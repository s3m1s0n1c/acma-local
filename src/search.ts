import Database from 'better-sqlite3';

export type EntityType =
  | 'client'
  | 'licence'
  | 'callsign'
  | 'device'
  | 'site'
  | 'broadcast'
  | 'application';

export interface RecordSearchInput {
  query: string;
  entity_types?: EntityType[];
  limit?: number;
}

export interface RecordSearchRow {
  ENTITY_TYPE: EntityType;
  ENTITY_ID: string;
  PRIMARY_TEXT: string | null;
  SECONDARY_TEXT: string | null;
  MATCH_FIELD: string;
  MATCH_KIND: 'exact' | 'prefix' | 'contains';
  MATCH_RANK: number;
  CLIENT_NO: number | null;
  LICENCE_NO: string | null;
  CALL_SIGN: string | null;
  ADDRESS: string | null;
  SITE_ID: string | null;
  STATE: string | null;
  POSTCODE: string | null;
  FREQUENCY_HZ: number | null;
  ASSIGNMENT_COUNT: number | null;
}

function text(value: unknown): string {
  return String(value ?? '').trim();
}

function clampLimit(value: unknown, fallback = 10, max = 500): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(max, Math.trunc(parsed)));
}

function address(row: any): string | null {
  const parts = [
    row.POSTAL_STREET,
    row.POSTAL_SUBURB,
    row.POSTAL_STATE,
    row.POSTAL_POSTCODE,
  ].map(text).filter(Boolean);
  return parts.join(', ') || null;
}

function classify(value: unknown, query: string) {
  const candidate = text(value).toLocaleLowerCase();
  const wanted = query.toLocaleLowerCase();
  if (candidate === wanted) return { MATCH_KIND: 'exact' as const, MATCH_RANK: 0 };
  if (candidate.startsWith(wanted)) return { MATCH_KIND: 'prefix' as const, MATCH_RANK: 10 };
  return { MATCH_KIND: 'contains' as const, MATCH_RANK: 20 };
}

function bestField(query: string, values: Array<[string, unknown]>) {
  return values
    .filter(([, value]) => text(value).toLocaleLowerCase().includes(query.toLocaleLowerCase()))
    .map(([field, value]) => ({ field, ...classify(value, query) }))
    .sort((a, b) => a.MATCH_RANK - b.MATCH_RANK)[0];
}

function baseRow(type: EntityType, id: unknown): Pick<
  RecordSearchRow,
  'ENTITY_TYPE' | 'ENTITY_ID' | 'CLIENT_NO' | 'LICENCE_NO' | 'CALL_SIGN' |
  'ADDRESS' | 'SITE_ID' | 'STATE' | 'POSTCODE' | 'FREQUENCY_HZ' | 'ASSIGNMENT_COUNT'
> {
  return {
    ENTITY_TYPE: type,
    ENTITY_ID: String(id),
    CLIENT_NO: null,
    LICENCE_NO: null,
    CALL_SIGN: null,
    ADDRESS: null,
    SITE_ID: null,
    STATE: null,
    POSTCODE: null,
    FREQUENCY_HZ: null,
    ASSIGNMENT_COUNT: null,
  };
}

function ftsQuery(query: string): string | null {
  const tokens = query.match(/[\p{L}\p{N}]+/gu)?.slice(0, 8) ?? [];
  return tokens.length ? tokens.map(token => `"${token}"*`).join(' AND ') : null;
}

export function searchRecords(db: Database.Database, input: RecordSearchInput): RecordSearchRow[] {
  const query = text(input.query);
  if (!query) return [];
  const limit = clampLimit(input.limit);
  const types = new Set<EntityType>(
    input.entity_types?.length
      ? input.entity_types
      : ['client', 'licence', 'callsign', 'device', 'site', 'broadcast']
  );
  const perType = Math.min(Math.max(limit, 10), 100);
  const params = {
    exact: query,
    prefix: `${query}%`,
    contains: `%${query}%`,
    numeric: /^\d+$/.test(query) ? Number(query) : -1,
    limit: perType,
  };
  const results: RecordSearchRow[] = [];

  if (types.has('client')) {
    const rows = db.prepare(`
      SELECT c.*, (SELECT COUNT(*) FROM licence l WHERE l.CLIENT_NO = c.CLIENT_NO) AS LICENCE_COUNT
      FROM client c
      WHERE CAST(c.CLIENT_NO AS TEXT) = @exact
         OR c.ABN = @exact COLLATE NOCASE
         OR c.ACN = @exact COLLATE NOCASE
         OR c.LICENCEE LIKE @contains COLLATE NOCASE
         OR c.TRADING_NAME LIKE @contains COLLATE NOCASE
         OR c.POSTAL_STREET LIKE @contains COLLATE NOCASE
         OR c.POSTAL_SUBURB LIKE @contains COLLATE NOCASE
         OR c.POSTAL_POSTCODE = @exact
      LIMIT @limit
    `).all(params) as any[];
    for (const row of rows) {
      const matched = bestField(query, [
        ['CLIENT_NO', row.CLIENT_NO], ['ABN', row.ABN], ['ACN', row.ACN],
        ['LICENCEE', row.LICENCEE], ['TRADING_NAME', row.TRADING_NAME],
        ['POSTAL_STREET', row.POSTAL_STREET], ['POSTAL_SUBURB', row.POSTAL_SUBURB],
        ['POSTAL_POSTCODE', row.POSTAL_POSTCODE],
      ]);
      if (!matched) continue;
      results.push({
        ...baseRow('client', row.CLIENT_NO),
        PRIMARY_TEXT: row.LICENCEE ?? row.TRADING_NAME ?? null,
        SECONDARY_TEXT: row.TRADING_NAME ?? `${row.LICENCE_COUNT} licence(s)`,
        MATCH_FIELD: matched.field,
        MATCH_KIND: matched.MATCH_KIND,
        MATCH_RANK: matched.MATCH_RANK,
        CLIENT_NO: row.CLIENT_NO,
        ADDRESS: address(row),
        STATE: row.POSTAL_STATE,
        POSTCODE: row.POSTAL_POSTCODE,
      });
    }
  }

  if (types.has('licence')) {
    const rows = db.prepare(`
      SELECT l.*, c.LICENCEE, c.TRADING_NAME,
             c.POSTAL_STREET, c.POSTAL_SUBURB, c.POSTAL_STATE, c.POSTAL_POSTCODE
      FROM licence l
      LEFT JOIN client c ON c.CLIENT_NO = l.CLIENT_NO
      WHERE l.LICENCE_NO LIKE @contains COLLATE NOCASE
         OR l.AP_PRJ_IDENT LIKE @contains COLLATE NOCASE
         OR l.SHIP_NAME LIKE @contains COLLATE NOCASE
      LIMIT @limit
    `).all(params) as any[];
    for (const row of rows) {
      const matched = bestField(query, [
        ['LICENCE_NO', row.LICENCE_NO], ['AP_PRJ_IDENT', row.AP_PRJ_IDENT], ['SHIP_NAME', row.SHIP_NAME],
      ]);
      if (!matched) continue;
      results.push({
        ...baseRow('licence', row.LICENCE_NO),
        PRIMARY_TEXT: row.LICENCE_NO,
        SECONDARY_TEXT: row.LICENCEE ?? row.LICENCE_TYPE_NAME ?? null,
        MATCH_FIELD: matched.field,
        MATCH_KIND: matched.MATCH_KIND,
        MATCH_RANK: matched.MATCH_RANK,
        CLIENT_NO: row.CLIENT_NO,
        LICENCE_NO: row.LICENCE_NO,
        ADDRESS: address(row),
        STATE: row.POSTAL_STATE,
        POSTCODE: row.POSTAL_POSTCODE,
      });
    }
  }

  if (types.has('callsign')) {
    const rows = db.prepare(`
      SELECT d.CALL_SIGN, d.LICENCE_NO, l.CLIENT_NO, c.LICENCEE, c.TRADING_NAME,
             c.POSTAL_STREET, c.POSTAL_SUBURB, c.POSTAL_STATE, c.POSTAL_POSTCODE,
             COUNT(*) AS ASSIGNMENT_COUNT
      FROM device_details d
      LEFT JOIN licence l ON l.LICENCE_NO = d.LICENCE_NO
      LEFT JOIN client c ON c.CLIENT_NO = l.CLIENT_NO
      WHERE d.CALL_SIGN IS NOT NULL AND d.CALL_SIGN <> ''
        AND (d.CALL_SIGN = @exact COLLATE NOCASE OR d.CALL_SIGN LIKE @prefix COLLATE NOCASE)
      GROUP BY d.CALL_SIGN, d.LICENCE_NO, l.CLIENT_NO, c.LICENCEE, c.TRADING_NAME,
               c.POSTAL_STREET, c.POSTAL_SUBURB, c.POSTAL_STATE, c.POSTAL_POSTCODE
      LIMIT @limit
    `).all(params) as any[];
    for (const row of rows) {
      const matched = classify(row.CALL_SIGN, query);
      results.push({
        ...baseRow('callsign', `${row.CALL_SIGN}:${row.LICENCE_NO ?? ''}`),
        PRIMARY_TEXT: row.CALL_SIGN,
        SECONDARY_TEXT: row.LICENCEE ?? row.TRADING_NAME ?? null,
        MATCH_FIELD: 'CALL_SIGN',
        ...matched,
        CLIENT_NO: row.CLIENT_NO,
        LICENCE_NO: row.LICENCE_NO,
        CALL_SIGN: row.CALL_SIGN,
        ADDRESS: address(row),
        STATE: row.POSTAL_STATE,
        POSTCODE: row.POSTAL_POSTCODE,
        ASSIGNMENT_COUNT: row.ASSIGNMENT_COUNT,
      });
    }
  }

  if (types.has('device')) {
    const searches = [
      ['DEVICE_REGISTRATION_IDENTIFIER', `DEVICE_REGISTRATION_IDENTIFIER IS NOT NULL AND DEVICE_REGISTRATION_IDENTIFIER <> '' AND (DEVICE_REGISTRATION_IDENTIFIER = @exact COLLATE NOCASE OR DEVICE_REGISTRATION_IDENTIFIER LIKE @prefix COLLATE NOCASE)`],
      ['FORMER_DEVICE_IDENTIFIER', `FORMER_DEVICE_IDENTIFIER IS NOT NULL AND FORMER_DEVICE_IDENTIFIER <> '' AND (FORMER_DEVICE_IDENTIFIER = @exact COLLATE NOCASE OR FORMER_DEVICE_IDENTIFIER LIKE @prefix COLLATE NOCASE)`],
      ['EFL_FREQ_IDENT', `EFL_FREQ_IDENT IS NOT NULL AND EFL_FREQ_IDENT <> '' AND (EFL_FREQ_IDENT = @exact COLLATE NOCASE OR EFL_FREQ_IDENT LIKE @prefix COLLATE NOCASE)`],
      ['EFL_SYSTEM', `EFL_SYSTEM IS NOT NULL AND EFL_SYSTEM <> '' AND (EFL_SYSTEM = @exact COLLATE NOCASE OR EFL_SYSTEM LIKE @prefix COLLATE NOCASE)`],
      ['STATION_NAME', `STATION_NAME IS NOT NULL AND STATION_NAME <> '' AND (STATION_NAME = @exact COLLATE NOCASE OR STATION_NAME LIKE @prefix COLLATE NOCASE)`],
    ] as const;
    if (/^\d+$/.test(query)) {
      const rows = db.prepare(`SELECT * FROM device_details WHERE SDD_ID = @numeric LIMIT @limit`).all(params) as any[];
      for (const row of rows) {
        results.push({
          ...baseRow('device', row.SDD_ID),
          PRIMARY_TEXT: String(row.SDD_ID),
          SECONDARY_TEXT: row.STATION_NAME ?? row.CALL_SIGN ?? row.LICENCE_NO ?? null,
          MATCH_FIELD: 'SDD_ID',
          MATCH_KIND: 'exact',
          MATCH_RANK: 0,
          LICENCE_NO: row.LICENCE_NO,
          CALL_SIGN: row.CALL_SIGN,
          SITE_ID: row.SITE_ID,
          FREQUENCY_HZ: row.FREQUENCY,
        });
      }
    }
    for (const [field, condition] of searches) {
      const rows = db.prepare(`SELECT * FROM device_details WHERE ${condition} LIMIT @limit`)
        .all({ ...params, limit: Math.min(perType, 25) }) as any[];
      for (const row of rows) {
        const matched = classify(row[field], query);
        results.push({
          ...baseRow('device', row.SDD_ID),
          PRIMARY_TEXT: text(row[field]) || String(row.SDD_ID),
          SECONDARY_TEXT: row.STATION_NAME ?? row.CALL_SIGN ?? row.LICENCE_NO ?? null,
          MATCH_FIELD: field,
          ...matched,
          LICENCE_NO: row.LICENCE_NO,
          CALL_SIGN: row.CALL_SIGN,
          SITE_ID: row.SITE_ID,
          FREQUENCY_HZ: row.FREQUENCY,
        });
      }
    }
  }

  if (types.has('site')) {
    const rows = db.prepare(`
      SELECT * FROM site
      WHERE SITE_ID = @exact COLLATE NOCASE
         OR NAME LIKE @contains COLLATE NOCASE
         OR POSTCODE = @exact
         OR STATE = @exact COLLATE NOCASE
      LIMIT @limit
    `).all(params) as any[];
    for (const row of rows) {
      const matched = bestField(query, [
        ['SITE_ID', row.SITE_ID], ['NAME', row.NAME], ['POSTCODE', row.POSTCODE], ['STATE', row.STATE],
      ]);
      if (!matched) continue;
      results.push({
        ...baseRow('site', row.SITE_ID),
        PRIMARY_TEXT: row.NAME ?? row.SITE_ID,
        SECONDARY_TEXT: [row.STATE, row.POSTCODE].filter(Boolean).join(' ') || null,
        MATCH_FIELD: matched.field,
        MATCH_KIND: matched.MATCH_KIND,
        MATCH_RANK: matched.MATCH_RANK,
        SITE_ID: row.SITE_ID,
        STATE: row.STATE,
        POSTCODE: row.POSTCODE,
      });
    }
  }

  if (types.has('broadcast')) {
    const rows = db.prepare(`
      SELECT b.*, a.AREA_NAME, l.LICENCE_NO, l.CLIENT_NO, c.LICENCEE,
             c.POSTAL_STREET, c.POSTAL_SUBURB, c.POSTAL_STATE, c.POSTAL_POSTCODE
      FROM bsl b
      LEFT JOIN bsl_area a ON a.AREA_CODE = b.AREA_CODE
      LEFT JOIN licence l ON CAST(l.BSL_NO AS TEXT) = CAST(b.BSL_NO AS TEXT)
      LEFT JOIN client c ON c.CLIENT_NO = l.CLIENT_NO
      WHERE b.CALL_SIGN = @exact COLLATE NOCASE
         OR b.CALL_SIGN LIKE @prefix COLLATE NOCASE
         OR CAST(b.BSL_NO AS TEXT) = @exact
         OR b.ON_AIR_ID = @exact COLLATE NOCASE
      LIMIT @limit
    `).all(params) as any[];
    for (const row of rows) {
      const matched = bestField(query, [
        ['CALL_SIGN', row.CALL_SIGN], ['BSL_NO', row.BSL_NO], ['ON_AIR_ID', row.ON_AIR_ID],
      ]);
      if (!matched) continue;
      results.push({
        ...baseRow('broadcast', row.BSL_NO),
        PRIMARY_TEXT: row.CALL_SIGN ?? String(row.BSL_NO),
        SECONDARY_TEXT: row.LICENCEE ?? row.AREA_NAME ?? null,
        MATCH_FIELD: matched.field,
        MATCH_KIND: matched.MATCH_KIND,
        MATCH_RANK: matched.MATCH_RANK,
        CLIENT_NO: row.CLIENT_NO,
        LICENCE_NO: row.LICENCE_NO,
        CALL_SIGN: row.CALL_SIGN,
        ADDRESS: address(row),
        STATE: row.POSTAL_STATE ?? row.BSL_STATE,
        POSTCODE: row.POSTAL_POSTCODE,
      });
    }
  }

  if (types.has('application')) {
    const fts = ftsQuery(query);
    if (fts) {
      const rows = db.prepare(`
        SELECT atb.APTB_ID, atb.LICENCE_NO, atb.APTB_CATEGORY, atb.APTB_DESCRIPTION,
               snippet(applic_text_block_fts, 0, '«', '»', '…', 24) AS SNIPPET,
               bm25(applic_text_block_fts) AS SCORE
        FROM applic_text_block_fts
        JOIN applic_text_block atb ON atb.APTB_ID = applic_text_block_fts.rowid
        WHERE applic_text_block_fts MATCH @fts
        ORDER BY SCORE
        LIMIT @limit
      `).all({ fts, limit: perType }) as any[];
      for (const row of rows) {
        results.push({
          ...baseRow('application', row.APTB_ID),
          PRIMARY_TEXT: row.APTB_DESCRIPTION ?? row.APTB_CATEGORY ?? String(row.APTB_ID),
          SECONDARY_TEXT: row.SNIPPET,
          MATCH_FIELD: 'APTB_TEXT',
          MATCH_KIND: 'contains',
          MATCH_RANK: 30,
          LICENCE_NO: row.LICENCE_NO,
        });
      }
    }
  }

  const unique = new Map<string, RecordSearchRow>();
  for (const row of results) {
    const key = `${row.ENTITY_TYPE}:${row.ENTITY_ID}`;
    const current = unique.get(key);
    if (!current || row.MATCH_RANK < current.MATCH_RANK) unique.set(key, row);
  }
  return [...unique.values()]
    .sort((a, b) =>
      a.MATCH_RANK - b.MATCH_RANK ||
      a.ENTITY_TYPE.localeCompare(b.ENTITY_TYPE) ||
      a.ENTITY_ID.localeCompare(b.ENTITY_ID)
    )
    .slice(0, limit);
}

export function getRecord(
  db: Database.Database,
  entityType: EntityType,
  id: string,
  includeRelated = true,
  relatedLimit = 20
): Record<string, unknown> | null {
  const exact = text(id);
  const limit = clampLimit(relatedLimit, 20, 100);
  if (!exact) return null;

  if (entityType === 'client') {
    const record = db.prepare(`SELECT * FROM client WHERE CAST(CLIENT_NO AS TEXT) = ?`).get(exact) as any;
    if (!record) return null;
    const result: Record<string, unknown> = { entity_type: 'client', record };
    if (includeRelated) {
      result.licences = db.prepare(`
        SELECT l.LICENCE_NO, l.LICENCE_TYPE_NAME, l.STATUS_TEXT, l.DATE_OF_EXPIRY,
               sv.SV_NAME AS SERVICE_NAME, ss.SS_NAME AS SUBSERVICE_NAME
        FROM licence l
        LEFT JOIN licence_service sv ON sv.SV_ID = l.SV_ID
        LEFT JOIN licence_subservice ss ON ss.SS_ID = l.SS_ID AND ss.SV_SV_ID = l.SV_ID
        WHERE l.CLIENT_NO = ? LIMIT ?
      `).all(record.CLIENT_NO, limit);
    }
    return result;
  }

  if (entityType === 'licence') {
    const record = db.prepare(`
      SELECT l.*, c.LICENCEE, c.TRADING_NAME, c.ABN, c.ACN,
             c.POSTAL_STREET, c.POSTAL_SUBURB, c.POSTAL_STATE, c.POSTAL_POSTCODE,
             sv.SV_NAME AS SERVICE_NAME, ss.SS_NAME AS SUBSERVICE_NAME,
             ls.STATUS_TEXT AS STATUS_NAME
      FROM licence l
      LEFT JOIN client c ON c.CLIENT_NO = l.CLIENT_NO
      LEFT JOIN licence_service sv ON sv.SV_ID = l.SV_ID
      LEFT JOIN licence_subservice ss ON ss.SS_ID = l.SS_ID AND ss.SV_SV_ID = l.SV_ID
      LEFT JOIN licence_status ls ON ls.STATUS = l.STATUS
      WHERE l.LICENCE_NO = ?
    `).get(exact) as any;
    if (!record) return null;
    const result: Record<string, unknown> = { entity_type: 'licence', record };
    if (includeRelated) {
      result.assignments = db.prepare(`
        SELECT d.SDD_ID, d.DEVICE_REGISTRATION_IDENTIFIER, d.FREQUENCY, d.BANDWIDTH,
               d.EMISSION, d.CALL_SIGN, d.STATION_NAME, d.SITE_ID,
               s.NAME AS SITE_NAME, s.STATE, s.POSTCODE, s.LATITUDE, s.LONGITUDE
        FROM device_details d LEFT JOIN site s ON s.SITE_ID = d.SITE_ID
        WHERE d.LICENCE_NO = ? LIMIT ?
      `).all(exact, limit);
    }
    return result;
  }

  if (entityType === 'site') {
    const record = db.prepare(`SELECT * FROM site WHERE SITE_ID = ?`).get(exact) as any;
    if (!record) return null;
    const result: Record<string, unknown> = { entity_type: 'site', record };
    if (includeRelated) {
      result.assignments = db.prepare(`
        SELECT SDD_ID, LICENCE_NO, DEVICE_REGISTRATION_IDENTIFIER, FREQUENCY,
               BANDWIDTH, EMISSION, CALL_SIGN, STATION_NAME
        FROM device_details WHERE SITE_ID = ? LIMIT ?
      `).all(exact, limit);
    }
    return result;
  }

  if (entityType === 'device') {
    const numeric = /^\d+$/.test(exact) ? Number(exact) : -1;
    const record = db.prepare(`
      SELECT d.*, l.CLIENT_NO, c.LICENCEE, c.TRADING_NAME,
             c.POSTAL_STREET, c.POSTAL_SUBURB, c.POSTAL_STATE, c.POSTAL_POSTCODE,
             s.NAME AS SITE_NAME, s.STATE, s.POSTCODE, s.LATITUDE, s.LONGITUDE
      FROM device_details d
      LEFT JOIN licence l ON l.LICENCE_NO = d.LICENCE_NO
      LEFT JOIN client c ON c.CLIENT_NO = l.CLIENT_NO
      LEFT JOIN site s ON s.SITE_ID = d.SITE_ID
      WHERE d.SDD_ID = @numeric
         OR d.DEVICE_REGISTRATION_IDENTIFIER = @exact COLLATE NOCASE
         OR d.FORMER_DEVICE_IDENTIFIER = @exact COLLATE NOCASE
         OR d.EFL_FREQ_IDENT = @exact COLLATE NOCASE
      LIMIT 1
    `).get({ numeric, exact }) as any;
    return record ? { entity_type: 'device', record } : null;
  }

  if (entityType === 'callsign') {
    const callSign = exact.split(':')[0]!;
    const assignments = db.prepare(`
      SELECT d.SDD_ID, d.CALL_SIGN, d.FREQUENCY, d.BANDWIDTH, d.EMISSION,
             d.LICENCE_NO, d.DEVICE_REGISTRATION_IDENTIFIER, d.STATION_NAME,
             d.SITE_ID, s.NAME AS SITE_NAME, s.STATE, s.POSTCODE,
             l.CLIENT_NO, c.LICENCEE, c.TRADING_NAME, c.ABN, c.ACN,
             c.POSTAL_STREET, c.POSTAL_SUBURB, c.POSTAL_STATE, c.POSTAL_POSTCODE
      FROM device_details d
      LEFT JOIN licence l ON l.LICENCE_NO = d.LICENCE_NO
      LEFT JOIN client c ON c.CLIENT_NO = l.CLIENT_NO
      LEFT JOIN site s ON s.SITE_ID = d.SITE_ID
      WHERE d.CALL_SIGN IS NOT NULL AND d.CALL_SIGN <> ''
        AND d.CALL_SIGN = ? COLLATE NOCASE
      LIMIT ?
    `).all(callSign, limit) as any[];
    return assignments.length ? { entity_type: 'callsign', call_sign: callSign, assignments } : null;
  }

  if (entityType === 'broadcast') {
    const record = db.prepare(`
      SELECT b.*, a.AREA_NAME, l.LICENCE_NO, l.CLIENT_NO,
             c.LICENCEE, c.TRADING_NAME, c.ABN, c.ACN,
             c.POSTAL_STREET, c.POSTAL_SUBURB, c.POSTAL_STATE, c.POSTAL_POSTCODE
      FROM bsl b
      LEFT JOIN bsl_area a ON a.AREA_CODE = b.AREA_CODE
      LEFT JOIN licence l ON CAST(l.BSL_NO AS TEXT) = CAST(b.BSL_NO AS TEXT)
      LEFT JOIN client c ON c.CLIENT_NO = l.CLIENT_NO
      WHERE CAST(b.BSL_NO AS TEXT) = @exact OR b.CALL_SIGN = @exact COLLATE NOCASE
      LIMIT 1
    `).get({ exact }) as any;
    return record ? { entity_type: 'broadcast', record } : null;
  }

  if (entityType === 'application') {
    const record = db.prepare(`SELECT * FROM applic_text_block WHERE CAST(APTB_ID AS TEXT) = ?`).get(exact) as any;
    return record ? { entity_type: 'application', record } : null;
  }

  return null;
}
