import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { initializeDatabase } from '../src/db.js';
import { buildFtsQuery, rebuildSearchIndex, searchEverything, searchEntityIds } from '../src/search_fts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('Cross-entity FTS search', () => {
    const scratchDir = path.join(__dirname, '../scratch_test_search_fts');
    const dbPath = path.join(scratchDir, 'test_acma.db');
    let db: Database.Database;

    beforeAll(() => {
        fs.mkdirSync(scratchDir, { recursive: true });
        initializeDatabase(dbPath);
        db = new Database(dbPath);
        db.exec(`
            INSERT INTO client
                (CLIENT_NO, LICENCEE, TRADING_NAME, ABN, POSTAL_STREET, POSTAL_SUBURB, POSTAL_STATE, POSTAL_POSTCODE)
                VALUES
                (123, 'Ian Nash', 'Nash Wireless', '11122233344', '1 Example Street', 'Newcastle', 'NSW', '2300'),
                (456, 'Ian Nash Services', NULL, '55566677788', '9 Harbour Road', 'Sydney', 'NSW', '2000');
            INSERT INTO licence (LICENCE_NO, CLIENT_NO, LICENCE_TYPE_NAME)
                VALUES ('LIC-123', 123, 'Apparatus'), ('LIC-456', 456, 'Spectrum');
            INSERT INTO site (SITE_ID, NAME, STATE, POSTCODE)
                VALUES ('SITE-1', 'Mount Example Radio Site', 'NSW', '2300');
            INSERT INTO device_details (SDD_ID, LICENCE_NO, SITE_ID, FREQUENCY)
                VALUES (1, 'LIC-123', 'SITE-1', 476625000);
            INSERT INTO applic_text_block (APTB_ID, LICENCE_NO, APTB_DESCRIPTION, APTB_TEXT)
                VALUES (99, 'LIC-123', 'Interference management', 'Special coordination near Newcastle harbour');
            INSERT INTO applic_text_block_fts(applic_text_block_fts) VALUES('rebuild');
        `);
        rebuildSearchIndex(db);
    });

    afterAll(() => {
        if (db.open) db.close();
        fs.rmSync(scratchDir, { recursive: true, force: true });
    });

    test('escapes user text into a safe prefix FTS query', () => {
        expect(buildFtsQuery('Ian Nash')).toBe('"Ian"* AND "Nash"*');
        expect(buildFtsQuery('  ABN: 111-222 ')).toBe('"ABN"* AND "111"* AND "222"*');
    });

    test('ranks exact client names ahead of prefixes', () => {
        expect(searchEntityIds(db, 'client', 'Ian Nash', 10)).toEqual(['123', '456']);
    });

    test('searches full postal addresses and identifiers without leading-wildcard scans', () => {
        expect(searchEntityIds(db, 'client', 'Example Street', 10)).toContain('123');
        expect(searchEntityIds(db, 'client', '11122233344', 10)).toContain('123');
        expect(searchEntityIds(db, 'licence', 'LIC-123', 10)).toContain('LIC-123');
        expect(searchEntityIds(db, 'site', 'Mount Example', 10)).toContain('SITE-1');
    });

    test('searches multiple entity types and reports deterministic match types', () => {
        const rows = searchEverything(db, 'LIC-123', ['client', 'licence'], true, 20);
        expect(rows[0]).toMatchObject({ ENTITY_TYPE: 'licence', ENTITY_ID: 'LIC-123', MATCH_TYPE: 'exact_id', RELATED_COUNT: 1 });
    });

    test('uses the existing application narrative FTS index', () => {
        const rows = searchEverything(db, 'coordination harbour', ['application'], false, 10);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ ENTITY_TYPE: 'application', ENTITY_ID: '99' });
    });

    test('falls back to substring matching only when FTS has no matches', () => {
        const rows = searchEverything(db, 'ample Street', ['client'], false, 10);
        expect(rows[0]).toMatchObject({ ENTITY_TYPE: 'client', ENTITY_ID: '123', MATCH_TYPE: 'substring' });
    });
});
