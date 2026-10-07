// ============================================================================
// Thinking Signature Cache (for Claude multi-turn conversations)
//
// Two layers, both process-wide and keyed by host session id and a hash of
// the thinking text (a host session id names one conversation):
//
// - The hot map holds recently written or looked-up signatures for at most
//   one hour (fixed), timed from when the hot entry was written.
// - The disk cache (`./cache/signature-cache`) persists signatures to a
//   file. One instance per canonical file path is shared by every location
//   that owns it. Every location whose signature_cache is enabled reads it,
//   while an owner holds it, with its own configured `memory_ttl_seconds`
//   against the entry's original timestamp.
//
// A location's `keep_thinking` setting decides thought restoration/injection
// (a request-pipeline concern exposed as `keepThinking`) and whether the
// location owns disk persistence: only an owner creates the disk cache,
// writes to it and keeps it running. It never disables signature lookup,
// extraction or hot-map writes. Disposing a location releases only its own
// share: persistence continues while any enabled owner remains and stops at
// the last one, and no location's hot entries or SignatureStore are cleared
// by another location's disposal.
// ============================================================================

import { createHash } from 'node:crypto'
import {
  getSignatureCacheFilePath,
  SignatureCache,
  type SignatureCacheRetention,
} from './cache/signature-cache'
import type { SignatureCacheConfig } from './config'
import { canonicalizeOwnedPath } from './config/loader'
import type { SignatureStore } from './core/streaming/types'
import type { Clock } from './neutral-types'
import { createSignatureStore } from './stores/signature-store'

interface SignatureEntry {
  signature: string
  timestamp: number
}

// Hot entries expire after 1 hour
const SIGNATURE_CACHE_TTL_MS = 60 * 60 * 1000

// Maximum entries per session to prevent memory bloat
const MAX_ENTRIES_PER_SESSION = 100

// Maximum sessions tracked in the outer Map to prevent unbounded growth
const MAX_CACHED_SESSIONS = 10
// 16 hex chars = 64-bit key space; keeps memory bounded while making collisions extremely unlikely.
const SIGNATURE_TEXT_HASH_HEX_LEN = 16

/**
 * Hashes text content into a stable, Unicode-safe key.
 *
 * Uses SHA-256 over UTF-8 bytes and truncates to keep memory usage bounded.
 */
function hashText(text: string): string {
  return createHash('sha256')
    .update(text, 'utf8')
    .digest('hex')
    .slice(0, SIGNATURE_TEXT_HASH_HEX_LEN)
}

/**
 * Create a disk cache key from sessionId and textHash.
 */
function makeDiskKey(sessionId: string, textHash: string): string {
  return `${sessionId}:${textHash}`
}

// ============================================================================
// Location handles over process-shared state
// ============================================================================

export interface LocationSignatureOptions {
  /** The location's keep_thinking setting. */
  keepThinking: boolean
  /** The location's signature_cache setting. */
  signatureCache: SignatureCacheConfig | undefined
  /** Disk cache file; defaults to `getSignatureCacheFilePath()`. */
  cacheFilePath?: string
}

/**
 * One location's view of the process-shared signature cache.
 */
export interface LocationSignatureCache {
  /**
   * Thought restoration/injection policy for this location's requests.
   * Lookup and extraction do not consult it.
   */
  readonly keepThinking: boolean
  /**
   * This location's owned handle on the shared disk cache when keep_thinking
   * and signature_cache.enabled are both on, else null. With thought replay
   * disabled (keep_thinking off) and signature_cache.enabled on, the location
   * has read-only lookup access to a cache another owner is running, and this
   * stays null.
   */
  readonly diskCache: SignatureCache | null
  /** This location's current-session signed-thinking replay store. */
  readonly signatureStore: SignatureStore
  /** Record a signature in the hot map and, when owned, the disk cache. */
  cacheSignature(sessionId: string, text: string, signature: string): void
  /**
   * Hot map first (fixed one-hour gate), then the disk cache for this
   * location's file, when one is running, against this location's memory
   * TTL; a disk hit is promoted into the hot map.
   */
  getCachedSignature(sessionId: string, text: string): string | undefined
  /**
   * Release this location's share of the disk cache. Idempotent. The last
   * enabled owner of a disk cache flushes and stops it, even while readers
   * remain; otherwise retention is recomputed from the remaining consumers.
   * Nothing is cleared for any other location, and this handle neither reads
   * nor writes afterwards.
   */
  dispose(): Promise<void>
}

export interface SignatureProcessState {
  /** Acquire one location's handle over this state. */
  acquireLocation(options: LocationSignatureOptions): LocationSignatureCache
  /**
   * Whether the hot map holds an entry for this session and text, whatever
   * its age. Never deletes or refreshes anything (diagnostics and tests).
   */
  hasHotEntry(sessionId: string, text: string): boolean
  /** The shared disk cache for a file while an enabled owner holds it. */
  diskCacheFor(filePath: string): SignatureCache | null
  /** Clear the hot map for one session, or entirely. */
  clearHot(sessionId?: string): void
}

export interface SignatureProcessStateOptions {
  /** Wall clock in epoch milliseconds; defaults to `Date.now()`. */
  now?: Clock
}

/** One live location's claim on a disk cache file. */
interface DiskConsumer {
  memoryTtlMs: number
  diskTtlMs: number
  writeIntervalMs: number
}

interface SharedDiskCache {
  path: string
  cache: SignatureCache
  owners: Set<DiskConsumer>
}

/**
 * Longest TTLs among every live consumer of a file (owners and readers) and
 * the shortest write interval among its owners, who alone write.
 */
function aggregateRetention(
  owners: Set<DiskConsumer>,
  readers: Set<DiskConsumer> | undefined,
): SignatureCacheRetention {
  let memoryTtlMs = 0
  let diskTtlMs = 0
  let writeIntervalMs = Number.POSITIVE_INFINITY
  for (const consumer of [...owners, ...(readers ?? [])]) {
    memoryTtlMs = Math.max(memoryTtlMs, consumer.memoryTtlMs)
    diskTtlMs = Math.max(diskTtlMs, consumer.diskTtlMs)
  }
  for (const owner of owners) {
    writeIntervalMs = Math.min(writeIntervalMs, owner.writeIntervalMs)
  }
  return { memoryTtlMs, diskTtlMs, writeIntervalMs }
}

/**
 * Create a signature-cache state: the hot map plus the table of shared disk
 * caches. Production uses the single `processSignatureState`; tests create
 * isolated ones with a deterministic clock.
 */
export function createSignatureProcessState(
  options: SignatureProcessStateOptions = {},
): SignatureProcessState {
  const now: Clock = options.now ?? (() => Date.now())
  // Map: sessionId -> Map<textHash, SignatureEntry>
  const hot = new Map<string, Map<string, SignatureEntry>>()
  const disks = new Map<string, SharedDiskCache>()
  // Locations with signature_cache enabled but keep_thinking off, by file.
  // They read a running cache and widen its retention but never create it
  // or keep it running.
  const readers = new Map<string, Set<DiskConsumer>>()

  const updateRetention = (path: string): void => {
    const shared = disks.get(path)
    if (shared) {
      shared.cache.setRetention(
        aggregateRetention(shared.owners, readers.get(path)),
      )
    }
  }

  /**
   * Prune stale sessions from the hot map.
   * Removes sessions where all entries have expired, then evicts the
   * oldest sessions if the Map still exceeds MAX_CACHED_SESSIONS.
   */
  const pruneSignatureSessions = (): void => {
    if (hot.size <= MAX_CACHED_SESSIONS) return

    const current = now()

    // First pass: remove sessions where ALL entries are expired
    for (const [sid, innerMap] of hot) {
      let allExpired = true
      for (const entry of innerMap.values()) {
        if (current - entry.timestamp <= SIGNATURE_CACHE_TTL_MS) {
          allExpired = false
          break
        }
      }
      if (allExpired) {
        hot.delete(sid)
      }
    }

    // Second pass: if still over cap, evict oldest sessions by newest entry timestamp
    if (hot.size > MAX_CACHED_SESSIONS) {
      const sessionsByAge: Array<{ sid: string; newestTs: number }> = []
      for (const [sid, innerMap] of hot) {
        let newestTs = 0
        for (const entry of innerMap.values()) {
          if (entry.timestamp > newestTs) newestTs = entry.timestamp
        }
        sessionsByAge.push({ sid, newestTs })
      }
      // Sort oldest-first, evict until at cap
      sessionsByAge.sort((a, b) => a.newestTs - b.newestTs)
      const toEvict = hot.size - MAX_CACHED_SESSIONS
      for (let i = 0; i < toEvict; i++) {
        const entry = sessionsByAge[i]
        if (entry) hot.delete(entry.sid)
      }
    }
  }

  const writeHot = (
    sessionId: string,
    textHash: string,
    signature: string,
  ): void => {
    let sessionMemCache = hot.get(sessionId)
    if (!sessionMemCache) {
      // About to add a new session — prune stale ones first
      pruneSignatureSessions()
      sessionMemCache = new Map()
      hot.set(sessionId, sessionMemCache)
    }
    // Evict old entries if we're at capacity
    if (sessionMemCache.size >= MAX_ENTRIES_PER_SESSION) {
      const current = now()
      for (const [key, entry] of sessionMemCache.entries()) {
        if (current - entry.timestamp > SIGNATURE_CACHE_TTL_MS) {
          sessionMemCache.delete(key)
        }
      }
      // If still at capacity, remove oldest entries
      if (sessionMemCache.size >= MAX_ENTRIES_PER_SESSION) {
        const entries = Array.from(sessionMemCache.entries()).sort(
          (a, b) => a[1].timestamp - b[1].timestamp,
        )
        const toRemove = entries.slice(
          0,
          Math.floor(MAX_ENTRIES_PER_SESSION / 4),
        )
        for (const [key] of toRemove) {
          sessionMemCache.delete(key)
        }
      }
    }

    sessionMemCache.set(textHash, { signature, timestamp: now() })
  }

  const readHot = (sessionId: string, textHash: string): string | undefined => {
    const sessionMemCache = hot.get(sessionId)
    if (!sessionMemCache) return undefined
    const entry = sessionMemCache.get(textHash)
    if (!entry) return undefined
    // The hot gate is the fixed hour for every location; a location's own
    // memory TTL applies only to its disk-cache reads.
    if (now() - entry.timestamp > SIGNATURE_CACHE_TTL_MS) {
      sessionMemCache.delete(textHash)
      return undefined
    }
    return entry.signature
  }

  // A disk hit is promoted without pruning, as a lookup must not evict
  // other sessions.
  const promoteHot = (
    sessionId: string,
    textHash: string,
    signature: string,
  ): void => {
    let memCache = hot.get(sessionId)
    if (!memCache) {
      memCache = new Map()
      hot.set(sessionId, memCache)
    }
    memCache.set(textHash, { signature, timestamp: now() })
  }

  const acquireDisk = (
    path: string,
    config: SignatureCacheConfig,
    owner: DiskConsumer,
  ): SharedDiskCache => {
    let shared = disks.get(path)
    if (!shared) {
      shared = {
        path,
        cache: new SignatureCache(config, { filePath: path, now }),
        owners: new Set(),
      }
      disks.set(path, shared)
    }
    shared.owners.add(owner)
    updateRetention(path)
    return shared
  }

  const releaseDisk = async (
    shared: SharedDiskCache,
    owner: DiskConsumer,
  ): Promise<void> => {
    shared.owners.delete(owner)
    if (shared.owners.size > 0) {
      updateRetention(shared.path)
      return
    }
    // Last enabled owner: unregister first so a new owner starts a fresh
    // instance from the file this flush writes.
    if (disks.get(shared.path) === shared) disks.delete(shared.path)
    try {
      await shared.cache.flush()
    } finally {
      shared.cache.shutdown()
    }
  }

  return {
    acquireLocation(locationOptions) {
      const config = locationOptions.signatureCache
      // A disabled signature_cache means no disk use at all for this location.
      const consumer: DiskConsumer | null = config?.enabled
        ? {
            memoryTtlMs: config.memory_ttl_seconds * 1000,
            diskTtlMs: config.disk_ttl_seconds * 1000,
            writeIntervalMs: config.write_interval_seconds * 1000,
          }
        : null
      const path =
        consumer &&
        canonicalizeOwnedPath(
          locationOptions.cacheFilePath ?? getSignatureCacheFilePath(),
        )
      const owns = locationOptions.keepThinking
      const shared =
        consumer && path && config && owns
          ? acquireDisk(path, config, consumer)
          : null
      if (consumer && path && !owns) {
        let pathReaders = readers.get(path)
        if (!pathReaders) {
          pathReaders = new Set()
          readers.set(path, pathReaders)
        }
        pathReaders.add(consumer)
        updateRetention(path)
      }
      // An owner reads its own instance; a reader looks up whichever instance
      // an owner is currently running for the file, if any.
      const readableCache = (): SignatureCache | undefined =>
        shared?.cache ?? (path ? disks.get(path)?.cache : undefined)
      const signatureStore = createSignatureStore()
      let disposed = false

      return {
        keepThinking: locationOptions.keepThinking,
        diskCache: shared?.cache ?? null,
        signatureStore,

        cacheSignature(sessionId, text, signature) {
          if (disposed) return
          if (!sessionId || !text || !signature) return

          const textHash = hashText(text)
          writeHot(sessionId, textHash, signature)
          if (shared) {
            shared.cache.store(makeDiskKey(sessionId, textHash), signature)
          }
        },

        getCachedSignature(sessionId, text) {
          if (disposed) return undefined
          if (!sessionId || !text) return undefined

          const textHash = hashText(text)
          const hotValue = readHot(sessionId, textHash)
          if (hotValue) return hotValue

          const diskCache = consumer ? readableCache() : undefined
          if (diskCache && consumer) {
            const diskValue = diskCache.retrieve(
              makeDiskKey(sessionId, textHash),
              consumer.memoryTtlMs,
            )
            if (diskValue) {
              // Promote to the hot map for faster subsequent access
              promoteHot(sessionId, textHash, diskValue)
              return diskValue
            }
          }

          return undefined
        },

        async dispose() {
          if (disposed) return
          disposed = true
          if (shared && consumer) {
            await releaseDisk(shared, consumer)
          } else if (consumer && path) {
            const pathReaders = readers.get(path)
            pathReaders?.delete(consumer)
            if (pathReaders?.size === 0) readers.delete(path)
            updateRetention(path)
          }
        },
      }
    },

    hasHotEntry(sessionId, text) {
      return hot.get(sessionId)?.has(hashText(text)) ?? false
    },

    diskCacheFor(filePath) {
      return disks.get(canonicalizeOwnedPath(filePath))?.cache ?? null
    },

    clearHot(sessionId) {
      if (sessionId) {
        hot.delete(sessionId)
      } else {
        hot.clear()
      }
    },
  }
}

/** The signature-cache state every location in this process shares. */
export const processSignatureState: SignatureProcessState =
  createSignatureProcessState()

/** Acquire a location's handle over the process-shared signature cache. */
export function acquireLocationSignatureCache(
  options: LocationSignatureOptions,
): LocationSignatureCache {
  return processSignatureState.acquireLocation(options)
}

// The functions below keep the existing OpenCode 1 call sites working
// through one separate module-level handle on `processSignatureState`. New
// location handles never read or replace that handle.

let legacyMemoryHandle: LocationSignatureCache | undefined
let legacyDiskHandle: LocationSignatureCache | null = null

function getLegacyHandle(): LocationSignatureCache {
  if (legacyDiskHandle) return legacyDiskHandle
  legacyMemoryHandle ??= processSignatureState.acquireLocation({
    keepThinking: false,
    signatureCache: undefined,
  })
  return legacyMemoryHandle
}

/**
 * Make the module-level OpenCode 1 handle own the disk cache for `config`.
 * Called from OpenCode 1 plugin initialization when keep_thinking is enabled.
 */
export function initDiskSignatureCache(
  config: SignatureCacheConfig | undefined,
): SignatureCache | null {
  const previous = legacyDiskHandle
  legacyDiskHandle = null
  // Releasing flushes synchronously before the first await, so the new
  // owner below loads what the previous one held.
  if (previous) void previous.dispose()
  legacyDiskHandle = processSignatureState.acquireLocation({
    keepThinking: true,
    signatureCache: config,
  })
  return legacyDiskHandle.diskCache
}

/**
 * Get the OpenCode 1 disk cache instance (for testing/debugging).
 */
export function getDiskSignatureCache(): SignatureCache | null {
  return legacyDiskHandle?.diskCache ?? null
}

/**
 * Release the OpenCode 1 disk ownership (flushing when it was the last
 * owner) and clear the hot map. Clears no credential state.
 */
export async function shutdownDiskSignatureCache(): Promise<void> {
  const handle = legacyDiskHandle
  legacyDiskHandle = null
  try {
    await handle?.dispose()
  } finally {
    clearSignatureCache()
  }
}

/**
 * Caches a thinking signature for a given session and text.
 * Used for Claude models that require signed thinking blocks in multi-turn conversations.
 * Also writes to disk cache if enabled.
 */
export function cacheSignature(
  sessionId: string,
  text: string,
  signature: string,
): void {
  getLegacyHandle().cacheSignature(sessionId, text, signature)
}

/**
 * Retrieves a cached signature for a given session and text.
 * Checks memory first, then falls back to disk cache.
 * Returns undefined if not found or expired.
 */
export function getCachedSignature(
  sessionId: string,
  text: string,
): string | undefined {
  return getLegacyHandle().getCachedSignature(sessionId, text)
}

/**
 * Clears signature cache for a specific session or all sessions.
 * Disk entries are left to expire through their TTL.
 */
export function clearSignatureCache(sessionId?: string): void {
  processSignatureState.clearHot(sessionId)
}

// ============================================================================
// Disk-Persistent Signature Cache (re-export from cache/ folder)
// ============================================================================

// Re-export SignatureCache class and factory for direct use
export {
  createSignatureCache,
  getSignatureCacheFilePath,
  SignatureCache,
} from './cache/signature-cache'
export type { SignatureCacheConfig } from './config'
