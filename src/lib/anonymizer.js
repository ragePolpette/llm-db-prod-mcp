import { createHash } from "node:crypto";

const EMAIL_REGEX = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PHONE_TEXT_REGEX = /(?=.*[+\s().-])(\+?\d[\d\s().-]{6,}\d)/g;
const KIND_VALUES = new Set(["email", "phone", "name", "org", "address", "city", "text"]);
const NONE_KIND = "__none__";
const LLM_KIND_CACHE_MAX_SIZE = 512;
const GLOBAL_CACHE_SCOPE = "__global__";
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
    "data",
    "estero",
    "numrif",
    "num_rif",
    "cf",
    "codicefiscale",
    "codice_fiscale",
    "cod_fiscale",
    "codfiscale",
    "codfiscalerl",
    "partitaiva",
    "partita_iva",
    "piva",
    "vat",
    "pi"
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
    "data",
    "flag",
    "stato",
    "tipo"
]);

const FLAG_LITERALS = new Set(["0", "1", "y", "n", "s", "no", "si", "yes", "true", "false", "t", "f"]);
const TECHNICAL_CODE_REGEXES = [
    /^[A-Z]{1,5}\d{4,}[A-Z0-9_-]*$/i,
    /^[A-Z0-9]{1,6}[-_/][A-Z0-9_-]{2,}$/i
];
const TECHNICAL_CODE_TOKENS = new Set([
    "codice",
    "code",
    "num",
    "numero",
    "rif",
    "numrif",
    "order",
    "ordine",
    "protocollo",
    "conto",
    "flag",
    "stato",
    "tipo",
    "estero"
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

function normalizeScalar(value) {
    if (value === null || value === undefined) return "";
    return String(value).trim();
}

function buildColumnProfiles(rows) {
    const profiles = new Map();
    for (const row of rows) {
        if (!isObject(row)) continue;
        for (const [key, rawValue] of Object.entries(row)) {
            const normalizedKey = normalizeKey(key);
            if (!normalizedKey) continue;
            let profile = profiles.get(normalizedKey);
            if (!profile) {
                profile = {
                    key,
                    normalizedKey,
                    values: [],
                    distinct: new Set()
                };
                profiles.set(normalizedKey, profile);
            }
            if (rawValue === null || rawValue === undefined || rawValue === "") continue;
            const value = normalizeScalar(rawValue);
            if (!value) continue;
            profile.values.push(value);
            if (profile.distinct.size < 16) {
                profile.distinct.add(value);
            }
        }
    }
    return profiles;
}

function isStructuredTechnicalCode(value) {
    const text = normalizeScalar(value);
    if (!text || text.includes("@")) return false;
    return TECHNICAL_CODE_REGEXES.some((regex) => regex.test(text));
}

function isFlagLikeProfile(profile) {
    if (!profile || profile.values.length === 0) return false;
    if (profile.distinct.size > 4) return false;
    return [...profile.distinct].every((value) => {
        const normalized = normalizeScalar(value).toLowerCase();
        return normalized.length > 0 && normalized.length <= 5 && FLAG_LITERALS.has(normalized);
    });
}

function isStructuredTechnicalCodeProfile(normalizedKey, profile) {
    if (!profile || profile.values.length === 0) return false;
    const tokens = tokenSetFromKey(normalizedKey);
    const technicalByName =
        SAFE_EXACT_KEYS.has(normalizedKey) ||
        hasAnyToken(tokens, [...TECHNICAL_CODE_TOKENS]);
    if (!technicalByName) return false;
    return profile.values.every(isStructuredTechnicalCode);
}

function isShortEnumProfile(normalizedKey, profile) {
    if (!profile || profile.values.length < 2) return false;
    const tokens = tokenSetFromKey(normalizedKey);
    const technicalByName =
        SAFE_EXACT_KEYS.has(normalizedKey) ||
        hasAnyToken(tokens, ["status", "stato", "type", "tipo", "flag", "estero"]);
    if (!technicalByName) return false;
    if (profile.distinct.size === 0 || profile.distinct.size > 6) return false;
    return [...profile.distinct].every((value) => {
        const text = normalizeScalar(value);
        return text.length > 0 && text.length <= 16 && !/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(text);
    });
}

function isTechnicalSafeColumn(key, value, columnProfiles) {
    const normalizedKey = normalizeKey(key);
    if (!normalizedKey) return false;
    if (isExplicitlySafeKey(key)) return true;
    const profile = columnProfiles?.get(normalizedKey) || null;
    if (SAFE_EXACT_KEYS.has(normalizedKey)) return true;
    if (
        profile &&
        (isFlagLikeProfile(profile) ||
            isStructuredTechnicalCodeProfile(normalizedKey, profile) ||
            isShortEnumProfile(normalizedKey, profile))
    ) {
        return true;
    }
    return isStructuredTechnicalCode(value) && hasAnyToken(tokenSetFromKey(normalizedKey), [...TECHNICAL_CODE_TOKENS]);
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

    if (hasAnyToken(tokens, ["note", "comment", "memo"])) {
        return "text";
    }

    return null;
}

function normalizeKind(kind) {
    const value = String(kind || "").trim().toLowerCase();
    if (!value || value === "none" || value === "null") return NONE_KIND;
    return KIND_VALUES.has(value) ? value : NONE_KIND;
}

function normalizeCacheScope(scope) {
    const value = String(scope || "").trim().toLowerCase();
    return value || GLOBAL_CACHE_SCOPE;
}

function cacheKeyFor(normalizedKey, scope = GLOBAL_CACHE_SCOPE) {
    return `${normalizeCacheScope(scope)}|${String(normalizedKey || "")}`;
}

function getCachedKindDecision(normalizedKey, scope = GLOBAL_CACHE_SCOPE) {
    const cacheKey = cacheKeyFor(normalizedKey, scope);
    if (!LLM_KIND_CACHE.has(cacheKey)) return null;
    const value = LLM_KIND_CACHE.get(cacheKey);
    LLM_KIND_CACHE.delete(cacheKey);
    LLM_KIND_CACHE.set(cacheKey, value);
    return value;
}

function getCachedKind(normalizedKey, scope = GLOBAL_CACHE_SCOPE) {
    const value = getCachedKindDecision(normalizedKey, scope);
    return value === NONE_KIND ? null : value;
}

function setCachedKind(normalizedKey, kind, scope = GLOBAL_CACHE_SCOPE) {
    const normalizedKind = normalizeKind(kind);
    const cacheKey = cacheKeyFor(normalizedKey, scope);
    if (LLM_KIND_CACHE.has(cacheKey)) {
        LLM_KIND_CACHE.delete(cacheKey);
        LLM_KIND_CACHE.set(cacheKey, normalizedKind);
        return;
    }

    if (LLM_KIND_CACHE.size >= LLM_KIND_CACHE_MAX_SIZE) {
        const oldestKey = LLM_KIND_CACHE.keys().next().value;
        if (oldestKey !== undefined) {
            LLM_KIND_CACHE.delete(oldestKey);
        }
    }
    LLM_KIND_CACHE.set(cacheKey, normalizedKind);
}

function normalizeSqlSourceName(rawSource) {
    return String(rawSource || "")
        .trim()
        .replace(/^[[`"]+|[\]`"]+$/g, "")
        .replace(/\s+/g, "")
        .toLowerCase();
}

function deriveCacheScopeFromSql(sqlText) {
    const sql = String(sqlText || "");
    const matches = [...sql.matchAll(/\b(?:from|join)\s+([A-Za-z0-9_\[\]".]+)/gi)];
    const sources = [...new Set(matches.map(match => normalizeSqlSourceName(match[1])).filter(Boolean))];
    if (sources.length === 0) {
        return GLOBAL_CACHE_SCOPE;
    }
    return sources.sort().join("|");
}

function extractSqlSources(sqlText) {
    const sql = String(sqlText || "");
    const matches = [...sql.matchAll(/\b(?:from|join)\s+([A-Za-z0-9_\[\]".]+)/gi)];
    return [...new Set(matches.map(match => normalizeSqlSourceName(match[1])).filter(Boolean))].sort();
}

function resolveKindForKey(key, fieldKindMap, cacheScope = GLOBAL_CACHE_SCOPE) {
    const normalized = normalizeKey(key);
    if (!normalized) return null;

    if (fieldKindMap?.has(normalized)) {
        return fieldKindMap.get(normalized);
    }

    const cachedDecision = getCachedKindDecision(normalized, cacheScope);
    if (cachedDecision) {
        return cachedDecision;
    }

    return inferKindHeuristic(key);
}

function resolveKindForValue(key, value, fieldKindMap, cacheScope = GLOBAL_CACHE_SCOPE, columnProfiles = null) {
    const kind = resolveKindForKey(key, fieldKindMap, cacheScope);
    if (kind) return kind;
    if (isTechnicalSafeColumn(key, value, columnProfiles)) return NONE_KIND;
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

function replaceByKind(kind, key, value, cfg) {
    const raw = String(value ?? "");
    const normalizedKey = normalizeKey(key);
    const salt = getHashSalt(cfg);

    switch (kind) {
        case "email":
            return `user_${stableDigest(salt, normalizedKey, raw, 10).toLowerCase()}@example.invalid`;
        case "phone":
            return toPhoneFromDigest(salt, normalizedKey, raw);
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
        .replace(PHONE_TEXT_REGEX, (match) => toPhoneFromDigest(salt, "inline_phone", match));
}

function normalizeSensitiveString(value) {
    return String(value || "")
        .normalize("NFKC")
        .toLowerCase()
        .replace(/[\s\p{P}\p{S}_]+/gu, "");
}

function isUnsafeEcho(candidateValue, sourceValue) {
    if (candidateValue === sourceValue) return true;
    if (typeof candidateValue !== "string" || typeof sourceValue !== "string") {
        return false;
    }

    if (candidateValue.trim() === sourceValue.trim()) {
        return true;
    }

    const normalizedCandidate = normalizeSensitiveString(candidateValue);
    const normalizedSource = normalizeSensitiveString(sourceValue);
    return normalizedCandidate.length > 0 && normalizedCandidate === normalizedSource;
}

function deterministicFallback(rows, cfg, fieldKindMap, cacheScope = GLOBAL_CACHE_SCOPE, columnProfiles = null) {
    return rows.map((row) => {
        if (!isObject(row)) return row;

        const out = { ...row };
        for (const key of Object.keys(out)) {
            const value = out[key];
            if (value === null || value === undefined) continue;

            const kind = resolveKindForValue(key, value, fieldKindMap, cacheScope, columnProfiles);
            if (kind === NONE_KIND) {
                continue;
            }
            if (kind) {
                out[key] = replaceByKind(kind, key, value, cfg);
                continue;
            }

            if (typeof value === "string" && !isTechnicalSafeColumn(key, value, columnProfiles)) {
                out[key] = maskInlineWithHashes(value, cfg);
            }
        }
        return out;
    });
}

function buildFieldProbePayload(rows, columnProfiles = null) {
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
            const normalizedKey = normalizeKey(key);
            const profile = columnProfiles?.get(normalizedKey) || null;
            const sample = firstObject[key];
            return {
                key,
                sample: sample === null || sample === undefined ? null : String(sample).slice(0, 80),
                samples: profile ? [...profile.distinct].slice(0, 5) : [],
                distinct_count: profile ? profile.distinct.size : 0,
                technical_hint: profile
                    ? {
                        flag_like: isFlagLikeProfile(profile),
                        structured_code_like: isStructuredTechnicalCodeProfile(normalizedKey, profile),
                        enum_like: isShortEnumProfile(normalizedKey, profile)
                    }
                    : undefined
            };
        })
        .slice(0, 400);
}

async function identifyFieldsWithOllama(rows, cfg, cacheScope = GLOBAL_CACHE_SCOPE, columnProfiles = null) {
    const payload = buildFieldProbePayload(rows, columnProfiles);
    if (payload.length === 0) return new Map();

    const unknown = payload.filter((entry) => !getCachedKindDecision(normalizeKey(entry.key), cacheScope));
    if (unknown.length === 0) {
        const known = new Map();
        for (const entry of payload) {
            const normalized = normalizeKey(entry.key);
            const kind = getCachedKindDecision(normalized, cacheScope);
            if (kind) known.set(normalized, kind);
        }
        return known;
    }

    const systemPrompt = [
        "Classifica campi database per anonimizzazione.",
        "Rispondi SOLO con JSON valido formato: {\"fields\":{\"<key>\":\"<kind>\"}}.",
        "kind ammessi: email, phone, name, org, address, city, text, none.",
        "Usa none per campi tecnici, amministrativi, contabili, numerici, enumerati o descrittivi non personali e non identificativi.",
        "Esempi tipici di none: id, codice, conto, numero documento, protocollo, stato, tipo, flag, data, timestamp, importo, aliquota, descrizione contabile, causale, riferimento amministrativo, note tecniche, campi di classificazione interna, codici fissi come OQ00000009 e flag come 0/1 o Y/N.",
        "Usa text solo se il contenuto libero puo' ragionevolmente contenere dati personali o aziendali sensibili in chiaro.",
        "Non usare text come fallback generico per qualunque descrizione.",
        "Usa org solo per denominazioni o ragioni sociali reali di aziende o enti.",
        "Usa name solo per nomi o cognomi di persone.",
        "Codice fiscale e partita IVA in questo contesto DB non sono campi sensibili: scegli none.",
        "Se il campo non appare chiaramente sensibile, scegli none.",
        "Non aggiungere testo extra."
    ].join(" ");

    const userPrompt = JSON.stringify({
        query_sources: extractSqlSources(cfg?.sqlText),
        fields: unknown
    });
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
        setCachedKind(normalized, inferred, cacheScope);
    }

    const resolved = new Map();
    for (const entry of payload) {
        const normalized = normalizeKey(entry.key);
        const kind = getCachedKindDecision(normalized, cacheScope);
        if (kind) resolved.set(normalized, kind);
    }
    return resolved;
}

async function resolveFieldKinds(rows, cfg, cacheScope = GLOBAL_CACHE_SCOPE, columnProfiles = null) {
    const mode = String(cfg?.mode || "hybrid").toLowerCase();
    const provider = String(cfg?.provider || "").toLowerCase();
    const strategy = String(cfg?.fieldIdentification || "hybrid").toLowerCase();
    const requireLlmClassification = mode === "llm-strict";

    if (!requireLlmClassification && (strategy === "heuristic" || provider !== "ollama")) {
        return new Map();
    }

    if (!cfg?.baseUrl || !cfg?.model) {
        if (requireLlmClassification || strategy === "llm") {
            throw new Error("Field identification LLM non disponibile: baseUrl/model mancanti.");
        }
        return new Map();
    }

    try {
        return await identifyFieldsWithOllama(rows, cfg, cacheScope, columnProfiles);
    } catch {
        if (requireLlmClassification || strategy === "llm") {
            throw new Error("Field identification LLM fallita.");
        }
        return new Map();
    }
}

export async function anonymizeRows(rows, cfg, options = {}) {
    if (!Array.isArray(rows) || rows.length === 0) return [];

    const mode = String(cfg?.mode || "hybrid").toLowerCase();
    const cacheScope = deriveCacheScopeFromSql(options?.sqlText);
    const columnProfiles = buildColumnProfiles(rows);

    let fieldKindMap = new Map();
    try {
        fieldKindMap = await resolveFieldKinds(rows, { ...cfg, sqlText: options?.sqlText }, cacheScope, columnProfiles);
    } catch (error) {
        if (mode === "llm-strict" && !cfg?.failOpen) {
            throw error;
        }
    }

    // The model may help classify sensitive fields, but the final masked value must remain deterministic.
    return deterministicFallback(rows, cfg, fieldKindMap, cacheScope, columnProfiles);
}

export const __anonymizerTestUtils = {
    cacheMaxSize: LLM_KIND_CACHE_MAX_SIZE,
    isUnsafeEcho,
    deriveCacheScopeFromSql,
    resetKindCache() {
        LLM_KIND_CACHE.clear();
    },
    getKindCacheKeys() {
        return [...LLM_KIND_CACHE.keys()];
    },
    setCachedKind,
    normalizeKind
};
