import test from "node:test";
import assert from "node:assert/strict";

import { startServer, stopServer } from "../src/server.js";

const silentLogger = {
    log() {},
    error() {}
};

const testConfig = {
    connectionString: "Server=127.0.0.1;Database=prod;User Id=test;Password=test;TrustServerCertificate=True;",
    maxRows: 200,
    queryTimeoutMs: 9000,
    preflightTimeoutMs: 8000,
    maxResultBytes: 5 * 1024 * 1024,
    textSizeBytes: 262144,
    maxRowBytes: 262144,
    anonymizer: {
        provider: "deterministic",
        mode: "deterministic",
        fieldIdentification: "heuristic",
        hashSalt: "stable-secret-for-tests",
        baseUrl: "http://127.0.0.1:11434",
        model: "unused",
        failOpen: false,
        timeoutMs: 5000,
        llmMaxRows: 2,
        llmMaxCells: 40,
        llmMaxInputChars: 3000
    },
    modelsDir: ".local/models",
    ollamaModelsDir: ".local/models/ollama",
    server: {
        host: "127.0.0.1",
        port: 0,
        path: "/mcp",
        sseEnabled: false,
        allowedHosts: ["127.0.0.1", "localhost"],
        allowedOrigins: ["http://127.0.0.1:*", "https://127.0.0.1:*"]
    }
};

async function withServer(fn) {
    const running = await startServer({
        config: structuredClone(testConfig),
        runPreflight: async () => {},
        logger: silentLogger
    });

    try {
        await fn(running);
    } finally {
        await stopServer(running.httpServer);
    }
}

async function mcpRequest(url, body, headers = {}) {
    const response = await fetch(url, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            ...headers
        },
        body: JSON.stringify(body)
    });

    return {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body: await response.json()
    };
}

test("prod server accepts initialize without Origin for non-browser clients", async () => {
    await withServer(async ({ url }) => {
        const response = await mcpRequest(url, {
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
                protocolVersion: "2025-11-25",
                capabilities: {},
                clientInfo: { name: "prod-smoke", version: "1.0.0" }
            }
        });

        assert.equal(response.status, 200);
        assert.equal(response.body.result.protocolVersion, "2025-11-25");
        assert.ok(response.headers["mcp-session-id"]);
    });
});

test("prod server rejects hostile origins but exposes session header to allowed browser clients", async () => {
    await withServer(async ({ url }) => {
        const hostile = await mcpRequest(
            url,
            {
                jsonrpc: "2.0",
                id: 1,
                method: "initialize",
                params: {
                    protocolVersion: "2025-11-25",
                    capabilities: {},
                    clientInfo: { name: "prod-smoke", version: "1.0.0" }
                }
            },
            {
                origin: "https://evil.example"
            }
        );
        assert.equal(hostile.status, 403);

        const allowed = await mcpRequest(
            url,
            {
                jsonrpc: "2.0",
                id: 2,
                method: "initialize",
                params: {
                    protocolVersion: "2025-11-25",
                    capabilities: {},
                    clientInfo: { name: "prod-smoke", version: "1.0.0" }
                }
            },
            {
                origin: "http://127.0.0.1:3000"
            }
        );

        assert.equal(allowed.status, 200);
        assert.equal(allowed.headers["access-control-allow-origin"], "http://127.0.0.1:3000");
        assert.match(allowed.headers["access-control-expose-headers"] || "", /mcp-session-id/i);
    });
});

test("prod server returns tool execution errors for invalid tool input", async () => {
    await withServer(async ({ url }) => {
        const initialize = await mcpRequest(url, {
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
                protocolVersion: "2025-11-25",
                capabilities: {},
                clientInfo: { name: "prod-smoke", version: "1.0.0" }
            }
        });

        const response = await mcpRequest(
            url,
            {
                jsonrpc: "2.0",
                id: 2,
                method: "tools/call",
                params: {
                    name: "db_prod_read_anonymized",
                    arguments: {
                        sql: "SELECT 1 AS ok",
                        maxRows: "abc"
                    }
                }
            },
            {
                "mcp-session-id": initialize.headers["mcp-session-id"],
                "mcp-protocol-version": "2025-11-25"
            }
        );

        assert.equal(response.status, 200);
        assert.ok(response.body.result);
        assert.equal(response.body.result.isError, true);
        assert.equal(response.body.error, undefined);
        assert.match(response.body.result.content[0].text, /Parametro maxRows non valido/);
    });
});

test("prod server preflight advertises protocol header support", async () => {
    await withServer(async ({ url }) => {
        const response = await fetch(url, {
            method: "OPTIONS",
            headers: {
                origin: "http://127.0.0.1:3000",
                "access-control-request-method": "POST",
                "access-control-request-headers": "content-type,mcp-session-id,mcp-protocol-version"
            }
        });

        assert.equal(response.status, 204);
        assert.match(response.headers.get("access-control-allow-headers") || "", /mcp-protocol-version/i);
        assert.match(response.headers.get("access-control-allow-headers") || "", /last-event-id/i);
    });
});
