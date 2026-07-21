import { ResultCache, objectRowsToColumnar, requestKey } from '../src/result_cache.js';

describe('ResultCache', () => {
    test('converts object rows to a lossless columnar representation', () => {
        expect(objectRowsToColumnar([
            { CLIENT_NO: 1, LICENCEE: 'One' },
            { CLIENT_NO: 2, LICENCEE: 'Two', POSTCODE: '2000' },
        ])).toEqual({
            columns: ['CLIENT_NO', 'LICENCEE', 'POSTCODE'],
            rows: [[1, 'One', null], [2, 'Two', '2000']],
        });
    });

    test('deduplicates argument objects regardless of key order or response options', () => {
        expect(requestKey('search_clients', { query: 'Ian', limit: 50, page_size: 10 }))
            .toBe(requestKey('search_clients', { limit: 50, query: 'Ian', include_hints: true }));

        const cache = new ResultCache();
        const first = cache.put('search_clients', { query: 'Ian' }, ['CLIENT_NO'], [[1]]);
        const second = cache.put('search_clients', { query: 'Ian', include_hints: true }, ['CLIENT_NO'], [[1]]);
        expect(first.duplicate).toBe(false);
        expect(second.duplicate).toBe(true);
        expect(second.entry.id).toBe(first.entry.id);
    });

    test('returns bounded pages with has_more metadata', () => {
        const cache = new ResultCache();
        const { entry } = cache.put('search_clients', { query: 'Ian' }, ['id'], [[1], [2], [3]]);
        expect(cache.page(entry.id, 0, 2)).toMatchObject({
            total: 3,
            rows: [[1], [2]],
            returned: 2,
            has_more: true,
        });
        expect(cache.page(entry.id, 2, 2)).toMatchObject({
            rows: [[3]],
            returned: 1,
            has_more: false,
        });
    });
});
