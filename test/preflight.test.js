import test from "node:test";
import assert from "node:assert/strict";

import { runWithTimeout } from "../src/lib/timeout.js";

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
