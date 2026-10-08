import { readFile } from 'node:fs/promises';
import { writeJsonAtomic } from '../fs/atomic-write.js';
import { LockContentionError, LockOwnershipError } from '../fs/with-lock.js';
import { PoolOperationError, } from './errors.js';
import { callFailureHook } from './hooks.js';
import { LockStack, } from './refresh-lock.js';
import { classifyConfig, classifyState, ensureEntries, entryIn, isRecord, LEGACY_STORE_VERSION, POOL_KEY, POOL_ROWS_KEY, POOL_SCHEMA_VERSION, retireEpochsIn, rosterOf, rosterRowIn, setEntryIn, } from './schema.js';
import { completeTornRows, loadRows } from './torn.js';
async function readJson(path) {
    let text;
    try {
        text = await readFile(path, 'utf8');
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return { exists: false };
        throw error;
    }
    try {
        return { exists: true, value: JSON.parse(text) };
    }
    catch (parseError) {
        return { exists: true, parseError };
    }
}
/** Reads and classifies both files. Never writes. */
export async function readPool(ctx) {
    const config = classifyConfig(await readJson(ctx.configPath));
    if (config.status === 'error')
        return { status: 'error', file: 'config', reason: config.reason };
    const state = classifyState(await readJson(ctx.statePath));
    if (state.status === 'error')
        return { status: 'error', file: 'state', reason: state.reason };
    if (config.status === 'pending-migration')
        return { status: 'pending-migration', config: config.config };
    return {
        status: 'ready',
        configExists: config.exists,
        stateExists: state.exists,
        config: config.config,
        state: state.state,
        rows: loadRows(config.config, state.state, ctx.codec, {
            requireCredentialStamps: ctx.requireCredentialStamps === true,
            ...(ctx.providerState ? { providerState: ctx.providerState } : {}),
        }),
    };
}
/** The refusal for a pool that is not ready, as a failure value. */
export function notReadyError(result, operation, rowId, phase = 'before-first-write') {
    return new PoolOperationError({
        operation,
        ...(rowId !== undefined ? { rowId } : {}),
        phase,
        retryable: false,
        kind: result.status === 'pending-migration'
            ? 'pending-migration'
            : 'load-error',
        message: result.status === 'pending-migration'
            ? 'the config holds a legacy roster that has not been migrated into the pool'
            : `${result.file} file cannot be loaded: ${result.reason}`,
    });
}
/**
 * One locked read-modify-write. The store locks are pushed onto the caller's
 * lock stack, so the ownership assertion before each write covers the outer
 * row, provider-wide and extra locks as well; they are released when the
 * transaction ends, whatever happens.
 */
export class Transaction {
    ctx;
    snapshot;
    locks;
    progress;
    info;
    config;
    state;
    constructor(ctx, snapshot, locks, progress, info) {
        this.ctx = ctx;
        this.snapshot = snapshot;
        this.locks = locks;
        this.progress = progress;
        this.info = info;
        this.config = structuredClone(snapshot.config);
        this.state = structuredClone(snapshot.state);
    }
    /**
     * The rows as every reader loads them: a row torn between the writes of a
     * replace is shown as that replace leaves it once completed (see
     * `PoolRow.torn`).
     */
    rows() {
        return loadRows(this.config, this.state, this.ctx.codec, {
            requireCredentialStamps: this.ctx.requireCredentialStamps === true,
            ...(this.ctx.providerState
                ? { providerState: this.ctx.providerState }
                : {}),
        });
    }
    row(id) {
        return this.rows().find((row) => row.id === id);
    }
    roster() {
        if (!Array.isArray(this.config.accounts))
            this.config.accounts = [];
        return this.config.accounts;
    }
    /** The first roster row with this id (the one the pool loads). */
    rosterRow(id) {
        this.roster();
        return rosterRowIn(this.config, id);
    }
    /**
     * Drops every roster row carrying this id. The row's per-row entry goes with
     * it on the next `commitConfig`, which drops entries for ids no longer in
     * the roster. Returns how many roster rows were dropped.
     */
    dropRosterRows(id) {
        const roster = this.roster();
        const kept = roster.filter((raw) => !(isRecord(raw) && raw.id === id));
        this.config.accounts = kept;
        return roster.length - kept.length;
    }
    entries() {
        return ensureEntries(this.config);
    }
    entry(id) {
        this.entries();
        return entryIn(this.config, id);
    }
    setEntry(id, entry) {
        setEntryIn(this.config, id, entry);
    }
    /**
     * Writes the config of every row torn between the writes of a replace, or
     * of a write giving it its first identity, as that write would have left it
     * (see `completeTornRows`), in one config
     * write ahead of the operation's own. The write is counted apart from the
     * operation's: it is setup, like a pull giving a row its entry, so a later
     * refusal still reports `before-first-write`.
     */
    async completeTorn() {
        const { config, torn } = completeTornRows(this.config, this.state, this.ctx.codec, { requireCredentialStamps: this.ctx.requireCredentialStamps === true });
        if (torn.length === 0)
            return;
        this.config = config;
        await this.commitConfig({ counted: false });
    }
    stateAccount(id) {
        const accounts = isRecord(this.state.accounts) ? this.state.accounts : {};
        const entry = Object.hasOwn(accounts, id) ? accounts[id] : undefined;
        return isRecord(entry) ? entry : undefined;
    }
    /** Drops the row's credential and runtime fields from the state file's accounts. */
    dropStateAccount(id) {
        if (isRecord(this.state.accounts) && Object.hasOwn(this.state.accounts, id))
            delete this.state.accounts[id];
    }
    setStateAccount(id, fields) {
        if (!isRecord(this.state.accounts))
            this.state.accounts = {};
        Object.defineProperty(this.state.accounts, id, {
            value: fields,
            enumerable: true,
            writable: true,
            configurable: true,
        });
    }
    /**
     * Writes the config: legacy `version: 1` and the legacy roster beside
     * `commonAuthPool`, every other top-level key and every unrecognised pool
     * key untouched. Entries for ids no longer in the roster are dropped here,
     * and remembered so the id is not reused in this process. Every id the
     * write drops (a roster row the files held when the transaction read them,
     * or an entry left without one) has its epoch recorded in the config (see
     * `retireEpochsIn`), which is what keeps a later `add` of the id, from any
     * process, past every epoch an attribution could name.
     */
    async commitConfig(options = {}) {
        const roster = this.roster();
        const rosterIds = new Set();
        for (const raw of roster)
            if (isRecord(raw) && typeof raw.id === 'string')
                rosterIds.add(raw.id);
        const dropped = new Set();
        for (const raw of rosterOf(this.snapshot.config))
            if (isRecord(raw) && typeof raw.id === 'string' && !rosterIds.has(raw.id))
                dropped.add(raw.id);
        for (const id of Object.keys(this.entries()))
            if (!rosterIds.has(id))
                dropped.add(id);
        retireEpochsIn(this.config, dropped);
        const entries = this.entries();
        const kept = {};
        for (const [id, entry] of Object.entries(entries)) {
            if (rosterIds.has(id)) {
                Object.defineProperty(kept, id, {
                    value: entry,
                    enumerable: true,
                    writable: true,
                    configurable: true,
                });
            }
            else {
                this.ctx.removedIds.add(id);
            }
        }
        const pool = this.config[POOL_KEY];
        const next = {
            ...this.config,
            version: LEGACY_STORE_VERSION,
            accounts: roster,
            [POOL_KEY]: {
                ...pool,
                schemaVersion: POOL_SCHEMA_VERSION,
                [POOL_ROWS_KEY]: kept,
            },
        };
        await this.write(this.ctx.configPath, next, 'config', options.counted ?? true);
        this.config = next;
    }
    /** Writes the state: every unrecognised top-level and per-row key kept. */
    async commitState(committed) {
        const next = {
            ...this.state,
            version: LEGACY_STORE_VERSION,
            accounts: isRecord(this.state.accounts) ? this.state.accounts : {},
        };
        await this.write(this.ctx.statePath, next, 'state');
        this.state = next;
        if (committed)
            this.progress.committed = committed;
    }
    async write(path, value, file, counted = true) {
        await writeJsonAtomic(path, value, {
            beforeRename: async () => {
                await this.ctx.onStep?.(`before-${file}-write`, this.info);
                // Ownership is proved immediately before the rename, on every lease.
                await this.locks.assertAll();
            },
        });
        if (counted)
            this.progress.writes++;
        await this.ctx.onStep?.(`after-${file}-write`, this.info);
    }
}
/**
 * Adds the pool key to a config that holds a legacy roster without one, under
 * the store-lock list, in one config write: `commonAuthPool` with the schema
 * version and no row entries, the legacy roster and every other top-level key
 * kept, except the keys named in `dropKeys`. The state file is not touched.
 * This is the only write the store makes to a pending-migration config; it is
 * where a plugin's migration starts, and every later row goes through the
 * ordinary operations. A config that is already a pool is left alone; a load
 * error refuses.
 */
export async function initializePool(ctx, dropKeys) {
    const locks = new LockStack(ctx.lockDefaults, ctx.lockEnv);
    const progress = { writes: 0 };
    try {
        for (const spec of ctx.storeLocks)
            await locks.acquire(spec);
        const result = await readPool(ctx);
        if (result.status === 'error')
            throw notReadyError(result, 'initialize', undefined);
        if (result.status === 'ready')
            return 'already-ready';
        const next = {};
        for (const [key, value] of Object.entries(result.config))
            if (!dropKeys.includes(key))
                next[key] = value;
        next.version = LEGACY_STORE_VERSION;
        next[POOL_KEY] = { schemaVersion: POOL_SCHEMA_VERSION, [POOL_ROWS_KEY]: {} };
        const info = { operation: 'initialize', rowId: undefined };
        await writeJsonAtomic(ctx.configPath, next, {
            beforeRename: async () => {
                await ctx.onStep?.('before-config-write', info);
                await locks.assertAll();
            },
        });
        progress.writes++;
        await ctx.onStep?.('after-config-write', info);
        return 'initialized';
    }
    catch (error) {
        throw toFailure(error, 'initialize', undefined, progress);
    }
    finally {
        await locks.releaseAll();
    }
}
/**
 * Runs `fn` under the store-lock list. The pool must be ready: a pending
 * migration or a load error refuses before anything is written. Unless
 * `completeTorn` is false, rows torn between the writes of a replace are
 * completed first, so `fn` never sees one; the writes that only record
 * readings or reorder the roster opt out and leave such rows as they are.
 */
export async function withTransaction(ctx, locks, progress, info, fn, options = {}) {
    const mark = locks.held.length;
    try {
        for (const spec of ctx.storeLocks)
            await locks.acquire(spec);
        const result = await readPool(ctx);
        if (result.status !== 'ready')
            throw notReadyError(result, info.operation, info.rowId, progress.writes > 0 ? 'after-first-write' : 'before-first-write');
        const tx = new Transaction(ctx, result, locks, progress, info);
        if (options.completeTorn ?? true)
            await tx.completeTorn();
        return await fn(tx);
    }
    finally {
        await locks.releaseTo(mark);
    }
}
/** Maps anything thrown inside an operation onto the one failure value. */
export function toFailure(error, operation, rowId, progress) {
    const phase = operation === 'pull'
        ? 'pull'
        : progress.writes > 0
            ? 'after-first-write'
            : 'before-first-write';
    const committed = phase === 'after-first-write' ? progress.committed : undefined;
    if (error instanceof PoolOperationError) {
        if (error.phase === phase &&
            error.rowId === rowId &&
            error.operation === operation &&
            error.committed === committed)
            return error;
        return new PoolOperationError({
            operation,
            ...(rowId !== undefined ? { rowId } : {}),
            phase: error.kind === 'after-persist-hook' ? error.phase : phase,
            retryable: error.retryable,
            kind: error.kind,
            ...((error.committed ?? committed)
                ? { committed: error.committed ?? committed }
                : {}),
            message: error.message,
            ...(error.cause !== undefined ? { cause: error.cause } : {}),
        });
    }
    const base = {
        operation,
        ...(rowId !== undefined ? { rowId } : {}),
        phase,
        ...(committed ? { committed } : {}),
        cause: error,
    };
    if (error instanceof LockOwnershipError)
        return new PoolOperationError({
            ...base,
            retryable: true,
            kind: 'lock-ownership',
            message: phase === 'after-first-write'
                ? `${operation} lost a lease after its first write; the intermediate stays on disk`
                : `${operation} lost a lease before writing; nothing was written`,
        });
    if (error instanceof LockContentionError)
        return new PoolOperationError({
            ...base,
            retryable: true,
            kind: 'lock-contention',
            message: error.message,
        });
    return new PoolOperationError({
        ...base,
        retryable: false,
        kind: 'unexpected',
        message: error instanceof Error ? error.message : String(error),
    });
}
/**
 * The frame every lock-holding operation runs in: failures are mapped onto
 * the failure value, handed to the failure hook while the outer locks are
 * still held (the store locks are already released), and rethrown; every
 * lock is released afterwards. `rowId` is undefined for an operation that
 * names no row (`reorder`).
 */
export async function runOperation(ctx, operation, rowId, onFailure, body) {
    const locks = new LockStack(ctx.lockDefaults, ctx.lockEnv);
    const progress = { writes: 0 };
    try {
        return await body(locks, progress);
    }
    catch (error) {
        const failure = toFailure(error, operation, rowId, progress);
        if (failure.kind !== 'after-persist-hook')
            await callFailureHook(operation, onFailure, rowId, failure, ctx.logger);
        throw failure;
    }
    finally {
        await locks.releaseAll();
    }
}
