import test from "node:test";
import assert from "node:assert/strict";

import { applyJsonAcceptCompatibility } from "../src/lib/accept-compat.js";

test("applyJsonAcceptCompatibility appends text/event-stream when SSE is disabled", () => {
    const headers = { accept: "application/json" };

    const changed = applyJsonAcceptCompatibility(headers, { sseEnabled: false });

    assert.equal(changed, true);
    assert.equal(headers.accept, "application/json, text/event-stream");
});

test("applyJsonAcceptCompatibility leaves accept untouched when SSE is enabled", () => {
    const headers = { accept: "application/json" };

    const changed = applyJsonAcceptCompatibility(headers, { sseEnabled: true });

    assert.equal(changed, false);
    assert.equal(headers.accept, "application/json");
});

test("applyJsonAcceptCompatibility leaves accept untouched when event-stream is already present", () => {
    const headers = { accept: "application/json, text/event-stream" };

    const changed = applyJsonAcceptCompatibility(headers, { sseEnabled: false });

    assert.equal(changed, false);
    assert.equal(headers.accept, "application/json, text/event-stream");
});

