import test from "node:test";
import assert from "node:assert/strict";

import { evaluateOrigin } from "../src/lib/origin-validation.js";

const allowedOrigins = [
    "http://localhost:*",
    "http://127.0.0.1:*",
    "https://localhost:*"
];

test("evaluateOrigin rejects missing origin header", () => {
    assert.deepEqual(evaluateOrigin({}, allowedOrigins), {
        ok: false,
        status: 403,
        message: "Forbidden: Missing Origin header"
    });
});

test("evaluateOrigin rejects non-allowlisted origin", () => {
    assert.deepEqual(evaluateOrigin({ origin: "https://evil.example" }, allowedOrigins), {
        ok: false,
        status: 403,
        message: "Forbidden: Origin not allowed"
    });
});

test("evaluateOrigin accepts allowed wildcard origin", () => {
    assert.deepEqual(evaluateOrigin({ origin: "http://localhost:3000" }, allowedOrigins), {
        ok: true,
        origin: "http://localhost:3000"
    });
});
