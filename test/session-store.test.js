import test from "node:test";
import assert from "node:assert/strict";
import { createSessionStore } from "../src/lib/session-store.js";

test("session store expires abandoned sessions after ttl", () => {
    const store = createSessionStore({ ttlMs: 1000 });
    const transport = { id: "t1" };

    store.set("abc", transport, 0);
    assert.equal(store.get("abc", 500), transport);
    assert.equal(store.get("abc", 1200), transport);
    assert.equal(store.get("abc", 2301), null);
});

test("session store keeps sessions forever when ttl is disabled", () => {
    const store = createSessionStore({ ttlMs: 0 });
    const transport = { id: "t1" };

    store.set("abc", transport, 0);
    assert.equal(store.get("abc", 500), transport);
    assert.equal(store.get("abc", 999999999), transport);
});
