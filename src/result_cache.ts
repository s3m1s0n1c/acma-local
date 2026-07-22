import { randomUUID } from 'node:crypto';

export interface CachedResult {
  id: string;
  key: string;
  columns: string[];
  rows: unknown[][];
  createdAt: number;
  expiresAt: number;
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
  duplicate?: boolean;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function clamp(value: unknown, fallback: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(max, Math.trunc(parsed)));
}

export class ResultCache {
  private readonly byId = new Map<string, CachedResult>();
  private readonly byKey = new Map<string, string>();

  constructor(
    private readonly ttlMs = 30 * 60 * 1000,
    private readonly maxEntries = 200
  ) {}

  key(tool: string, args: unknown): string {
    return `${tool}:${stable(args)}`;
  }

  putObjects(tool: string, args: unknown, objects: Array<Record<string, unknown>>): {
    entry: CachedResult;
    duplicate: boolean;
  } {
    const columns: string[] = [];
    const seen = new Set<string>();
    for (const object of objects) {
      for (const column of Object.keys(object)) {
        if (!seen.has(column)) {
          seen.add(column);
          columns.push(column);
        }
      }
    }
    const rows = objects.map(object => columns.map(column => object[column] ?? null));
    return this.put(tool, args, columns, rows);
  }

  put(
    tool: string,
    args: unknown,
    columns: string[],
    rows: unknown[][]
  ): { entry: CachedResult; duplicate: boolean } {
    this.cleanup();
    const key = this.key(tool, args);
    const existingId = this.byKey.get(key);
    const existing = existingId ? this.byId.get(existingId) : undefined;
    if (existing) return { entry: existing, duplicate: true };

    if (this.byId.size >= this.maxEntries) {
      const oldest = [...this.byId.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
      if (oldest) this.remove(oldest.id);
    }

    const now = Date.now();
    const entry: CachedResult = {
      id: randomUUID(),
      key,
      columns,
      rows,
      createdAt: now,
      expiresAt: now + this.ttlMs,
    };
    this.byId.set(entry.id, entry);
    this.byKey.set(key, entry.id);
    return { entry, duplicate: false };
  }

  get(id: string): CachedResult | undefined {
    const entry = this.byId.get(id);
    if (!entry) return undefined;
    if (Date.now() >= entry.expiresAt) {
      this.remove(id);
      return undefined;
    }
    return entry;
  }

  page(entry: CachedResult, offsetValue: unknown = 0, limitValue: unknown = 10): ResultPage {
    const offset = clamp(offsetValue, 0, entry.rows.length);
    const limit = Math.max(1, clamp(limitValue, 10, 500));
    const rows = entry.rows.slice(offset, offset + limit);
    return {
      result_id: entry.id,
      total: entry.rows.length,
      columns: entry.columns,
      rows,
      offset,
      limit,
      returned: rows.length,
      has_more: offset + rows.length < entry.rows.length,
    };
  }

  private remove(id: string): void {
    const entry = this.byId.get(id);
    if (!entry) return;
    this.byId.delete(id);
    if (this.byKey.get(entry.key) === id) this.byKey.delete(entry.key);
  }

  cleanup(): void {
    const now = Date.now();
    for (const entry of this.byId.values()) {
      if (now >= entry.expiresAt) this.remove(entry.id);
    }
  }
}

export function objectToColumns(value: Record<string, unknown>): {
  columns: string[];
  rows: unknown[][];
} {
  const columns = Object.keys(value);
  return { columns, rows: [columns.map(column => value[column] ?? null)] };
}
