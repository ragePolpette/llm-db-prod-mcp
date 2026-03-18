export function createSessionStore({ ttlMs = 0 } = {}) {
    const sessions = new Map();
    const ttlEnabled = Number(ttlMs) > 0;

    function prune(now = Date.now()) {
        if (!ttlEnabled) {
            return;
        }
        for (const [sessionId, entry] of sessions.entries()) {
            if (entry.expiresAt <= now) {
                sessions.delete(sessionId);
            }
        }
    }

    function set(sessionId, transport, now = Date.now()) {
        prune(now);
        sessions.set(sessionId, {
            transport,
            expiresAt: ttlEnabled ? now + ttlMs : Number.POSITIVE_INFINITY
        });
    }

    function get(sessionId, now = Date.now()) {
        prune(now);
        const entry = sessions.get(sessionId);
        if (!entry) {
            return null;
        }
        if (ttlEnabled) {
            entry.expiresAt = now + ttlMs;
        }
        return entry.transport;
    }

    function deleteSession(sessionId) {
        sessions.delete(sessionId);
    }

    return {
        set,
        get,
        delete: deleteSession,
        prune,
        size() {
            prune();
            return sessions.size;
        }
    };
}
