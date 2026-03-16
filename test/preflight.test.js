import test from "node:test";
import assert from "node:assert/strict";

import { __dbClientTestUtils } from "../src/lib/db-client.js";
import { runProdPreflight } from "../src/lib/preflight.js";
import { runWithTimeout } from "../src/lib/timeout.js";

test.afterEach(() => {
    __dbClientTestUtils.reset();
});

test("runWithTimeout resolves completed work", async () => {
    const result = await runWithTimeout(async () => "ok", 50, "test preflight");
    assert.equal(result, "ok");
});

test("runWithTimeout rejects hung work", async () => {
    await assert.rejects(
        () => runWithTimeout(() => new Promise(() => {}), 10, "DB preflight"),
        /DB preflight timeout after 10ms/
    );
});

test("runProdPreflight rejects heuristic-only field identification", async () => {
    __dbClientTestUtils.setPoolFactory(() => ({
        config: { server: "localhost", options: {} },
        connect() {
            return Promise.resolve(this);
        },
        request() {
            return {
                stream: false,
                handlers: {},
                on(event, handler) {
                    this.handlers[event] = handler;
                },
                query() {
                    queueMicrotask(() => {
                        this.handlers.row?.({ ok: 1 });
                        this.handlers.done?.();
                    });
                    return Promise.resolve();
                }
            };
        },
        close() {
            return Promise.resolve();
        }
    }));

    await assert.rejects(
        () =>
            runProdPreflight({
                connectionString: "Server=localhost;Database=test;",
                queryTimeoutMs: 1000,
                preflightTimeoutMs: 1000,
                server: { host: "127.0.0.1" },
                anonymizer: {
                    provider: "ollama",
                    mode: "hybrid",
                    fieldIdentification: "heuristic",
                    baseUrl: "http://127.0.0.1:11434",
                    model: "qwen2.5:3b-instruct",
                    failOpen: false
                }
            }),
        /ANON_FIELD_IDENTIFICATION=heuristic non consentito/
    );
});
