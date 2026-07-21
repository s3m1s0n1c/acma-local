import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { initializeDatabase } from '../src/db.js';
import Database from 'better-sqlite3';
import axios from 'axios';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import * as path from 'path';
import * as fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('MCP Network & Sync Integration (Streamable HTTP)', () => {
    let serverProcess: any;
    const PORT = 3001;
    const testDbPath = path.join(__dirname, 'test_mcp.db');

    beforeAll(async () => {
        // Ensure a valid (empty) database exists before the server starts
        if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
        initializeDatabase(testDbPath);

        // Seed emission lookup tables so search_devices_by_emission can resolve descriptions.
        {
            const seedPath = path.resolve(__dirname, '..', 'seed', 'emissions.sql');
            const db = new Database(testDbPath);
            try {
                const { applyEmissionReseed } = await import('../src/emissions.js');
                applyEmissionReseed(db, seedPath);
            } finally { db.close(); }
        }

        console.log(`Starting server on port ${PORT}...`);
        serverProcess = spawn('npx', ['tsx', 'src/index.ts'], {
            env: { ...process.env, PORT: String(PORT), ACMA_DB_PATH: testDbPath },
            stdio: 'pipe'
        });

        serverProcess.stderr.on('data', (data: Buffer) => console.error(`[SERVER ERR] ${data}`));

        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Server timeout (60s)')), 60000);
            serverProcess.stderr.on('data', (data: Buffer) => {
                if (data.toString().includes(`running on port ${PORT}`)) {
                    clearTimeout(timeout);
                    resolve(true);
                }
            });
        });

        await axios.get(`http://localhost:${PORT}/health`);
    }, 90000);

    afterAll(() => {
        if (serverProcess) serverProcess.kill();
        if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    });

    test('should connect via Streamable HTTP and list tools', async () => {
        const transport = new StreamableHTTPClientTransport(new URL(`http://localhost:${PORT}/mcp`));
        const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });

        await client.connect(transport);
        const tools = await client.listTools();

        expect(tools.tools).toBeDefined();
        expect(tools.tools.some(t => t.name === 'search_sites')).toBe(true);

        const frequencyTool = tools.tools.find(t => t.name === 'search_frequency_assignments');
        expect(frequencyTool?.inputSchema.properties).toHaveProperty('freq_min_mhz');
        expect(frequencyTool?.inputSchema.properties).toHaveProperty('freq_min_hz');

        await transport.close();
    }, 15000);

    test('search_frequency_assignments accepts MHz and echoes the interpreted range', async () => {
        const seedDb = new Database(testDbPath);
        try {
            seedDb.exec(`
                INSERT INTO client (CLIENT_NO, LICENCEE) VALUES (9001, 'MHz Fixture Client');
                INSERT INTO licence (LICENCE_NO, CLIENT_NO) VALUES ('MHZ-1', 9001);
                INSERT INTO device_details (SDD_ID, LICENCE_NO, FREQUENCY) VALUES
                    (9001, 'MHZ-1', 476625000),
                    (9002, 'MHZ-1', 477000000);
            `);
        } finally { seedDb.close(); }

        const response = await callMcpTool('search_frequency_assignments', {
            freq_min_mhz: 476.425,
            freq_max_mhz: 477.4125,
        });
        const parsed = JSON.parse(response);
        expect(parsed.query).toMatchObject({
            input_unit: 'MHz',
            freq_min_hz: 476425000,
            freq_max_hz: 477412500,
        });
        expect(parsed.rows).toHaveLength(2);
        const first = Object.fromEntries(parsed.columns.map((column: string, i: number) => [column, parsed.rows[0][i]]));
        expect(first).toMatchObject({ LICENCE_NO: 'MHZ-1', FREQUENCY: 476625000 });
        expect(parsed.rows_returned).toBe(2);
        expect(parsed.rows_truncated).toBe(false);

        const limitedResponse = await callMcpTool('search_frequency_assignments', {
            freq_min_mhz: 476.425,
            freq_max_mhz: 477.4125,
            limit: 1,
        });
        const limited = JSON.parse(limitedResponse);
        expect(limited.rows).toHaveLength(1);
        expect(limited.rows_returned).toBe(1);
        expect(limited.rows_truncated).toBe(true);
    }, 15000);

    test('search_frequency_assignments rejects mixed Hz and MHz fields', async () => {
        const response = await callMcpTool('search_frequency_assignments', {
            freq_min_mhz: 476.425,
            freq_max_hz: 477412500,
        });
        const parsed = JSON.parse(response);
        expect(parsed._error).toMatch(/either the \*_hz fields or the \*_mhz fields/i);
    }, 15000);

    test('should report sync progress', async () => {
        const transport = new StreamableHTTPClientTransport(new URL(`http://localhost:${PORT}/mcp`));
        const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
        await client.connect(transport);

        // Kick off sync (non-awaited) — sync will fail (no network in test) but should start
        client.callTool({ name: 'sync_data', arguments: {} }).catch(() => { });
        // Give it a moment to register as in-progress
        await new Promise(r => setTimeout(r, 2000));

        const secondCall = await client.callTool({ name: 'sync_data', arguments: {} }) as any;
        const responseText = secondCall.content[0].text;
        // Either still in progress, triggered, completed, or returned freshness/decision info — all valid
        expect(responseText).toMatch(/Sync (in progress|triggered|already in progress|failed)|Last decision:|dataAsOf:|lastSyncAt:/i);

        await transport.close();
    }, 25000);

    test('sync_data accepts mode="full" argument', async () => {
        const transport = new StreamableHTTPClientTransport(new URL(`http://localhost:${PORT}/mcp`));
        const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
        await client.connect(transport);

        const result = await client.callTool({ name: 'sync_data', arguments: { mode: 'full' } }) as any;
        // Tool must return a content block with non-empty text; no error thrown.
        expect(result.content).toBeDefined();
        expect(result.content.length).toBeGreaterThan(0);
        expect(typeof result.content[0].text).toBe('string');
        expect(result.content[0].text.length).toBeGreaterThan(0);

        await transport.close();
    }, 25000);

    test('list_sample_queries bare call returns a category summary with >=45 total entries', async () => {
        const transport = new StreamableHTTPClientTransport(new URL(`http://localhost:${PORT}/mcp`));
        const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
        await client.connect(transport);

        const result = await client.callTool({ name: 'list_sample_queries', arguments: {} }) as any;
        const summary = JSON.parse(result.content[0].text);
        expect(Array.isArray(summary)).toBe(false);
        expect(Array.isArray(summary.categories)).toBe(true);
        expect(summary.categories.length).toBeGreaterThan(0);
        const total = summary.categories.reduce((s: number, c: any) => s + c.count, 0);
        expect(total).toBeGreaterThanOrEqual(45);

        await transport.close();
    }, 15000);

    test('list_sample_queries filtered by category returns SampleQuery[]', async () => {
        const transport = new StreamableHTTPClientTransport(new URL(`http://localhost:${PORT}/mcp`));
        const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
        await client.connect(transport);

        const result = await client.callTool({ name: 'list_sample_queries', arguments: { category: 'lookup' } }) as any;
        const queries = JSON.parse(result.content[0].text);
        expect(Array.isArray(queries)).toBe(true);
        expect(queries.length).toBeGreaterThan(0);
        expect(queries[0]).toHaveProperty('description');
        expect(queries[0]).toHaveProperty('query');
        expect(queries[0]).toHaveProperty('category', 'lookup');

        await transport.close();
    }, 15000);

    test('execute_sql runs a valid SELECT and returns structured results', async () => {
        const transport = new StreamableHTTPClientTransport(new URL(`http://localhost:${PORT}/mcp`));
        const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
        await client.connect(transport);

        const result = await client.callTool({
            name: 'execute_sql',
            arguments: { sql: "select 1 as num, 'hello' as word" }
        }) as any;
        const data = JSON.parse(result.content[0].text);
        expect(data.columns).toEqual(['num', 'word']);
        expect(data.rows).toEqual([[1, 'hello']]);
        expect(data.truncated).toBe(false);

        await transport.close();
    }, 45000);

    test('execute_sql rejects non-SELECT statements', async () => {
        const transport = new StreamableHTTPClientTransport(new URL(`http://localhost:${PORT}/mcp`));
        const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
        await client.connect(transport);

        const result = await client.callTool({
            name: 'execute_sql',
            arguments: { sql: "INSERT INTO client (CLIENT_NO) VALUES (999)" }
        }) as any;
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toMatch(/SELECT/i);

        await transport.close();
    }, 45000);

    test('describe_tool returns the full markdown for a registered tool', async () => {
        const transport = new StreamableHTTPClientTransport(new URL(`http://localhost:${PORT}/mcp`));
        const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
        await client.connect(transport);

        const result = await client.callTool({ name: 'describe_tool', arguments: { name: 'search_licences' } }) as any;
        const response = result.content[0].text as string;
        // The full description must contain section headers absent from the slim catalog summary
        expect(response).toMatch(/PRIMARY SEARCH TOOL/);
        expect(response).toMatch(/## Usage/);

        await transport.close();
    }, 15000);

    test('describe_tool returns error for unknown tool', async () => {
        const transport = new StreamableHTTPClientTransport(new URL(`http://localhost:${PORT}/mcp`));
        const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
        await client.connect(transport);

        const result = await client.callTool({ name: 'describe_tool', arguments: { name: 'nonexistent_tool' } }) as any;
        const response = (result.content[0].text as string).toLowerCase();
        expect(response).toMatch(/unknown|not found/);

        await transport.close();
    }, 15000);

    test('tools/list catalog descriptions are slim summaries (under 200 chars)', async () => {
        const transport = new StreamableHTTPClientTransport(new URL(`http://localhost:${PORT}/mcp`));
        const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
        await client.connect(transport);

        const tools = await client.listTools();
        for (const tool of tools.tools) {
            expect(tool.description!.length).toBeLessThan(200);
        }

        await transport.close();
    }, 15000);

    test('tools/list advertises the full 23-tool catalog', async () => {
        const transport = new StreamableHTTPClientTransport(new URL(`http://localhost:${PORT}/mcp`));
        const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
        await client.connect(transport);

        const tools = await client.listTools();
        expect(tools.tools.some(t => t.name === 'describe_tool')).toBe(true);
        expect(tools.tools.some(t => t.name === 'explain_query')).toBe(true);
        expect(tools.tools.some(t => t.name === 'get_frequency_allocation')).toBe(true);
        expect(tools.tools.some(t => t.name === 'decode_emission_designator')).toBe(true);
        expect(tools.tools.some(t => t.name === 'search_devices_by_emission')).toBe(true);
        expect(tools.tools.some(t => t.name === 'get_client_details')).toBe(true);
        expect(tools.tools.some(t => t.name === 'search_frequency_assignments')).toBe(true);
        expect(tools.tools.some(t => t.name === 'get_result_page')).toBe(true);
        expect(tools.tools.some(t => t.name === 'lookup_client')).toBe(true);
        expect(tools.tools.some(t => t.name === 'search_everything')).toBe(true);
        expect(tools.tools.length).toBe(23);

        await transport.close();
    }, 15000);

    // ─── _hints tests ─────────────────────────────────────────────────────────

    async function callMcpTool(toolName: string, toolArgs: Record<string, unknown>): Promise<string> {
        const transport = new StreamableHTTPClientTransport(new URL(`http://localhost:${PORT}/mcp`));
        const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
        await client.connect(transport);
        const result = await client.callTool({ name: toolName, arguments: toolArgs }) as any;
        await transport.close();
        return result.content[0].text as string;
    }

    function expandRows(payload: any): any[] {
        return payload.rows.map((row: unknown[]) =>
            Object.fromEntries(payload.columns.map((column: string, i: number) => [column, row[i]]))
        );
    }

    test('search results omit _hints unless explicitly requested', async () => {
        const response = await callMcpTool('search_licences', { query: '1', limit: 1 });
        const parsed = JSON.parse(response);
        expect(Array.isArray(parsed.rows)).toBe(true);
        expect(parsed._hints).toBeUndefined();
    }, 15000);

    test('include_hints=true returns optional follow-up suggestions', async () => {
        const response = await callMcpTool('search_sites', { query: '2000', limit: 2, include_hints: true });
        const parsed = JSON.parse(response);
        expect(Array.isArray(parsed.rows)).toBe(true);
        if (parsed.rows.length > 0) {
            expect(parsed._hints).toBeDefined();
            expect(parsed._hints[0].tool).toBe('get_site_details');
        }
    }, 15000);

    test('search_clients also keeps hints off by default', async () => {
        const response = await callMcpTool('search_clients', { query: 'Test', limit: 1 });
        const parsed = JSON.parse(response);
        expect(parsed._hints).toBeUndefined();
    }, 15000);

    test('lookup_client returns client, licences and devices in one response', async () => {
        const response = JSON.parse(await callMcpTool('lookup_client', {
            query: 'MHz Fixture Client',
            include_licences: true,
            include_devices: true,
        }));
        expect(response.found).toBe(true);
        expect(response.client).toMatchObject({ CLIENT_NO: 9001, LICENCEE: 'MHz Fixture Client' });
        expect(response.licences.columns).toContain('LICENCE_NO');
        expect(response.licences.rows.length).toBeGreaterThan(0);
        expect(response.devices.rows).toHaveLength(2);
    }, 15000);

    test('search_everything returns ranked columnar results', async () => {
        // The server initialized before this fixture was inserted, so rebuild
        // the derived search index just as a sync would.
        const db = new Database(testDbPath);
        const { rebuildSearchIndex } = await import('../src/search_fts.js');
        rebuildSearchIndex(db);
        db.close();

        const response = JSON.parse(await callMcpTool('search_everything', {
            query: 'MHz Fixture Client',
            entity_types: ['client', 'licence'],
            include_related: true,
        }));
        const rows = expandRows(response);
        expect(rows.some(row => row.ENTITY_TYPE === 'client' && row.ENTITY_ID === '9001')).toBe(true);
        expect(response.total).toBeGreaterThan(0);
    }, 15000);

    test('cached results are pageable and identical calls are deduplicated', async () => {
        const first = JSON.parse(await callMcpTool('search_frequency_assignments', {
            freq_min_mhz: 476.425,
            freq_max_mhz: 477.4125,
            limit: 2,
            page_size: 1,
        }));
        expect(first.rows).toHaveLength(1);
        expect(first.has_more).toBe(true);

        const page = JSON.parse(await callMcpTool('get_result_page', {
            result_id: first.result_id,
            offset: 1,
            limit: 1,
        }));
        expect(page.rows).toHaveLength(1);
        expect(page.has_more).toBe(false);

        const duplicate = JSON.parse(await callMcpTool('search_frequency_assignments', {
            freq_min_mhz: 476.425,
            freq_max_mhz: 477.4125,
            limit: 2,
        }));
        expect(duplicate).toMatchObject({ duplicate: true, result_id: first.result_id });
    }, 15000);

    // ─── End _hints tests ──────────────────────────────────────────────────────

    // ─── get_frequency_allocation integration tests ───────────────────────────

    test('get_frequency_allocation returns "data not loaded" error when spectrum tables are empty', async () => {
        // The test DB is initialised but the spectrum_* tables have no rows yet
        // (the spectrum-plan seed is only auto-applied at the tail of performFullSync,
        // which doesn't run in this integration setup). The tool should detect this
        // and return a structured _error envelope rather than an empty array.
        const response = await callMcpTool('get_frequency_allocation', { freq_hz: 87100000 });
        const parsed = JSON.parse(response);
        expect(parsed._error).toBeDefined();
        expect(parsed._error).toMatch(/spectrum plan data not loaded/i);
    }, 15000);

    test('get_frequency_allocation returns matching allocation + footnotes after seeding', async () => {
        // Seed the spectrum tables directly via applyReseed so the next call to
        // the MCP tool has data to return. We use a tiny fixture rather than
        // the full seed/spectrum_plan.sql so the test stays fast and offline-safe.
        const Database = (await import('better-sqlite3')).default;
        const { applyReseed } = await import('../src/spectrum_plan.js');
        const fixture = path.join(__dirname, 'fixtures', 'spectrum_plan_smoke.sql');
        if (!fs.existsSync(path.dirname(fixture))) fs.mkdirSync(path.dirname(fixture), { recursive: true });
        // New schema: spectrum_allocations(freq_start_hz, freq_end_hz, unit, page, services_json, footnotes_json, raw)
        // services_json: array of { name, primary, inline_footnotes, qualifier? }
        // footnotes_json: array of footnote ref strings
        fs.writeFileSync(fixture, `BEGIN TRANSACTION;
INSERT INTO spectrum_allocations(freq_start_hz, freq_end_hz, unit, page, services_json, footnotes_json, raw)
  VALUES(87000000, 108000000, 'MHz', 42,
    '[{"name":"BROADCASTING","primary":true,"inline_footnotes":["AUS37"]}]',
    '["AUS37","5.87"]',
    'BROADCASTING AUS37');
INSERT INTO spectrum_australian_footnotes(footnote_ref, footnote_text) VALUES('AUS37', 'AUS37 body.');
INSERT INTO spectrum_international_footnotes(footnote_ref, footnote_text) VALUES('5.87', '5.87 ITU body.');
INSERT INTO spectrum_plan_meta VALUES('source_description', 'Smoke fixture');
INSERT INTO spectrum_plan_meta VALUES('published_date', '2018-01-01');
COMMIT;
`);
        const seedDb = new Database(testDbPath);
        try {
            applyReseed(seedDb, fixture);
        } finally { seedDb.close(); }

        const response = await callMcpTool('get_frequency_allocation', { freq_hz: 87100000, include_hints: true });
        const parsed = JSON.parse(response);
        expect(parsed.match_count).toBe(1);
        // New shape: allocation (singular object) instead of allocations[0]
        expect(parsed.allocation).toBeDefined();
        expect(typeof parsed.allocation).toBe('object');
        expect(parsed.allocation.services[0].name).toBe('BROADCASTING');
        expect(parsed.allocation.services[0].primary).toBe(true);
        // regions object with ITU R1/R2/R3 contrast keys
        expect(parsed.regions).toBeDefined();
        expect(Object.keys(parsed.regions)).toEqual(expect.arrayContaining(['1', '2', '3']));
        // resolved_footnotes flat map
        expect(parsed.resolved_footnotes).toBeDefined();
        expect(parsed.resolved_footnotes['AUS37']).toBe('AUS37 body.');
        // match_count is numeric
        expect(typeof parsed.match_count).toBe('number');
        // staleness warning fires for 2018-01-01
        expect(parsed._warning).toMatch(/8 years old|published 2018/);
        expect(parsed._hints).toBeDefined();
        expect(parsed._hints.some((h: any) => h.tool === 'search_licences')).toBe(true);

        const mhzResponse = await callMcpTool('get_frequency_allocation', { freq_mhz: 87.1 });
        const mhzParsed = JSON.parse(mhzResponse);
        expect(mhzParsed.match_count).toBe(1);
        expect(mhzParsed.query).toMatchObject({
            input_unit: 'MHz',
            freq_hz: 87100000,
            freq_mhz: 87.1,
        });

        fs.unlinkSync(fixture);
    }, 15000);

    // ─── End get_frequency_allocation tests ───────────────────────────────────

    // ─── decode_emission_designator + search_devices_by_emission tests ────────

    test('decode_emission_designator: happy path', async () => {
        const transport = new StreamableHTTPClientTransport(new URL(`http://localhost:${PORT}/mcp`));
        const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
        await client.connect(transport);
        const res = await client.callTool({ name: 'decode_emission_designator', arguments: { code: '16K0F3E', include_hints: true } });
        const payload = JSON.parse((res.content as any)[0].text);
        expect(payload.valid).toBe(true);
        expect(payload.bandwidth.value_hz).toBe(16000);
        expect(payload.modulation.code).toBe('F');
        expect(payload.info_type.code).toBe('E');
        expect(payload._hints.some((h: any) => h.tool === 'search_devices_by_emission' && h.args?.modulation === 'F')).toBe(true);
        await transport.close();
    }, 15000);

    test('decode_emission_designator: empty input', async () => {
        const transport = new StreamableHTTPClientTransport(new URL(`http://localhost:${PORT}/mcp`));
        const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
        await client.connect(transport);
        const res = await client.callTool({ name: 'decode_emission_designator', arguments: { code: '' } });
        const payload = JSON.parse((res.content as any)[0].text);
        expect(payload.valid).toBe(false);
        expect(payload.warnings.length).toBeGreaterThan(0);
        // No _hints key emitted on invalid path.
        expect(payload._hints).toBeUndefined();
        await transport.close();
    }, 15000);

    test('search_devices_by_emission: happy path with seeded fixture', async () => {
        // The test DB starts empty for device_details; insert two rows so the search has something to find.
        const fixtureDb = new Database(testDbPath);
        try {
            fixtureDb.prepare(`INSERT INTO device_details(SDD_ID, LICENCE_NO, EMISSION, FREQUENCY, SITE_ID) VALUES
                (9001, 'TEST-L1', '16K0F3E', 150000000, NULL),
                (9002, 'TEST-L2', '10M0W7D', 2400000000, NULL)`).run();
        } finally { fixtureDb.close(); }

        const transport = new StreamableHTTPClientTransport(new URL(`http://localhost:${PORT}/mcp`));
        const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
        await client.connect(transport);
        const res = await client.callTool({ name: 'search_devices_by_emission', arguments: { modulation: 'F', info_type: 'E', include_hints: true } });
        const payload = JSON.parse((res.content as any)[0].text);
        expect(payload._error).toBeUndefined();
        expect(payload.rows.length).toBeGreaterThanOrEqual(1);
        const rows = expandRows(payload);
        expect(rows[0].decoded.modulation_code).toBe('F');
        expect(rows[0].decoded.info_type_description).toContain('Telephony');
        expect(payload.resolved_filters.modulation.code).toBe('F');
        expect(payload._hints?.length).toBeGreaterThan(0);
        expect(payload._hints.some((h: any) => h.tool === 'decode_emission_designator' && h.args?.code)).toBe(true);
        await transport.close();
    }, 20000);

    test('search_devices_by_emission: description-resolution path', async () => {
        const transport = new StreamableHTTPClientTransport(new URL(`http://localhost:${PORT}/mcp`));
        const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
        await client.connect(transport);
        const res = await client.callTool({ name: 'search_devices_by_emission', arguments: { modulation: 'frequency modulation', info_type: 'telephony' } });
        const payload = JSON.parse((res.content as any)[0].text);
        expect(payload._error).toBeUndefined();
        expect(payload.resolved_filters.modulation.code).toBe('F');
        expect(payload.resolved_filters.info_type.code).toBe('E');
        await transport.close();
    }, 15000);

    test('search_devices_by_emission: ambiguous description returns candidate list', async () => {
        const transport = new StreamableHTTPClientTransport(new URL(`http://localhost:${PORT}/mcp`));
        const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
        await client.connect(transport);
        const res = await client.callTool({ name: 'search_devices_by_emission', arguments: { modulation: 'sideband' } });
        const payload = JSON.parse((res.content as any)[0].text);
        expect(payload._error).toBeDefined();
        expect(payload._error).toContain('ambiguous');
        await transport.close();
    }, 15000);

    test('search_devices_by_emission: no filters returns error', async () => {
        const transport = new StreamableHTTPClientTransport(new URL(`http://localhost:${PORT}/mcp`));
        const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
        await client.connect(transport);
        const res = await client.callTool({ name: 'search_devices_by_emission', arguments: {} });
        const payload = JSON.parse((res.content as any)[0].text);
        expect(payload._error).toBe('At least one filter is required.');
        await transport.close();
    }, 15000);

    test('search_devices_by_emission: unknown code letter returns error', async () => {
        const transport = new StreamableHTTPClientTransport(new URL(`http://localhost:${PORT}/mcp`));
        const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
        await client.connect(transport);
        const res = await client.callTool({ name: 'search_devices_by_emission', arguments: { modulation: 'Z' } });
        const payload = JSON.parse((res.content as any)[0].text);
        expect(payload._error).toContain('Z');
        await transport.close();
    }, 15000);

    // ─── End emission tests ───────────────────────────────────────────────────

    test('every advertised tool has a TOOL_DOCS entry', async () => {
        // Read TOOL_DOCS via dynamic import to avoid module side-effects at file load time.
        const { TOOL_DOCS } = await import('../src/index');
        const advertised = [
            'search_licences', 'get_licence_details', 'search_sites', 'get_site_details',
            'search_clients', 'search_bsl', 'search_spectrum_band', 'search_application_text',
            'lookup_client', 'search_everything',
            'get_frequency_allocation', 'sync_data', 'list_sample_queries', 'execute_sql',
            'export_kml', 'get_result_page', 'describe_schema', 'describe_tool', 'explain_query',
            'decode_emission_designator', 'search_devices_by_emission',
        ];
        for (const name of advertised) {
            expect(TOOL_DOCS[name]).toBeDefined();
            expect(TOOL_DOCS[name]!.summary.length).toBeLessThan(200);
            expect(TOOL_DOCS[name]!.tags.length).toBeGreaterThan(0);
            expect(TOOL_DOCS[name]!.fullDescription.length).toBeGreaterThan(50);
        }
    });
});
