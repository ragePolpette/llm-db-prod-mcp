import path from "node:path";
import os from "node:os";
import fs from "node:fs";

function toBool(value, fallback = false) {
    if (value === undefined || value === null || value === "") return fallback;
    return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function toInt(value, fallback) {
    const parsed = parseInt(value, 10);
    return Number.isNaN(parsed) ? fallback : parsed;
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(value, max));
}

function normalizeSecret(value) {
    return String(value || "").trim();
}

const GENERIC_SECRET_PLACEHOLDERS = new Set([
    "__set_me__",
    "change-me",
    "change-me-stable-secret",
    "insert-secret-here",
    "llm-db-prod-mcp",
    "metti-un-segreto-stabile-lungo",
    "placeholder",
    "replace-me",
    "secret",
    "set-me",
    "your-secret-here"
]);

function hasEnoughSecretStrength(secret) {
    if (secret.length < 16) {
        return false;
    }

    let classes = 0;
    if (/[a-z]/.test(secret)) classes += 1;
    if (/[A-Z]/.test(secret)) classes += 1;
    if (/\d/.test(secret)) classes += 1;
    if (/[^A-Za-z0-9]/.test(secret)) classes += 1;
    return classes >= 3;
}

function assertRequiredSecret(value, envName, rejectedPlaceholders = []) {
    const secret = normalizeSecret(value);
    if (!secret) {
        throw new Error(`${envName} obbligatoria: avvio rifiutato senza secret esplicito.`);
    }

    const normalized = secret.toLowerCase();
    const rejectedValues = new Set([
        ...rejectedPlaceholders.map(candidate => String(candidate || "").trim().toLowerCase()),
        ...GENERIC_SECRET_PLACEHOLDERS
    ]);

    if (rejectedValues.has(normalized)) {
        throw new Error(`${envName} non valida: sostituisci il placeholder con un secret reale.`);
    }

    if (!hasEnoughSecretStrength(secret)) {
        throw new Error(
            `${envName} non valida: usa un secret stabile di almeno 16 caratteri con almeno 3 classi tra maiuscole, minuscole, numeri e simboli.`
        );
    }
    return secret;
}

function parseCsvList(value, fallback) {
    if (value === undefined || value === null || value === "") return [...fallback];
    const list = String(value)
        .split(",")
        .map(item => item.trim())
        .filter(Boolean);
    return list.length ? list : [...fallback];
}

function uniqueLower(items) {
    const seen = new Set();
    const out = [];
    for (const item of items) {
        const raw = String(item || "").trim();
        if (!raw) continue;
        const lower = raw.toLowerCase();
        if (seen.has(lower)) continue;
        seen.add(lower);
        out.push(raw);
    }
    return out;
}

function getLocalHostFallback() {
    const hostname = String(os.hostname() || "").trim().toLowerCase();
    const hostCandidates = uniqueLower([
        "localhost",
        "127.0.0.1",
        "[::1]",
        hostname
    ]);

    const originCandidates = [];
    for (const host of hostCandidates) {
        if (!host || host === "[::1]") continue;
        originCandidates.push(`http://${host}:*`, `https://${host}:*`);
    }

    return {
        allowedHosts: hostCandidates,
        allowedOrigins: uniqueLower(originCandidates)
    };
}

let envLoaded = false;
let dotEnvKeysCache = null;

function getDotEnvKeysFromCwd() {
    if (dotEnvKeysCache !== null) {
        return dotEnvKeysCache;
    }

    dotEnvKeysCache = new Set();
    const envPath = path.resolve(process.cwd(), ".env");
    if (!fs.existsSync(envPath)) {
        return dotEnvKeysCache;
    }

    const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
    for (const rawLine of lines) {
        const line = String(rawLine || "").trim();
        if (!line || line.startsWith("#")) continue;
        const idx = line.indexOf("=");
        if (idx <= 0) continue;
        dotEnvKeysCache.add(line.slice(0, idx).trim().toLowerCase());
    }
    return dotEnvKeysCache;
}

function assertNoProdConnectionStringInDotEnv() {
    const dotEnvKeys = getDotEnvKeysFromCwd();
    if (dotEnvKeys.has("db_prod_connection_string")) {
        throw new Error(
            "Il file .env non puo' contenere DB_PROD_CONNECTION_STRING: usa una variabile ambiente di processo o un secret runtime esterno."
        );
    }
}

function loadDotEnvFromCwd() {
    if (envLoaded) return;
    envLoaded = true;

    const envPath = path.resolve(process.cwd(), ".env");
    if (!fs.existsSync(envPath)) return;

    const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
    for (const rawLine of lines) {
        const line = String(rawLine || "").trim();
        if (!line || line.startsWith("#")) continue;
        const idx = line.indexOf("=");
        if (idx <= 0) continue;

        const key = line.slice(0, idx).trim();
        let value = line.slice(idx + 1);
        if (
            (value.startsWith("\"") && value.endsWith("\"")) ||
            (value.startsWith("'") && value.endsWith("'"))
        ) {
            value = value.slice(1, -1);
        }

        if (!Object.prototype.hasOwnProperty.call(process.env, key) || process.env[key] === "") {
            process.env[key] = value;
        }
    }
}

function toEnum(value, allowed, fallback, envName) {
    if (value === undefined || value === null || value === "") return fallback;
    const normalized = String(value).trim().toLowerCase();
    if (allowed.includes(normalized)) {
        return normalized;
    }
    const key = envName ? `${envName}` : "enum";
    throw new Error(`Valore non valido per ${key}: '${value}'. Valori ammessi: ${allowed.join(", ")}.`);
}

export function getProdConfig() {
    loadDotEnvFromCwd();
    assertNoProdConnectionStringInDotEnv();
    const localFallback = getLocalHostFallback();
    const modelsDirRaw = process.env.MCP_MODELS_DIR || ".local/models";
    const modelsDir = path.isAbsolute(modelsDirRaw)
        ? modelsDirRaw
        : path.resolve(process.cwd(), modelsDirRaw);
    const ollamaModelsRaw = process.env.OLLAMA_MODELS || path.join(modelsDir, "ollama");
    const ollamaModelsDir = path.isAbsolute(ollamaModelsRaw)
        ? ollamaModelsRaw
        : path.resolve(process.cwd(), ollamaModelsRaw);
    if (!process.env.OLLAMA_MODELS) {
        process.env.OLLAMA_MODELS = ollamaModelsDir;
    }

    const anonymizerProvider = toEnum(
        process.env.ANON_MODEL_PROVIDER || "ollama",
        ["ollama", "deterministic"],
        "ollama",
        "ANON_MODEL_PROVIDER"
    );
    if (anonymizerProvider !== "ollama") {
        throw new Error("ANON_MODEL_PROVIDER=deterministic non consentito in produzione: usa sempre ollama.");
    }

    return {
        connectionString: process.env.DB_PROD_CONNECTION_STRING || "",
        maxRows: clamp(toInt(process.env.DB_PROD_MAX_ROWS, 200), 1, 250),
        queryTimeoutMs: clamp(toInt(process.env.DB_PROD_QUERY_TIMEOUT_MS, 9000), 1000, 10000),
        preflightTimeoutMs: clamp(toInt(process.env.DB_PROD_PREFLIGHT_TIMEOUT_MS, 8000), 1000, 30000),
        maxResultBytes: clamp(toInt(process.env.DB_PROD_MAX_RESULT_BYTES, 5 * 1024 * 1024), 128 * 1024, 5 * 1024 * 1024),
        textSizeBytes: clamp(toInt(process.env.DB_PROD_TEXTSIZE_BYTES, 262144), 4096, 1048576),
        maxRowBytes: clamp(toInt(process.env.DB_PROD_MAX_ROW_BYTES, 262144), 4096, 10 * 1024 * 1024),
        anonymizer: {
            provider: anonymizerProvider,
            mode: toEnum(
                process.env.ANON_MODE || "hybrid",
                ["hybrid", "deterministic", "llm-strict"],
                "hybrid",
                "ANON_MODE"
            ),
            fieldIdentification: toEnum(
                process.env.ANON_FIELD_IDENTIFICATION || "hybrid",
                ["hybrid", "heuristic", "llm"],
                "hybrid",
                "ANON_FIELD_IDENTIFICATION"
            ),
            hashSalt: assertRequiredSecret(process.env.ANON_HASH_SALT, "ANON_HASH_SALT", [
                "change-me-stable-secret",
                "llm-db-prod-mcp"
            ]),
            baseUrl: process.env.ANON_MODEL_BASE_URL || "http://127.0.0.1:11434",
            model: process.env.ANON_MODEL_NAME || "",
            failOpen: toBool(process.env.ANON_FAIL_OPEN, false),
            timeoutMs: clamp(toInt(process.env.ANON_TIMEOUT_MS, 5000), 500, 60000),
            llmMaxRows: clamp(toInt(process.env.ANON_LLM_MAX_ROWS, 2), 1, 1000),
            llmMaxCells: clamp(toInt(process.env.ANON_LLM_MAX_CELLS, 40), 1, 200000),
            llmMaxInputChars: clamp(toInt(process.env.ANON_LLM_MAX_INPUT_CHARS, 3000), 100, 2000000)
        },
        modelsDir,
        ollamaModelsDir,
        server: {
            host: process.env.MCP_PROD_HOST || "127.0.0.1",
            port: clamp(toInt(process.env.MCP_PROD_PORT, 8782), 1, 65535),
            path: process.env.MCP_PROD_PATH || "/mcp",
            sseEnabled: toBool(process.env.MCP_PROD_SSE_ENABLED, false),
            allowedHosts: parseCsvList(
                process.env.MCP_PROD_ALLOWED_HOSTS,
                localFallback.allowedHosts
            ),
            allowedOrigins: parseCsvList(
                process.env.MCP_PROD_ALLOWED_ORIGINS,
                localFallback.allowedOrigins
            )
        }
    };
}
