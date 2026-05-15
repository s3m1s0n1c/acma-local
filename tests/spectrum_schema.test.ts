import { describe, expect, test } from '@jest/globals';
import Database from 'better-sqlite3';
import { TABLE_METADATA } from '../src/db.js';

describe('spectrum schema', () => {
    test('spectrum_allocations has new shape', () => {
        const meta = TABLE_METADATA['spectrum_allocations'];
        expect(meta).toBeDefined();
        const sql = meta!.ddl;
        expect(sql).toContain('services_json');
        expect(sql).toContain('footnotes_json');
        expect(sql).toContain('raw');
        expect(sql).toContain('page');
        expect(sql).not.toContain('region1');
        expect(sql).not.toContain('australian_table_of_allocations');
    });

    test('spectrum_region_allocations is declared', () => {
        const meta = TABLE_METADATA['spectrum_region_allocations'];
        expect(meta).toBeDefined();
        expect(meta!.ddl).toContain('region INTEGER');
    });

    test('spectrum_australian_footnotes has page column', () => {
        const sql = TABLE_METADATA['spectrum_australian_footnotes']!.ddl;
        expect(sql).toContain('page');
    });

    test('schema is creatable on a fresh DB', () => {
        const db = new Database(':memory:');
        for (const meta of Object.values(TABLE_METADATA)) {
            db.exec(meta.ddl);
            if (meta.post_load_ddl) {
                db.exec(meta.post_load_ddl);
            }
        }
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
        const names = tables.map(t => t.name);
        expect(names).toContain('spectrum_allocations');
        expect(names).toContain('spectrum_region_allocations');
        db.close();
    });
});
