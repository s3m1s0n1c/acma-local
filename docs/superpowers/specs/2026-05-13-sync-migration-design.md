# Sync migration to ACMA v1 Extracts manifest

## Problem

ACMA quietly rolled out a new RRL backend in early May 2026 at `https://backend.acma.gov.au/rrl/v1/`. The legacy URLs our pipeline uses still serve today, but signals point to deprecation:

- The legacy incremental endpoint `https://web.acma.gov.au/rrl/spectra_incremental.rrl_update` was observed timing out on 2026-05-13.
- The legacy bulk URL `https://web.acma.gov.au/rrl-updates/spectra_rrl.zip` and the new CDN URL `https://cdn.acma.gov.au/rrl/spectra_rrl.zip` now serve materially different artifacts (different content-length, last-modified, schedule).
- The legacy offline app at `https://web.acma.gov.au/offline-rrl/` has not been touched on the server since 2024 and has been visibly replaced by a React SPA at `https://www.acma.gov.au/register-radiocommunication-licences-rrl` that consumes the new backend.

`src/sync.ts` currently fetches three legacy URLs (`datasetUrl`, `timestampUrl`, `incrementalUrl`) and parses an `.rrl_update` SQL-diff format. None of that maps to the new API.

Two further constraints surfaced during brainstorming:

1. **Mobile / offline-first.** Automatic sync must never decide on its own to pull the 70 MB `spectra_rrl.zip` — the host application may be running on a metered or unreachable connection. A user (or agent) must explicitly opt into a full download.
2. **3-day incremental window.** The new manifest exposes the latest full extract plus only ~3 most recent daily change-zips. A DB older than ~3 days falls outside the manifest's reach.

## Goals

- Replace the 3-URL legacy config with a single manifest URL.
- Parse the manifest, apply the latest applicable daily change-zips (CSV-diff format).
- Surface freshness state explicitly through `SyncStatus` so consumers can answer "how current is this data?".
- Give callers a `mode: 'auto' | 'full'` switch via the MCP `sync_data` tool.
- Preserve the local-`inputs/spectra_rrl.zip` shortcut for dev workflows.

## Non-goals

- Ingesting `spectra_licence_hrp.zip` (1.5 GB Device Power Patterns) — deferred to a later sprint.
- Migrating KML rendering to the API's `/v1/Sites/kml` and `/v1/SpectrumAreas/{id}/kml` endpoints — feature parity stays in-house, deferred to a later sprint.
- Schema changes — no PRIMARY KEY / UNIQUE constraints added to existing tables. The DELETE-then-INSERT pattern keeps incrementals idempotent without touching DDL.
- Authenticated `/prtl/webapi/rrl/` endpoints — out of scope (Digital ID required).
- Retries / backoff for network or apply failures beyond the existing one-shot semantics.

## Architecture

Everything lives in `src/sync.ts` (project convention is a flat `src/`). The file grows from ~500 to ~700 lines; if it exceeds ~800 a follow-up refactor can split into `sync_manifest.ts` + `sync_csv_diff.ts`.

### Points of truth

| Question | Field / source | Set by |
|---|---|---|
| "How fresh is the data we hold?" | `meta.as_of` (ISO 8601) | Last applied change-zip's `LastMdified`, or full entry's `LastMdified` after a full sync |
| "When did our pipeline last attempt to sync?" | `meta.last_sync` (ISO 8601) | End of every successful sync attempt |
| "What is upstream's latest data?" | Manifest `full_entry.LastMdified` | Fetched on every `sync()` invocation; not persisted |
| "Are we behind upstream?" | derived: `remoteAsOf − dataAsOf` | Computed and exposed on `SyncStatus` |

The decision-making core is a pure function so it can be tested without network or filesystem:

```ts
type SyncAction =
  | { kind: 'noop'; reason: 'cooldown' | 'current' }
  | { kind: 'full'; entry: ExtractEntry; reason: 'bootstrap' | 'forced' }
  | { kind: 'incremental'; entries: ExtractEntry[] }      // sorted by LastMdified asc
  | { kind: 'gap-exceeded'; behindHours: number };

export function decideSyncAction(
  asOf: Date | null,
  manifest: ExtractsManifest,
  mode: SyncMode,
  lastSync: Date | null,
  now: Date,
): SyncAction
```

### Decision rules (the body of `decideSyncAction`)

In order:

1. **Cooldown.** If `lastSync !== null` and `now − lastSync < SYNC_COOLDOWN_MS` (12 h, unchanged): `{ noop, cooldown }`.
2. **Bootstrap.** If `asOf === null`: `{ full, bootstrap }`. The MCP tool's `mode` argument does not gate this — first-run must succeed.
3. **Forced.** If `mode === 'full'`: `{ full, forced }`.
4. **Current.** If `asOf >= manifest.full.LastMdified`: `{ noop, current }`.
5. **Incremental candidates.** Let `applicable = incrementals.filter(e => e.LastMdified > asOf).sort()`.
6. **Gap-exceeded.** If `applicable.length === 0` OR `applicable[0].LastMdified − asOf > 30 h`: `{ gap-exceeded, behindHours }`. The 30 h tolerance = the manifest's 24 h-per-zip window plus 6 h of slack. Sync does NOT auto-fall-back to full; it logs a warning and returns. The user can re-run with `mode='full'`.
7. **Incremental.** Otherwise: `{ incremental, entries: applicable }`.

### `SyncConfig` shape

```ts
export interface SyncConfig {
    extractsUrl: string;   // default: https://backend.acma.gov.au/rrl/v1/Extracts
    dataDir: string;       // default: ./data
    dbPath: string;        // default: ./data/acma.db
}
```

`datasetUrl`, `timestampUrl`, `incrementalUrl` are removed. The manifest is sufficient for all three responsibilities.

### `SyncStatus` shape

Existing fields preserved (`isSyncing`, `progress`, `currentTable`, `lastError`, `mode`, `reason`, `lastDecisionAt`, `detail`) with two adjustments:

- `mode` type extended: `'auto' | 'full' | 'incremental'` — `'auto'` denotes a noop or gap-exceeded outcome where no mode was actually executed.
- `reason` type adjusted to drop `'parse-failed'` (no more text-format timestamp parsing on the sync path) and add `'current'` and `'manifest-fetch-failed'`.

New fields:

```ts
dataAsOf?: string;        // = meta.as_of (ISO 8601)
lastSyncAt?: string;      // = meta.last_sync (ISO 8601)
remoteAsOf?: string;      // = last seen manifest full.LastMdified
behindByHours?: number;   // derived; 0 when current
```

### Manifest types and helpers

```ts
interface ExtractItem {
    Description: string;
    Format: string;
    FileSize: number;
    FileName: string;
    FileUrl: string;
}
interface ExtractEntry {
    IsFullExtract: boolean;
    LastMdified: string;      // ISO 8601 — typo preserved verbatim to match API
    DateOfChanges?: string;   // YYYY-MM-DD; present only when IsFullExtract === false
    Items: ExtractItem[];
}
type ExtractsManifest = ExtractEntry[];

export async function fetchExtractsManifest(url: string): Promise<ExtractsManifest>
function pickSpectraRrl(items: ExtractItem[]): ExtractItem | null
//   → returns the Items entry whose FileName starts with 'spectra_rrl'
//     (filters out 'spectra_licence_hrp')
```

`parseRemoteTimestamp` extended to accept ISO 8601 (`YYYY-MM-DDTHH:MM:SSZ`) in addition to the existing dashed (`YYYY-MM-DD HH:MM:SS`) and compact (`YYYYMMDDHHMMSS`) forms. Existing DBs may have either of the older formats in `meta.as_of`; new writes use ISO 8601.

### CSV-diff application

```ts
export async function applyCsvDiffZip(
  zipPath: string,
  dbPath: string,
): Promise<void>
```

Per zip:

1. Extract entries to `<dataDir>/changes/<DateOfChanges>/`.
2. For each CSV whose target table (filename stem) is in `TABLE_METADATA`, OR whose stem aliases to one:
   - Aliases: `device_detail` → `device_details` (ACMA naming bug in change-zips).
   - Tables not in our schema (e.g. `applic_text_block`, `antenna_pattern`, ...) are skipped without warning.
3. Read CSV header. Last column must be `CHANGE`; if not, throw.
4. Open one transaction per CSV. For each row:
   - `CHANGE === 'Deleted'`: `DELETE FROM <table> WHERE <pk> = ?` using only the PK column (other columns are blank).
   - `CHANGE === 'Added'` or `'Updated'`: `DELETE FROM <table> WHERE <pk> = ?` then `INSERT INTO <table> (...) VALUES (...)` — idempotent under repeated application.
   - Anything else: log `console.warn` and skip the row.
5. Commit.

PK map (single-column for every tracked table):
```ts
const PK_BY_TABLE: Record<string, string> = {
  client: 'CLIENT_NO',
  licence: 'LICENCE_NO',
  site: 'SITE_ID',
  device_details: 'SDD_ID',
  antenna: 'ANTENNA_ID',
};
```

### Orchestrator: `sync(config, mode)`

```
sync(config = DEFAULT_CONFIG, mode: SyncMode = 'auto'):
  read meta.last_sync                                  → lastSync (or null)
  fetch manifest                                       → on failure: record 'manifest-fetch-failed', return
  read meta.as_of                                      → asOf (or null)
  action = decideSyncAction(asOf, manifest, mode, lastSync, now)

  switch (action.kind):
    'noop':
      record { reason: action.reason }, return
    'gap-exceeded':
      console.warn(`DB is ${action.behindHours}h behind; run sync_data mode=full to recover`)
      record { reason: 'gap-exceeded', detail: '<N>h behind manifest window' }
      return
    'full':
      performFullSync(config, action.entry)
      write meta.as_of = action.entry.LastMdified
      write meta.last_sync = now
      record { mode: 'full', reason: action.reason === 'bootstrap' ? 'no-db' : 'forced', ... }
    'incremental':
      for entry of action.entries:
        url = pickSpectraRrl(entry.Items).FileUrl
        zipPath = `${config.dataDir}/changes/${entry.DateOfChanges}.zip`
        download(url, zipPath)
        await applyCsvDiffZip(zipPath, config.dbPath)
      write meta.as_of = action.entries.at(-1).LastMdified
      write meta.last_sync = now
      record { mode: 'incremental', reason: 'incremental-success', detail: '<N> change-zips applied' }
```

`performFullSync` keeps its existing structure (download → extract → import) but takes an `ExtractEntry` (specifically the IsFullExtract one) instead of dredging URLs from config. The `inputs/spectra_rrl.zip` shortcut path is preserved — it now compares against `entry.LastMdified` for staleness.

### `inputs/spectra_rrl.zip` shortcut

Unchanged behavior, adapted source of truth: if `inputs/spectra_rrl.zip` exists and its mtime ≥ `full_entry.LastMdified`, copy it to `<dataDir>/spectra_rrl.zip` instead of downloading. The existing `isInputZipStale` helper continues to do the comparison.

### MCP integration (`src/index.ts`)

The `sync_data` tool's `inputSchema` (currently `{ type: 'object', properties: {} }`) gains an optional `mode` property:
```ts
{ type: 'object', properties: { mode: { type: 'string', enum: ['auto', 'full'] } } }
```
Threaded straight through to `sync(config, mode)`.

The existing `sync_data` text response (which already formats `status.mode / .reason / .detail / .lastDecisionAt / .progress / .currentTable`) is extended to include the three new freshness fields when present: `dataAsOf`, `remoteAsOf`, `behindByHours`. (`lastSyncAt` is implicit via `lastDecisionAt`.) There is no separate `get_db_status` tool today; if one is wanted later, the same `SyncStatus` is the natural source. No other MCP surface change.

## Removals

- `applyIncrementalUpdate` function and its test (legacy SQL-diff parser).
- `incrementalUrl`, `timestampUrl`, `datasetUrl` fields from `SyncConfig`.
- `shouldDoFullSync` and its tests — superseded by `decideSyncAction`. Verified (grep) that no consumer outside `src/sync.ts` and `tests/sync.test.ts` imports it.
- `reason: 'parse-failed'` in `SyncStatus` (no more text-format parsing in the sync path).

## Testing

New tests in `tests/sync.test.ts`:

1. **`fetchExtractsManifest`** — supplies a fixture JSON via mocked axios; asserts parsing, including the `LastMdified` typo preservation.
2. **`parseRemoteTimestamp` ISO 8601** — `2026-05-12T21:51:36Z` parses; bogus input still returns null.
3. **`decideSyncAction` pure-function matrix** — at minimum:
   - Cooldown active → noop
   - asOf null → bootstrap full (regardless of mode)
   - asOf >= full.LastMdified → noop current
   - mode='full' → forced full (even when current)
   - asOf strictly inside manifest window → incremental with correctly-sorted entries
   - asOf > 30 h before oldest applicable → gap-exceeded
   - No applicable incrementals AND asOf < full.LastMdified → gap-exceeded
4. **`applyCsvDiffZip`** — synthesize an in-memory zip with one CSV per outcome (Added / Updated / Deleted) for `client` (plural-named) and `device_details` (covered by the `device_detail` singular alias). Verify DB end-state row-by-row.
5. **End-to-end `sync()`** with axios mocked: bootstrap, current, incremental, gap-exceeded-no-fallback, force-full. Verify `meta.as_of`, `meta.last_sync`, and `SyncStatus` fields after each.

Existing preserved: `parseRemoteTimestamp` (old forms), `isInputZipStale`, `extractZip`, `importCsv`.

Deleted: `applyIncrementalUpdate` test, `shouldDoFullSync` tests.

## Migration notes

- No data migration required — `meta.as_of` parser is backward-compatible across all three formats (dashed, compact, ISO 8601). Existing installs are picked up correctly on first sync after the upgrade.
- The `data/changes/` subdirectory is created on demand the first time an incremental runs. It is already covered by the existing `.gitignore` rule `data/`.
- The 12 h `SYNC_COOLDOWN_MS` is preserved as-is. (Relaxing it for the cheaper-to-serve new CDN is a separate change and out of scope.)
