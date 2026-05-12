# Sync Migration to ACMA v1 Extracts Manifest — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 3-URL legacy ACMA sync (`spectra_rrl.zip` + `datetime-of-extract.txt` + `.rrl_update` SQL diff) with a manifest-driven flow against `https://backend.acma.gov.au/rrl/v1/Extracts` that applies CSV-diff change-zips for incremental updates, never auto-pulls the 70 MB full extract, and surfaces an explicit `mode: 'auto' | 'full'` switch on the MCP `sync_data` tool.

**Architecture:** All work lives in `src/sync.ts` (project convention is flat `src/`). A pure `decideSyncAction()` function is the point of truth for sync routing; CSV-diff application is a transactional DELETE-then-INSERT per row, idempotent without schema PK constraints. `meta.as_of` and `meta.last_sync` remain the local freshness records; the manifest's `LastMdified` is the remote source of truth and is compared against, never stored.

**Tech Stack:** TypeScript, Jest (ts-jest ESM preset), better-sqlite3, axios, adm-zip, csv-parse (incl. `csv-parse/sync`), Node `fs`.

**Spec:** `docs/superpowers/specs/2026-05-13-sync-migration-design.md`

---

## File Structure

**Modify:**
- `src/sync.ts` — replace legacy URLs with manifest flow; add `ExtractsManifest` types, `fetchExtractsManifest`, `decideSyncAction`, `applyCsvDiffZip`; rewire `sync()` and `performFullSync()`; extend `parseRemoteTimestamp` for ISO 8601; extend `SyncStatus` with freshness fields.
- `src/index.ts` — extend `sync_data` tool input schema with `mode` arg; thread to `sync()`; surface new freshness fields in the text response.
- `tests/sync.test.ts` — add tests for new pure helpers and the orchestrator; remove tests for the deleted `applyIncrementalUpdate` and `shouldDoFullSync`.
- `README.md` — update the data-source section to point at the new endpoints.

**No new files.** The pure helpers fit naturally alongside the existing sync code; project does not use subdirectories under `src/`.

**Deleted code (within `src/sync.ts` and `tests/sync.test.ts`):**
- `applyIncrementalUpdate` function + its test (`'should apply incremental SQL updates'`)
- `shouldDoFullSync` function + its `describe` block (5 tests)
- `datasetUrl`, `timestampUrl`, `incrementalUrl` fields from `SyncConfig`

---

## Task 1: `ExtractsManifest` types + `fetchExtractsManifest` + `pickSpectraRrl`

Adds the type model for ACMA's `/v1/Extracts` JSON payload and two helpers: one to fetch and validate the payload, one to pick the `spectra_rrl.zip` item out of an entry's `Items` array (filters out `spectra_licence_hrp.zip` which is out of scope this sprint).

**Files:**
- Modify: `src/sync.ts` (add new exports near the top, after `SyncConfig`)
- Test: `tests/sync.test.ts` (add new `describe` blocks)

- [ ] **Step 1: Write the failing tests for `pickSpectraRrl`**

Add to the top of `tests/sync.test.ts`, after the existing imports:

```typescript
import { pickSpectraRrl, fetchExtractsManifest } from '../src/sync';
import type { ExtractItem, ExtractsManifest } from '../src/sync';
import axios from 'axios';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;
```

Then add this `describe` block at the end of the file:

```typescript
describe('pickSpectraRrl', () => {
    const item = (FileName: string): ExtractItem => ({
        Description: 'x', Format: 'CSV', FileSize: 0,
        FileName, FileUrl: `https://cdn.example/${FileName}`,
    });

    test('returns the spectra_rrl entry when present alongside hrp', () => {
        const items = [
            item('spectra_rrl.zip'),
            item('spectra_licence_hrp.zip'),
        ];
        expect(pickSpectraRrl(items)?.FileName).toBe('spectra_rrl.zip');
    });

    test('returns spectra_rrl-changes-YYYY-MM-DD.zip from an incremental entry', () => {
        const items = [item('spectra_rrl-changes-2026-03-15.zip')];
        expect(pickSpectraRrl(items)?.FileName).toBe('spectra_rrl-changes-2026-03-15.zip');
    });

    test('returns null when only hrp is present', () => {
        const items = [item('spectra_licence_hrp.zip')];
        expect(pickSpectraRrl(items)).toBeNull();
    });

    test('returns null on empty list', () => {
        expect(pickSpectraRrl([])).toBeNull();
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest tests/sync.test.ts -t 'pickSpectraRrl'`
Expected: 4 tests, all FAIL with `pickSpectraRrl is not a function` (or compile error: "no exported member 'pickSpectraRrl'").

- [ ] **Step 3: Implement types + `pickSpectraRrl`**

Add to `src/sync.ts`, immediately after `DEFAULT_CONFIG`:

```typescript
// ── ACMA /v1/Extracts manifest types ─────────────────────────────────────────
//
// Mirrors the JSON returned by GET https://backend.acma.gov.au/rrl/v1/Extracts.
// `LastMdified` is misspelled on ACMA's side; preserved verbatim so JSON.parse
// hits it directly. Each entry's Items array may contain spectra_rrl.zip and
// (for full entries) spectra_licence_hrp.zip — we ignore the latter this sprint.

export interface ExtractItem {
    Description: string;
    Format: string;
    FileSize: number;
    FileName: string;
    FileUrl: string;
}

export interface ExtractEntry {
    IsFullExtract: boolean;
    LastMdified: string;       // ISO 8601, e.g. "2026-05-12T21:51:36Z"
    DateOfChanges?: string;    // YYYY-MM-DD; present only when IsFullExtract === false
    Items: ExtractItem[];
}

export type ExtractsManifest = ExtractEntry[];

/**
 * Returns the spectra_rrl* item from an entry's Items array, or null if none.
 * Filters out spectra_licence_hrp.zip (Device Power Patterns — out of scope).
 */
export function pickSpectraRrl(items: ExtractItem[]): ExtractItem | null {
    return items.find(i => i.FileName.startsWith('spectra_rrl')) ?? null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest tests/sync.test.ts -t 'pickSpectraRrl'`
Expected: 4 tests PASS.

- [ ] **Step 5: Write the failing test for `fetchExtractsManifest`**

Add to `tests/sync.test.ts`:

```typescript
describe('fetchExtractsManifest', () => {
    afterEach(() => { jest.resetAllMocks(); });

    test('parses the manifest payload, preserving LastMdified typo', async () => {
        const payload: ExtractsManifest = [
            {
                IsFullExtract: true,
                LastMdified: '2026-05-12T21:51:36Z',
                Items: [{
                    Description: 'Spectra dataset', Format: 'CSV', FileSize: 71666767,
                    FileName: 'spectra_rrl.zip',
                    FileUrl: 'https://cdn.acma.gov.au/rrl/spectra_rrl.zip',
                }],
            },
            {
                IsFullExtract: false,
                DateOfChanges: '2026-03-15',
                LastMdified: '2026-03-15T13:20:59Z',
                Items: [{
                    Description: 'Spectra dataset', Format: 'CSV', FileSize: 12600026,
                    FileName: 'spectra_rrl-changes-2026-03-15.zip',
                    FileUrl: 'https://cdn.acma.gov.au/rrl/changes/spectra_rrl-changes-2026-03-15.zip',
                }],
            },
        ];
        mockedAxios.get.mockResolvedValueOnce({ data: payload });

        const m = await fetchExtractsManifest('https://example/v1/Extracts');

        expect(m).toEqual(payload);
        expect(m[0]!.LastMdified).toBe('2026-05-12T21:51:36Z');
        expect(mockedAxios.get).toHaveBeenCalledWith('https://example/v1/Extracts');
    });

    test('propagates axios errors', async () => {
        mockedAxios.get.mockRejectedValueOnce(new Error('network down'));
        await expect(fetchExtractsManifest('https://example/v1/Extracts'))
            .rejects.toThrow('network down');
    });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx jest tests/sync.test.ts -t 'fetchExtractsManifest'`
Expected: 2 tests FAIL with `fetchExtractsManifest is not a function`.

- [ ] **Step 7: Implement `fetchExtractsManifest`**

Add to `src/sync.ts`, immediately after `pickSpectraRrl`:

```typescript
/**
 * Fetches and returns the ACMA /v1/Extracts manifest. The manifest contains
 * the latest full extract entry plus the most recent (~3) daily change-zip
 * entries. Throws on network / parse failure.
 */
export async function fetchExtractsManifest(url: string): Promise<ExtractsManifest> {
    const response = await axios.get(url);
    return response.data as ExtractsManifest;
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx jest tests/sync.test.ts -t 'fetchExtractsManifest'`
Expected: 2 tests PASS.

- [ ] **Step 9: Commit**

```bash
git add src/sync.ts tests/sync.test.ts
git commit -m "feat(sync): Add ExtractsManifest types and fetch/pick helpers for ACMA /v1/Extracts."
```

---

## Task 2: Extend `parseRemoteTimestamp` to accept ISO 8601

`meta.as_of` will now be written from manifest `LastMdified` values (ISO 8601 like `2026-05-12T21:51:36Z`). The existing parser handles dashed (`2026-05-12 21:51:36`) and compact (`20260512215136`) forms; we add ISO 8601 alongside so historical `meta.as_of` rows still parse.

**Files:**
- Modify: `src/sync.ts:466-479` (the `parseRemoteTimestamp` function body)
- Test: `tests/sync.test.ts` (add cases to the existing `describe('parseRemoteTimestamp', ...)` block)

- [ ] **Step 1: Write the failing tests**

Add inside the existing `describe('parseRemoteTimestamp', ...)` block in `tests/sync.test.ts`:

```typescript
test('parses ISO 8601 UTC form (no fractional seconds)', () => {
    const d = parseRemoteTimestamp('2026-05-12T21:51:36Z');
    expect(d).not.toBeNull();
    expect(d!.toISOString()).toBe('2026-05-12T21:51:36.000Z');
});

test('parses ISO 8601 UTC form with fractional seconds', () => {
    const d = parseRemoteTimestamp('2026-05-12T21:51:36.123Z');
    expect(d).not.toBeNull();
    expect(d!.toISOString()).toBe('2026-05-12T21:51:36.123Z');
});

test('returns null on ISO 8601 with non-UTC timezone', () => {
    // We only support 'Z'; offsets like +10:00 are intentionally rejected
    // because ACMA's manifest always emits 'Z'.
    expect(parseRemoteTimestamp('2026-05-12T21:51:36+10:00')).toBeNull();
});

test('returns null on ISO 8601 with semantically invalid components', () => {
    expect(parseRemoteTimestamp('2026-13-12T21:51:36Z')).toBeNull();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest tests/sync.test.ts -t 'parseRemoteTimestamp'`
Expected: 4 new tests FAIL (existing 7 still pass).

- [ ] **Step 3: Extend `parseRemoteTimestamp`**

Replace the body of `parseRemoteTimestamp` in `src/sync.ts` (currently lines 466-479) with:

```typescript
export function parseRemoteTimestamp(s: string): Date | null {
    const trimmed = s.trim();
    // Three accepted forms:
    //   1. Dashed `YYYY-MM-DD HH:MM:SS` (legacy datetime-of-extract.txt).
    //   2. Compact `YYYYMMDDHHMMSS` optionally followed by sub-second digits
    //      (production feed at one point emitted 9 trailing digits).
    //   3. ISO 8601 UTC `YYYY-MM-DDTHH:MM:SS[.fff]Z` (new manifest LastMdified).
    const dashed = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(trimmed);
    const compact = dashed ? null : /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\d*$/.exec(trimmed);
    const iso = (dashed || compact) ? null : /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/.exec(trimmed);
    const m = dashed ?? compact ?? iso;
    if (!m) return null;
    // Construct ISO-8601 in UTC and validate by round-trip.
    // Compare against the input components so values like month=13 → null.
    const iso8601 = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
    const d = new Date(iso8601);
    if (isNaN(d.getTime())) return null;
    // Validate components round-trip (rejects 2026-13-12T... etc.)
    if (d.getUTCFullYear() !== Number(m[1]) ||
        d.getUTCMonth() + 1 !== Number(m[2]) ||
        d.getUTCDate() !== Number(m[3])) {
        return null;
    }
    // Preserve fractional seconds when present (ISO form only).
    if (iso) {
        return new Date(trimmed);
    }
    return d;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest tests/sync.test.ts -t 'parseRemoteTimestamp'`
Expected: all 11 tests PASS (7 existing + 4 new).

- [ ] **Step 5: Commit**

```bash
git add src/sync.ts tests/sync.test.ts
git commit -m "feat(sync): Accept ISO 8601 UTC in parseRemoteTimestamp for manifest LastMdified."
```

---

## Task 3: `SyncAction` type + `decideSyncAction` pure function

The decision core. Pure function (no I/O); fully unit-testable. Encapsulates the entire sync routing policy from the spec.

**Files:**
- Modify: `src/sync.ts` (add new exports near other types)
- Test: `tests/sync.test.ts` (add new `describe` block)

- [ ] **Step 1: Write the failing tests (cooldown + bootstrap + forced)**

Add to `tests/sync.test.ts`:

```typescript
import { decideSyncAction } from '../src/sync';
import type { SyncAction } from '../src/sync';

describe('decideSyncAction', () => {
    // Default manifest: full=May 12, three incrementals on May 10/11/12.
    const fixtureManifest = (): ExtractsManifest => ([
        {
            IsFullExtract: true,
            LastMdified: '2026-05-12T21:51:36Z',
            Items: [{
                Description: 'Spectra dataset', Format: 'CSV', FileSize: 71666767,
                FileName: 'spectra_rrl.zip',
                FileUrl: 'https://cdn.acma.gov.au/rrl/spectra_rrl.zip',
            }],
        },
        {
            IsFullExtract: false, DateOfChanges: '2026-05-12',
            LastMdified: '2026-05-12T13:20:59Z',
            Items: [{
                Description: 'Spectra dataset', Format: 'CSV', FileSize: 250000,
                FileName: 'spectra_rrl-changes-2026-05-12.zip',
                FileUrl: 'https://cdn.acma.gov.au/rrl/changes/spectra_rrl-changes-2026-05-12.zip',
            }],
        },
        {
            IsFullExtract: false, DateOfChanges: '2026-05-11',
            LastMdified: '2026-05-11T13:00:00Z',
            Items: [{
                Description: 'Spectra dataset', Format: 'CSV', FileSize: 250000,
                FileName: 'spectra_rrl-changes-2026-05-11.zip',
                FileUrl: 'https://cdn.acma.gov.au/rrl/changes/spectra_rrl-changes-2026-05-11.zip',
            }],
        },
        {
            IsFullExtract: false, DateOfChanges: '2026-05-10',
            LastMdified: '2026-05-10T13:00:00Z',
            Items: [{
                Description: 'Spectra dataset', Format: 'CSV', FileSize: 250000,
                FileName: 'spectra_rrl-changes-2026-05-10.zip',
                FileUrl: 'https://cdn.acma.gov.au/rrl/changes/spectra_rrl-changes-2026-05-10.zip',
            }],
        },
    ]);
    const now = new Date('2026-05-13T08:00:00Z');

    test('cooldown active → noop/cooldown (regardless of state)', () => {
        // lastSync only 1h ago, < 12h cooldown
        const lastSync = new Date('2026-05-13T07:00:00Z');
        const action = decideSyncAction(null, fixtureManifest(), 'auto', lastSync, now);
        expect(action).toEqual({ kind: 'noop', reason: 'cooldown' });
    });

    test('bootstrap when asOf is null and no cooldown applies', () => {
        const action = decideSyncAction(null, fixtureManifest(), 'auto', null, now);
        expect(action.kind).toBe('full');
        if (action.kind !== 'full') throw new Error('expected full');
        expect(action.reason).toBe('bootstrap');
        expect(action.entry.IsFullExtract).toBe(true);
    });

    test('mode=full → forced (even when current)', () => {
        const asOf = new Date('2026-05-12T21:51:36Z'); // exactly current
        const action = decideSyncAction(asOf, fixtureManifest(), 'full', null, now);
        expect(action).toMatchObject({ kind: 'full', reason: 'forced' });
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest tests/sync.test.ts -t 'decideSyncAction'`
Expected: 3 tests FAIL with `decideSyncAction is not a function` (or compile error).

- [ ] **Step 3: Implement `SyncAction` type and `decideSyncAction` skeleton**

Add to `src/sync.ts`, after `pickSpectraRrl`:

```typescript
// ── Sync routing: pure decision function ─────────────────────────────────────

export type SyncMode = 'auto' | 'full';

export type SyncAction =
    | { kind: 'noop'; reason: 'cooldown' | 'current' }
    | { kind: 'full'; entry: ExtractEntry; reason: 'bootstrap' | 'forced' }
    | { kind: 'incremental'; entries: ExtractEntry[] }
    | { kind: 'gap-exceeded'; behindHours: number };

/** Minimum milliseconds between any sync attempt. */
const SYNC_COOLDOWN_MS = 12 * 60 * 60 * 1000;   // 12 hours

/**
 * Maximum allowed gap (in ms) between meta.as_of and the oldest applicable
 * incremental. Equal to the manifest's 24 h-per-zip window plus 6 h of slack
 * so that we don't false-trigger on slow daily extract generation.
 */
const GAP_TOLERANCE_MS = 30 * 60 * 60 * 1000;   // 30 hours

/**
 * Decides what sync action to take given the local DB freshness, the remote
 * manifest, and the user-requested mode. Pure — no I/O, no clock reads.
 *
 * Decision rules, in order:
 *  1. Cooldown active → noop/cooldown.
 *  2. asOf === null → full/bootstrap (mode is ignored; first-run must succeed).
 *  3. mode === 'full' → full/forced.
 *  4. asOf >= manifest.full.LastMdified → noop/current.
 *  5. No applicable incrementals OR gap > GAP_TOLERANCE_MS → gap-exceeded.
 *  6. Otherwise → incremental with applicable entries sorted ascending.
 */
export function decideSyncAction(
    asOf: Date | null,
    manifest: ExtractsManifest,
    mode: SyncMode,
    lastSync: Date | null,
    now: Date,
): SyncAction {
    if (lastSync !== null && now.getTime() - lastSync.getTime() < SYNC_COOLDOWN_MS) {
        return { kind: 'noop', reason: 'cooldown' };
    }
    const fullEntry = manifest.find(e => e.IsFullExtract);
    if (!fullEntry) {
        throw new Error('Manifest has no full extract entry');
    }
    if (asOf === null) {
        return { kind: 'full', entry: fullEntry, reason: 'bootstrap' };
    }
    if (mode === 'full') {
        return { kind: 'full', entry: fullEntry, reason: 'forced' };
    }
    const fullTime = new Date(fullEntry.LastMdified).getTime();
    if (asOf.getTime() >= fullTime) {
        return { kind: 'noop', reason: 'current' };
    }
    const applicable = manifest
        .filter(e => !e.IsFullExtract && new Date(e.LastMdified).getTime() > asOf.getTime())
        .sort((a, b) => new Date(a.LastMdified).getTime() - new Date(b.LastMdified).getTime());
    if (applicable.length === 0 ||
        new Date(applicable[0]!.LastMdified).getTime() - asOf.getTime() > GAP_TOLERANCE_MS) {
        const behindHours = Math.round((fullTime - asOf.getTime()) / 3_600_000);
        return { kind: 'gap-exceeded', behindHours };
    }
    return { kind: 'incremental', entries: applicable };
}
```

- [ ] **Step 4: Run the existing tests to verify they pass**

Run: `npx jest tests/sync.test.ts -t 'decideSyncAction'`
Expected: 3 tests PASS.

- [ ] **Step 5: Write the failing tests (current + incremental + gap-exceeded)**

Add inside the same `describe('decideSyncAction', ...)` block:

```typescript
test('noop/current when asOf >= full.LastMdified', () => {
    const asOf = new Date('2026-05-12T21:51:36Z'); // equal
    const action = decideSyncAction(asOf, fixtureManifest(), 'auto', null, now);
    expect(action).toEqual({ kind: 'noop', reason: 'current' });
});

test('noop/current when asOf is past full.LastMdified', () => {
    const asOf = new Date('2026-05-12T22:00:00Z'); // 9m past
    const action = decideSyncAction(asOf, fixtureManifest(), 'auto', null, now);
    expect(action).toEqual({ kind: 'noop', reason: 'current' });
});

test('incremental with ascending-sorted applicable entries', () => {
    // asOf is just before the May 11 change-zip → should include May 11 and May 12.
    const asOf = new Date('2026-05-11T08:00:00Z');
    const action = decideSyncAction(asOf, fixtureManifest(), 'auto', null, now);
    expect(action.kind).toBe('incremental');
    if (action.kind !== 'incremental') throw new Error('expected incremental');
    expect(action.entries.map(e => e.DateOfChanges)).toEqual(['2026-05-11', '2026-05-12']);
});

test('gap-exceeded when asOf is older than 30 h before oldest applicable', () => {
    // asOf is 4 days before May 12 full; oldest available is May 10. Gap > 30h.
    const asOf = new Date('2026-05-08T00:00:00Z');
    const action = decideSyncAction(asOf, fixtureManifest(), 'auto', null, now);
    expect(action.kind).toBe('gap-exceeded');
    if (action.kind !== 'gap-exceeded') throw new Error('expected gap-exceeded');
    expect(action.behindHours).toBeGreaterThan(48);
});

test('gap-exceeded when no incrementals are applicable but asOf < full', () => {
    // asOf newer than every incremental but older than the full.
    // (Manifest only carries 3 most recent incrementals; older full re-published.)
    const asOf = new Date('2026-05-12T20:00:00Z');
    const noIncrementals: ExtractsManifest = [fixtureManifest()[0]!];
    const action = decideSyncAction(asOf, noIncrementals, 'auto', null, now);
    expect(action.kind).toBe('gap-exceeded');
});

test('cooldown takes precedence over forced mode', () => {
    const lastSync = new Date('2026-05-13T07:00:00Z'); // 1h ago
    const asOf = new Date('2026-05-11T00:00:00Z');
    const action = decideSyncAction(asOf, fixtureManifest(), 'full', lastSync, now);
    expect(action).toEqual({ kind: 'noop', reason: 'cooldown' });
});

test('throws if manifest has no full extract entry', () => {
    const onlyIncrementals: ExtractsManifest = fixtureManifest().slice(1);
    expect(() => decideSyncAction(null, onlyIncrementals, 'auto', null, now))
        .toThrow('Manifest has no full extract entry');
});
```

- [ ] **Step 6: Run the full decideSyncAction suite**

Run: `npx jest tests/sync.test.ts -t 'decideSyncAction'`
Expected: 10 tests PASS (3 prior + 7 new). If any fails, fix `decideSyncAction` before continuing.

- [ ] **Step 7: Commit**

```bash
git add src/sync.ts tests/sync.test.ts
git commit -m "feat(sync): Introduce decideSyncAction as the pure point of truth for sync routing."
```

---

## Task 4: `PK_BY_TABLE` + `csvToTable` + per-CSV diff applier

Internal helpers for incremental application. `applyCsvDiff` takes a parsed CSV buffer plus a target table and a live DB connection and runs the DELETE-then-INSERT transaction. `csvToTable` translates the change-zip's `device_detail.csv` (singular) into our schema's `device_details` table (plural).

**Files:**
- Modify: `src/sync.ts` (add private helpers before `applyCsvDiffZip` — added in Task 5)
- Test: `tests/sync.test.ts` (add new `describe` block)

- [ ] **Step 1: Add a sync-import-only export for testing**

We test `csvToTable` and the diff transaction through `applyCsvDiffZip` (Task 5) using a real in-memory DB; no internal export is necessary. The internal helpers stay private.

- [ ] **Step 2: Implement `PK_BY_TABLE` and `csvToTable` (no test yet — exercised by Task 5)**

Add to `src/sync.ts`, after `decideSyncAction`:

```typescript
// ── CSV-diff incremental application ─────────────────────────────────────────

/**
 * Single-column primary keys for the tables we materialise. ACMA's full extract
 * does not declare PKs and the schema does not enforce them; we use these to
 * key the DELETE step of incremental application.
 */
const PK_BY_TABLE: Record<string, string> = {
    client: 'CLIENT_NO',
    licence: 'LICENCE_NO',
    site: 'SITE_ID',
    device_details: 'SDD_ID',
    antenna: 'ANTENNA_ID',
};

/**
 * Translates a change-zip CSV basename to a schema table name. ACMA's daily
 * change-zip names device data `device_detail.csv` (singular) while the full
 * extract names it `device_details.csv` (plural). Likely an ACMA-side bug; we
 * handle both here so the diff applier sees a single canonical table name.
 */
function csvToTable(csvBasename: string): string {
    const stem = csvBasename.replace(/\.csv$/i, '');
    return stem === 'device_detail' ? 'device_details' : stem;
}
```

- [ ] **Step 3: No commit yet — bundled with Task 5.**

---

## Task 5: `applyCsvDiffZip` — apply a single daily change-zip

Reads a downloaded change-zip, iterates its CSV entries, and applies each one to the SQLite DB using DELETE-then-INSERT for Added/Updated rows and a plain DELETE for Deleted rows. Skips CSVs whose table is not in our materialised schema.

**Files:**
- Modify: `src/sync.ts` (add `applyCsvDiffZip` and inner `applyCsvDiff`)
- Test: `tests/sync.test.ts` (add new `describe` block)

- [ ] **Step 1: Write the failing tests**

Add to `tests/sync.test.ts`:

```typescript
import { applyCsvDiffZip } from '../src/sync';

describe('applyCsvDiffZip', () => {
    const scratchDir = path.join(__dirname, '../scratch_test_csv_diff');
    const dbPath = path.join(scratchDir, 'test_acma.db');
    const zipPath = path.join(scratchDir, 'change.zip');

    beforeEach(() => {
        if (!fs.existsSync(scratchDir)) fs.mkdirSync(scratchDir);
        if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
        initializeDatabase(dbPath);
    });

    afterAll(() => {
        if (fs.existsSync(scratchDir)) fs.rmSync(scratchDir, { recursive: true, force: true });
    });

    function buildChangeZip(files: Record<string, string>): void {
        const zip = new AdmZip();
        for (const [name, content] of Object.entries(files)) {
            zip.addFile(name, Buffer.from(content, 'utf-8'));
        }
        zip.writeZip(zipPath);
    }

    test('Added rows are inserted, Updated rows replace, Deleted rows are removed', async () => {
        // Seed the client table with two existing rows.
        const seedDb = new Database(dbPath);
        seedDb.prepare("INSERT INTO client (CLIENT_NO, LICENCEE) VALUES (1, 'Old Name')").run();
        seedDb.prepare("INSERT INTO client (CLIENT_NO, LICENCEE) VALUES (2, 'Doomed')").run();
        seedDb.close();

        // Change zip: add #3, update #1, delete #2.
        buildChangeZip({
            'client.csv':
                'CLIENT_NO,LICENCEE,TRADING_NAME,ACN,ABN,POSTAL_STREET,POSTAL_SUBURB,POSTAL_STATE,POSTAL_POSTCODE,CAT_ID,CLIENT_TYPE_ID,FEE_STATUS_ID,CHANGE\n' +
                '3,New Corp,,,,,,,,,,,Added\n' +
                '1,Updated Name,,,,,,,,,,,Updated\n' +
                '2,,,,,,,,,,,,Deleted\n',
        });

        await applyCsvDiffZip(zipPath, dbPath);

        const db = new Database(dbPath);
        const rows = db.prepare('SELECT CLIENT_NO, LICENCEE FROM client ORDER BY CLIENT_NO').all() as any[];
        db.close();
        expect(rows).toEqual([
            { CLIENT_NO: 1, LICENCEE: 'Updated Name' },
            { CLIENT_NO: 3, LICENCEE: 'New Corp' },
        ]);
    });

    test('device_detail.csv (singular) is applied to device_details table (plural)', async () => {
        // 55-column header: 54 schema cols + CHANGE.
        const header = [
            'SDD_ID','LICENCE_NO','DEVICE_REGISTRATION_IDENTIFIER','FORMER_DEVICE_IDENTIFIER',
            'AUTHORISATION_DATE','CERTIFICATION_METHOD','GROUP_FLAG','SITE_RADIUS','FREQUENCY',
            'BANDWIDTH','CARRIER_FREQ','EMISSION','DEVICE_TYPE','TRANSMITTER_POWER',
            'TRANSMITTER_POWER_UNIT','SITE_ID','ANTENNA_ID','POLARISATION','AZIMUTH','HEIGHT',
            'TILT','FEEDER_LOSS','LEVEL_OF_PROTECTION','EIRP','EIRP_UNIT','SV_ID','SS_ID',
            'EFL_ID','EFL_FREQ_IDENT','EFL_SYSTEM','LEQD_MODE','RECEIVER_THRESHOLD',
            'AREA_AREA_ID','CALL_SIGN','AREA_DESCRIPTION','AP_ID','CLASS_OF_STATION_CODE',
            'SUPPLIMENTAL_FLAG','EQ_FREQ_RANGE_MIN','EQ_FREQ_RANGE_MAX','NATURE_OF_SERVICE_ID',
            'HOURS_OF_OPERATION','SA_ID','RELATED_EFL_ID','EQP_ID','ANTENNA_MULTI_MODE',
            'POWER_IND','LPON_CENTER_LONGITUDE','LPON_CENTER_LATITUDE','TCS_ID','TECH_SPEC_ID',
            'DROPTHROUGH_ID','STATION_TYPE','STATION_NAME','CHANGE',
        ];
        // SDD_ID=999, LICENCE_NO='L1', 52 empty cols, CHANGE='Added' → 55 fields.
        const row = ['999', 'L1', ...new Array(52).fill(''), 'Added'];
        buildChangeZip({
            'device_detail.csv': header.join(',') + '\n' + row.join(',') + '\n',
        });

        await applyCsvDiffZip(zipPath, dbPath);

        const db = new Database(dbPath);
        const got = db.prepare('SELECT SDD_ID, LICENCE_NO FROM device_details WHERE SDD_ID = 999').get() as any;
        db.close();
        expect(got).toEqual({ SDD_ID: 999, LICENCE_NO: 'L1' });
    });

    test('CSVs for tables not in our schema are skipped silently', async () => {
        // applic_text_block is in the change zip but not in our schema.
        buildChangeZip({
            'applic_text_block.csv':
                'APTB_ID,APTB_TABLE_PREFIX,APTB_TABLE_ID,LICENCE_NO,APTB_DESCRIPTION,APTB_CATEGORY,APTB_TEXT,APTB_ITEM,CHANGE\n' +
                '12345,,,,,,,,Deleted\n',
        });
        // Should not throw.
        await expect(applyCsvDiffZip(zipPath, dbPath)).resolves.toBeUndefined();
    });

    test('header-only CSV (no row changes) is a no-op', async () => {
        // Insert a row, then apply a change-zip whose client.csv has only a header.
        const seedDb = new Database(dbPath);
        seedDb.prepare("INSERT INTO client (CLIENT_NO, LICENCEE) VALUES (42, 'Survivor')").run();
        seedDb.close();

        buildChangeZip({
            'client.csv':
                'CLIENT_NO,LICENCEE,TRADING_NAME,ACN,ABN,POSTAL_STREET,POSTAL_SUBURB,POSTAL_STATE,POSTAL_POSTCODE,CAT_ID,CLIENT_TYPE_ID,FEE_STATUS_ID,CHANGE\n',
        });
        await applyCsvDiffZip(zipPath, dbPath);

        const db = new Database(dbPath);
        const count = (db.prepare('SELECT COUNT(*) AS n FROM client').get() as any).n;
        db.close();
        expect(count).toBe(1);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest tests/sync.test.ts -t 'applyCsvDiffZip'`
Expected: 4 tests FAIL with `applyCsvDiffZip is not a function`.

- [ ] **Step 3: Implement `applyCsvDiffZip` and inner `applyCsvDiff`**

Add to `src/sync.ts`, after the `csvToTable` helper added in Task 4. Also add the new import at the top of the file:

```typescript
// At the top of src/sync.ts, alongside the existing csv-parse import:
import { parse as parseCsvSync } from 'csv-parse/sync';
```

Then add the new functions:

```typescript
/**
 * Applies a single daily change-zip to the SQLite database. The zip is the
 * payload of one https://cdn.acma.gov.au/rrl/changes/spectra_rrl-changes-*.zip
 * file. Each CSV in the zip carries the table's columns plus a trailing
 * CHANGE column; rows are Added / Updated / Deleted.
 */
export async function applyCsvDiffZip(zipPath: string, dbPath: string): Promise<void> {
    const zip = new AdmZip(zipPath);
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    try {
        for (const entry of zip.getEntries()) {
            if (entry.isDirectory) continue;
            const baseName = path.basename(entry.entryName);
            if (!baseName.toLowerCase().endsWith('.csv')) continue;
            const tableName = csvToTable(baseName);
            if (!(tableName in PK_BY_TABLE)) continue;   // skip non-materialised tables
            applyCsvDiff(entry.getData(), tableName, db);
        }
    } finally {
        db.close();
    }
}

/**
 * Applies one CSV diff (the contents of one entry in a change-zip) to the
 * named table. DELETE-then-INSERT for Added/Updated; DELETE for Deleted.
 * Idempotent under repeated application, which protects us against replays.
 */
function applyCsvDiff(csvBuffer: Buffer, tableName: string, db: Database.Database): void {
    const rows: Record<string, string>[] = parseCsvSync(csvBuffer, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
    });
    if (rows.length === 0) return;     // header-only CSV

    const columns = Object.keys(rows[0]!);
    if (!columns.includes('CHANGE')) {
        throw new Error(`Expected CHANGE column in ${tableName} change-zip`);
    }
    const pk = PK_BY_TABLE[tableName]!;
    const dataCols = columns.filter(c => c !== 'CHANGE');
    const placeholders = dataCols.map(() => '?').join(',');
    const insertStmt = db.prepare(
        `INSERT INTO ${tableName} (${dataCols.join(',')}) VALUES (${placeholders})`
    );
    const deleteStmt = db.prepare(`DELETE FROM ${tableName} WHERE ${pk} = ?`);

    const apply = db.transaction(() => {
        for (const row of rows) {
            const change = row.CHANGE;
            const pkValue = row[pk];
            if (change === 'Deleted') {
                deleteStmt.run(pkValue);
            } else if (change === 'Added' || change === 'Updated') {
                deleteStmt.run(pkValue);
                const values = dataCols.map(c => row[c] === '' ? null : row[c]);
                insertStmt.run(...values);
            } else {
                console.warn(`Unknown CHANGE='${change}' in ${tableName}; skipping row pk=${pkValue}`);
            }
        }
    });
    apply();
}
```

- [ ] **Step 4: Run the applyCsvDiffZip test suite**

Run: `npx jest tests/sync.test.ts -t 'applyCsvDiffZip'`
Expected: 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sync.ts tests/sync.test.ts
git commit -m "feat(sync): Add applyCsvDiffZip for ACMA daily CSV-diff change-zips."
```

---

## Task 6: New `SyncConfig` + `DEFAULT_CONFIG` + extended `SyncStatus`

Replace the 3-URL legacy config with a single manifest URL; extend the reason/mode enums; add the three freshness fields. This task does not yet wire `sync()` to use them — that's Task 8. We're staging the type changes here so subsequent tasks compile cleanly.

**Files:**
- Modify: `src/sync.ts` (replace `SyncConfig`, `DEFAULT_CONFIG`, `SyncReason`, `SyncMode`, `SyncStatus`)

- [ ] **Step 1: No new tests — type-only change exercised by later tasks.**

- [ ] **Step 2: Update `SyncConfig`, `DEFAULT_CONFIG`, `SyncReason`, `SyncMode`, `SyncStatus`**

In `src/sync.ts`, replace the block at lines 10-59 (the existing `SyncConfig`, `DEFAULT_CONFIG`, `SyncMode`, `SyncReason`, `SyncStatus`) with the following. Note `SyncMode` was already added by Task 3 — confirm it's present and remove any duplicate definition.

```typescript
export interface SyncConfig {
    extractsUrl: string;
    dataDir: string;
    dbPath: string;
}

export const DEFAULT_CONFIG: SyncConfig = {
    extractsUrl: 'https://backend.acma.gov.au/rrl/v1/Extracts',
    dataDir: './data',
    dbPath: './data/acma.db',
};

// SyncMode is defined in Task 3 alongside SyncAction.

/**
 * The reason for the most recent sync decision. Outcome reasons are set at
 * the end of an attempt; decision reasons (`cooldown`, `current`,
 * `gap-exceeded`, etc.) are set when sync() routes a request.
 */
export type SyncReason =
    | 'cooldown'
    | 'current'
    | 'manifest-fetch-failed'
    | 'no-db'
    | 'gap-exceeded'
    | 'forced'
    | 'incremental-success'
    | 'incremental-failed'
    | 'full-success'
    | 'full-failed';

export interface SyncStatus {
    isSyncing: boolean;
    progress: number; // 0-100
    currentTable?: string;
    lastError?: string;
    /** Executed mode, or 'auto' when no execution occurred (noop / gap-exceeded). */
    mode?: SyncMode | 'incremental';
    /** Reason / outcome of the most recent decision. */
    reason?: SyncReason;
    /** ISO-8601 timestamp of the most recent decision. */
    lastDecisionAt?: string;
    /** Free-form context for the decision (e.g. "3 change-zips applied"). */
    detail?: string;
    /** "How fresh is the data?" — mirror of meta.as_of in ISO 8601. */
    dataAsOf?: string;
    /** "When did our pipeline last successfully run?" — mirror of meta.last_sync. */
    lastSyncAt?: string;
    /** "What is upstream's latest data?" — last seen manifest full.LastMdified. */
    remoteAsOf?: string;
    /** Derived: (remoteAsOf - dataAsOf) rounded to hours; 0 when current. */
    behindByHours?: number;
}

let currentSyncStatus: SyncStatus = {
    isSyncing: false,
    progress: 0,
};

export function getSyncStatus(): SyncStatus {
    return { ...currentSyncStatus };
}
```

- [ ] **Step 3: Update `recordDecision` to accept the broadened mode type**

Find the existing `recordDecision` helper (around lines 70-82). Replace with:

```typescript
function recordDecision(
    reason: SyncReason,
    mode: SyncStatus['mode'] | undefined,
    detail?: string
): void {
    currentSyncStatus = {
        ...currentSyncStatus,
        reason,
        lastDecisionAt: new Date().toISOString(),
        ...(mode !== undefined ? { mode } : {}),
        ...(detail !== undefined ? { detail } : {}),
    };
}
```

- [ ] **Step 4: Run the full test suite to confirm nothing is broken**

Run: `npx jest`
Expected: all tests currently passing continue to pass. Tests for `applyIncrementalUpdate` and `shouldDoFullSync` still pass at this point — they are deleted in Task 10.

If TypeScript errors appear in `sync()` or `performFullSync()` (e.g. references to removed `datasetUrl` / `timestampUrl` / `incrementalUrl`), they are expected and resolved by Tasks 7 and 8. As long as the type definitions compile in isolation, you can proceed.

If the test run does not compile because of removed field references, temporarily comment out the offending lines in `sync()` and `performFullSync()` — they are rewritten in Tasks 7 and 8.

- [ ] **Step 5: Commit**

```bash
git add src/sync.ts
git commit -m "refactor(sync): Adopt manifest-driven SyncConfig and extend SyncStatus with freshness fields."
```

---

## Task 7: Rewrite `performFullSync` to take an `ExtractEntry`

`performFullSync` no longer dereferences `config.datasetUrl` and `config.timestampUrl`. Instead it accepts the full `ExtractEntry` from the manifest, downloads the zip pointed at by `pickSpectraRrl(entry.Items).FileUrl`, and records `meta.as_of = entry.LastMdified`. The `inputs/spectra_rrl.zip` shortcut path is preserved.

**Files:**
- Modify: `src/sync.ts` (rewrite `performFullSync` body)
- Test: `tests/sync.test.ts` (no new test — covered by Task 8 end-to-end test, and the existing `extractZip` / `importCsv` tests still apply)

- [ ] **Step 1: Rewrite `performFullSync`**

Replace the existing `performFullSync` function (around lines 100-191) with:

```typescript
/**
 * Performs a full synchronization: download, extract, and import all data.
 * Takes the full ExtractEntry from the manifest as input — the URL and the
 * authoritative as_of timestamp both come from there.
 */
export async function performFullSync(config: SyncConfig, fullEntry: ExtractEntry): Promise<void> {
    if (currentSyncStatus.isSyncing) {
        throw new Error('Synchronization already in progress');
    }

    const spectra = pickSpectraRrl(fullEntry.Items);
    if (!spectra) {
        throw new Error('Full extract entry has no spectra_rrl item');
    }

    // Reset transient run state but preserve decision metadata.
    const { currentTable: _ct, lastError: _le, ...preserved } = currentSyncStatus;
    void _ct; void _le;
    currentSyncStatus = { ...preserved, isSyncing: true, progress: 0 };

    try {
        if (!fs.existsSync(config.dataDir)) {
            fs.mkdirSync(config.dataDir, { recursive: true });
        }

        const zipPathFromInput = path.resolve('inputs/spectra_rrl.zip');
        const zipPath = path.join(config.dataDir, 'spectra_rrl.zip');

        currentSyncStatus.progress = 5;

        const remoteTimestamp = new Date(fullEntry.LastMdified);
        const inputZipExists = fs.existsSync(zipPathFromInput);
        const inputZipStale = inputZipExists && isInputZipStale(zipPathFromInput, remoteTimestamp);

        if (inputZipExists && !inputZipStale) {
            console.log('Using local dataset from inputs/');
            fs.copyFileSync(zipPathFromInput, zipPath);
        } else {
            if (inputZipStale) {
                const mtime = fs.statSync(zipPathFromInput).mtime.toISOString();
                console.log(`[SYNC] Input zip mtime=${mtime} is older than remote=${remoteTimestamp.toISOString()}; ignoring stale input.`);
            }
            console.log(`Downloading full dataset from ${spectra.FileUrl}...`);
            await downloadFile(spectra.FileUrl, zipPath);
        }

        currentSyncStatus.progress = 20;

        console.log('Extracting ZIP...');
        const extractDir = path.join(config.dataDir, 'extracted');
        if (!fs.existsSync(extractDir)) fs.mkdirSync(extractDir, { recursive: true });
        const files = await extractZip(zipPath, extractDir);

        currentSyncStatus.progress = 30;

        console.log('Initializing database...');
        initializeDatabase(config.dbPath);

        const tablesToImport = files.filter(file => {
            const fileName = path.basename(file);
            const targetTable = fileName.split('.')[0]!;
            return Object.keys(TABLE_METADATA).includes(targetTable);
        });

        for (let i = 0; i < tablesToImport.length; i++) {
            const file = tablesToImport[i]!;
            const fileName = path.basename(file);
            const targetTable = fileName.split('.')[0]!;

            currentSyncStatus.currentTable = targetTable;
            const tableProgressBase = 30 + (i / tablesToImport.length) * 65;

            console.log(`Importing ${fileName}...`);
            await importCsv(file, config.dbPath, targetTable, (p) => {
                currentSyncStatus.progress = Math.round(
                    tableProgressBase + (p / tablesToImport.length) * (65 / 100)
                );
            });
        }

        const db = new Database(config.dbPath);
        db.prepare('REPLACE INTO meta (key, value) VALUES (?, ?)').run('as_of', fullEntry.LastMdified);
        db.prepare('REPLACE INTO meta (key, value) VALUES (?, ?)').run('last_sync', new Date().toISOString());
        db.close();

        currentSyncStatus.progress = 100;
        console.log('Full sync complete.');
    } catch (error: any) {
        currentSyncStatus.lastError = error.message;
        throw error;
    } finally {
        currentSyncStatus.isSyncing = false;
    }
}
```

- [ ] **Step 2: Run the full test suite**

Run: `npx jest`
Expected: existing pure-function tests still pass. Compile errors are expected only inside `sync()` (rewired in Task 8); if you commented out `sync()` lines in Task 6, leave them commented for now.

- [ ] **Step 3: Commit**

```bash
git add src/sync.ts
git commit -m "refactor(sync): performFullSync takes an ExtractEntry instead of legacy config URLs."
```

---

## Task 8: Rewrite the `sync()` orchestrator

Replaces the legacy sync flow with the manifest-driven decision tree from the spec. Uses `decideSyncAction` and applies the action via either `performFullSync` or a loop of `applyCsvDiffZip` calls.

**Files:**
- Modify: `src/sync.ts` (replace `sync()` body and remove dead helpers / unused imports)
- Test: `tests/sync.test.ts` (add new `describe` block)

- [ ] **Step 1: Write a failing end-to-end test for the noop/current path**

The orchestrator test mocks axios so no network is hit. Add to `tests/sync.test.ts`:

```typescript
import { sync, DEFAULT_CONFIG } from '../src/sync';

describe('sync() orchestrator (mocked axios)', () => {
    const scratchDir = path.join(__dirname, '../scratch_test_orchestrator');
    const dbPath = path.join(scratchDir, 'test_acma.db');
    const dataDir = scratchDir;
    const cfg = { extractsUrl: 'https://example/v1/Extracts', dataDir, dbPath };

    beforeEach(() => {
        if (!fs.existsSync(scratchDir)) fs.mkdirSync(scratchDir);
        if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
        jest.resetAllMocks();
    });

    afterAll(() => {
        if (fs.existsSync(scratchDir)) fs.rmSync(scratchDir, { recursive: true, force: true });
    });

    const manifestWithCurrentAsOf = (asOf: string): ExtractsManifest => ([
        {
            IsFullExtract: true,
            LastMdified: asOf,
            Items: [{
                Description: 'Spectra dataset', Format: 'CSV', FileSize: 0,
                FileName: 'spectra_rrl.zip',
                FileUrl: 'https://cdn.example/spectra_rrl.zip',
            }],
        },
    ]);

    test('noop/current — DB already at remote as_of, no fetch happens', async () => {
        // Seed an existing DB with meta.as_of equal to the manifest.
        initializeDatabase(dbPath);
        const seed = new Database(dbPath);
        seed.prepare("REPLACE INTO meta (key, value) VALUES ('as_of', '2026-05-12T21:51:36Z')").run();
        seed.close();

        mockedAxios.get.mockResolvedValueOnce({
            data: manifestWithCurrentAsOf('2026-05-12T21:51:36Z'),
        });

        await sync(cfg, 'auto');

        const status = getSyncStatus();
        expect(status.reason).toBe('current');
        expect(status.dataAsOf).toBe('2026-05-12T21:51:36Z');
        expect(status.remoteAsOf).toBe('2026-05-12T21:51:36Z');
        expect(status.behindByHours).toBe(0);
        // The only axios call should have been the manifest fetch.
        expect(mockedAxios.get).toHaveBeenCalledTimes(1);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/sync.test.ts -t 'sync\\(\\) orchestrator'`
Expected: test FAILS (sync() either throws, hits old code paths, or asserts about uninitialised SyncStatus freshness fields).

- [ ] **Step 3: Rewrite `sync()`**

Replace the entire body of `sync()` (around lines 219-325) with:

```typescript
/**
 * Orchestrates the sync process using the ACMA /v1/Extracts manifest as the
 * source of truth. Never auto-pulls the full 70 MB extract on `mode='auto'` —
 * caller must pass `mode='full'` (typically via the MCP sync_data tool) to
 * force a full re-download when the DB is too far behind the manifest window.
 */
export async function sync(
    config: SyncConfig = DEFAULT_CONFIG,
    mode: SyncMode = 'auto',
): Promise<void> {
    const lastSync = getLastSyncTime(config.dbPath);

    // 1. Fetch manifest.
    let manifest: ExtractsManifest;
    try {
        manifest = await fetchExtractsManifest(config.extractsUrl);
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error('[SYNC] Could not fetch /v1/Extracts manifest; aborting sync.', e);
        recordDecision('manifest-fetch-failed', undefined, msg);
        return;
    }

    const fullEntry = manifest.find(e => e.IsFullExtract);
    if (!fullEntry) {
        console.error('[SYNC] Manifest has no full extract entry; aborting.');
        recordDecision('manifest-fetch-failed', undefined, 'no full entry in manifest');
        return;
    }

    // 2. Read local as_of.
    const asOf = getDbAsOf(config.dbPath);

    // 3. Update freshness fields visible to MCP consumers.
    updateFreshnessStatus(asOf, fullEntry, getDbLastSync(config.dbPath));

    // 4. Decide.
    const action = decideSyncAction(asOf, manifest, mode, lastSync, new Date());

    // 5. Execute.
    switch (action.kind) {
        case 'noop':
            recordDecision(action.reason, undefined);
            return;

        case 'gap-exceeded': {
            const detail = `${action.behindHours}h behind manifest window — run sync_data mode=full to recover`;
            console.warn(`[SYNC] ${detail}`);
            recordDecision('gap-exceeded', undefined, detail);
            return;
        }

        case 'full': {
            try {
                await performFullSync(config, action.entry);
                refreshFreshnessAfter(config.dbPath, action.entry.LastMdified, fullEntry);
                recordDecision(
                    action.reason === 'bootstrap' ? 'no-db' : 'forced',
                    'full',
                    `as-of ${action.entry.LastMdified}`,
                );
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                recordDecision('full-failed', 'full', msg);
                throw e;
            }
            return;
        }

        case 'incremental': {
            try {
                if (!fs.existsSync(config.dataDir)) {
                    fs.mkdirSync(config.dataDir, { recursive: true });
                }
                const changesDir = path.join(config.dataDir, 'changes');
                if (!fs.existsSync(changesDir)) fs.mkdirSync(changesDir, { recursive: true });

                for (const entry of action.entries) {
                    const item = pickSpectraRrl(entry.Items);
                    if (!item) {
                        throw new Error(`Incremental entry for ${entry.DateOfChanges} has no spectra_rrl item`);
                    }
                    const zipPath = path.join(changesDir, item.FileName);
                    console.log(`Downloading ${item.FileUrl}...`);
                    await downloadFile(item.FileUrl, zipPath);
                    console.log(`Applying ${item.FileName}...`);
                    await applyCsvDiffZip(zipPath, config.dbPath);
                }

                const newAsOf = action.entries.at(-1)!.LastMdified;
                const db = new Database(config.dbPath);
                db.prepare('REPLACE INTO meta (key, value) VALUES (?, ?)').run('as_of', newAsOf);
                db.prepare('REPLACE INTO meta (key, value) VALUES (?, ?)').run('last_sync', new Date().toISOString());
                db.close();

                refreshFreshnessAfter(config.dbPath, newAsOf, fullEntry);
                recordDecision(
                    'incremental-success',
                    'incremental',
                    `${action.entries.length} change-zip(s) applied; as-of ${newAsOf}`,
                );
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                console.error('[SYNC] Incremental sync failed.', e);
                recordDecision('incremental-failed', 'incremental', msg);
            }
            return;
        }
    }
}

// ── DB freshness helpers ─────────────────────────────────────────────────────

function getLastSyncTime(dbPath: string): Date | null {
    return getDbLastSync(dbPath);
}

function getDbAsOf(dbPath: string): Date | null {
    if (!fs.existsSync(dbPath)) return null;
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
        const row = db.prepare("SELECT value FROM meta WHERE key = 'as_of'").get() as { value: string } | undefined;
        return row ? parseRemoteTimestamp(row.value) : null;
    } finally {
        if (db.open) db.close();
    }
}

function getDbLastSync(dbPath: string): Date | null {
    if (!fs.existsSync(dbPath)) return null;
    try {
        const db = new Database(dbPath, { readonly: true, fileMustExist: true });
        try {
            const row = db.prepare("SELECT value FROM meta WHERE key = 'last_sync'").get() as { value: string } | undefined;
            return row ? new Date(row.value) : null;
        } finally {
            if (db.open) db.close();
        }
    } catch {
        return null;
    }
}

function updateFreshnessStatus(
    asOf: Date | null,
    fullEntry: ExtractEntry,
    lastSync: Date | null,
): void {
    const remoteAsOf = fullEntry.LastMdified;
    const dataAsOf = asOf?.toISOString();
    const behindByHours = asOf
        ? Math.max(0, Math.round((new Date(remoteAsOf).getTime() - asOf.getTime()) / 3_600_000))
        : undefined;
    currentSyncStatus = {
        ...currentSyncStatus,
        ...(dataAsOf !== undefined ? { dataAsOf } : {}),
        remoteAsOf,
        ...(behindByHours !== undefined ? { behindByHours } : {}),
        ...(lastSync !== null ? { lastSyncAt: lastSync.toISOString() } : {}),
    };
}

function refreshFreshnessAfter(dbPath: string, newAsOf: string, fullEntry: ExtractEntry): void {
    const asOfDate = parseRemoteTimestamp(newAsOf);
    updateFreshnessStatus(asOfDate, fullEntry, getDbLastSync(dbPath));
}
```

- [ ] **Step 4: Run the orchestrator test**

Run: `npx jest tests/sync.test.ts -t 'sync\\(\\) orchestrator'`
Expected: 1 test PASSES.

- [ ] **Step 5: Add bootstrap and incremental orchestrator tests**

Append to the same `describe('sync() orchestrator (mocked axios)', ...)` block:

```typescript
test('bootstrap — no DB; full sync triggered regardless of mode', async () => {
    // The orchestrator should call manifest, then downloadFile for the full zip.
    // We mock both, and synthesise a minimal valid zip that performFullSync can
    // extract — empty zip with no CSVs is sufficient because performFullSync
    // only imports tables whose filenames appear in TABLE_METADATA.
    const fullManifest = manifestWithCurrentAsOf('2026-05-12T21:51:36Z');
    mockedAxios.get.mockResolvedValueOnce({ data: fullManifest });

    // downloadFile uses axios with responseType: 'stream'. Stub: create a tiny
    // valid zip on disk and have axios resolve with a Readable of its bytes.
    const fakeZipPath = path.join(scratchDir, 'fake_full.zip');
    const fakeZip = new AdmZip();
    fakeZip.addFile('placeholder.txt', Buffer.from('not a csv'));
    fakeZip.writeZip(fakeZipPath);
    const fakeBytes = fs.readFileSync(fakeZipPath);
    const { Readable } = require('stream');
    mockedAxios.mockResolvedValueOnce({ data: Readable.from(fakeBytes) } as any);

    await sync(cfg, 'auto');

    const status = getSyncStatus();
    expect(status.reason).toBe('no-db');
    expect(status.mode).toBe('full');
    // DB should now exist with meta.as_of set to the manifest's LastMdified.
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare("SELECT value FROM meta WHERE key = 'as_of'").get() as any;
    db.close();
    expect(row.value).toBe('2026-05-12T21:51:36Z');
});

test('gap-exceeded — auto mode does NOT trigger full download', async () => {
    initializeDatabase(dbPath);
    const seed = new Database(dbPath);
    seed.prepare("REPLACE INTO meta (key, value) VALUES ('as_of', '2026-05-01T00:00:00Z')").run();
    seed.close();

    // Manifest with full=May 12 but no incrementals → asOf 11 days behind.
    mockedAxios.get.mockResolvedValueOnce({
        data: manifestWithCurrentAsOf('2026-05-12T21:51:36Z'),
    });

    await sync(cfg, 'auto');

    const status = getSyncStatus();
    expect(status.reason).toBe('gap-exceeded');
    expect(status.mode).toBeUndefined();
    expect(status.detail).toMatch(/h behind/);
    expect(mockedAxios.get).toHaveBeenCalledTimes(1); // ONLY the manifest call
});
```

- [ ] **Step 6: Run orchestrator tests**

Run: `npx jest tests/sync.test.ts -t 'sync\\(\\) orchestrator'`
Expected: 3 tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/sync.ts tests/sync.test.ts
git commit -m "feat(sync): Rewrite sync() orchestrator around decideSyncAction and the /v1/Extracts manifest."
```

---

## Task 9: MCP `sync_data` — accept `mode` arg and surface freshness fields

Wire the new `mode` argument through the MCP tool definition and the call handler, and extend the human-readable response with the new freshness fields when present.

**Files:**
- Modify: `src/index.ts` (tool definition around line 191; tool handler around line 366)

- [ ] **Step 1: Update the `sync_data` tool definition**

Find the entry in `src/index.ts` at line 191 (the `sync_data` tool's `inputSchema`). Replace `inputSchema: { type: 'object', properties: {} }` with:

```typescript
                inputSchema: {
                    type: 'object',
                    properties: {
                        mode: {
                            type: 'string',
                            enum: ['auto', 'full'],
                            description:
                                "'auto' (default) applies incremental change-zips only. " +
                                "'full' force-pulls and reimports the ~70 MB full extract — " +
                                "use after a long offline period or to recover from gap-exceeded.",
                        },
                    },
                },
```

Update the surrounding description string immediately above (currently `"### [Data Synchronization]\nDownload and import..."`) to:

```typescript
                description: `
### [Data Synchronization]
Download and import the latest ACMA RRL changes. Safe to call while server is running.

## Usage
- Default mode='auto' applies incremental change-zips only (cheap, mobile-friendly).
- Use mode='full' to force a full extract reimport (~70 MB) when 'gap-exceeded' is reported.
- Call once to start sync, then poll to check progress.

## Status fields
- progress: 0-100%
- currentTable: which CSV is being imported
- dataAsOf: how fresh the local data is (ISO 8601)
- remoteAsOf: latest available upstream (ISO 8601)
- behindByHours: derived staleness; 0 when current`,
```

- [ ] **Step 2: Thread `mode` through the tool handler and extend the response**

Find the `if (name === 'sync_data')` handler (around line 366). Replace the entire handler block with:

```typescript
        if (name === 'sync_data') {
            // Trigger the sync (mode defaults to 'auto'). Fire-and-forget; the
            // user polls by calling sync_data again to read getSyncStatus().
            const mode = (args as any)?.mode === 'full' ? 'full' : 'auto';
            if (!getSyncStatus().isSyncing) {
                // Kick off async; intentionally not awaited so this response is fast.
                sync(DEFAULT_CONFIG, mode).catch((e: unknown) => {
                    console.error('[MCP] sync_data background failure:', e);
                });
            }

            const status = getSyncStatus();
            const decisionLine = status.reason
                ? `Last decision: ${status.mode ? `${status.mode} sync — ` : ''}${status.reason}` +
                  (status.detail ? ` (${status.detail})` : '') +
                  (status.lastDecisionAt ? ` at ${status.lastDecisionAt}` : '')
                : null;

            const freshness: string[] = [];
            if (status.dataAsOf) freshness.push(`Data as-of: ${status.dataAsOf}`);
            if (status.remoteAsOf) freshness.push(`Remote as-of: ${status.remoteAsOf}`);
            if (status.behindByHours !== undefined) freshness.push(`Behind by: ${status.behindByHours}h`);
            if (status.lastSyncAt) freshness.push(`Last successful sync: ${status.lastSyncAt}`);

            if (status.isSyncing) {
                const lines = [
                    `Sync in progress${status.mode ? ` (${status.mode})` : ''}: ${status.progress}% — step: ${status.currentTable ?? 'Initializing'}.`,
                    'Poll sync_data again soon.',
                ];
                if (decisionLine) lines.push(decisionLine);
                if (freshness.length) lines.push(...freshness);
                return { content: [{ type: 'text', text: lines.join('\n') }] };
            }

            const lines: string[] = [];
            if (decisionLine) lines.push(decisionLine);
            if (freshness.length) lines.push(...freshness);
            if (lines.length === 0) lines.push('Sync triggered.');
            return { content: [{ type: 'text', text: lines.join('\n') }] };
        }
```

Confirm that `sync` and `DEFAULT_CONFIG` are imported at the top of `src/index.ts` (they already are — line 16).

- [ ] **Step 3: Run the entire test suite**

Run: `npx jest`
Expected: all tests pass (no test changes for `src/index.ts` — the existing test suite covers the underlying `sync()` behavior).

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat(mcp): Accept mode arg on sync_data and surface manifest-driven freshness fields."
```

---

## Task 10: Remove the legacy `applyIncrementalUpdate` and `shouldDoFullSync`

Now that `sync()` no longer references these and external consumers have been verified (only `src/sync.ts` and `tests/sync.test.ts` import them), delete them along with their tests. Also clean up the legacy URL constants in comments.

**Files:**
- Modify: `src/sync.ts` (delete `applyIncrementalUpdate`, `shouldDoFullSync`, related comments, `INCREMENTAL_WINDOW_MS`)
- Modify: `tests/sync.test.ts` (delete the `'Sync Logic - Incremental Update'` and `'shouldDoFullSync'` describe blocks, plus the now-unused `applyIncrementalUpdate` and `shouldDoFullSync` imports)

- [ ] **Step 1: Delete legacy functions and constants from `src/sync.ts`**

Remove the following from `src/sync.ts`:

1. The entire `applyIncrementalUpdate` function and its `/** ... */` docstring (was lines ~413-459).
2. The entire `shouldDoFullSync` function and its docstring (was lines ~492-503).
3. The `INCREMENTAL_WINDOW_MS` constant (was line ~493) — no longer referenced.
4. Any comment that mentions `applyIncrementalUpdate` or `-- TO:` syntax (search for `applyIncrementalUpdate`).

Verify with: `grep -nE '(applyIncrementalUpdate|shouldDoFullSync|INCREMENTAL_WINDOW_MS)' src/sync.ts` — expected: no matches.

- [ ] **Step 2: Delete the legacy tests from `tests/sync.test.ts`**

Remove:
1. `applyIncrementalUpdate` and `shouldDoFullSync` from the top-of-file import line.
2. The entire `describe('Sync Logic - Incremental Update', ...)` block (one test inside it).
3. The entire `describe('shouldDoFullSync', ...)` block (5 tests inside it).

Verify with: `grep -nE '(applyIncrementalUpdate|shouldDoFullSync)' tests/sync.test.ts` — expected: no matches.

- [ ] **Step 3: Run the entire test suite**

Run: `npx jest`
Expected: all remaining tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/sync.ts tests/sync.test.ts
git commit -m "refactor(sync): Remove legacy applyIncrementalUpdate and shouldDoFullSync (superseded by manifest-driven flow)."
```

---

## Task 11: Update README and verify

Final pass: update the user-facing data-source description to reflect the new endpoints, and run a smoke build to confirm TypeScript still compiles cleanly.

**Files:**
- Modify: `README.md` (the "Data Source & Extraction" section)

- [ ] **Step 1: Update the README data-source section**

In `README.md`, find the "## Data Source & Extraction" section (around line 70). Replace the paragraph starting "The server implementation is based on the logic..." with:

```markdown
The server implementation now consumes ACMA's `/v1/Extracts` REST endpoint
(`https://backend.acma.gov.au/rrl/v1/Extracts`) as its source of truth for
both the full dataset and daily incremental updates. The legacy
`offline-rrl` JavaScript implementation was used to reverse-engineer the
data structures and SQL query patterns; the new manifest API replaces the
legacy 3-URL pipeline (`spectra_rrl.zip` + `datetime-of-extract.txt` +
`.rrl_update` SQL diff).

Synchronisation modes (exposed via the MCP `sync_data` tool):

- **`auto`** (default): fetches the manifest and applies any daily
  CSV-diff change-zips strictly newer than the local `meta.as_of`. Never
  pulls the full 70 MB extract on its own — safe to call from mobile or
  metered networks.
- **`full`**: force-downloads and reimports `spectra_rrl.zip`. Use this
  on first install or when `sync_data` reports `gap-exceeded` (the local
  DB is older than the manifest's ~3-day incremental window).
```

- [ ] **Step 2: TypeScript build check**

Run: `npm run build`
Expected: exit code 0, no errors. If there are unused-import warnings related to deleted helpers, remove the imports from the top of `src/sync.ts` (likely none — the imports we use are still used).

- [ ] **Step 3: Full test suite**

Run: `npm test`
Expected: all tests pass (manifest fetch + parseRemoteTimestamp + decideSyncAction + applyCsvDiffZip + sync() orchestrator + existing extractZip/importCsv/parseRemoteTimestamp/isInputZipStale).

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: Update data-source section for ACMA /v1/Extracts manifest migration."
```

---

## Self-Review

**Spec coverage:**
- [x] §1 New API surface (`SyncConfig`, `SyncMode`, `sync()` signature, `sync_data` mode arg) — Tasks 6, 8, 9
- [x] §2 Manifest types + helpers (`fetchExtractsManifest`, `pickSpectraRrl`, ISO 8601 in `parseRemoteTimestamp`) — Tasks 1, 2
- [x] §3 CSV-diff application (`applyCsvDiffZip`, `PK_BY_TABLE`, `device_detail` alias) — Tasks 4, 5
- [x] §4 Orchestrator (`decideSyncAction`, `sync()` rewrite, mobile-friendly gap-exceeded policy) — Tasks 3, 8
- [x] §5 Testing matrix — covered across Tasks 1, 2, 3, 5, 8
- [x] §6 Removals (`applyIncrementalUpdate`, `shouldDoFullSync`, legacy URL fields) — Tasks 6, 10
- [x] Points of truth: `meta.as_of`, `meta.last_sync`, manifest `LastMdified`, three new `SyncStatus` fields — Tasks 6, 8

**Placeholder scan:** No TBDs, no "add appropriate error handling", no "similar to Task N", no test-without-code steps. Every code block is concrete.

**Type consistency:** `SyncMode` is defined once (Task 3); `SyncStatus.mode` is broader (`SyncMode | 'incremental'`) to accommodate the orchestrator's reporting; `SyncAction` is the single discriminated-union return shape from `decideSyncAction`; `ExtractEntry` flows from `fetchExtractsManifest` → `decideSyncAction` → `performFullSync`/`sync()` unchanged.

**Notes for the executing agent:**
- Tests assume `jest.mock('axios')` is hoisted (top-of-file). The mock is declared once in Task 1 and reused across subsequent tasks; do not re-declare.
- `tests/sync.test.ts` ends up importing several new exports (`fetchExtractsManifest`, `pickSpectraRrl`, `decideSyncAction`, `applyCsvDiffZip`, `sync`, `DEFAULT_CONFIG`) and types (`ExtractItem`, `ExtractsManifest`, `SyncAction`). Add these incrementally as each task is completed; the final import line at the top of the test file should consolidate them.
- The `inputs/spectra_rrl.zip` shortcut path is preserved in Task 7. Existing dev workflows that drop a fresh zip into `inputs/` to bypass the network continue to work as long as the file's mtime ≥ the manifest's full `LastMdified`.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-13-sync-migration.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
