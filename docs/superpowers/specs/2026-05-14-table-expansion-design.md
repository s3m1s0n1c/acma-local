# Table expansion: T1 lookups, T2 BSL + spectrum, T3 satellite, T4 application text

## Problem

`src/db.ts`'s `TABLE_METADATA` currently materialises 5 tables (`client`, `licence`, `site`, `device_details`, `antenna`) plus `meta` — about 1/6 of what ACMA's full extract provides. As a result:

- **Existing search/detail views surface raw codes** (`SV_ID=3`, `STATUS='10'`) instead of human-readable names. Every `searchLicences*` / `getLicenceDetails` result is harder to read than it needs to be.
- **Broadcasting Service Licences are invisible** — `bsl` and `bsl_area` aren't materialised, so common queries like "what's the call sign for this transmitter?" can't be answered without ad-hoc CSV parsing.
- **Spectrum authorisations can't be queried by frequency band** — the natural "who's licenced between 1800 and 1900 MHz?" question requires `auth_spectrum_freq` and `auth_spectrum_area`, neither of which are present.
- **Satellite data is missing** even though `device_details.SA_ID` references it.
- **Application narrative is unsearchable** — the bulk of regulator-facing context (conditions, exemptions, special clauses) lives in `applic_text_block.APTB_TEXT` and is invisible to the MCP.
- **`execute_sql`'s description in `src/index.ts:248` advertises ~25 tables**, but only 5 are real. The description has been lying to clients since long before the sync migration.

This sprint closes those gaps.

## Goals

- Materialise 17 additional ACMA tables in `TABLE_METADATA`.
- Add 3 new MCP tools: `search_bsl`, `search_spectrum_band`, `search_application_text`.
- Restructure existing `src/logic.ts` search/detail SQL to JOIN the 10 lookup tables, so consumer-facing results carry human-readable names alongside the FK codes.
- Extend incremental sync (`src/sync.ts`) to support composite-PK tables — the current `PK_BY_TABLE: Record<string, string>` is single-column only.
- Build a SQLite FTS5 virtual table over `applic_text_block.APTB_TEXT` and keep it in step with the base table on incrementals.
- Update `execute_sql`'s `description` to reflect the actual materialised schema.

## Non-goals

- **Antenna patterns** (`antenna_pattern`). Deferred — high-volume technical data with no clear primary consumer yet. Will land after the Sprint 3 SQL-backend hardening pass.
- **`access_area`** (3 rows; reference table, no current consumer).
- **SQL backend hardening** — CTE support in `execute_sql`'s validator, `describe_schema` / `describe_tool` meta-tools, `explain_query`, ANALYZE-after-sync, matterfront-style hydration of result payloads with `_hints`. All deferred to Sprint 3; intent recorded in this repo's memory and acknowledged below in Roadmap.
- **Trimming the existing `tools/list` catalog content** to lean descriptions. Also Sprint 3.
- **Re-aligning `list_sample_queries` to the original ACMA offline app's set.** Also Sprint 3 — natural to do once full table parity is reached.
- **Pushing to remote.** Same convention as the sync migration: this lands on `main` locally; the user controls publication.

## Architecture

### Schema additions

All schemas live in `src/db.ts` under `TABLE_METADATA`. Column names match the CSV headers exactly. Type inference comes from sampling the real extract.

#### T1 — 10 lookup tables (small, reference data, FK targets)

| Table | PK | Cols | Used by JOIN in |
|---|---|---|---|
| `client_type` | `TYPE_ID` (INTEGER) | TYPE_ID, NAME | `searchClients`, `client` detail |
| `fee_status` | `FEE_STATUS_ID` (INTEGER) | FEE_STATUS_ID, FEE_STATUS_TEXT | `searchClients`, `client` detail |
| `industry_cat` | `CAT_ID` (INTEGER) | CAT_ID, DESCRIPTION, NAME | `searchClients`, `client` detail |
| `licence_service` | `SV_ID` (INTEGER) | SV_ID, SV_NAME | `searchLicences*`, `getLicenceDetails` |
| `licence_subservice` | `(SS_ID, SV_SV_ID)` composite | SS_ID, SV_SV_ID, SS_NAME | `searchLicences*`, `getLicenceDetails` |
| `licence_status` | `STATUS` (INTEGER) | STATUS, STATUS_TEXT | `searchLicences*`, `getLicenceDetails` |
| `nature_of_service` | `CODE` (TEXT) | CODE, DESCRIPTION | `getSiteDetails`, `getLicenceDetails` device rows |
| `class_of_station` | `CODE` (TEXT) | CODE, DESCRIPTION | `getSiteDetails`, `getLicenceDetails` device rows |
| `licensing_area` | `LICENSING_AREA_ID` (INTEGER) | LICENSING_AREA_ID, DESCRIPTION | `searchSites`, `getSiteDetails` |
| `antenna_polarity` | `POLARISATION_CODE` (TEXT) | POLARISATION_CODE, POLARISATION_TEXT | `getSiteDetails`, `getLicenceDetails` device rows |

Each carries an index on its PK (auto-indexed by SQLite if declared `PRIMARY KEY`, but we keep the schema's no-explicit-PK convention and add explicit indexes via `post_load_ddl` for consistency).

#### T2 — broadcasting + spectrum

`bsl` — 3,651 rows. Primary entity for broadcasting:
```
BSL_NO INTEGER, MEDIUM_CATEGORY TEXT, REGION_CATEGORY TEXT, COMMUNITY_INTEREST TEXT,
BSL_STATE TEXT, DATE_COMMENCED TEXT, ON_AIR_ID TEXT, CALL_SIGN TEXT,
IBL_TARGET_AREA TEXT, AREA_CODE INTEGER, REFERENCE TEXT
```
PK `BSL_NO`. Indexes: `BSL_NO`, `CALL_SIGN`, `ON_AIR_ID`, `AREA_CODE`.

`bsl_area` — 564 rows. Area-name lookup for `bsl.AREA_CODE`:
```
AREA_CODE INTEGER, AREA_NAME TEXT
```
PK `AREA_CODE`.

`auth_spectrum_freq` — 3,466 rows. Frequency-range authorisations:
```
LICENCE_NO TEXT, AREA_CODE TEXT, AREA_NAME TEXT,
LW_FREQUENCY_START INTEGER, LW_FREQUENCY_END INTEGER,
UP_FREQUENCY_START INTEGER, UP_FREQUENCY_END INTEGER
```
Frequencies are Hz (e.g. `1960000000` = 1.96 GHz). PK composite `(LICENCE_NO, AREA_CODE, LW_FREQUENCY_START, UP_FREQUENCY_START)`. Indexes on `LICENCE_NO` and `LW_FREQUENCY_START` (band range queries).

`auth_spectrum_area` — 3,430 rows (~1.5 MB). Area metadata for spectrum auths:
```
LICENCE_NO TEXT, AREA_CODE TEXT, AREA_NAME TEXT, AREA_DESCRIPTION TEXT
```
PK composite `(LICENCE_NO, AREA_CODE)`. Index on `LICENCE_NO`.

#### T3 — satellite

`satellite` — 144 rows. Joins into `getLicenceDetails` when a device's `SA_ID` is set:
```
SA_ID INTEGER, SA_SAT_NAME TEXT, SA_SAT_LONG_NOM TEXT,
SA_SAT_INCEXC TEXT, SA_SAT_GEO_POS TEXT, SA_SAT_MERIT_G_T TEXT
```
PK `SA_ID`.

#### T4 — narrative tables + FTS5

`applic_text_block` — 447,716 rows (~168 MB CSV; ~150 MB SQLite). The narrative attached to licence applications:
```
APTB_ID INTEGER, APTB_TABLE_PREFIX TEXT, APTB_TABLE_ID INTEGER,
LICENCE_NO TEXT, APTB_DESCRIPTION TEXT, APTB_CATEGORY TEXT,
APTB_TEXT TEXT, APTB_ITEM TEXT
```
PK `APTB_ID`. Indexes on `APTB_ID`, `LICENCE_NO`, `APTB_CATEGORY`.

`applic_text_block_fts` — FTS5 virtual table backed by `applic_text_block`. Indexed columns: `APTB_TEXT`, `APTB_DESCRIPTION`. Uses **contentless-external-content** mode pointing at `applic_text_block` to avoid storing the text twice:

```sql
CREATE VIRTUAL TABLE applic_text_block_fts USING fts5(
    APTB_TEXT,
    APTB_DESCRIPTION,
    content='applic_text_block',
    content_rowid='APTB_ID',
    tokenize='porter unicode61 remove_diacritics 2'
);
```

`reports_text_block` — 528 rows (~173 KB). Operator-facing report text:
```
RTB_ITEM TEXT, RTB_CATEGORY TEXT, RTB_DESCRIPTION TEXT,
RTB_START_DATE TEXT, RTB_END_DATE TEXT, RTB_TEXT TEXT
```
PK `RTB_ITEM`. Index on `RTB_ITEM`, `RTB_CATEGORY`. Materialised but no dedicated tool — exposed via `execute_sql`.

### Incremental sync — composite PK support

`PK_BY_TABLE` in `src/sync.ts` becomes `Record<string, string | string[]>`. The `applyCsvDiff` helper:
- For string-valued PKs, current behaviour stays (`DELETE FROM t WHERE pk = ?`).
- For array-valued PKs, builds `DELETE FROM t WHERE col1 = ? AND col2 = ? ...` with positional bindings from the row.

Updated `PK_BY_TABLE`:
```typescript
const PK_BY_TABLE: Record<string, string | string[]> = {
    // existing
    client: 'CLIENT_NO',
    licence: 'LICENCE_NO',
    site: 'SITE_ID',
    device_details: 'SDD_ID',
    antenna: 'ANTENNA_ID',
    // T1
    client_type: 'TYPE_ID',
    fee_status: 'FEE_STATUS_ID',
    industry_cat: 'CAT_ID',
    licence_service: 'SV_ID',
    licence_subservice: ['SS_ID', 'SV_SV_ID'],
    licence_status: 'STATUS',
    nature_of_service: 'CODE',
    class_of_station: 'CODE',
    licensing_area: 'LICENSING_AREA_ID',
    antenna_polarity: 'POLARISATION_CODE',
    // T2
    bsl: 'BSL_NO',
    bsl_area: 'AREA_CODE',
    auth_spectrum_freq: ['LICENCE_NO', 'AREA_CODE', 'LW_FREQUENCY_START', 'UP_FREQUENCY_START'],
    auth_spectrum_area: ['LICENCE_NO', 'AREA_CODE'],
    // T3
    satellite: 'SA_ID',
    // T4
    applic_text_block: 'APTB_ID',
    reports_text_block: 'RTB_ITEM',
};
```

### FTS5 lifecycle

The FTS5 virtual table is built **after** the regular `applic_text_block` import completes in `performFullSync`. The build pattern (external-content):

```sql
INSERT INTO applic_text_block_fts(applic_text_block_fts) VALUES('rebuild');
```

This re-indexes from the live `applic_text_block` rows. Runs once per full sync; takes a few seconds on the 447k-row table.

For incrementals, `applyCsvDiff` special-cases `applic_text_block` to keep FTS5 in step. FTS5 external-content `'delete'` requires the OLD column values, so ordering matters:

1. For each row in the CSV diff:
   - SELECT current `APTB_TEXT`, `APTB_DESCRIPTION` from `applic_text_block` by `APTB_ID` (may return nothing if the row doesn't exist — fine for `Added`).
   - If old values exist: `INSERT INTO applic_text_block_fts(applic_text_block_fts, rowid, APTB_TEXT, APTB_DESCRIPTION) VALUES('delete', ?, ?, ?);`
   - DELETE from base table.
   - For `Added` or `Updated`: INSERT into base table, then `INSERT INTO applic_text_block_fts(rowid, APTB_TEXT, APTB_DESCRIPTION) VALUES(?, ?, ?);` with the new values.

This keeps FTS5 + base table in step without triggers (we deliberately avoid triggers because they fire on the bulk INSERT during full sync, doubling work; the full sync uses `rebuild` instead). Implementation lives in `src/sync.ts` as a per-table branch inside `applyCsvDiff` (the only table that needs this special-casing).

### MCP tool surface — 3 new tools

In `src/index.ts`:

#### `search_bsl`
```ts
{
  name: 'search_bsl',
  description: '[Broadcasting Licence Search] Search broadcasting service licences by call sign, BSL number, or on-air ID.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'CALL_SIGN, BSL_NO, or ON_AIR_ID (substring match)' },
      limit: { type: 'number', description: 'Max rows (default 10, max 50)' },
    },
    required: ['query'],
  },
}
```
Backed by `searchBsl(db, query, limit)` in `src/logic.ts`. Joins `bsl_area` to fetch `AREA_NAME`. Returns `BSL_NO`, `CALL_SIGN`, `MEDIUM_CATEGORY`, `REGION_CATEGORY`, `BSL_STATE`, `DATE_COMMENCED`, `ON_AIR_ID`, `AREA_NAME`.

#### `search_spectrum_band`
```ts
{
  name: 'search_spectrum_band',
  description: '[Spectrum Authorisation Search] Find licences authorised in a frequency band.',
  inputSchema: {
    type: 'object',
    properties: {
      freq_min_hz: { type: 'number', description: 'Lower bound of the band, in Hz' },
      freq_max_hz: { type: 'number', description: 'Upper bound of the band, in Hz' },
      limit: { type: 'number', description: 'Max rows (default 20, max 100)' },
    },
    required: ['freq_min_hz', 'freq_max_hz'],
  },
}
```
Backed by `searchSpectrumBand(db, freqMinHz, freqMaxHz, limit)`. Uses range-overlap predicate: `WHERE NOT (UP_FREQUENCY_END < ? OR LW_FREQUENCY_START > ?)`. Joins `auth_spectrum_area` for area description and `licence` for client linkage. Returns `LICENCE_NO`, `AREA_CODE`, `AREA_NAME`, `LW_FREQUENCY_START`, `UP_FREQUENCY_END` (the natural human range), plus the licence's `CLIENT_NO`.

#### `search_application_text`
```ts
{
  name: 'search_application_text',
  description: '[Licence Application Text Search] Full-text search across licence application narrative.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'FTS5 query (phrase, AND/OR, NEAR/N, prefix*)' },
      limit: { type: 'number', description: 'Max rows (default 20, max 100)' },
    },
    required: ['query'],
  },
}
```
Backed by `searchApplicationText(db, ftsQuery, limit)`. Uses FTS5 MATCH with BM25 ranking:
```sql
SELECT atb.APTB_ID, atb.LICENCE_NO, atb.APTB_CATEGORY, atb.APTB_DESCRIPTION,
       snippet(applic_text_block_fts, 0, '«', '»', '…', 32) AS snippet,
       bm25(applic_text_block_fts) AS rank
FROM applic_text_block_fts
JOIN applic_text_block atb ON atb.APTB_ID = applic_text_block_fts.rowid
WHERE applic_text_block_fts MATCH ?
ORDER BY rank
LIMIT ?
```
Returns the snippet (not the full APTB_TEXT — too large) so the model gets a usable preview; full text is retrievable via `execute_sql` keyed on `APTB_ID`.

### JOIN restructuring in `src/logic.ts`

`searchLicences`, `searchLicencesWithSites`, `getLicenceDetails`, `searchClients`, `searchSites`, `getSiteDetails` are updated to LEFT JOIN the relevant lookup tables and expose name fields alongside the existing code columns. Backwards-compat: the existing columns stay; new name columns are additive. Example before/after for `searchLicences`:

```sql
-- BEFORE
SELECT * FROM licence WHERE LICENCE_NO LIKE ? LIMIT ?

-- AFTER
SELECT l.*,
       sv.SV_NAME    AS SERVICE_NAME,
       ss.SS_NAME    AS SUBSERVICE_NAME,
       ls.STATUS_TEXT AS STATUS_NAME
FROM licence l
LEFT JOIN licence_service     sv ON sv.SV_ID = l.SV_ID
LEFT JOIN licence_subservice  ss ON ss.SS_ID = l.SS_ID AND ss.SV_SV_ID = l.SV_ID
LEFT JOIN licence_status      ls ON ls.STATUS = l.STATUS
WHERE l.LICENCE_NO LIKE ?
LIMIT ?
```

Similar restructuring for the others, joining the appropriate lookups for client/site/device contexts. `getSiteDetails`' device list joins `nature_of_service`, `class_of_station`, `antenna_polarity` for each device row.

### `execute_sql` description update

The aspirational table list in `src/index.ts` (around line 248) gets replaced with the accurate post-expansion 22-table list: `client`, `licence`, `site`, `device_details`, `antenna`, `bsl`, `bsl_area`, `auth_spectrum_freq`, `auth_spectrum_area`, `satellite`, `applic_text_block`, `applic_text_block_fts`, `reports_text_block`, `client_type`, `fee_status`, `industry_cat`, `licence_service`, `licence_subservice`, `licence_status`, `nature_of_service`, `class_of_station`, `licensing_area`, `antenna_polarity`, `meta`. Drops the unmaterialised aspirational entries (`access_area`, `antenna_pattern`).

## Removals

None. Pure addition. The existing `searchLicences*` / `get*Details` signatures and return shapes are extended, not changed.

## Testing

### New tests
- **`applyCsvDiff` composite-PK** (`tests/sync.test.ts`): synthesise a change-zip with an `auth_spectrum_freq.csv` containing Added/Updated/Deleted rows; verify the DELETE-then-INSERT with the 4-column composite key works correctly.
- **`searchBsl`, `searchSpectrumBand`** (`tests/logic.test.ts`): seed `bsl` + `bsl_area` and `auth_spectrum_freq` + `auth_spectrum_area` with known rows; verify substring match, frequency-band overlap predicate (including edge cases: query band entirely inside, entirely outside, half-overlapping), area JOIN.
- **`searchApplicationText`** (`tests/sync.test.ts` for FTS5 build, `tests/logic.test.ts` for query): seed `applic_text_block` with 3 rows of distinct text; run FTS5 rebuild; verify MATCH returns expected rows with snippet markup.
- **`searchLicences` with JOINs** (`tests/logic.test.ts`): seed `licence` + `licence_service` + `licence_subservice` + `licence_status`; verify name columns appear in result rows.

### Updated tests
- Existing `searchLicences` / `getLicenceDetails` tests get expectations updated to include the new name columns (additive — no removed assertions).

### Removed tests
None.

## Roadmap notes

Two follow-up sprints are explicitly out-of-scope here but referenced for continuity:

**Sprint 3 — SQL backend + matterfront-style hydration.** Before any further table additions, do:
- CTE support in `execute_sql`'s validator (accept `WITH` as a legal SELECT prefix).
- `describe_schema(tables?)` meta-tool — runtime DDL/index introspection, replaces the static table list in `execute_sql`'s description.
- `describe_tool(name)` meta-tool — full markdown spec per tool, on demand. Trim the `tools/list` catalog to lean one-liners.
- `list_sample_queries({ category?, name? })` — paginated/categorised. Aligned to the original ACMA offline app's set (visible in `scratch/offline_rrl*.js`).
- `_hints` arrays embedded in tool result payloads — next-step affordances (e.g., `search_licences` results carry `_hints` pointing at `get_licence_details` and `export_kml`).
- ANALYZE after full sync; possibly `explain_query` tool.

Design principles recorded in repo memory (`feedback_mcp_hydration.md`).

**Sprint 4 — `antenna_pattern`.** Last of the technical tables. ~2 MB of radiation pattern data per antenna. Useful for EME / coverage modelling. No new MCP tool unless a concrete consumer asks for one — `execute_sql` is the right surface.
