// Where the signature cache lives by default. OpenCode watches its config
// folder, so the cache was moved out of it into the plugin's state folder.
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { getSignatureCacheFilePath, SignatureCache } from './signature-cache'

const ENV_NAMES = [
  'XDG_STATE_HOME',
  'XDG_CONFIG_HOME',
  'OPENCODE_CONFIG_DIR',
] as const

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
    const cache = new SignatureCache({
      enabled: true,
      memory_ttl_seconds: 3600,
      disk_ttl_seconds: 172800,
      write_interval_seconds: 3600,
    })
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
