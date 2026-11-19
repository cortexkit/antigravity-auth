// Where the signature cache lives by default. OpenCode watches its config
// folder, so the cache was moved out of it into the plugin's state folder.
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { getSignatureCacheFilePath, SignatureCache } from './signature-cache'

const ENV_NAMES = [
  'XDG_STATE_HOME',
  'XDG_CONFIG_HOME',
  'OPENCODE_CONFIG_DIR',
] as const

const CONFIG = {
  enabled: true,
  memory_ttl_seconds: 3600,
  disk_ttl_seconds: 172800,
  write_interval_seconds: 3600,
}

function diskEntries(
  path: string,
): Record<string, { value: string; timestamp: number }> {
  return JSON.parse(readFileSync(path, 'utf8')).entries
}

let base: string
let saved: Record<string, string | undefined>

beforeEach(() => {
  base = join(
    process.env.ANTIGRAVITY_TEST_ROOT ?? '',
    `signature-cache-${Math.random().toString(36).slice(2)}`,
  )
  mkdirSync(base, { recursive: true })
  saved = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]))
  process.env.XDG_STATE_HOME = join(base, 'state')
  process.env.XDG_CONFIG_HOME = join(base, 'config')
  process.env.OPENCODE_CONFIG_DIR = join(base, 'config', 'opencode')
})

afterEach(() => {
  for (const name of ENV_NAMES) {
    const value = saved[name]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  rmSync(base, { recursive: true, force: true })
})

describe('the signature cache default path', () => {
  it('is antigravity-signature-cache.json in the plugin state folder, not in the config folder', () => {
    expect(getSignatureCacheFilePath()).toBe(
      join(
        base,
        'state',
        'cortexkit',
        'antigravity-auth',
        'antigravity-signature-cache.json',
      ),
    )
  })

  it('does not follow OPENCODE_CONFIG_DIR', () => {
    const before = getSignatureCacheFilePath()
    process.env.OPENCODE_CONFIG_DIR = join(base, 'elsewhere')
    expect(getSignatureCacheFilePath()).toBe(before)
  })

  it('a save writes the state folder and nothing in the config folder', async () => {
    const configDir = join(base, 'config', 'opencode')
    mkdirSync(configDir, { recursive: true })
    const cache = new SignatureCache(CONFIG)
    try {
      cache.store(SignatureCache.makeKey('session', 'model'), 'signature')
      expect(await cache.flush()).toBe(true)
    } finally {
      cache.shutdown()
    }
    expect(
      existsSync(
        join(
          base,
          'state',
          'cortexkit',
          'antigravity-auth',
          'antigravity-signature-cache.json',
        ),
      ),
    ).toBe(true)
    // No cache file and no .gitignore beside OpenCode's settings.
    expect(readdirSync(configDir)).toEqual([])
  })
})

describe('signature cache persistence', () => {
  it('merges another writer’s entries, keeping memory precedence and original timestamps', async () => {
    const path = join(base, 'signature-cache.json')
    const other = new SignatureCache(CONFIG, { filePath: path, now: () => 10 })
    const cache = new SignatureCache(CONFIG, { filePath: path, now: () => 20 })
    try {
      other.store('other', 'other signature')
      other.store('both', 'old signature')
      cache.store('both', 'new signature')
      cache.store('local', 'local signature')
      expect(await Promise.all([other.flush(), cache.flush()])).toEqual([
        true,
        true,
      ])
      expect(diskEntries(path)).toEqual({
        other: { value: 'other signature', timestamp: 10 },
        both: { value: 'new signature', timestamp: 20 },
        local: { value: 'local signature', timestamp: 20 },
      })
    } finally {
      other.shutdown()
      cache.shutdown()
    }
  })

  it('evicts the oldest signatures and thinking entries past 4096 in memory and on disk', async () => {
    const path = join(base, 'signature-cache.json')
    let clock = 0
    const cache = new SignatureCache(CONFIG, {
      filePath: path,
      now: () => clock++,
    })
    const other = new SignatureCache(CONFIG, { filePath: path, now: () => 0 })
    try {
      other.store('other-old', 'other signature')
      expect(await other.flush()).toBe(true)
      for (let index = 0; index < 4096; index++) {
        cache.store(`key-${index}`, 'signature')
      }
      cache.store('key-0', 'refreshed')
      cache.storeThinking('thought', 'text', 'thinking signature')
      cache.store('newest', 'newest signature')

      expect(cache.getStats().memoryEntries).toBe(4096)
      expect(cache.getTimestamp('key-1')).toBeUndefined()
      expect(cache.getTimestamp('key-2')).toBeUndefined()
      expect(cache.retrieve('key-0')).toBe('refreshed')
      expect(cache.retrieveThinking('thought')?.text).toBe('text')

      expect(await cache.flush()).toBe(true)
      const entries = diskEntries(path)
      expect(Object.keys(entries)).toHaveLength(4096)
      expect(entries['other-old']).toBeUndefined()
      expect(entries.thought).toEqual({
        value: 'thinking signature',
        timestamp: expect.any(Number),
      })
    } finally {
      other.shutdown()
      cache.shutdown()
    }
  })

  it('flushes through async reads and atomic writes without losing inserts during a write', async () => {
    const path = join(base, 'signature-cache.json')
    const cache = new SignatureCache(CONFIG, { filePath: path })
    cache.store('first', 'first signature')
    expect(await cache.flush()).toBe(true)
    cache.store('second', 'second signature')

    const enteredRename = Promise.withResolvers<void>()
    const allowRename = Promise.withResolvers<void>()
    const rename = fs.rename
    const reads = spyOn(fs, 'readFile')
    const renames = spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (to === path) {
        enteredRename.resolve()
        await allowRename.promise
      }
      await rename(from, to)
    })
    const flushing = cache.flush()
    try {
      expect(
        await Promise.race([
          enteredRename.promise.then(() => 'at async rename'),
          flushing.then(() => 'finished without async rename'),
        ]),
      ).toBe('at async rename')
      expect(reads).toHaveBeenCalledWith(path, 'utf-8')
      expect(diskEntries(path).second).toBeUndefined()
      cache.store('late', 'late signature')
      allowRename.resolve()
      expect(await flushing).toBe(true)
      expect(diskEntries(path).late).toBeUndefined()
      expect(cache.getStats().dirty).toBe(true)
      expect(await cache.flush()).toBe(true)
      expect(diskEntries(path).late?.value).toBe('late signature')
    } finally {
      allowRename.resolve()
      await flushing
      renames.mockRestore()
      reads.mockRestore()
      cache.shutdown()
    }
  })
})
