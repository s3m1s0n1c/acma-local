import Database from 'better-sqlite3';

const MAX_SEARCH_RESULTS = 500;
const DEFAULT_DETAIL_LIMIT = 50;

function clampLimit(limit: number | undefined, fallback: number, max: number = MAX_SEARCH_RESULTS): number {
  if (!Number.isFinite(limit)) return fallback;
  return Math.min(Math.max(1, Math.trunc(limit!)), max);
}

/** Treat user input as text, rather than allowing `%` and `_` to become wildcards. */
function likePattern(query: string): string {
  const escaped = query.trim().replace(/[\\%_]/g, '\\$&');
  return `%${escaped}%`;
}

function cleanQuery(query: string): string {
  return typeof query === 'string' ? query.trim() : '';
}

export function searchSites(db: Database.Database, query: string, limit: number = 20) {
  const exact = cleanQuery(query);
  if (!exact) return [];
  const pattern = likePattern(exact);
  return db.prepare(`
    SELECT s.*, la.DESCRIPTION AS LICENSING_AREA_NAME,
           (SELECT COUNT(*) FROM device_details d WHERE d.SITE_ID = s.SITE_ID) AS DEVICE_COUNT
    FROM site s
    LEFT JOIN licensing_area la ON la.LICENSING_AREA_ID = s.LICENSING_AREA_ID
    WHERE s.SITE_ID LIKE @pattern ESCAPE '\\'
       OR s.NAME LIKE @pattern ESCAPE '\\'
       OR s.POSTCODE LIKE @pattern ESCAPE '\\'
       OR s.STATE LIKE @pattern ESCAPE '\\'
    ORDER BY CASE
      WHEN s.SITE_ID = @exact THEN 0
      WHEN s.POSTCODE = @exact THEN 1
      WHEN s.NAME = @exact COLLATE NOCASE THEN 2
      ELSE 3 END,
      s.NAME
    LIMIT @limit
  `).all({ pattern, exact, limit: clampLimit(limit, 20) });
}

export function getSiteDetails(db: Database.Database, siteId: string, deviceLimit: number = DEFAULT_DETAIL_LIMIT) {
  const site = db.prepare(`
    SELECT s.*, la.DESCRIPTION AS LICENSING_AREA_NAME
    FROM site s
    LEFT JOIN licensing_area la ON la.LICENSING_AREA_ID = s.LICENSING_AREA_ID
    WHERE s.SITE_ID = ?
  `).get(siteId);
  if (!site) return null;

  const total = (db.prepare(
    'SELECT COUNT(*) AS count FROM device_details WHERE SITE_ID = ?'
  ).get(siteId) as { count: number }).count;
  const maxDevices = clampLimit(deviceLimit, DEFAULT_DETAIL_LIMIT);
  const devices = db.prepare(`
    SELECT d.*,
           l.CLIENT_NO, l.STATUS AS LICENCE_STATUS,
           ls.STATUS_TEXT AS LICENCE_STATUS_NAME,
           c.LICENCEE, c.TRADING_NAME,
           sv.SV_NAME AS SERVICE_NAME,
           ss.SS_NAME AS SUBSERVICE_NAME,
           nos.DESCRIPTION AS NATURE_OF_SERVICE_NAME,
           cos.DESCRIPTION AS CLASS_OF_STATION_NAME,
           ap.POLARISATION_TEXT AS POLARISATION_NAME,
           ant.MANUFACTURER AS ANTENNA_MANUFACTURER,
           ant.MODEL AS ANTENNA_MODEL,
           ant.ANTENNA_TYPE
    FROM device_details d
    LEFT JOIN licence l ON l.LICENCE_NO = d.LICENCE_NO
    LEFT JOIN client c ON c.CLIENT_NO = l.CLIENT_NO
    LEFT JOIN licence_status ls ON ls.STATUS = l.STATUS
    LEFT JOIN licence_service sv ON sv.SV_ID = d.SV_ID
    LEFT JOIN licence_subservice ss ON ss.SS_ID = d.SS_ID AND ss.SV_SV_ID = d.SV_ID
    LEFT JOIN nature_of_service nos ON nos.CODE = d.NATURE_OF_SERVICE_ID
    LEFT JOIN class_of_station cos ON cos.CODE = d.CLASS_OF_STATION_CODE
    LEFT JOIN antenna_polarity ap ON ap.POLARISATION_CODE = d.POLARISATION
    LEFT JOIN antenna ant ON ant.ANTENNA_ID = d.ANTENNA_ID
    WHERE d.SITE_ID = ?
    ORDER BY d.FREQUENCY, d.SDD_ID
    LIMIT ?
  `).all(siteId, maxDevices);
  return {
    site,
    devices,
    devices_total: total,
    devices_returned: devices.length,
    devices_truncated: total > devices.length,
  };
}

// l.* includes licence.STATUS_TEXT (denormalised, may be stale).
// STATUS_NAME is the authoritative value from the licence_status lookup.
const LICENCE_SELECT = `
  SELECT l.*,
         sv.SV_NAME AS SERVICE_NAME,
         ss.SS_NAME AS SUBSERVICE_NAME,
         ls.STATUS_TEXT AS STATUS_NAME,
         c.LICENCEE, c.TRADING_NAME, c.ABN, c.ACN
  FROM licence l
  LEFT JOIN licence_service sv ON sv.SV_ID = l.SV_ID
  LEFT JOIN licence_subservice ss ON ss.SS_ID = l.SS_ID AND ss.SV_SV_ID = l.SV_ID
  LEFT JOIN licence_status ls ON ls.STATUS = l.STATUS
  LEFT JOIN client c ON c.CLIENT_NO = l.CLIENT_NO
`;

const CLIENT_SELECT = `
  SELECT c.*,
         ct.NAME AS CLIENT_TYPE_NAME,
         fs.FEE_STATUS_TEXT AS FEE_STATUS_NAME,
         ic.NAME AS INDUSTRY_NAME,
         (SELECT COUNT(*) FROM licence l WHERE l.CLIENT_NO = c.CLIENT_NO) AS LICENCE_COUNT
  FROM client c
  LEFT JOIN client_type ct ON ct.TYPE_ID = c.CLIENT_TYPE_ID
  LEFT JOIN fee_status fs ON fs.FEE_STATUS_ID = c.FEE_STATUS_ID
  LEFT JOIN industry_cat ic ON ic.CAT_ID = c.CAT_ID
`;

export function searchLicences(db: Database.Database, query: string, limit: number = 20) {
  const exact = cleanQuery(query);
  if (!exact) return [];
  const pattern = likePattern(exact);
  return db.prepare(`
    ${LICENCE_SELECT}
    WHERE l.LICENCE_NO LIKE @pattern ESCAPE '\\'
       OR CAST(l.CLIENT_NO AS TEXT) = @exact
       OR c.LICENCEE LIKE @pattern ESCAPE '\\'
       OR c.TRADING_NAME LIKE @pattern ESCAPE '\\'
       OR c.ABN LIKE @pattern ESCAPE '\\'
       OR c.ACN LIKE @pattern ESCAPE '\\'
    ORDER BY CASE
      WHEN l.LICENCE_NO = @exact THEN 0
      WHEN CAST(l.CLIENT_NO AS TEXT) = @exact THEN 1
      WHEN c.LICENCEE = @exact COLLATE NOCASE THEN 2
      WHEN c.TRADING_NAME = @exact COLLATE NOCASE THEN 3
      ELSE 4 END,
      l.LICENCE_NO
    LIMIT @limit
  `).all({ pattern, exact, limit: clampLimit(limit, 20) });
}

export function searchLicencesWithSites(db: Database.Database, query: string, limit: number = 20) {
  const exact = cleanQuery(query);
  if (!exact) return [];
  const pattern = likePattern(exact);
  return db.prepare(`
    SELECT DISTINCT l.*,
           sv.SV_NAME AS SERVICE_NAME,
           ss.SS_NAME AS SUBSERVICE_NAME,
           ls.STATUS_TEXT AS STATUS_NAME,
           c.LICENCEE, c.TRADING_NAME,
           s.LATITUDE, s.LONGITUDE, s.NAME AS SITE_NAME
    FROM licence l
    LEFT JOIN licence_service sv ON sv.SV_ID = l.SV_ID
    LEFT JOIN licence_subservice ss ON ss.SS_ID = l.SS_ID AND ss.SV_SV_ID = l.SV_ID
    LEFT JOIN licence_status ls ON ls.STATUS = l.STATUS
    LEFT JOIN client c ON c.CLIENT_NO = l.CLIENT_NO
    LEFT JOIN device_details d ON l.LICENCE_NO = d.LICENCE_NO
    LEFT JOIN site s ON d.SITE_ID = s.SITE_ID
    WHERE l.LICENCE_NO LIKE @pattern ESCAPE '\\'
       OR c.LICENCEE LIKE @pattern ESCAPE '\\'
       OR c.TRADING_NAME LIKE @pattern ESCAPE '\\'
    LIMIT @limit
  `).all({ pattern, limit: clampLimit(limit, 20) });
}

export function searchClients(db: Database.Database, query: string, limit: number = 20) {
  const exact = cleanQuery(query);
  if (!exact) return [];
  const pattern = likePattern(exact);
  return db.prepare(`
    ${CLIENT_SELECT}
    WHERE CAST(c.CLIENT_NO AS TEXT) = @exact
       OR c.LICENCEE LIKE @pattern ESCAPE '\\'
       OR c.TRADING_NAME LIKE @pattern ESCAPE '\\'
       OR c.ABN LIKE @pattern ESCAPE '\\'
       OR c.ACN LIKE @pattern ESCAPE '\\'
       OR c.POSTAL_STREET LIKE @pattern ESCAPE '\\'
       OR c.POSTAL_SUBURB LIKE @pattern ESCAPE '\\'
       OR c.POSTAL_STATE LIKE @pattern ESCAPE '\\'
       OR c.POSTAL_POSTCODE LIKE @pattern ESCAPE '\\'
    ORDER BY CASE
      WHEN CAST(c.CLIENT_NO AS TEXT) = @exact THEN 0
      WHEN c.LICENCEE = @exact COLLATE NOCASE THEN 1
      WHEN c.TRADING_NAME = @exact COLLATE NOCASE THEN 2
      WHEN c.ABN = @exact OR c.ACN = @exact THEN 3
      ELSE 4 END,
      c.LICENCEE
    LIMIT @limit
  `).all({ pattern, exact, limit: clampLimit(limit, 20) });
}

export function getClientDetails(db: Database.Database, clientNo: number, licenceLimit: number = DEFAULT_DETAIL_LIMIT) {
  const client = db.prepare(`${CLIENT_SELECT} WHERE c.CLIENT_NO = ?`).get(clientNo) as any;
  if (!client) return null;

  const total = Number(client.LICENCE_COUNT ?? 0);
  const maxLicences = clampLimit(licenceLimit, DEFAULT_DETAIL_LIMIT);
  const licences = db.prepare(`
    ${LICENCE_SELECT}
    WHERE l.CLIENT_NO = ?
    ORDER BY l.DATE_OF_EXPIRY DESC, l.LICENCE_NO
    LIMIT ?
  `).all(clientNo, maxLicences);
  return {
    client,
    licences,
    licences_total: total,
    licences_returned: licences.length,
    licences_truncated: total > licences.length,
  };
}

export function searchBsl(db: Database.Database, query: string, limit: number = 20) {
  const exact = cleanQuery(query);
  if (!exact) return [];
  const pattern = likePattern(exact);
  return db.prepare(`
    SELECT b.*, a.AREA_NAME, l.LICENCE_NO, l.CLIENT_NO, c.LICENCEE, c.TRADING_NAME
    FROM bsl b
    LEFT JOIN bsl_area a ON a.AREA_CODE = b.AREA_CODE
    LEFT JOIN licence l ON CAST(l.BSL_NO AS TEXT) = CAST(b.BSL_NO AS TEXT)
    LEFT JOIN client c ON c.CLIENT_NO = l.CLIENT_NO
    WHERE b.CALL_SIGN LIKE @pattern ESCAPE '\\'
       OR CAST(b.BSL_NO AS TEXT) LIKE @pattern ESCAPE '\\'
       OR b.ON_AIR_ID LIKE @pattern ESCAPE '\\'
       OR c.LICENCEE LIKE @pattern ESCAPE '\\'
       OR c.TRADING_NAME LIKE @pattern ESCAPE '\\'
    ORDER BY CASE
      WHEN b.CALL_SIGN = @exact COLLATE NOCASE THEN 0
      WHEN CAST(b.BSL_NO AS TEXT) = @exact THEN 1
      ELSE 2 END,
      b.CALL_SIGN
    LIMIT @limit
  `).all({ pattern, exact, limit: clampLimit(limit, 20) });
}

export function searchFrequencyAssignments(
  db: Database.Database,
  freqMinHz: number,
  freqMaxHz: number = freqMinHz,
  state?: string,
  limit: number = 50
) {
  if (!Number.isFinite(freqMinHz) || !Number.isFinite(freqMaxHz)) {
    throw new Error('Frequency bounds must be finite numbers in Hz.');
  }
  const min = Math.min(freqMinHz, freqMaxHz);
  const max = Math.max(freqMinHz, freqMaxHz);
  const normalizedState = state?.trim().toUpperCase() ?? '';
  return db.prepare(`
    SELECT d.SDD_ID, d.LICENCE_NO, d.DEVICE_REGISTRATION_IDENTIFIER,
           d.FREQUENCY, d.CARRIER_FREQ, d.BANDWIDTH, d.EMISSION,
           d.DEVICE_TYPE, d.CALL_SIGN, d.STATION_TYPE, d.STATION_NAME,
           d.TRANSMITTER_POWER, d.TRANSMITTER_POWER_UNIT, d.EIRP, d.EIRP_UNIT,
           l.CLIENT_NO, l.STATUS AS LICENCE_STATUS,
           ls.STATUS_TEXT AS LICENCE_STATUS_NAME,
           c.LICENCEE, c.TRADING_NAME,
           sv.SV_NAME AS SERVICE_NAME, ss.SS_NAME AS SUBSERVICE_NAME,
           s.SITE_ID, s.NAME AS SITE_NAME, s.STATE, s.POSTCODE,
           s.LATITUDE, s.LONGITUDE
    FROM device_details d
    LEFT JOIN licence l ON l.LICENCE_NO = d.LICENCE_NO
    LEFT JOIN client c ON c.CLIENT_NO = l.CLIENT_NO
    LEFT JOIN licence_status ls ON ls.STATUS = l.STATUS
    LEFT JOIN licence_service sv ON sv.SV_ID = d.SV_ID
    LEFT JOIN licence_subservice ss ON ss.SS_ID = d.SS_ID AND ss.SV_SV_ID = d.SV_ID
    LEFT JOIN site s ON s.SITE_ID = d.SITE_ID
    WHERE (
      d.FREQUENCY BETWEEN @min AND @max
      OR d.CARRIER_FREQ BETWEEN @min AND @max
      OR (d.EQ_FREQ_RANGE_MIN <= @max AND d.EQ_FREQ_RANGE_MAX >= @min)
    )
      AND (@state = '' OR UPPER(s.STATE) = @state)
    ORDER BY d.FREQUENCY, d.LICENCE_NO, d.SDD_ID
    LIMIT @limit
  `).all({ min, max, state: normalizedState, limit: clampLimit(limit, 50) });
}

export function searchSpectrumBand(
  db: Database.Database,
  freqMinHz: number,
  freqMaxHz: number,
  limit: number = 20
) {
  if (!Number.isFinite(freqMinHz) || !Number.isFinite(freqMaxHz)) {
    throw new Error('Frequency bounds must be finite numbers in Hz.');
  }
  const min = Math.min(freqMinHz, freqMaxHz);
  const max = Math.max(freqMinHz, freqMaxHz);
  return db.prepare(`
    SELECT f.LICENCE_NO, f.AREA_CODE, f.AREA_NAME,
           f.LW_FREQUENCY_START, f.LW_FREQUENCY_END,
           f.UP_FREQUENCY_START, f.UP_FREQUENCY_END,
           a.AREA_DESCRIPTION,
           l.CLIENT_NO, l.STATUS AS LICENCE_STATUS,
           c.LICENCEE, c.TRADING_NAME
    FROM auth_spectrum_freq f
    LEFT JOIN auth_spectrum_area a
           ON a.LICENCE_NO = f.LICENCE_NO AND a.AREA_CODE = f.AREA_CODE
    LEFT JOIN licence l ON l.LICENCE_NO = f.LICENCE_NO
    LEFT JOIN client c ON c.CLIENT_NO = l.CLIENT_NO
    WHERE (f.LW_FREQUENCY_END >= @min AND f.LW_FREQUENCY_START <= @max)
       OR (f.UP_FREQUENCY_END >= @min AND f.UP_FREQUENCY_START <= @max)
    ORDER BY f.LW_FREQUENCY_START, f.LICENCE_NO
    LIMIT @limit
  `).all({ min, max, limit: clampLimit(limit, 20) });
}

export function searchApplicationText(
  db: Database.Database,
  ftsQuery: string,
  limit: number = 20
) {
  return db.prepare(`
    SELECT atb.APTB_ID, atb.LICENCE_NO, atb.APTB_CATEGORY, atb.APTB_DESCRIPTION,
           snippet(applic_text_block_fts, 0, '«', '»', '…', 32) AS snippet,
           bm25(applic_text_block_fts) AS rank
    FROM applic_text_block_fts
    JOIN applic_text_block atb ON atb.APTB_ID = applic_text_block_fts.rowid
    WHERE applic_text_block_fts MATCH ?
    ORDER BY rank
    LIMIT ?
  `).all(ftsQuery, clampLimit(limit, 20));
}

export function getLicenceDetails(db: Database.Database, licenceNo: string, deviceLimit: number = DEFAULT_DETAIL_LIMIT) {
  const licence = db.prepare(`${LICENCE_SELECT} WHERE l.LICENCE_NO = ?`).get(licenceNo) as any;
  if (!licence) return null;

  const client = db.prepare(`${CLIENT_SELECT} WHERE c.CLIENT_NO = ?`).get(licence.CLIENT_NO);
  const total = (db.prepare(
    'SELECT COUNT(*) AS count FROM device_details WHERE LICENCE_NO = ?'
  ).get(licenceNo) as { count: number }).count;
  const maxDevices = clampLimit(deviceLimit, DEFAULT_DETAIL_LIMIT);
  const devices = db.prepare(`
    SELECT d.*,
           sv.SV_NAME AS SERVICE_NAME,
           ss.SS_NAME AS SUBSERVICE_NAME,
           nos.DESCRIPTION AS NATURE_OF_SERVICE_NAME,
           cos.DESCRIPTION AS CLASS_OF_STATION_NAME,
           ap.POLARISATION_TEXT AS POLARISATION_NAME,
           sat.SA_SAT_NAME AS SATELLITE_NAME,
           s.LATITUDE, s.LONGITUDE, s.NAME AS SITE_NAME, s.STATE, s.POSTCODE,
           ant.GAIN AS ANTENNA_GAIN,
           ant.MANUFACTURER AS ANTENNA_MANUFACTURER,
           ant.MODEL AS ANTENNA_MODEL,
           ant.ANTENNA_TYPE
    FROM device_details d
    LEFT JOIN licence_service sv ON sv.SV_ID = d.SV_ID
    LEFT JOIN licence_subservice ss ON ss.SS_ID = d.SS_ID AND ss.SV_SV_ID = d.SV_ID
    LEFT JOIN nature_of_service nos ON nos.CODE = d.NATURE_OF_SERVICE_ID
    LEFT JOIN class_of_station cos ON cos.CODE = d.CLASS_OF_STATION_CODE
    LEFT JOIN antenna_polarity ap ON ap.POLARISATION_CODE = d.POLARISATION
    LEFT JOIN satellite sat ON sat.SA_ID = d.SA_ID
    LEFT JOIN site s ON d.SITE_ID = s.SITE_ID
    LEFT JOIN antenna ant ON ant.ANTENNA_ID = d.ANTENNA_ID
    WHERE d.LICENCE_NO = ?
    ORDER BY d.FREQUENCY, d.SDD_ID
    LIMIT ?
  `).all(licenceNo, maxDevices);

  const broadcasting = licence.BSL_NO == null ? null : db.prepare(`
    SELECT b.*, ba.AREA_NAME
    FROM bsl b
    LEFT JOIN bsl_area ba ON ba.AREA_CODE = b.AREA_CODE
    WHERE CAST(b.BSL_NO AS TEXT) = CAST(? AS TEXT)
  `).get(licence.BSL_NO);
  const spectrum_areas = db.prepare(`
    SELECT * FROM auth_spectrum_area WHERE LICENCE_NO = ? ORDER BY AREA_CODE
  `).all(licenceNo);
  const spectrum_frequencies = db.prepare(`
    SELECT * FROM auth_spectrum_freq
    WHERE LICENCE_NO = ? ORDER BY AREA_CODE, LW_FREQUENCY_START
  `).all(licenceNo);
  const application_text = db.prepare(`
    SELECT APTB_ID, APTB_TABLE_PREFIX, APTB_DESCRIPTION, APTB_CATEGORY, APTB_ITEM
    FROM applic_text_block
    WHERE LICENCE_NO = ?
    ORDER BY APTB_ID
    LIMIT 100
  `).all(licenceNo);

  return {
    licence,
    client,
    devices,
    devices_total: total,
    devices_returned: devices.length,
    devices_truncated: total > devices.length,
    broadcasting,
    spectrum_areas,
    spectrum_frequencies,
    application_text,
  };
}
