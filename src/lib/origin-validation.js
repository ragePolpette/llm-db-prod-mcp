function normalizeHeaderValue(rawValue) {
    if (Array.isArray(rawValue)) {
        return typeof rawValue[0] === "string" ? rawValue[0].trim() : "";
    }
    return typeof rawValue === "string" ? rawValue.trim() : "";
}

function normalizeOrigin(origin) {
    try {
        const parsed = new URL(origin);
        const protocol = parsed.protocol.toLowerCase();
        const host = parsed.hostname.toLowerCase();
        if (!["http:", "https:"].includes(protocol) || !host) {
            return null;
        }
        return parsed.port ? `${protocol}//${host}:${parsed.port}` : `${protocol}//${host}`;
    } catch {
        return null;
    }
}

function isOriginAllowed(origin, allowedOrigins) {
    const normalizedOrigin = normalizeOrigin(origin);
    if (!normalizedOrigin) return false;
    for (const rawPattern of allowedOrigins) {
        const pattern = String(rawPattern || "").trim().toLowerCase();
        if (!pattern) continue;
        if (pattern === normalizedOrigin) return true;
        if (pattern.endsWith(":*")) {
            const prefix = pattern.slice(0, -2);
            if (normalizedOrigin.startsWith(`${prefix}:`)) {
                return true;
            }
        }
    }
    return false;
}

export function evaluateOrigin(headers, allowedOrigins) {
    const origin = normalizeHeaderValue(headers?.origin);
    if (!origin) {
        return {
            ok: false,
            status: 403,
            message: "Forbidden: Missing Origin header"
        };
    }

    if (!isOriginAllowed(origin, allowedOrigins)) {
        return {
            ok: false,
            status: 403,
            message: "Forbidden: Origin not allowed"
        };
    }

    return {
        ok: true,
        origin
    };
}
