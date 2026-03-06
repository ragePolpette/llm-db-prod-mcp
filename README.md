# llm-db-prod-mcp

MCP server per DB di produzione con accesso sola lettura + anonimizzazione obbligatoria (LLM locale o fallback deterministico).

Regole implementate:
- Nessuna scrittura esposta.
- Solo query `SELECT / WITH`.
- Prima del ritorno alla LLM, i dati passano sempre da anonymizer (`db_prod_read_anonymized`).
- Hard cap `maxRows` a `250`.
- Timeout query DB configurabile (default `9000ms`, max `10000ms`).
- Hard cap payload risultato (default `5MB`) durante stream.
- Limite su righe tramite stream cancellation server-side e su dimensione LOB tramite `SET TEXTSIZE`.

## Setup

1. Copia `.env.example` in `.env` (o imposta variabili ambiente).
2. Installa dipendenze:
```bash
npm install
```
3. Avvia server MCP:
```bash
npm start
```

Server esposto in locale su `http://127.0.0.1:8782/mcp` (configurabile via env).
Configurazione client consigliata: `type=stdio` + `npx mcp-remote`.

## Variabili ambiente

- `DB_PROD_CONNECTION_STRING` (obbligatoria, consigliato utente SQL read-only)
- `DB_PROD_MAX_ROWS` (default `200`, hard cap `250`)
- `DB_PROD_QUERY_TIMEOUT_MS` (default `9000`, min `1000`, max `10000`)
- `DB_PROD_PREFLIGHT_TIMEOUT_MS` (default `8000`, min `1000`, max `30000`): timeout esplicito per il check DB eseguito allo startup.
- `DB_PROD_MAX_RESULT_BYTES` (default `5242880`, min `131072`, hard cap `5242880`): valori piu alti vengono clampati a 5MB in codice.
- `DB_PROD_TEXTSIZE_BYTES` (default `262144`, min `4096`, max `1048576`)
- `DB_PROD_MAX_ROW_BYTES` (default `262144`, min `4096`, max `10485760`)
- `ANON_MODEL_PROVIDER` (default `ollama`, ammessi `ollama|deterministic`)
- `ANON_MODE` (default `hybrid`, ammessi `hybrid|deterministic|llm-strict`)
  - `hybrid`: usa anonimizzazione deterministica hash-based; puo usare LLM locale solo per identificare i campi sensibili.
  - `deterministic`: solo anonimizzazione deterministica hash-based (piu veloce, nessuna dipendenza LLM).
  - `llm-strict`: solo LLM locale (se fallisce, fallisce la richiesta).
- `ANON_FIELD_IDENTIFICATION` (default `hybrid`, ammessi `hybrid|heuristic|llm`)
  - `hybrid`: tenta classificazione campi con LLM locale, fallback euristico.
  - `heuristic`: classificazione solo con regole locali.
  - `llm`: classificazione solo LLM (fallisce se LLM non disponibile).
- Default-deny anonimization: colonne stringa non riconosciute come tecniche/safe vengono pseudonimizzate comunque (`TEXT_*`) invece di passare in chiaro.
- `ANON_HASH_SALT` (obbligatorio, segreto stabile): salt usato nell'hash deterministico. Stesso input+salt => stessa pseudonimizzazione nel tempo. Il server rifiuta l'avvio se manca o se resta il placeholder.
- `ANON_MODEL_BASE_URL` (default `http://127.0.0.1:11434`)
- `ANON_MODEL_NAME` (default `qwen2.5:3b-instruct`)
- `ANON_FAIL_OPEN` (default `false`)
  - in `llm-strict`, `false` mantiene comportamento fail-closed.
  - in `hybrid`, il fallback deterministico e gia attivo per garantire latenza.
- `ANON_TIMEOUT_MS` (default `5000`, timeout chiamata LLM locale)
- `ANON_LLM_MAX_ROWS` (default `2`, oltre passa a deterministic)
- `ANON_LLM_MAX_CELLS` (default `40`, oltre passa a deterministic)
- `ANON_LLM_MAX_INPUT_CHARS` (default `3000`, oltre passa a deterministic)
- `MCP_PROD_HOST` (default `127.0.0.1`)
- `MCP_PROD_PORT` (default `8782`)
- `MCP_PROD_PATH` (default `/mcp`)
- `MCP_PROD_SSE_ENABLED` (default `false`; se `false`, `GET /mcp` risponde `405`)
- `MCP_PROD_ALLOWED_HOSTS` (default `localhost,127.0.0.1,[::1]`)
- `MCP_PROD_ALLOWED_ORIGINS` (default localhost loopback con wildcard porta)
  - Le richieste a `/mcp` senza header `Origin` vengono rifiutate; `Origin` deve essere presente e allowlisted.
- `MCP_MODELS_DIR` (default `.local/models`)
- `OLLAMA_MODELS` (default `.local/models/ollama`)

## Tool esposto

- `db_prod_read_anonymized`
  - esegue query read-only
  - anonimizza risultato prima della risposta
  - valida SQL in ingresso (single statement reale, parentesi/commenti/stringhe bilanciate, blocco keyword/pattern pericolosi)
  - costruisce il batch eseguito solo a partire dalla query gia validata (`SET TEXTSIZE <n>; <SELECT/WITH validata>;`)
  - rifiuta parametri non validi (nome parametro e tipo valore)
  - applica limitazione dimensione LOB (`TEXTSIZE`) + controllo/stop durante stream quando supera i limiti di righe o payload
- `db_prod_info`
  - descrive scopo operativo e limiti di sicurezza (read-only + anonimizzazione)

## Esempio configurazione MCP (Codex/Client)

File: `config/mcp.servers.example.json`
