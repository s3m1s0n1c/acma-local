import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import Database from 'better-sqlite3';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { initializeDatabase } from './db.js';
import { DEFAULT_CONFIG, getSyncStatus, sync } from './sync.js';
import { searchRecords, getRecord, type EntityType } from './search.js';
import { parseFrequencyHz, searchFrequencies } from './frequency.js';
import { ResultCache } from './result_cache.js';
import { lookupFrequencyAllocation } from './spectrum_plan.js';
import { decodeEmissionDesignator } from './emissions.js';
import { executeSqlWithTimeout, describeSchema } from './sql.js';
import { generateKml } from './kml.js';
import { log } from './logger.js';

const VERSION = '2.0.0';
const dbPath = process.env.ACMA_DB_PATH || DEFAULT_CONFIG.dbPath;
const PORT = Number(process.env.PORT || 3000);
const DEFAULT_PAGE_SIZE = Math.max(1, Math.min(100, Number(process.env.MCP_DEFAULT_PAGE_SIZE || 10)));
const cache = new ResultCache();
const transports = new Map<string, StreamableHTTPServerTransport>();

const ENTITY_TYPES: EntityType[] = [
  'client', 'licence', 'callsign', 'device', 'site', 'broadcast', 'application',
];

export const TOOL_DOCS = {
  search_records: {
    summary: 'Search names, addresses, clients, licences, call signs, device IDs, sites, broadcasts and application text.',
  },
  get_record: {
    summary: 'Open one search result and return its database record plus useful related licences or assignments.',
  },
  search_frequencies: {
    summary: 'Find exact or ranged frequency assignments. Accepts Hz, kHz, MHz or GHz; 476.425 auto-means MHz.',
  },
  spectrum_reference: {
    summary: 'Look up the Australian and ITU spectrum-plan allocation covering one frequency.',
  },
  decode_emission: {
    summary: 'Decode an emission designator such as 16K0F3E.',
  },
  database: {
    summary: 'Advanced fallback: inspect the schema or run a read-only SQL query when the search tools cannot answer.',
  },
  get_result_page: {
    summary: 'Read another page from a previous search result without repeating the database query.',
  },
  export_kml: {
    summary: 'Turn a cached result containing latitude and longitude into KML.',
  },
  sync_data: {
    summary: 'Check sync status or start an automatic/full ACMA data sync.',
  },
} as const;

function openDb(): Database.Database {
  return new Database(dbPath, { readonly: true, fileMustExist: true });
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function error(message: string) {
  return {
    content: [{ type: 'text' as const, text: json({ error: message }) }],
    isError: true,
  };
}

function response(tool: string, started: number, value: unknown, rows = 0, cached = false) {
  const output = json(value);
  log.info(
    `[MCP] tool=${tool} db_ms=${Math.round(performance.now() - started)} ` +
    `rows=${rows} output_bytes=${Buffer.byteLength(output)} cached=${cached}`
  );
  return { content: [{ type: 'text' as const, text: output }] };
}

function pageSize(args: Record<string, unknown> | undefined): number {
  const value = Number(args?.page_size);
  if (!Number.isFinite(value)) return DEFAULT_PAGE_SIZE;
  return Math.max(1, Math.min(100, Math.trunc(value)));
}

function createServer(): Server {
  const server = new Server(
    { name: 'acma-rrl-server', version: VERSION },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'search_records',
        description: TOOL_DOCS.search_records.summary,
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Name, address, licence/client number, ABN/ACN, call sign, device ID, site or text.',
            },
            entity_types: {
              type: 'array',
              items: { type: 'string', enum: ENTITY_TYPES },
              description: 'Optional categories. Use application explicitly for narrative full-text search.',
            },
            limit: {
              type: 'integer',
              description: 'Total matches to retain for paging (default 50, max 500).',
            },
            page_size: {
              type: 'integer',
              description: 'Rows returned now (default 10, max 100).',
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'get_record',
        description: TOOL_DOCS.get_record.summary,
        inputSchema: {
          type: 'object',
          properties: {
            entity_type: { type: 'string', enum: ENTITY_TYPES },
            id: {
              type: 'string',
              description: 'ENTITY_ID from search_records. A plain exact call sign also works.',
            },
            include_related: {
              type: 'boolean',
              description: 'Include linked licences or assignments (default true).',
            },
            related_limit: {
              type: 'integer',
              description: 'Maximum linked rows (default 20, max 100).',
            },
          },
          required: ['entity_type', 'id'],
        },
      },
      {
        name: 'search_frequencies',
        description: TOOL_DOCS.search_frequencies.summary,
        inputSchema: {
          type: 'object',
          properties: {
            frequency: {
              oneOf: [{ type: 'number' }, { type: 'string' }],
              description: 'Examples: 476.425, "476.425 MHz", or 476425000.',
            },
            unit: {
              type: 'string',
              enum: ['auto', 'Hz', 'kHz', 'MHz', 'GHz'],
              description: 'Default auto: values under 1,000,000 mean MHz; larger values mean Hz.',
            },
            to_frequency: {
              oneOf: [{ type: 'number' }, { type: 'string' }],
              description: 'Optional upper end of a range, using the same unit.',
            },
            tolerance_hz: {
              type: 'number',
              description: 'Optional tolerance around the requested value. Default 0 means exact only.',
            },
            scope: {
              type: 'string',
              enum: ['assignments', 'authorisations', 'all'],
              description: 'Default assignments searches device frequencies.',
            },
            limit: {
              type: 'integer',
              description: 'Total matches retained for paging (default 50, max 500).',
            },
            page_size: {
              type: 'integer',
              description: 'Rows returned now (default 10, max 100).',
            },
          },
          required: ['frequency'],
        },
      },
      {
        name: 'spectrum_reference',
        description: TOOL_DOCS.spectrum_reference.summary,
        inputSchema: {
          type: 'object',
          properties: {
            frequency: {
              oneOf: [{ type: 'number' }, { type: 'string' }],
              description: 'Examples: 87.1, "87.1 MHz", or 87100000.',
            },
            unit: {
              type: 'string',
              enum: ['auto', 'Hz', 'kHz', 'MHz', 'GHz'],
            },
            include_footnotes: {
              type: 'boolean',
              description: 'Include resolved footnote text (default false for speed).',
            },
          },
          required: ['frequency'],
        },
      },
      {
        name: 'decode_emission',
        description: TOOL_DOCS.decode_emission.summary,
        inputSchema: {
          type: 'object',
          properties: {
            code: { type: 'string', description: 'Emission designator, for example 16K0F3E.' },
          },
          required: ['code'],
        },
      },
      {
        name: 'database',
        description: TOOL_DOCS.database.summary,
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['schema', 'query'] },
            tables: {
              type: 'array',
              items: { type: 'string' },
              description: 'For schema: optional table names.',
            },
            sql: {
              type: 'string',
              description: 'For query: one read-only SELECT or WITH statement.',
            },
            limit: {
              type: 'integer',
              description: 'For query: maximum rows retained (default 100, max 500).',
            },
            page_size: {
              type: 'integer',
              description: 'For query: rows returned now (default 10, max 100).',
            },
          },
          required: ['action'],
        },
      },
      {
        name: 'get_result_page',
        description: TOOL_DOCS.get_result_page.summary,
        inputSchema: {
          type: 'object',
          properties: {
            result_id: { type: 'string' },
            offset: { type: 'integer', description: 'Zero-based row offset.' },
            limit: { type: 'integer', description: 'Rows to return (default 10, max 500).' },
          },
          required: ['result_id'],
        },
      },
      {
        name: 'export_kml',
        description: TOOL_DOCS.export_kml.summary,
        inputSchema: {
          type: 'object',
          properties: { result_id: { type: 'string' } },
          required: ['result_id'],
        },
      },
      {
        name: 'sync_data',
        description: TOOL_DOCS.sync_data.summary,
        inputSchema: {
          type: 'object',
          properties: {
            mode: { type: 'string', enum: ['status', 'auto', 'full'] },
          },
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async request => {
    const started = performance.now();
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, any>;

    try {
      if (name === 'search_records') {
        const db = openDb();
        let rows;
        try {
          rows = searchRecords(db, {
            query: args.query,
            entity_types: args.entity_types,
            limit: args.limit ?? 50,
          });
        } finally {
          db.close();
        }
        const stored = cache.putObjects(name, {
          query: args.query,
          entity_types: args.entity_types ?? null,
          limit: args.limit ?? 50,
        }, rows as any[]);
        const page = cache.page(stored.entry, 0, pageSize(args));
        if (stored.duplicate) page.duplicate = true;
        return response(name, started, page, rows.length, stored.duplicate);
      }

      if (name === 'get_record') {
        if (!ENTITY_TYPES.includes(args.entity_type)) return error('Invalid entity_type.');
        const db = openDb();
        let result;
        try {
          result = getRecord(
            db,
            args.entity_type,
            args.id,
            args.include_related !== false,
            args.related_limit ?? 20
          );
        } finally {
          db.close();
        }
        if (!result) return error(`No ${args.entity_type} record found for ${args.id}.`);
        return response(name, started, result, 1);
      }

      if (name === 'search_frequencies') {
        const db = openDb();
        let result;
        try {
          result = searchFrequencies(db, {
            frequency: args.frequency,
            unit: args.unit ?? 'auto',
            to_frequency: args.to_frequency,
            tolerance_hz: args.tolerance_hz,
            scope: args.scope ?? 'assignments',
            limit: args.limit ?? 50,
          });
        } finally {
          db.close();
        }
        const stored = cache.putObjects(name, {
          frequency: args.frequency,
          unit: args.unit ?? 'auto',
          to_frequency: args.to_frequency ?? null,
          tolerance_hz: args.tolerance_hz ?? 0,
          scope: args.scope ?? 'assignments',
          limit: args.limit ?? 50,
        }, result.rows as any[]);
        const page = cache.page(stored.entry, 0, pageSize(args));
        const payload = { query: result.query, ...page, ...(stored.duplicate ? { duplicate: true } : {}) };
        return response(name, started, payload, result.rows.length, stored.duplicate);
      }

      if (name === 'spectrum_reference') {
        const hz = parseFrequencyHz(args.frequency, args.unit ?? 'auto');
        const db = openDb();
        let result;
        try {
          result = lookupFrequencyAllocation(db, hz, args.include_footnotes === true);
        } finally {
          db.close();
        }
        return response(name, started, { frequency_hz: hz, ...result }, result.match_count);
      }

      if (name === 'decode_emission') {
        if (typeof args.code !== 'string') return error('code must be a string.');
        return response(name, started, decodeEmissionDesignator(args.code), 1);
      }

      if (name === 'database') {
        if (args.action === 'schema') {
          const db = openDb();
          let result;
          try {
            result = describeSchema(db, args.tables);
          } finally {
            db.close();
          }
          return response(name, started, result, Array.isArray(result) ? result.length : 1);
        }
        if (args.action === 'query') {
          if (typeof args.sql !== 'string') return error('sql is required when action=query.');
          const result = await executeSqlWithTimeout(dbPath, args.sql, args.limit ?? 100, 25_000);
          const stored = cache.put(name, {
            sql: args.sql,
            limit: args.limit ?? 100,
          }, result.columns, result.rows);
          const page = cache.page(stored.entry, 0, pageSize(args));
          if (stored.duplicate) page.duplicate = true;
          return response(name, started, page, result.rowCount, stored.duplicate);
        }
        return error('action must be schema or query.');
      }

      if (name === 'get_result_page') {
        const entry = cache.get(args.result_id);
        if (!entry) return error('Result not found or expired. Run the search again.');
        const page = cache.page(entry, args.offset ?? 0, args.limit ?? DEFAULT_PAGE_SIZE);
        return response(name, started, page, page.returned, true);
      }

      if (name === 'export_kml') {
        const entry = cache.get(args.result_id);
        if (!entry) return error('Result not found or expired. Run the search again.');
        const kml = generateKml(entry.columns, entry.rows);
        log.info(
          `[MCP] tool=${name} db_ms=${Math.round(performance.now() - started)} ` +
          `rows=${entry.rows.length} output_bytes=${Buffer.byteLength(kml)} cached=true`
        );
        return { content: [{ type: 'text' as const, text: kml }] };
      }

      if (name === 'sync_data') {
        const mode = args.mode ?? 'status';
        if (mode !== 'status' && !getSyncStatus().isSyncing) {
          sync(DEFAULT_CONFIG, mode === 'full' ? 'full' : 'auto').catch(errorValue => {
            log.error('[SYNC] Background failure:', errorValue);
          });
        }
        return response(name, started, getSyncStatus(), 1);
      }

      return error(`Unknown tool: ${name}`);
    } catch (errorValue) {
      const message = errorValue instanceof Error ? errorValue.message : String(errorValue);
      log.error(`[MCP] tool=${name} failed: ${message}`);
      return error(message);
    }
  });

  return server;
}

async function main() {
  initializeDatabase(dbPath);
  const app = express();
  app.use(express.json());

  app.get('/health', (req, res) => {
    const status = getSyncStatus();
    const body: Record<string, unknown> = {
      status: 'ok',
      version: VERSION,
      isSyncing: status.isSyncing,
      ...(status.dataAsOf ? { dataAsOf: status.dataAsOf } : {}),
      ...(status.lastSyncAt ? { lastSyncAt: status.lastSyncAt } : {}),
      ...(status.remoteAsOf ? { remoteAsOf: status.remoteAsOf } : {}),
      ...(status.behindByHours !== undefined ? { behindByHours: status.behindByHours } : {}),
    };

    if (req.query.deep === '1') {
      try {
        const db = openDb();
        try {
          db.prepare('SELECT COUNT(*) AS n FROM meta').get();
          body.db = 'reachable';
        } finally {
          db.close();
        }
      } catch (errorValue) {
        body.status = 'degraded';
        body.db = 'unreachable';
        body.dbError = errorValue instanceof Error ? errorValue.message : String(errorValue);
        return res.status(500).json(body);
      }
    }
    res.json(body);
  });

  app.all('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (sessionId && transports.has(sessionId)) {
      try {
        await transports.get(sessionId)!.handleRequest(req, res, req.body);
      } catch (errorValue) {
        const message = errorValue instanceof Error ? errorValue.message : String(errorValue);
        log.error('[MCP] Transport error:', message);
        if (!res.headersSent) res.status(500).json({ error: message });
      }
      return;
    }

    if (req.method !== 'POST') {
      return res.status(400).json({ error: 'Send POST /mcp with initialize to start a session.' });
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: id => {
        transports.set(id, transport);
        log.info(`[SESSION] Opened: ${id}`);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) {
        transports.delete(transport.sessionId);
        log.info(`[SESSION] Closed: ${transport.sessionId}`);
      }
    };

    await createServer().connect(transport as any);
    try {
      await transport.handleRequest(req, res, req.body);
    } catch (errorValue) {
      const message = errorValue instanceof Error ? errorValue.message : String(errorValue);
      log.error('[MCP] Init error:', message);
      if (!res.headersSent) res.status(500).json({ error: message });
    }
  });

  const httpServer = app.listen(PORT, '0.0.0.0', () => {
    log.info(`ACMA RRL MCP Server v${VERSION} running on port ${PORT} at http://localhost:${PORT}/mcp`);
    log.info(`Tools: ${Object.keys(TOOL_DOCS).join(', ')}`);
    log.info(`MCP default_page_size=${DEFAULT_PAGE_SIZE}`);
  });

  const shutdown = (signal: string) => {
    log.info(`[SHUTDOWN] Received ${signal}; closing server.`);
    for (const transport of transports.values()) {
      try {
        transport.close();
      } catch {}
    }
    transports.clear();
    httpServer.close(errorValue => process.exit(errorValue ? 1 : 0));
    setTimeout(() => process.exit(1), 30_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (process.argv[1]?.endsWith('index.ts') || process.argv[1]?.endsWith('index.js')) {
  main().catch(errorValue => {
    log.error('Fatal error:', errorValue);
    process.exit(1);
  });
}
