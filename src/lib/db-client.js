import sql from "mssql";
import { isIP } from "node:net";

let poolPromise;

function mapParameters(request, parameters) {
    if (!parameters || typeof parameters !== "object") return;
    for (const [key, value] of Object.entries(parameters)) {
        request.input(key, value);
    }
}

function normalizeHostForIpCheck(hostValue) {
    const raw = String(hostValue || "").trim();
    if (!raw) return "";
    const withoutBrackets = raw.startsWith("[") && raw.endsWith("]") ? raw.slice(1, -1) : raw;
    const base = withoutBrackets.split("\\")[0].split(",")[0].trim();
    return base;
}

function disableSniForIpServer(pool) {
    const host = normalizeHostForIpCheck(pool?.config?.server);
    if (!host || isIP(host) === 0) return;
    pool.config.options = pool.config.options || {};
    pool.config.options.serverName = "localhost";
}

async function getPool(connectionString) {
    if (!connectionString) {
        throw new Error("Connection string non configurata (DB_PROD_CONNECTION_STRING).");
    }
    if (!poolPromise) {
        const pool = new sql.ConnectionPool(connectionString);
        disableSniForIpServer(pool);
        poolPromise = pool.connect();
    }
    return poolPromise;
}

function estimateValueBytes(value) {
    if (value === null || value === undefined) return 0;
    if (typeof value === "string") return Buffer.byteLength(value, "utf8");
    if (typeof value === "number") return 8;
    if (typeof value === "bigint") return 8;
    if (typeof value === "boolean") return 1;
    if (value instanceof Date) return 8;
    if (Buffer.isBuffer(value)) return value.length;
    try {
        return Buffer.byteLength(JSON.stringify(value), "utf8");
    } catch {
        return 64;
    }
}

function estimateRowBytes(row) {
    let bytes = 0;
    for (const [key, value] of Object.entries(row || {})) {
        bytes += Buffer.byteLength(String(key), "utf8");
        bytes += estimateValueBytes(value);
    }
    return bytes;
}

export async function runReadQuery({
    connectionString,
    sqlText,
    parameters,
    maxRows,
    queryTimeoutMs,
    maxResultBytes,
    textSizeBytes,
    maxRowBytes
}) {
    const pool = await getPool(connectionString);
    const request = pool.request();
    if (Number.isFinite(queryTimeoutMs) && queryTimeoutMs > 0) {
        request.timeout = queryTimeoutMs;
    }
    mapParameters(request, parameters);
    request.stream = true;
    const rowCountLimit = Math.max(1, Math.floor(maxRows) + 1);
    const safeTextSize = Number.isFinite(textSizeBytes) && textSizeBytes > 0 ? Math.floor(textSizeBytes) : 262144;
    const executionSql = `SET ROWCOUNT ${rowCountLimit}; SET TEXTSIZE ${safeTextSize}; ${sqlText}; SET ROWCOUNT 0;`;

    return await new Promise((resolve, reject) => {
        const rows = [];
        let truncated = false;
        let cancelledByLimit = false;
        let settled = false;
        const byteCap = Number.isFinite(maxResultBytes) && maxResultBytes > 0 ? maxResultBytes : 5 * 1024 * 1024;
        const rowByteCap = Number.isFinite(maxRowBytes) && maxRowBytes > 0 ? maxRowBytes : 262144;
        let totalBytes = 0;

        const done = payload => {
            if (settled) return;
            settled = true;
            resolve(payload);
        };
        const fail = error => {
            if (settled) return;
            settled = true;
            reject(error);
        };

        request.on("row", row => {
            const rowBytes = estimateRowBytes(row);
            if (rowBytes > rowByteCap) {
                truncated = true;
                if (!cancelledByLimit) {
                    cancelledByLimit = true;
                    request.cancel();
                }
                return;
            }

            totalBytes += rowBytes;
            if (totalBytes > byteCap) {
                truncated = true;
                if (!cancelledByLimit) {
                    cancelledByLimit = true;
                    request.cancel();
                }
                return;
            }
            if (rows.length < maxRows) {
                rows.push(row);
                return;
            }
            truncated = true;
            if (!cancelledByLimit) {
                cancelledByLimit = true;
                request.cancel();
            }
        });

        request.on("error", error => {
            const isExpectedCancel = cancelledByLimit && (error?.code === "ECANCEL" || /cancel/i.test(String(error?.message || "")));
            if (isExpectedCancel) return;
            fail(error);
        });

        request.on("done", () => {
            done({
                rows,
                rowCount: rows.length,
                truncated
            });
        });

        request.query(executionSql).catch(error => {
            const isExpectedCancel = cancelledByLimit && (error?.code === "ECANCEL" || /cancel/i.test(String(error?.message || "")));
            if (isExpectedCancel) return;
            fail(error);
        });
    });
}


