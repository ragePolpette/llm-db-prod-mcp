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
    withEnv({ ANON_HASH_SALT: undefined }, () => {
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

test("getProdConfig accepts explicit anonymization salt", () => {
    withEnv({ ANON_HASH_SALT: "stable-secret-for-tests" }, () => {
        const cfg = getProdConfig();
        assert.equal(cfg.anonymizer.hashSalt, "stable-secret-for-tests");
    });
});
