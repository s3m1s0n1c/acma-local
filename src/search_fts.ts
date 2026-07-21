import type Database from 'better-sqlite3';

const SEARCH_INDEX_VERSION = '1';
export type SearchEntityType = 'client' | 'licence' | 'site' | 'application';

export interface EverythingSearchRow {
    ENTITY_TYPE: SearchEntityType;
    ENTITY_ID: string;
    PRIMARY_TEXT: string | null;
    SECONDARY_TEXT: string | null;
    MATCH_TYPE: 'exact_id' | 'exact_phrase' | 'prefix' | 'fts' | 'substring';
    SCORE: number;
    RELATED_COUNT?: number;
}

function tokens(query: string): string[] {
    return query.normalize('NFKC').match(/[\p{L}\p{N}]+/gu) ?? [];
}

export function buildFtsQuery(query: string): string {
    return tokens(query)
        .map(token => `"${token.replace(/"/g, '""')}"*`)
        .join(' AND ');
}

export function rebuildSearchIndex(db: Database.Database): void {
    const rebuild = db.transaction(() => {
        db.exec('DELETE FROM rrl_search_fts;');
        db.exec(`
            INSERT INTO rrl_search_fts(entity_type, entity_id, primary_text, secondary_text, search_text)
            SELECT 'client', CAST(CLIENT_NO AS TEXT), COALESCE(LICENCEE, ''), COALESCE(TRADING_NAME, ''),
                   TRIM(COALESCE(CAST(CLIENT_NO AS TEXT), '') || ' ' || COALESCE(LICENCEE, '') || ' ' ||
                        COALESCE(TRADING_NAME, '') || ' ' || COALESCE(ABN, '') || ' ' || COALESCE(ACN, '') || ' ' ||
                        COALESCE(POSTAL_STREET, '') || ' ' || COALESCE(POSTAL_SUBURB, '') || ' ' ||
                        COALESCE(POSTAL_STATE, '') || ' ' || COALESCE(POSTAL_POSTCODE, ''))
            FROM client;

            INSERT INTO rrl_search_fts(entity_type, entity_id, primary_text, secondary_text, search_text)
            SELECT 'licence', l.LICENCE_NO, l.LICENCE_NO, COALESCE(c.LICENCEE, ''),
                   TRIM(COALESCE(l.LICENCE_NO, '') || ' ' || COALESCE(l.LICENCE_TYPE_NAME, '') || ' ' ||
                        COALESCE(l.LICENCE_CATEGORY_NAME, '') || ' ' || COALESCE(c.LICENCEE, '') || ' ' ||
                        COALESCE(c.TRADING_NAME, '') || ' ' || COALESCE(c.ABN, '') || ' ' || COALESCE(c.ACN, ''))
            FROM licence l
            LEFT JOIN client c ON c.CLIENT_NO = l.CLIENT_NO;

            INSERT INTO rrl_search_fts(entity_type, entity_id, primary_text, secondary_text, search_text)
            SELECT 'site', SITE_ID, COALESCE(NAME, ''),
                   TRIM(COALESCE(STATE, '') || ' ' || COALESCE(POSTCODE, '')),
                   TRIM(COALESCE(SITE_ID, '') || ' ' || COALESCE(NAME, '') || ' ' || COALESCE(STATE, '') || ' ' ||
                        COALESCE(POSTCODE, '') || ' ' || COALESCE(HCIS_L2, ''))
            FROM site;
        `);
        db.prepare('REPLACE INTO meta(key, value) VALUES (?, ?)')
            .run('rrl_search_fts_version', SEARCH_INDEX_VERSION);
    });
    rebuild();
}

export function ensureSearchIndex(db: Database.Database): void {
    const version = db.prepare("SELECT value FROM meta WHERE key = 'rrl_search_fts_version'")
        .get() as { value: string } | undefined;
    if (version?.value !== SEARCH_INDEX_VERSION) rebuildSearchIndex(db);
}

export function searchEntityIds(
    db: Database.Database,
    entityType: Exclude<SearchEntityType, 'application'>,
    query: string,
    limit: number
): string[] {
    const match = buildFtsQuery(query);
    if (!match) return [];
    try {
        return (db.prepare(`
            SELECT entity_id
            FROM rrl_search_fts
            WHERE rrl_search_fts MATCH ? AND entity_type = ?
            ORDER BY CASE
                WHEN LOWER(entity_id) = LOWER(?) THEN 0
                WHEN LOWER(primary_text) = LOWER(?) THEN 1
                WHEN LOWER(secondary_text) = LOWER(?) THEN 1
                WHEN LOWER(primary_text) LIKE LOWER(?) || '%' THEN 2
                ELSE 3 END,
                bm25(rrl_search_fts)
            LIMIT ?
        `).all(match, entityType, query, query, query, query, limit) as Array<{ entity_id: string }>)
            .map(row => row.entity_id);
    } catch {
        return [];
    }
}

function matchType(id: string, primary: string | null, secondary: string | null, query: string): EverythingSearchRow['MATCH_TYPE'] {
    const q = query.toLocaleLowerCase();
    if (id.toLocaleLowerCase() === q) return 'exact_id';
    if (primary?.toLocaleLowerCase() === q || secondary?.toLocaleLowerCase() === q) return 'exact_phrase';
    if (primary?.toLocaleLowerCase().startsWith(q)) return 'prefix';
    return 'fts';
}

export function searchEverything(
    db: Database.Database,
    query: string,
    entityTypes: SearchEntityType[] = ['client', 'licence', 'site', 'application'],
    includeRelated = false,
    limit = 100
): EverythingSearchRow[] {
    const clean = query.trim();
    const cap = Math.min(Math.max(1, Math.trunc(limit)), 500);
    const allowed = new Set(entityTypes);
    const out: EverythingSearchRow[] = [];
    const seen = new Set<string>();
    const match = buildFtsQuery(clean);

    if (match && [...allowed].some(type => type !== 'application')) {
        const indexedTypes = [...allowed].filter(type => type !== 'application');
        const placeholders = indexedTypes.map(() => '?').join(',');
        const hits = db.prepare(`
            SELECT entity_type, entity_id, primary_text, secondary_text, bm25(rrl_search_fts) AS score
            FROM rrl_search_fts
            WHERE rrl_search_fts MATCH ? AND entity_type IN (${placeholders})
            ORDER BY CASE
                WHEN LOWER(entity_id) = LOWER(?) THEN 0
                WHEN LOWER(primary_text) = LOWER(?) OR LOWER(secondary_text) = LOWER(?) THEN 1
                WHEN LOWER(primary_text) LIKE LOWER(?) || '%' THEN 2
                ELSE 3 END,
                score
            LIMIT ?
        `).all(match, ...indexedTypes, clean, clean, clean, clean, cap) as Array<{
            entity_type: Exclude<SearchEntityType, 'application'>;
            entity_id: string;
            primary_text: string | null;
            secondary_text: string | null;
            score: number;
        }>;
        for (const hit of hits) {
            const key = `${hit.entity_type}:${hit.entity_id}`;
            seen.add(key);
            const row: EverythingSearchRow = {
                ENTITY_TYPE: hit.entity_type,
                ENTITY_ID: hit.entity_id,
                PRIMARY_TEXT: hit.primary_text,
                SECONDARY_TEXT: hit.secondary_text,
                MATCH_TYPE: matchType(hit.entity_id, hit.primary_text, hit.secondary_text, clean),
                SCORE: hit.score,
            };
            if (includeRelated) {
                if (hit.entity_type === 'client') {
                    row.RELATED_COUNT = (db.prepare('SELECT COUNT(*) AS n FROM licence WHERE CLIENT_NO = ?').get(Number(hit.entity_id)) as { n: number }).n;
                } else if (hit.entity_type === 'licence') {
                    row.RELATED_COUNT = (db.prepare('SELECT COUNT(*) AS n FROM device_details WHERE LICENCE_NO = ?').get(hit.entity_id) as { n: number }).n;
                } else {
                    row.RELATED_COUNT = (db.prepare('SELECT COUNT(*) AS n FROM device_details WHERE SITE_ID = ?').get(hit.entity_id) as { n: number }).n;
                }
            }
            out.push(row);
        }
    }

    if (allowed.has('application') && out.length < cap && match) {
        const rows = db.prepare(`
            SELECT atb.APTB_ID, atb.LICENCE_NO, atb.APTB_DESCRIPTION,
                   bm25(applic_text_block_fts) AS score
            FROM applic_text_block_fts
            JOIN applic_text_block atb ON atb.APTB_ID = applic_text_block_fts.rowid
            WHERE applic_text_block_fts MATCH ?
            ORDER BY score
            LIMIT ?
        `).all(match, cap - out.length) as Array<{ APTB_ID: number; LICENCE_NO: string; APTB_DESCRIPTION: string; score: number }>;
        for (const row of rows) {
            out.push({
                ENTITY_TYPE: 'application',
                ENTITY_ID: String(row.APTB_ID),
                PRIMARY_TEXT: row.APTB_DESCRIPTION,
                SECONDARY_TEXT: row.LICENCE_NO,
                MATCH_TYPE: 'fts',
                SCORE: row.score,
            });
        }
    }

    // A leading-wildcard scan is deliberately a last resort. If FTS found
    // anything, keep those ranked results rather than scanning whole tables.
    const remaining = out.length === 0 ? cap : 0;
    if (remaining > 0 && clean) {
        const pattern = `%${clean.replace(/[\\%_]/g, '\\$&')}%`;
        const fallback: Array<{ type: Exclude<SearchEntityType, 'application'>; id: string; primary_text: string | null; secondary_text: string | null }> = [];
        if (allowed.has('client')) {
            fallback.push(...(db.prepare(`SELECT 'client' AS type, CAST(CLIENT_NO AS TEXT) AS id, LICENCEE AS primary_text, TRADING_NAME AS secondary_text FROM client WHERE LICENCEE LIKE ? ESCAPE '\\' OR TRADING_NAME LIKE ? ESCAPE '\\' OR POSTAL_STREET LIKE ? ESCAPE '\\' LIMIT ?`).all(pattern, pattern, pattern, remaining) as any[]));
        }
        if (allowed.has('licence')) {
            fallback.push(...(db.prepare(`SELECT 'licence' AS type, LICENCE_NO AS id, LICENCE_NO AS primary_text, LICENCE_TYPE_NAME AS secondary_text FROM licence WHERE LICENCE_NO LIKE ? ESCAPE '\\' LIMIT ?`).all(pattern, remaining) as any[]));
        }
        if (allowed.has('site')) {
            fallback.push(...(db.prepare(`SELECT 'site' AS type, SITE_ID AS id, NAME AS primary_text, TRIM(COALESCE(STATE,'') || ' ' || COALESCE(POSTCODE,'')) AS secondary_text FROM site WHERE NAME LIKE ? ESCAPE '\\' OR POSTCODE LIKE ? ESCAPE '\\' LIMIT ?`).all(pattern, pattern, remaining) as any[]));
        }
        for (const row of fallback) {
            const key = `${row.type}:${row.id}`;
            if (seen.has(key) || out.length >= cap) continue;
            out.push({ ENTITY_TYPE: row.type, ENTITY_ID: row.id, PRIMARY_TEXT: row.primary_text, SECONDARY_TEXT: row.secondary_text, MATCH_TYPE: 'substring', SCORE: 1000 });
            seen.add(key);
        }
    }

    const order = { exact_id: 0, exact_phrase: 1, prefix: 2, fts: 3, substring: 4 };
    return out.sort((a, b) => order[a.MATCH_TYPE] - order[b.MATCH_TYPE] || a.SCORE - b.SCORE).slice(0, cap);
}
