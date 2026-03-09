# claude.md — llm-db-prod-mcp

## Project summary

Server MCP (Model Context Protocol) in Node.js per l'accesso in **sola lettura** al **database SQL Server di produzione**, con **anonimizzazione obbligatoria** dei risultati prima della risposta all'LLM.

Nessuna scrittura esposta. Hard cap: 250 righe, 5MB payload, timeout query 9s. L'anonimizzazione è configurabile: deterministica (hash-based, default), ibrida (deterministica + LLM locale per classificare campi sensibili), o LLM-strict (solo modello locale, fallisce se non disponibile). Trasporto HTTP su `127.0.0.1:8782/mcp`. Progetto MCP del monorepo Yetzirah; il runtime è in `Binah`.

## Quickstart

```bash
cd llm-db-prod-mcp

# Configura env
cp config.local.example.env .env
# Edita .env: imposta DB_PROD_CONNECTION_STRING (utente SQL read-only consigliato)

# Installa dipendenze
npm install

# Avvia server
npm start
# → http://127.0.0.1:8782/mcp
```

## Architecture overview

```
Client MCP
    |  HTTP POST /mcp
    v
server.js  (entry point)
    |
lib/
    |-- sqlGuard.js        (validazione SQL: solo SELECT/WITH, blocco keyword pericolose)
    |-- dbClient.js        (connessione mssql, ROWCOUNT + TEXTSIZE server-side)
    |-- anonymizer.js      (anonimizzazione: deterministic | hybrid | llm-strict)
    |-- tools/
         |-- readAnon.js   (db_prod_read_anonymized)
         |-- info.js       (db_prod_info)
```

Flusso: query SQL → validazione guard → esecuzione DB con limiti server-side → stream risultato → anonimizzazione → risposta MCP.

## Key modules / folders

| Percorso | Ruolo |
|---|---|
| `src/server.js` | Entry point: inizializza MCP SDK + HTTP server |
| `src/lib/` | Guard SQL, client DB, anonymizer, tool |
| `scripts/` | Script operativi (Non determinabile il contenuto esatto) |
| `config/` | Esempi configurazione MCP client |
| `config.local.example.env` | Template variabili ambiente |

## Dependencies & tooling

- **Runtime**: Node.js (ESM, `"type": "module"`)
- **MCP SDK**: `@modelcontextprotocol/sdk ^1.12.0`
- **DB driver**: `mssql ^11.0.1`
- **LLM locale** (opzionale): Ollama con `qwen2.5:3b-instruct` (default)
- **Test**: Non determinabile dai file presenti

## Configuration

| Variabile | Default | Note |
|---|---|---|
| `DB_PROD_CONNECTION_STRING` | — | **Obbligatoria**, preferire utente SQL read-only |
| `DB_PROD_MAX_ROWS` | `200` | Hard cap `250` |
| `DB_PROD_QUERY_TIMEOUT_MS` | `9000` | Min 1000, max 10000 |
| `DB_PROD_MAX_RESULT_BYTES` | `5242880` (5MB) | |
| `ANON_MODEL_PROVIDER` | `ollama` | `ollama` o `deterministic` |
| `ANON_MODE` | `hybrid` | `hybrid` / `deterministic` / `llm-strict` |
| `ANON_FIELD_IDENTIFICATION` | `hybrid` | `hybrid` / `heuristic` / `llm` |
| `ANON_HASH_SALT` | — | **Consigliato**: salt segreto stabile per pseudonimizzazione consistente |
| `ANON_MODEL_BASE_URL` | `http://127.0.0.1:11434` | URL Ollama locale |
| `ANON_MODEL_NAME` | `qwen2.5:3b-instruct` | Modello LLM locale |
| `ANON_FAIL_OPEN` | `false` | Se `true` in llm-strict: risponde senza anon se LLM fallisce |
| `ANON_TIMEOUT_MS` | `5000` | Timeout chiamata LLM |
| `ANON_LLM_MAX_ROWS` | `2` | Oltre → passa a deterministic |
| `ANON_LLM_MAX_CELLS` | `40` | Oltre → passa a deterministic |
| `MCP_PROD_HOST` | `127.0.0.1` | |
| `MCP_PROD_PORT` | `8782` | |
| `MCP_PROD_SSE_ENABLED` | `false` | GET /mcp → 405 se false |

## Common commands

```bash
# Avvio server
npm start

# Avvio tramite launcher monorepo
powershell -ExecutionPolicy Bypass -File ../tools/start-mcp-db.ps1 -Mode prod

# Test compliance MCP transport
powershell -ExecutionPolicy Bypass -File ../tools/test-mcp-transport-compliance.ps1
```

## Operational notes

- **Porta PROD**: 8782. Non cambiare senza aggiornare launcher e compliance test.
- Configurazione client consigliata: `type=stdio` + `npx mcp-remote http://127.0.0.1:8782/mcp`.
- Il tool `db_prod_read_anonymized` applica `SET ROWCOUNT` e `SET TEXTSIZE` lato server prima della query.
- In modalità `deterministic`: nessuna dipendenza da Ollama, pseudonimizzazione hash-based con `ANON_HASH_SALT`.
- In modalità `hybrid`: LLM locale usato solo per classificare campi sensibili (fallback euristico se LLM non risponde).
- Deploy: tramite `tools/deploy-mcp-dev-to-deploy.ps1` → copia in `Binah\llm-db-prod-mcp`.

## Known issues / risks

- **BLOCKER potenziale**: se `ANON_HASH_SALT` non è impostato, la pseudonimizzazione non è consistente tra sessioni (stessa entità → hash diversi).
- **Nessun test automatizzato** identificato nel progetto.
- `ANON_FAIL_OPEN=true` in modalità `llm-strict` può esporre dati non anonimizzati se il modello locale non è disponibile — usare con cautela.
- Assenza di monitoring/alerting per query lente o payload vicini al cap.
- La connection string contiene credenziali DB di produzione: gestirla con estrema cautela.

## Roadmap / next actions

1. **(S)** Verificare e documentare che `ANON_HASH_SALT` sia sempre impostato in produzione
2. **(M)** Aggiungere test automatizzati per guard SQL e anonimizzatore
3. **(M)** Aggiungere logging strutturato per query rifiutate e fallback anonimizzazione
4. **(S)** Documentare procedura per cambiare `ANON_HASH_SALT` (richiede re-pseudonimizzazione storico)
5. **(L)** Aggiungere metriche latenza per monitorare impatto anonimizzazione LLM vs deterministica
