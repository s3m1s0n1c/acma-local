# ACMA RRL MCP Server

A Model Context Protocol (MCP) server that exposes the Australian Communications and Media Authority (ACMA) [Register of Radiocommunications Licences (RRL)](https://www.acma.gov.au/radiocomms-licence-data) and the [Australian Radiofrequency Spectrum Plan (ARSP)](https://www.acma.gov.au/australian-radiofrequency-spectrum-plan) as a local SQLite mirror, with manifest-driven sync against ACMA's REST API.

The server speaks two transports: **stdio** and **Streamable HTTP/SSE** on `:3000`. Version 2 keeps the database and sync pipeline intact while replacing the overlapping MCP catalog with nine focused tools designed for small local models.

## Features

- **Local mirror** of the full RRL dataset (32 materialised tables + FTS5 narrative index), kept fresh by ACMA's `/v1/Extracts` manifest API — mobile-friendly by default (no automatic 70 MB downloads).
- **One-call record search** across client names and addresses, licence numbers, ABN/ACN, call signs, device identifiers, station names, sites, broadcasting licences and application narrative.
- **Exact frequency search** with unambiguous Hz/kHz/MHz/GHz parsing. `476.425`, `"476.425 MHz"` and `476425000` all resolve to exactly `476425000` Hz.
- **Call-sign resolution** joins assignments through licences to the holder name and full postal address in one tool call.
- **Compact lossless results** use columnar rows, paging, duplicate-call reuse and minified JSON to reduce local-model prompt processing.
- **Full-text search** (SQLite FTS5) over application narrative.
- **Geospatial export** — site/device results carry coordinates and can be rendered as KML via `export_kml`.
- **Spectrum plan lookup** — `spectrum_reference` returns the AU primary allocation plus ITU Region 1/2/3 contrast rows and optional resolved footnote text.
- **Power-user fallback** — `database` can inspect the schema or run a sandboxed read-only SELECT/WITH query when a specialised search cannot answer the question.
- **Search metrics** — every MCP call logs database time, row count, response bytes and cache status.

## Tools (9)

| Tool | Purpose |
|---|---|
| `search_records` | Ranked search across names, addresses, clients, licences, call signs, device IDs, sites, broadcasts and application text. |
| `get_record` | Open a result and include linked licences or assignments. |
| `search_frequencies` | Exact/ranged assignment and spectrum-authorisation search with Hz, kHz, MHz and GHz input. |
| `spectrum_reference` | Australian and ITU spectrum-plan lookup. |
| `decode_emission` | Decode an ITU/ACA emission designator such as `16K0F3E`. |
| `database` | Schema inspection and advanced read-only SQL fallback. |
| `get_result_page` | Retrieve another cached page without rerunning SQLite. |
| `export_kml` | Render cached latitude/longitude results as KML. |
| `sync_data` | Check status or start an automatic/full sync. |

Search responses contain `columns` and `rows`, plus a `result_id` for paging. Automatic `_hints` are intentionally not returned.

## Installation

Requires Node ≥ 18.

```bash
git clone https://github.com/ciphernaut/acma-local.git
cd acma-local
npm install
```

First-time data bootstrap (downloads ~70 MB; one-time). On a fresh DB the bootstrap path runs automatically — no `mode=full` needed:

```bash
npm run sync
```

After the first install you can also trigger syncs through the MCP `sync_data` tool with `mode=auto` (default, incremental) or `mode=full` (force-redownload, e.g. to recover from `gap-exceeded`).

The spectrum-plan tables auto-populate from `seed/spectrum_plan.sql` at the tail of the full sync.

## Running

```bash
npm run dev                    # tsx src/index.ts — development mode, live reload
npm run build && npm start     # production (compiled to dist/, then node dist/index.js)
```

The server listens on `$PORT` (default `3000`) and exposes the MCP endpoint at `http://localhost:$PORT/mcp` plus a liveness probe at `/health`. It handles `SIGTERM` and `SIGINT` gracefully — closes MCP transports, finishes in-flight requests, exits cleanly within 30 seconds.

For stdio mode (Claude Desktop), point the client at the compiled entry point — see [MCP client configuration](#mcp-client-configuration).

## Spectrum plan

The Australian Radiofrequency Spectrum Plan is stored in five `spectrum_*` tables alongside the RRL data:

- `spectrum_allocations` — AU primary allocations keyed by `(freq_start_hz, freq_end_hz)`.
- `spectrum_region_allocations` — ITU Region 1/2/3 allocations keyed independently of AU sub-range boundaries.
- `spectrum_australian_footnotes`, `spectrum_international_footnotes`, `spectrum_plan_meta`.

**Source pipeline.** The canonical source is `seed/spectrum_plan_source.yaml`, extracted from the 2021 ACMA Spectrum Plan PDF by `tools/extract-rrsp/extract.py`. `seed/spectrum_plan.sql` is generated from the YAML plus any overlays in `seed/patches/*.yaml` by `scripts/generate-spectrum-seed.ts`. On a fresh DB, the seed is auto-applied at the tail of `performFullSync`.

**`get_frequency_allocation` response shape.** Returns `allocation` (AU primary row, nullable), `regions` (R1/R2/R3 contrast rows, each nullable), `resolved_footnotes` (flat text map for all referenced AU and international footnotes), and `source` (with `published_date` and `last_patch_date`).

To apply an ACMA amendment:

```bash
# 1. Write a YAML overlay — see seed/patches/README.md for the operation set
$EDITOR seed/patches/$(date +%Y-%m-%d)-<topic>.yaml

# 2. Regenerate the SQL seed
npx tsx scripts/generate-spectrum-seed.ts

# 3. Apply to the DB
npm run import-spectrum-plan -- --reseed

# 4. Commit the overlay and regenerated seed
git add seed/
git commit -m "data(spectrum): apply amendment $(date +%Y-%m-%d)"
```

## Configuration

Environment variables:

| Variable | Purpose |
|----------|---------|
| `ACMA_DB_PATH` | Absolute path to the SQLite DB. Default `./data/acma.db`. |
| `PORT` | HTTP server port for the Streamable HTTP transport. Default `3000`. |
| `LOG_LEVEL` | One of `error` / `warn` / `info` (default) / `debug`. Lower levels are emitted; everything else is suppressed. |
| `MCP_DEFAULT_PAGE_SIZE` | Rows returned by the first search page. Default `10`, maximum `100`. |
| `DEBUG_NETWORK` | Legacy alias for `LOG_LEVEL=debug` (kept for backwards compatibility). Promotes per-request `[NETWORK]` logging when set. |

The server's `/health` endpoint returns JSON with sync provenance (`dataAsOf`, `lastSyncAt`, `remoteAsOf`, `behindByHours`, `isSyncing`). Pass `?deep=1` to additionally probe the DB read-only — returns `500` with `status: degraded` if the DB is unreachable.

### MCP client configuration

**Claude Desktop / LM Studio (stdio):**

```json
{
  "mcpServers": {
    "acma-rrl": {
      "command": "node",
      "args": ["/path/to/acma-local-redux/dist/index.js"],
      "env": {
        "ACMA_DB_PATH": "/path/to/acma-local-redux/data/acma.db"
      }
    }
  }
}
```

**LM Studio 0.3.17+ (networked, Streamable HTTP):**

```json
{
  "mcpServers": {
    "acma-rrl": {
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

## Data sync

The local SQLite mirror is kept in step with ACMA's `https://backend.acma.gov.au/rrl/v1/Extracts` manifest. The manifest exposes one full-extract entry plus the most recent ~3 daily change-zip entries.

Three timestamps drive the state machine — kept in the `meta` table:

- `as_of` — how fresh the data we hold is (from the manifest's `LastMdified` of the last applied entry).
- `last_sync` — when our pipeline last successfully ran.
- Manifest `full.LastMdified` (never persisted) — the upstream state. The MCP surfaces the delta as `behindByHours`.

Sync modes (exposed via the MCP `sync_data` tool):

- **`auto`** (default): fetches the manifest and applies any daily CSV-diff change-zips strictly newer than `meta.as_of`. Never auto-pulls the 70 MB full extract — safe to call from mobile or metered networks.
- **`full`**: force-downloads and reimports `spectra_rrl.zip`. Use on first install or when `sync_data` reports `gap-exceeded` (local DB older than the manifest's ~3-day incremental window).

## Development

```bash
npm test                          # full Jest suite (ts-jest ESM preset)
npm test -- tests/sync.test.ts    # single file
npm run build                     # tsc → dist/ (ESM)
```

See `CLAUDE.md` for architecture notes, project-specific gotchas, and the sync pipeline's invariants.

## Attribution

This project provides a local mirror of ACMA-published data. The legacy [`offline-rrl`](https://web.acma.gov.au/offline-rrl/index.html) JavaScript implementation was used to reverse-engineer the data structures and SQL query patterns; the manifest API replaces its 3-URL pipeline (`spectra_rrl.zip` + `datetime-of-extract.txt` + `.rrl_update` SQL diff).

## License

This software and the associated RRL/ARSP data are licensed under the [Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/) license.

- **ACMA Data**: © Commonwealth of Australia (Australian Communications and Media Authority).
- **Implementation**: Creative Commons Attribution 4.0 International.
