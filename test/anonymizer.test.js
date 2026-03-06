import test from "node:test";
import assert from "node:assert/strict";

import { anonymizeRows } from "../src/lib/anonymizer.js";

const baseCfg = {
    mode: "deterministic",
    provider: "deterministic",
    fieldIdentification: "heuristic",
    hashSalt: "stable-secret-for-tests"
};

test("default deny anonymizes unknown string columns", async () => {
    const rows = [{ RagSoc: "ACME SPA", id: 42 }];

    const anonymized = await anonymizeRows(rows, baseCfg);

    assert.match(anonymized[0].RagSoc, /^TEXT_/);
    assert.equal(anonymized[0].id, 42);
});

test("explicitly safe technical string fields remain unchanged", async () => {
    const rows = [{ status: "ACTIVE", created_at: "2026-03-06T10:00:00Z" }];

    const anonymized = await anonymizeRows(rows, baseCfg);

    assert.equal(anonymized[0].status, "ACTIVE");
    assert.equal(anonymized[0].created_at, "2026-03-06T10:00:00Z");
});

test("known pii keys still use specific deterministic replacements", async () => {
    const rows = [{ email: "user@example.com", telefono: "+39 333 1234567" }];

    const anonymized = await anonymizeRows(rows, baseCfg);

    assert.match(anonymized[0].email, /^user_[a-z0-9]+@example\.invalid$/);
    assert.match(anonymized[0].telefono, /^\+39\d+$/);
});

test("llm anonymizer falls back when sensitive values are echoed unchanged", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
        ok: true,
        async json() {
            return {
                message: {
                    content: JSON.stringify({
                        rows: [
                            {
                                email: "user@example.com",
                                RagSoc: "ACME SPA"
                            }
                        ]
                    })
                }
            };
        }
    });

    try {
        const rows = [{ email: "user@example.com", RagSoc: "ACME SPA" }];
        const anonymized = await anonymizeRows(rows, {
            ...baseCfg,
            mode: "llm-strict",
            provider: "ollama",
            fieldIdentification: "heuristic",
            baseUrl: "http://127.0.0.1:11434",
            model: "qwen2.5:3b-instruct",
            failOpen: false
        });

        assert.notEqual(anonymized[0].email, "user@example.com");
        assert.notEqual(anonymized[0].RagSoc, "ACME SPA");
        assert.match(anonymized[0].email, /^user_[a-z0-9]+@example\.invalid$/);
        assert.match(anonymized[0].RagSoc, /^TEXT_/);
    } finally {
        globalThis.fetch = originalFetch;
    }
});
