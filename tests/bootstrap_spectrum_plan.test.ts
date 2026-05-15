import { describe, expect, test } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TABLE_METADATA } from '../src/db.js';
import { bootstrapSpectrumPlan, resetSpectrumTables, spectrumSchemaIsLegacy } from '../src/spectrum_plan.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SEED_PATH = path.join(__dirname, '..', 'seed', 'spectrum_plan.sql');

const SPECTRUM_TABLE_NAMES = [
    'spectrum_allocations',
    'spectrum_region_allocations',
    'spectrum_australian_footnotes',
    'spectrum_international_footnotes',
    'spectrum_plan_meta',
] as const;

/** Create an in-memory DB with current spectrum schema (no data). */
function freshSpectrumDb(): Database.Database {
    const db = new Database(':memory:');
    for (const name of SPECTRUM_TABLE_NAMES) {
        const meta = TABLE_METADATA[name]!;
        db.exec(meta.ddl);
        if (meta.post_load_ddl) db.exec(meta.post_load_ddl);
    }
    return db;
}

/** Create an in-memory DB with the LEGACY spectrum_allocations schema. */
function legacySpectrumDb(): Database.Database {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE spectrum_allocations(
        freq_start_hz INTEGER, freq_end_hz INTEGER,
        frequency_range TEXT PRIMARY KEY,
        unit TEXT,
        region1 TEXT, region2 TEXT, region3 TEXT,
        australian_table_of_allocations TEXT,
        common TEXT,
        footnote_ref TEXT
    )`);
    db.exec(`CREATE TABLE spectrum_australian_footnotes(footnote_ref TEXT PRIMARY KEY, footnote_text TEXT)`);
    db.exec(`CREATE TABLE spectrum_international_footnotes(footnote_ref TEXT PRIMARY KEY, footnote_text TEXT)`);
    db.exec(`CREATE TABLE spectrum_plan_meta(key TEXT PRIMARY KEY, value TEXT)`);
    return db;
}

describe('resetSpectrumTables', () => {
    test('drops and recreates tables with new schema', () => {
        const db = legacySpectrumDb();
        // Verify legacy column is present before reset.
        const before = db.prepare("PRAGMA table_info(spectrum_allocations)").all() as Array<{ name: string }>;
        expect(before.some(c => c.name === 'frequency_range')).toBe(true);

        resetSpectrumTables(db);

        const after = db.prepare("PRAGMA table_info(spectrum_allocations)").all() as Array<{ name: string }>;
        expect(after.some(c => c.name === 'frequency_range')).toBe(false);
        expect(after.some(c => c.name === 'services_json')).toBe(true);
        expect(after.some(c => c.name === 'footnotes_json')).toBe(true);
        expect(after.some(c => c.name === 'raw')).toBe(true);
        db.close();
    });

    test('creates spectrum_region_allocations table', () => {
        const db = legacySpectrumDb();
        resetSpectrumTables(db);

        const row = db.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='spectrum_region_allocations'"
        ).get() as { name: string } | undefined;
        expect(row?.name).toBe('spectrum_region_allocations');
        db.close();
    });
});

describe('spectrumSchemaIsLegacy', () => {
    test('returns false for new schema', () => {
        const db = freshSpectrumDb();
        expect(spectrumSchemaIsLegacy(db)).toBe(false);
        db.close();
    });

    test('returns true when frequency_range column present', () => {
        const db = legacySpectrumDb();
        expect(spectrumSchemaIsLegacy(db)).toBe(true);
        db.close();
    });

    test('returns false when table does not exist', () => {
        const db = new Database(':memory:');
        expect(spectrumSchemaIsLegacy(db)).toBe(false);
        db.close();
    });
});

describe('bootstrapSpectrumPlan', () => {
    test('loads generated SQL on empty DB', () => {
        const db = freshSpectrumDb();
        bootstrapSpectrumPlan(db, SEED_PATH);
        const n = (db.prepare('SELECT COUNT(*) AS n FROM spectrum_allocations').get() as { n: number }).n;
        expect(n).toBeGreaterThan(0);
        db.close();
    });

    test('skips when table is non-empty (idempotent)', () => {
        const db = freshSpectrumDb();
        // Insert a sentinel row.
        db.exec(`INSERT INTO spectrum_allocations(freq_start_hz, freq_end_hz, unit, page, services_json, footnotes_json, raw)
                 VALUES(1, 2, 'Hz', 1, '[]', '[]', 'sentinel')`);

        bootstrapSpectrumPlan(db, SEED_PATH);

        // Should still have exactly 1 row (seed not applied).
        const n = (db.prepare('SELECT COUNT(*) AS n FROM spectrum_allocations').get() as { n: number }).n;
        expect(n).toBe(1);
        const row = db.prepare("SELECT raw FROM spectrum_allocations").get() as { raw: string };
        expect(row.raw).toBe('sentinel');
        db.close();
    });

    test('resets legacy schema before loading', () => {
        const db = legacySpectrumDb();
        // Insert an old-schema row.
        db.exec(`INSERT INTO spectrum_allocations VALUES(87000000, 88000000, '87-88', 'MHz', 'BROADCASTING', '', '', '', '', '')`);

        bootstrapSpectrumPlan(db, SEED_PATH);

        // Legacy column must be gone.
        const cols = db.prepare("PRAGMA table_info(spectrum_allocations)").all() as Array<{ name: string }>;
        expect(cols.some(c => c.name === 'frequency_range')).toBe(false);
        expect(cols.some(c => c.name === 'services_json')).toBe(true);

        // Seed data must be loaded.
        const n = (db.prepare('SELECT COUNT(*) AS n FROM spectrum_allocations').get() as { n: number }).n;
        expect(n).toBeGreaterThan(0);
        db.close();
    });

    test('no-op (no throw) when seed file is missing', () => {
        const db = freshSpectrumDb();
        expect(() => bootstrapSpectrumPlan(db, '/nonexistent/seed.sql')).not.toThrow();
        const n = (db.prepare('SELECT COUNT(*) AS n FROM spectrum_allocations').get() as { n: number }).n;
        expect(n).toBe(0);
        db.close();
    });

    test('sets spectrum_plan_meta.imported_at after loading', () => {
        const db = freshSpectrumDb();
        bootstrapSpectrumPlan(db, SEED_PATH);
        const row = db.prepare("SELECT value FROM spectrum_plan_meta WHERE key='imported_at'").get() as { value: string } | undefined;
        expect(row?.value).toBeTruthy();
        db.close();
    });

    test('uses seed/patches dir relative to process.cwd for real path', () => {
        // Verify the seed path we're using actually exists (guards against path drift).
        expect(fs.existsSync(SEED_PATH)).toBe(true);
    });
});
