# SQL backend hardening + matterfront-style context hydration

## Problem

After Sprints 1–2 the MCP server materialises 22 tables and exposes 12 tools, but the catalog and SQL surface are inefficient for LLM agents:

- **`tools/list` payload is bloated.** Each tool description is a multi-section markdown blob; ~145 lines just inside `description:` strings (out of `src/index.ts`'s 661 total lines). On a `tools/list` call the entire blob is shipped, every session.
- **`execute_sql` rejects CTEs.** The validator at `src/sql.ts:33-39` checks `firstWord !== 'SELECT'`. Any query starting with `WITH ...` is rejected even though CTEs are read-only by definition. Several of the more useful sample queries are blocked.
- **Schema is undiscoverable at runtime.** The `execute_sql` description hard-codes the table list. An agent has to either trust that list (it lied for months until P11) or `SELECT * FROM sqlite_master`. There is no clean way to ask "what columns does `auth_spectrum_freq` have?".
- **`list_sample_queries` returns all 45 queries at once.** ~5 KB of JSON regardless of what the agent actually needs. There is no category structure to support targeted exploration.
- **Tool results are dead-end.** A `search_licences` result is a list of rows; nothing in the payload tells the agent that `get_licence_details(licence_no)` is the natural next step, or that `export_kml(result_id)` would render the result spatially. Agents have to know the workflow by heart.
- **No query plan visibility.** When a SQL query is unexpectedly slow, the agent has no way to ask SQLite which indexes are being used.
- **No `ANALYZE` after sync.** After every full sync the query planner is working from stale statistics on the new table sizes.

## Goals

1. Slim `tools/list` payload by 60-80% via aggressive description trimming + a `describe_tool(name)` meta-tool.
2. Add a runtime schema-introspection meta-tool `describe_schema(tables?)`.
3. Accept `WITH ... SELECT ...` (CTEs) in `execute_sql`.
4. Categorise the 45 sample queries; paginate `list_sample_queries` by category/name.
5. Embed contextual `_hints` arrays in result payloads where a follow-up tool obviously applies.
6. Run `ANALYZE` at the tail of `performFullSync`.
7. Add an `explain_query` tool returning SQLite's `EXPLAIN QUERY PLAN` output.

## Non-goals

- **Antenna patterns** (Sprint 4 — last technical table).
- **Refactoring `src/sync.ts`** despite its ~800 lines. Next feature touching `sync.ts` can extract `applyCsvDiff`+FTS5 into a module; not in scope here.
- **Removing pre-existing failing test scaffolds** (`tests/sql_crossjoin.test.ts`, `tests/sql_transaction.test.ts`). Unrelated chore.
- **Schema migrations** for index rename consistency (e.g. `bsl_area_code_idx2`). Pre-existing cosmetic note from the P4 review; not blocking.
- **CTE materialisation hints, `INSERT/DELETE/UPDATE` in CTE bodies, or sandbox bypass.** CTE support means accepting `WITH` as a SELECT prefix; the BEGIN/ROLLBACK sandbox in `src/sql_worker.ts` continues to ensure no mutation lands.

## Architecture

All work lives in `src/sql.ts`, `src/sql_worker.ts`, `src/sql_worker.cjs`, `src/index.ts`, `src/logic.ts` (for embedded `_hints`), and `src/sync.ts` (for `ANALYZE`). No new files — project convention is flat `src/`.

### 1. CTE support in `execute_sql` validator

`src/sql.ts:33-39` and the equivalent guard in `src/sql_worker.ts:24-32`:

```typescript
const firstWord = (trimmed.split(/\s+/)[0] ?? '').toUpperCase();
if (firstWord !== 'SELECT' && firstWord !== 'WITH') {
    throw new Error(
        `Only SELECT/WITH statements are allowed. Received: ${firstWord}. ` +
        `Use execute_sql for querying data only.`
    );
}
```

`WITH RECURSIVE`-prefixed queries match `firstWord === 'WITH'`. The `BEGIN TRANSACTION; ... ROLLBACK;` sandbox in the worker already prevents any write side-effects regardless of statement type, so the validator can safely loosen.

Update both files (`sql.ts` and `sql_worker.ts`) — the worker has a duplicated check that must move in lockstep.

### 2. `describe_schema` meta-tool

New function in `src/sql.ts`:

```typescript
export interface TableDescription {
    name: string;
    columns: Array<{ name: string; type: string; notnull: boolean; pk: boolean }>;
    indexes: Array<{ name: string; columns: string[]; unique: boolean }>;
    rowCount: number;     // SELECT COUNT(*) — cheap on indexed tables
    isVirtual: boolean;   // true for applic_text_block_fts
}

export function describeSchema(
    db: Database.Database,
    tables?: string[],
): TableDescription[]
```

When `tables` is omitted, returns all 22+ tables. When provided, filters to the named subset (case-insensitive match). Uses `PRAGMA table_info(<t>)` + `PRAGMA index_list(<t>)` + `PRAGMA index_info(<idx>)` + `SELECT COUNT(*) FROM <t>` per table. Virtual tables (FTS5) are detected via `sqlite_master.type='table' AND sql LIKE '%VIRTUAL%'`.

MCP tool definition in `src/index.ts`:

```ts
{
    name: 'describe_schema',
    description: '[Schema Introspection] Returns columns, indexes, and row counts for one or more tables. Omit `tables` for all materialised tables.',
    inputSchema: {
        type: 'object',
        properties: {
            tables: { type: 'array', items: { type: 'string' }, description: 'Optional list of table names; omit for all.' },
        },
    },
}
```

### 3. `describe_tool` meta-tool + aggressive catalog trim

New constant in `src/index.ts`:

```typescript
interface ToolDoc {
    summary: string;     // ≤80 chars
    tags: string[];      // ['primary'], ['geospatial'], ['fts'], ['meta'], ['sync'], ['sql']
    fullDescription: string;  // the existing multi-line markdown
}
const TOOL_DOCS: Record<string, ToolDoc> = { /* one entry per tool */ };
```

`tools/list` advertises each tool with `description: TOOL_DOCS[name].summary` plus a `_meta.tags` field on the tool's input schema:

```ts
{
    name: 'search_licences',
    description: 'Search ACMA licences by licence number (substring match).',
    inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' }, limit: { type: 'number' } },
        required: ['query'],
        _meta: { tags: ['primary', 'sql'] },
    },
}
```

(`_meta` in JSON Schema is permitted by the MCP spec for arbitrary metadata.)

New tool:

```ts
{
    name: 'describe_tool',
    description: '[Meta] Returns the full documentation for a given tool by name.',
    inputSchema: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
    },
}
```

Handler: returns `TOOL_DOCS[name].fullDescription` (the markdown that previously lived inline).

Capability tags (initial set, per current 13 tools after this sprint): `primary` (`search_licences`), `lookup` (`get_licence_details`, `get_site_details`), `sql` (`execute_sql`, `list_sample_queries`, `explain_query`), `geospatial` (`export_kml`), `sync` (`sync_data`), `fts` (`search_application_text`), `broadcasting` (`search_bsl`), `spectrum` (`search_spectrum_band`), `meta` (`describe_schema`, `describe_tool`).

Catalog payload reduction estimate: ~145 lines → ~25 lines. About 82%.

### 4. Categorised `list_sample_queries`

Extend `SampleQuery` type in `src/sql.ts`:

```typescript
export interface SampleQuery {
    description: string;
    query: string;
    category: SampleQueryCategory;
}

export type SampleQueryCategory =
    | 'lookup'         // "All <table>" queries — 23 entries
    | 'statistics'     // counts, aggregates by service/type/state — 8 entries
    | 'geospatial'     // map / KML / coordinate queries — 5 entries
    | 'text-search'    // FTS5 / LIKE narrative queries — 3 entries
    | 'power-user'     // CTE templates, advanced joins — 6 entries
    | 'data-dict';     // sqlite_master introspection — 2 entries (rough split — final categorisation lives in the implementation)
```

`listSampleQueries(filter?)` signature:

```typescript
export function listSampleQueries(filter?: {
    category?: SampleQueryCategory;
    name?: string;   // substring match on description
}): SampleQuery[] | SampleQuerySummary

interface SampleQuerySummary {
    categories: Array<{ category: SampleQueryCategory; count: number; descriptions: string[] }>;
}
```

When called with no filter, returns the summary (a category × description matrix — ~1 line per query name, no SQL strings, very compact). When called with a category or name filter, returns the full `SampleQuery[]` matching.

MCP tool input schema gains:
```ts
{
    name: 'list_sample_queries',
    description: '[SQL] List sample queries; call bare for the category index, then filter by category/name for details.',
    inputSchema: {
        type: 'object',
        properties: {
            category: { type: 'string', enum: ['lookup', 'statistics', 'geospatial', 'text-search', 'power-user', 'data-dict'] },
            name:     { type: 'string', description: 'Substring match on description' },
        },
    },
}
```

### 5. `_hints` in tool result payloads (contextual)

Tools that have a clear follow-up emit `_hints` alongside their data:

- `search_licences` → `[{ tool: 'get_licence_details', args: { licence_no: row.LICENCE_NO }, why: 'devices + holder' }]` per row, OR a single hint pointing at the first result.
- `search_sites` → `[{ tool: 'get_site_details', args: { site_id: row.SITE_ID }, why: 'devices at this site' }]`.
- `search_clients` → no specific follow-up tool today (there's no `get_client_details`); skip `_hints`.
- `search_bsl` → no obvious follow-up; skip.
- `search_spectrum_band` → no obvious follow-up; skip.
- `search_application_text` → `[{ tool: 'execute_sql', args: { sql: \`SELECT APTB_TEXT FROM applic_text_block WHERE APTB_ID = ${row.APTB_ID}\` }, why: 'full text' }]`.
- `execute_sql` → if result has geospatial columns (already detected by `hasGeospatialData` in `src/index.ts:61`) AND a `result_id` is cached, emit `[{ tool: 'export_kml', args: { result_id }, why: 'render geospatially' }]`. (This wiring already half-exists.)
- `get_licence_details`, `get_site_details` → if results have geospatial cols, same KML hint.
- `sync_data`, `list_sample_queries`, `describe_schema`, `describe_tool`, `explain_query` → no hints.

Result shape:

```typescript
interface ResultEnvelope<T> {
    rows?: T[];
    result_id?: string;
    _hints?: Array<{
        tool: string;
        args?: Record<string, unknown>;
        why: string;
    }>;
}
```

Hints are emitted only when populated (no empty arrays).

### 6. ANALYZE after full sync

In `src/sync.ts`'s `performFullSync`, after the FTS5 rebuild block and before the meta REPLACE block, add:

```typescript
console.error('Running ANALYZE for query planner...');
const anDb = new Database(config.dbPath);
try {
    anDb.exec('ANALYZE;');
} finally {
    anDb.close();
}
```

`ANALYZE` on the 22-table corpus completes in a few seconds. The output is the `sqlite_stat1` table; the query planner uses it for join order and index selection. Safe; no parameters.

### 7. `explain_query` tool

New logic + tool. In `src/sql.ts`:

```typescript
export function explainQuery(db: Database.Database, sql: string): Array<{
    id: number;
    parent: number;
    notused: number;
    detail: string;
}>
```

Validates the input as SELECT-or-WITH first (reuses the validator from item 1). Prepares `EXPLAIN QUERY PLAN ${sql}` and returns the rows. Does NOT run inside the sandbox transaction (EXPLAIN doesn't execute the query).

MCP tool:

```ts
{
    name: 'explain_query',
    description: '[SQL] Returns SQLite EXPLAIN QUERY PLAN output for a SELECT/WITH statement.',
    inputSchema: {
        type: 'object',
        properties: { sql: { type: 'string', description: 'A SELECT or WITH ... SELECT statement' } },
        required: ['sql'],
    },
}
```

## Removals

- The hard-coded `## Available tables` list in `execute_sql`'s description (P11 of last sprint just landed it accurately, but `describe_schema` is the runtime source going forward — leaves the list authoritative for the catalog summary but trimmed in the catalog itself).
- The verbose markdown blocks in 9 existing tool descriptions move into `TOOL_DOCS`. The catalog `description:` field for each existing tool becomes its `summary`.

## Testing

### New tests

- **`tests/sql.test.ts`**:
  - CTE accepted: `WITH x AS (SELECT 1) SELECT * FROM x` runs without rejection.
  - `WITH RECURSIVE` accepted similarly.
  - `INSERT`, `UPDATE`, `DELETE`, `DROP` still rejected with the existing message.
  - `describeSchema()` returns all tables; row count > 0 for materialised tables.
  - `describeSchema(['client', 'bsl'])` filters correctly.
  - `describeSchema` includes `isVirtual: true` for `applic_text_block_fts`.
  - `listSampleQueries()` (no args) returns a summary object with all categories represented.
  - `listSampleQueries({ category: 'geospatial' })` returns only geospatial queries.
  - `listSampleQueries({ name: 'NBN' })` does substring match.
  - `explainQuery(db, 'SELECT * FROM client WHERE CLIENT_NO = 42')` returns at least one row mentioning the `client` table.
  - `explainQuery` rejects non-SELECT/WITH input.

- **`tests/logic.test.ts`**: existing search/detail tests get a `_hints` assertion for the tools that gain hints (search_licences, search_sites, search_application_text). Specifically: results have a `_hints` field; first hint's `tool` is the expected follow-up name.

- **`tests/sync.test.ts`**: full-sync ANALYZE — a test that initialises the DB, mocks a tiny full sync, and verifies `sqlite_stat1` is populated after.

### Updated tests

- `tests/network.test.ts` regex for `sync_data` text response — no expected change (this sprint doesn't touch `sync_data` output format).
- The existing test asserting `tools/list` contains tool names continues to pass (names unchanged); description-text assertions, if any, need to use the new compact summaries.

### Removed tests

None.

## Risks and mitigations

- **MCP clients that don't speak `describe_tool`** see only the one-line summary in `tools/list`. Acceptable — the summary names the tool and its capability tags; dumb clients can still invoke. The `description` field still satisfies the MCP spec's required string.
- **`_meta` in inputSchema** is an MCP extension. JSON Schema's "Unknown Keywords" rule says they're ignored by validators that don't recognise them. Safe to add.
- **`describe_schema` is a slow first call** on a fully-populated DB — 22 `PRAGMA` calls + 22 `COUNT(*)`s. On the current data (~600 MB total) `COUNT(*)` on `applic_text_block` (447 K rows) takes a few hundred ms. Acceptable for an introspection tool. Cache the result in-memory for 60 s as a follow-up if needed.
- **Catalog trim breaks any client that hard-codes parsing of the verbose description.** Such clients are unlikely (descriptions are LLM-facing prose). The capability tags via `_meta.tags` give programmatic clients a stable signal.

## Roadmap

- **Sprint 4 — `antenna_pattern`** remains the next data sprint. The matterfront design from this sprint (`_hints` for search → details, etc.) generalises trivially when new tools are added.
- **Optional follow-ups** (not in this sprint): in-memory cache for `describeSchema`; pagination on `execute_sql` for queries that exceed the row cap; named-prepared-statement registry for power users.
