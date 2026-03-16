import test from "node:test";
import assert from "node:assert/strict";

import { getProdConfig } from "../src/lib/config.js";

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

test("getProdConfig rejects missing anonymization salt", () => {
    withEnv({ ANON_HASH_SALT: " " }, () => {
        assert.throws(
            () => getProdConfig(),
            /ANON_HASH_SALT obbligatoria/
        );
    });
});

test("getProdConfig rejects placeholder anonymization salt", () => {
    withEnv({ ANON_HASH_SALT: "change-me-stable-secret" }, () => {
        assert.throws(
            () => getProdConfig(),
            /ANON_HASH_SALT non valida/
        );
    });
});

test("getProdConfig rejects local instructional anonymization placeholder", () => {
    withEnv({ ANON_HASH_SALT: "metti-un-segreto-stabile-lungo" }, () => {
        assert.throws(
            () => getProdConfig(),
            /ANON_HASH_SALT non valida/
        );
    });
});

test("getProdConfig rejects weak anonymization salts", () => {
    withEnv({ ANON_HASH_SALT: "stable-secret" }, () => {
        assert.throws(
            () => getProdConfig(),
            /almeno 16 caratteri/
        );
    });
});

test("getProdConfig accepts explicit strong anonymization salt", () => {
    withEnv({ ANON_HASH_SALT: "Stable-secret-for-tests-2026!" }, () => {
        const cfg = getProdConfig();
        assert.equal(cfg.anonymizer.hashSalt, "Stable-secret-for-tests-2026!");
    });
});

test("getProdConfig rejects deterministic provider in production", () => {
    withEnv(
        {
            ANON_HASH_SALT: "Stable-secret-for-tests-2026!",
            ANON_MODEL_PROVIDER: "deterministic"
        },
        () => {
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
            ANON_HASH_SALT: "Stable-secret-for-tests-2026!",
            DB_PROD_PREFLIGHT_TIMEOUT_MS: "15000"
        },
        () => {
            const cfg = getProdConfig();
            assert.equal(cfg.preflightTimeoutMs, 15000);
        }
    );
});

test("getProdConfig clamps max result bytes to hard 5MB cap", () => {
    withEnv(
        {
            ANON_HASH_SALT: "Stable-secret-for-tests-2026!",
            DB_PROD_MAX_RESULT_BYTES: String(50 * 1024 * 1024)
        },
        () => {
            const cfg = getProdConfig();
            assert.equal(cfg.maxResultBytes, 5 * 1024 * 1024);
        }
    );
});
