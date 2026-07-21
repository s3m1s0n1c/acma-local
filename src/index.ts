/**
 * ACMA RRL MCP Server - Network Mode
 *
 * Per-session StreamableHTTPServerTransport (official MCP multi-client pattern).
 * Full tool catalog: search_sites, search_licences, search_clients,
 *                    get_client_details, search_frequency_assignments,
 *                    get_licence_details, get_site_details, sync_data,
 *                    execute_sql, list_sample_queries, export_kml,
 *                    search_bsl, search_spectrum_band, search_application_text,
 *                    describe_schema, describe_tool, explain_query,
 *                    get_frequency_allocation, decode_emission_designator,
 *                    search_devices_by_emission, get_result_page.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import Database from 'better-sqlite3';
import { initializeDatabase } from './db.js';
import { DEFAULT_CONFIG, sync, getSyncStatus } from './sync.js';
import express from 'express';
import { randomUUID } from 'node:crypto';
import {
    searchSites,
    searchLicences,
    searchClients,
    getClientDetails,
    getLicenceDetails,
    getSiteDetails,
    searchFrequencyAssignments,
    searchBsl,
    searchSpectrumBand,
    searchApplicationText,
} from './logic.js';
import { executeSqlWithTimeout, listSampleQueries, describeSchema, explainQuery } from './sql.js';
import { generateKml } from './kml.js';
import { lookupFrequencyAllocation } from './spectrum_plan.js';
import { decodeEmissionDesignator } from './emissions.js';
import { searchDevicesByEmission } from './emissions_search.js';
import { normalizeFrequencyPoint, normalizeFrequencyRange } from './frequency_input.js';
import { ResultCache, objectRowsToColumnar } from './result_cache.js';
import { log } from './logger.js';

const dbPath = process.env.ACMA_DB_PATH || DEFAULT_CONFIG.dbPath;
const PORT = process.env.PORT || 3000;

// ─── Tool Documentation Map ───────────────────────────────────────────────────

interface ToolDoc {
    summary: string;      // ≤150 chars; appears in tools/list
    tags: string[];       // ['primary'], ['geospatial'], ['fts'], ['meta'], ['sync'], ['sql'], etc.
    fullDescription: string;  // returned by describe_tool
}

export const TOOL_DOCS: Record<string, ToolDoc> = {
    search_licences: {
        summary: 'Search licences by number, holder name, client number, ABN or ACN. [primary]',
        tags: ['primary', 'sql'],
        fullDescription: `
### [Licence Search] PRIMARY SEARCH TOOL
Search ACMA RRL licences by licence number or holder identity.

## Usage
- Accepts a licence number, client number, licencee/trading name, ABN or ACN.
- Results include resolved service, subservice, status and holder fields.

## Input
- query: Licence number or holder identity`,
    },
    get_licence_details: {
        summary: 'Full licence: holder, devices, sites, antenna/area lookups, BSL, spectrum and text links.',
        tags: ['lookup', 'geospatial-result'],
        fullDescription: `
### [Licence Details]
Get full details for a specific licence: client info and all associated radio devices.

## Usage
- Use after finding a licence number via search_licences
- Returns the holder, up to device_limit devices, truncation metadata, BSL details,
  spectrum authorisations and application-text references.
- Device rows resolve site, antenna, service, station and satellite relationships.
- If results contain geospatial data, a result_id is returned for optional KML export via export_kml

## Input
- licence_no: Exact licence number (e.g. "1191324/1")
- device_limit: Maximum device rows (default 50, max 500)`,
    },
    search_sites: {
        summary: 'Search sites by ID, name, postcode or state; includes coordinates and device counts.',
        tags: ['lookup', 'geospatial-result'],
        fullDescription: `
### [Site Search]
Search transmission sites by site name or postcode.

## Usage
- Use when asked about a transmitter location or site
- Results include: SITE_ID, NAME, STATE, POSTCODE, LATITUDE, LONGITUDE
- A result_id is returned for optional KML export via export_kml

## Input
- query: Site name or postcode`,
    },
    get_site_details: {
        summary: 'Full site + related devices, holders, licences, services and antennas.',
        tags: ['lookup', 'geospatial-result'],
        fullDescription: `
### [Site Details]
Get full details for a specific site including all devices registered at that site.

## Usage
- Use after finding a SITE_ID via search_sites
- Returns: site record, up to device_limit associated device_details records
- A result_id is returned for optional KML export via export_kml

## Input
- site_id: Exact Site ID from site search results
- device_limit: Maximum device rows (default 50, max 500)`,
    },
    search_clients: {
        summary: 'Search clients by name, ID, ABN/ACN or any postal-address field. [primary]',
        tags: ['lookup'],
        fullDescription: `
### [Client / Licensee Search]
Search licence holders using all identity and postal-address fields.

## Usage
- Use for people/business names, client number, ABN, ACN, street, suburb, state or postcode.
- Results contain the complete postal address and a LICENCE_COUNT.
- Follow the returned get_client_details hint to list that client's licences.

## Input
- query: Name, client number, ABN/ACN or address text`,
    },
    get_client_details: {
        summary: 'Get one client/holder with postal address and up to 500 related licences.',
        tags: ['lookup'],
        fullDescription: `
### [Client Details]
Resolve a CLIENT_NO through the CLIENT_NO relationship to licence records.

## Input
- client_no: Exact numeric client ID from search_clients.
- licence_limit: Maximum related licences (default 50, max 500).

## Output
- client: full holder and postal-address record with resolved client type, fee status and industry.
- licences: related licence records with resolved service/subservice/status.
- licences_total, licences_returned, licences_truncated: explicit pagination metadata.`,
    },
    search_frequency_assignments: {
        summary: 'Search ordinary device assignments using an explicit Hz or MHz range, optionally by state. [primary]',
        tags: ['primary', 'spectrum', 'geospatial-result'],
        fullDescription: `
### [Device Frequency Assignment Search]
Search DEVICE_DETAILS assignments, including carrier and equipment frequency ranges.

Use this for ordinary frequency questions such as "who uses 476.625 MHz in NSW?".
Do not substitute search_spectrum_band: that tool only covers area-wide spectrum licences.
Pass MHz values directly in the *_mhz fields. Do not convert MHz to Hz in the chat client.

## Input
- freq_min_mhz / freq_max_mhz: Preferred when the user gives MHz, e.g. 476.425 and 477.4125.
- freq_min_hz / freq_max_hz: Use when the user explicitly gives Hz.
- Use one unit pair only. The upper bound is optional and defaults to the lower bound.
- state: Optional state code, e.g. NSW.
- limit: Default 50, max 500.

## Output
The interpreted query in both Hz and MHz, returned/truncated counts, plus assignment,
licence, holder, service and site/coordinate fields.`,
    },
    search_bsl: {
        summary: 'Search broadcasting service licences by call sign, BSL number, or on-air ID.',
        tags: ['broadcasting'],
        fullDescription: `
### [Broadcasting Licence Search]
Search broadcasting service licences (BSLs) by call sign, BSL number, or on-air ID.

## Usage
- Use for queries about broadcast/TV/radio operators (e.g. "what's the call sign for ABC Sydney?")
- Results include: BSL_NO, CALL_SIGN, MEDIUM_CATEGORY, REGION_CATEGORY, BSL_STATE, DATE_COMMENCED, ON_AIR_ID, AREA_NAME

## Input
- query: CALL_SIGN, BSL_NO, or ON_AIR_ID`,
    },
    search_spectrum_band: {
        summary: 'Find area-wide spectrum licences overlapping an explicit Hz or MHz band; not device assignments.',
        tags: ['spectrum'],
        fullDescription: `
### [Spectrum Authorisation Search]
Find licences authorised in a frequency range expressed in either Hz or MHz.

## Usage
- Use for queries like "who's licenced between 1800 and 1900 MHz?"
- Pass either the *_mhz pair or the *_hz pair; result rows overlap the requested range
- Results include LICENCE_NO, AREA_NAME, frequency endpoints, CLIENT_NO

## Input
- freq_min_mhz / freq_max_mhz: Bounds in MHz (e.g. 1800 and 1900)
- freq_min_hz / freq_max_hz: Bounds in Hz
- Use one unit pair only`,
    },
    search_application_text: {
        summary: 'FTS5 full-text search over licence application narrative.',
        tags: ['fts'],
        fullDescription: `
### [Licence Application Text Search]
Full-text search across licence application narrative (conditions, exemptions, special clauses).

## Usage
- Pass an FTS5 query string. Supports: phrase ("text in quotes"), AND/OR, NEAR/N, prefix*.
- Results return APTB_ID, LICENCE_NO, APTB_CATEGORY, APTB_DESCRIPTION, a snippet with «match» markers, and a BM25 rank score (lower is better).
- For full text of a matching APTB_ID, follow up with execute_sql: SELECT APTB_TEXT FROM applic_text_block WHERE APTB_ID = ...

## Input
- query: FTS5 query (e.g. 'aeronautical', '"marine emergency"', 'ICAO OR ITU')`,
    },
    sync_data: {
        summary: 'Sync local RRL mirror. mode=auto applies incrementals; mode=full re-pulls the 70 MB extract.',
        tags: ['sync'],
        fullDescription: `
### [Data Synchronization]
Download and import the latest ACMA RRL changes. Safe to call while server is running.

## Usage
- Default mode='auto' applies incremental change-zips only (cheap, mobile-friendly).
- Use mode='full' to force a full extract reimport (~70 MB) when 'gap-exceeded' is reported.
- Call once to start sync, then poll to check progress.

## Status fields
- progress: 0-100%
- currentTable: which CSV is being imported
- dataAsOf: how fresh the local data is (ISO 8601)
- remoteAsOf: latest available upstream (ISO 8601)
- behindByHours: derived staleness; 0 when current`,
    },
    list_sample_queries: {
        summary: '[SQL] List sample queries. Bare call returns category index; filter by category/name for details.',
        tags: ['sql', 'meta'],
        fullDescription: `
### [SQL Sample Queries]
Curated SQL examples grouped by category. Bare call returns a compact category index; filter to drill in.

## Usage
- Call once with no args to see categories and query descriptions
- Then call with { category: "geospatial" } or { name: "NBN" } to fetch the SQL bodies

## Categories
- lookup: "All <table>" queries
- statistics: counts and aggregates
- geospatial: lat/lng and KML-friendly queries
- text-search: applic_text_block / client / site text matches
- power-user: CTE templates and advanced joins
- data-dict: sqlite_master introspection`,
    },
    execute_sql: {
        summary: '[SQL] Run a read-only SELECT/WITH query against the RRL database (max 500 rows).',
        tags: ['sql'],
        fullDescription: `
### [SQL Query Executor]
Run a read-only SELECT or WITH (CTE) query directly against the ACMA RRL SQLite database.

## Usage
- Use describe_schema to discover available tables and columns at runtime
- Use list_sample_queries first if unsure what to query
- Only SELECT/WITH statements are allowed — no INSERT, UPDATE, DELETE, DROP etc.
- Results capped at 'limit' rows (default 100, max 500)
- If results contain geospatial columns (LATITUDE/LONGITUDE or GEOMETRY), a result_id is returned for optional KML export via export_kml

## Output
{ columns: string[], rows: any[][], truncated: boolean, rowCount: number, result_id?: string, _hints?: ... }`,
    },
    export_kml: {
        summary: '[KML] Render a previously-cached query result as a KML overlay.',
        tags: ['geospatial'],
        fullDescription: `
### [KML Export]
Generate a KML file from cached query results.

## Usage
- Call this AFTER running a query that returned a result_id (e.g. execute_sql, search_sites, get_site_details, get_licence_details)
- Returns a KML <Placemark> collection ready to drop into Google Earth or any KML-aware viewer

## Input
- result_id: the result_id returned by the previous tool call`,
    },
    describe_schema: {
        summary: '[Meta] Returns columns, indexes, row counts for one or more tables; omit `tables` for all.',
        tags: ['meta', 'sql'],
        fullDescription: `
### [Schema Introspection]
Runtime schema discovery. Returns columns + indexes + row counts for the named tables.

## Usage
- Call with no args to enumerate every materialised table
- Pass { tables: ['licence', 'site'] } to drill in to specific tables
- Virtual tables (e.g. applic_text_block_fts) appear with isVirtual: true

## Output
Array of { name, columns, indexes, rowCount, isVirtual } records.`,
    },
    describe_tool: {
        summary: '[Meta] Returns the full markdown documentation for a tool by name.',
        tags: ['meta'],
        fullDescription: `
### [Tool Documentation]
Returns the verbose, full-markdown documentation for any tool advertised by this server.

## Usage
- tools/list gives a compact summary per tool
- Call describe_tool({ name: 'search_licences' }) for the full description, including Usage notes, Input fields, and Output shape

## Input
- name: Exact tool name (case-sensitive)`,
    },
    explain_query: {
        summary: '[SQL] Returns SQLite EXPLAIN QUERY PLAN output for a SELECT/WITH statement.',
        tags: ['sql', 'meta'],
        fullDescription: `
### [Query Plan Explainer]
Returns SQLite's EXPLAIN QUERY PLAN output for a read-only query.

## Usage
- Pass a SELECT or WITH ... SELECT statement
- Returns plan rows with { id, parent, notused, detail }
- Use to understand index choices, scan vs lookup, join order

## Input
- sql: A SELECT or WITH ... SELECT statement (same restrictions as execute_sql)`,
    },
    get_frequency_allocation: {
        summary: 'Look up an ACMA Spectrum Plan allocation using explicit Hz or MHz. Returns AU + ITU regions and footnotes.',
        tags: ['lookup', 'spectrum'],
        fullDescription: `
### [Spectrum Allocation Lookup]
Look up the Australian Radiofrequency Spectrum Plan (ARSP) allocation for a given frequency,
with ITU Region 1/2/3 contrast and resolved footnote text.

## Input
- \`freq_mhz\` — Preferred when the user gives MHz, e.g. 87.1.
- \`freq_hz\` — Use when the user explicitly gives Hz. Examples:
  - \`87100000\` → 87.1 MHz (FM broadcast band)
  - \`2400000000\` → 2.4 GHz (ISM band)
  - \`14000000\` → 14 MHz (amateur 20 m band)
- \`include_footnotes\` — Boolean, default \`true\`. When false, \`resolved_footnotes\` is omitted (faster).

## Response shape

| Field | Type | Description |
|-------|------|-------------|
| \`query\` | object | Echoes the interpreted frequency in both Hz and MHz. |
| \`match_count\` | number | Number of AU allocations covering this frequency. Normally 0 or 1; >1 indicates a plan overlap and triggers a \`_warning\`. |
| \`allocation\` | object\|null | The AU allocation row covering the frequency, or \`null\` when nothing matches. |
| \`regions\` | object | ITU R1/R2/R3 contrast. Keys \`"1"\`, \`"2"\`, \`"3"\`; each value is an allocation row or \`null\`. |
| \`resolved_footnotes\` | object | Flat map of \`footnote_ref → footnote_text\` covering all refs in \`allocation\` + all \`regions\`. Omitted when \`include_footnotes=false\`. |
| \`source\` | object | \`{ published_date, last_patch_date }\` — provenance from \`spectrum_plan_meta\`. |
| \`_warning\` | string | Staleness or integrity notice. Present when base data is ≥ 3 years old, no match found, or >1 overlapping rows detected. Absent otherwise. |
| \`_hints\` | array | Optional cross-link suggestions. Present only when \`include_hints: true\`. |

### Allocation / region row fields

Each \`allocation\` row (and each non-null \`regions[n]\` row) contains:

| Field | Type | Description |
|-------|------|-------------|
| \`freq_start_hz\` | number | Band start in Hz. |
| \`freq_end_hz\` | number | Band end in Hz (exclusive). |
| \`unit\` | string | Display unit from the plan table (e.g. \`"MHz"\`). |
| \`page\` | number | Source page in the ARSP document. |
| \`services\` | array | Parsed service entries (see below). |
| \`footnotes\` | string[] | Cell-level footnote refs (e.g. \`["AUS37","5.87"]\`). |
| \`raw\` | string | Original table-cell text (unparsed). |
| \`region\` | number | Present only on region rows (1, 2, or 3). Absent on \`allocation\`. |

### Service entry fields

Each \`services[]\` element:

| Field | Type | Description |
|-------|------|-------------|
| \`name\` | string | Service name as it appears in the plan (e.g. \`"BROADCASTING"\`). |
| \`primary\` | boolean | \`true\` when the service is written ALL CAPS in the plan, indicating a primary allocation basis. \`false\` for secondary (mixed case). |
| \`inline_footnotes\` | string[] | Footnote refs that appeared inline with this service entry. |
| \`qualifier\` | string | Optional qualifier text (e.g. \`"(Earth-to-space)"\`). Absent when none. |

## Example

**Call:**
\`\`\`json
{ "name": "get_frequency_allocation", "arguments": { "freq_mhz": 87.1 } }
\`\`\`

**Response (truncated):**
\`\`\`json
{
  "match_count": 1,
  "allocation": {
    "freq_start_hz": 87000000,
    "freq_end_hz": 108000000,
    "unit": "MHz",
    "page": 42,
    "services": [
      { "name": "BROADCASTING", "primary": true, "inline_footnotes": ["AUS37"] }
    ],
    "footnotes": ["AUS37", "5.87"],
    "raw": "BROADCASTING AUS37"
  },
  "regions": {
    "1": { "freq_start_hz": 87500000, "freq_end_hz": 108000000, "services": [...], "region": 1, ... },
    "2": { "freq_start_hz": 87500000, "freq_end_hz": 108000000, "services": [...], "region": 2, ... },
    "3": null
  },
  "resolved_footnotes": {
    "AUS37": "AUS37 — The frequency band 87–108 MHz ...",
    "5.87": "5.87 — In the band 87.5–108 MHz ..."
  },
  "source": { "published_date": "2021-06-24", "last_patch_date": null },
  "_hints": [
    { "tool": "search_licences", "why": "find licences operating in this band" },
    { "tool": "search_application_text", "why": "search application text for this band's usage" }
  ]
}
\`\`\`

## Notes
- The plan is updated by legislative amendment; consult the current legislation for any licensing decision.
- When \`include_footnotes=false\`, the response is faster but \`resolved_footnotes\` is absent.
- \`_warning\` is added when the base data is ≥ 3 years old; verify against the current legislation before any licensing decision.`,
    },
    decode_emission_designator: {
        summary: 'Decode an ITU/ACA emission designator (e.g. 16K0F3E) into bandwidth, modulation, signal nature, info type and optional details. [reference]',
        tags: ['reference', 'emission'],
        fullDescription: `
### [Decode Emission Designator]
Decode an ITU/ACA emission designator (the 7- or 9-character code stored in \`device_details.EMISSION\`) into structured fields.

## Usage
- Pass the raw designator string. Trailing whitespace is tolerated.
- Returns parsed bandwidth (Hz + display), modulation, signal nature, info type, and (when present) signal detail + multiplex.

## Input
- code: e.g. "16K0F3E" (classic FM telephony), "10M0W7D" (combined-mode digital data), "19M8W7DEW" (9-char form with optional fields).

## Output
- valid: true if bandwidth parsed AND all three required body codes are known. Optional codes are recorded as warnings, not errors.
- warnings[]: non-fatal observations (whitespace, unknown optional codes, length mismatch).
- _hints: when \`include_hints: true\`, includes a prefilled search_devices_by_emission call.

## Notes
- The decoder is the inverse of search_devices_by_emission: one designator → many fields; use search_devices_by_emission to go the other way (one filter → many devices).
- Codes are per the ACA "Emission characteristics of radio transmissions" booklet (ITU worldwide standard, 1982).`,
    },
    search_devices_by_emission: {
        summary: 'Find devices/licences whose emission designator matches decoded filters (modulation, info type, etc.) — accepts code letters or descriptions. [search]',
        tags: ['search', 'emission'],
        fullDescription: `
### [Search Devices by Emission]
Find device_details rows whose EMISSION designator matches one or more decoded descriptors.

## Usage
- Each filter may be a code letter (e.g. \`modulation: 'F'\`) OR a description substring (e.g. \`modulation: 'frequency modulation'\`, or just \`'frequency'\`).
- At least one filter is required.
- Description substring is matched case-insensitively against the relevant emission_* lookup table.
- If a description resolves to zero or more than one code, the tool returns an explicit \`_error\` listing the candidates rather than silently picking one.

## Input
- modulation:     code letter or description substring (e.g. 'F', 'frequency', 'reduced').
- signal_nature:  code digit or description substring (e.g. '3', 'single channel analogue').
- info_type:      code letter or description substring (e.g. 'C', 'facsimile', 'telephony').
- signal_detail:  optional. Code letter or description substring.
- multiplex:      optional. Code letter or description substring.
- min_bandwidth_hz, max_bandwidth_hz: bandwidth bounds in Hz. Devices with unparseable EMISSION are excluded when these are set.
- licence_no:     restrict to one licence.
- state:          state code from the joined site row (e.g. 'NSW', 'QLD').
- limit:          default 100, max 500.

## Output
- rows[]: each row carries LICENCE_NO, CLIENT_NO, FREQUENCY, EMISSION, decoded summary (modulation/info-type descriptions, parsed bandwidth), SITE_ID, STATE, and transmitter power.
- resolved_filters: echoes back the codes the handler actually matched on — useful when you passed a description.
- _hints: optional links returned only when \`include_hints: true\`.

## Notes
- Description-only resolution is the common case; you don't need to memorise that R = SSB-reduced-carrier or C = facsimile.
- For aggregate questions ("most common modulation across all devices"), use execute_sql with SUBSTR + emission_modulation join — see list_sample_queries.`,
    },
    get_result_page: {
        summary: 'Read another page from a cached search result without repeating the database query.',
        tags: ['meta'],
        fullDescription: `
### [Cached Result Page]
Return a compact columnar page from a previous search result.

## Input
- result_id: ID returned by a search tool.
- offset: Zero-based row offset (default 0).
- limit: Page size (default 25, max 100).

Cached results expire after 30 minutes.`,
    },
};

// ─── Result Cache ────────────────────────────────────────────────────────────
// Caches query results (columns + rows) so KML can be generated on demand
// without re-running the query. 30-minute TTL.

const resultCache = new ResultCache();

function cacheResult(columns: string[], rows: unknown[][]): string {
    return resultCache.putAnonymous(columns, rows).id;
}

// Cleanup expired results every 5 mins
setInterval(() => {
    resultCache.cleanup();
}, 300_000).unref();

function pagedSearchResponse(
    tool: string,
    args: Record<string, unknown>,
    objectRows: Array<Record<string, unknown>>,
    extra: Record<string, unknown> = {},
    hints?: unknown[]
): Record<string, unknown> {
    const { columns, rows } = objectRowsToColumnar(objectRows);
    return pagedColumnarResponse(tool, args, columns, rows, extra, hints);
}

function pagedColumnarResponse(
    tool: string,
    args: Record<string, unknown>,
    columns: string[],
    rows: unknown[][],
    extra: Record<string, unknown> = {},
    hints?: unknown[]
): Record<string, unknown> {
    const { entry, duplicate } = resultCache.put(tool, args, columns, rows);
    if (duplicate) {
        return {
            duplicate: true,
            result_id: entry.id,
            total: entry.rows.length,
            message: 'Identical result already returned. Use get_result_page if another page is needed.',
        };
    }
    const page = resultCache.page(
        entry.id,
        (args['offset'] as number | undefined) ?? 0,
        (args['page_size'] as number | undefined) ?? 25
    )!;
    return {
        ...page,
        ...extra,
        ...(args['include_hints'] === true && hints?.length ? { _hints: hints } : {}),
    };
}

/**
 * Detects whether a result set contains geospatial data (lat/lng or geometry columns).
 */
function hasGeospatialData(columns: string[]): boolean {
    const lCols = columns.map(c => c.toLowerCase());
    const hasLatLng = lCols.includes('latitude') && lCols.includes('longitude');
    const hasGeometry = lCols.includes('geometry');
    return hasLatLng || hasGeometry;
}

// ─── DB Helper ───────────────────────────────────────────────────────────────

function openDb() {
    return new Database(dbPath, { readonly: true });
}

const HINT_OPTION = {
    include_hints: {
        type: 'boolean',
        description: 'Return optional follow-up suggestions. Default false to avoid automatic tool chains.',
    },
} as const;

const PAGED_RESPONSE_OPTIONS = {
    ...HINT_OPTION,
    page_size: {
        type: 'integer', minimum: 1, maximum: 100,
        description: 'Rows delivered in this response (default 25). The complete result remains cached.',
    },
    offset: {
        type: 'integer', minimum: 0,
        description: 'Initial zero-based result offset (default 0).',
    },
} as const;

const DB_TOOLS = new Set([
    'search_licences', 'get_licence_details', 'search_sites', 'get_site_details',
    'search_clients', 'get_client_details', 'search_frequency_assignments',
    'search_bsl', 'search_spectrum_band', 'search_application_text',
    'describe_schema', 'explain_query', 'execute_sql', 'get_frequency_allocation',
    'search_devices_by_emission',
]);

function createServer(): Server {
    const server = new Server(
        { name: 'acma-rrl-server', version: '1.10.0' },
        { capabilities: { tools: {} } }
    );

    // ─── Tool Catalog ───────────────────────────────────────────────────────────

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
            {
                name: 'search_licences',
                description: TOOL_DOCS.search_licences!.summary,
                inputSchema: {
                    type: 'object',
                    properties: {
                        ...PAGED_RESPONSE_OPTIONS,
                        query: { type: 'string', description: 'Licence number, holder name, client number, ABN or ACN' },
                        limit: { type: 'number', description: 'Max results (default 10)' },
                    },
                    required: ['query'],
                },
            },
            {
                name: 'get_licence_details',
                description: TOOL_DOCS.get_licence_details!.summary,
                inputSchema: {
                    type: 'object',
                    properties: {
                        ...HINT_OPTION,
                        licence_no: { type: 'string', description: 'Exact licence number, e.g. "1191324/1"' },
                        device_limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Max devices (default 50)' },
                    },
                    required: ['licence_no'],
                },
            },
            {
                name: 'search_sites',
                description: TOOL_DOCS.search_sites!.summary,
                inputSchema: {
                    type: 'object',
                    properties: {
                        ...PAGED_RESPONSE_OPTIONS,
                        query: { type: 'string', description: 'Site name or postcode' },
                        limit: { type: 'number', description: 'Max results (default 10)' },
                    },
                    required: ['query'],
                },
            },
            {
                name: 'get_site_details',
                description: TOOL_DOCS.get_site_details!.summary,
                inputSchema: {
                    type: 'object',
                    properties: {
                        ...HINT_OPTION,
                        site_id: { type: 'string', description: 'Site ID, e.g. "124"' },
                        device_limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Max devices (default 50)' },
                    },
                    required: ['site_id'],
                },
            },
            {
                name: 'search_clients',
                description: TOOL_DOCS.search_clients!.summary,
                inputSchema: {
                    type: 'object',
                    properties: {
                        ...PAGED_RESPONSE_OPTIONS,
                        query: { type: 'string', description: 'Name, client number, ABN/ACN, street, suburb, state or postcode' },
                        limit: { type: 'number', description: 'Max results (default 10)' },
                    },
                    required: ['query'],
                },
            },
            {
                name: 'get_client_details',
                description: TOOL_DOCS.get_client_details!.summary,
                inputSchema: {
                    type: 'object',
                    properties: {
                        ...HINT_OPTION,
                        client_no: { type: 'integer', description: 'Exact CLIENT_NO from search_clients' },
                        licence_limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Max licences (default 50)' },
                    },
                    required: ['client_no'],
                },
            },
            {
                name: 'search_frequency_assignments',
                description: TOOL_DOCS.search_frequency_assignments!.summary,
                inputSchema: {
                    type: 'object',
                    properties: {
                        ...PAGED_RESPONSE_OPTIONS,
                        freq_min_mhz: { type: 'number', exclusiveMinimum: 0, description: 'Preferred when the user gives MHz: exact frequency or lower bound, e.g. 476.425' },
                        freq_max_mhz: { type: 'number', exclusiveMinimum: 0, description: 'Optional upper bound in MHz, e.g. 477.4125' },
                        freq_min_hz: { type: 'number', exclusiveMinimum: 0, description: 'Use only when the user explicitly gives Hz: exact frequency or lower bound' },
                        freq_max_hz: { type: 'number', exclusiveMinimum: 0, description: 'Optional upper bound in Hz' },
                        state: { type: 'string', description: 'Optional state code, e.g. NSW' },
                        limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Max rows (default 50)' },
                    },
                    anyOf: [
                        { required: ['freq_min_mhz'] },
                        { required: ['freq_min_hz'] },
                    ],
                },
            },
            {
                name: 'search_bsl',
                description: TOOL_DOCS.search_bsl!.summary,
                inputSchema: {
                    type: 'object',
                    properties: {
                        ...PAGED_RESPONSE_OPTIONS,
                        query: { type: 'string', description: 'CALL_SIGN, BSL_NO, or ON_AIR_ID' },
                        limit: { type: 'number', description: 'Max rows (default 10)' },
                    },
                    required: ['query'],
                },
            },
            {
                name: 'search_spectrum_band',
                description: TOOL_DOCS.search_spectrum_band!.summary,
                inputSchema: {
                    type: 'object',
                    properties: {
                        ...PAGED_RESPONSE_OPTIONS,
                        freq_min_mhz: { type: 'number', exclusiveMinimum: 0, description: 'Preferred when the user gives MHz: lower bound' },
                        freq_max_mhz: { type: 'number', exclusiveMinimum: 0, description: 'Upper bound in MHz' },
                        freq_min_hz: { type: 'number', exclusiveMinimum: 0, description: 'Use only when the user explicitly gives Hz: lower bound' },
                        freq_max_hz: { type: 'number', exclusiveMinimum: 0, description: 'Upper bound in Hz' },
                        limit:       { type: 'number', description: 'Max rows (default 20)' },
                    },
                    anyOf: [
                        { required: ['freq_min_mhz'] },
                        { required: ['freq_min_hz'] },
                    ],
                },
            },
            {
                name: 'search_application_text',
                description: TOOL_DOCS.search_application_text!.summary,
                inputSchema: {
                    type: 'object',
                    properties: {
                        ...PAGED_RESPONSE_OPTIONS,
                        query: { type: 'string', description: 'FTS5 query string' },
                        limit: { type: 'number', description: 'Max rows (default 20)' },
                    },
                    required: ['query'],
                },
            },
            {
                name: 'sync_data',
                description: TOOL_DOCS.sync_data!.summary,
                inputSchema: {
                    type: 'object',
                    properties: {
                        mode: {
                            type: 'string',
                            enum: ['auto', 'full'],
                            description:
                                "'auto' (default) applies incremental change-zips only. " +
                                "'full' force-pulls and reimports the ~70 MB full extract — " +
                                "use after a long offline period or to recover from gap-exceeded.",
                        },
                    },
                },
            },
            {
                name: 'list_sample_queries',
                description: TOOL_DOCS.list_sample_queries!.summary,
                inputSchema: {
                    type: 'object',
                    properties: {
                        category: {
                            type: 'string',
                            enum: ['lookup', 'statistics', 'geospatial', 'text-search', 'power-user', 'data-dict'],
                            description: 'Filter to one category',
                        },
                        name: {
                            type: 'string',
                            description: 'Substring match on description',
                        },
                    },
                },
            },
            {
                name: 'describe_schema',
                description: TOOL_DOCS.describe_schema!.summary,
                inputSchema: {
                    type: 'object',
                    properties: {
                        tables: {
                            type: 'array',
                            items: { type: 'string' },
                            description: 'Optional list of table names (case-insensitive); omit for all.',
                        },
                    },
                },
            },
            {
                name: 'explain_query',
                description: TOOL_DOCS.explain_query!.summary,
                inputSchema: {
                    type: 'object',
                    properties: {
                        sql: { type: 'string', description: 'A SELECT or WITH ... SELECT statement' },
                    },
                    required: ['sql'],
                },
            },
            {
                name: 'execute_sql',
                description: TOOL_DOCS.execute_sql!.summary,
                inputSchema: {
                    type: 'object',
                    properties: {
                        ...PAGED_RESPONSE_OPTIONS,
                        sql: {
                            type: 'string',
                            description: 'A SELECT SQL query to run against the ACMA RRL database',
                        },
                        limit: {
                            type: 'number',
                            description: 'Max rows to return (default 100, max 500)',
                        },
                    },
                    required: ['sql'],
                },
            },
            {
                name: 'export_kml',
                description: TOOL_DOCS.export_kml!.summary,
                inputSchema: {
                    type: 'object',
                    properties: {
                        result_id: { type: 'string', description: 'The result_id from a previous query response' },
                    },
                    required: ['result_id'],
                },
            },
            {
                name: 'get_result_page',
                description: TOOL_DOCS.get_result_page!.summary,
                inputSchema: {
                    type: 'object',
                    properties: {
                        result_id: { type: 'string', description: 'Cached result_id returned by a search tool' },
                        offset: { type: 'integer', minimum: 0, description: 'Zero-based row offset (default 0)' },
                        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Rows to return (default 25)' },
                    },
                    required: ['result_id'],
                },
            },
            {
                name: 'describe_tool',
                description: TOOL_DOCS.describe_tool!.summary,
                inputSchema: {
                    type: 'object',
                    properties: {
                        name: { type: 'string', description: 'Exact tool name (case-sensitive)' },
                    },
                    required: ['name'],
                },
            },
            {
                name: 'get_frequency_allocation',
                description: TOOL_DOCS.get_frequency_allocation!.summary,
                inputSchema: {
                    type: 'object',
                    properties: {
                        ...HINT_OPTION,
                        freq_mhz: {
                            type: 'number',
                            exclusiveMinimum: 0,
                            description: 'Preferred when the user gives MHz, e.g. 87.1.',
                        },
                        freq_hz: {
                            type: 'number',
                            exclusiveMinimum: 0,
                            description: 'Use only when the user explicitly gives Hz, e.g. 87100000.',
                        },
                        include_footnotes: {
                            type: 'boolean',
                            description: 'If true (default), include full footnote text.',
                        },
                    },
                    anyOf: [
                        { required: ['freq_mhz'] },
                        { required: ['freq_hz'] },
                    ],
                },
            },
            {
                name: 'decode_emission_designator',
                description: TOOL_DOCS.decode_emission_designator!.summary,
                inputSchema: {
                    type: 'object',
                    properties: {
                        ...HINT_OPTION,
                        code: { type: 'string', description: 'Emission designator, e.g. 16K0F3E or 10M0W7D' },
                    },
                    required: ['code'],
                },
            },
            {
                name: 'search_devices_by_emission',
                description: TOOL_DOCS.search_devices_by_emission!.summary,
                inputSchema: {
                    type: 'object',
                    properties: {
                        ...PAGED_RESPONSE_OPTIONS,
                        modulation:       { type: 'string', description: "Code letter (e.g. 'R', 'F') or description substring (e.g. 'reduced', 'frequency modulation')" },
                        signal_nature:    { type: 'string', description: "Code digit (e.g. '3') or description substring" },
                        info_type:        { type: 'string', description: "Code letter (e.g. 'C', 'E') or description substring (e.g. 'facsimile', 'telephony')" },
                        signal_detail:    { type: 'string', description: 'Optional. Code letter or description substring.' },
                        multiplex:        { type: 'string', description: 'Optional. Code letter or description substring.' },
                        min_bandwidth_hz: { type: 'number',  description: 'Lower bound on parsed bandwidth (inclusive).' },
                        max_bandwidth_hz: { type: 'number',  description: 'Upper bound on parsed bandwidth (inclusive).' },
                        licence_no:       { type: 'string',  description: 'Restrict to one licence.' },
                        state:            { type: 'string',  description: "State code from the joined site row (e.g. 'NSW')." },
                        limit:            { type: 'integer', description: 'Default 100, max 500.' },
                    },
                },
            },
        ],
    }));

    // ─── Tool Handlers ──────────────────────────────────────────────────────────

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;
        const started = performance.now();
        let completed: any;
        try {
            completed = await (async () => {

        if (name === 'search_licences') {
            const db = openDb();
            try {
                const rows = searchLicences(db, args?.query as string, (args?.limit as number) ?? 10) as any[];
                const hints = rows.length > 0 && rows[0]?.LICENCE_NO ? [{
                        tool: 'get_licence_details',
                        args: { licence_no: rows[0].LICENCE_NO },
                        why: 'devices + holder for the first result',
                    }] : undefined;
                const response = pagedSearchResponse(name, args ?? {}, rows, {}, hints);
                return { content: [{ type: 'text', text: JSON.stringify(response) }] };
            } finally { if (db.open) db.close(); }
        }

        if (name === 'get_licence_details') {
            const db = openDb();
            try {
                const result = getLicenceDetails(
                    db,
                    args?.licence_no as string,
                    (args?.device_limit as number) ?? 50
                );
                if (!result) return { content: [{ type: 'text', text: `No licence found for: ${args?.licence_no}` }] };

                // Cache devices for potential KML export (devices now include site coords)
                let resultId: string | undefined;
                if (result.devices.length > 0) {
                    const columns = Object.keys(result.devices[0] as object);
                    if (hasGeospatialData(columns)) {
                        const rows = result.devices.map(r => columns.map(c => (r as any)[c]));
                        resultId = cacheResult(columns, rows);
                    }
                }

                const response: any = { ...result };
                if (resultId) response.result_id = resultId;
                if (args?.include_hints === true && resultId && (result.devices as any[]).some((d: any) => d.LATITUDE != null && d.LONGITUDE != null)) {
                    response._hints = [{
                        tool: 'export_kml',
                        args: { result_id: resultId },
                        why: 'render geospatially',
                    }];
                }

                return { content: [{ type: 'text', text: JSON.stringify(response) }] };
            } finally { if (db.open) db.close(); }
        }

        if (name === 'search_sites') {
            const db = openDb();
            try {
                const rows = searchSites(db, args?.query as string, (args?.limit as number) ?? 10) as any[];

                const hints = rows.length > 0 ? [{
                        tool: 'get_site_details',
                        args: { site_id: String(rows[0].SITE_ID) },
                        why: 'devices at this site',
                    }] : undefined;
                const response = pagedSearchResponse(name, args ?? {}, rows, {}, hints);
                return { content: [{ type: 'text', text: JSON.stringify(response) }] };
            } finally { if (db.open) db.close(); }
        }

        if (name === 'get_site_details') {
            const db = openDb();
            try {
                const result = getSiteDetails(
                    db,
                    args?.site_id as string,
                    (args?.device_limit as number) ?? 50
                );
                if (!result) return { content: [{ type: 'text', text: `No site found for ID: ${args?.site_id}` }] };

                // Cache site record for potential KML export
                let resultId: string | undefined;
                const columns = Object.keys(result.site as object);
                if (hasGeospatialData(columns)) {
                    const rows = [columns.map(c => (result.site as any)[c])];
                    resultId = cacheResult(columns, rows);
                }

                const response: any = { ...result };
                if (resultId) response.result_id = resultId;
                if (args?.include_hints === true && resultId) {
                    response._hints = [{
                        tool: 'export_kml',
                        args: { result_id: resultId },
                        why: 'render geospatially',
                    }];
                }

                return { content: [{ type: 'text', text: JSON.stringify(response) }] };
            } finally { if (db.open) db.close(); }
        }

        if (name === 'search_clients') {
            const db = openDb();
            try {
                const rows = searchClients(db, args?.query as string, (args?.limit as number) ?? 10) as any[];
                const hints = rows.length > 0 && rows[0]?.CLIENT_NO != null ? [{
                        tool: 'get_client_details',
                        args: { client_no: rows[0].CLIENT_NO },
                        why: 'licences held by the first matching client',
                    }] : undefined;
                const response = pagedSearchResponse(name, args ?? {}, rows, {}, hints);
                return { content: [{ type: 'text', text: JSON.stringify(response) }] };
            } finally { if (db.open) db.close(); }
        }

        if (name === 'get_client_details') {
            const db = openDb();
            try {
                const result = getClientDetails(
                    db,
                    args?.client_no as number,
                    (args?.licence_limit as number) ?? 50
                );
                if (!result) return { content: [{ type: 'text', text: `No client found for ID: ${args?.client_no}` }] };
                const response: any = { ...result };
                if (args?.include_hints === true && result.licences.length > 0 && (result.licences[0] as any).LICENCE_NO) {
                    response._hints = [{
                        tool: 'get_licence_details',
                        args: { licence_no: (result.licences[0] as any).LICENCE_NO },
                        why: 'devices and authorisations for the first licence',
                    }];
                }
                return { content: [{ type: 'text', text: JSON.stringify(response) }] };
            } finally { if (db.open) db.close(); }
        }

        if (name === 'search_frequency_assignments') {
            const db = openDb();
            try {
                let query;
                try {
                    query = normalizeFrequencyRange(args ?? {});
                } catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    return { content: [{ type: 'text', text: JSON.stringify({ _error: message }) }], isError: true };
                }
                const state = args?.state as string | undefined;
                const rawLimit = args?.limit as number | undefined;
                const limit = Number.isFinite(rawLimit)
                    ? Math.min(Math.max(1, Math.trunc(rawLimit!)), 500)
                    : 50;
                const matches = searchFrequencyAssignments(
                    db,
                    query.freq_min_hz,
                    query.freq_max_hz,
                    state,
                    limit + 1
                ) as any[];
                const truncated = matches.length > limit;
                const rows = truncated ? matches.slice(0, limit) : matches;
                const hints = rows.length > 0 && rows[0]?.LICENCE_NO ? [{
                    tool: 'get_licence_details',
                    args: { licence_no: rows[0].LICENCE_NO },
                    why: 'full details for the first matching assignment',
                }] : undefined;
                const response = pagedSearchResponse(name, args ?? {}, rows, {
                    query,
                    rows_returned: rows.length,
                    rows_truncated: truncated,
                }, hints);
                return { content: [{ type: 'text', text: JSON.stringify(response) }] };
            } finally { if (db.open) db.close(); }
        }

        if (name === 'search_bsl') {
            const db = openDb();
            try {
                const results = searchBsl(db, args?.query as string, (args?.limit as number) ?? 10);
                const response = pagedSearchResponse(name, args ?? {}, results as Array<Record<string, unknown>>);
                return { content: [{ type: 'text', text: JSON.stringify(response) }] };
            } finally { if (db.open) db.close(); }
        }

        if (name === 'search_spectrum_band') {
            const db = openDb();
            try {
                let query;
                try {
                    query = normalizeFrequencyRange(args ?? {});
                } catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    return { content: [{ type: 'text', text: JSON.stringify({ _error: message }) }], isError: true };
                }
                const results = searchSpectrumBand(
                    db,
                    query.freq_min_hz,
                    query.freq_max_hz,
                    (args?.limit as number) ?? 20
                );
                const response = pagedSearchResponse(name, args ?? {}, results as Array<Record<string, unknown>>, { query });
                return { content: [{ type: 'text', text: JSON.stringify(response) }] };
            } finally { db.close(); }
        }

        if (name === 'search_application_text') {
            const db = openDb();
            try {
                const rows = searchApplicationText(
                    db,
                    args?.query as string,
                    (args?.limit as number) ?? 20
                ) as any[];
                const hints = rows.length > 0 && rows[0]?.APTB_ID != null ? [{
                        tool: 'execute_sql',
                        args: { sql: `SELECT APTB_TEXT FROM applic_text_block WHERE APTB_ID = ${rows[0].APTB_ID}` },
                        why: 'full text for the first result',
                    }] : undefined;
                const response = pagedSearchResponse(name, args ?? {}, rows, {}, hints);
                return { content: [{ type: 'text', text: JSON.stringify(response) }] };
            } finally { db.close(); }
        }

        if (name === 'sync_data') {
            // Trigger the sync (mode defaults to 'auto'). Fire-and-forget; the
            // user polls by calling sync_data again to read getSyncStatus().
            const mode = args?.['mode'] === 'full' ? 'full' : 'auto';
            const wasSyncing = getSyncStatus().isSyncing;
            let launched = false;
            if (!wasSyncing) {
                // Kick off async; intentionally not awaited so this response is fast.
                sync(DEFAULT_CONFIG, mode).catch((e: unknown) => {
                    log.error('[MCP] sync_data background failure:', e);
                });
                launched = true;
            }

            const status = getSyncStatus();
            const decisionLine = status.reason
                ? `Last decision: ${status.mode ? `${status.mode} sync — ` : ''}${status.reason}` +
                  (status.detail ? ` (${status.detail})` : '') +
                  (status.lastDecisionAt ? ` at ${status.lastDecisionAt}` : '')
                : null;

            const freshness: string[] = [];
            if (status.dataAsOf) freshness.push(`dataAsOf: ${status.dataAsOf}`);
            if (status.remoteAsOf) freshness.push(`remoteAsOf: ${status.remoteAsOf}`);
            if (status.behindByHours !== undefined) freshness.push(`behindByHours: ${status.behindByHours}`);
            if (status.lastSyncAt) freshness.push(`lastSyncAt: ${status.lastSyncAt}`);
            if (status.lastFullSyncAt) freshness.push(`lastFullSyncAt: ${status.lastFullSyncAt}`);
            if (status.lastIncrementalSyncAt) freshness.push(`lastIncrementalSyncAt: ${status.lastIncrementalSyncAt}`);

            if (status.isSyncing) {
                const lines = [
                    `Sync in progress${status.mode ? ` (${status.mode})` : ''}: ${status.progress}% — step: ${status.currentTable ?? 'Initializing'}.`,
                    'Poll sync_data again soon.',
                ];
                if (decisionLine) lines.push(decisionLine);
                if (freshness.length) lines.push(...freshness);
                return { content: [{ type: 'text', text: lines.join('\n') }] };
            }

            const lines: string[] = [];
            if (decisionLine) lines.push(decisionLine);
            if (freshness.length) lines.push(...freshness);
            if (lines.length === 0) {
                lines.push(launched ? 'Sync triggered.' : 'Sync already in progress.');
            }
            return { content: [{ type: 'text', text: lines.join('\n') }] };
        }

        if (name === 'list_sample_queries') {
            const filter: { category?: any; name?: string } = {};
            if (args?.category !== undefined) filter.category = args.category as any;
            if (args?.name !== undefined) filter.name = args.name as string;
            const result = listSampleQueries(Object.keys(filter).length > 0 ? filter : undefined);
            return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        }

        if (name === 'describe_schema') {
            const db = openDb();
            try {
                const result = describeSchema(db, args?.tables as string[] | undefined);
                return { content: [{ type: 'text', text: JSON.stringify(result) }] };
            } finally { db.close(); }
        }

        if (name === 'describe_tool') {
            const toolName = args?.name as string | undefined;
            if (!toolName) {
                return { content: [{ type: 'text', text: 'Error: missing required argument `name`.' }] };
            }
            const doc = TOOL_DOCS[toolName];
            if (!doc) {
                return { content: [{ type: 'text', text: `Unknown tool: ${toolName}. Call tools/list for available tools.` }] };
            }
            return { content: [{ type: 'text', text: doc.fullDescription.trim() }] };
        }

        if (name === 'explain_query') {
            const db = openDb();
            try {
                const plan = explainQuery(db, args?.sql as string);
                return { content: [{ type: 'text', text: JSON.stringify(plan) }] };
            } finally { db.close(); }
        }

        if (name === 'execute_sql') {
            const sql = args?.sql as string;
            const limit = (args?.limit as number) ?? 100;
            try {
                const result = await executeSqlWithTimeout(dbPath, sql, limit, 25_000);

                const hints = result.rowCount > 0 && hasGeospatialData(result.columns) ? [{
                        tool: 'export_kml',
                        args: { result_id: '<result_id from this response>' },
                        why: 'render geospatially',
                    }] : undefined;
                const response = pagedColumnarResponse(name, args ?? {}, result.columns, result.rows, {
                    truncated: result.truncated,
                    rowCount: result.rowCount,
                }, hints);
                return { content: [{ type: 'text', text: JSON.stringify(response) }] };
            } catch (err: any) {
                return {
                    content: [{ type: 'text', text: `SQL Error: ${err.message}` }],
                    isError: true,
                };
            }
        }

        if (name === 'export_kml') {
            const id = args?.result_id as string;
            if (!id) {
                return {
                    content: [{ type: 'text', text: 'Missing required parameter: result_id' }],
                    isError: true,
                };
            }
            const entry = resultCache.get(id);
            if (!entry) {
                return {
                    content: [{ type: 'text', text: `Result not found or expired (result_id: ${id}). Please re-run the original query to get a fresh result_id.` }],
                    isError: true,
                };
            }
            const kml = generateKml(entry.columns, entry.rows);
            return {
                content: [{ type: 'text', text: kml }]
            };
        }

        if (name === 'get_result_page') {
            const id = args?.result_id as string;
            const page = resultCache.page(
                id,
                (args?.offset as number | undefined) ?? 0,
                (args?.limit as number | undefined) ?? 25
            );
            if (!page) {
                return {
                    content: [{ type: 'text', text: JSON.stringify({ _error: `Result not found or expired: ${id}` }) }],
                    isError: true,
                };
            }
            return { content: [{ type: 'text', text: JSON.stringify(page) }] };
        }

        if (name === 'get_frequency_allocation') {
            let query;
            try {
                query = normalizeFrequencyPoint(args ?? {});
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                return { content: [{ type: 'text', text: JSON.stringify({ _error: message }) }], isError: true };
            }
            const freq_hz = query.freq_hz;
            const include_footnotes = args?.include_footnotes !== false;  // default true
            const db = openDb();
            try {
                const tableCount = (db.prepare('SELECT COUNT(*) AS n FROM spectrum_allocations').get() as { n: number }).n;
                if (tableCount === 0) {
                    return { content: [{ type: 'text', text: JSON.stringify({ _error: "Spectrum plan data not loaded. Run 'npm run import-spectrum-plan -- --reseed'." }) }] };
                }
                const result: any = lookupFrequencyAllocation(db, freq_hz, include_footnotes);
                result.query = query;

                // Staleness warning
                const warnings: string[] = [];
                const publishedRaw = result.source.published_date;
                if (publishedRaw) {
                    const pub = new Date(publishedRaw);
                    if (!Number.isNaN(pub.getTime())) {
                        const ageMs = Date.now() - pub.getTime();
                        const ageYears = ageMs / (1000 * 60 * 60 * 24 * 365.25);
                        if (ageYears >= 3) {
                            if (result.source.last_patch_date) {
                                warnings.push(`Spectrum plan base from ${publishedRaw}; last patched ${result.source.last_patch_date}. Verify against the current legislation for licensing decisions.`);
                            } else {
                                warnings.push(`Spectrum plan base data is ${Math.floor(ageYears)} years old (published ${publishedRaw}); not patched. Verify against the current legislation for licensing decisions.`);
                            }
                        }
                    }
                }
                if (result.match_count === 0) {
                    warnings.push('No allocation found in the Australian Radiofrequency Spectrum Plan for this frequency.');
                } else if (result.match_count > 1) {
                    warnings.push(`${result.match_count} overlapping allocations matched; the plan should not contain overlaps - verify recent patches.`);
                }
                if (warnings.length > 0) {
                    result._warning = warnings.join(' ');
                }

                if (args?.include_hints === true && result.match_count > 0) {
                    result._hints = [
                        { tool: 'search_licences', why: 'find licences operating in this band' },
                        { tool: 'search_application_text', why: "search application text for this band's usage" },
                    ];
                }

                return { content: [{ type: 'text', text: JSON.stringify(result) }] };
            } finally { if (db.open) db.close(); }
        }

        if (name === 'decode_emission_designator') {
            const code = args?.code as string;
            if (typeof code !== 'string') {
                return { content: [{ type: 'text', text: JSON.stringify({ _error: 'code must be a string.' }) }] };
            }
            const decoded = decodeEmissionDesignator(code);
            const response: any = { ...decoded };
            if (args?.include_hints === true && decoded.valid) {
                response._hints = [
                    {
                        tool: 'search_devices_by_emission',
                        args: { modulation: decoded.modulation!.code, info_type: decoded.info_type!.code },
                        why: 'find every device using this same emission pattern',
                    },
                    {
                        tool: 'execute_sql',
                        why: 'aggregate device counts by this emission code',
                    },
                ];
            }
            return { content: [{ type: 'text', text: JSON.stringify(response) }] };
        }

        if (name === 'search_devices_by_emission') {
            const db = openDb();
            try {
                const result = searchDevicesByEmission(db, (args ?? {}) as any);
                if (result._error) {
                    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
                }
                const hints = result.rows.length > 0 ? (() => {
                    const first = result.rows[0]!;
                    return [
                        { tool: 'get_licence_details', args: { licence_no: first.LICENCE_NO }, why: 'open the first matching licence' },
                        { tool: 'decode_emission_designator', args: { code: first.EMISSION.trim() }, why: 'full breakdown of any returned EMISSION value' },
                        { tool: 'execute_sql', why: 'aggregate or refine these results' },
                    ];
                })() : undefined;
                const response = pagedSearchResponse(name, args ?? {}, result.rows as unknown as Array<Record<string, unknown>>, {
                    truncated: result.truncated,
                    resolved_filters: result.resolved_filters,
                }, hints);
                return { content: [{ type: 'text', text: JSON.stringify(response) }] };
            } finally { if (db.open) db.close(); }
        }

        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
            })();
            return completed;
        } finally {
            const elapsed = performance.now() - started;
            const text = completed?.content?.find((item: any) => item?.type === 'text')?.text ?? '';
            let rows = 0;
            let cached = false;
            try {
                const payload = JSON.parse(text);
                rows = Array.isArray(payload?.rows) ? payload.rows.length : 0;
                cached = payload?.duplicate === true;
            } catch { /* non-JSON tool response */ }
            log.info(
                `[MCP_PERF] tool=${name} db_ms=${DB_TOOLS.has(name) ? elapsed.toFixed(1) : '0.0'} ` +
                `total_ms=${elapsed.toFixed(1)} rows=${rows} output_bytes=${Buffer.byteLength(text)} cached=${cached}`
            );
        }
    });

    return server;
}

// ─── HTTP Server ─────────────────────────────────────────────────────────────

const transports = new Map<string, StreamableHTTPServerTransport>();

async function main() {
    // Ensure the schema is current. CREATE TABLE IF NOT EXISTS is idempotent,
    // so this is safe on existing DBs and adds any tables that landed in
    // later releases (e.g. an older sync'd DB pulling a new spectrum_* table).
    initializeDatabase(dbPath);

    const app = express();
    app.use(express.json());

    // Liveness/readiness probe.
    //   GET /health           → fast: returns sync provenance only; never opens the DB
    //   GET /health?deep=1    → readiness: also opens the DB read-only and runs a
    //                           SELECT COUNT(*) on the meta table; 500 if it fails
    app.get('/health', (req, res) => {
        const status = getSyncStatus();
        const body: Record<string, unknown> = {
            status: 'ok',
            version: '1.10.0',
            ...(status.dataAsOf !== undefined ? { dataAsOf: status.dataAsOf } : {}),
            ...(status.lastSyncAt !== undefined ? { lastSyncAt: status.lastSyncAt } : {}),
            ...(status.remoteAsOf !== undefined ? { remoteAsOf: status.remoteAsOf } : {}),
            ...(status.behindByHours !== undefined ? { behindByHours: status.behindByHours } : {}),
            isSyncing: status.isSyncing,
        };
        if (req.query.deep === '1') {
            try {
                const db = new Database(dbPath, { readonly: true, fileMustExist: true });
                try {
                    db.prepare('SELECT COUNT(*) AS n FROM meta').get();
                    body.db = 'reachable';
                } finally {
                    if (db.open) db.close();
                }
            } catch (e) {
                body.status = 'degraded';
                body.db = 'unreachable';
                body.dbError = (e as Error).message;
                return res.status(500).json(body);
            }
        }
        res.json(body);
    });

    app.all('/mcp', async (req, res) => {
        log.debug(`[NETWORK] ${req.method} | session=${req.headers['mcp-session-id'] ?? 'none'}`);

        const sessionId = req.headers['mcp-session-id'] as string | undefined;

        // Route to existing session
        if (sessionId && transports.has(sessionId)) {
            try {
                await transports.get(sessionId)!.handleRequest(req, res, req.body);
            } catch (err: any) {
                log.error('[MCP] Transport error:', err.message);
                if (!res.headersSent) res.status(500).json({ error: err.message });
            }
            return;
        }

        // New session — only POST initialize can start one
        if (req.method === 'POST') {
            const transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                onsessioninitialized: (newId) => {
                    transports.set(newId, transport);
                    log.info(`[SESSION] Opened: ${newId}`);
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
            } catch (err: any) {
                log.error('[MCP] Init error:', err.message);
                if (!res.headersSent) res.status(500).json({ error: err.message });
            }
            return;
        }

        res.status(400).json({
            error: 'Send POST /mcp with initialize to start a session first.',
        });
    });

    const port = Number(PORT);
    const httpServer = app.listen(port, '0.0.0.0', () => {
        log.info(`ACMA RRL MCP Server v1.10.0 running on port ${port} at http://localhost:${port}/mcp`);
        log.info('Tools: search_licences, get_licence_details, search_sites, get_site_details, search_clients, sync_data, execute_sql, list_sample_queries, export_kml, search_bsl, search_spectrum_band, search_application_text, get_frequency_allocation, describe_schema, describe_tool, explain_query, decode_emission_designator, search_devices_by_emission');
    });

    // Graceful shutdown on SIGTERM (systemd / docker stop) and SIGINT (Ctrl-C).
    // Closes MCP transports, stops accepting new connections, finishes in-flight
    // requests, then exits. A 30s watchdog hard-exits if any handle is stuck.
    const shutdown = (signal: string) => {
        log.info(`[SHUTDOWN] Received ${signal}; closing ${transports.size} MCP transport(s) and HTTP server.`);
        for (const [sessionId, transport] of transports.entries()) {
            try {
                transport.close();
            } catch (e) {
                log.error(`[SHUTDOWN] Error closing transport ${sessionId}: ${(e as Error).message}`);
            }
        }
        transports.clear();
        httpServer.close((err) => {
            if (err) {
                log.error(`[SHUTDOWN] HTTP server close error: ${err.message}`);
                process.exit(1);
            }
            log.info('[SHUTDOWN] Closed cleanly.');
            process.exit(0);
        });
        setTimeout(() => {
            log.warn('[SHUTDOWN] Watchdog: forcing exit after 30s grace period.');
            process.exit(1);
        }, 30_000).unref();
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
}

// Only auto-run main() when this file is the entry point — not when imported
// (e.g. tests/network.test.ts imports this module to read TOOL_DOCS).
// Mirrors the pattern in src/sync.ts.
if (process.argv[1]?.endsWith('index.ts') || process.argv[1]?.endsWith('index.js')) {
    main().catch(err => {
        log.error('Fatal error:', err);
        process.exit(1);
    });
}
