import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

async function withTempEnvFile(dotEnvContent, querySuffix, fn) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-db-prod-config-"));
    const originalCwd = process.cwd();
    try {
        process.chdir(tempDir);
        if (dotEnvContent !== null) {
            fs.writeFileSync(path.join(tempDir, ".env"), dotEnvContent);
        }
        const configModule = await import(new URL(`../src/lib/config.js?case=${querySuffix}`, import.meta.url));
        return await fn(configModule);
    } finally {
        process.chdir(originalCwd);
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

test("getProdConfig rejects missing anonymization salt", () => {
    withEnv({ DB_PROD_CONNECTION_STRING: "Server=runtime;", ANON_HASH_SALT: " " }, () => {
        const { getProdConfig } = requireConfigModule();
        assert.throws(
            () => getProdConfig(),
            /ANON_HASH_SALT obbligatoria/
        );
    });
});

test("getProdConfig rejects placeholder anonymization salt", () => {
    withEnv({ DB_PROD_CONNECTION_STRING: "Server=runtime;", ANON_HASH_SALT: "change-me-stable-secret" }, () => {
        const { getProdConfig } = requireConfigModule();
        assert.throws(
            () => getProdConfig(),
            /ANON_HASH_SALT non valida/
        );
    });
});

test("getProdConfig rejects local instructional anonymization placeholder", () => {
    withEnv({ DB_PROD_CONNECTION_STRING: "Server=runtime;", ANON_HASH_SALT: "metti-un-segreto-stabile-lungo" }, () => {
        const { getProdConfig } = requireConfigModule();
        assert.throws(
            () => getProdConfig(),
            /ANON_HASH_SALT non valida/
        );
    });
});

test("getProdConfig rejects weak anonymization salts", () => {
    withEnv({ DB_PROD_CONNECTION_STRING: "Server=runtime;", ANON_HASH_SALT: "stable-secret" }, () => {
        const { getProdConfig } = requireConfigModule();
        assert.throws(
            () => getProdConfig(),
            /almeno 16 caratteri/
        );
    });
});

test("getProdConfig accepts explicit strong anonymization salt", () => {
    withEnv({ DB_PROD_CONNECTION_STRING: "Server=runtime;", ANON_HASH_SALT: "Stable-secret-for-tests-2026!" }, () => {
        const { getProdConfig } = requireConfigModule();
        const cfg = getProdConfig();
        assert.equal(cfg.anonymizer.hashSalt, "Stable-secret-for-tests-2026!");
    });
});

test("getProdConfig rejects deterministic provider in production", () => {
    withEnv(
        {
            DB_PROD_CONNECTION_STRING: "Server=runtime;",
            ANON_HASH_SALT: "Stable-secret-for-tests-2026!",
            ANON_MODEL_PROVIDER: "deterministic"
        },
        () => {
            const { getProdConfig } = requireConfigModule();
            assert.throws(
                () => getProdConfig(),
                /ANON_MODEL_PROVIDER=deterministic non consentito/
            );
        }
    );
});

test("getProdConfig exposes bounded preflight timeout", () => {
    withEnv(
        {
            DB_PROD_CONNECTION_STRING: "Server=runtime;",
            ANON_HASH_SALT: "Stable-secret-for-tests-2026!",
            DB_PROD_PREFLIGHT_TIMEOUT_MS: "15000"
        },
        () => {
            const { getProdConfig } = requireConfigModule();
            const cfg = getProdConfig();
            assert.equal(cfg.preflightTimeoutMs, 15000);
        }
    );
});

test("getProdConfig clamps max result bytes to hard 5MB cap", () => {
    withEnv(
        {
            DB_PROD_CONNECTION_STRING: "Server=runtime;",
            ANON_HASH_SALT: "Stable-secret-for-tests-2026!",
            DB_PROD_MAX_RESULT_BYTES: String(50 * 1024 * 1024)
        },
        () => {
            const { getProdConfig } = requireConfigModule();
            const cfg = getProdConfig();
            assert.equal(cfg.maxResultBytes, 5 * 1024 * 1024);
        }
    );
});

function requireConfigModule() {
    return requireConfigModule.cache ??= (() => {
        throw new Error("requireConfigModule cache not initialized");
    })();
}

requireConfigModule.cache = null;

test.beforeEach(async () => {
    requireConfigModule.cache = await import(new URL(`../src/lib/config.js?case=${Date.now()}-${Math.random()}`, import.meta.url));
});

test("getProdConfig rejects DB_PROD_CONNECTION_STRING inside dot env", async () => {
    const originalEnv = process.env.DB_PROD_CONNECTION_STRING;
    const originalSalt = process.env.ANON_HASH_SALT;
    try {
        delete process.env.DB_PROD_CONNECTION_STRING;
        process.env.ANON_HASH_SALT = "Stable-secret-for-tests-2026!";
        await withTempEnvFile(
            "DB_PROD_CONNECTION_STRING=from-dot-env\n",
            `${Date.now()}-reject-dot-env`,
            async configModule => {
                assert.throws(
                    () => configModule.getProdConfig(),
                    /Il file \.env non puo' contenere DB_PROD_CONNECTION_STRING/
                );
            }
        );
    } finally {
        if (originalEnv === undefined) delete process.env.DB_PROD_CONNECTION_STRING;
        else process.env.DB_PROD_CONNECTION_STRING = originalEnv;
        if (originalSalt === undefined) delete process.env.ANON_HASH_SALT;
        else process.env.ANON_HASH_SALT = originalSalt;
    }
});

test("getProdConfig accepts DB_PROD_CONNECTION_STRING from process env when dot env omits it", async () => {
    const originalEnv = process.env.DB_PROD_CONNECTION_STRING;
    const originalSalt = process.env.ANON_HASH_SALT;
    try {
        process.env.DB_PROD_CONNECTION_STRING = "Server=runtime;";
        process.env.ANON_HASH_SALT = "Stable-secret-for-tests-2026!";
        await withTempEnvFile(
            "DB_PROD_MAX_ROWS=123\n",
            `${Date.now()}-runtime-env`,
            async configModule => {
                const cfg = configModule.getProdConfig();
                assert.equal(cfg.connectionString, "Server=runtime;");
                assert.equal(cfg.maxRows, 123);
            }
        );
    } finally {
        if (originalEnv === undefined) delete process.env.DB_PROD_CONNECTION_STRING;
        else process.env.DB_PROD_CONNECTION_STRING = originalEnv;
        if (originalSalt === undefined) delete process.env.ANON_HASH_SALT;
        else process.env.ANON_HASH_SALT = originalSalt;
    }
});
