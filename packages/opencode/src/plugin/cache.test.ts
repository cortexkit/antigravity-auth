import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import * as cacheModule from './cache'
import {
  cacheSignature,
  clearSignatureCache,
  getCachedSignature,
  getDiskSignatureCache,
  initDiskSignatureCache,
  shutdownDiskSignatureCache,
} from './cache'

function listSourceFiles(dir: string): string[] {
  const files: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      files.push(...listSourceFiles(path))
    } else if (/\.(ts|tsx)$/.test(name)) {
      files.push(path)
    }
  }
  return files
}

// The refresh-token keyed auth snapshot cache was write-only: no production
// code read from it. It was removed with its writers and clears, and nothing
// replaces it.
describe('removed auth cache', () => {
  it('exports no auth-cache API from the cache module', () => {
    const exported = Object.keys(cacheModule)
    expect(exported).not.toContain('resolveCachedAuth')
    expect(exported).not.toContain('storeCachedAuth')
    expect(exported).not.toContain('clearCachedAuth')
  })

  it('leaves no auth-cache reference in package source', () => {
    const srcRoot = join(import.meta.dir, '..')
    const offenders = listSourceFiles(srcRoot).filter((file) => {
      if (file === join(import.meta.dir, 'cache.test.ts')) return false
      return /\b(resolve|store|clear)CachedAuth\b|\bauthCache\b/.test(
        readFileSync(file, 'utf8'),
      )
    })
    expect(offenders).toEqual([])
  })
})

describe('OpenCode 1 disk signature binding', () => {
  beforeEach(() => {
    jest.useRealTimers()
  })

  afterEach(async () => {
    await shutdownDiskSignatureCache()
  })

  it('persists through the shared disk cache and clears the hot map on shutdown', async () => {
    const disk = initDiskSignatureCache({
      enabled: true,
      memory_ttl_seconds: 3600,
      disk_ttl_seconds: 172800,
      write_interval_seconds: 60,
    })
    expect(disk).not.toBeNull()
    expect(getDiskSignatureCache()).toBe(disk)

    cacheSignature('legacy-session', 'legacy thinking', 'legacy-sig')
    expect(disk!.getStats().dirty).toBe(true)

    await shutdownDiskSignatureCache()
    expect(getDiskSignatureCache()).toBeNull()
    // Shutdown cleared the hot map and left no disk cache to fall back to.
    expect(getCachedSignature('legacy-session', 'legacy thinking')).toBe(
      undefined,
    )
    // Shutdown also flushed: a new disk cache loads the signature from the
    // file, so the lookup succeeds again.
    initDiskSignatureCache({
      enabled: true,
      memory_ttl_seconds: 3600,
      disk_ttl_seconds: 172800,
      write_interval_seconds: 60,
    })
    expect(getCachedSignature('legacy-session', 'legacy thinking')).toBe(
      'legacy-sig',
    )
  })

  it('returns no disk cache when the signature cache is disabled', () => {
    expect(
      initDiskSignatureCache({
        enabled: false,
        memory_ttl_seconds: 3600,
        disk_ttl_seconds: 172800,
        write_interval_seconds: 60,
      }),
    ).toBeNull()
  })
})

describe('Signature Cache', () => {
  beforeEach(() => {
    jest.useRealTimers()
    clearSignatureCache()
  })

  afterEach(() => {
    clearSignatureCache()
  })

  describe('cacheSignature', () => {
    it('caches a signature for session and text', () => {
      cacheSignature('session1', 'thinking text', 'sig123')
      const result = getCachedSignature('session1', 'thinking text')
      expect(result).toBe('sig123')
    })

    it('does nothing when sessionId is empty', () => {
      cacheSignature('', 'text', 'sig')
      expect(getCachedSignature('', 'text')).toBeUndefined()
    })

    it('does nothing when text is empty', () => {
      cacheSignature('session', '', 'sig')
      expect(getCachedSignature('session', '')).toBeUndefined()
    })

    it('does nothing when signature is empty', () => {
      cacheSignature('session', 'text', '')
      expect(getCachedSignature('session', 'text')).toBeUndefined()
    })

    it('stores multiple signatures per session', () => {
      cacheSignature('session1', 'text1', 'sig1')
      cacheSignature('session1', 'text2', 'sig2')

      expect(getCachedSignature('session1', 'text1')).toBe('sig1')
      expect(getCachedSignature('session1', 'text2')).toBe('sig2')
    })

    it('stores signatures for different sessions independently', () => {
      cacheSignature('session1', 'text', 'sig1')
      cacheSignature('session2', 'text', 'sig2')

      expect(getCachedSignature('session1', 'text')).toBe('sig1')
      expect(getCachedSignature('session2', 'text')).toBe('sig2')
    })
  })

  describe('getCachedSignature', () => {
    it('returns undefined when session not found', () => {
      expect(getCachedSignature('unknown', 'text')).toBeUndefined()
    })

    it('returns undefined when text not found in session', () => {
      cacheSignature('session', 'known-text', 'sig')
      expect(getCachedSignature('session', 'unknown-text')).toBeUndefined()
    })

    it('returns undefined when sessionId is empty', () => {
      expect(getCachedSignature('', 'text')).toBeUndefined()
    })

    it('returns undefined when text is empty', () => {
      expect(getCachedSignature('session', '')).toBeUndefined()
    })

    it('returns undefined when signature is expired', () => {
      jest.useFakeTimers()
      jest.setSystemTime(new Date(0))

      cacheSignature('session', 'text', 'sig')

      // Advance time past TTL (1 hour = 3600000ms)
      jest.setSystemTime(new Date(3600001))

      expect(getCachedSignature('session', 'text')).toBeUndefined()
    })

    it('returns signature when not expired', () => {
      jest.useFakeTimers()
      jest.setSystemTime(new Date(0))

      cacheSignature('session', 'text', 'sig')

      // Advance time but stay within TTL
      jest.setSystemTime(new Date(3599999))

      expect(getCachedSignature('session', 'text')).toBe('sig')
    })
  })

  describe('clearSignatureCache', () => {
    it('clears all signature cache when no argument provided', () => {
      cacheSignature('session1', 'text', 'sig1')
      cacheSignature('session2', 'text', 'sig2')

      clearSignatureCache()

      expect(getCachedSignature('session1', 'text')).toBeUndefined()
      expect(getCachedSignature('session2', 'text')).toBeUndefined()
    })

    it('clears specific session from cache', () => {
      cacheSignature('session1', 'text', 'sig1')
      cacheSignature('session2', 'text', 'sig2')

      clearSignatureCache('session1')

      expect(getCachedSignature('session1', 'text')).toBeUndefined()
      expect(getCachedSignature('session2', 'text')).toBe('sig2')
    })
  })

  describe('cache eviction', () => {
    it('evicts entries when at capacity', () => {
      jest.useFakeTimers()
      jest.setSystemTime(new Date(0))

      // Fill cache with 100 entries (MAX_ENTRIES_PER_SESSION)
      for (let i = 0; i < 100; i++) {
        jest.setSystemTime(new Date(i * 1000)) // stagger timestamps
        cacheSignature('session', `text-${i}`, `sig-${i}`)
      }

      // Reset time to check entries
      jest.setSystemTime(new Date(100 * 1000))

      // Adding one more should trigger eviction
      cacheSignature('session', 'new-text', 'new-sig')

      // New entry should exist
      expect(getCachedSignature('session', 'new-text')).toBe('new-sig')

      // Some old entries should have been evicted (oldest 25%)
      // Entry at index 0 (timestamp 0) should be evicted
      expect(getCachedSignature('session', 'text-0')).toBeUndefined()
    })
  })
})
