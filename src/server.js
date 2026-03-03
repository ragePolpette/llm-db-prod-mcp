import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, isInitializeRequest, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { getProdConfig } from "./lib/config.js";
import { assertReadOnlySql } from "./lib/sql-guard.js";
import { runReadQuery } from "./lib/db-client.js";
import { anonymizeRows } from "./lib/anonymizer.js";
import { runProdPreflight } from "./lib/preflight.js";

const config = getProdConfig();
const SESSION_ID_REGEX = /^[a-zA-Z0-9-]{1,128}$/;

function normalizeSessionId(sessionIdRaw) {
    if (Array.isArray(sessionIdRaw)) {
        return null;
    }
    const value = typeof sessionIdRaw === "string" ? sessionIdRaw.trim() : "";
    if (!value) return null;
    if (!SESSION_ID_REGEX.test(value)) return null;
    return value;
}

function parseMaxRows(value, fallback) {
    if (value === undefined || value === null || value === "") {
        return fallback;
    }
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || !Number.isInteger(numeric)) {
        throw new Error("Parametro maxRows non valido: intero atteso.");
    }
    return Math.max(1, Math.min(numeric, 250));
}

function isAllowedParameterValue(value) {
    if (value === null) return true;
    if (value === undefined) return false;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
        return true;
    }
    if (value instanceof Date) return true;
    if (Buffer.isBuffer(value)) return true;
    return false;
}

function sanitizeParameters(input) {
    if (input === undefined || input === null) return undefined;
    if (typeof input !== "object" || Array.isArray(input)) {
        throw new Error("Parametro parameters non valido: oggetto key/value atteso.");
    }

    const entries = Object.entries(input);
    if (entries.length > 100) {
        throw new Error("Parametro parameters non valido: massimo 100 parametri.");
    }

    const out = {};
    for (const [key, value] of entries) {
        if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key)) {
            throw new Error(`Nome parametro SQL non valido: ${key}`);
        }
        if (!isAllowedParameterValue(value)) {
            throw new Error(`Valore parametro non supportato per '${key}'.`);
        }
        out[key] = value;
    }
    return out;
}

function asTextResult(payload) {
    return {
        content: [
            {
                type: "text",
                text: JSON.stringify(payload, null, 2)
            }
        ]
    };
}

function createMcpServer() {
    const server = new Server(
        {
            name: "llm-db-prod-mcp",
            version: "1.0.0"
        },
        {
            capabilities: {
                tools: {}
            }
        }
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
            {
                name: "db_prod_read_anonymized",
                description: "Esegue query SQL di sola lettura sul DB di produzione e anonimizza i risultati tramite modello locale.",
                inputSchema: {
                    type: "object",
                    properties: {
                        sql: { type: "string", description: "Query SQL di sola lettura (SELECT/WITH)." },
                        parameters: {
                            type: "object",
                            description: "Parametri query (key/value).",
                            additionalProperties: true
                        },
                        maxRows: {
                            type: "integer",
                            description: `Numero massimo righe restituite (default ${config.maxRows}).`,
                            minimum: 1,
                            maximum: 250
                        }
                    },
                    required: ["sql"]
                }
            }
        ]
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;

        if (name !== "db_prod_read_anonymized") {
            throw new Error(`Tool non supportato: ${name}`);
        }

        const sqlText = assertReadOnlySql(args?.sql);
        const maxRows = parseMaxRows(args?.maxRows, config.maxRows);
        const parameters = sanitizeParameters(args?.parameters);
        const dbResult = await runReadQuery({
            connectionString: config.connectionString,
            sqlText,
            parameters,
            maxRows,
            queryTimeoutMs: config.queryTimeoutMs,
            maxResultBytes: config.maxResultBytes,
            textSizeBytes: config.textSizeBytes,
            maxRowBytes: config.maxRowBytes
        });

        const anonymized = await anonymizeRows(dbResult.rows, config.anonymizer);
        return asTextResult({
            success: true,
            mode: "read_anonymized",
            rowCount: anonymized.length,
            truncated: dbResult.truncated,
            rows: anonymized
        });
    });

    return server;
}

function createErrorResponse(message) {
    return {
        jsonrpc: "2.0",
        error: {
            code: -32000,
            message
        },
        id: null
    };
}

const app = createMcpExpressApp({ host: config.server.host });
const transports = new Map();

app.get("/health", (_req, res) => {
    res.json({
        status: "ok",
        server: "llm-db-prod-mcp",
        endpoint: config.server.path
    });
});

app.post(config.server.path, async (req, res) => {
    const sessionId = normalizeSessionId(req.headers["mcp-session-id"]);
    let transport;

    try {
        if (sessionId && transports.has(sessionId)) {
            transport = transports.get(sessionId);
            await transport.handleRequest(req, res, req.body);
            return;
        }

        if (!sessionId && isInitializeRequest(req.body)) {
            const server = createMcpServer();
            transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                onsessioninitialized: sid => {
                    if (normalizeSessionId(sid)) {
                        transports.set(sid, transport);
                    }
                }
            });

            transport.onclose = () => {
                const sid = transport.sessionId;
                if (sid && transports.has(sid)) {
                    transports.delete(sid);
                }
            };

            await server.connect(transport);
            await transport.handleRequest(req, res, req.body);
            return;
        }

        res.status(400).json(createErrorResponse("Bad Request: No valid session ID provided"));
    } catch (error) {
        const message = error instanceof Error ? error.message : "Internal server error";
        console.error("POST MCP request failed:", message);
        if (!res.headersSent) {
            res.status(500).json(createErrorResponse("Internal server error"));
        }
    }
});

app.get(config.server.path, async (req, res) => {
    const sessionId = normalizeSessionId(req.headers["mcp-session-id"]);
    if (!sessionId || !transports.has(sessionId)) {
        res.status(400).send("Invalid or missing session ID");
        return;
    }

    try {
        await transports.get(sessionId).handleRequest(req, res);
    } catch (error) {
        const message = error instanceof Error ? error.message : "Internal server error";
        console.error("GET MCP request failed:", message);
        if (!res.headersSent) {
            res.status(500).send("Internal server error");
        }
    }
});

app.delete(config.server.path, async (req, res) => {
    const sessionId = normalizeSessionId(req.headers["mcp-session-id"]);
    if (!sessionId || !transports.has(sessionId)) {
        res.status(400).send("Invalid or missing session ID");
        return;
    }

    try {
        await transports.get(sessionId).handleRequest(req, res);
    } catch (error) {
        const message = error instanceof Error ? error.message : "Internal server error";
        console.error("DELETE MCP request failed:", message);
        if (!res.headersSent) {
            res.status(500).send("Internal server error");
        }
    }
});

async function startServer() {
    await runProdPreflight(config);

    const httpServer = app.listen(config.server.port, config.server.host, () => {
        console.log(
            `llm-db-prod-mcp listening at http://${config.server.host}:${config.server.port}${config.server.path}`
        );
    });

    httpServer.on("error", error => {
        const message = error instanceof Error ? error.message : String(error);
        console.error("Failed to start llm-db-prod-mcp:", message);
        process.exit(1);
    });
}

startServer().catch(error => {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Preflight failed for llm-db-prod-mcp:", message);
    process.exit(1);
});
