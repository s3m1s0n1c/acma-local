import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { initializeDatabase } from '../src/db.js';
import { getRecord, searchRecords } from '../src/search.js';
import { parseFrequencyHz, searchFrequencies } from '../src/frequency.js';
import { ResultCache } from '../src/result_cache.js';

describe('MCP v2 search core', () => {
  let directory: string;
  let databasePath: string;
  let db: Database.Database;

  beforeAll(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'acma-search-v2-'));
    databasePath = path.join(directory, 'test.db');
    initializeDatabase(databasePath);
    db = new Database(databasePath);
    db.exec(`
      INSERT INTO client (
        CLIENT_NO, LICENCEE, TRADING_NAME, ABN, ACN,
        POSTAL_STREET, POSTAL_SUBURB, POSTAL_STATE, POSTAL_POSTCODE
      ) VALUES (
        101, 'Ian Nash', 'Nash Radio', '11122233344', '123456789',
        '1 Example Street', 'Newcastle', 'NSW', '2300'
      );

      INSERT INTO licence (
        LICENCE_NO, CLIENT_NO, LICENCE_TYPE_NAME, STATUS_TEXT, BSL_NO
      ) VALUES ('1234567/1', 101, 'Apparatus', 'Granted', '85');

      INSERT INTO site (
        SITE_ID, NAME, STATE, POSTCODE, LATITUDE, LONGITUDE
      ) VALUES ('S100', 'Mount Example', 'NSW', '2300', -32.9, 151.7);

      INSERT INTO device_details (
        SDD_ID, LICENCE_NO, DEVICE_REGISTRATION_IDENTIFIER,
        FORMER_DEVICE_IDENTIFIER, FREQUENCY, BANDWIDTH, EMISSION,
        SITE_ID, CALL_SIGN, STATION_NAME
      ) VALUES (
        5001, '1234567/1', 'DEV-5001', 'OLD-5001',
        476425000, 12500, '16K0F3E', 'S100', 'VK2ABC', 'Newcastle Base'
      );

      INSERT INTO bsl (
        BSL_NO, CALL_SIGN, ON_AIR_ID, AREA_CODE
      ) VALUES (85, '2ABC', 'ABC Newcastle', 1);
      INSERT INTO bsl_area (AREA_CODE, AREA_NAME) VALUES (1, 'Newcastle');
    `);
  });

  afterAll(() => {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  test('finds a person by name and returns the postal address', () => {
    const rows = searchRecords(db, { query: 'Ian Nash', limit: 10 });
    expect(rows[0]).toMatchObject({
      ENTITY_TYPE: 'client',
      ENTITY_ID: '101',
      PRIMARY_TEXT: 'Ian Nash',
      MATCH_FIELD: 'LICENCEE',
      MATCH_KIND: 'exact',
      CLIENT_NO: 101,
      ADDRESS: '1 Example Street, Newcastle, NSW, 2300',
    });
  });

  test('resolves a call sign to its licence holder and address in one search', () => {
    const rows = searchRecords(db, {
      query: 'vk2abc',
      entity_types: ['callsign'],
      limit: 10,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ENTITY_TYPE: 'callsign',
      PRIMARY_TEXT: 'VK2ABC',
      LICENCE_NO: '1234567/1',
      CLIENT_NO: 101,
      SECONDARY_TEXT: 'Ian Nash',
      ADDRESS: '1 Example Street, Newcastle, NSW, 2300',
      ASSIGNMENT_COUNT: 1,
    });
  });

  test('opens a call sign with related assignment details', () => {
    const result = getRecord(db, 'callsign', 'VK2ABC', true, 20) as any;
    expect(result.call_sign).toBe('VK2ABC');
    expect(result.assignments[0]).toMatchObject({
      FREQUENCY: 476425000,
      LICENCEE: 'Ian Nash',
      POSTAL_STREET: '1 Example Street',
    });
  });

  test('finds exact device identifiers without a broad substring scan', () => {
    const rows = searchRecords(db, {
      query: 'DEV-5001',
      entity_types: ['device'],
      limit: 10,
    });
    expect(rows[0]).toMatchObject({
      ENTITY_TYPE: 'device',
      ENTITY_ID: '5001',
      MATCH_FIELD: 'DEVICE_REGISTRATION_IDENTIFIER',
      MATCH_KIND: 'exact',
      FREQUENCY_HZ: 476425000,
    });
  });

  test('interprets 476.425 as MHz and matches only 476425000 Hz', () => {
    expect(parseFrequencyHz(476.425, 'auto')).toBe(476425000);
    const result = searchFrequencies(db, {
      frequency: 476.425,
      unit: 'auto',
      tolerance_hz: 0,
    });
    expect(result.query).toMatchObject({
      requested_frequency_hz: 476425000,
      min_hz: 476425000,
      max_hz: 476425000,
      exact: true,
    });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      FREQUENCY_HZ: 476425000,
      DISTANCE_HZ: 0,
      MATCH_TYPE: 'exact',
      LICENCEE: 'Ian Nash',
    });
  });

  test('accepts explicit MHz strings and raw Hz values', () => {
    expect(parseFrequencyHz('476.425 MHz')).toBe(476425000);
    expect(parseFrequencyHz(476425000)).toBe(476425000);
    expect(parseFrequencyHz('476425000 Hz')).toBe(476425000);
  });

  test('does not silently return a nearby frequency for an exact miss', () => {
    const result = searchFrequencies(db, {
      frequency: 476.426,
      unit: 'MHz',
      tolerance_hz: 0,
    });
    expect(result.rows).toHaveLength(0);
  });

  test('creates the high-value device search indexes', () => {
    const names = (db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND name LIKE 'device_details_%_search_idx'
    `).all() as Array<{ name: string }>).map(row => row.name);
    expect(names).toEqual(expect.arrayContaining([
      'device_details_frequency_search_idx',
      'device_details_callsign_search_idx',
      'device_details_registration_search_idx',
      'device_details_former_search_idx',
      'device_details_efl_freq_search_idx',
      'device_details_efl_system_search_idx',
      'device_details_station_name_search_idx',
    ]));
  });
});

describe('compact result cache', () => {
  test('returns lossless columnar pages and reuses identical calls', () => {
    const cache = new ResultCache();
    const objects = [
      { CLIENT_NO: 1, LICENCEE: 'One' },
      { CLIENT_NO: 2, LICENCEE: 'Two' },
      { CLIENT_NO: 3, LICENCEE: 'Three' },
    ];
    const first = cache.putObjects('search_records', { query: 'test' }, objects);
    const page = cache.page(first.entry, 0, 2);
    expect(page).toMatchObject({
      total: 3,
      columns: ['CLIENT_NO', 'LICENCEE'],
      rows: [[1, 'One'], [2, 'Two']],
      has_more: true,
    });

    const repeated = cache.putObjects('search_records', { query: 'test' }, objects);
    expect(repeated.duplicate).toBe(true);
    expect(repeated.entry.id).toBe(first.entry.id);
  });
});
