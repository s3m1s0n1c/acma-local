import AdmZip from 'adm-zip';
import * as path from 'path';
import * as fs from 'fs';
import Database from 'better-sqlite3';
import { parse } from 'csv-parse';
import { parse as parseCsvSync } from 'csv-parse/sync';
import axios from 'axios';
import { pipeline } from 'stream/promises';
import { initializeDatabase, TABLE_METADATA } from './db.js';

export interface SyncConfig {
    datasetUrl: string;
    timestampUrl: string;
    incrementalUrl: string;
    dataDir: string;
    dbPath: string;
}

export const DEFAULT_CONFIG: SyncConfig = {
    datasetUrl: 'https://web.acma.gov.au/rrl-updates/spectra_rrl.zip',
    timestampUrl: 'https://web.acma.gov.au/rrl-updates/datetime-of-extract.txt',
    incrementalUrl: 'https://web.acma.gov.au/rrl/spectra_incremental.rrl_update',
    dataDir: './data',
    dbPath: './data/acma.db',
};

// ── ACMA /v1/Extracts manifest types ─────────────────────────────────────────
//
// Mirrors the JSON returned by GET https://backend.acma.gov.au/rrl/v1/Extracts.
// `LastMdified` is misspelled on ACMA's side; preserved verbatim so JSON.parse
// hits it directly. Each entry's Items array may contain spectra_rrl.zip and
// (for full entries) spectra_licence_hrp.zip — we ignore the latter this sprint.

export interface ExtractItem {
    Description: string;
    Format: string;
    FileSize: number;
    FileName: string;
    FileUrl: string;
}

export interface ExtractEntry {
    IsFullExtract: boolean;
    LastMdified: string;       // ISO 8601, e.g. "2026-05-12T21:51:36Z"
    DateOfChanges?: string;    // YYYY-MM-DD; present only when IsFullExtract === false
    Items: ExtractItem[];
}

export type ExtractsManifest = ExtractEntry[];

/**
 * Returns the spectra_rrl* item from an entry's Items array, or null if none.
 * Filters out spectra_licence_hrp.zip (Device Power Patterns — out of scope).
 */
export function pickSpectraRrl(items: ExtractItem[]): ExtractItem | null {
    return items.find(i => i.FileName.startsWith('spectra_rrl')) ?? null;
}

/**
 * Fetches and returns the ACMA /v1/Extracts manifest. The manifest contains
 * the latest full extract entry plus the most recent (~3) daily change-zip
 * entries. Throws on network / parse failure.
 */
export async function fetchExtractsManifest(url: string): Promise<ExtractsManifest> {
    const response = await axios.get(url);
    return response.data as ExtractsManifest;
}

// ── Sync routing: pure decision function ─────────────────────────────────────

export type SyncMode = 'auto' | 'full';

export type SyncAction =
    | { kind: 'noop'; reason: 'cooldown' | 'current' }
    | { kind: 'full'; entry: ExtractEntry; reason: 'bootstrap' | 'forced' }
    | { kind: 'incremental'; entries: ExtractEntry[] }
    | { kind: 'gap-exceeded'; behindHours: number };

/** Minimum milliseconds between any sync attempt. */
const SYNC_COOLDOWN_MS = 12 * 60 * 60 * 1000;   // 12 hours

/**
 * Maximum allowed gap (in ms) between meta.as_of and the oldest applicable
 * incremental. Equal to the manifest's 24 h-per-zip window plus 6 h of slack
 * so that we don't false-trigger on slow daily extract generation.
 */
const GAP_TOLERANCE_MS = 30 * 60 * 60 * 1000;   // 30 hours

/**
 * Decides what sync action to take given the local DB freshness, the remote
 * manifest, and the user-requested mode. Pure — no I/O, no clock reads.
 *
 * Decision rules, in order:
 *  1. Cooldown active → noop/cooldown.
 *  2. asOf === null → full/bootstrap (mode is ignored; first-run must succeed).
 *  3. mode === 'full' → full/forced.
 *  4. asOf >= manifest.full.LastMdified → noop/current.
 *  5. No applicable incrementals OR gap > GAP_TOLERANCE_MS → gap-exceeded.
 *  6. Otherwise → incremental with applicable entries sorted ascending.
 */
export function decideSyncAction(
    asOf: Date | null,
    manifest: ExtractsManifest,
    mode: SyncMode,
    lastSync: Date | null,
    now: Date,
): SyncAction {
    if (lastSync !== null && now.getTime() - lastSync.getTime() < SYNC_COOLDOWN_MS) {
        return { kind: 'noop', reason: 'cooldown' };
    }
    const fullEntry = manifest.find(e => e.IsFullExtract);
    if (!fullEntry) {
        throw new Error('Manifest has no full extract entry');
    }
    if (asOf === null) {
        return { kind: 'full', entry: fullEntry, reason: 'bootstrap' };
    }
    if (mode === 'full') {
        return { kind: 'full', entry: fullEntry, reason: 'forced' };
    }
    const fullTime = new Date(fullEntry.LastMdified).getTime();
    if (asOf.getTime() >= fullTime) {
        return { kind: 'noop', reason: 'current' };
    }
    const applicable = manifest
        .filter(e => !e.IsFullExtract)
        .map(e => ({ e, t: new Date(e.LastMdified).getTime() }))
        .filter(({ t }) => t > asOf.getTime())
        .sort((a, b) => a.t - b.t);
    if (applicable.length === 0 ||
        applicable[0]!.t - asOf.getTime() > GAP_TOLERANCE_MS) {
        const behindHours = Math.round((fullTime - asOf.getTime()) / 3_600_000);
        return { kind: 'gap-exceeded', behindHours };
    }
    return { kind: 'incremental', entries: applicable.map(({ e }) => e) };
}

// ── CSV-diff incremental application ─────────────────────────────────────────

/**
 * Single-column primary keys for the tables we materialise. ACMA's full extract
 * does not declare PKs and the schema does not enforce them; we use these to
 * key the DELETE step of incremental application.
 */
const PK_BY_TABLE: Record<string, string> = {
    client: 'CLIENT_NO',
    licence: 'LICENCE_NO',
    site: 'SITE_ID',
    device_details: 'SDD_ID',
    antenna: 'ANTENNA_ID',
};

/**
 * Translates a change-zip CSV basename to a schema table name. ACMA's daily
 * change-zip names device data `device_detail.csv` (singular) while the full
 * extract names it `device_details.csv` (plural). Likely an ACMA-side bug; we
 * handle both here so the diff applier sees a single canonical table name.
 */
function csvToTable(csvBasename: string): string {
    const stem = csvBasename.replace(/\.csv$/i, '');
    return stem === 'device_detail' ? 'device_details' : stem;
}

/**
 * Applies a single daily change-zip to the SQLite database. The zip is the
 * payload of one https://cdn.acma.gov.au/rrl/changes/spectra_rrl-changes-*.zip
 * file. Each CSV in the zip carries the table's columns plus a trailing
 * CHANGE column; rows are Added / Updated / Deleted.
 */
export async function applyCsvDiffZip(zipPath: string, dbPath: string): Promise<void> {
    const zip = new AdmZip(zipPath);
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    try {
        for (const entry of zip.getEntries()) {
            if (entry.isDirectory) continue;
            const baseName = path.basename(entry.entryName);
            if (!baseName.toLowerCase().endsWith('.csv')) continue;
            const tableName = csvToTable(baseName);
            if (!(tableName in PK_BY_TABLE)) continue;   // skip non-materialised tables
            applyCsvDiff(entry.getData(), tableName, db);
        }
    } finally {
        db.close();
    }
}

/**
 * Applies one CSV diff (the contents of one entry in a change-zip) to the
 * named table. DELETE-then-INSERT for Added/Updated; DELETE for Deleted.
 * Idempotent under repeated application, which protects us against replays.
 */
function applyCsvDiff(csvBuffer: Buffer, tableName: string, db: Database.Database): void {
    const rows: Record<string, string>[] = parseCsvSync(csvBuffer, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
    });
    if (rows.length === 0) return;     // header-only CSV

    const columns = Object.keys(rows[0]!);
    if (!columns.includes('CHANGE')) {
        throw new Error(`Expected CHANGE column in ${tableName} change-zip`);
    }
    const pk = PK_BY_TABLE[tableName]!;
    const dataCols = columns.filter(c => c !== 'CHANGE');
    const placeholders = dataCols.map(() => '?').join(',');
    const insertStmt = db.prepare(
        `INSERT INTO ${tableName} (${dataCols.join(',')}) VALUES (${placeholders})`
    );
    const deleteStmt = db.prepare(`DELETE FROM ${tableName} WHERE ${pk} = ?`);

    const apply = db.transaction(() => {
        for (const row of rows) {
            const change = row.CHANGE;
            const pkValue = row[pk];
            if (change === 'Deleted') {
                deleteStmt.run(pkValue);
            } else if (change === 'Added' || change === 'Updated') {
                deleteStmt.run(pkValue);
                const values = dataCols.map(c => row[c] === '' ? null : row[c]);
                insertStmt.run(...values);
            } else {
                console.warn(`Unknown CHANGE='${change}' in ${tableName}; skipping row pk=${pkValue}`);
            }
        }
    });
    apply();
}

/**
 * The reason for the most recent sync decision. Set every time `sync()` makes
 * a routing choice, so callers can tell why a run was skipped or which mode it
 * picked. Outcome reasons (`incremental-failed`, `incremental-success`,
 * `full-success`, `full-failed`) are set at the end of an attempt.
 */
export type SyncReason =
    | 'cooldown-skipped'
    | 'fetch-failed'
    | 'parse-failed'
    | 'no-db'
    | 'gap-exceeded'
    | 'within-window'
    | 'incremental-success'
    | 'incremental-failed'
    | 'full-success'
    | 'full-failed';

export interface SyncStatus {
    isSyncing: boolean;
    progress: number; // 0-100
    currentTable?: string;
    lastError?: string;
    /** Mode of the most recent attempt. Absent if no sync has been attempted. */
    mode?: SyncMode;
    /** Reason / outcome of the most recent decision. */
    reason?: SyncReason;
    /** ISO-8601 timestamp of the most recent decision. */
    lastDecisionAt?: string;
    /** Free-form context for the decision (e.g. "DB 53h behind", "next sync in 47 min"). */
    detail?: string;
}

let currentSyncStatus: SyncStatus = {
    isSyncing: false,
    progress: 0,
};

export function getSyncStatus(): SyncStatus {
    return { ...currentSyncStatus };
}

/**
 * Records the latest sync decision. Mode is omitted when no sync was attempted
 * (cooldown / fetch-failed). `lastDecisionAt` is set to now.
 */
function recordDecision(reason: SyncReason, mode: SyncMode | undefined, detail?: string): void {
    currentSyncStatus = {
        ...currentSyncStatus,
        reason,
        lastDecisionAt: new Date().toISOString(),
        ...(mode !== undefined ? { mode } : {}),
        ...(detail !== undefined ? { detail } : {}),
    };
}

/**
 * Downloads a file from a URL to a target path.
 */
async function downloadFile(url: string, targetPath: string): Promise<void> {
    const response = await axios({
        method: 'get',
        url: url,
        responseType: 'stream',
    });

    await pipeline(response.data, fs.createWriteStream(targetPath));
}

/**
 * Performs a full synchronization: download, extract, and import all data.
 */
export async function performFullSync(config: SyncConfig, remoteTimestampRaw?: string): Promise<void> {
    if (currentSyncStatus.isSyncing) {
        throw new Error('Synchronization already in progress');
    }

    // Reset transient run state but preserve decision metadata set by sync().
    const { currentTable: _ct, lastError: _le, ...preserved } = currentSyncStatus;
    void _ct; void _le;
    currentSyncStatus = { ...preserved, isSyncing: true, progress: 0 };

    try {
        if (!fs.existsSync(config.dataDir)) {
            fs.mkdirSync(config.dataDir, { recursive: true });
        }

        let remoteTimestamp: string;
        if (remoteTimestampRaw !== undefined) {
            remoteTimestamp = remoteTimestampRaw;
        } else {
            console.log('Fetching dataset timestamp...');
            const tsResponse = await axios.get(config.timestampUrl, { responseType: 'text' });
            remoteTimestamp = String(tsResponse.data).trim();
        }

        const zipPathFromInput = '/projects/acma-local-redux/inputs/spectra_rrl.zip';
        const zipPath = path.join(config.dataDir, 'spectra_rrl.zip');

        currentSyncStatus.progress = 5;

        const parsedRemote = parseRemoteTimestamp(remoteTimestamp);
        const inputZipExists = fs.existsSync(zipPathFromInput);
        const inputZipStale = parsedRemote !== null && isInputZipStale(zipPathFromInput, parsedRemote);

        if (inputZipExists && !inputZipStale) {
            console.log('Using local dataset from inputs/');
            fs.copyFileSync(zipPathFromInput, zipPath);
        } else {
            if (inputZipStale && parsedRemote) {
                const mtime = fs.statSync(zipPathFromInput).mtime.toISOString();
                console.log(`[SYNC] Input zip mtime=${mtime} is older than remote=${parsedRemote.toISOString()}; ignoring stale input.`);
            }
            console.log('Downloading full dataset...');
            await downloadFile(config.datasetUrl, zipPath);
        }

        currentSyncStatus.progress = 20;

        console.log('Extracting ZIP...');
        const extractDir = path.join(config.dataDir, 'extracted');
        if (!fs.existsSync(extractDir)) fs.mkdirSync(extractDir, { recursive: true });
        const files = await extractZip(zipPath, extractDir);

        currentSyncStatus.progress = 30;

        console.log('Initializing database...');
        initializeDatabase(config.dbPath);

        const tablesToImport = files.filter(file => {
            const fileName = path.basename(file);
            const targetTable = fileName.split('.')[0]!;
            return Object.keys(TABLE_METADATA).includes(targetTable);
        });

        for (let i = 0; i < tablesToImport.length; i++) {
            const file = tablesToImport[i]!;
            const fileName = path.basename(file);
            const targetTable = fileName.split('.')[0]!;

            currentSyncStatus.currentTable = targetTable;
            // Map 30-95% across table imports
            const tableProgressBase = 30 + (i / tablesToImport.length) * 65;

            console.log(`Importing ${fileName}...`);
            await importCsv(file, config.dbPath, targetTable, (p) => {
                currentSyncStatus.progress = Math.round(tableProgressBase + (p / tablesToImport.length) * (65 / 100));
            });
        }

        const db = new Database(config.dbPath);
        db.prepare('REPLACE INTO meta (key, value) VALUES (?, ?)').run('as_of', remoteTimestamp);
        db.prepare('REPLACE INTO meta (key, value) VALUES (?, ?)').run('last_sync', new Date().toISOString());
        db.close();

        currentSyncStatus.progress = 100;
        console.log('Full sync complete.');
    } catch (error: any) {
        currentSyncStatus.lastError = error.message;
        throw error;
    } finally {
        currentSyncStatus.isSyncing = false;
    }
}

/**
 * Returns the ISO-8601 timestamp of the last successful sync stored in the
 * meta table, or null if the DB doesn't exist / has never been synced.
 */
function getLastSyncTime(dbPath: string): Date | null {
    if (!fs.existsSync(dbPath)) return null;
    try {
        const db = new Database(dbPath, { readonly: true, fileMustExist: true });
        try {
            const row = db.prepare("SELECT value FROM meta WHERE key = 'last_sync'").get() as { value: string } | undefined;
            return row ? new Date(row.value) : null;
        } finally {
            if (db.open) db.close();
        }
    } catch {
        return null;
    }
}

/**
 * Orchestrates the sync process.
 * Will not contact the origin if the last successful sync was within 12 hours.
 */
export async function sync(config: SyncConfig = DEFAULT_CONFIG): Promise<void> {
    // ── Rate-limit guard ──────────────────────────────────────────────────────
    const lastSync = getLastSyncTime(config.dbPath);
    if (lastSync) {
        const msSinceLast = Date.now() - lastSync.getTime();
        if (msSinceLast < SYNC_COOLDOWN_MS) {
            const nextSyncIn = Math.ceil((SYNC_COOLDOWN_MS - msSinceLast) / 60_000);
            console.log(
                `[SYNC] Skipping — last sync was ${Math.floor(msSinceLast / 60_000)} min ago. ` +
                `Next allowed sync in ~${nextSyncIn} min.`
            );
            recordDecision('cooldown-skipped', undefined, `next sync allowed in ~${nextSyncIn} min`);
            return;
        }
    }
    // ─────────────────────────────────────────────────────────────────────────

    // Fetch remote timestamp once; reused below to decide full vs incremental
    // and threaded through performFullSync to avoid a second fetch.
    let remoteTimestampRaw: string;
    try {
        const tsResponse = await axios.get(config.timestampUrl, { responseType: 'text' });
        remoteTimestampRaw = String(tsResponse.data).trim();
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error('[SYNC] Could not fetch remote timestamp; aborting sync.', e);
        recordDecision('fetch-failed', undefined, msg);
        return;
    }
    const parsedRemote = parseRemoteTimestamp(remoteTimestampRaw);
    if (!parsedRemote) {
        console.log(`[SYNC] Could not parse remote timestamp '${remoteTimestampRaw}'; proceeding without staleness check.`);
    }

    const dbExists = fs.existsSync(config.dbPath);

    if (!dbExists) {
        recordDecision('no-db', 'full', 'no local database; performing initial full sync');
        try {
            await performFullSync(config, remoteTimestampRaw);
            recordDecision('full-success', 'full');
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            recordDecision('full-failed', 'full', msg);
            throw e;
        }
        return;
    }

    // Read meta.as_of for gap check
    let asOf: Date | null = null;
    if (parsedRemote) {
        const db = new Database(config.dbPath, { readonly: true, fileMustExist: true });
        try {
            const row = db.prepare("SELECT value FROM meta WHERE key = 'as_of'").get() as { value: string } | undefined;
            // meta.as_of is written by performFullSync (raw remote timestamp) and
            // applyIncrementalUpdate (-- TO: line); both produce YYYY-MM-DD HH:MM:SS today.
            asOf = row ? parseRemoteTimestamp(row.value) : null;
        } finally {
            if (db.open) db.close();
        }

        if (shouldDoFullSync(asOf, parsedRemote)) {
            const gapHours = asOf
                ? Math.round((parsedRemote.getTime() - asOf.getTime()) / 3_600_000)
                : null;
            const gapDesc = gapHours === null ? 'no prior sync' : `${gapHours}h behind`;
            console.log(`[SYNC] DB is ${gapDesc} (remote=${parsedRemote.toISOString()}); full sync required.`);
            recordDecision('gap-exceeded', 'full', `DB ${gapDesc} of remote ${parsedRemote.toISOString()}`);
            try {
                await performFullSync(config, remoteTimestampRaw);
                recordDecision('full-success', 'full');
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                recordDecision('full-failed', 'full', msg);
                throw e;
            }
            return;
        }
    }

    // Within the incremental window — attempt incremental sync
    console.log('Checking for incremental updates...');
    // TODO(Task 6): pass mode='incremental' once SyncMode includes it.
    recordDecision(parsedRemote ? 'within-window' : 'parse-failed', undefined,
        parsedRemote ? undefined : `unparseable remote timestamp '${remoteTimestampRaw}' — gap check skipped`);
    try {
        const response = await axios.get(config.incrementalUrl);
        const updateContent = response.data;

        const newTimestamp = await applyIncrementalUpdate(updateContent, config.dbPath);
        if (newTimestamp) {
            const db = new Database(config.dbPath);
            db.prepare('REPLACE INTO meta (key, value) VALUES (?, ?)').run('as_of', newTimestamp);
            db.prepare('REPLACE INTO meta (key, value) VALUES (?, ?)').run('last_sync', new Date().toISOString());
            db.close();
            console.log(`Incremental sync successful. Database is now as-of ${newTimestamp}`);
            recordDecision('incremental-success', undefined, `as-of ${newTimestamp}`); // TODO(Task 6): pass mode='incremental'.
        }
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error('Incremental sync failed.', e);
        recordDecision('incremental-failed', undefined, msg); // TODO(Task 6): pass mode='incremental'.
        // No auto-fallback: the gap check above already routed any DB that
        // is genuinely past the incremental window. Remaining failures are
        // transient and will retry on the next scheduled sync.
    }
}

// Run if called directly
if (process.argv[1]?.endsWith('sync.ts') || process.argv[1]?.endsWith('sync.js')) {
    sync().catch(console.error);
}

/**
 * Extracts a ZIP file to a target directory.
 * @param zipPath Path to the ZIP file.
 * @param targetDir Directory to extract files into.
 * @returns List of absolute paths to extracted files.
 */
export async function extractZip(zipPath: string, targetDir: string): Promise<string[]> {
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(targetDir, true);

    const entries = zip.getEntries();
    return entries.map(entry => path.join(targetDir, entry.entryName));
}

/**
 * Imports a CSV file into a SQLite table.
 * @param csvPath Path to the CSV file.
 * @param dbPath Path to the SQLite database.
 * @param tableName Name of the target table.
 */
export async function importCsv(
    csvPath: string,
    dbPath: string,
    tableName: string,
    onProgress?: (percent: number) => void
): Promise<void> {
    const db = new Database(dbPath);
    let insert: any = null;
    let columns: string[] = [];

    // Get total size for progress estimation
    const stats = fs.statSync(csvPath);
    const totalBytes = stats.size;
    let processedBytes = 0;

    const readStream = fs.createReadStream(csvPath);
    readStream.on('data', (chunk) => {
        processedBytes += chunk.length;
        if (onProgress) {
            onProgress(Math.round((processedBytes / totalBytes) * 100));
        }
    });

    const parser = readStream.pipe(parse({
        columns: true,
        skip_empty_lines: true,
        trim: true,
    }));

    const BATCH_SIZE = 5000;
    let batch: any[] = [];

    const doBatch = db.transaction((rows: any[]) => {
        for (const row of rows) {
            const values = columns.map(col => row[col] === '' ? null : row[col]);
            insert.run(...values);
        }
    });

    for await (const record of parser) {
        if (!insert) {
            columns = Object.keys(record as object);
            const placeholders = columns.map(() => '?').join(',');
            const sql = `INSERT INTO ${tableName} (${columns.join(',')}) VALUES (${placeholders})`;
            insert = db.prepare(sql);
        }

        batch.push(record);
        if (batch.length >= BATCH_SIZE) {
            doBatch(batch);
            batch = [];
        }
    }

    if (batch.length > 0) {
        doBatch(batch);
    }

    db.close();
}

/**
 * Applies incremental SQL updates to the database.
 * @param sqlContent The SQL content from the .rrl_update file.
 * @param dbPath Path to the SQLite database.
 * @returns The new "as of" timestamp.
 */
export async function applyIncrementalUpdate(sqlContent: string, dbPath: string): Promise<string | null> {
    const lines = sqlContent.split('\n');
    let status = null;
    let newAsof = null;
    const sqlStatements: string[] = [];

    for (const line of lines) {
        const trimmedLine = line.trim();
        if (trimmedLine.startsWith('-- STATUS:')) {
            status = trimmedLine.replace('-- STATUS:', '').trim();
        } else if (trimmedLine.startsWith('-- TO:')) {
            newAsof = trimmedLine.replace('-- TO:', '').trim();
        } else if (trimmedLine && !trimmedLine.startsWith('--')) {
            sqlStatements.push(trimmedLine);
        }
    }

    if (status !== 'SUCCESS') {
        throw new Error(`Incremental update failed with status: ${status}`);
    }

    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.transaction(() => {
        for (const sql of sqlStatements) {
            try {
                db.exec(sql);
            } catch (e: any) {
                // Tables not in our schema (e.g. applic_text_block, antenna_pattern) are
                // skipped silently — the incremental feed references the full ACMA schema
                // but we only persist a subset. Any other error is logged.
                if (!e?.message?.includes('no such table')) {
                    console.error(`Error executing incremental SQL: ${sql}`, e);
                }
            }
        }
    })();
    db.close();

    return newAsof;
}

/**
 * Parses ACMA's `datetime-of-extract.txt` payload (`YYYY-MM-DD HH:MM:SS`).
 * Treated as UTC so comparisons against other parsed timestamps stay consistent.
 * Returns null on any parse failure — callers fall back to existing behaviour.
 */
export function parseRemoteTimestamp(s: string): Date | null {
    const trimmed = s.trim();
    // Three accepted forms:
    //   1. Dashed `YYYY-MM-DD HH:MM:SS` (legacy datetime-of-extract.txt).
    //   2. Compact `YYYYMMDDHHMMSS` optionally followed by sub-second digits
    //      (production feed at one point emitted 9 trailing digits).
    //   3. ISO 8601 UTC `YYYY-MM-DDTHH:MM:SS[.fff]Z` (new manifest LastMdified).
    const dashed = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(trimmed);
    const compact = dashed ? null : /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\d*$/.exec(trimmed);
    const iso = (dashed || compact) ? null : /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/.exec(trimmed);
    const m = dashed ?? compact ?? iso;
    if (!m) return null;
    // Construct ISO-8601 in UTC and validate by round-trip.
    // Compare against the input components so values like month=13 → null.
    const iso8601 = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
    const d = new Date(iso8601);
    if (isNaN(d.getTime())) return null;
    // Validate components round-trip (rejects 2026-13-12T... etc.)
    if (d.getUTCFullYear() !== Number(m[1]) ||
        d.getUTCMonth() + 1 !== Number(m[2]) ||
        d.getUTCDate() !== Number(m[3])) {
        return null;
    }
    // Preserve fractional seconds when present (ISO form only).
    if (iso) {
        return new Date(trimmed);
    }
    return d;
}

/**
 * True iff the file at `zipPath` exists AND its mtime is earlier than
 * `remoteTimestamp`. Returns false if the file is missing — the caller
 * decides whether that means "download" or "error".
 */
export function isInputZipStale(zipPath: string, remoteTimestamp: Date): boolean {
    if (!fs.existsSync(zipPath)) return false;
    const mtime = fs.statSync(zipPath).mtime;
    return mtime < remoteTimestamp;
}

/** Milliseconds in the ACMA incremental update window. */
const INCREMENTAL_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * True iff a full sync is required — either the DB has never been synced
 * (`asOf` is null) or the gap to `remoteTimestamp` exceeds the 24-hour
 * incremental update window. Equality counts as "still incremental".
 */
export function shouldDoFullSync(asOf: Date | null, remoteTimestamp: Date): boolean {
    if (!asOf) return true;
    return remoteTimestamp.getTime() - asOf.getTime() > INCREMENTAL_WINDOW_MS;
}
