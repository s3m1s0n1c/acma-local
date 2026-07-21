import { randomUUID } from 'node:crypto';

export interface CachedResult {
    id: string;
    tool: string;
    key: string;
    columns: string[];
    rows: unknown[][];
    expires: number;
}

export interface ResultPage {
    result_id: string;
    total: number;
    columns: string[];
    rows: unknown[][];
    offset: number;
    limit: number;
    returned: number;
    has_more: boolean;
}

function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
                .filter(([, v]) => v !== undefined)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([k, v]) => [k, canonical(v)])
        );
    }
    return value;
}

export function requestKey(tool: string, args: Record<string, unknown>): string {
    const relevant = { ...args };
    delete relevant['include_hints'];
    delete relevant['page_size'];
    delete relevant['offset'];
    return `${tool}:${JSON.stringify(canonical(relevant))}`;
}

export function objectRowsToColumnar(rows: Array<Record<string, unknown>>): {
    columns: string[];
    rows: unknown[][];
} {
    if (rows.length === 0) return { columns: [], rows: [] };
    const seen = new Set<string>();
    const columns: string[] = [];
    for (const row of rows) {
        for (const column of Object.keys(row)) {
            if (!seen.has(column)) {
                seen.add(column);
                columns.push(column);
            }
        }
    }
    return { columns, rows: rows.map(row => columns.map(column => row[column] ?? null)) };
}

export class ResultCache {
    private readonly byId = new Map<string, CachedResult>();
    private readonly byRequest = new Map<string, string>();

    constructor(private readonly ttlMs = 30 * 60 * 1000) {}

    put(tool: string, args: Record<string, unknown>, columns: string[], rows: unknown[][]): {
        entry: CachedResult;
        duplicate: boolean;
    } {
        this.cleanup();
        const key = requestKey(tool, args);
        const existingId = this.byRequest.get(key);
        const existing = existingId ? this.byId.get(existingId) : undefined;
        if (existing) return { entry: existing, duplicate: true };

        const id = randomUUID();
        const entry: CachedResult = {
            id,
            tool,
            key,
            columns,
            rows,
            expires: Date.now() + this.ttlMs,
        };
        this.byId.set(id, entry);
        this.byRequest.set(key, id);
        return { entry, duplicate: false };
    }

    putAnonymous(columns: string[], rows: unknown[][]): CachedResult {
        const id = randomUUID();
        const entry: CachedResult = {
            id,
            tool: 'anonymous',
            key: `anonymous:${id}`,
            columns,
            rows,
            expires: Date.now() + this.ttlMs,
        };
        this.byId.set(id, entry);
        return entry;
    }

    get(id: string): CachedResult | undefined {
        this.cleanup();
        return this.byId.get(id);
    }

    page(id: string, offset = 0, limit = 25): ResultPage | undefined {
        const entry = this.get(id);
        if (!entry) return undefined;
        const safeOffset = Number.isFinite(offset) ? Math.max(0, Math.trunc(offset)) : 0;
        const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(1, Math.trunc(limit)), 100) : 25;
        const rows = entry.rows.slice(safeOffset, safeOffset + safeLimit);
        return {
            result_id: entry.id,
            total: entry.rows.length,
            columns: entry.columns,
            rows,
            offset: safeOffset,
            limit: safeLimit,
            returned: rows.length,
            has_more: safeOffset + rows.length < entry.rows.length,
        };
    }

    cleanup(now = Date.now()): void {
        for (const [id, entry] of this.byId.entries()) {
            if (now <= entry.expires) continue;
            this.byId.delete(id);
            if (this.byRequest.get(entry.key) === id) this.byRequest.delete(entry.key);
        }
    }
}
