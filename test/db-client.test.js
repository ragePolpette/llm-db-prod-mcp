import test from "node:test";
import assert from "node:assert/strict";

import { __dbClientTestUtils, runReadQuery } from "../src/lib/db-client.js";

test.afterEach(() => {
    __dbClientTestUtils.reset();
});

test("runReadQuery retries after a failed initial pool connection", async () => {
    let attempts = 0;
    const fakeRequest = {
        stream: false,
        query() {
            queueMicrotask(() => {
                this.handlers.row?.({ ok: 1 });
                this.handlers.done?.();
            });
            return Promise.resolve();
        },
        on(event, handler) {
            this.handlers = this.handlers || {};
            this.handlers[event] = handler;
        }
    };
    const fakePool = {
        config: { server: "localhost", options: {} },
        connect() {
            attempts += 1;
            if (attempts === 1) {
                return Promise.reject(new Error("connect failed"));
            }
            return Promise.resolve(this);
        },
        request() {
            return fakeRequest;
        },
        close() {
            return Promise.resolve();
        }
    };

    __dbClientTestUtils.setPoolFactory(() => ({ ...fakePool }));

    await assert.rejects(
        () =>
            runReadQuery({
                connectionString: "Server=localhost;Database=test;",
                sqlText: "SELECT 1",
                parameters: {},
                maxRows: 1
            }),
        /connect failed/
    );

    const result = await runReadQuery({
        connectionString: "Server=localhost;Database=test;",
        sqlText: "SELECT 1",
        parameters: {},
        maxRows: 1
    });

    assert.equal(attempts, 2);
    assert.equal(result.rowCount, 1);
});

test("runReadQuery cancels the active request when abortSignal fires", async () => {
    let cancelCalls = 0;
    let activeRequest;
    const fakePool = {
        config: { server: "localhost", options: {} },
        connect() {
            return Promise.resolve(this);
        },
        request() {
            activeRequest = {
                stream: false,
                handlers: {},
                cancel() {
                    cancelCalls += 1;
                    queueMicrotask(() => this.handlers.error?.({ code: "ECANCEL", message: "cancelled" }));
                },
                on(event, handler) {
                    this.handlers[event] = handler;
                },
                query() {
                    return Promise.resolve();
                }
            };
            return activeRequest;
        },
        close() {
            return Promise.resolve();
        }
    };

    __dbClientTestUtils.setPoolFactory(() => fakePool);

    const abortController = new AbortController();
    const promise = runReadQuery({
        connectionString: "Server=localhost;Database=test;",
        sqlText: "SELECT 1",
        parameters: {},
        maxRows: 1,
        abortSignal: abortController.signal
    });

    abortController.abort("timeout");
    await Promise.race([
        promise,
        new Promise(resolve => setTimeout(resolve, 25))
    ]);

    assert.equal(cancelCalls, 1);
    assert.ok(activeRequest);
});
