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

test("technical flags and generated references remain unchanged", async () => {
    const rows = [{ Estero: "1", numrif: "OQ00000009" }];

    const anonymized = await anonymizeRows(rows, baseCfg);

    assert.equal(anonymized[0].Estero, "1");
    assert.equal(anonymized[0].numrif, "OQ00000009");
});

test("structured technical codes remain unchanged when the field name is operational", async () => {
    const rows = [{ codice_ordine: "OQ00000010" }];

    const anonymized = await anonymizeRows(rows, baseCfg);

    assert.equal(anonymized[0].codice_ordine, "OQ00000010");
});

test("known pii keys still use specific deterministic replacements", async () => {
    const rows = [{ email: "user@example.com", telefono: "+39 333 1234567" }];

    const anonymized = await anonymizeRows(rows, baseCfg);

    assert.match(anonymized[0].email, /^user_[a-z0-9]+@example\.invalid$/);
    assert.match(anonymized[0].telefono, /^\+39\d+$/);
});

test("cf and partita iva remain unchanged in db context", async () => {
    const rows = [{ cf: "RSSMRA80A01H501U", partita_iva: "12345678901" }];

    const anonymized = await anonymizeRows(rows, baseCfg);

    assert.equal(anonymized[0].cf, "RSSMRA80A01H501U");
    assert.equal(anonymized[0].partita_iva, "12345678901");
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
    assert.equal(keys.includes("__global__|field_0"), false);
    assert.equal(keys.includes("__global__|field_overflow"), true);
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
        assert.equal(keysAfterOverflow.includes("__global__|field_0"), true);
        assert.equal(keysAfterOverflow.includes("__global__|field_1"), false);
        assert.equal(keysAfterOverflow.includes("__global__|fresh_overflow"), true);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("query scope cache separates same column names across different sources", async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = async () => {
        fetchCalls += 1;
        const kind = fetchCalls === 1 ? "email" : "text";
        return {
            ok: true,
            async json() {
                return {
                    message: {
                        content: JSON.stringify({
                            fields: {
                                shared_column: kind
                            }
                        })
                    }
                };
            }
        };
    };

    try {
        const first = await anonymizeRows(
            [{ shared_column: "user@example.com" }],
            {
                ...baseCfg,
                provider: "ollama",
                mode: "hybrid",
                fieldIdentification: "hybrid",
                baseUrl: "http://127.0.0.1:11434",
                model: "qwen2.5:3b-instruct"
            },
            { sqlText: "select shared_column from dbo.contacts" }
        );
        const second = await anonymizeRows(
            [{ shared_column: "memo interno riservato" }],
            {
                ...baseCfg,
                provider: "ollama",
                mode: "hybrid",
                fieldIdentification: "hybrid",
                baseUrl: "http://127.0.0.1:11434",
                model: "qwen2.5:3b-instruct"
            },
            { sqlText: "select shared_column from dbo.notes" }
        );

        assert.equal(fetchCalls, 2);
        assert.match(first[0].shared_column, /^user_[a-z0-9]+@example\.invalid$/);
        assert.match(second[0].shared_column, /^TEXT_/);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("query scope cache reuses the same source without a second ollama call", async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = async () => {
        fetchCalls += 1;
        return {
            ok: true,
            async json() {
                return {
                    message: {
                        content: JSON.stringify({
                            fields: {
                                customer_mail: "email"
                            }
                        })
                    }
                };
            }
        };
    };

    try {
        await anonymizeRows(
            [{ customer_mail: "one@example.com" }],
            {
                ...baseCfg,
                provider: "ollama",
                mode: "hybrid",
                fieldIdentification: "hybrid",
                baseUrl: "http://127.0.0.1:11434",
                model: "qwen2.5:3b-instruct"
            },
            { sqlText: "select customer_mail from dbo.contacts" }
        );
        await anonymizeRows(
            [{ customer_mail: "two@example.com" }],
            {
                ...baseCfg,
                provider: "ollama",
                mode: "hybrid",
                fieldIdentification: "hybrid",
                baseUrl: "http://127.0.0.1:11434",
                model: "qwen2.5:3b-instruct"
            },
            { sqlText: "select customer_mail from dbo.contacts" }
        );

        assert.equal(fetchCalls, 1);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("hybrid classification keeps accounting description unchanged when ollama returns none", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
        ok: true,
        async json() {
            return {
                message: {
                    content: JSON.stringify({
                        fields: {
                            Descrizione: "none"
                        }
                    })
                }
            };
        }
    });

    try {
        const rows = [{ Descrizione: "Conto economico riclassificato" }];
        const anonymized = await anonymizeRows(
            rows,
            {
                ...baseCfg,
                provider: "ollama",
                mode: "hybrid",
                fieldIdentification: "hybrid",
                baseUrl: "http://127.0.0.1:11434",
                model: "qwen2.5:3b-instruct"
            },
            { sqlText: "select Descrizione from dbo.DocPdc" }
        );

        assert.equal(anonymized[0].Descrizione, "Conto economico riclassificato");
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("hybrid classification can keep accounting code columns unchanged when ollama returns none", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
        ok: true,
        async json() {
            return {
                message: {
                    content: JSON.stringify({
                        fields: {
                            Conto: "none"
                        }
                    })
                }
            };
        }
    });

    try {
        const rows = [{ Conto: "1213628" }];
        const anonymized = await anonymizeRows(
            rows,
            {
                ...baseCfg,
                provider: "ollama",
                mode: "hybrid",
                fieldIdentification: "hybrid",
                baseUrl: "http://127.0.0.1:11434",
                model: "qwen2.5:3b-instruct"
            },
            { sqlText: "select Conto from dbo.DocPdc" }
        );

        assert.equal(anonymized[0].Conto, "1213628");
    } finally {
        globalThis.fetch = originalFetch;
    }
});
