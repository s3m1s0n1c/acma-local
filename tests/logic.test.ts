import {
    searchSites,
    getSiteDetails,
    searchLicences,
    searchClients,
    getClientDetails,
    getLicenceDetails,
    searchBsl,
    searchSpectrumBand,
    searchApplicationText,
    searchFrequencyAssignments,
    lookupClient,
} from '../src/logic.js';
import { initializeDatabase } from '../src/db.js';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Logic Layer', () => {
    const scratchDir = path.join(__dirname, '../scratch_test_logic');
    const dbPath = path.join(scratchDir, 'test_acma.db');
    let db: Database.Database;

    beforeAll(() => {
        if (!fs.existsSync(scratchDir)) {
            fs.mkdirSync(scratchDir);
        }
        initializeDatabase(dbPath);
        db = new Database(dbPath);

        // Seed data
        db.prepare("INSERT INTO site (SITE_ID, NAME, STATE, POSTCODE) VALUES ('S1', 'Sydney Tower', 'NSW', '2000')").run();
        db.prepare(`INSERT INTO client
            (CLIENT_NO, LICENCEE, ABN, POSTAL_STREET, POSTAL_SUBURB, POSTAL_STATE, POSTAL_POSTCODE)
            VALUES (1, 'Test Client', '12345678901', '5 Example Road', 'Gosford', 'NSW', '2250')`).run();
        db.prepare("INSERT INTO licence (LICENCE_NO, CLIENT_NO) VALUES ('L1', 1)").run();
        db.prepare("INSERT INTO device_details (SDD_ID, SITE_ID, LICENCE_NO, FREQUENCY) VALUES (101, 'S1', 'L1', 100000000)").run();
    });

    afterAll(() => {
        if (db) db.close();
        if (fs.existsSync(scratchDir)) {
            fs.rmSync(scratchDir, { recursive: true, force: true });
        }
    });

    test('searchSites should find site by name', () => {
        const results = searchSites(db, 'Sydney');
        expect(results).toHaveLength(1);
        expect((results[0] as any).NAME).toBe('Sydney Tower');
    });

    test('getSiteDetails should return site and devices', () => {
        const results = getSiteDetails(db, 'S1');
        expect(results).not.toBeNull();
        expect((results!.site as any).NAME).toBe('Sydney Tower');
        expect(results!.devices).toHaveLength(1);
        expect((results!.devices[0] as any).FREQUENCY).toBe(100000000);
    });

    test('searchLicences should find licence by no', () => {
        const results = searchLicences(db, 'L1');
        expect(results).toHaveLength(1);
    });

    test('searchClients should find client by name', () => {
        const results = searchClients(db, 'Test');
        expect(results).toHaveLength(1);
    });

    test('searchClients searches identity and postal address fields', () => {
        for (const query of ['1', '12345678901', 'Example Road', 'Gosford', '2250']) {
            const results = searchClients(db, query) as any[];
            expect(results.map(r => r.CLIENT_NO)).toContain(1);
        }
    });

    test('searchLicences can find licences by holder name and ABN', () => {
        expect((searchLicences(db, 'Test Client') as any[])[0]?.LICENCE_NO).toBe('L1');
        expect((searchLicences(db, '12345678901') as any[])[0]?.LICENCE_NO).toBe('L1');
    });

    test('getClientDetails follows CLIENT_NO to related licences', () => {
        const result = getClientDetails(db, 1) as any;
        expect(result.client.POSTAL_SUBURB).toBe('Gosford');
        expect(result.licences.map((l: any) => l.LICENCE_NO)).toContain('L1');
        expect(result.licences_total).toBeGreaterThanOrEqual(1);
        expect(result.licences_truncated).toBe(false);
    });

    test('lookupClient returns the address, licences and devices in one call', () => {
        const result = lookupClient(db, 'Test Client', true, true, 50) as any;
        expect(result.client).toMatchObject({ CLIENT_NO: 1, POSTAL_STREET: '5 Example Road' });
        expect(result.licences.map((row: any) => row.LICENCE_NO)).toContain('L1');
        expect(result.devices).toHaveLength(1);
        expect(result.devices[0]).toMatchObject({ SDD_ID: 101, FREQUENCY: 100000000, SITE_NAME: 'Sydney Tower' });
        expect(result.licences_truncated).toBe(false);
        expect(result.devices_truncated).toBe(false);
    });

    test('getLicenceDetails should return licence, client and devices', () => {
        const results = getLicenceDetails(db, 'L1');
        expect(results).not.toBeNull();
        expect((results!.licence as any).LICENCE_NO).toBe('L1');
        expect((results!.client as any).LICENCEE).toBe('Test Client');
        expect(results!.devices).toHaveLength(1);
    });

    test('searchLicences returns SERVICE_NAME, SUBSERVICE_NAME, STATUS_NAME via JOINs', () => {
        // Seed the lookups (call sites adjust per existing test infrastructure).
        const db = new Database(dbPath);
        db.exec(`
            INSERT INTO licence_service (SV_ID, SV_NAME) VALUES (3, 'Land Mobile');
            INSERT INTO licence_subservice (SS_ID, SV_SV_ID, SS_NAME) VALUES (304, 3, 'Land Mobile System');
            INSERT INTO licence_status (STATUS, STATUS_TEXT) VALUES ('10', 'Expired');
            INSERT INTO licence (LICENCE_NO, CLIENT_NO, SV_ID, SS_ID, STATUS) VALUES ('LM1', 1, 3, 304, '10');
        `);
        db.close();

        const db2 = new Database(dbPath, { readonly: true });
        const results = searchLicences(db2, 'LM1', 10) as any[];
        db2.close();
        expect(results).toHaveLength(1);
        expect(results[0]).toMatchObject({
            LICENCE_NO: 'LM1',
            SV_ID: 3,
            SERVICE_NAME: 'Land Mobile',
            SUBSERVICE_NAME: 'Land Mobile System',
            STATUS_NAME: 'Expired',
        });
    });

    test('searchClients returns CLIENT_TYPE_NAME, FEE_STATUS_NAME, INDUSTRY_NAME via JOINs', () => {
        const db = new Database(dbPath);
        db.exec(`
            INSERT INTO client_type (TYPE_ID, NAME) VALUES (5, 'Company');
            INSERT INTO fee_status (FEE_STATUS_ID, FEE_STATUS_TEXT) VALUES (1, 'Normal');
            INSERT INTO industry_cat (CAT_ID, DESCRIPTION, NAME) VALUES (3, 'Manufacturing', 'Manufacturing');
            INSERT INTO client (CLIENT_NO, LICENCEE, CAT_ID, CLIENT_TYPE_ID, FEE_STATUS_ID)
                VALUES (42, 'Acme Pty Ltd', 3, 5, 1);
        `);
        db.close();

        const db2 = new Database(dbPath, { readonly: true });
        const results = searchClients(db2, 'Acme', 10) as any[];
        db2.close();
        expect(results).toHaveLength(1);
        expect(results[0]).toMatchObject({
            LICENCEE: 'Acme Pty Ltd',
            CLIENT_TYPE_NAME: 'Company',
            FEE_STATUS_NAME: 'Normal',
            INDUSTRY_NAME: 'Manufacturing',
        });
    });

    test('searchSites returns LICENSING_AREA_NAME via JOIN', () => {
        const db = new Database(dbPath);
        db.exec(`
            INSERT INTO licensing_area (LICENSING_AREA_ID, DESCRIPTION) VALUES (1, 'Australia');
            INSERT INTO site (SITE_ID, NAME, POSTCODE, LICENSING_AREA_ID)
                VALUES ('S1_LA', 'Test Site', '2000', 1);
        `);
        db.close();

        const db2 = new Database(dbPath, { readonly: true });
        const results = searchSites(db2, 'Test Site', 10) as any[];
        db2.close();
        expect(results[0]?.LICENSING_AREA_NAME).toBe('Australia');
    });

    test('searchBsl matches by call sign and joins bsl_area for AREA_NAME', () => {
        const db = new Database(dbPath);
        db.exec(`
            INSERT INTO bsl_area (AREA_CODE, AREA_NAME) VALUES (162, 'ADELAIDE TV1');
            INSERT INTO bsl
                (BSL_NO, MEDIUM_CATEGORY, REGION_CATEGORY, BSL_STATE, DATE_COMMENCED, ON_AIR_ID, CALL_SIGN, AREA_CODE)
                VALUES (85, 'TV', 'Regional', 'ACT', '1962-06-02', '10', 'CTC', 162);
        `);
        db.close();

        const db2 = new Database(dbPath, { readonly: true });
        const results = searchBsl(db2, 'CTC', 10) as any[];
        db2.close();
        expect(results).toHaveLength(1);
        expect(results[0]).toMatchObject({
            BSL_NO: 85,
            CALL_SIGN: 'CTC',
            MEDIUM_CATEGORY: 'TV',
            BSL_STATE: 'ACT',
            AREA_NAME: 'ADELAIDE TV1',
        });
    });

    test('searchBsl matches by BSL_NO (numeric string)', () => {
        const db = new Database(dbPath);
        db.exec(`INSERT INTO bsl (BSL_NO, CALL_SIGN) VALUES (123, 'XYZ');`);
        db.close();

        const db2 = new Database(dbPath, { readonly: true });
        const results = searchBsl(db2, '123', 10) as any[];
        db2.close();
        expect(results[0]?.BSL_NO).toBe(123);
    });

    test('searchSpectrumBand finds licences whose band overlaps the query', () => {
        const db = new Database(dbPath);
        db.exec(`
            INSERT INTO auth_spectrum_area
                (LICENCE_NO, AREA_CODE, AREA_NAME, AREA_DESCRIPTION)
                VALUES ('10143110', 'AP_10143110_3918', 'Brisbane', 'KX6G, KX6H...');
            INSERT INTO auth_spectrum_freq
                (LICENCE_NO, AREA_CODE, AREA_NAME, LW_FREQUENCY_START, LW_FREQUENCY_END, UP_FREQUENCY_START, UP_FREQUENCY_END)
                VALUES ('10143110', 'AP_10143110_3918', 'Brisbane', 1960000000, 1970000000, 2150000000, 2160000000);
        `);
        db.close();

        const db2 = new Database(dbPath, { readonly: true });
        // Query 1.96-1.97 GHz — overlaps the LW range.
        const overlap = searchSpectrumBand(db2, 1_960_000_000, 1_970_000_000, 50) as any[];
        // Query 0-100 Hz — far outside; should return none.
        const outside = searchSpectrumBand(db2, 0, 100, 50) as any[];
        // Query 1.965 GHz to 2.155 GHz — straddles both bands.
        const straddle = searchSpectrumBand(db2, 1_965_000_000, 2_155_000_000, 50) as any[];
        db2.close();

        expect(overlap).toHaveLength(1);
        expect(overlap[0]).toMatchObject({ LICENCE_NO: '10143110', AREA_NAME: 'Brisbane' });
        expect(outside).toHaveLength(0);
        expect(straddle).toHaveLength(1);
    });

    test('getLicenceDetails device rows include SATELLITE_NAME when SA_ID is set', () => {
        const db = new Database(dbPath);
        db.exec(`
            INSERT INTO satellite (SA_ID, SA_SAT_NAME) VALUES (1003, 'USASAT-14K');
            INSERT INTO licence (LICENCE_NO, CLIENT_NO) VALUES ('SAT1', 99);
            INSERT INTO device_details (SDD_ID, LICENCE_NO, SA_ID) VALUES (5001, 'SAT1', 1003);
        `);
        db.close();

        const db2 = new Database(dbPath, { readonly: true });
        const details = getLicenceDetails(db2, 'SAT1') as any;
        db2.close();
        expect(details).not.toBeNull();
        expect(details.devices[0]).toMatchObject({ SDD_ID: 5001, SA_ID: 1003, SATELLITE_NAME: 'USASAT-14K' });
    });

    test('device details resolve the antenna relationship', () => {
        const writeDb = new Database(dbPath);
        writeDb.exec(`
            INSERT INTO antenna (ANTENNA_ID, MANUFACTURER, MODEL, ANTENNA_TYPE)
                VALUES ('ANT-1', 'Acme', 'Beam 4', 'Yagi');
            UPDATE device_details
               SET ANTENNA_ID = 'ANT-1'
             WHERE SDD_ID = 101;
        `);
        writeDb.close();

        const readDb = new Database(dbPath, { readonly: true });
        const result = getLicenceDetails(readDb, 'L1') as any;
        readDb.close();
        expect(result.devices[0]).toMatchObject({
            ANTENNA_MANUFACTURER: 'Acme',
            ANTENNA_MODEL: 'Beam 4',
        });
    });

    test('searchFrequencyAssignments resolves licence, holder and site', () => {
        const results = searchFrequencyAssignments(db, 99_999_000, 100_001_000, 'NSW', 10) as any[];
        expect(results).toHaveLength(1);
        expect(results[0]).toMatchObject({
            SDD_ID: 101,
            LICENCE_NO: 'L1',
            LICENCEE: 'Test Client',
            SITE_NAME: 'Sydney Tower',
            STATE: 'NSW',
        });
    });

    test('searchSpectrumBand handles rows with NULL UP_FREQUENCY_END', () => {
        const db = new Database(dbPath);
        db.exec(`
            INSERT INTO auth_spectrum_freq
                (LICENCE_NO, AREA_CODE, AREA_NAME, LW_FREQUENCY_START, LW_FREQUENCY_END,
                 UP_FREQUENCY_START, UP_FREQUENCY_END)
                VALUES ('LW_ONLY', 'A1', 'AreaX', 3000000, 4000000, NULL, NULL);
        `);
        db.close();

        const db2 = new Database(dbPath, { readonly: true });
        // Query overlaps the LW range only.
        const lwHit = searchSpectrumBand(db2, 3500000, 3600000, 50) as any[];
        // Query is in the (no-)UP range — should NOT match the LW_ONLY row.
        const upMiss = searchSpectrumBand(db2, 5000000, 6000000, 50) as any[];
        db2.close();

        expect(lwHit.map(r => r.LICENCE_NO)).toContain('LW_ONLY');
        expect(upMiss.map(r => r.LICENCE_NO)).not.toContain('LW_ONLY');
    });

    test('searchApplicationText returns matching rows with snippets and BM25 ordering', () => {
        const db = new Database(dbPath);
        db.exec(`
            INSERT INTO applic_text_block (APTB_ID, LICENCE_NO, APTB_CATEGORY, APTB_DESCRIPTION, APTB_TEXT)
                VALUES (100, 'L100', 'SPCOND', 'Aviation conditions', 'Operation in aeronautical bands subject to ICAO standards.');
            INSERT INTO applic_text_block (APTB_ID, LICENCE_NO, APTB_CATEGORY, APTB_DESCRIPTION, APTB_TEXT)
                VALUES (101, 'L101', 'SPCOND', 'Marine conditions', 'Operation must comply with marine emergency procedures.');
            INSERT INTO applic_text_block_fts(applic_text_block_fts) VALUES('rebuild');
        `);
        db.close();

        const db2 = new Database(dbPath, { readonly: true });
        const results = searchApplicationText(db2, 'marine', 5) as any[];
        db2.close();
        expect(results).toHaveLength(1);
        expect(results[0]).toMatchObject({ APTB_ID: 101, LICENCE_NO: 'L101' });
        expect(results[0].snippet).toContain('«marine»');
    });
});
