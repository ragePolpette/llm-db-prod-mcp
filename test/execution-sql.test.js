import test from "node:test";
import assert from "node:assert/strict";

import { buildExecutionSql } from "../src/lib/execution-sql.js";

test("buildExecutionSql wraps validated read-only sql", () => {
    assert.equal(
        buildExecutionSql("SELECT 1 AS ok;", 4096),
        "SET TEXTSIZE 4096; SELECT 1 AS ok;"
    );
});

test("buildExecutionSql rejects non read-only sql", () => {
    assert.throws(
        () => buildExecutionSql("SELECT 1; DELETE FROM users", 4096),
        /una sola istruzione|lettura/
    );
});
