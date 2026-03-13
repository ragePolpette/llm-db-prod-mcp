import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
    CallToolRequestSchema,
    ErrorCode,
    isInitializeRequest,
    ListToolsRequestSchema,
    McpError
} from "@modelcontextprotocol/sdk/types.js";
import { anonymizeRows } from "./lib/anonymizer.js";
import { getProdConfig } from "./lib/config.js";
import { runReadQuery } from "./lib/db-client.js";
import { evaluateOrigin } from "./lib/origin-validation.js";
import { runProdPreflight } from "./lib/preflight.js";
import { assertReadOnlySql } from "./lib/sql-guard.js";

const CORS_ALLOW_HEADERS = "Content-Type, Accept, MCP-Session-Id, MCP-Protocol-Version, Last-Event-ID";
const CORS_ALLOW_METHODS = "POST, GET, DELETE, OPTIONS";
const CORS_EXPOSE_HEADERS = "MCP-Session-Id";
const SESSION_ID_REGEX = /^[a-zA-Z0-9-]{1,128}$/;
const SUPPORTED_TOOL_NAMES = new Set(["db_prod_read_anonymized", "db_prod_info"]);

function normalizeSessionId(sessionIdRaw) {
    if (Array.isArray(sessionIdRaw)) {
        return null;
    }
    const value = typeof sessionIdRaw === "string" ? sessionIdRaw.trim() : "";
    if (!value) return null;
    if (!SESSION_ID_REGEX.test(value)) return null;
    return value;
}

function parseMaxRows(value, fallback) {
    if (value === undefined || value === null || value === "") {
        return fallback;
    }
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || !Number.isInteger(numeric)) {
        throw new Error("Parametro maxRows non valido: intero atteso.");
    }
    return Math.max(1, Math.min(numeric, 250));
}

function isAllowedParameterValue(value) {
    if (value === null) return true;
    if (value === undefined) return false;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
        return true;
    }
    if (value instanceof Date) return true;
    if (Buffer.isBuffer(value)) return true;
    return false;
}

function sanitizeParameters(input) {
    if (input === undefined || input === null) return undefined;
    if (typeof input !== "object" || Array.isArray(input)) {
        throw new Error("Parametro parameters non valido: oggetto key/value atteso.");
    }

    const entries = Object.entries(input);
    if (entries.length > 100) {
        throw new Error("Parametro parameters non valido: massimo 100 parametri.");
    }

    const out = {};
    for (const [key, value] of entries) {
        if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key)) {
            throw new Error(`Nome parametro SQL non valido: ${key}`);
        }
        if (!isAllowedParameterValue(value)) {
            throw new Error(`Valore parametro non supportato per '${key}'.`);
        }
        out[key] = value;
    }
    return out;
}

function asTextResult(payload) {
    return {
        content: [
            {
                type: "text",
                text: JSON.stringify(payload, null, 2)
            }
        ]
    };
}

function asToolError(message) {
    return {
        content: [
            {
                type: "text",
                text: message
            }
        ],
        isError: true
    };
}

function createToolDefinitions(config) {
    return [
        {
            name: "db_prod_read_anonymized",
            description: "DB PROD: sola lettura SQL su produzione con anonimizzazione obbligatoria prima della risposta.",
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false
            },
            inputSchema: {
                type: "object",
                additionalProperties: false,
                properties: {
                    sql: { type: "string", description: "Query SQL di sola lettura (SELECT/WITH)." },
                    parameters: {
                        type: "object",
                        description: "Parametri query (key/value).",
                        additionalProperties: true
                    },
                    maxRows: {
                        type: "integer",
                        description: `Numero massimo righe restituite (default ${config.maxRows}).`,
                        minimum: 1,
                        maximum: 250
                    }
                },
                required: ["sql"]
            }
        },
        {
            name: "db_prod_info",
            description: "Spiega scopo, limiti e regole di sicurezza del MCP DB PROD.",
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false
            },
            inputSchema: {
                type: "object",
                additionalProperties: false,
                properties: {}
            }
        }
    ];
}

function createToolHandler(config, dependencies) {
    return async (request) => {
        const { name, arguments: args } = request.params;
        if (!SUPPORTED_TOOL_NAMES.has(name)) {
            throw new McpError(ErrorCode.InvalidParams, `Tool non supportato: ${name}`);
        }

        try {
            if (name === "db_prod_info") {
                return asTextResult({
                    server: "llm-db-prod-mcp",
                    purpose: "Accesso SQL read-only al DB di produzione con anonimizzazione obbligatoria.",
                    capabilities: [
                        "db_prod_read_anonymized: SELECT/WITH + anonimizzazione output"
                    ],
                    constraints: [
                        "Nessuna write disponibile",
                        "Solo query read-only validate",
                        "Output sempre anonimizzato",
                        "Gli errori di validazione vengono restituiti come tool execution errors"
                    ]
                });
            }

            const sqlText = assertReadOnlySql(args?.sql);
            const maxRows = parseMaxRows(args?.maxRows, config.maxRows);
            const parameters = sanitizeParameters(args?.parameters);
            const dbResult = await dependencies.runReadQuery({
                connectionString: config.connectionString,
                sqlText,
                parameters,
                maxRows,
                queryTimeoutMs: config.queryTimeoutMs,
                maxResultBytes: config.maxResultBytes,
                textSizeBytes: config.textSizeBytes,
                maxRowBytes: config.maxRowBytes
            });

            const anonymized = await dependencies.anonymizeRows(dbResult.rows, config.anonymizer);
            return asTextResult({
                success: true,
                mode: "read_anonymized",
                rowCount: anonymized.length,
                truncated: dbResult.truncated,
                rows: anonymized
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : "Errore interno durante l'esecuzione del tool.";
            return asToolError(message);
        }
    };
}

export function createMcpServer({
    config,
    dependencies = {
        runReadQuery,
        anonymizeRows
    }
}) {
    const toolDefinitions = createToolDefinitions(config);
    const server = new Server(
        {
            name: "llm-db-prod-mcp",
            version: "1.0.0"
        },
        {
            capabilities: {
                tools: {}
            }
        }
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: toolDefinitions
    }));
    server.setRequestHandler(CallToolRequestSchema, createToolHandler(config, dependencies));

    return server;
}

function createErrorResponse(message) {
    return {
        jsonrpc: "2.0",
        error: {
            code: -32000,
            message
        },
        id: null
    };
}

function withOriginValidationFactory(config) {
    return function withOriginValidation(req, res, next) {
        if (req.path === "/health") {
            next();
            return;
        }

        if (!req.headers.origin) {
            next();
            return;
        }

        const result = evaluateOrigin(req.headers, config.server.allowedOrigins);
        if (!result.ok) {
            res.status(result.status).json(createErrorResponse(result.message));
            return;
        }

        res.append("Vary", "Origin");
        res.set("Access-Control-Allow-Origin", result.origin);
        res.set("Access-Control-Expose-Headers", CORS_EXPOSE_HEADERS);
        next();
    };
}

function sendCorsPreflight(res) {
    res.set("Access-Control-Allow-Methods", CORS_ALLOW_METHODS);
    res.set("Access-Control-Allow-Headers", CORS_ALLOW_HEADERS);
    res.set("Access-Control-Max-Age", "600");
    res.status(204).send();
}

function sendMissingSession(res) {
    res.status(400).json(createErrorResponse("Bad Request: Missing session ID"));
}

function sendUnknownSession(res) {
    res.status(404).json(createErrorResponse("Not Found: Invalid or expired session ID"));
}

export function createApp({
    config,
    transportStore = new Map(),
    serverFactory = createMcpServer
}) {
    const app = createMcpExpressApp({
        host: config.server.host,
        allowedHosts: config.server.allowedHosts?.length ? config.server.allowedHosts : undefined
    });

    app.use(withOriginValidationFactory(config));
    app.options(config.server.path, (_req, res) => {
        sendCorsPreflight(res);
    });

    app.get("/health", (_req, res) => {
        res.json({
            status: "ok",
            server: "llm-db-prod-mcp",
            endpoint: config.server.path,
            pid: process.pid,
            uptimeSec: Math.floor(process.uptime()),
            activeSessions: transportStore.size
        });
    });

    app.post(config.server.path, async (req, res) => {
        const rawSessionId = req.headers["mcp-session-id"];
        const sessionId = normalizeSessionId(rawSessionId);
        const hasSessionHeader = rawSessionId !== undefined;
        let transport;

        try {
            if (sessionId && transportStore.has(sessionId)) {
                transport = transportStore.get(sessionId);
                await transport.handleRequest(req, res, req.body);
                return;
            }

            if (hasSessionHeader && (!sessionId || !transportStore.has(sessionId))) {
                sendUnknownSession(res);
                return;
            }

            if (!sessionId && isInitializeRequest(req.body)) {
                const server = serverFactory({ config });
                transport = new StreamableHTTPServerTransport({
                    sessionIdGenerator: () => randomUUID(),
                    enableJsonResponse: !config.server.sseEnabled,
                    onsessioninitialized: sid => {
                        if (normalizeSessionId(sid)) {
                            transportStore.set(sid, transport);
                        }
                    }
                });

                transport.onclose = () => {
                    const sid = transport.sessionId;
                    if (sid && transportStore.has(sid)) {
                        transportStore.delete(sid);
                    }
                };

                await server.connect(transport);
                await transport.handleRequest(req, res, req.body);
                return;
            }

            sendMissingSession(res);
        } catch (error) {
            const message = error instanceof Error ? error.message : "Internal server error";
            console.error("POST MCP request failed:", message);
            if (!res.headersSent) {
                res.status(500).json(createErrorResponse("Internal server error"));
            }
        }
    });

    app.get(config.server.path, async (req, res) => {
        if (!config.server.sseEnabled) {
            res.status(405).set("Allow", "POST, DELETE").send("Method Not Allowed");
            return;
        }

        const rawSessionId = req.headers["mcp-session-id"];
        if (rawSessionId === undefined) {
            sendMissingSession(res);
            return;
        }

        const sessionId = normalizeSessionId(rawSessionId);
        if (!sessionId || !transportStore.has(sessionId)) {
            sendUnknownSession(res);
            return;
        }

        try {
            await transportStore.get(sessionId).handleRequest(req, res);
        } catch (error) {
            const message = error instanceof Error ? error.message : "Internal server error";
            console.error("GET MCP request failed:", message);
            if (!res.headersSent) {
                res.status(500).json(createErrorResponse("Internal server error"));
            }
        }
    });

    app.delete(config.server.path, async (req, res) => {
        const rawSessionId = req.headers["mcp-session-id"];
        if (rawSessionId === undefined) {
            sendMissingSession(res);
            return;
        }

        const sessionId = normalizeSessionId(rawSessionId);
        if (!sessionId || !transportStore.has(sessionId)) {
            sendUnknownSession(res);
            return;
        }

        try {
            await transportStore.get(sessionId).handleRequest(req, res);
        } catch (error) {
            const message = error instanceof Error ? error.message : "Internal server error";
            console.error("DELETE MCP request failed:", message);
            if (!res.headersSent) {
                res.status(500).json(createErrorResponse("Internal server error"));
            }
        }
    });

    return { app, transportStore };
}

export async function startServer({
    config = getProdConfig(),
    runPreflight = runProdPreflight,
    logger = console
} = {}) {
    await runPreflight(config);
    const { app, transportStore } = createApp({ config });

    return await new Promise((resolve, reject) => {
        const httpServer = app.listen(config.server.port, config.server.host, () => {
            const address = httpServer.address();
            const actualPort = typeof address === "object" && address ? address.port : config.server.port;
            logger.log(
                `llm-db-prod-mcp listening at http://${config.server.host}:${actualPort}${config.server.path}`
            );
            resolve({
                app,
                transportStore,
                httpServer,
                url: `http://${config.server.host}:${actualPort}${config.server.path}`
            });
        });

        httpServer.on("error", reject);
    });
}

export async function stopServer(httpServer) {
    if (!httpServer) return;
    await new Promise((resolve, reject) => {
        httpServer.close(error => {
            if (error) {
                reject(error);
                return;
            }
            resolve();
        });
    });
}

function isDirectRun() {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isDirectRun()) {
    startServer().catch(error => {
        const message = error instanceof Error ? error.message : String(error);
        console.error("Preflight failed for llm-db-prod-mcp:", message);
        process.exit(1);
    });
}
