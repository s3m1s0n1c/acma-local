import { describe, expect, test } from '@jest/globals';
import { generateSeedSql, applyOverlay } from '../scripts/generate-spectrum-seed.js';

const baseDoc = {
    meta: {
        generation: 2,
        source: { title: 'X', pdf_sha256: 'abc', pdf_published: '2021-07', url: 'http://x' },
        extracted_at: '2026-05-15T00:00:00Z',
        extractor_version: '1.0.0',
    },
    au_allocations: [
        {
            freq_start_hz: 8300, freq_end_hz: 9000, unit: 'kHz', page: 25,
            services: [{ name: 'METEOROLOGICAL AIDS', primary: true, inline_footnotes: ['54A'] }],
            footnotes: [],
            raw: 'METEOROLOGICAL AIDS  54A',
        },
    ],
    region_allocations: [],
    au_footnotes: [{ ref: 'AUS1A', text: 'Example.', page: 107 }],
    intl_footnotes: [{ ref: '54A', text: 'Example intl.', page: 120 }],
};

describe('generateSeedSql', () => {
    test('produces deterministic SQL with BEGIN/COMMIT and meta rows', () => {
        const sql = generateSeedSql(baseDoc);
        expect(sql).toContain('BEGIN TRANSACTION;');
        expect(sql).toMatch(/COMMIT;\s*$/);
        expect(sql).toContain("INSERT INTO spectrum_allocations");
        expect(sql).toMatch(/INSERT( OR REPLACE)? INTO spectrum_australian_footnotes/);
        expect(sql).toContain("'pdf_sha256'");
        expect(sql).toContain("'abc'");
    });

    test('row_counts meta reflects post-overlay state', () => {
        const sql = generateSeedSql(baseDoc);
        expect(sql).toContain('"au_allocations":1');
    });
});

describe('applyOverlay', () => {
    test('replace_footnote updates AU footnote text', () => {
        const patched = applyOverlay(baseDoc, {
            meta: { patch_id: '2026-a', applied_to: 2, description: 't', source: {} },
            operations: [
                { op: 'replace_footnote', table: 'au_footnotes', ref: 'AUS1A', text: 'Updated.' },
            ],
        });
        expect(patched.au_footnotes.find((f: any) => f.ref === 'AUS1A')?.text).toBe('Updated.');
    });

    test('replace_allocation swaps an existing au row', () => {
        const patched = applyOverlay(baseDoc, {
            meta: { patch_id: '2026-b', applied_to: 2, description: 't', source: {} },
            operations: [
                {
                    op: 'replace_allocation',
                    freq_start_hz: 8300,
                    freq_end_hz: 9000,
                    new: {
                        freq_start_hz: 8300, freq_end_hz: 9000, unit: 'kHz', page: 25,
                        services: [{ name: 'NEW', primary: true, inline_footnotes: [] }],
                        footnotes: [], raw: 'NEW',
                    },
                },
            ],
        });
        expect(patched.au_allocations[0].services[0].name).toBe('NEW');
    });

    test('insert_allocation rejects duplicate key', () => {
        expect(() =>
            applyOverlay(baseDoc, {
                meta: { patch_id: '2026-c', applied_to: 2, description: 't', source: {} },
                operations: [
                    {
                        op: 'insert_allocation',
                        new: {
                            freq_start_hz: 8300, freq_end_hz: 9000, unit: 'kHz', page: 25,
                            services: [], footnotes: [], raw: '',
                        },
                    },
                ],
            }),
        ).toThrow(/already exists/);
    });

    test('delete_allocation removes the matching row', () => {
        const patched = applyOverlay(baseDoc, {
            meta: { patch_id: '2026-d', applied_to: 2, description: 't', source: {} },
            operations: [{ op: 'delete_allocation', freq_start_hz: 8300, freq_end_hz: 9000 }],
        });
        expect(patched.au_allocations.length).toBe(0);
    });
});
