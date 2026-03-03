const READ_ONLY_START = /^\s*(select|with)\b/i;
const FORBIDDEN_KEYWORDS =
    /\b(insert|update|delete|merge|alter|drop|truncate|create|exec|execute|grant|revoke|deny|backup|restore|use|attach|detach|reconfigure|shutdown|dbcc|kill|waitfor|begin|commit|rollback|savepoint|into|declare|set|raiserror|print|if|while|return|go|send|throw|checkpoint|move|get|conversation)\b/i;
const FORBIDDEN_PATTERNS = [
    /\bselect\s+.*\binto\b/i,
    /\bopenrowset\b/i,
    /\bopendatasource\b/i,
    /\bopenquery\b/i,
    /\bxp_[a-z0-9_]+\b/i,
    /\bsp_[a-z0-9_]+\b/i
];
const DISALLOWED_TOP_LEVEL_STATEMENT_START = new Set([
    "alter",
    "backup",
    "begin",
    "break",
    "close",
    "commit",
    "continue",
    "create",
    "dbcc",
    "deallocate",
    "declare",
    "delete",
    "deny",
    "disable",
    "drop",
    "enable",
    "exec",
    "execute",
    "goto",
    "grant",
    "if",
    "insert",
    "kill",
    "merge",
    "open",
    "print",
    "raiserror",
    "receive",
    "reconfigure",
    "restore",
    "return",
    "revert",
    "revoke",
    "rollback",
    "save",
    "set",
    "shutdown",
    "send",
    "checkpoint",
    "throw",
    "move",
    "get",
    "truncate",
    "update",
    "updatetext",
    "use",
    "waitfor",
    "while",
    "writetext"
]);

function assertSqlInput(sql) {
    if (typeof sql !== "string" || sql.trim() === "") {
        throw new Error("SQL non valido: stringa vuota.");
    }
}

function stripLeadingTerminators(sql) {
    return sql.replace(/^\s*(?:;\s*)+/, "").trimStart();
}

function scanBalancedSql(sql) {
    const STATE = {
        NORMAL: 0,
        SINGLE_QUOTE: 1,
        DOUBLE_QUOTE: 2,
        BRACKET: 3,
        LINE_COMMENT: 4,
        BLOCK_COMMENT: 5
    };

    let state = STATE.NORMAL;
    let parenDepth = 0;
    const semicolons = [];

    for (let i = 0; i < sql.length; i += 1) {
        const ch = sql[i];
        const next = i + 1 < sql.length ? sql[i + 1] : "";

        if (state === STATE.NORMAL) {
            if (ch === "-" && next === "-") {
                state = STATE.LINE_COMMENT;
                i += 1;
                continue;
            }
            if (ch === "/" && next === "*") {
                state = STATE.BLOCK_COMMENT;
                i += 1;
                continue;
            }
            if (ch === "'") {
                state = STATE.SINGLE_QUOTE;
                continue;
            }
            if (ch === "\"") {
                state = STATE.DOUBLE_QUOTE;
                continue;
            }
            if (ch === "[") {
                state = STATE.BRACKET;
                continue;
            }
            if (ch === "(") {
                parenDepth += 1;
                continue;
            }
            if (ch === ")") {
                parenDepth -= 1;
                if (parenDepth < 0) {
                    throw new Error("SQL non valido: parentesi chiuse in modo non corretto.");
                }
                continue;
            }
            if (ch === ";") {
                semicolons.push(i);
            }
            continue;
        }

        if (state === STATE.SINGLE_QUOTE) {
            if (ch === "'" && next === "'") {
                i += 1;
                continue;
            }
            if (ch === "'") {
                state = STATE.NORMAL;
            }
            continue;
        }

        if (state === STATE.DOUBLE_QUOTE) {
            if (ch === "\"" && next === "\"") {
                i += 1;
                continue;
            }
            if (ch === "\"") {
                state = STATE.NORMAL;
            }
            continue;
        }

        if (state === STATE.BRACKET) {
            if (ch === "]") {
                state = STATE.NORMAL;
            }
            continue;
        }

        if (state === STATE.LINE_COMMENT) {
            if (ch === "\n" || ch === "\r") {
                state = STATE.NORMAL;
            }
            continue;
        }

        if (state === STATE.BLOCK_COMMENT) {
            if (ch === "*" && next === "/") {
                state = STATE.NORMAL;
                i += 1;
            }
        }
    }

    if (state === STATE.SINGLE_QUOTE || state === STATE.DOUBLE_QUOTE || state === STATE.BRACKET) {
        throw new Error("SQL non valido: stringhe o identificatori non chiusi correttamente.");
    }
    if (state === STATE.BLOCK_COMMENT) {
        throw new Error("SQL non valido: commento /* */ non chiuso correttamente.");
    }
    if (parenDepth !== 0) {
        throw new Error("SQL non valido: parentesi non bilanciate.");
    }

    return semicolons;
}

function normalizeSingleStatement(sql) {
    const semicolons = scanBalancedSql(sql);
    if (semicolons.length > 1) {
        throw new Error("SQL non valido: è consentita una sola istruzione per richiesta.");
    }
    if (semicolons.length === 1) {
        const idx = semicolons[0];
        const trailing = sql.slice(idx + 1).trim();
        if (trailing.length > 0) {
            throw new Error("SQL non valido: è consentita una sola istruzione per richiesta.");
        }
        return sql.slice(0, idx).trim();
    }
    return sql.trim();
}

function stripCommentsAndLiterals(sql) {
    const STATE = {
        NORMAL: 0,
        SINGLE_QUOTE: 1,
        DOUBLE_QUOTE: 2,
        BRACKET: 3,
        LINE_COMMENT: 4,
        BLOCK_COMMENT: 5
    };

    let state = STATE.NORMAL;
    let out = "";

    for (let i = 0; i < sql.length; i += 1) {
        const ch = sql[i];
        const next = i + 1 < sql.length ? sql[i + 1] : "";

        if (state === STATE.NORMAL) {
            if (ch === "-" && next === "-") {
                state = STATE.LINE_COMMENT;
                out += "  ";
                i += 1;
                continue;
            }
            if (ch === "/" && next === "*") {
                state = STATE.BLOCK_COMMENT;
                out += "  ";
                i += 1;
                continue;
            }
            if (ch === "'") {
                state = STATE.SINGLE_QUOTE;
                out += " ";
                continue;
            }
            if (ch === "\"") {
                state = STATE.DOUBLE_QUOTE;
                out += " ";
                continue;
            }
            if (ch === "[") {
                state = STATE.BRACKET;
                out += " ";
                continue;
            }
            out += ch;
            continue;
        }

        if (state === STATE.SINGLE_QUOTE) {
            if (ch === "'" && next === "'") {
                out += "  ";
                i += 1;
                continue;
            }
            if (ch === "'") {
                state = STATE.NORMAL;
                out += " ";
                continue;
            }
            out += " ";
            continue;
        }

        if (state === STATE.DOUBLE_QUOTE) {
            if (ch === "\"" && next === "\"") {
                out += "  ";
                i += 1;
                continue;
            }
            if (ch === "\"") {
                state = STATE.NORMAL;
                out += " ";
                continue;
            }
            out += " ";
            continue;
        }

        if (state === STATE.BRACKET) {
            if (ch === "]") {
                state = STATE.NORMAL;
                out += " ";
            } else {
                out += " ";
            }
            continue;
        }

        if (state === STATE.LINE_COMMENT) {
            if (ch === "\n" || ch === "\r") {
                state = STATE.NORMAL;
                out += ch;
            } else {
                out += " ";
            }
            continue;
        }

        if (state === STATE.BLOCK_COMMENT) {
            if (ch === "*" && next === "/") {
                state = STATE.NORMAL;
                out += "  ";
                i += 1;
            } else {
                out += " ";
            }
        }
    }

    return out;
}

function sanitizeSqlInput(sql) {
    assertSqlInput(sql);
    const noPrefixTerminators = stripLeadingTerminators(sql.trim());
    if (!noPrefixTerminators) {
        throw new Error("SQL non valido: stringa vuota.");
    }
    return normalizeSingleStatement(noPrefixTerminators);
}

function topLevelWordTokens(analysis) {
    const tokens = [];
    let depth = 0;
    let current = "";
    let currentStart = -1;

    const flush = () => {
        if (!current) return;
        if (depth === 0 && currentStart >= 0) {
            tokens.push({
                token: current.toLowerCase(),
                start: currentStart,
                end: currentStart + current.length
            });
        }
        current = "";
        currentStart = -1;
    };

    for (let i = 0; i < analysis.length; i += 1) {
        const ch = analysis[i];
        if (/[A-Za-z0-9_]/.test(ch)) {
            if (currentStart < 0) currentStart = i;
            current += ch;
            continue;
        }
        flush();
        if (ch === "(") depth += 1;
        if (ch === ")" && depth > 0) depth -= 1;
    }
    flush();
    return tokens;
}

function nextNonWhitespaceChar(text, start) {
    for (let i = start; i < text.length; i += 1) {
        const ch = text[i];
        if (!/\s/.test(ch)) return ch;
    }
    return "";
}

function assertSingleReadStatement(analysis) {
    const tokens = topLevelWordTokens(analysis);
    if (tokens.length === 0 || (tokens[0].token !== "select" && tokens[0].token !== "with")) {
        throw new Error("Solo query di lettura sono consentite (SELECT / WITH).");
    }

    let mainSelectSeen = tokens[0].token === "select";
    for (let i = 1; i < tokens.length; i += 1) {
        const token = tokens[i].token;
        const prev = tokens[i - 1]?.token || "";

        if (token === "with") {
            const nextChar = nextNonWhitespaceChar(analysis, tokens[i].end);
            if (nextChar === "(") {
                continue;
            }
            throw new Error("SQL non valido: batch multipli non consentiti.");
        }

        if (token === "select") {
            if (!mainSelectSeen && tokens[0].token === "with") {
                mainSelectSeen = true;
                continue;
            }
            if (prev === "union" || prev === "intersect" || prev === "except" || prev === "all") {
                continue;
            }
            throw new Error("SQL non valido: batch multipli non consentiti.");
        }

        if (DISALLOWED_TOP_LEVEL_STATEMENT_START.has(token)) {
            throw new Error("SQL non valido: batch multipli non consentiti.");
        }

        if (token === "conversation" && prev === "end") {
            throw new Error("SQL non valido: batch multipli non consentiti.");
        }
    }
}

export function assertReadOnlySql(sql) {
    const normalized = sanitizeSqlInput(sql);
    const analysis = stripCommentsAndLiterals(normalized).trim();

    if (!READ_ONLY_START.test(analysis)) {
        throw new Error("Solo query di lettura sono consentite (SELECT / WITH).");
    }
    assertSingleReadStatement(analysis);
    if (FORBIDDEN_KEYWORDS.test(analysis)) {
        throw new Error("Query bloccata: contiene parole chiave non consentite in produzione.");
    }
    for (const pattern of FORBIDDEN_PATTERNS) {
        if (pattern.test(analysis)) {
            throw new Error("Query bloccata: pattern SQL non consentito in produzione.");
        }
    }
    return normalized;
}
