import { createHash } from "node:crypto";

const EMAIL_REGEX = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PHONE_TEXT_REGEX = /(?=.*[+\s().-])(\+?\d[\d\s().-]{6,}\d)/g;
const FISCAL_REGEX = /\b[A-Z]{6}\d{2}[A-Z]\d{2}[A-Z]\d{3}[A-Z]\b/gi;
const VAT_REGEX = /\b\d{11,16}\b/g;

const KIND_VALUES = new Set(["email", "phone", "cf", "vat", "name", "org", "address", "city", "text"]);
const NONE_KIND = "__none__";
const SAFE_EXACT_KEYS = new Set([
    "id",
    "ids",
    "rownum",
    "row_num",
    "count",
    "total",
    "status",
    "stato",
    "type",
    "tipo",
    "flag",
    "enabled",
    "active",
    "created_at",
    "updated_at",
    "deleted_at",
    "timestamp",
    "ts",
    "date",
    "data"
]);
const SAFE_KEY_TOKENS = new Set([
    "id",
    "count",
    "total",
    "status",
    "stato",
    "type",
    "tipo",
    "flag",
    "enabled",
    "active",
    "created",
    "updated",
    "deleted",
    "timestamp",
    "date",
    "data"
]);

const EXACT_KEY_KIND = new Map([
    ["email", "email"],
    ["pec", "email"],
    ["emailrl", "email"],
    ["telefono", "phone"],
    ["telefonorl", "phone"],
    ["cellulare", "phone"],
    ["mobile", "phone"],
    ["fax", "phone"],
    ["cf", "cf"],
    ["codicefiscale", "cf"],
    ["cod_fiscale", "cf"],
    ["codfiscale", "cf"],
    ["codfiscalerl", "cf"],
    ["partitaiva", "vat"],
    ["partita_iva", "vat"],
    ["piva", "vat"],
    ["vat", "vat"],
    ["pi", "vat"],
    ["nome", "name"],
    ["cognome", "name"],
    ["nomerl", "name"],
    ["cognomerl", "name"],
    ["denominazione", "org"],
    ["ragionesociale", "org"],
    ["indirizzo", "address"],
    ["address", "address"],
    ["cap", "address"],
    ["citta", "city"],
    ["comune", "city"],
    ["provincia", "city"],
    ["nazione", "city"],
    ["note", "text"],
    ["descrizione", "text"],
    ["description", "text"],
    ["comment", "text"],
    ["memo", "text"]
]);

const LLM_KIND_CACHE = new Map();

function isObject(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeKey(key) {
    return String(key || "")
        .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .replace(/_+/g, "_");
}

function compactKey(normalized) {
    return String(normalized || "").replace(/_/g, "");
}

function tokenSetFromKey(normalized) {
    return new Set(String(normalized || "").split("_").filter(Boolean));
}

function hasAnyToken(tokens, candidates) {
    for (const candidate of candidates) {
        if (tokens.has(candidate)) {
            return true;
        }
    }
    return false;
}

function getHashSalt(cfg) {
    const raw = String(cfg?.hashSalt || "").trim();
    if (!raw) {
        throw new Error("ANON_HASH_SALT mancante: impossibile anonimizzare in modo deterministico.");
    }
    return raw;
}

function isExplicitlySafeKey(key) {
    const normalized = normalizeKey(key);
    if (!normalized) return false;
    if (SAFE_EXACT_KEYS.has(normalized)) return true;

    const tokens = tokenSetFromKey(normalized);
    if (tokens.size === 0) return false;
    for (const token of tokens) {
        if (!SAFE_KEY_TOKENS.has(token)) {
            return false;
        }
    }
    return true;
}

function stableDigest(salt, key, value, len = 8) {
    const base = `${salt}|${String(key || "")}|${String(value ?? "")}`;
    return createHash("sha256").update(base).digest("hex").slice(0, len).toUpperCase();
}

function toPhoneFromDigest(salt, key, value) {
    const hex = stableDigest(salt, key, value, 10);
    const digits = hex
        .split("")
        .map((ch) => (parseInt(ch, 16) % 10).toString())
        .join("");
    return `+39${digits}`;
}

function inferKindHeuristic(key) {
    const normalized = normalizeKey(key);
    if (!normalized) return null;

    if (EXACT_KEY_KIND.has(normalized)) {
        return EXACT_KEY_KIND.get(normalized);
    }

    const compact = compactKey(normalized);
    const tokens = tokenSetFromKey(normalized);

    if (compact === "tipoiva" || compact === "regimeiva" || compact === "referenteiva") {
        return null;
    }

    if (compact.startsWith("email") || compact.includes("pec") || hasAnyToken(tokens, ["email", "mail", "pec"])) {
        return "email";
    }

    if (
        compact.startsWith("telefono") ||
        compact.startsWith("cellulare") ||
        compact.endsWith("phone") ||
        hasAnyToken(tokens, ["telefono", "phone", "mobile", "cellulare", "fax"])
    ) {
        return "phone";
    }

    if (
        compact.includes("codicefiscale") ||
        compact.includes("codfiscale") ||
        compact === "cf" ||
        hasAnyToken(tokens, ["cf", "codicefiscale", "codfiscale"])
    ) {
        return "cf";
    }

    if (
        compact.includes("partitaiva") ||
        compact === "piva" ||
        compact === "vat" ||
        (tokens.has("partita") && tokens.has("iva")) ||
        tokens.has("piva") ||
        tokens.has("vat")
    ) {
        return "vat";
    }

    if (
        compact.startsWith("nome") ||
        compact.startsWith("cognome") ||
        hasAnyToken(tokens, ["nome", "name", "cognome", "surname", "firstname", "lastname", "referente"])
    ) {
        return "name";
    }

    if (
        compact.includes("denominazione") ||
        compact.includes("ragionesociale") ||
        normalized === "azienda" ||
        normalized === "societa" ||
        normalized === "company"
    ) {
        return "org";
    }

    if (
        compact.includes("indirizzo") ||
        compact.includes("address") ||
        hasAnyToken(tokens, ["indirizzo", "address", "via", "street", "cap", "zip"])
    ) {
        return "address";
    }

    if (hasAnyToken(tokens, ["citta", "city", "comune", "provincia", "country", "nazione"])) {
        return "city";
    }

    if (hasAnyToken(tokens, ["note", "descrizione", "description", "comment", "memo"])) {
        return "text";
    }

    return null;
}

function normalizeKind(kind) {
    const value = String(kind || "").trim().toLowerCase();
    if (!value || value === "none" || value === "null") return NONE_KIND;
    return KIND_VALUES.has(value) ? value : NONE_KIND;
}

function getCachedKind(normalizedKey) {
    if (!LLM_KIND_CACHE.has(normalizedKey)) return null;
    const value = LLM_KIND_CACHE.get(normalizedKey);
    return value === NONE_KIND ? null : value;
}

function setCachedKind(normalizedKey, kind) {
    const normalizedKind = normalizeKind(kind);
    if (!LLM_KIND_CACHE.has(normalizedKey)) {
        LLM_KIND_CACHE.set(normalizedKey, normalizedKind);
    }
}

function resolveKindForKey(key, fieldKindMap) {
    const normalized = normalizeKey(key);
    if (!normalized) return null;

    if (fieldKindMap?.has(normalized)) {
        return fieldKindMap.get(normalized);
    }

    const cached = getCachedKind(normalized);
    if (cached) {
        return cached;
    }

    return inferKindHeuristic(key);
}

function resolveKindForValue(key, value, fieldKindMap) {
    const kind = resolveKindForKey(key, fieldKindMap);
    if (kind) return kind;
    if (isExplicitlySafeKey(key)) return null;
    if (typeof value === "string" && value.trim()) {
        return "text";
    }
    return null;
}

function extractJsonFromText(text) {
    if (!text) return null;
    const trimmed = String(text).trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        return trimmed;
    }

    const fenced = trimmed.match(/```json\s*([\s\S]*?)```/i);
    if (fenced?.[1]) return fenced[1].trim();

    const generic = trimmed.match(/```[\s\S]*?\n([\s\S]*?)```/i);
    if (generic?.[1]) return generic[1].trim();

    return null;
}

function coerceRowsArray(parsed) {
    if (Array.isArray(parsed)) {
        return parsed;
    }

    if (isObject(parsed)) {
        if (Array.isArray(parsed.rows)) return parsed.rows;
        if (Array.isArray(parsed.data)) return parsed.data;
        if (Array.isArray(parsed.items)) return parsed.items;
    }

    throw new Error("Anonymizer output non valido: array atteso.");
}

function replaceByKind(kind, key, value, cfg) {
    const raw = String(value ?? "");
    const normalizedKey = normalizeKey(key);
    const salt = getHashSalt(cfg);

    switch (kind) {
        case "email":
            return `user_${stableDigest(salt, normalizedKey, raw, 10).toLowerCase()}@example.invalid`;
        case "phone":
            return toPhoneFromDigest(salt, normalizedKey, raw);
        case "cf":
            return `CF_${stableDigest(salt, normalizedKey, raw, 16)}`;
        case "vat":
            return `VAT_${stableDigest(salt, normalizedKey, raw, 12)}`;
        case "address":
            return `ADDRESS_${stableDigest(salt, normalizedKey, raw, 8)}`;
        case "city":
            return `CITY_${stableDigest(salt, normalizedKey, raw, 8)}`;
        case "name":
            return `NAME_${stableDigest(salt, normalizedKey, raw, 8)}`;
        case "org":
            return `ORG_${stableDigest(salt, normalizedKey, raw, 8)}`;
        case "text":
            return `TEXT_${stableDigest(salt, normalizedKey, raw, 10)}`;
        default:
            return raw;
    }
}

function maskInlineWithHashes(value, cfg) {
    const salt = getHashSalt(cfg);
    return String(value)
        .replace(EMAIL_REGEX, (match) => `user_${stableDigest(salt, "inline_email", match, 10).toLowerCase()}@example.invalid`)
        .replace(FISCAL_REGEX, (match) => `CF_${stableDigest(salt, "inline_cf", match, 16)}`)
        .replace(VAT_REGEX, (match) => `VAT_${stableDigest(salt, "inline_vat", match, 12)}`)
        .replace(PHONE_TEXT_REGEX, (match) => toPhoneFromDigest(salt, "inline_phone", match));
}

function deterministicFallback(rows, cfg, fieldKindMap) {
    return rows.map((row) => {
        if (!isObject(row)) return row;

        const out = { ...row };
        for (const key of Object.keys(out)) {
            const value = out[key];
            if (value === null || value === undefined) continue;

            const kind = resolveKindForValue(key, value, fieldKindMap);
            if (kind) {
                out[key] = replaceByKind(kind, key, value, cfg);
                continue;
            }

            if (typeof value === "string" && !isExplicitlySafeKey(key)) {
                out[key] = maskInlineWithHashes(value, cfg);
            }
        }
        return out;
    });
}

function normalizeRowsShape(sourceRows, candidateRows, fieldKindMap, cfg) {
    if (!Array.isArray(candidateRows) || candidateRows.length !== sourceRows.length) {
        throw new Error("Anonymizer output non valido: numero righe differente.");
    }

    return sourceRows.map((source, idx) => {
        if (!isObject(source)) return source;

        const candidate = isObject(candidateRows[idx]) ? candidateRows[idx] : {};
        const out = {};

        for (const key of Object.keys(source)) {
            const kind = resolveKindForValue(key, source[key], fieldKindMap);
            if (!kind) {
                out[key] = source[key];
                continue;
            }

            if (Object.prototype.hasOwnProperty.call(candidate, key) && candidate[key] !== undefined) {
                const candidateValue = candidate[key];
                const sourceValue = source[key];
                const echoedUnchanged =
                    candidateValue === sourceValue ||
                    (typeof candidateValue === "string" &&
                        typeof sourceValue === "string" &&
                        candidateValue.trim() === sourceValue.trim());

                out[key] = echoedUnchanged
                    ? replaceByKind(kind, key, sourceValue, cfg)
                    : candidateValue;
            } else {
                out[key] = replaceByKind(kind, key, source[key], cfg);
            }
        }
        return out;
    });
}

function buildFieldProbePayload(rows) {
    const keys = new Set();
    for (const row of rows) {
        if (!isObject(row)) continue;
        for (const key of Object.keys(row)) {
            keys.add(key);
        }
    }

    const firstObject = rows.find((row) => isObject(row)) || {};
    return [...keys]
        .map((key) => {
            const sample = firstObject[key];
            return {
                key,
                sample: sample === null || sample === undefined ? null : String(sample).slice(0, 80)
            };
        })
        .slice(0, 400);
}

async function identifyFieldsWithOllama(rows, cfg) {
    const payload = buildFieldProbePayload(rows);
    if (payload.length === 0) return new Map();

    const unknown = payload.filter((entry) => !LLM_KIND_CACHE.has(normalizeKey(entry.key)));
    if (unknown.length === 0) {
        const known = new Map();
        for (const entry of payload) {
            const normalized = normalizeKey(entry.key);
            const kind = getCachedKind(normalized);
            if (kind) known.set(normalized, kind);
        }
        return known;
    }

    const systemPrompt = [
        "Classifica nomi campo database per anonimizzazione.",
        "Rispondi SOLO con JSON valido formato: {\"fields\":{\"<key>\":\"<kind>\"}}.",
        "kind ammessi: email, phone, cf, vat, name, org, address, city, text, none.",
        "Non aggiungere testo extra."
    ].join(" ");

    const userPrompt = JSON.stringify({ fields: unknown });
    const timeoutMs = Math.min(Number(cfg?.timeoutMs ?? 5000), 5000);
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort("timeout"), timeoutMs);

    let response;
    try {
        response = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/api/chat`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                model: cfg.model,
                stream: false,
                format: "json",
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: userPrompt }
                ]
            }),
            signal: abortController.signal
        });
    } catch (error) {
        if (error?.name === "AbortError") {
            throw new Error(`Field identification timeout after ${timeoutMs}ms`);
        }
        throw error;
    } finally {
        clearTimeout(timeout);
    }

    if (!response.ok) {
        throw new Error(`Field identification HTTP error: ${response.status}`);
    }

    const result = await response.json();
    const text = result?.message?.content || result?.response || "";
    const jsonText = extractJsonFromText(text);
    if (!jsonText) {
        throw new Error("Field identification output non parsabile (JSON mancante).");
    }

    const parsed = JSON.parse(jsonText);
    const fields = isObject(parsed?.fields) ? parsed.fields : {};

    for (const entry of unknown) {
        const normalized = normalizeKey(entry.key);
        const inferred = normalizeKind(fields[entry.key]);
        setCachedKind(normalized, inferred);
    }

    const resolved = new Map();
    for (const entry of payload) {
        const normalized = normalizeKey(entry.key);
        const kind = getCachedKind(normalized);
        if (kind) resolved.set(normalized, kind);
    }
    return resolved;
}

async function resolveFieldKinds(rows, cfg) {
    const provider = String(cfg?.provider || "").toLowerCase();
    const strategy = String(cfg?.fieldIdentification || "hybrid").toLowerCase();

    if (strategy === "heuristic" || provider !== "ollama") {
        return new Map();
    }

    if (!cfg?.baseUrl || !cfg?.model) {
        return new Map();
    }

    try {
        return await identifyFieldsWithOllama(rows, cfg);
    } catch {
        if (strategy === "llm") {
            throw new Error("Field identification LLM fallita con strategia ANON_FIELD_IDENTIFICATION=llm.");
        }
        return new Map();
    }
}

async function anonymizeWithOllama(rows, cfg, fieldKindMap) {
    const systemPrompt = [
        "Sei un motore di anonimizzazione dati.",
        "Riceverai un array JSON di righe database.",
        "Devi restituire SOLO JSON valido, stessa struttura, stesse chiavi, stesso numero di righe.",
        "Anonimizza o pseudonimizza PII (nome, cognome, email, telefono, codice fiscale, partita IVA, indirizzi, note contenenti dati personali).",
        "Mantieni invariati i campi tecnici non personali (id tecnici, enum, importi, date di sistema, flag).",
        "Non aggiungere testo extra."
    ].join(" ");

    const userPrompt = JSON.stringify({ rows });
    const timeoutMs = Number(cfg?.timeoutMs ?? 5000);
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort("timeout"), timeoutMs);

    let response;
    try {
        response = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/api/chat`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                model: cfg.model,
                stream: false,
                format: "json",
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: userPrompt }
                ]
            }),
            signal: abortController.signal
        });
    } catch (error) {
        if (error?.name === "AbortError") {
            throw new Error(`Anonymizer timeout after ${timeoutMs}ms`);
        }
        throw error;
    } finally {
        clearTimeout(timeout);
    }

    if (!response.ok) {
        throw new Error(`Anonymizer HTTP error: ${response.status}`);
    }

    const payload = await response.json();
    const text = payload?.message?.content || payload?.response || "";
    const jsonText = extractJsonFromText(text);
    if (!jsonText) {
        throw new Error("Anonymizer output non parsabile (JSON mancante).");
    }

    const parsed = JSON.parse(jsonText);
    const candidateRows = coerceRowsArray(parsed);
    return normalizeRowsShape(rows, candidateRows, fieldKindMap, cfg);
}

export async function anonymizeRows(rows, cfg) {
    if (!Array.isArray(rows) || rows.length === 0) return [];

    const mode = String(cfg?.mode || "hybrid").toLowerCase();
    const provider = String(cfg?.provider || "").toLowerCase();

    let fieldKindMap = new Map();
    try {
        fieldKindMap = await resolveFieldKinds(rows, cfg);
    } catch (error) {
        if (mode === "llm-strict" && !cfg?.failOpen) {
            throw error;
        }
    }

    // In hybrid/deterministic mode the output is always deterministic and hash-based.
    if (mode !== "llm-strict") {
        return deterministicFallback(rows, cfg, fieldKindMap);
    }

    try {
        if (provider === "ollama") {
            return await anonymizeWithOllama(rows, cfg, fieldKindMap);
        }
        throw new Error(`Provider non supportato: ${cfg?.provider}`);
    } catch (error) {
        if (mode === "llm-strict" && !cfg?.failOpen) {
            throw error;
        }
        return deterministicFallback(rows, cfg, fieldKindMap);
    }
}
