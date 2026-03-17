function normalizeHeaderValue(rawValue) {
    if (Array.isArray(rawValue)) {
        return typeof rawValue[0] === "string" ? rawValue[0].trim() : "";
    }
    return typeof rawValue === "string" ? rawValue.trim() : "";
}

export function applyJsonAcceptCompatibility(headers, { sseEnabled }) {
    if (sseEnabled) {
        return false;
    }

    const accept = normalizeHeaderValue(headers?.accept);
    if (!accept) {
        return false;
    }

    const lowered = accept.toLowerCase();
    if (!lowered.includes("application/json")) {
        return false;
    }
    if (lowered.includes("text/event-stream")) {
        return false;
    }

    headers.accept = `${accept}, text/event-stream`;
    return true;
}

