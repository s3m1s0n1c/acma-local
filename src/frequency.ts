import Database from 'better-sqlite3';

export type FrequencyUnit = 'auto' | 'Hz' | 'kHz' | 'MHz' | 'GHz';
export type FrequencyScope = 'assignments' | 'authorisations' | 'all';

export interface FrequencySearchInput {
  frequency: number | string;
  unit?: FrequencyUnit;
  to_frequency?: number | string;
  tolerance_hz?: number;
  scope?: FrequencyScope;
  limit?: number;
}

export interface FrequencyRow {
  ENTITY_TYPE: 'frequency_assignment' | 'frequency_authorisation';
  ENTITY_ID: string;
  FREQUENCY_HZ: number | null;
  LICENCE_NO: string | null;
  CLIENT_NO: number | null;
  LICENCEE: string | null;
  CALL_SIGN: string | null;
  DEVICE_IDENTIFIER: string | null;
  SITE_ID: string | null;
  SITE_NAME: string | null;
  STATE: string | null;
  POSTCODE: string | null;
  ADDRESS: string | null;
  MATCH_TYPE: 'exact' | 'range';
  DISTANCE_HZ: number | null;
  RANGE_START_HZ: number | null;
  RANGE_END_HZ: number | null;
}

const MULTIPLIER = { Hz: 1, kHz: 1e3, MHz: 1e6, GHz: 1e9 } as const;

function clampLimit(value: unknown, fallback = 10): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(1, Math.min(500, Math.trunc(number)));
}

function postalAddress(row: any): string | null {
  const parts = [
    row.POSTAL_STREET,
    row.POSTAL_SUBURB,
    row.POSTAL_STATE,
    row.POSTAL_POSTCODE,
  ].map(value => String(value ?? '').trim()).filter(Boolean);
  return parts.join(', ') || null;
}

export function parseFrequencyHz(value: number | string, unit: FrequencyUnit = 'auto'): number {
  let number: number;
  let suffix: Exclude<FrequencyUnit, 'auto'> | null = null;

  if (typeof value === 'number') {
    number = value;
  } else {
    const match = value.trim().replaceAll(',', '').match(
      /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*(hz|khz|mhz|ghz)?$/i
    );
    if (!match) throw new Error(`Invalid frequency: ${value}`);
    number = Number(match[1]);
    const rawSuffix = match[2]?.toLowerCase();
    if (rawSuffix === 'hz') suffix = 'Hz';
    if (rawSuffix === 'khz') suffix = 'kHz';
    if (rawSuffix === 'mhz') suffix = 'MHz';
    if (rawSuffix === 'ghz') suffix = 'GHz';
  }

  if (!Number.isFinite(number) || number <= 0) {
    throw new Error('Frequency must be a positive number.');
  }

  let resolved: Exclude<FrequencyUnit, 'auto'>;
  if (unit !== 'auto') resolved = unit;
  else if (suffix) resolved = suffix;
  else if (number >= 1_000_000) resolved = 'Hz';
  else resolved = 'MHz';

  return Math.round(number * MULTIPLIER[resolved]);
}

export function searchFrequencies(
  db: Database.Database,
  input: FrequencySearchInput
): {
  query: {
    requested_frequency_hz: number;
    min_hz: number;
    max_hz: number;
    exact: boolean;
    unit_rule: string;
  };
  rows: FrequencyRow[];
} {
  const requested = parseFrequencyHz(input.frequency, input.unit ?? 'auto');
  const other = input.to_frequency === undefined
    ? requested
    : parseFrequencyHz(input.to_frequency, input.unit ?? 'auto');
  const tolerance = Math.max(0, Math.trunc(Number(input.tolerance_hz) || 0));
  const minHz = Math.min(requested, other) - tolerance;
  const maxHz = Math.max(requested, other) + tolerance;
  const exact = requested === other && tolerance === 0;
  const scope = input.scope ?? 'assignments';
  const limit = clampLimit(input.limit);
  const rows: FrequencyRow[] = [];

  if (scope === 'assignments' || scope === 'all') {
    const assignments = db.prepare(`
      SELECT d.SDD_ID, d.FREQUENCY, d.LICENCE_NO, d.CALL_SIGN,
             d.DEVICE_REGISTRATION_IDENTIFIER, d.SITE_ID,
             l.CLIENT_NO, c.LICENCEE,
             c.POSTAL_STREET, c.POSTAL_SUBURB, c.POSTAL_STATE, c.POSTAL_POSTCODE,
             s.NAME AS SITE_NAME, s.STATE, s.POSTCODE
      FROM device_details d
      LEFT JOIN licence l ON l.LICENCE_NO = d.LICENCE_NO
      LEFT JOIN client c ON c.CLIENT_NO = l.CLIENT_NO
      LEFT JOIN site s ON s.SITE_ID = d.SITE_ID
      WHERE d.FREQUENCY BETWEEN @minHz AND @maxHz
      ORDER BY ABS(d.FREQUENCY - @requested), d.SDD_ID
      LIMIT @limit
    `).all({ minHz, maxHz, requested, limit }) as any[];

    for (const row of assignments) {
      rows.push({
        ENTITY_TYPE: 'frequency_assignment',
        ENTITY_ID: String(row.SDD_ID),
        FREQUENCY_HZ: row.FREQUENCY,
        LICENCE_NO: row.LICENCE_NO,
        CLIENT_NO: row.CLIENT_NO,
        LICENCEE: row.LICENCEE,
        CALL_SIGN: row.CALL_SIGN,
        DEVICE_IDENTIFIER: row.DEVICE_REGISTRATION_IDENTIFIER,
        SITE_ID: row.SITE_ID,
        SITE_NAME: row.SITE_NAME,
        STATE: row.STATE,
        POSTCODE: row.POSTCODE,
        ADDRESS: postalAddress(row),
        MATCH_TYPE: exact ? 'exact' : 'range',
        DISTANCE_HZ: Math.abs(Number(row.FREQUENCY) - requested),
        RANGE_START_HZ: null,
        RANGE_END_HZ: null,
      });
    }
  }

  if ((scope === 'authorisations' || scope === 'all') && rows.length < limit) {
    const authorisations = db.prepare(`
      SELECT f.LICENCE_NO, f.AREA_CODE, f.AREA_NAME,
             f.LW_FREQUENCY_START, f.LW_FREQUENCY_END,
             f.UP_FREQUENCY_START, f.UP_FREQUENCY_END,
             l.CLIENT_NO, c.LICENCEE
      FROM auth_spectrum_freq f
      LEFT JOIN licence l ON l.LICENCE_NO = f.LICENCE_NO
      LEFT JOIN client c ON c.CLIENT_NO = l.CLIENT_NO
      WHERE (f.LW_FREQUENCY_END >= @minHz AND f.LW_FREQUENCY_START <= @maxHz)
         OR (f.UP_FREQUENCY_END >= @minHz AND f.UP_FREQUENCY_START <= @maxHz)
      LIMIT @limit
    `).all({ minHz, maxHz, limit: limit - rows.length }) as any[];

    for (const row of authorisations) {
      const lowerMatch = row.LW_FREQUENCY_END >= minHz && row.LW_FREQUENCY_START <= maxHz;
      rows.push({
        ENTITY_TYPE: 'frequency_authorisation',
        ENTITY_ID: `${row.LICENCE_NO}:${row.AREA_CODE}`,
        FREQUENCY_HZ: null,
        LICENCE_NO: row.LICENCE_NO,
        CLIENT_NO: row.CLIENT_NO,
        LICENCEE: row.LICENCEE,
        CALL_SIGN: null,
        DEVICE_IDENTIFIER: null,
        SITE_ID: null,
        SITE_NAME: row.AREA_NAME,
        STATE: null,
        POSTCODE: null,
        ADDRESS: null,
        MATCH_TYPE: 'range',
        DISTANCE_HZ: null,
        RANGE_START_HZ: lowerMatch ? row.LW_FREQUENCY_START : row.UP_FREQUENCY_START,
        RANGE_END_HZ: lowerMatch ? row.LW_FREQUENCY_END : row.UP_FREQUENCY_END,
      });
    }
  }

  return {
    query: {
      requested_frequency_hz: requested,
      min_hz: minHz,
      max_hz: maxHz,
      exact,
      unit_rule: input.unit && input.unit !== 'auto'
        ? input.unit
        : 'auto: values below 1,000,000 are MHz; larger values are Hz',
    },
    rows,
  };
}
