# Sync Staleness Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `sync()` automatically detect when the local dataset is too stale for incremental updates and fall back to a full download from ACMA, including ignoring an out-of-date `inputs/spectra_rrl.zip`.

**Architecture:** Three pure helpers in `src/sync.ts` carry the decision logic — timestamp parsing, input-zip staleness, and DB-age gap. `sync()` and `performFullSync()` are minimally rewired to call them at the right points. Decisions are unit-tested via the helpers; orchestration code remains straight-line wiring.

**Tech Stack:** TypeScript, Jest (ts-jest ESM preset), better-sqlite3, axios, adm-zip, Node `fs`.

**Spec:** `docs/superpowers/specs/2026-04-28-sync-staleness-detection-design.md`

---

## File Structure

**Modify:**
- `src/sync.ts` — add three helpers; rewire `sync()` and `performFullSync()`.
- `tests/sync.test.ts` — add unit tests for the three helpers.

No new files. The helpers live alongside the existing sync code because they're tightly coupled to its contract and small enough that a separate module would just add ceremony.

---

### Task 1: `parseRemoteTimestamp` helper

Parses ACMA's `datetime-of-extract.txt` payload (format `YYYY-MM-DD HH:MM:SS`). Returns `null` on any parse failure. Interprets the timestamp as UTC — comparisons stay consistent because both sides of any comparison flow through this same parser.

**Files:**
- Modify: `src/sync.ts` (add export at end of file)
- Test: `tests/sync.test.ts` (add new `describe` block)

- [ ] **Step 1: Write the failing tests**

Add this `describe` block to the end of `tests/sync.test.ts`:

```typescript
import { parseRemoteTimestamp } from '../src/sync';

describe('parseRemoteTimestamp', () => {
    test('parses well-formed ACMA timestamp as UTC', () => {
        const d = parseRemoteTimestamp('2026-03-05 06:00:00');
        expect(d).not.toBeNull();
        expect(d!.toISOString()).toBe('2026-03-05T06:00:00.000Z');
    });

    test('tolerates surrounding whitespace and trailing newline', () => {
        const d = parseRemoteTimestamp('  2026-03-05 06:00:00\n');
        expect(d).not.toBeNull();
        expect(d!.toISOString()).toBe('2026-03-05T06:00:00.000Z');
    });

    test('returns null on malformed input', () => {
        expect(parseRemoteTimestamp('not a date')).toBeNull();
        expect(parseRemoteTimestamp('2026/03/05 06:00:00')).toBeNull();
        expect(parseRemoteTimestamp('2026-03-05T06:00:00Z')).toBeNull();
    });

    test('returns null on empty string', () => {
        expect(parseRemoteTimestamp('')).toBeNull();
    });
});
```

Note: the existing top-of-file imports already cover everything else. Add `parseRemoteTimestamp` to the existing import line `import { extractZip, importCsv, applyIncrementalUpdate } from '../src/sync';` instead of adding a separate import — final line should read:

```typescript
import { extractZip, importCsv, applyIncrementalUpdate, parseRemoteTimestamp } from '../src/sync';
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/sync.test.ts`
Expected: TypeScript / runtime error indicating `parseRemoteTimestamp` is not exported / not defined.

- [ ] **Step 3: Implement the helper**

Append to `src/sync.ts` (after `applyIncrementalUpdate`, at end of file):

```typescript
/**
 * Parses ACMA's `datetime-of-extract.txt` payload (`YYYY-MM-DD HH:MM:SS`).
 * Treated as UTC so comparisons against other parsed timestamps stay consistent.
 * Returns null on any parse failure — callers fall back to existing behaviour.
 */
export function parseRemoteTimestamp(s: string): Date | null {
    const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(s.trim());
    if (!match) return null;
    const iso = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`;
    const d = new Date(iso);
    return isNaN(d.getTime()) ? null : d;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/sync.test.ts`
Expected: All four `parseRemoteTimestamp` tests PASS. Existing tests still PASS.

- [ ] **Step 5: Commit**

```bash
git -c user.name="Sage Grigull" -c user.email="ciphernaut@proton.me" \
  add src/sync.ts tests/sync.test.ts
git -c user.name="Sage Grigull" -c user.email="ciphernaut@proton.me" \
  commit -m "feat(sync): Add parseRemoteTimestamp helper for ACMA datetime payload."
```

---

### Task 2: `isInputZipStale` helper

Returns `true` iff the file at `zipPath` exists AND its mtime is earlier than `remoteTimestamp`. Returns `false` if the file is missing — caller decides whether that means "download" or "error".

**Files:**
- Modify: `src/sync.ts` (add export at end of file)
- Test: `tests/sync.test.ts`

- [ ] **Step 1: Write the failing tests**

Add this `describe` block to the end of `tests/sync.test.ts`. Update the existing import line to also include `isInputZipStale`:

```typescript
// Update existing import:
import { extractZip, importCsv, applyIncrementalUpdate, parseRemoteTimestamp, isInputZipStale } from '../src/sync';

describe('isInputZipStale', () => {
    const scratchDir = path.join(__dirname, '../scratch_test_stale');
    const zipPath = path.join(scratchDir, 'sample.zip');

    beforeEach(() => {
        if (!fs.existsSync(scratchDir)) fs.mkdirSync(scratchDir);
        fs.writeFileSync(zipPath, 'placeholder');
    });

    afterAll(() => {
        if (fs.existsSync(scratchDir)) fs.rmSync(scratchDir, { recursive: true, force: true });
    });

    test('returns false when zip is missing', () => {
        const remote = new Date('2026-03-05T06:00:00Z');
        expect(isInputZipStale(path.join(scratchDir, 'does-not-exist.zip'), remote)).toBe(false);
    });

    test('returns true when zip mtime is older than remote timestamp', () => {
        const oldTime = new Date('2025-01-01T00:00:00Z');
        fs.utimesSync(zipPath, oldTime, oldTime);
        const remote = new Date('2026-03-05T06:00:00Z');
        expect(isInputZipStale(zipPath, remote)).toBe(true);
    });

    test('returns false when zip mtime is newer than remote timestamp', () => {
        const newTime = new Date('2026-04-01T00:00:00Z');
        fs.utimesSync(zipPath, newTime, newTime);
        const remote = new Date('2026-03-05T06:00:00Z');
        expect(isInputZipStale(zipPath, remote)).toBe(false);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/sync.test.ts`
Expected: TypeScript / runtime error indicating `isInputZipStale` is not exported.

- [ ] **Step 3: Implement the helper**

Append to `src/sync.ts` (after `parseRemoteTimestamp`):

```typescript
/**
 * True iff the file at `zipPath` exists AND its mtime is earlier than
 * `remoteTimestamp`. Returns false if the file is missing — the caller
 * decides whether that means "download" or "error".
 */
export function isInputZipStale(zipPath: string, remoteTimestamp: Date): boolean {
    if (!fs.existsSync(zipPath)) return false;
    const mtime = fs.statSync(zipPath).mtime;
    return mtime < remoteTimestamp;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/sync.test.ts`
Expected: All three `isInputZipStale` tests PASS. Existing tests still PASS.

- [ ] **Step 5: Commit**

```bash
git -c user.name="Sage Grigull" -c user.email="ciphernaut@proton.me" \
  add src/sync.ts tests/sync.test.ts
git -c user.name="Sage Grigull" -c user.email="ciphernaut@proton.me" \
  commit -m "feat(sync): Add isInputZipStale helper."
```

---

### Task 3: `shouldDoFullSync` helper

Returns `true` iff `asOf` is null OR `remoteTimestamp - asOf > 24h`. The 24-hour threshold matches ACMA's incremental window — outside it, incremental sync cannot succeed.

**Files:**
- Modify: `src/sync.ts` (add export at end of file)
- Test: `tests/sync.test.ts`

- [ ] **Step 1: Write the failing tests**

Add this `describe` block. Update import:

```typescript
// Update existing import:
import { extractZip, importCsv, applyIncrementalUpdate, parseRemoteTimestamp, isInputZipStale, shouldDoFullSync } from '../src/sync';

describe('shouldDoFullSync', () => {
    const remote = new Date('2026-04-28T00:00:00Z');

    test('returns true when asOf is null (no DB / never synced)', () => {
        expect(shouldDoFullSync(null, remote)).toBe(true);
    });

    test('returns false when gap is under 24h', () => {
        const asOf = new Date('2026-04-27T05:00:00Z'); // 19h behind
        expect(shouldDoFullSync(asOf, remote)).toBe(false);
    });

    test('returns true when gap is over 24h', () => {
        const asOf = new Date('2026-04-26T00:00:00Z'); // 48h behind
        expect(shouldDoFullSync(asOf, remote)).toBe(true);
    });

    test('returns false when gap is exactly 24h (boundary: <= 24h is incremental)', () => {
        const asOf = new Date('2026-04-27T00:00:00Z'); // exactly 24h
        expect(shouldDoFullSync(asOf, remote)).toBe(false);
    });

    test('returns false when asOf is in the future relative to remote', () => {
        const asOf = new Date('2026-04-28T01:00:00Z');
        expect(shouldDoFullSync(asOf, remote)).toBe(false);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/sync.test.ts`
Expected: TypeScript / runtime error indicating `shouldDoFullSync` is not exported.

- [ ] **Step 3: Implement the helper**

Append to `src/sync.ts` (after `isInputZipStale`):

```typescript
/** Milliseconds in the ACMA incremental update window. */
const INCREMENTAL_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * True iff a full sync is required — either the DB has never been synced
 * (`asOf` is null) or the gap to `remoteTimestamp` exceeds the 24-hour
 * incremental update window. Equality counts as "still incremental".
 */
export function shouldDoFullSync(asOf: Date | null, remoteTimestamp: Date): boolean {
    if (!asOf) return true;
    return remoteTimestamp.getTime() - asOf.getTime() > INCREMENTAL_WINDOW_MS;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/sync.test.ts`
Expected: All five `shouldDoFullSync` tests PASS. All previously added tests still PASS.

- [ ] **Step 5: Commit**

```bash
git -c user.name="Sage Grigull" -c user.email="ciphernaut@proton.me" \
  add src/sync.ts tests/sync.test.ts
git -c user.name="Sage Grigull" -c user.email="ciphernaut@proton.me" \
  commit -m "feat(sync): Add shouldDoFullSync helper for incremental window gap check."
```

---

### Task 4: Wire input-zip staleness into `performFullSync`

Make `performFullSync` accept an optional pre-fetched `remoteTimestamp`, and skip the local input zip when it's older than upstream.

**Files:**
- Modify: `src/sync.ts:58-133` (the `performFullSync` function)

- [ ] **Step 1: Update the signature and timestamp-fetch logic**

Replace lines `src/sync.ts:58-85` (from `export async function performFullSync` through the end of the `if (fs.existsSync(zipPathFromInput))` block) with:

```typescript
export async function performFullSync(config: SyncConfig, remoteTimestampRaw?: string): Promise<void> {
    if (currentSyncStatus.isSyncing) {
        throw new Error('Synchronization already in progress');
    }

    currentSyncStatus = { isSyncing: true, progress: 0 };

    try {
        if (!fs.existsSync(config.dataDir)) {
            fs.mkdirSync(config.dataDir, { recursive: true });
        }

        let remoteTimestamp: string;
        if (remoteTimestampRaw !== undefined) {
            remoteTimestamp = remoteTimestampRaw;
        } else {
            console.log('Fetching dataset timestamp...');
            const tsResponse = await axios.get(config.timestampUrl, { responseType: 'text' });
            remoteTimestamp = String(tsResponse.data).trim();
        }

        const zipPathFromInput = '/projects/acma-local-redux/inputs/spectra_rrl.zip';
        const zipPath = path.join(config.dataDir, 'spectra_rrl.zip');

        currentSyncStatus.progress = 5;

        const parsedRemote = parseRemoteTimestamp(remoteTimestamp);
        const inputZipExists = fs.existsSync(zipPathFromInput);
        const inputZipUsable = inputZipExists && !(parsedRemote && isInputZipStale(zipPathFromInput, parsedRemote));

        if (inputZipUsable) {
            console.log('Using local dataset from inputs/');
            fs.copyFileSync(zipPathFromInput, zipPath);
        } else {
            if (inputZipExists && parsedRemote) {
                const mtime = fs.statSync(zipPathFromInput).mtime.toISOString();
                console.log(`[SYNC] Input zip mtime=${mtime} is older than remote=${parsedRemote.toISOString()}; ignoring stale input.`);
            }
            console.log('Downloading full dataset...');
            await downloadFile(config.datasetUrl, zipPath);
        }
```

The rest of `performFullSync` (lines 87 onwards: `currentSyncStatus.progress = 20;` through the end of the function) is unchanged.

- [ ] **Step 2: Run the full test suite**

Run: `npm test`
Expected: All tests PASS. The new helper tests from Tasks 1-3 still pass; existing sync tests still pass; no TypeScript errors.

- [ ] **Step 3: Type-check the build**

Run: `npm run build`
Expected: Compiles cleanly, no TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git -c user.name="Sage Grigull" -c user.email="ciphernaut@proton.me" \
  add src/sync.ts
git -c user.name="Sage Grigull" -c user.email="ciphernaut@proton.me" \
  commit -m "feat(sync): Skip stale inputs/spectra_rrl.zip in performFullSync."
```

---

### Task 5: Restructure `sync()` for gap-check routing

Fetch the remote timestamp once up front; use `shouldDoFullSync` to decide between full and incremental sync; pass the timestamp through to `performFullSync` to avoid a second fetch.

**Files:**
- Modify: `src/sync.ts:161-202` (the `sync` function)

- [ ] **Step 1: Replace the `sync` function body**

Replace the entirety of `src/sync.ts:161-202` (from `export async function sync` through the closing `}` of the function) with:

```typescript
export async function sync(config: SyncConfig = DEFAULT_CONFIG): Promise<void> {
    // ── Rate-limit guard ──────────────────────────────────────────────────────
    const lastSync = getLastSyncTime(config.dbPath);
    if (lastSync) {
        const msSinceLast = Date.now() - lastSync.getTime();
        if (msSinceLast < SYNC_COOLDOWN_MS) {
            const nextSyncIn = Math.ceil((SYNC_COOLDOWN_MS - msSinceLast) / 60_000);
            console.log(
                `[SYNC] Skipping — last sync was ${Math.floor(msSinceLast / 60_000)} min ago. ` +
                `Next allowed sync in ~${nextSyncIn} min.`
            );
            return;
        }
    }
    // ─────────────────────────────────────────────────────────────────────────

    // Fetch remote timestamp once; reused below to decide full vs incremental
    // and threaded through performFullSync to avoid a second fetch.
    let remoteTimestampRaw: string;
    try {
        const tsResponse = await axios.get(config.timestampUrl, { responseType: 'text' });
        remoteTimestampRaw = String(tsResponse.data).trim();
    } catch (e) {
        console.error('[SYNC] Could not fetch remote timestamp; aborting sync.', e);
        return;
    }
    const parsedRemote = parseRemoteTimestamp(remoteTimestampRaw);
    if (!parsedRemote) {
        console.log(`[SYNC] Could not parse remote timestamp '${remoteTimestampRaw}'; proceeding without staleness check.`);
    }

    const dbExists = fs.existsSync(config.dbPath);

    if (!dbExists) {
        await performFullSync(config, remoteTimestampRaw);
        return;
    }

    // Read meta.as_of for gap check
    let asOf: Date | null = null;
    if (parsedRemote) {
        const db = new Database(config.dbPath, { readonly: true, fileMustExist: true });
        try {
            const row = db.prepare("SELECT value FROM meta WHERE key = 'as_of'").get() as { value: string } | undefined;
            asOf = row ? parseRemoteTimestamp(row.value) : null;
        } finally {
            if (db.open) db.close();
        }

        if (shouldDoFullSync(asOf, parsedRemote)) {
            const gapHours = asOf
                ? Math.round((parsedRemote.getTime() - asOf.getTime()) / 3_600_000)
                : null;
            const gapDesc = gapHours === null ? 'no prior sync' : `${gapHours}h behind`;
            console.log(`[SYNC] DB is ${gapDesc} (remote=${parsedRemote.toISOString()}); full sync required.`);
            await performFullSync(config, remoteTimestampRaw);
            return;
        }
    }

    // Within the incremental window — attempt incremental sync
    console.log('Checking for incremental updates...');
    try {
        const response = await axios.get(config.incrementalUrl);
        const updateContent = response.data;

        const newTimestamp = await applyIncrementalUpdate(updateContent, config.dbPath);
        if (newTimestamp) {
            const db = new Database(config.dbPath);
            db.prepare('REPLACE INTO meta (key, value) VALUES (?, ?)').run('as_of', newTimestamp);
            db.prepare('REPLACE INTO meta (key, value) VALUES (?, ?)').run('last_sync', new Date().toISOString());
            db.close();
            console.log(`Incremental sync successful. Database is now as-of ${newTimestamp}`);
        }
    } catch (e) {
        console.error('Incremental sync failed.', e);
        // No auto-fallback: the gap check above already routed any DB that
        // is genuinely past the incremental window. Remaining failures are
        // transient and will retry on the next scheduled sync.
    }
}
```

- [ ] **Step 2: Run the full test suite**

Run: `npm test`
Expected: All tests PASS. No TypeScript errors. Existing `applyIncrementalUpdate`, `extractZip`, and `importCsv` tests still pass.

- [ ] **Step 3: Type-check the build**

Run: `npm run build`
Expected: Compiles cleanly, no TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git -c user.name="Sage Grigull" -c user.email="ciphernaut@proton.me" \
  add src/sync.ts
git -c user.name="Sage Grigull" -c user.email="ciphernaut@proton.me" \
  commit -m "feat(sync): Route stale DB to full sync via remote-timestamp gap check."
```

---

## Verification

After all five tasks land:

- [ ] **Sanity-check the new behaviour against the current state**

  The current state of this repo: `inputs/spectra_rrl.zip` is dated 2026-03-05; today is 2026-04-28; no `data/acma.db` likely exists in clean checkouts, or if it does it is well outside the 24h window. Either path now leads to a fresh download from `datasetUrl` rather than seeding from the stale input zip or attempting (and silently failing) an incremental update.

  Run: `npm test`
  Expected: All tests pass, including new helper tests.

  Run: `npm run build`
  Expected: Clean compile.

- [ ] **Manual smoke test (optional, requires network)**

  With a clean state (`rm -rf data/`), invoke `npm run sync`. Expected log lines, in order:
  1. `[SYNC] Input zip mtime=… is older than remote=…; ignoring stale input.`
  2. `Downloading full dataset...`
  3. `Extracting ZIP...` then per-table `Importing …` lines
  4. `Full sync complete.`
