import { runReadQuery } from "./db-client.js";
import { runWithTimeout } from "./timeout.js";

function isLoopbackHost(host) {
    const normalized = String(host || "").trim().toLowerCase();
    return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}

function isBooleanTrue(value) {
    return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function parseModelNames(payload) {
    const list = Array.isArray(payload?.models) ? payload.models : [];
    const names = new Set();

    for (const model of list) {
        if (typeof model?.name === "string" && model.name.trim()) {
            names.add(model.name.trim());
        }
        if (typeof model?.model === "string" && model.model.trim()) {
            names.add(model.model.trim());
        }
    }

    return [...names];
}

function modelAliases(modelName) {
    const raw = String(modelName || "").trim().toLowerCase();
    if (!raw) return [];

    const aliases = new Set([raw]);
    const short = raw.includes("/") ? raw.split("/").pop() : raw;
    aliases.add(short);

    const rawNoTag = raw.includes(":") ? raw.split(":")[0] : raw;
    const shortNoTag = short.includes(":") ? short.split(":")[0] : short;
    aliases.add(rawNoTag);
    aliases.add(shortNoTag);

    if (!raw.includes(":")) aliases.add(`${raw}:latest`);
    if (!short.includes(":")) aliases.add(`${short}:latest`);

    return [...aliases].filter(Boolean);
}

function hasCompatibleModel(targetModel, availableModels) {
    const targetAliases = new Set(modelAliases(targetModel));
    if (targetAliases.size === 0) return false;

    for (const available of availableModels) {
        const aliases = modelAliases(available);
        for (const alias of aliases) {
            if (targetAliases.has(alias)) {
                return true;
            }
        }
    }
    return false;
}

function ensureLocalAnonymizerConfig(anonymizer) {
    const provider = String(anonymizer?.provider || "").trim().toLowerCase();
    const mode = String(anonymizer?.mode || "hybrid").trim().toLowerCase();
    const fieldIdentification = String(anonymizer?.fieldIdentification || "hybrid").trim().toLowerCase();

    if (provider !== "ollama") {
        throw new Error("Produzione richiede ANON_MODEL_PROVIDER=ollama.");
    }

    const baseUrlRaw = String(anonymizer?.baseUrl || "").trim();
    if (!baseUrlRaw) {
        throw new Error("ANON_MODEL_BASE_URL mancante.");
    }

    let parsed;
    try {
        parsed = new URL(baseUrlRaw);
    } catch {
        throw new Error(`ANON_MODEL_BASE_URL non valida: ${baseUrlRaw}`);
    }

    if (!isLoopbackHost(parsed.hostname)) {
        throw new Error(
            `ANON_MODEL_BASE_URL deve puntare a loopback locale (127.0.0.1/localhost). Valore corrente: ${baseUrlRaw}`
        );
    }

    if (isBooleanTrue(anonymizer?.failOpen) && mode === "llm-strict") {
        throw new Error("ANON_FAIL_OPEN=true non consentito in produzione.");
    }

    if (mode === "deterministic") {
        throw new Error("ANON_MODE=deterministic non consentito in produzione: usa hybrid o llm-strict.");
    }

    if (fieldIdentification === "heuristic") {
        throw new Error("ANON_FIELD_IDENTIFICATION=heuristic non consentito in produzione: Ollama deve essere attivo.");
    }

    const model = String(anonymizer?.model || "").trim();
    if (!model) {
        throw new Error("ANON_MODEL_NAME mancante: specifica esplicitamente il modello locale.");
    }

    return {
        provider: "ollama",
        model,
        tagsUrl: `${baseUrlRaw.replace(/\/$/, "")}/api/tags`
    };
}

async function ensureLocalModelIsInstalled(anonymizer) {
    const cfg = ensureLocalAnonymizerConfig(anonymizer);
    if (cfg.provider !== "ollama") {
        return;
    }

    const { model, tagsUrl } = cfg;
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort("timeout"), 8000);
    let response;
    try {
        response = await fetch(tagsUrl, { method: "GET", signal: abortController.signal });
    } finally {
        clearTimeout(timeout);
    }

    if (!response.ok) {
        throw new Error(`Ollama locale non raggiungibile (${response.status}) su ${tagsUrl}`);
    }

    const payload = await response.json();
    const available = parseModelNames(payload);
    const found = hasCompatibleModel(model, available);

    if (!found) {
        const suffix = available.length > 0 ? ` Disponibili: ${available.join(", ")}` : " Nessun modello disponibile.";
        throw new Error(`Modello locale non trovato: ${model}.${suffix}`);
    }
}

async function ensureDbConnection(connectionString, queryTimeoutMs, preflightTimeoutMs) {
    const conn = String(connectionString || "").trim();
    if (!conn) {
        throw new Error("Connection string non configurata (DB_PROD_CONNECTION_STRING).");
    }

    await runWithTimeout(
        signal => runReadQuery({
            connectionString: conn,
            sqlText: "SELECT TOP 1 1 AS ok;",
            parameters: {},
            maxRows: 1,
            queryTimeoutMs,
            abortSignal: signal
        }),
        preflightTimeoutMs,
        "DB preflight"
    );
}

export async function runProdPreflight(config) {
    if (!isLoopbackHost(config?.server?.host)) {
        throw new Error(
            `MCP_PROD_HOST deve essere loopback locale (127.0.0.1/localhost/::1). Valore corrente: ${config?.server?.host}`
        );
    }
    await ensureDbConnection(config?.connectionString, config?.queryTimeoutMs, config?.preflightTimeoutMs);
    await ensureLocalModelIsInstalled(config?.anonymizer);
}
