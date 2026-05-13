# Table Expansion (T1–T4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Materialise 17 additional ACMA tables in `TABLE_METADATA`, JOIN lookup tables into existing search/detail views, add 3 new MCP tools (`search_bsl`, `search_spectrum_band`, `search_application_text`), build a SQLite FTS5 index over `applic_text_block.APTB_TEXT`, and update `execute_sql`'s description to reflect the real materialised schema.

**Architecture:** Schemas live in `src/db.ts` (`TABLE_METADATA`). Incremental sync logic in `src/sync.ts` is extended for composite-PK tables and a special FTS5-aware branch for `applic_text_block`. Search/detail SQL lives in `src/logic.ts` with LEFT JOINs against lookup tables for human-readable name columns. MCP tools are registered in `src/index.ts`.

**Tech Stack:** TypeScript, Jest (ts-jest ESM preset), better-sqlite3 (incl. FTS5 virtual tables), adm-zip, csv-parse, `@modelcontextprotocol/sdk`.

**Spec:** `docs/superpowers/specs/2026-05-14-table-expansion-design.md`

**Commit convention for this branch:** All commits MUST be authored as `Sage Grigull <ciphernaut@proton.me>` via per-call `-c`. No `Co-Authored-By:` trailers. Commit form:

```bash
git -c user.email='ciphernaut@proton.me' -c user.name='Sage Grigull' commit -m "feat(scope): one-line summary."
```

**Test runner:** `NODE_OPTIONS='--experimental-vm-modules' npx jest ...` (the `npm test` script sets this automatically).

---

## File Structure

**Modify:**
- `src/db.ts` — add 17 new entries to `TABLE_METADATA` (10 lookups + 4 BSL/spectrum + 1 satellite + 2 text blocks); add 1 FTS5 virtual-table entry (`applic_text_block_fts`).
- `src/sync.ts` — widen `PK_BY_TABLE` to `Record<string, string | string[]>`; rebuild `applyCsvDiff` DELETE statement for composite keys; add FTS5-aware branch for `applic_text_block`; add FTS5 rebuild call in `performFullSync`.
- `src/logic.ts` — restructure `searchLicences`, `searchLicencesWithSites`, `getLicenceDetails`, `searchClients`, `searchSites`, `getSiteDetails` with LEFT JOINs to lookup tables; add `searchBsl`, `searchSpectrumBand`, `searchApplicationText`.
- `src/index.ts` — register 3 new MCP tools (`search_bsl`, `search_spectrum_band`, `search_application_text`); update `execute_sql` description; add handlers.
- `tests/sync.test.ts` — add composite-PK applyCsvDiff test + FTS5 incremental test.
- `tests/logic.test.ts` — add tests for 3 new search functions + assertions on new JOIN name columns.
- `tests/db.test.ts` — verify all 17 new tables are created by `initializeDatabase`.

**No new files.** Project convention is flat `src/`.

---

## Task 1: Composite-PK support in `applyCsvDiff`

The current `applyCsvDiff` assumes single-column PKs. T2's `auth_spectrum_freq` (4-column composite) and `auth_spectrum_area` (2-column composite), plus T1's `licence_subservice` (2-column composite), need composite-key DELETE statements. This task is the foundation that all subsequent table additions rely on.

**Files:**
- Modify: `src/sync.ts:140` (PK_BY_TABLE type) and `src/sync.ts:192-233` (applyCsvDiff body)
- Test: `tests/sync.test.ts` (add to `applyCsvDiffZip` describe block)

- [ ] **Step 1: Write the failing test**

Add inside the existing `describe('applyCsvDiffZip', ...)` block in `tests/sync.test.ts`:

```typescript
    test('composite-PK table: DELETE binds all PK columns positionally', async () => {
        // Add a synthetic composite-PK entry to PK_BY_TABLE via a real table.
        // licence_subservice is the smallest real composite-PK table; its schema
        // arrives in Task 2 of this plan but for THIS test we create it inline so
        // Task 1 is independently testable.
        const seedDb = new Database(dbPath);
        seedDb.exec(`
            CREATE TABLE IF NOT EXISTS licence_subservice(
                SS_ID INTEGER, SV_SV_ID INTEGER, SS_NAME TEXT
            );
            INSERT INTO licence_subservice VALUES (101, 1, 'HF Domestic');
            INSERT INTO licence_subservice VALUES (101, 2, 'HF Domestic clone');
        `);
        seedDb.close();

        // Change-zip: delete (SS_ID=101, SV_SV_ID=1) — the other row must survive.
        buildChangeZip({
            'licence_subservice.csv':
                'SS_ID,SV_SV_ID,SS_NAME,CHANGE\n' +
                '101,1,,Deleted\n',
        });

        await applyCsvDiffZip(zipPath, dbPath);

        const db = new Database(dbPath);
        const rows = db.prepare('SELECT * FROM licence_subservice ORDER BY SV_SV_ID').all() as any[];
        db.close();
        expect(rows).toEqual([{ SS_ID: 101, SV_SV_ID: 2, SS_NAME: 'HF Domestic clone' }]);
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `NODE_OPTIONS='--experimental-vm-modules' npx jest tests/sync.test.ts -t 'composite-PK'`
Expected: FAIL — `licence_subservice` is not in `PK_BY_TABLE` so the entire CSV is skipped.

- [ ] **Step 3: Widen `PK_BY_TABLE` and rebuild DELETE for composite keys**

In `src/sync.ts`, replace the existing `PK_BY_TABLE` declaration (around line 144) with:

```typescript
const PK_BY_TABLE: Record<string, string | string[]> = {
    client: 'CLIENT_NO',
    licence: 'LICENCE_NO',
    site: 'SITE_ID',
    device_details: 'SDD_ID',
    antenna: 'ANTENNA_ID',
    // Composite-PK seed for tests; real entries land in Task 2.
    licence_subservice: ['SS_ID', 'SV_SV_ID'],
};
```

Then replace the `applyCsvDiff` body (around lines 192-233) — specifically the section that builds `deleteStmt` and runs `Deleted` rows — with the composite-aware version. Replace this block:

```typescript
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
                console.error(`Unknown CHANGE='${change}' in ${tableName}; skipping row pk=${pkValue}`);
            }
        }
    });
    apply();
```

With:

```typescript
    const pkSpec = PK_BY_TABLE[tableName]!;
    const pkCols: string[] = Array.isArray(pkSpec) ? pkSpec : [pkSpec];
    const dataCols = columns.filter(c => c !== 'CHANGE');
    const placeholders = dataCols.map(() => '?').join(',');
    const insertStmt = db.prepare(
        `INSERT INTO ${tableName} (${dataCols.join(',')}) VALUES (${placeholders})`
    );
    const deleteWhere = pkCols.map(c => `${c} = ?`).join(' AND ');
    const deleteStmt = db.prepare(`DELETE FROM ${tableName} WHERE ${deleteWhere}`);

    const apply = db.transaction(() => {
        for (const row of rows) {
            const change = row.CHANGE;
            const pkValues = pkCols.map(c => row[c]);
            if (change === 'Deleted') {
                deleteStmt.run(...pkValues);
            } else if (change === 'Added' || change === 'Updated') {
                deleteStmt.run(...pkValues);
                const values = dataCols.map(c => row[c] === '' ? null : row[c]);
                insertStmt.run(...values);
            } else {
                console.error(`Unknown CHANGE='${change}' in ${tableName}; skipping row pk=${JSON.stringify(pkValues)}`);
            }
        }
    });
    apply();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `NODE_OPTIONS='--experimental-vm-modules' npx jest tests/sync.test.ts`
Expected: all 47 prior tests + the new composite-PK test PASS (48 total).

- [ ] **Step 5: Commit**

```bash
git add src/sync.ts tests/sync.test.ts
git -c user.email='ciphernaut@proton.me' -c user.name='Sage Grigull' \
    commit -m "feat(sync): Widen PK_BY_TABLE for composite keys; rebuild DELETE positionally."
```

---

## Task 2: T1 — 10 lookup table schemas

Adds the 10 small lookup tables to `TABLE_METADATA` and registers them in `PK_BY_TABLE`. No JOIN restructuring yet (that's Task 3). After this task, `initializeDatabase` creates these tables but they remain unpopulated until a sync runs.

**Files:**
- Modify: `src/db.ts` (add 10 entries to TABLE_METADATA)
- Modify: `src/sync.ts:144` (extend PK_BY_TABLE)
- Test: `tests/db.test.ts` (verify all 10 tables exist after initializeDatabase)

- [ ] **Step 1: Write the failing test**

Add to `tests/db.test.ts`:

```typescript
describe('T1 lookup tables', () => {
    const scratchDir = path.join(__dirname, '../scratch_test_t1');
    const dbPath = path.join(scratchDir, 'test_acma.db');

    beforeEach(() => {
        if (!fs.existsSync(scratchDir)) fs.mkdirSync(scratchDir);
        if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
        initializeDatabase(dbPath);
    });

    afterAll(() => {
        if (fs.existsSync(scratchDir)) fs.rmSync(scratchDir, { recursive: true, force: true });
    });

    test.each([
        ['client_type', 'TYPE_ID'],
        ['fee_status', 'FEE_STATUS_ID'],
        ['industry_cat', 'CAT_ID'],
        ['licence_service', 'SV_ID'],
        ['licence_subservice', 'SS_ID'],
        ['licence_status', 'STATUS'],
        ['nature_of_service', 'CODE'],
        ['class_of_station', 'CODE'],
        ['licensing_area', 'LICENSING_AREA_ID'],
        ['antenna_polarity', 'POLARISATION_CODE'],
    ])('%s table exists and has expected PK column %s', (table, pkCol) => {
        const db = new Database(dbPath, { readonly: true });
        const cols = db.prepare(`PRAGMA table_info(${table})`).all() as any[];
        db.close();
        expect(cols.length).toBeGreaterThan(0);
        expect(cols.find(c => c.name === pkCol)).toBeDefined();
    });
});
```

Confirm `tests/db.test.ts` has the required imports at the top (`Database`, `initializeDatabase`, `fs`, `path`, `__dirname`). If not, add them following the pattern from `tests/sync.test.ts`.

- [ ] **Step 2: Run test to verify it fails**

Run: `NODE_OPTIONS='--experimental-vm-modules' npx jest tests/db.test.ts -t 'T1 lookup tables'`
Expected: 10 tests FAIL — none of the tables exist yet.

- [ ] **Step 3: Add the 10 schema entries to `TABLE_METADATA`**

In `src/db.ts`, after the existing `antenna` entry and before `meta`, insert:

```typescript
  "client_type": {
    "ddl": `CREATE TABLE IF NOT EXISTS client_type(TYPE_ID INTEGER, NAME TEXT);`,
    "post_load_ddl": `CREATE INDEX IF NOT EXISTS client_type_type_id ON client_type(TYPE_ID);`
  },
  "fee_status": {
    "ddl": `CREATE TABLE IF NOT EXISTS fee_status(FEE_STATUS_ID INTEGER, FEE_STATUS_TEXT TEXT);`,
    "post_load_ddl": `CREATE INDEX IF NOT EXISTS fee_status_id_idx ON fee_status(FEE_STATUS_ID);`
  },
  "industry_cat": {
    "ddl": `CREATE TABLE IF NOT EXISTS industry_cat(CAT_ID INTEGER, DESCRIPTION TEXT, NAME TEXT);`,
    "post_load_ddl": `CREATE INDEX IF NOT EXISTS industry_cat_cat_id ON industry_cat(CAT_ID);`
  },
  "licence_service": {
    "ddl": `CREATE TABLE IF NOT EXISTS licence_service(SV_ID INTEGER, SV_NAME TEXT);`,
    "post_load_ddl": `CREATE INDEX IF NOT EXISTS licence_service_sv_id ON licence_service(SV_ID);`
  },
  "licence_subservice": {
    "ddl": `CREATE TABLE IF NOT EXISTS licence_subservice(SS_ID INTEGER, SV_SV_ID INTEGER, SS_NAME TEXT);`,
    "post_load_ddl": `
      CREATE INDEX IF NOT EXISTS licence_subservice_ss_idx ON licence_subservice(SS_ID, SV_SV_ID);
      CREATE INDEX IF NOT EXISTS licence_subservice_sv_idx ON licence_subservice(SV_SV_ID);
    `
  },
  "licence_status": {
    "ddl": `CREATE TABLE IF NOT EXISTS licence_status(STATUS INTEGER, STATUS_TEXT TEXT);`,
    "post_load_ddl": `CREATE INDEX IF NOT EXISTS licence_status_status_idx ON licence_status(STATUS);`
  },
  "nature_of_service": {
    "ddl": `CREATE TABLE IF NOT EXISTS nature_of_service(CODE TEXT, DESCRIPTION TEXT);`,
    "post_load_ddl": `CREATE INDEX IF NOT EXISTS nature_of_service_code_idx ON nature_of_service(CODE);`
  },
  "class_of_station": {
    "ddl": `CREATE TABLE IF NOT EXISTS class_of_station(CODE TEXT, DESCRIPTION TEXT);`,
    "post_load_ddl": `CREATE INDEX IF NOT EXISTS class_of_station_code_idx ON class_of_station(CODE);`
  },
  "licensing_area": {
    "ddl": `CREATE TABLE IF NOT EXISTS licensing_area(LICENSING_AREA_ID INTEGER, DESCRIPTION TEXT);`,
    "post_load_ddl": `CREATE INDEX IF NOT EXISTS licensing_area_id_idx ON licensing_area(LICENSING_AREA_ID);`
  },
  "antenna_polarity": {
    "ddl": `CREATE TABLE IF NOT EXISTS antenna_polarity(POLARISATION_CODE TEXT, POLARISATION_TEXT TEXT);`,
    "post_load_ddl": `CREATE INDEX IF NOT EXISTS antenna_polarity_code_idx ON antenna_polarity(POLARISATION_CODE);`
  },
```

In `src/sync.ts`, replace the `PK_BY_TABLE` declaration (now containing only `licence_subservice` from Task 1) with the full T1+T2+T3+T4 set so later tasks don't have to keep editing it. Replace the existing block:

```typescript
const PK_BY_TABLE: Record<string, string | string[]> = {
    client: 'CLIENT_NO',
    licence: 'LICENCE_NO',
    site: 'SITE_ID',
    device_details: 'SDD_ID',
    antenna: 'ANTENNA_ID',
    licence_subservice: ['SS_ID', 'SV_SV_ID'],
};
```

With:

```typescript
const PK_BY_TABLE: Record<string, string | string[]> = {
    // pre-existing
    client: 'CLIENT_NO',
    licence: 'LICENCE_NO',
    site: 'SITE_ID',
    device_details: 'SDD_ID',
    antenna: 'ANTENNA_ID',
    // T1 lookups
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
    // T2 broadcasting + spectrum
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

- [ ] **Step 4: Run test to verify it passes**

Run: `NODE_OPTIONS='--experimental-vm-modules' npx jest tests/db.test.ts`
Expected: 10 new T1 tests + any pre-existing db.test.ts tests PASS.

Also run the full suite to confirm nothing regressed: `NODE_OPTIONS='--experimental-vm-modules' npx jest`. The pre-existing `sql_transaction.test.ts` and `sql_crossjoin.test.ts` empty-suite failures are unrelated.

- [ ] **Step 5: Commit**

```bash
git add src/db.ts src/sync.ts tests/db.test.ts
git -c user.email='ciphernaut@proton.me' -c user.name='Sage Grigull' \
    commit -m "feat(db): Materialise 10 ACMA lookup tables (T1) + extend PK_BY_TABLE for full sprint."
```

---

## Task 3: T1 — JOIN lookups into existing search/detail views

Restructures `src/logic.ts` so all existing search/detail functions LEFT JOIN the relevant lookups and surface human-readable names alongside the FK codes. Backwards-compat: existing columns stay; name columns are additive.

**Files:**
- Modify: `src/logic.ts` (all 6 existing functions)
- Test: `tests/logic.test.ts` (add seed for lookups, assert name columns present)

- [ ] **Step 1: Read the current `tests/logic.test.ts` to identify the existing seed pattern**

The file currently seeds `client`, `licence`, `site`, `device_details`, `antenna`. After Task 2, the schema has the 10 lookups but no seed data. Tests must seed at least `licence_service`, `licence_subservice`, `licence_status` for `searchLicences*` assertions; `client_type`, `fee_status`, `industry_cat` for `searchClients`; `licensing_area` for `searchSites`; `nature_of_service`, `class_of_station`, `antenna_polarity` for `getSiteDetails` device rows.

- [ ] **Step 2: Write the failing tests**

Add to `tests/logic.test.ts`. Place these inside whichever `describe` block sets up the seed DB; assume the seed function is reusable. If the existing tests use a single shared `beforeAll`/`beforeEach` block, extend it with lookup-table seeds, then add these assertions:

```typescript
    test('searchLicences returns SERVICE_NAME, SUBSERVICE_NAME, STATUS_NAME via JOINs', () => {
        // Seed the lookups (call sites adjust per existing test infrastructure).
        const db = new Database(dbPath);
        db.exec(`
            INSERT INTO licence_service (SV_ID, SV_NAME) VALUES (3, 'Land Mobile');
            INSERT INTO licence_subservice (SS_ID, SV_SV_ID, SS_NAME) VALUES (304, 3, 'Land Mobile System');
            INSERT INTO licence_status (STATUS, STATUS_TEXT) VALUES (10, 'Expired');
            INSERT INTO licence (LICENCE_NO, CLIENT_NO, SV_ID, SS_ID, STATUS) VALUES ('LM1', 1, 3, 304, 10);
        `);
        db.close();

        const db2 = new Database(dbPath, { readonly: true });
        const results = searchLicences(db2, 'LM1', 10) as any[];
        db2.close();
        expect(results).toHaveLength(1);
        expect(results[0]).toMatchObject({
            LICENCE_NO: 'LM1',
            SV_ID: 3,
            SERVICE_NAME: 'Land Mobile',
            SUBSERVICE_NAME: 'Land Mobile System',
            STATUS_NAME: 'Expired',
        });
    });

    test('searchClients returns CLIENT_TYPE_NAME, FEE_STATUS_NAME, INDUSTRY_NAME via JOINs', () => {
        const db = new Database(dbPath);
        db.exec(`
            INSERT INTO client_type (TYPE_ID, NAME) VALUES (5, 'Company');
            INSERT INTO fee_status (FEE_STATUS_ID, FEE_STATUS_TEXT) VALUES (1, 'Normal');
            INSERT INTO industry_cat (CAT_ID, DESCRIPTION, NAME) VALUES (3, 'Manufacturing', 'Manufacturing');
            INSERT INTO client (CLIENT_NO, LICENCEE, CAT_ID, CLIENT_TYPE_ID, FEE_STATUS_ID)
                VALUES (42, 'Acme Pty Ltd', 3, 5, 1);
        `);
        db.close();

        const db2 = new Database(dbPath, { readonly: true });
        const results = searchClients(db2, 'Acme', 10) as any[];
        db2.close();
        expect(results).toHaveLength(1);
        expect(results[0]).toMatchObject({
            LICENCEE: 'Acme Pty Ltd',
            CLIENT_TYPE_NAME: 'Company',
            FEE_STATUS_NAME: 'Normal',
            INDUSTRY_NAME: 'Manufacturing',
        });
    });

    test('searchSites returns LICENSING_AREA_NAME via JOIN', () => {
        const db = new Database(dbPath);
        db.exec(`
            INSERT INTO licensing_area (LICENSING_AREA_ID, DESCRIPTION) VALUES (1, 'Australia');
            INSERT INTO site (SITE_ID, NAME, POSTCODE, LICENSING_AREA_ID)
                VALUES ('S1', 'Test Site', '2000', 1);
        `);
        db.close();

        const db2 = new Database(dbPath, { readonly: true });
        const results = searchSites(db2, 'Test Site', 10) as any[];
        db2.close();
        expect(results[0]?.LICENSING_AREA_NAME).toBe('Australia');
    });
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `NODE_OPTIONS='--experimental-vm-modules' npx jest tests/logic.test.ts`
Expected: the 3 new tests FAIL — name columns don't exist yet in the result rows. Pre-existing logic.test.ts tests still pass.

- [ ] **Step 4: Restructure `src/logic.ts`**

Replace the entire file contents with:

```typescript
import Database from 'better-sqlite3';

export function searchSites(db: Database.Database, query: string, limit: number = 20) {
  return db.prepare(`
    SELECT s.*, la.DESCRIPTION AS LICENSING_AREA_NAME
    FROM site s
    LEFT JOIN licensing_area la ON la.LICENSING_AREA_ID = s.LICENSING_AREA_ID
    WHERE s.NAME LIKE ? OR s.POSTCODE LIKE ?
    LIMIT ?
  `).all(`%${query}%`, `%${query}%`, limit);
}

export function getSiteDetails(db: Database.Database, siteId: string) {
  const site = db.prepare(`
    SELECT s.*, la.DESCRIPTION AS LICENSING_AREA_NAME
    FROM site s
    LEFT JOIN licensing_area la ON la.LICENSING_AREA_ID = s.LICENSING_AREA_ID
    WHERE s.SITE_ID = ?
  `).get(siteId);
  if (!site) return null;

  const devices = db.prepare(`
    SELECT d.*,
           nos.DESCRIPTION AS NATURE_OF_SERVICE_NAME,
           cos.DESCRIPTION AS CLASS_OF_STATION_NAME,
           ap.POLARISATION_TEXT AS POLARISATION_NAME
    FROM device_details d
    LEFT JOIN nature_of_service nos ON nos.CODE = d.NATURE_OF_SERVICE_ID
    LEFT JOIN class_of_station   cos ON cos.CODE = d.CLASS_OF_STATION_CODE
    LEFT JOIN antenna_polarity   ap  ON ap.POLARISATION_CODE = d.POLARISATION
    WHERE d.SITE_ID = ?
    LIMIT 50
  `).all(siteId);
  return { site, devices };
}

const LICENCE_SELECT = `
  SELECT l.*,
         sv.SV_NAME     AS SERVICE_NAME,
         ss.SS_NAME     AS SUBSERVICE_NAME,
         ls.STATUS_TEXT AS STATUS_NAME
  FROM licence l
  LEFT JOIN licence_service     sv ON sv.SV_ID = l.SV_ID
  LEFT JOIN licence_subservice  ss ON ss.SS_ID = l.SS_ID AND ss.SV_SV_ID = l.SV_ID
  LEFT JOIN licence_status      ls ON ls.STATUS = l.STATUS
`;

export function searchLicences(db: Database.Database, query: string, limit: number = 20) {
  return db.prepare(`
    ${LICENCE_SELECT}
    WHERE l.LICENCE_NO LIKE ?
    LIMIT ?
  `).all(`%${query}%`, limit);
}

export function searchLicencesWithSites(db: Database.Database, query: string, limit: number = 20) {
  return db.prepare(`
    SELECT DISTINCT l.*,
           sv.SV_NAME     AS SERVICE_NAME,
           ss.SS_NAME     AS SUBSERVICE_NAME,
           ls.STATUS_TEXT AS STATUS_NAME,
           s.LATITUDE, s.LONGITUDE, s.NAME AS SITE_NAME
    FROM licence l
    LEFT JOIN licence_service    sv ON sv.SV_ID = l.SV_ID
    LEFT JOIN licence_subservice ss ON ss.SS_ID = l.SS_ID AND ss.SV_SV_ID = l.SV_ID
    LEFT JOIN licence_status     ls ON ls.STATUS = l.STATUS
    LEFT JOIN device_details d ON l.LICENCE_NO = d.LICENCE_NO
    LEFT JOIN site s ON d.SITE_ID = s.SITE_ID
    WHERE l.LICENCE_NO LIKE ?
    LIMIT ?
  `).all(`%${query}%`, limit);
}

export function searchClients(db: Database.Database, query: string, limit: number = 20) {
  return db.prepare(`
    SELECT c.*,
           ct.NAME            AS CLIENT_TYPE_NAME,
           fs.FEE_STATUS_TEXT AS FEE_STATUS_NAME,
           ic.NAME            AS INDUSTRY_NAME
    FROM client c
    LEFT JOIN client_type  ct ON ct.TYPE_ID = c.CLIENT_TYPE_ID
    LEFT JOIN fee_status   fs ON fs.FEE_STATUS_ID = c.FEE_STATUS_ID
    LEFT JOIN industry_cat ic ON ic.CAT_ID = c.CAT_ID
    WHERE c.LICENCEE LIKE ? OR c.TRADING_NAME LIKE ?
    LIMIT ?
  `).all(`%${query}%`, `%${query}%`, limit);
}

export function getLicenceDetails(db: Database.Database, licenceNo: string) {
  const licence = db.prepare(`
    ${LICENCE_SELECT}
    WHERE l.LICENCE_NO = ?
  `).get(licenceNo) as any;
  if (!licence) return null;

  const client = db.prepare(`
    SELECT c.*,
           ct.NAME            AS CLIENT_TYPE_NAME,
           fs.FEE_STATUS_TEXT AS FEE_STATUS_NAME,
           ic.NAME            AS INDUSTRY_NAME
    FROM client c
    LEFT JOIN client_type  ct ON ct.TYPE_ID = c.CLIENT_TYPE_ID
    LEFT JOIN fee_status   fs ON fs.FEE_STATUS_ID = c.FEE_STATUS_ID
    LEFT JOIN industry_cat ic ON ic.CAT_ID = c.CAT_ID
    WHERE c.CLIENT_NO = ?
  `).get(licence.CLIENT_NO);

  const devices = db.prepare(`
    SELECT d.*,
           nos.DESCRIPTION       AS NATURE_OF_SERVICE_NAME,
           cos.DESCRIPTION       AS CLASS_OF_STATION_NAME,
           ap.POLARISATION_TEXT  AS POLARISATION_NAME,
           s.LATITUDE, s.LONGITUDE, s.NAME AS SITE_NAME
    FROM device_details d
    LEFT JOIN nature_of_service nos ON nos.CODE = d.NATURE_OF_SERVICE_ID
    LEFT JOIN class_of_station   cos ON cos.CODE = d.CLASS_OF_STATION_CODE
    LEFT JOIN antenna_polarity   ap  ON ap.POLARISATION_CODE = d.POLARISATION
    LEFT JOIN site s ON d.SITE_ID = s.SITE_ID
    WHERE d.LICENCE_NO = ?
    LIMIT 50
  `).all(licenceNo);

  return { licence, client, devices };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `NODE_OPTIONS='--experimental-vm-modules' npx jest tests/logic.test.ts`
Expected: all logic.test.ts tests PASS, including the 3 new ones.

Run the full suite to confirm nothing regressed: `NODE_OPTIONS='--experimental-vm-modules' npx jest`.

- [ ] **Step 6: Commit**

```bash
git add src/logic.ts tests/logic.test.ts
git -c user.email='ciphernaut@proton.me' -c user.name='Sage Grigull' \
    commit -m "feat(logic): JOIN T1 lookups into search/detail views — return human-readable names."
```

---

## Task 4: T2 — `bsl` + `bsl_area` + `search_bsl` MCP tool

Adds the broadcasting service licence tables and the MCP tool to search them.

**Files:**
- Modify: `src/db.ts` (add `bsl` and `bsl_area` schemas)
- Modify: `src/logic.ts` (add `searchBsl`)
- Modify: `src/index.ts` (register `search_bsl` tool + handler)
- Test: `tests/logic.test.ts` (seed bsl + bsl_area; test searchBsl)
- Test: `tests/db.test.ts` (verify bsl, bsl_area exist)

- [ ] **Step 1: Write the failing test**

Add to `tests/logic.test.ts`:

```typescript
    test('searchBsl matches by call sign and joins bsl_area for AREA_NAME', () => {
        const db = new Database(dbPath);
        db.exec(`
            INSERT INTO bsl_area (AREA_CODE, AREA_NAME) VALUES (162, 'ADELAIDE TV1');
            INSERT INTO bsl
                (BSL_NO, MEDIUM_CATEGORY, REGION_CATEGORY, BSL_STATE, DATE_COMMENCED, ON_AIR_ID, CALL_SIGN, AREA_CODE)
                VALUES (85, 'TV', 'Regional', 'ACT', '1962-06-02', '10', 'CTC', 162);
        `);
        db.close();

        const db2 = new Database(dbPath, { readonly: true });
        const results = searchBsl(db2, 'CTC', 10) as any[];
        db2.close();
        expect(results).toHaveLength(1);
        expect(results[0]).toMatchObject({
            BSL_NO: 85,
            CALL_SIGN: 'CTC',
            MEDIUM_CATEGORY: 'TV',
            BSL_STATE: 'ACT',
            AREA_NAME: 'ADELAIDE TV1',
        });
    });

    test('searchBsl matches by BSL_NO (numeric string)', () => {
        const db = new Database(dbPath);
        db.exec(`INSERT INTO bsl (BSL_NO, CALL_SIGN) VALUES (123, 'XYZ');`);
        db.close();

        const db2 = new Database(dbPath, { readonly: true });
        const results = searchBsl(db2, '123', 10) as any[];
        db2.close();
        expect(results[0]?.BSL_NO).toBe(123);
    });
```

Add `searchBsl` to the imports at the top of the file: `import { searchSites, searchLicences, searchClients, getLicenceDetails, getSiteDetails, searchBsl } from '../src/logic';`.

In `tests/db.test.ts`, append to the `T1 lookup tables` describe block (or a new `T2 tables` describe block) the `bsl` and `bsl_area` table-existence assertions:

```typescript
    test.each([
        ['bsl', 'BSL_NO'],
        ['bsl_area', 'AREA_CODE'],
    ])('T2 %s table exists with expected PK column %s', (table, pkCol) => {
        const db = new Database(dbPath, { readonly: true });
        const cols = db.prepare(`PRAGMA table_info(${table})`).all() as any[];
        db.close();
        expect(cols.length).toBeGreaterThan(0);
        expect(cols.find(c => c.name === pkCol)).toBeDefined();
    });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `NODE_OPTIONS='--experimental-vm-modules' npx jest tests/logic.test.ts -t 'searchBsl'` and `NODE_OPTIONS='--experimental-vm-modules' npx jest tests/db.test.ts -t 'T2'`
Expected: FAIL — `searchBsl` not exported; `bsl` / `bsl_area` tables don't exist.

- [ ] **Step 3: Add `bsl` and `bsl_area` to TABLE_METADATA**

In `src/db.ts`, after the `antenna_polarity` entry (last of T1) and before `meta`, insert:

```typescript
  "bsl": {
    "ddl": `
      CREATE TABLE IF NOT EXISTS bsl(
        BSL_NO INTEGER, MEDIUM_CATEGORY TEXT, REGION_CATEGORY TEXT,
        COMMUNITY_INTEREST TEXT, BSL_STATE TEXT, DATE_COMMENCED TEXT,
        ON_AIR_ID TEXT, CALL_SIGN TEXT, IBL_TARGET_AREA TEXT,
        AREA_CODE INTEGER, REFERENCE TEXT
      );
    `,
    "post_load_ddl": `
      CREATE INDEX IF NOT EXISTS bsl_bsl_no_idx ON bsl(BSL_NO);
      CREATE INDEX IF NOT EXISTS bsl_call_sign_idx ON bsl(CALL_SIGN);
      CREATE INDEX IF NOT EXISTS bsl_on_air_id_idx ON bsl(ON_AIR_ID);
      CREATE INDEX IF NOT EXISTS bsl_area_code_idx ON bsl(AREA_CODE);
    `
  },
  "bsl_area": {
    "ddl": `CREATE TABLE IF NOT EXISTS bsl_area(AREA_CODE INTEGER, AREA_NAME TEXT);`,
    "post_load_ddl": `CREATE INDEX IF NOT EXISTS bsl_area_code_idx2 ON bsl_area(AREA_CODE);`
  },
```

- [ ] **Step 4: Add `searchBsl` to `src/logic.ts`**

Append to `src/logic.ts`:

```typescript
export function searchBsl(db: Database.Database, query: string, limit: number = 10) {
  return db.prepare(`
    SELECT b.*, a.AREA_NAME
    FROM bsl b
    LEFT JOIN bsl_area a ON a.AREA_CODE = b.AREA_CODE
    WHERE b.CALL_SIGN LIKE ?
       OR CAST(b.BSL_NO AS TEXT) LIKE ?
       OR b.ON_AIR_ID LIKE ?
    LIMIT ?
  `).all(`%${query}%`, `%${query}%`, `%${query}%`, limit);
}
```

- [ ] **Step 5: Register `search_bsl` MCP tool**

In `src/index.ts`, at the top imports (around line 19-25), add `searchBsl`:

```typescript
import {
    searchSites,
    searchLicences,
    searchClients,
    getLicenceDetails,
    getSiteDetails,
    searchBsl,
} from './logic.js';
```

In the tool catalog (look for the array containing `name: 'search_clients'`, and add the new tool after it), insert:

```typescript
            {
                name: 'search_bsl',
                description: `
### [Broadcasting Licence Search]
Search broadcasting service licences (BSLs) by call sign, BSL number, or on-air ID.

## Usage
- Use for queries about broadcast/TV/radio operators (e.g. "what's the call sign for ABC Sydney?")
- Results include: BSL_NO, CALL_SIGN, MEDIUM_CATEGORY, REGION_CATEGORY, BSL_STATE, DATE_COMMENCED, ON_AIR_ID, AREA_NAME

## Input
- query: CALL_SIGN, BSL_NO, or ON_AIR_ID (substring match)`,
                inputSchema: {
                    type: 'object',
                    properties: {
                        query: { type: 'string', description: 'CALL_SIGN, BSL_NO, or ON_AIR_ID' },
                        limit: { type: 'number', description: 'Max rows (default 10)' },
                    },
                    required: ['query'],
                },
            },
```

In the tool-call dispatcher (look for `if (name === 'search_clients')` and add a sibling branch after it):

```typescript
        if (name === 'search_bsl') {
            const db = openDb();
            try {
                const results = searchBsl(db, args?.query as string, (args?.limit as number) ?? 10);
                return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
            } finally { db.close(); }
        }
```

(Match the pattern of nearby `search_clients` / `search_sites` handlers; the actual return-shape and try/finally style may differ — follow whatever is already there.)

- [ ] **Step 6: Run tests to verify they pass**

Run: `NODE_OPTIONS='--experimental-vm-modules' npx jest`
Expected: searchBsl tests + bsl/bsl_area schema tests pass. Pre-existing tests still pass. `npx tsc --noEmit` clean.

- [ ] **Step 7: Commit**

```bash
git add src/db.ts src/logic.ts src/index.ts tests/db.test.ts tests/logic.test.ts
git -c user.email='ciphernaut@proton.me' -c user.name='Sage Grigull' \
    commit -m "feat(mcp): Add bsl + bsl_area materialised tables and search_bsl tool."
```

---

## Task 5: T2 — `auth_spectrum_freq` + `auth_spectrum_area` + `search_spectrum_band` tool

Adds the spectrum-authorisation tables (both composite-PK) and the band-overlap search tool.

**Files:**
- Modify: `src/db.ts` (2 new schemas)
- Modify: `src/logic.ts` (add `searchSpectrumBand`)
- Modify: `src/index.ts` (register tool + handler)
- Test: `tests/logic.test.ts` (band overlap edge cases)
- Test: `tests/db.test.ts` (verify both tables)
- Test: `tests/sync.test.ts` (composite-PK incremental for auth_spectrum_freq)

- [ ] **Step 1: Write the failing tests**

Add to `tests/logic.test.ts`:

```typescript
    test('searchSpectrumBand finds licences whose band overlaps the query', () => {
        const db = new Database(dbPath);
        db.exec(`
            INSERT INTO auth_spectrum_area
                (LICENCE_NO, AREA_CODE, AREA_NAME, AREA_DESCRIPTION)
                VALUES ('10143110', 'AP_10143110_3918', 'Brisbane', 'KX6G, KX6H...');
            INSERT INTO auth_spectrum_freq
                (LICENCE_NO, AREA_CODE, AREA_NAME, LW_FREQUENCY_START, LW_FREQUENCY_END, UP_FREQUENCY_START, UP_FREQUENCY_END)
                VALUES ('10143110', 'AP_10143110_3918', 'Brisbane', 1960000000, 1970000000, 2150000000, 2160000000);
        `);
        db.close();

        const db2 = new Database(dbPath, { readonly: true });
        // Query 1.96-1.97 GHz — overlaps the LW range.
        const overlap = searchSpectrumBand(db2, 1_960_000_000, 1_970_000_000, 50) as any[];
        // Query 0-100 Hz — far outside; should return none.
        const outside = searchSpectrumBand(db2, 0, 100, 50) as any[];
        // Query 1.965 GHz to 2.155 GHz — straddles both bands.
        const straddle = searchSpectrumBand(db2, 1_965_000_000, 2_155_000_000, 50) as any[];
        db2.close();

        expect(overlap).toHaveLength(1);
        expect(overlap[0]).toMatchObject({ LICENCE_NO: '10143110', AREA_NAME: 'Brisbane' });
        expect(outside).toHaveLength(0);
        expect(straddle).toHaveLength(1);
    });
```

Add `searchSpectrumBand` to the imports: `import { ..., searchSpectrumBand } from '../src/logic';`.

Add to `tests/db.test.ts`:

```typescript
    test.each([
        ['auth_spectrum_freq', 'LICENCE_NO'],
        ['auth_spectrum_area', 'LICENCE_NO'],
    ])('T2 %s table exists with column %s', (table, col) => {
        const db = new Database(dbPath, { readonly: true });
        const cols = db.prepare(`PRAGMA table_info(${table})`).all() as any[];
        db.close();
        expect(cols.find(c => c.name === col)).toBeDefined();
    });
```

Add to `tests/sync.test.ts` inside `describe('applyCsvDiffZip', ...)`:

```typescript
    test('auth_spectrum_freq incremental (4-column composite PK)', async () => {
        // Seed two rows with the same LICENCE_NO + AREA_CODE but different freq starts.
        const seedDb = new Database(dbPath);
        seedDb.exec(`
            INSERT INTO auth_spectrum_freq
                (LICENCE_NO, AREA_CODE, AREA_NAME, LW_FREQUENCY_START, LW_FREQUENCY_END, UP_FREQUENCY_START, UP_FREQUENCY_END)
                VALUES ('L1', 'A1', 'X', 100, 200, 300, 400);
            INSERT INTO auth_spectrum_freq
                (LICENCE_NO, AREA_CODE, AREA_NAME, LW_FREQUENCY_START, LW_FREQUENCY_END, UP_FREQUENCY_START, UP_FREQUENCY_END)
                VALUES ('L1', 'A1', 'X', 500, 600, 700, 800);
        `);
        seedDb.close();

        // Delete only the (L1, A1, 100, 300) row.
        buildChangeZip({
            'auth_spectrum_freq.csv':
                'LICENCE_NO,AREA_CODE,AREA_NAME,LW_FREQUENCY_START,LW_FREQUENCY_END,UP_FREQUENCY_START,UP_FREQUENCY_END,CHANGE\n' +
                'L1,A1,,100,,300,,Deleted\n',
        });
        await applyCsvDiffZip(zipPath, dbPath);

        const db = new Database(dbPath);
        const rows = db.prepare('SELECT LW_FREQUENCY_START FROM auth_spectrum_freq ORDER BY LW_FREQUENCY_START').all() as any[];
        db.close();
        expect(rows).toEqual([{ LW_FREQUENCY_START: 500 }]);
    });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `NODE_OPTIONS='--experimental-vm-modules' npx jest`
Expected: 3 new failures (logic, db, sync).

- [ ] **Step 3: Add schemas to `src/db.ts`**

After the `bsl_area` entry, insert:

```typescript
  "auth_spectrum_freq": {
    "ddl": `
      CREATE TABLE IF NOT EXISTS auth_spectrum_freq(
        LICENCE_NO TEXT, AREA_CODE TEXT, AREA_NAME TEXT,
        LW_FREQUENCY_START INTEGER, LW_FREQUENCY_END INTEGER,
        UP_FREQUENCY_START INTEGER, UP_FREQUENCY_END INTEGER
      );
    `,
    "post_load_ddl": `
      CREATE INDEX IF NOT EXISTS asf_licence_idx ON auth_spectrum_freq(LICENCE_NO);
      CREATE INDEX IF NOT EXISTS asf_lw_idx ON auth_spectrum_freq(LW_FREQUENCY_START);
      CREATE INDEX IF NOT EXISTS asf_pk_idx ON auth_spectrum_freq(LICENCE_NO, AREA_CODE, LW_FREQUENCY_START, UP_FREQUENCY_START);
    `
  },
  "auth_spectrum_area": {
    "ddl": `
      CREATE TABLE IF NOT EXISTS auth_spectrum_area(
        LICENCE_NO TEXT, AREA_CODE TEXT, AREA_NAME TEXT, AREA_DESCRIPTION TEXT
      );
    `,
    "post_load_ddl": `
      CREATE INDEX IF NOT EXISTS asa_licence_idx ON auth_spectrum_area(LICENCE_NO);
      CREATE INDEX IF NOT EXISTS asa_pk_idx ON auth_spectrum_area(LICENCE_NO, AREA_CODE);
    `
  },
```

- [ ] **Step 4: Add `searchSpectrumBand` to `src/logic.ts`**

Append:

```typescript
export function searchSpectrumBand(
  db: Database.Database,
  freqMinHz: number,
  freqMaxHz: number,
  limit: number = 20
) {
  // A band overlaps the query iff NOT (band entirely below query OR band entirely above).
  // The "band" here is the union of LW (lower) and UP (upper) ranges.
  return db.prepare(`
    SELECT f.LICENCE_NO, f.AREA_CODE, f.AREA_NAME,
           f.LW_FREQUENCY_START, f.LW_FREQUENCY_END,
           f.UP_FREQUENCY_START, f.UP_FREQUENCY_END,
           a.AREA_DESCRIPTION,
           l.CLIENT_NO
    FROM auth_spectrum_freq f
    LEFT JOIN auth_spectrum_area a
           ON a.LICENCE_NO = f.LICENCE_NO AND a.AREA_CODE = f.AREA_CODE
    LEFT JOIN licence l ON l.LICENCE_NO = f.LICENCE_NO
    WHERE NOT (f.UP_FREQUENCY_END < ? OR f.LW_FREQUENCY_START > ?)
    LIMIT ?
  `).all(freqMinHz, freqMaxHz, limit);
}
```

- [ ] **Step 5: Register `search_spectrum_band` MCP tool**

Mirror Task 4's pattern. Add `searchSpectrumBand` to the imports in `src/index.ts`. Add the tool definition right after `search_bsl`:

```typescript
            {
                name: 'search_spectrum_band',
                description: `
### [Spectrum Authorisation Search]
Find licences authorised in a frequency range. Frequencies are in Hertz (Hz).

## Usage
- Use for queries like "who's licenced between 1800 and 1900 MHz?"
- Pass freq_min_hz and freq_max_hz; result rows overlap the requested range
- Results include LICENCE_NO, AREA_NAME, frequency endpoints, CLIENT_NO

## Input
- freq_min_hz: Lower bound of the band, in Hz (e.g. 1800000000 for 1.8 GHz)
- freq_max_hz: Upper bound of the band, in Hz`,
                inputSchema: {
                    type: 'object',
                    properties: {
                        freq_min_hz: { type: 'number', description: 'Lower bound (Hz)' },
                        freq_max_hz: { type: 'number', description: 'Upper bound (Hz)' },
                        limit:       { type: 'number', description: 'Max rows (default 20)' },
                    },
                    required: ['freq_min_hz', 'freq_max_hz'],
                },
            },
```

And the handler after `search_bsl`:

```typescript
        if (name === 'search_spectrum_band') {
            const db = openDb();
            try {
                const results = searchSpectrumBand(
                    db,
                    args?.freq_min_hz as number,
                    args?.freq_max_hz as number,
                    (args?.limit as number) ?? 20
                );
                return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
            } finally { db.close(); }
        }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `NODE_OPTIONS='--experimental-vm-modules' npx jest`
Expected: all tests pass. `npx tsc --noEmit` clean.

- [ ] **Step 7: Commit**

```bash
git add src/db.ts src/logic.ts src/index.ts tests/db.test.ts tests/logic.test.ts tests/sync.test.ts
git -c user.email='ciphernaut@proton.me' -c user.name='Sage Grigull' \
    commit -m "feat(mcp): Add auth_spectrum tables (composite PK) and search_spectrum_band tool."
```

---

## Task 6: T3 — `satellite` schema + JOIN into `getLicenceDetails`

Small addition. Satellite metadata is referenced by `device_details.SA_ID`. Materialise the table and surface satellite info in the device rows of `getLicenceDetails`.

**Files:**
- Modify: `src/db.ts` (add `satellite` schema)
- Modify: `src/logic.ts` (add satellite JOIN to `getLicenceDetails` device subquery)
- Test: `tests/logic.test.ts` (verify SATELLITE_NAME appears in device row)
- Test: `tests/db.test.ts` (verify satellite table exists)

- [ ] **Step 1: Write the failing test**

In `tests/logic.test.ts`:

```typescript
    test('getLicenceDetails device rows include SATELLITE_NAME when SA_ID is set', () => {
        const db = new Database(dbPath);
        db.exec(`
            INSERT INTO satellite (SA_ID, SA_SAT_NAME) VALUES (1003, 'USASAT-14K');
            INSERT INTO licence (LICENCE_NO, CLIENT_NO) VALUES ('SAT1', 99);
            INSERT INTO device_details (SDD_ID, LICENCE_NO, SA_ID) VALUES (5001, 'SAT1', 1003);
        `);
        db.close();

        const db2 = new Database(dbPath, { readonly: true });
        const details = getLicenceDetails(db2, 'SAT1') as any;
        db2.close();
        expect(details).not.toBeNull();
        expect(details.devices[0]).toMatchObject({ SDD_ID: 5001, SA_ID: 1003, SATELLITE_NAME: 'USASAT-14K' });
    });
```

In `tests/db.test.ts`:

```typescript
    test('satellite table exists with SA_ID column', () => {
        const db = new Database(dbPath, { readonly: true });
        const cols = db.prepare("PRAGMA table_info(satellite)").all() as any[];
        db.close();
        expect(cols.find(c => c.name === 'SA_ID')).toBeDefined();
    });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `NODE_OPTIONS='--experimental-vm-modules' npx jest tests/logic.test.ts -t 'SATELLITE_NAME'` and `... -t 'satellite table'`
Expected: FAIL — table doesn't exist; column not in result.

- [ ] **Step 3: Add `satellite` schema**

In `src/db.ts`, after `auth_spectrum_area`:

```typescript
  "satellite": {
    "ddl": `
      CREATE TABLE IF NOT EXISTS satellite(
        SA_ID INTEGER, SA_SAT_NAME TEXT, SA_SAT_LONG_NOM TEXT,
        SA_SAT_INCEXC TEXT, SA_SAT_GEO_POS TEXT, SA_SAT_MERIT_G_T TEXT
      );
    `,
    "post_load_ddl": `CREATE INDEX IF NOT EXISTS satellite_sa_id_idx ON satellite(SA_ID);`
  },
```

- [ ] **Step 4: Add satellite JOIN to `getLicenceDetails` device subquery**

In `src/logic.ts`, in `getLicenceDetails`, update the `devices` query to LEFT JOIN satellite:

```typescript
  const devices = db.prepare(`
    SELECT d.*,
           nos.DESCRIPTION       AS NATURE_OF_SERVICE_NAME,
           cos.DESCRIPTION       AS CLASS_OF_STATION_NAME,
           ap.POLARISATION_TEXT  AS POLARISATION_NAME,
           sat.SA_SAT_NAME       AS SATELLITE_NAME,
           s.LATITUDE, s.LONGITUDE, s.NAME AS SITE_NAME
    FROM device_details d
    LEFT JOIN nature_of_service nos ON nos.CODE = d.NATURE_OF_SERVICE_ID
    LEFT JOIN class_of_station   cos ON cos.CODE = d.CLASS_OF_STATION_CODE
    LEFT JOIN antenna_polarity   ap  ON ap.POLARISATION_CODE = d.POLARISATION
    LEFT JOIN satellite          sat ON sat.SA_ID = d.SA_ID
    LEFT JOIN site s ON d.SITE_ID = s.SITE_ID
    WHERE d.LICENCE_NO = ?
    LIMIT 50
  `).all(licenceNo);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `NODE_OPTIONS='--experimental-vm-modules' npx jest`
Expected: pass. `npx tsc --noEmit` clean.

- [ ] **Step 6: Commit**

```bash
git add src/db.ts src/logic.ts tests/db.test.ts tests/logic.test.ts
git -c user.email='ciphernaut@proton.me' -c user.name='Sage Grigull' \
    commit -m "feat(db): Materialise satellite table and JOIN into getLicenceDetails."
```

---

## Task 7: T4-a — `applic_text_block` + `reports_text_block` schemas

Plain table additions for the two narrative tables. FTS5 setup is the next task.

**Files:**
- Modify: `src/db.ts` (add 2 schemas)
- Test: `tests/db.test.ts` (verify both tables)

- [ ] **Step 1: Write the failing test**

Add to `tests/db.test.ts`:

```typescript
    test.each([
        ['applic_text_block', 'APTB_ID'],
        ['reports_text_block', 'RTB_ITEM'],
    ])('T4 %s table exists with column %s', (table, col) => {
        const db = new Database(dbPath, { readonly: true });
        const cols = db.prepare(`PRAGMA table_info(${table})`).all() as any[];
        db.close();
        expect(cols.find(c => c.name === col)).toBeDefined();
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `NODE_OPTIONS='--experimental-vm-modules' npx jest tests/db.test.ts -t 'T4'`
Expected: FAIL — tables don't exist.

- [ ] **Step 3: Add schemas to `src/db.ts`**

After `satellite`:

```typescript
  "applic_text_block": {
    "ddl": `
      CREATE TABLE IF NOT EXISTS applic_text_block(
        APTB_ID INTEGER, APTB_TABLE_PREFIX TEXT, APTB_TABLE_ID INTEGER,
        LICENCE_NO TEXT, APTB_DESCRIPTION TEXT, APTB_CATEGORY TEXT,
        APTB_TEXT TEXT, APTB_ITEM TEXT
      );
    `,
    "post_load_ddl": `
      CREATE INDEX IF NOT EXISTS atb_id_idx ON applic_text_block(APTB_ID);
      CREATE INDEX IF NOT EXISTS atb_licence_idx ON applic_text_block(LICENCE_NO);
      CREATE INDEX IF NOT EXISTS atb_category_idx ON applic_text_block(APTB_CATEGORY);
    `
  },
  "reports_text_block": {
    "ddl": `
      CREATE TABLE IF NOT EXISTS reports_text_block(
        RTB_ITEM TEXT, RTB_CATEGORY TEXT, RTB_DESCRIPTION TEXT,
        RTB_START_DATE TEXT, RTB_END_DATE TEXT, RTB_TEXT TEXT
      );
    `,
    "post_load_ddl": `
      CREATE INDEX IF NOT EXISTS rtb_item_idx ON reports_text_block(RTB_ITEM);
      CREATE INDEX IF NOT EXISTS rtb_category_idx ON reports_text_block(RTB_CATEGORY);
    `
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `NODE_OPTIONS='--experimental-vm-modules' npx jest tests/db.test.ts`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/db.ts tests/db.test.ts
git -c user.email='ciphernaut@proton.me' -c user.name='Sage Grigull' \
    commit -m "feat(db): Materialise applic_text_block and reports_text_block tables."
```

---

## Task 8: T4-b — FTS5 virtual table + rebuild after full sync

Adds the `applic_text_block_fts` FTS5 virtual table to the schema and wires a `rebuild` call into `performFullSync` after `applic_text_block.csv` is imported.

**Files:**
- Modify: `src/db.ts` (add `applic_text_block_fts` schema entry — virtual table)
- Modify: `src/sync.ts` (FTS5 rebuild inside `performFullSync` after applic_text_block import)
- Test: `tests/sync.test.ts` (FTS5 build + MATCH query)

- [ ] **Step 1: Write the failing test**

Add to `tests/sync.test.ts`:

```typescript
describe('FTS5: applic_text_block_fts', () => {
    const scratchDir = path.join(__dirname, '../scratch_test_fts5');
    const dbPath = path.join(scratchDir, 'test_acma.db');

    beforeEach(() => {
        if (!fs.existsSync(scratchDir)) fs.mkdirSync(scratchDir);
        if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
        initializeDatabase(dbPath);
    });

    afterAll(() => {
        if (fs.existsSync(scratchDir)) fs.rmSync(scratchDir, { recursive: true, force: true });
    });

    test('FTS5 rebuild populates index from applic_text_block', () => {
        const db = new Database(dbPath);
        db.exec(`
            INSERT INTO applic_text_block (APTB_ID, APTB_TEXT, APTB_DESCRIPTION)
                VALUES (1, 'Operation must comply with the radio regulations.', 'Radio compliance');
            INSERT INTO applic_text_block (APTB_ID, APTB_TEXT, APTB_DESCRIPTION)
                VALUES (2, 'Spurious emissions must be suppressed.', 'Emissions');
        `);
        // Rebuild populates the index.
        db.exec(`INSERT INTO applic_text_block_fts(applic_text_block_fts) VALUES('rebuild');`);

        const hits = db.prepare(`
            SELECT rowid FROM applic_text_block_fts WHERE applic_text_block_fts MATCH ?
        `).all('spurious') as any[];
        db.close();
        expect(hits.map(h => h.rowid)).toEqual([2]);
    });
});
```

Confirm `initializeDatabase` is imported at the top of `tests/sync.test.ts` (it already is).

- [ ] **Step 2: Run test to verify it fails**

Run: `NODE_OPTIONS='--experimental-vm-modules' npx jest tests/sync.test.ts -t 'FTS5'`
Expected: FAIL — `applic_text_block_fts` virtual table doesn't exist.

- [ ] **Step 3: Add FTS5 virtual table to `TABLE_METADATA`**

In `src/db.ts`, after `reports_text_block`:

```typescript
  "applic_text_block_fts": {
    "ddl": `
      CREATE VIRTUAL TABLE IF NOT EXISTS applic_text_block_fts USING fts5(
        APTB_TEXT,
        APTB_DESCRIPTION,
        content='applic_text_block',
        content_rowid='APTB_ID',
        tokenize='porter unicode61 remove_diacritics 2'
      );
    `
  },
```

(No `post_load_ddl` — FTS5 manages its own indexing.)

- [ ] **Step 4: Wire FTS5 rebuild into `performFullSync`**

In `src/sync.ts`, locate `performFullSync` (around line 311). After the `for (let i = 0; i < tablesToImport.length; i++)` loop completes and before the `meta` UPDATE block (look for `db.prepare('REPLACE INTO meta ...')`), insert:

```typescript
        // Rebuild the FTS5 index over the freshly-imported applic_text_block rows.
        // External-content FTS5 requires an explicit rebuild after bulk import.
        console.error('Rebuilding FTS5 index over applic_text_block...');
        const ftsDb = new Database(config.dbPath);
        try {
            ftsDb.exec(`INSERT INTO applic_text_block_fts(applic_text_block_fts) VALUES('rebuild');`);
        } finally {
            ftsDb.close();
        }
```

Place this immediately before the `const db = new Database(config.dbPath);` that handles the meta updates. The two DB handles are separate; both are short-lived.

- [ ] **Step 5: Run test to verify it passes**

Run: `NODE_OPTIONS='--experimental-vm-modules' npx jest tests/sync.test.ts -t 'FTS5'`
Expected: pass.

Run the full suite: `NODE_OPTIONS='--experimental-vm-modules' npx jest`. All prior tests + the new FTS5 test should pass.

- [ ] **Step 6: Commit**

```bash
git add src/db.ts src/sync.ts tests/sync.test.ts
git -c user.email='ciphernaut@proton.me' -c user.name='Sage Grigull' \
    commit -m "feat(sync): Build FTS5 index over applic_text_block on full sync."
```

---

## Task 9: T4-c — FTS5 incremental sync

Extends `applyCsvDiff` with a special branch for `applic_text_block` that maintains the FTS5 mirror on every Added/Updated/Deleted row.

**Files:**
- Modify: `src/sync.ts` (add FTS5 special-case in `applyCsvDiff`)
- Test: `tests/sync.test.ts` (FTS5 stays in step on incrementals)

- [ ] **Step 1: Write the failing test**

Append to the `describe('applyCsvDiffZip', ...)` block in `tests/sync.test.ts`:

```typescript
    test('applic_text_block incremental updates FTS5 mirror', async () => {
        const seedDb = new Database(dbPath);
        seedDb.exec(`
            INSERT INTO applic_text_block (APTB_ID, APTB_TEXT, APTB_DESCRIPTION)
                VALUES (10, 'Initial conditions for the licence.', 'Initial');
            INSERT INTO applic_text_block_fts(applic_text_block_fts) VALUES('rebuild');
        `);
        seedDb.close();

        // Change-zip: Update row 10's APTB_TEXT, Add row 20, Delete row 10's twin (none — should be no-op).
        buildChangeZip({
            'applic_text_block.csv':
                'APTB_ID,APTB_TABLE_PREFIX,APTB_TABLE_ID,LICENCE_NO,APTB_DESCRIPTION,APTB_CATEGORY,APTB_TEXT,APTB_ITEM,CHANGE\n' +
                '10,,,,Updated description,,Revised conditions about emission masks.,,Updated\n' +
                '20,,,,New description,,Newly added emission text.,,Added\n',
        });
        await applyCsvDiffZip(zipPath, dbPath);

        const db = new Database(dbPath, { readonly: true });
        // The old text "Initial conditions" should no longer match.
        const oldHits = db.prepare(`
            SELECT rowid FROM applic_text_block_fts WHERE applic_text_block_fts MATCH 'initial'
        `).all();
        // The new text "Revised conditions" should match for row 10.
        const newHits = db.prepare(`
            SELECT rowid FROM applic_text_block_fts WHERE applic_text_block_fts MATCH 'revised'
        `).all() as any[];
        // The added row 20 should match for "newly".
        const addedHits = db.prepare(`
            SELECT rowid FROM applic_text_block_fts WHERE applic_text_block_fts MATCH 'newly'
        `).all() as any[];
        db.close();

        expect(oldHits).toHaveLength(0);
        expect(newHits.map(h => h.rowid)).toEqual([10]);
        expect(addedHits.map(h => h.rowid)).toEqual([20]);
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `NODE_OPTIONS='--experimental-vm-modules' npx jest tests/sync.test.ts -t 'applic_text_block incremental'`
Expected: FAIL — FTS5 still shows the old row 10 text; row 20 isn't indexed.

- [ ] **Step 3: Add FTS5 special-case to `applyCsvDiff`**

In `src/sync.ts`, modify `applyCsvDiff` so that when `tableName === 'applic_text_block'`, the per-row inner loop performs the SELECT-old → FTS5 delete → base delete → base insert + FTS5 insert pattern. Replace the existing `apply` transaction body (the `for (const row of rows)` loop) with a branched version:

```typescript
    const isApplicTextBlock = tableName === 'applic_text_block';

    // FTS5-aware statements (only used when isApplicTextBlock).
    const selectOldStmt = isApplicTextBlock
        ? db.prepare(`SELECT APTB_TEXT, APTB_DESCRIPTION FROM applic_text_block WHERE APTB_ID = ?`)
        : null;
    const ftsDeleteStmt = isApplicTextBlock
        ? db.prepare(
            `INSERT INTO applic_text_block_fts(applic_text_block_fts, rowid, APTB_TEXT, APTB_DESCRIPTION)
             VALUES('delete', ?, ?, ?)`
        )
        : null;
    const ftsInsertStmt = isApplicTextBlock
        ? db.prepare(
            `INSERT INTO applic_text_block_fts(rowid, APTB_TEXT, APTB_DESCRIPTION) VALUES (?, ?, ?)`
        )
        : null;

    const apply = db.transaction(() => {
        for (const row of rows) {
            const change = row.CHANGE;
            const pkValues = pkCols.map(c => row[c]);

            // FTS5 delete must happen BEFORE the base DELETE — it needs the old values.
            if (isApplicTextBlock && (change === 'Deleted' || change === 'Updated')) {
                const aptbId = Number(row.APTB_ID);
                const old = selectOldStmt!.get(aptbId) as { APTB_TEXT?: string; APTB_DESCRIPTION?: string } | undefined;
                if (old) {
                    ftsDeleteStmt!.run(aptbId, old.APTB_TEXT ?? '', old.APTB_DESCRIPTION ?? '');
                }
            }

            if (change === 'Deleted') {
                deleteStmt.run(...pkValues);
            } else if (change === 'Added' || change === 'Updated') {
                deleteStmt.run(...pkValues);
                const values = dataCols.map(c => row[c] === '' ? null : row[c]);
                insertStmt.run(...values);
                if (isApplicTextBlock) {
                    const aptbId = Number(row.APTB_ID);
                    ftsInsertStmt!.run(
                        aptbId,
                        row.APTB_TEXT ?? '',
                        row.APTB_DESCRIPTION ?? '',
                    );
                }
            } else {
                console.error(`Unknown CHANGE='${change}' in ${tableName}; skipping row pk=${JSON.stringify(pkValues)}`);
            }
        }
    });
    apply();
```

Replace the previous version of `apply` and the surrounding statement preparation. Keep the existing `insertStmt` and `deleteStmt` declarations as they were — only the per-row branch changes.

- [ ] **Step 4: Run test to verify it passes**

Run: `NODE_OPTIONS='--experimental-vm-modules' npx jest tests/sync.test.ts -t 'applic_text_block incremental'`
Expected: pass.

Run the full sync test file: `NODE_OPTIONS='--experimental-vm-modules' npx jest tests/sync.test.ts`. All tests should still pass.

- [ ] **Step 5: Commit**

```bash
git add src/sync.ts tests/sync.test.ts
git -c user.email='ciphernaut@proton.me' -c user.name='Sage Grigull' \
    commit -m "feat(sync): Maintain FTS5 mirror for applic_text_block on incrementals."
```

---

## Task 10: T4-d — `search_application_text` MCP tool

Adds `searchApplicationText` to `src/logic.ts` and registers the `search_application_text` MCP tool. Returns snippet markup (FTS5's `snippet()` function) plus the keying columns; full text is reachable via `execute_sql` keyed on the returned `APTB_ID`.

**Files:**
- Modify: `src/logic.ts` (add `searchApplicationText`)
- Modify: `src/index.ts` (register tool + handler)
- Test: `tests/logic.test.ts` (FTS5 query + snippet markers)

- [ ] **Step 1: Write the failing test**

Add to `tests/logic.test.ts`:

```typescript
    test('searchApplicationText returns matching rows with snippets and BM25 ordering', () => {
        const db = new Database(dbPath);
        db.exec(`
            INSERT INTO applic_text_block (APTB_ID, LICENCE_NO, APTB_CATEGORY, APTB_DESCRIPTION, APTB_TEXT)
                VALUES (100, 'L100', 'SPCOND', 'Aviation conditions', 'Operation in aeronautical bands subject to ICAO standards.');
            INSERT INTO applic_text_block (APTB_ID, LICENCE_NO, APTB_CATEGORY, APTB_DESCRIPTION, APTB_TEXT)
                VALUES (101, 'L101', 'SPCOND', 'Marine conditions', 'Operation must comply with marine emergency procedures.');
            INSERT INTO applic_text_block_fts(applic_text_block_fts) VALUES('rebuild');
        `);
        db.close();

        const db2 = new Database(dbPath, { readonly: true });
        const results = searchApplicationText(db2, 'marine', 5) as any[];
        db2.close();
        expect(results).toHaveLength(1);
        expect(results[0]).toMatchObject({ APTB_ID: 101, LICENCE_NO: 'L101' });
        expect(results[0].snippet).toContain('«marine»');
    });
```

Add `searchApplicationText` to the imports.

- [ ] **Step 2: Run test to verify it fails**

Run: `NODE_OPTIONS='--experimental-vm-modules' npx jest tests/logic.test.ts -t 'searchApplicationText'`
Expected: FAIL — `searchApplicationText` not exported.

- [ ] **Step 3: Add `searchApplicationText` to `src/logic.ts`**

Append:

```typescript
export function searchApplicationText(
  db: Database.Database,
  ftsQuery: string,
  limit: number = 20
) {
  return db.prepare(`
    SELECT atb.APTB_ID, atb.LICENCE_NO, atb.APTB_CATEGORY, atb.APTB_DESCRIPTION,
           snippet(applic_text_block_fts, 0, '«', '»', '…', 32) AS snippet,
           bm25(applic_text_block_fts) AS rank
    FROM applic_text_block_fts
    JOIN applic_text_block atb ON atb.APTB_ID = applic_text_block_fts.rowid
    WHERE applic_text_block_fts MATCH ?
    ORDER BY rank
    LIMIT ?
  `).all(ftsQuery, limit);
}
```

- [ ] **Step 4: Register `search_application_text` MCP tool**

In `src/index.ts`, add `searchApplicationText` to the imports. After the `search_spectrum_band` tool definition, append:

```typescript
            {
                name: 'search_application_text',
                description: `
### [Licence Application Text Search]
Full-text search across licence application narrative (conditions, exemptions, special clauses).

## Usage
- Pass an FTS5 query string. Supports: phrase ("text in quotes"), AND/OR, NEAR/N, prefix*.
- Results return APTB_ID, LICENCE_NO, APTB_CATEGORY, APTB_DESCRIPTION, a snippet with «match» markers, and a BM25 rank score (lower is better).
- For full text of a matching APTB_ID, follow up with execute_sql: SELECT APTB_TEXT FROM applic_text_block WHERE APTB_ID = ...

## Input
- query: FTS5 query (e.g. 'aeronautical', '"marine emergency"', 'ICAO OR ITU')`,
                inputSchema: {
                    type: 'object',
                    properties: {
                        query: { type: 'string', description: 'FTS5 query string' },
                        limit: { type: 'number', description: 'Max rows (default 20)' },
                    },
                    required: ['query'],
                },
            },
```

Handler:

```typescript
        if (name === 'search_application_text') {
            const db = openDb();
            try {
                const results = searchApplicationText(
                    db,
                    args?.query as string,
                    (args?.limit as number) ?? 20
                );
                return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
            } finally { db.close(); }
        }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `NODE_OPTIONS='--experimental-vm-modules' npx jest`
Expected: pass. `npx tsc --noEmit` clean.

- [ ] **Step 6: Commit**

```bash
git add src/logic.ts src/index.ts tests/logic.test.ts
git -c user.email='ciphernaut@proton.me' -c user.name='Sage Grigull' \
    commit -m "feat(mcp): Add search_application_text FTS5-backed tool."
```

---

## Task 11: Align `execute_sql` description with actual materialised schema

Updates the `## Available tables` block in `execute_sql`'s description to reflect what's actually in `TABLE_METADATA` after this sprint. Drops the aspirational `access_area` and `antenna_pattern` entries (deferred to Sprint 4).

**Files:**
- Modify: `src/index.ts` (the description string for `execute_sql`)
- No test changes; smoke-check the MCP `tools/list` response.

- [ ] **Step 1: Update the description**

In `src/index.ts`, locate the `## Available tables` block inside the `execute_sql` tool definition (around line 248-253). Replace the table list with:

```
## Available tables
client, licence, site, device_details, antenna,
bsl, bsl_area, auth_spectrum_freq, auth_spectrum_area, satellite,
applic_text_block, applic_text_block_fts, reports_text_block,
client_type, fee_status, industry_cat,
licence_service, licence_subservice, licence_status,
nature_of_service, class_of_station, licensing_area, antenna_polarity,
meta
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Run the full test suite**

Run: `NODE_OPTIONS='--experimental-vm-modules' npx jest`
Expected: all in-scope tests pass.

Also run a build smoke-check:

```bash
npm run build
```
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git -c user.email='ciphernaut@proton.me' -c user.name='Sage Grigull' \
    commit -m "docs(mcp): Align execute_sql description with the actual materialised schema."
```

---

## Self-Review

**Spec coverage:**
- [x] T1 — 10 lookup tables — Task 2 (schemas), Task 3 (JOINs).
- [x] T2 — bsl + bsl_area + search_bsl — Task 4.
- [x] T2 — auth_spectrum_freq + auth_spectrum_area + search_spectrum_band — Task 5.
- [x] T3 — satellite + getLicenceDetails JOIN — Task 6.
- [x] T4 — applic_text_block + reports_text_block — Task 7.
- [x] T4 — FTS5 virtual table + rebuild on full sync — Task 8.
- [x] T4 — FTS5 incremental sync — Task 9.
- [x] T4 — search_application_text — Task 10.
- [x] Composite-PK support in applyCsvDiff — Task 1 (foundation).
- [x] `execute_sql` description update — Task 11.

**Placeholder scan:** No TBDs, no "add validation", no "similar to Task N", no test-without-code steps.

**Type consistency:** `PK_BY_TABLE: Record<string, string | string[]>` introduced in Task 1, expanded once in Task 2 to cover all 22 entries; never re-edited after that. `searchBsl`, `searchSpectrumBand`, `searchApplicationText` exported from `src/logic.ts` with consistent `db: Database.Database` first-param convention. Tool names (`search_bsl`, `search_spectrum_band`, `search_application_text`) match between tool definition and handler dispatcher in every task.

**Notes for the executing agent:**
- Every commit MUST use `git -c user.email='ciphernaut@proton.me' -c user.name='Sage Grigull' commit ...` per repo memory. No `Co-Authored-By:` trailers.
- The pre-existing `sql_transaction.test.ts` and `sql_crossjoin.test.ts` empty-suite failures are out of scope — they fail at the baseline and should be ignored in any "all tests pass" claim. Only `Tests: N passed` counts.
- After Task 8, the FTS5 virtual table appears in `tools/list` of `pragma_module_list`; this is harmless. The materialised tables list in Task 11 includes `applic_text_block_fts` for completeness, so power users querying FTS5 directly via `execute_sql` know it exists.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-14-table-expansion.md`. Two execution options:

**1. Subagent-Driven (recommended)** — fresh subagent per task, two-stage review (spec + code quality) between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
