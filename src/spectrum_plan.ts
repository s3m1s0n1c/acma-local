/**
 * Spectrum-plan helpers (lookup-only dataset alongside the RRL mirror).
 *
 * See docs/superpowers/specs/2026-05-14-spectrum-plan-integration-design.md.
 */

import type { Database as BetterSqlite3Database } from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { log } from './logger.js';
import { TABLE_METADATA } from './db.js';

const UNIT_MULTIPLIER: Record<string, number> = {
    'Hz': 1,
    'kHz': 1_000,
    'MHz': 1_000_000,
    'GHz': 1_000_000_000,
    'THz': 1_000_000_000_000,
};

const TOP_OF_SPECTRUM_HZ = 3_000_000_000_000;  // 3 THz sentinel for open-ended bands

/**
 * Parse a frequency-range string + unit into integer Hz bounds.
 *
 * Examples:
 *   parseFrequencyRange('87-88', 'MHz')        → { 87_000_000, 88_000_000 }
 *   parseFrequencyRange('9-14 kHz', 'kHz')     → { 9_000, 14_000 }
 *   parseFrequencyRange('3000-', 'GHz')        → { 3 THz, 3 THz } (open-ended)
 *
 * Accepts en-dash (U+2013) as well as hyphen separator. Trailing unit token
 * inside the range string is stripped before parsing.
 */
export function parseFrequencyRange(rangeText: string, unit: string): { freq_start_hz: number; freq_end_hz: number } {
    // Normalise to canonical mixed-case key (e.g. "KHZ" → "kHz", "MHZ" → "MHz").
    const canonicalUnit = Object.keys(UNIT_MULTIPLIER).find(
        k => k.toLowerCase() === unit.toLowerCase()
    ) ?? unit;
    const multiplier = UNIT_MULTIPLIER[canonicalUnit];
    if (multiplier === undefined) {
        throw new Error(`parseFrequencyRange: unknown unit "${unit}"`);
    }

    // Strip a trailing unit token (e.g. "9-14 kHz" → "9-14") and whitespace.
    const stripped = rangeText
        .replace(/\b(Hz|kHz|MHz|GHz|THz)\b/g, '')
        .trim();

    // Normalise en-dash to ASCII hyphen.
    const normalised = stripped.replace(/–/g, '-');

    // Open-ended entry: "3000-" → parse actual start; freq_end_hz uses 3 THz sentinel.
    const openMatch = normalised.match(/^(\d+(?:\.\d+)?)\s*-\s*$/);
    if (openMatch) {
        const start = Number(openMatch[1]);
        return {
            freq_start_hz: Math.round(start * multiplier),
            freq_end_hz: TOP_OF_SPECTRUM_HZ,
        };
    }

    const parts = normalised.split(/\s*-\s*/);
    if (parts.length !== 2) {
        throw new Error(`parseFrequencyRange: malformed range "${rangeText}"`);
    }

    const start = Number(parts[0]);
    const end = Number(parts[1]);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
        throw new Error(`parseFrequencyRange: non-numeric bound in "${rangeText}"`);
    }
    if (end < start) {
        throw new Error(`parseFrequencyRange: end (${end}) < start (${start}) in "${rangeText}"`);
    }

    return {
        freq_start_hz: Math.round(start * multiplier),
        freq_end_hz: Math.round(end * multiplier),
    };
}

const SPECTRUM_TABLES = [
    'spectrum_allocations',
    'spectrum_region_allocations',
    'spectrum_australian_footnotes',
    'spectrum_international_footnotes',
    'spectrum_plan_meta',
] as const;

/**
 * Drop and recreate all spectrum_* tables using the current DDL from TABLE_METADATA.
 * Used when a legacy schema is detected, to migrate to the new column layout.
 */
export function resetSpectrumTables(db: BetterSqlite3Database): void {
    db.exec(`
        DROP TABLE IF EXISTS spectrum_allocations;
        DROP TABLE IF EXISTS spectrum_region_allocations;
        DROP TABLE IF EXISTS spectrum_australian_footnotes;
        DROP TABLE IF EXISTS spectrum_international_footnotes;
        DROP TABLE IF EXISTS spectrum_plan_meta;
    `);
    for (const name of SPECTRUM_TABLES) {
        const meta = TABLE_METADATA[name];
        if (!meta) continue;
        db.exec(meta.ddl);
        if (meta.post_load_ddl) db.exec(meta.post_load_ddl);
    }
}

/**
 * Returns true if spectrum_allocations exists but has the old column layout
 * (pre-Task-9 schema: frequency_range TEXT or region1 TEXT columns).
 */
export function spectrumSchemaIsLegacy(db: BetterSqlite3Database): boolean {
    const cols = db.prepare("PRAGMA table_info(spectrum_allocations)").all() as Array<{ name: string }>;
    if (cols.length === 0) return false;
    return cols.some(c => c.name === 'frequency_range' || c.name === 'region1');
}

/**
 * Auto-bootstrap helper: if spectrum_allocations is empty AND the seed file
 * exists at the given path, apply it. If the table has the legacy schema,
 * drops and recreates all spectrum_* tables first.
 *
 * Used at the tail of performFullSync so that "delete acma.db and rebuild"
 * produces a complete schema. Failure modes are non-fatal — a missing/malformed
 * seed logs a warning and leaves spectrum tables empty (the MCP server still
 * runs without them).
 */
export function bootstrapSpectrumPlan(db: BetterSqlite3Database, seedPath: string): void {
    // Migrate legacy schema if present.
    if (spectrumSchemaIsLegacy(db)) {
        console.error('[SPECTRUM] Legacy schema detected — dropping and recreating spectrum tables.');
        resetSpectrumTables(db);
    }

    const n = (db.prepare('SELECT COUNT(*) AS n FROM spectrum_allocations').get() as { n: number }).n;
    if (n > 0) {
        return;
    }
    if (!fs.existsSync(seedPath)) {
        log.warn(`[SPECTRUM] Bootstrap skipped: no seed at ${seedPath}`);
        return;
    }
    try {
        log.info(`[SPECTRUM] Bootstrapping spectrum tables from ${seedPath}`);
        const sql = fs.readFileSync(seedPath, 'utf-8');
        db.exec(sql);
    } catch (e) {
        log.error(`[SPECTRUM] Bootstrap failed: ${(e as Error).message}. Spectrum tables remain empty.`);
    }
}

export interface FootnoteEntry {
    ref: string;
    text: string;
    page?: number;
}

export interface ServiceEntry {
    name: string;
    primary: boolean;
    inline_footnotes: string[];
    qualifier?: string;
}

export interface AllocationEntry {
    freq_start_hz: number;
    freq_end_hz: number;
    unit: string;
    page: number;
    services: ServiceEntry[];
    footnotes: string[];
    raw: string;
    footnote_details?: {
        australian: FootnoteEntry[];
        international: FootnoteEntry[];
    };
}

export interface SourceProvenance {
    description: string | null;
    published_date: string | null;
    last_patch_date: string | null;
    imported_at: string | null;
}

export interface FrequencyAllocationResult {
    freq_hz: number;
    frequency_display: string;
    match_count: number;
    allocations: AllocationEntry[];
    source: SourceProvenance;
}

/**
 * Look up the ARSP allocation(s) covering a given frequency in Hz.
 *
 * Returns matching rows from spectrum_allocations with services and footnotes
 * parsed from JSON columns. When include_footnotes is true, also resolves
 * footnote text from spectrum_australian_footnotes and
 * spectrum_international_footnotes. Always returns an array shape
 * (`allocations: []`) regardless of match count.
 */
export function lookupFrequencyAllocation(
    db: BetterSqlite3Database,
    freq_hz: number,
    include_footnotes: boolean,
): FrequencyAllocationResult {
    const rows = db.prepare(`
        SELECT freq_start_hz, freq_end_hz, unit, page, services_json, footnotes_json, raw
        FROM spectrum_allocations
        WHERE ? BETWEEN freq_start_hz AND freq_end_hz
        ORDER BY freq_start_hz, freq_end_hz
    `).all(freq_hz) as Array<{
        freq_start_hz: number;
        freq_end_hz: number;
        unit: string;
        page: number;
        services_json: string;
        footnotes_json: string;
        raw: string;
    }>;

    const allocations: AllocationEntry[] = rows.map(r => {
        const services: ServiceEntry[] = r.services_json ? JSON.parse(r.services_json) as ServiceEntry[] : [];
        const footnotes: string[] = r.footnotes_json ? JSON.parse(r.footnotes_json) as string[] : [];
        const entry: AllocationEntry = {
            freq_start_hz: r.freq_start_hz,
            freq_end_hz: r.freq_end_hz,
            unit: r.unit,
            page: r.page,
            services,
            footnotes,
            raw: r.raw,
        };
        if (include_footnotes && footnotes.length > 0) {
            entry.footnote_details = resolveFootnotes(db, footnotes);
        }
        return entry;
    });

    return {
        freq_hz,
        frequency_display: formatFrequency(freq_hz),
        match_count: allocations.length,
        allocations,
        source: readSourceProvenance(db),
    };
}

function resolveFootnotes(db: BetterSqlite3Database, footnoteRefs: string[]): { australian: FootnoteEntry[]; international: FootnoteEntry[] } {
    const auRefs = footnoteRefs.filter(t => /^AUS/i.test(t));
    const intlRefs = footnoteRefs.filter(t => !/^AUS/i.test(t));

    const fetch = (table: string, refs: string[]): FootnoteEntry[] => {
        if (refs.length === 0) return [];
        const placeholders = refs.map(() => '?').join(',');
        const rows = db.prepare(
            `SELECT footnote_ref AS ref, footnote_text AS text, page FROM ${table} WHERE footnote_ref IN (${placeholders})`
        ).all(...refs) as FootnoteEntry[];
        // Preserve input order:
        const byRef = new Map(rows.map(r => [r.ref, r]));
        return refs.map(r => byRef.get(r)).filter((r): r is FootnoteEntry => r !== undefined);
    };

    return {
        australian: fetch('spectrum_australian_footnotes', auRefs),
        international: fetch('spectrum_international_footnotes', intlRefs),
    };
}

function readSourceProvenance(db: BetterSqlite3Database): SourceProvenance {
    const rows = db.prepare('SELECT key, value FROM spectrum_plan_meta').all() as Array<{ key: string; value: string }>;
    const map: Record<string, string> = {};
    for (const r of rows) map[r.key] = r.value;
    return {
        description: map['source_title'] ?? map['source_description'] ?? null,
        published_date: map['published_date'] ?? null,
        last_patch_date: map['last_patch_date'] ?? null,
        imported_at: map['imported_at'] ?? null,
    };
}

function formatFrequency(hz: number): string {
    if (hz < 1_000) return `${hz} Hz`;
    if (hz < 1_000_000) return `${(hz / 1_000).toFixed(3)} kHz`;
    if (hz < 1_000_000_000) return `${(hz / 1_000_000).toFixed(3)} MHz`;
    return `${(hz / 1_000_000_000).toFixed(3)} GHz`;
}

/**
 * @deprecated Use generate-spectrum-seed.ts CLI (npx tsx scripts/generate-spectrum-seed.ts)
 * instead. Kept for backwards compatibility only.
 */
export function applyReseed(db: BetterSqlite3Database, sourcePath: string): void {
    if (!fs.existsSync(sourcePath)) {
        throw new Error(`applyReseed: source not found: ${sourcePath}`);
    }
    const ext = path.extname(sourcePath).toLowerCase();
    if (ext !== '.sql') {
        throw new Error(`applyReseed: only .sql sources are supported in the new pipeline. Got: ${sourcePath}`);
    }
    resetSpectrumTables(db);
    const sql = fs.readFileSync(sourcePath, 'utf-8');
    db.exec(sql);
    const now = new Date().toISOString();
    db.prepare('INSERT OR REPLACE INTO spectrum_plan_meta(key, value) VALUES(?, ?)').run('imported_at', now);
    log.info(`[SPECTRUM] Reseeded from ${sourcePath}`);
}
