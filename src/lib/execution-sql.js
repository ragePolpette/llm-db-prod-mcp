import { assertReadOnlySql } from "./sql-guard.js";

export function buildExecutionSql(sqlText, textSizeBytes) {
    const normalizedSql = assertReadOnlySql(sqlText);
    const safeTextSize = Number.isFinite(textSizeBytes) && textSizeBytes > 0 ? Math.floor(textSizeBytes) : 262144;
    return `SET TEXTSIZE ${safeTextSize}; ${normalizedSql};`;
}
