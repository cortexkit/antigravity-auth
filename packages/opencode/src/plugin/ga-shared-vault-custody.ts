/**
 * One vault custody per OpenCode 2 process and vault folder, shared by every
 * location that resolves that folder. Each location gets a lease through
 * `acquireGaVaultCustody`. The leases share the custody's one vault source and
 * connection; if a refresh of that source stalls, custody replaces it. The
 * custody is disposed when the last lease is released. Each location still keeps
 * its own account pool over the shared source, because selection state belongs
 * to the location.
 *
 * The shared custody also runs the process's one background vault quota
 * producer. It runs while at least one started location has
 * `background_quota_refresh` on, at the shortest interval among those
 * locations.
 *
 * The registry is process state on purpose: a per-location custody would open
 * one vault connection and one background poll per open location.
 */

import { resolve } from 'node:path'
import { fetchWithActiveTimeout } from '@cortexkit/antigravity-auth-core'
import { getSidebarStateFile } from '../sidebar-state.ts'
import {
  BackgroundVaultQuotaRefresh,
  type BackgroundVaultQuotaRefreshOptions,
} from './background-vault-quota-refresh.ts'
import type { GaLocationCustody } from './ga-location-services.ts'
import type { Logger } from './logger.ts'
import {
  VAULT_REFRESH_STALL_MS,
  type VaultAccountPool,
} from './shared/vault-request-credentials.ts'
import {
  createOpenCodeVaultAccountPool,
  type OpenCodeVaultCustody,
} from './vault-custody.ts'

/** A started location's background vault quota settings. */
export interface GaVaultQuotaPolling {
  /** The location's `background_quota_refresh` option. */
  readonly enabled: boolean
  /** The location's `background_quota_refresh_interval_minutes` option. */
  readonly intervalMinutes: number
  /** Where the producer reports its ticks while this location is enabled. */
  readonly logger: Pick<Logger, 'debug' | 'info' | 'warn'>
}

/** Seams of the shared background quota producer; production uses none. */
export interface GaVaultQuotaProducerOptions {
  /** Physical quota request transport; defaults to `fetchWithActiveTimeout`. */
  readonly transport?: BackgroundVaultQuotaRefreshOptions['transport']
  readonly now?: () => number
  readonly random?: () => number
  readonly acquireLock?: BackgroundVaultQuotaRefreshOptions['acquireLock']
  /** Sees each producer as it is created, before it starts. */
  readonly onProducer?: (producer: BackgroundVaultQuotaRefresh) => void
}

export interface AcquireGaVaultCustodyOptions {
  /**
   * The vault folder the location resolves (`currentVaultFolder` in
   * `vault-folder.ts`); the registry key once resolved. OpenCode 1 and every
   * OpenCode 2 location of one config folder use the same folder, wherever
   * it lives, so they share one set of vault files.
   */
  readonly vaultDir: string
  /** The account file the vault folder was settled against. */
  readonly accountFile: string
  /**
   * Why the vault folder could not be settled, when it could not; see
   * `OpenCodeVaultCustodyOptions.layoutRefusal`.
   */
  readonly layoutRefusal?: string
  /** This location's reader of the host's own Google sign-in. */
  readonly readHostSlot: () => Promise<unknown>
  /**
   * Builds the one custody for the vault folder, the first time a location
   * acquires it. `readHostSlot` reads through the most recently acquired lease
   * still held, so a disposed location's host connection is never used.
   */
  readonly create: (input: {
    readonly vaultDir: string
    readonly accountFile: string
    readonly layoutRefusal?: string
    readonly readHostSlot: () => Promise<unknown>
  }) => OpenCodeVaultCustody
  /** Used only by the lease that creates the shared custody. */
  readonly quota?: GaVaultQuotaProducerOptions
}

interface Lease {
  readonly readHostSlot: () => Promise<unknown>
  polling?: GaVaultQuotaPolling
}

interface SharedCustody {
  readonly key: string
  readonly custody: OpenCodeVaultCustody
  readonly leases: Set<Lease>
  /** Starts, retimes or stops the background quota producer to match the leases. */
  readonly updateQuota: () => Promise<void>
}

const shared = new Map<string, SharedCustody>()

/**
 * A location's lease on the shared custody for its vault folder. Disposing the
 * lease releases it; the last release stops the quota producer and disposes
 * the custody, which closes the vault connection.
 */
export function acquireGaVaultCustody(
  options: AcquireGaVaultCustodyOptions,
): GaLocationCustody {
  // A custody that refuses because the folder is unsettled is never shared
  // with one that serves it.
  const key =
    options.layoutRefusal === undefined
      ? resolve(options.vaultDir)
      : `unsettled\0${resolve(options.vaultDir)}`
  let entry = shared.get(key)
  if (!entry) {
    const leases = new Set<Lease>()
    const custody = options.create({
      vaultDir: options.vaultDir,
      accountFile: options.accountFile,
      ...(options.layoutRefusal === undefined
        ? {}
        : { layoutRefusal: options.layoutRefusal }),
      readHostSlot: async () => {
        const latest = [...leases].at(-1)
        if (!latest)
          throw new Error('No OpenCode location holds the vault custody')
        return latest.readHostSlot()
      },
    })
    entry = {
      key,
      custody,
      leases,
      updateQuota: sharedVaultQuota(custody, leases, options.quota ?? {}),
    }
    shared.set(key, entry)
  }
  const held = entry
  const lease: Lease = { readHostSlot: options.readHostSlot }
  held.leases.add(lease)
  const { custody } = held
  let released: Promise<void> | undefined
  return {
    readMode: () => custody.readMode(),
    menuSection: () => custody.menuSection(),
    readState: () => custody.readState(),
    grantPrincipal: () => custody.grantPrincipal(),
    startObservation: () => custody.startObservation(),
    custodySource: () => custody.custodySource(),
    recycleStalledSource: (maxMs) => custody.recycleStalledSource(maxMs),
    currentSource: () => custody.currentSource(),
    pollVaultQuota(settings) {
      if (released) return
      lease.polling = settings
      void held.updateQuota()
    },
    dispose() {
      released ??= release(held, lease)
      return released
    },
  }
}

async function release(entry: SharedCustody, lease: Lease): Promise<void> {
  entry.leases.delete(lease)
  if (entry.leases.size > 0) {
    await entry.updateQuota()
    return
  }
  // A location acquiring after this point builds a new custody.
  if (shared.get(entry.key) === entry) shared.delete(entry.key)
  try {
    await entry.updateQuota()
  } finally {
    await entry.custody.dispose()
  }
}

/**
 * The one background vault quota producer of a shared custody, kept in step
 * with the leases' settings. Joining never fires a tick of its own: a new
 * producer starts with its usual random delay, and a running one only has its
 * wait retimed. When no started location has background refresh on, the
 * producer is stopped and awaited, as disposal does.
 */
function sharedVaultQuota(
  custody: OpenCodeVaultCustody,
  leases: ReadonlySet<Lease>,
  options: GaVaultQuotaProducerOptions,
): () => Promise<void> {
  let producer: BackgroundVaultQuotaRefresh | null = null
  let stopped: Promise<void> = Promise.resolve()
  let current:
    | {
        readonly source: Awaited<
          ReturnType<OpenCodeVaultCustody['custodySource']>
        >
        readonly pool: VaultAccountPool
      }
    | undefined
  const enabled = () =>
    [...leases].flatMap((lease) =>
      lease.polling?.enabled ? [lease.polling] : [],
    )
  const logger = () => enabled().at(-1)?.logger
  // The same pool reuse OpenCode 1 uses: a replaced source gets a new pool.
  const currentVaultPool = async () => {
    await custody.recycleStalledSource(VAULT_REFRESH_STALL_MS)
    const source = await custody.custodySource()
    if (current?.source === source) return current
    current = {
      source,
      pool: createOpenCodeVaultAccountPool({
        source,
        durable: { source, readState: () => custody.readState() },
      }),
    }
    return current
  }
  return () => {
    const active = enabled()
    if (active.length === 0) {
      const running = producer
      producer = null
      current = undefined
      if (running) stopped = running.dispose()
      return stopped
    }
    const intervalMs =
      Math.min(...active.map((polling) => polling.intervalMinutes)) * 60_000
    if (producer) {
      producer.setIntervalMs(intervalMs)
      return Promise.resolve()
    }
    producer = new BackgroundVaultQuotaRefresh({
      intervalMs,
      // Used for the cross-process `bg-vault-quota-poll` fence only: an
      // OpenCode 2 location writes no sidebar file.
      sidebarStateFile: getSidebarStateFile(),
      readAuthority: async () => {
        const mode = await custody.readMode()
        return !mode.ok
          ? 'unreadable'
          : mode.record.mode === 'custody'
            ? 'vault'
            : 'local'
      },
      currentVaultPool,
      readProviderState: () => custody.readState(),
      // OpenCode 2 locations re-read the stored quota on each state read.
      publishSidebar: async () => {},
      transport:
        options.transport ??
        ((url, init, extra) =>
          fetchWithActiveTimeout(
            url,
            { ...init, signal: extra.signal ?? init.signal },
            { timeoutMs: extra.timeoutMs },
          )),
      logger: {
        debug: (message, extra) => logger()?.debug(message, extra),
      },
      onOutcome: (level, outcome) =>
        logger()?.[level]('vault-quota-tick', { ...outcome }),
      ...(options.now ? { now: options.now } : {}),
      ...(options.random ? { random: options.random } : {}),
      ...(options.acquireLock ? { acquireLock: options.acquireLock } : {}),
    })
    options.onProducer?.(producer)
    producer.start()
    return Promise.resolve()
  }
}
