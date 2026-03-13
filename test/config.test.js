import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";

import { __resetEnvLoaderForTests, getProdConfig } from "../src/lib/config.js";

function withEnv(overrides, fn) {
    const previous = new Map();
    for (const [key, value] of Object.entries(overrides)) {
        previous.set(key, process.env[key]);
        if (value === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    }

    try {
        return fn();
    } finally {
        for (const [key, value] of previous.entries()) {
            if (value === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        }
    }
}

function withTempCwd(fn) {
    const previousCwd = process.cwd();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-db-prod-config-"));

    process.chdir(tempDir);
    try {
        return fn();
    } finally {
        process.chdir(previousCwd);
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

afterEach(() => {
    __resetEnvLoaderForTests();
});

test("getProdConfig rejects missing anonymization salt", () => {
    withTempCwd(() => {
        withEnv({ ANON_HASH_SALT: undefined }, () => {
            assert.throws(
                () => getProdConfig(),
                /ANON_HASH_SALT obbligatoria/
            );
        });
    });
});

test("getProdConfig rejects placeholder anonymization salt", () => {
    withTempCwd(() => {
        withEnv({ ANON_HASH_SALT: "change-me-stable-secret" }, () => {
            assert.throws(
                () => getProdConfig(),
                /ANON_HASH_SALT non valida/
            );
        });
    });
});

test("getProdConfig accepts explicit anonymization salt", () => {
    withTempCwd(() => {
        withEnv({ ANON_HASH_SALT: "stable-secret-for-tests" }, () => {
            const cfg = getProdConfig();
            assert.equal(cfg.anonymizer.hashSalt, "stable-secret-for-tests");
        });
    });
});

test("getProdConfig exposes bounded preflight timeout", () => {
    withTempCwd(() => {
        withEnv(
            {
                ANON_HASH_SALT: "stable-secret-for-tests",
                DB_PROD_PREFLIGHT_TIMEOUT_MS: "15000"
            },
            () => {
                const cfg = getProdConfig();
                assert.equal(cfg.preflightTimeoutMs, 15000);
            }
        );
    });
});

test("getProdConfig clamps max result bytes to hard 5MB cap", () => {
    withTempCwd(() => {
        withEnv(
            {
                ANON_HASH_SALT: "stable-secret-for-tests",
                DB_PROD_MAX_RESULT_BYTES: String(50 * 1024 * 1024)
            },
            () => {
                const cfg = getProdConfig();
                assert.equal(cfg.maxResultBytes, 5 * 1024 * 1024);
            }
        );
    });
});
