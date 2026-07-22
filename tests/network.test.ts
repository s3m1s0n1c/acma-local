import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import Database from 'better-sqlite3';
import axios from 'axios';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeDatabase } from '../src/db.js';

const directory = path.dirname(fileURLToPath(import.meta.url));

describe('MCP v2 network integration', () => {
  const port = 3001;
  const databasePath = path.join(directory, 'test_mcp_v2.db');
  let server: ChildProcess;

  beforeAll(async () => {
    if (fs.existsSync(databasePath)) fs.unlinkSync(databasePath);
    initializeDatabase(databasePath);
    const db = new Database(databasePath);
    db.exec(`
      INSERT INTO client (
        CLIENT_NO, LICENCEE, POSTAL_STREET, POSTAL_SUBURB, POSTAL_STATE, POSTAL_POSTCODE
      ) VALUES (101, 'Ian Nash', '1 Example Street', 'Newcastle', 'NSW', '2300');
      INSERT INTO licence (LICENCE_NO, CLIENT_NO) VALUES ('1234567/1', 101);
      INSERT INTO site (
        SITE_ID, NAME, STATE, POSTCODE, LATITUDE, LONGITUDE
      ) VALUES ('S100', 'Mount Example', 'NSW', '2300', -32.9, 151.7);
      INSERT INTO device_details (
        SDD_ID, LICENCE_NO, DEVICE_REGISTRATION_IDENTIFIER,
        FREQUENCY, SITE_ID, CALL_SIGN
      ) VALUES (5001, '1234567/1', 'DEV-5001', 476425000, 'S100', 'VK2ABC');
    `);
    db.close();

    server = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      cwd: path.resolve(directory, '..'),
      env: {
        ...process.env,
        PORT: String(port),
        ACMA_DB_PATH: databasePath,
        LOG_LEVEL: 'info',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Server startup timed out.')), 30_000);
      const onData = (chunk: Buffer) => {
        if (chunk.toString().includes(`running on port ${port}`)) {
          clearTimeout(timer);
          resolve();
        }
      };
      server.stderr?.on('data', onData);
      server.once('exit', code => {
        clearTimeout(timer);
        reject(new Error(`Server exited during startup with code ${code}.`));
      });
    });
  }, 45_000);

  afterAll(async () => {
    if (server && !server.killed) {
      server.kill('SIGTERM');
      await new Promise(resolve => server.once('exit', resolve));
    }
    if (fs.existsSync(databasePath)) fs.unlinkSync(databasePath);
  });

  async function withClient<T>(run: (client: Client) => Promise<T>): Promise<T> {
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/mcp`)
    );
    const client = new Client(
      { name: 'integration-test', version: '1.0.0' },
      { capabilities: {} }
    );
    await client.connect(transport);
    try {
      return await run(client);
    } finally {
      await transport.close();
    }
  }

  function parsed(result: any): any {
    return JSON.parse(result.content[0].text);
  }

  function objects(page: any): Array<Record<string, unknown>> {
    return page.rows.map((row: unknown[]) =>
      Object.fromEntries(page.columns.map((column: string, index: number) => [column, row[index]]))
    );
  }

  test('health reports v2 and a reachable database', async () => {
    const result = await axios.get(`http://127.0.0.1:${port}/health?deep=1`);
    expect(result.data).toMatchObject({
      status: 'ok',
      version: '2.0.0',
      db: 'reachable',
    });
  });

  test('advertises only the nine focused tools', async () => {
    await withClient(async client => {
      const listed = await client.listTools();
      expect(listed.tools.map(tool => tool.name)).toEqual([
        'search_records',
        'get_record',
        'search_frequencies',
        'spectrum_reference',
        'decode_emission',
        'database',
        'get_result_page',
        'export_kml',
        'sync_data',
      ]);
      for (const tool of listed.tools) {
        expect(tool.description!.length).toBeLessThan(200);
      }
    });
  });

  test('searches a person and returns their address in one compact call', async () => {
    await withClient(async client => {
      const page = parsed(await client.callTool({
        name: 'search_records',
        arguments: { query: 'Ian Nash', page_size: 10 },
      }));
      const rows = objects(page);
      expect(rows[0]).toMatchObject({
        ENTITY_TYPE: 'client',
        PRIMARY_TEXT: 'Ian Nash',
        CLIENT_NO: 101,
        ADDRESS: '1 Example Street, Newcastle, NSW, 2300',
      });
      expect(page).not.toHaveProperty('_hints');
    });
  });

  test('searches a call sign and returns its holder and address', async () => {
    await withClient(async client => {
      const page = parsed(await client.callTool({
        name: 'search_records',
        arguments: { query: 'VK2ABC', entity_types: ['callsign'] },
      }));
      expect(objects(page)[0]).toMatchObject({
        CALL_SIGN: 'VK2ABC',
        LICENCE_NO: '1234567/1',
        SECONDARY_TEXT: 'Ian Nash',
        ADDRESS: '1 Example Street, Newcastle, NSW, 2300',
      });
    });
  });

  test('matches 476.425 MHz exactly and reports the interpreted Hz value', async () => {
    await withClient(async client => {
      const page = parsed(await client.callTool({
        name: 'search_frequencies',
        arguments: { frequency: 476.425, unit: 'auto', tolerance_hz: 0 },
      }));
      expect(page.query).toMatchObject({
        requested_frequency_hz: 476425000,
        min_hz: 476425000,
        max_hz: 476425000,
        exact: true,
      });
      expect(objects(page)[0]).toMatchObject({
        FREQUENCY_HZ: 476425000,
        DISTANCE_HZ: 0,
        MATCH_TYPE: 'exact',
      });
    });
  });

  test('reuses identical searches and pages cached data', async () => {
    await withClient(async client => {
      const first = parsed(await client.callTool({
        name: 'search_records',
        arguments: { query: 'Ian Nash', page_size: 1 },
      }));
      const repeated = parsed(await client.callTool({
        name: 'search_records',
        arguments: { query: 'Ian Nash', page_size: 1 },
      }));
      expect(repeated.result_id).toBe(first.result_id);
      expect(repeated.duplicate).toBe(true);

      const next = parsed(await client.callTool({
        name: 'get_result_page',
        arguments: { result_id: first.result_id, offset: 0, limit: 10 },
      }));
      expect(next.total).toBeGreaterThan(0);
    });
  });

  test('keeps the advanced database fallback read-only', async () => {
    await withClient(async client => {
      const selected = parsed(await client.callTool({
        name: 'database',
        arguments: { action: 'query', sql: 'SELECT COUNT(*) AS total FROM client' },
      }));
      expect(objects(selected)[0]).toEqual({ total: 1 });

      const rejected = await client.callTool({
        name: 'database',
        arguments: { action: 'query', sql: 'DELETE FROM client' },
      }) as any;
      expect(rejected.isError).toBe(true);
      expect(rejected.content[0].text).toMatch(/SELECT|read-only/i);
    });
  });
});
