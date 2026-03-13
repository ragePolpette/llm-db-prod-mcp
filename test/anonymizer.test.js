import test from "node:test";
import assert from "node:assert/strict";

import { __anonymizerTestUtils, anonymizeRows } from "../src/lib/anonymizer.js";

const baseCfg = {
    mode: "deterministic",
    provider: "deterministic",
    fieldIdentification: "heuristic",
    hashSalt: "stable-secret-for-tests"
};

test.afterEach(() => {
    __anonymizerTestUtils.resetKindCache();
});

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

test("llm-strict uses the model only to classify fields and keeps masking deterministic", async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = async () => ({
        ok: true,
        async json() {
            fetchCalls += 1;
            return {
                message: {
                    content: JSON.stringify({
                        fields: {
                            destinatario: "email",
                            RagSoc: "org"
                        }
                    })
                }
            };
        }
    });

    try {
        const rows = [{ destinatario: "user@example.com", RagSoc: "ACME SPA" }];
        const anonymized = await anonymizeRows(rows, {
            ...baseCfg,
            mode: "llm-strict",
            provider: "ollama",
            fieldIdentification: "heuristic",
            baseUrl: "http://127.0.0.1:11434",
            model: "qwen2.5:3b-instruct",
            failOpen: false
        });

        assert.equal(fetchCalls, 1);
        assert.notEqual(anonymized[0].destinatario, "user@example.com");
        assert.notEqual(anonymized[0].RagSoc, "ACME SPA");
        assert.match(anonymized[0].destinatario, /^user_[a-z0-9]+@example\.invalid$/);
        assert.match(anonymized[0].RagSoc, /^ORG_/);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("llm-strict fails closed when field identification is unavailable", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
        throw new Error("ollama offline");
    };

    try {
        await assert.rejects(
            () =>
                anonymizeRows(
                    [{ destinatario: "user@example.com" }],
                    {
                        ...baseCfg,
                        mode: "llm-strict",
                        provider: "ollama",
                        fieldIdentification: "heuristic",
                        baseUrl: "http://127.0.0.1:11434",
                        model: "qwen2.5:3b-instruct",
                        failOpen: false
                    }
                ),
            /Field identification LLM fallita/
        );
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("llm anonymizer falls back when sensitive values differ only by formatting", () => {
    assert.equal(
        __anonymizerTestUtils.isUnsafeEcho(" user@example.com ", "user@example.com"),
        true
    );
    assert.equal(
        __anonymizerTestUtils.isUnsafeEcho("ACME, S.P.A.", "Acme SPA"),
        true
    );
    assert.equal(
        __anonymizerTestUtils.isUnsafeEcho("masked-value", "source-value"),
        false
    );
});

test("llm kind cache evicts the oldest key when max size is reached", () => {
    const maxSize = __anonymizerTestUtils.cacheMaxSize;

    for (let index = 0; index < maxSize; index += 1) {
        __anonymizerTestUtils.setCachedKind(`field_${index}`, "text");
    }
    __anonymizerTestUtils.setCachedKind("field_overflow", "email");

    const keys = __anonymizerTestUtils.getKindCacheKeys();
    assert.equal(keys.length, maxSize);
    assert.equal(keys.includes("field_0"), false);
    assert.equal(keys.includes("field_overflow"), true);
});

test("llm kind cache refreshes recency on read", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
        ok: true,
        async json() {
            return {
                message: {
                    content: JSON.stringify({
                        fields: {
                            fresh_key: "text"
                        }
                    })
                }
            };
        }
    });

    try {
        for (let index = 0; index < __anonymizerTestUtils.cacheMaxSize; index += 1) {
            __anonymizerTestUtils.setCachedKind(`field_${index}`, "text");
        }

        await anonymizeRows(
            [{ field_0: "hello" }],
            {
                ...baseCfg,
                provider: "ollama",
                fieldIdentification: "hybrid",
                baseUrl: "http://127.0.0.1:11434",
                model: "qwen2.5:3b-instruct"
            }
        );

        __anonymizerTestUtils.setCachedKind("fresh_overflow", "email");

        const keysAfterOverflow = __anonymizerTestUtils.getKindCacheKeys();
        assert.equal(keysAfterOverflow.includes("field_0"), true);
        assert.equal(keysAfterOverflow.includes("field_1"), false);
        assert.equal(keysAfterOverflow.includes("fresh_overflow"), true);
    } finally {
        globalThis.fetch = originalFetch;
    }
});
