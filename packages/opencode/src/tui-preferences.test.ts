/**
 * Tests for the shared TUI preferences store.
 *
 * The store is a JSONC file under $XDG_CONFIG_HOME/opencode (or
 * $OPENCODE_CONFIG_DIR, or $OPENCODE_TUI_PREFERENCES_FILE for tests) that
 * holds one keyed block per plugin. Every reader must fall back to defaults
 * when the file is missing or malformed; the watchers and writers must
 * never crash the TUI. These tests pin the contract the rest of the TUI
 * (collapse state, section toggles, poll cadence) depends on.
 *
 * Convention parity: the fleet siblings (anthropic-auth, openai-auth) ship
 * the same shape with their own remainder-percent direction. Antigravity
 * uses `errorThreshold < warnThreshold` — the smaller number is the danger
 * floor — and a smaller section set (no cache, no pacing).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  computeEffectiveOrder,
  DEFAULT_PREFS,
  getTuiPreferencesFile,
  PLUGIN_KEY,
  queueTuiPreferenceUpdate,
  readTuiPreferencesFile,
  resolveAntigravityAuthPrefs,
  TUI_PREFS_FILE_ENV,
  watchTuiPreferences,
} from './tui-preferences'

let dir: string
let file: string
const savedEnv: Record<string, string | undefined> = {}
const ENV_KEYS = [TUI_PREFS_FILE_ENV, 'OPENCODE_CONFIG_DIR', 'XDG_CONFIG_HOME']

beforeEach(async () => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key]
  dir = await mkdtemp(join(tmpdir(), 'tui-prefs-test-'))
  file = join(dir, 'tui-preferences.jsonc')
  process.env[TUI_PREFS_FILE_ENV] = file
})

afterEach(async () => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  await rm(dir, { recursive: true, force: true })
})

describe('getTuiPreferencesFile', () => {
  test('env override wins', () => {
    expect(getTuiPreferencesFile()).toBe(file)
  })

  test('OPENCODE_CONFIG_DIR beats XDG_CONFIG_HOME', () => {
    delete process.env[TUI_PREFS_FILE_ENV]
    process.env.OPENCODE_CONFIG_DIR = '/cfg/opencode-dir'
    process.env.XDG_CONFIG_HOME = '/xdg'
    expect(getTuiPreferencesFile()).toBe(
      '/cfg/opencode-dir/tui-preferences.jsonc',
    )
  })

  test('XDG_CONFIG_HOME fallback appends opencode/', () => {
    delete process.env[TUI_PREFS_FILE_ENV]
    delete process.env.OPENCODE_CONFIG_DIR
    process.env.XDG_CONFIG_HOME = '/xdg'
    expect(getTuiPreferencesFile()).toBe('/xdg/opencode/tui-preferences.jsonc')
  })
})

describe('readTuiPreferencesFile', () => {
  test('missing file returns empty object', async () => {
    expect(await readTuiPreferencesFile()).toEqual({})
  })

  test('parses JSONC with comments and trailing commas', async () => {
    await writeFile(
      file,
      `// header comment\n{\n  // plugin\n  "antigravity-auth": { "order": 5, },\n}\n`,
      'utf8',
    )
    const root = await readTuiPreferencesFile()
    expect(root).toEqual({ 'antigravity-auth': { order: 5 } })
  })

  test('malformed file returns empty object', async () => {
    await writeFile(file, '{{{{ not json', 'utf8')
    expect(await readTuiPreferencesFile()).toEqual({})
  })

  test('unterminated object returns empty object', async () => {
    await writeFile(file, '{"antigravity-auth": {"order": 5}', 'utf8')
    expect(await readTuiPreferencesFile()).toEqual({})
  })

  test('trailing garbage after object returns empty object', async () => {
    await writeFile(
      file,
      '{"antigravity-auth":{"order":5}} trailing garbage',
      'utf8',
    )
    expect(await readTuiPreferencesFile()).toEqual({})
  })

  test('non-object root returns empty object', async () => {
    await writeFile(file, '[1, 2, 3]', 'utf8')
    expect(await readTuiPreferencesFile()).toEqual({})
  })
})

describe('resolveAntigravityAuthPrefs', () => {
  test('empty root yields defaults', () => {
    const prefs = resolveAntigravityAuthPrefs({})
    expect(prefs).toEqual(DEFAULT_PREFS)
    expect(prefs.order).toBe(160)
    expect(prefs.collapsed).toBeNull()
  })

  test('legacy remaining-percent thresholds convert to fleet used-percent thresholds', () => {
    const prefs = resolveAntigravityAuthPrefs({
      'antigravity-auth': {
        forceToTop: true,
        order: -500,
        startCollapsed: true,
        rememberCollapsed: false,
        collapsed: true,
        pollMs: 5000,
        refreshDebounceMs: 100,
        header: { label: 'QUOTA', showVersion: false },
        sections: { routing: false, fallbackAccounts: false },
        appearance: { barWidth: 20, warnThreshold: 60, errorThreshold: 30 },
      },
    })
    expect(prefs.forceToTop).toBe(true)
    expect(prefs.order).toBe(-500)
    expect(prefs.startCollapsed).toBe(true)
    expect(prefs.rememberCollapsed).toBe(false)
    expect(prefs.collapsed).toBe(true)
    expect(prefs.pollMs).toBe(5000)
    expect(prefs.refreshDebounceMs).toBe(100)
    expect(prefs.header).toEqual({ label: 'QUOTA', showVersion: false })
    expect(prefs.sections).toEqual({
      quota: true,
      fallbackAccounts: false,
      routing: false,
      health: true,
    })
    expect(prefs.appearance.barWidth).toBe(20)
    expect(prefs.appearance.warnThreshold).toBe(40)
    expect(prefs.appearance.errorThreshold).toBe(70)
  })

  test('numbers are clamped to their ranges', () => {
    const prefs = resolveAntigravityAuthPrefs({
      'antigravity-auth': {
        order: 99999999,
        pollMs: 1,
        refreshDebounceMs: 999999,
        appearance: {
          barWidth: 1000,
          warnThreshold: 400,
          errorThreshold: -5,
        },
      },
    })
    expect(prefs.order).toBe(10000)
    expect(prefs.pollMs).toBe(500)
    expect(prefs.refreshDebounceMs).toBe(5000)
    expect(prefs.appearance.barWidth).toBe(40)
    expect(prefs.appearance.warnThreshold).toBe(1)
    expect(prefs.appearance.errorThreshold).toBe(100)
  })

  test('used-percent thresholds retain fleet ordering', () => {
    const prefs = resolveAntigravityAuthPrefs({
      'antigravity-auth': {
        appearance: { warnThreshold: 30, errorThreshold: 80 },
      },
    })
    expect(prefs.appearance.errorThreshold).toBe(80)
    expect(prefs.appearance.warnThreshold).toBe(30)
  })

  test('errorThreshold accepts the fully exhausted 100% boundary', () => {
    const prefs = resolveAntigravityAuthPrefs({
      'antigravity-auth': {
        appearance: { warnThreshold: 30, errorThreshold: 100 },
      },
    })
    expect(prefs.appearance.errorThreshold).toBe(100)
    expect(prefs.appearance.warnThreshold).toBe(30)
  })

  test('label is truncated to 20 chars and empty label falls back', () => {
    const long = resolveAntigravityAuthPrefs({
      'antigravity-auth': { header: { label: 'X'.repeat(50) } },
    })
    expect(long.header.label).toBe('X'.repeat(20))
    const empty = resolveAntigravityAuthPrefs({
      'antigravity-auth': { header: { label: '' } },
    })
    expect(empty.header.label).toBe('ANTIGRAVITY')
  })

  test('bar chars reduce to first code point', () => {
    const prefs = resolveAntigravityAuthPrefs({
      'antigravity-auth': {
        appearance: { barFilledChar: 'abc', barEmptyChar: '🟦🟦' },
      },
    })
    expect(prefs.appearance.barFilledChar).toBe('a')
    expect(prefs.appearance.barEmptyChar).toBe('🟦')
  })

  test('fleet bar defaults survive a round-trip', () => {
    expect(DEFAULT_PREFS.appearance.barFilledChar).toBe('█')
    expect(DEFAULT_PREFS.appearance.barEmptyChar).toBe('░')
  })

  test('wrong types fall back per key, unknown keys ignored', () => {
    const prefs = resolveAntigravityAuthPrefs({
      'antigravity-auth': {
        forceToTop: 'yes',
        order: 'high',
        pollMs: null,
        header: 'big',
        sections: { quota: 1, bogus: true },
        appearance: { barWidth: '12' },
        somethingElse: { nested: true },
      },
    })
    expect(prefs.forceToTop).toBe(false)
    expect(prefs.order).toBe(160)
    expect(prefs.pollMs).toBe(1500)
    expect(prefs.header).toEqual(DEFAULT_PREFS.header)
    expect(prefs.sections.quota).toBe(true)
    expect(prefs.appearance.barWidth).toBe(10)
    expect('bogus' in prefs.sections).toBe(false)
  })

  test('non-object plugin entry yields defaults', () => {
    expect(resolveAntigravityAuthPrefs({ 'antigravity-auth': 42 })).toEqual(
      DEFAULT_PREFS,
    )
  })

  test('sections.health defaults true, accepts false, rejects wrong type', () => {
    expect(resolveAntigravityAuthPrefs({}).sections.health).toBe(true)
    expect(
      resolveAntigravityAuthPrefs({
        'antigravity-auth': { sections: { health: false } },
      }).sections.health,
    ).toBe(false)
    expect(
      resolveAntigravityAuthPrefs({
        'antigravity-auth': { sections: { health: 'off' } },
      }).sections.health,
    ).toBe(true)
  })
})

describe('computeEffectiveOrder', () => {
  test('missing key returns default order', () => {
    expect(computeEffectiveOrder({}, 'antigravity-auth', 160)).toBe(160)
  })

  test('explicit order knob is used and clamped', () => {
    expect(
      computeEffectiveOrder(
        { 'antigravity-auth': { order: 42 } },
        'antigravity-auth',
        160,
      ),
    ).toBe(42)
    expect(
      computeEffectiveOrder(
        { 'antigravity-auth': { order: -99999999 } },
        'antigravity-auth',
        160,
      ),
    ).toBe(-10000)
  })

  test('forceToTop beats any explicit order', () => {
    expect(
      computeEffectiveOrder(
        { 'antigravity-auth': { forceToTop: true, order: -10000 } },
        'antigravity-auth',
        160,
      ),
    ).toBe(-100000)
  })

  test('multiple forced plugins order by key position in file', () => {
    const root = {
      'plugin-a': { forceToTop: true },
      'plugin-b': { order: 5 },
      'plugin-c': { forceToTop: true },
    }
    expect(computeEffectiveOrder(root, 'plugin-a', 0)).toBe(-100000)
    expect(computeEffectiveOrder(root, 'plugin-c', 0)).toBe(-99998)
    expect(computeEffectiveOrder(root, 'plugin-b', 0)).toBe(5)
  })

  test('non-boolean forceToTop is ignored', () => {
    expect(
      computeEffectiveOrder(
        { 'antigravity-auth': { forceToTop: 'yes' } },
        'antigravity-auth',
        160,
      ),
    ).toBe(160)
  })
})

describe('queueTuiPreferenceUpdate', () => {
  test('creates file with template on first write', async () => {
    await queueTuiPreferenceUpdate(PLUGIN_KEY, ['collapsed'], true)
    const text = await readFile(file, 'utf8')
    expect(text).toContain('Shared preferences for opencode TUI plugins')
    const root = await readTuiPreferencesFile()
    expect(root).toEqual({ 'antigravity-auth': { collapsed: true } })
  })

  test('preserves comments and unrelated keys on update', async () => {
    const original = `// my notes
{
  // keep me
  "other-plugin": { "forceToTop": true },
  "antigravity-auth": {
    "pollMs": 2000, // tuned
    "collapsed": false
  }
}
`
    await writeFile(file, original, 'utf8')
    await queueTuiPreferenceUpdate(PLUGIN_KEY, ['collapsed'], true)
    const text = await readFile(file, 'utf8')
    expect(text).toContain('// my notes')
    expect(text).toContain('// keep me')
    expect(text).toContain('// tuned')
    expect(text).toContain('"pollMs": 2000')
    const root = await readTuiPreferencesFile()
    expect(root['other-plugin']).toEqual({ forceToTop: true })
    expect(
      (root['antigravity-auth'] as Record<string, unknown>).collapsed,
    ).toBe(true)
  })

  test('writes nested paths', async () => {
    await queueTuiPreferenceUpdate(PLUGIN_KEY, ['header', 'label'], 'Q')
    const root = await readTuiPreferencesFile()
    expect(root).toEqual({ 'antigravity-auth': { header: { label: 'Q' } } })
  })

  test('rapid sequential updates land the final value', async () => {
    const writes = [true, false, true, false].map((value) =>
      queueTuiPreferenceUpdate(PLUGIN_KEY, ['collapsed'], value),
    )
    await Promise.all(writes)
    const root = await readTuiPreferencesFile()
    expect(
      (root['antigravity-auth'] as Record<string, unknown>).collapsed,
    ).toBe(false)
  })

  test('preserves concurrent updates from independent plugin module instances', async () => {
    const firstPath = `./tui-preferences?writer=first-${Math.random()}`
    const secondPath = `./tui-preferences?writer=second-${Math.random()}`
    const first = (await import(
      /* @vite-ignore */ firstPath
    )) as typeof import('./tui-preferences')
    const second = (await import(
      /* @vite-ignore */ secondPath
    )) as typeof import('./tui-preferences')

    await Promise.all([
      first.queueTuiPreferenceUpdate('antigravity-auth', ['collapsed'], true),
      second.queueTuiPreferenceUpdate('sibling-plugin', ['enabled'], true),
    ])

    expect(await readTuiPreferencesFile()).toEqual({
      'antigravity-auth': { collapsed: true },
      'sibling-plugin': { enabled: true },
    })
  })

  test('no temp files are left behind', async () => {
    await queueTuiPreferenceUpdate(PLUGIN_KEY, ['collapsed'], true)
    const { readdir } = await import('node:fs/promises')
    const entries = await readdir(dir)
    expect(entries).toEqual(['tui-preferences.jsonc'])
  })
})

describe('watchTuiPreferences', () => {
  test('fires after the file changes', async () => {
    await writeFile(file, '{}', 'utf8')
    let fired = 0
    const dispose = watchTuiPreferences(() => {
      fired += 1
    })
    try {
      await new Promise((resolve) => setTimeout(resolve, 50))
      await queueTuiPreferenceUpdate(PLUGIN_KEY, ['collapsed'], true)
      await new Promise((resolve) => setTimeout(resolve, 400))
      expect(fired).toBeGreaterThanOrEqual(1)
    } finally {
      dispose()
    }
  })

  test('debounces bursts into few callbacks', async () => {
    await writeFile(file, '{}', 'utf8')
    let fired = 0
    const dispose = watchTuiPreferences(() => {
      fired += 1
    })
    try {
      await new Promise((resolve) => setTimeout(resolve, 50))
      for (let i = 0; i < 5; i++) {
        await queueTuiPreferenceUpdate(PLUGIN_KEY, ['pollMs'], 1000 + i)
      }
      await new Promise((resolve) => setTimeout(resolve, 400))
      expect(fired).toBeGreaterThanOrEqual(1)
      expect(fired).toBeLessThan(5)
    } finally {
      dispose()
    }
  })

  test('missing directory returns a no-op disposer', () => {
    process.env[TUI_PREFS_FILE_ENV] = join(dir, 'nope', 'missing.jsonc')
    const dispose = watchTuiPreferences(() => {})
    expect(typeof dispose).toBe('function')
    dispose()
  })

  test('dispose stops callbacks', async () => {
    await writeFile(file, '{}', 'utf8')
    let fired = 0
    const dispose = watchTuiPreferences(() => {
      fired += 1
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    dispose()
    await queueTuiPreferenceUpdate(PLUGIN_KEY, ['collapsed'], true)
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(fired).toBe(0)
  })

  test('ignores sibling files that share the preferences name as a prefix', async () => {
    await writeFile(file, '{}', 'utf8')
    let fired = 0
    const dispose = watchTuiPreferences(() => {
      fired += 1
    })
    try {
      await new Promise((resolve) => setTimeout(resolve, 50))
      await writeFile(
        join(dir, 'tui-preferences.jsonc.backup'),
        'noise',
        'utf8',
      )
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(fired).toBe(0)
      await queueTuiPreferenceUpdate(PLUGIN_KEY, ['collapsed'], true)
      await new Promise((resolve) => setTimeout(resolve, 400))
      expect(fired).toBeGreaterThanOrEqual(1)
    } finally {
      dispose()
    }
  })

  test('does not fire when the file is rewritten with identical content', async () => {
    await writeFile(file, '{}', 'utf8')
    let fired = 0
    const dispose = watchTuiPreferences(() => {
      fired += 1
    })
    try {
      await new Promise((resolve) => setTimeout(resolve, 50))
      await writeFile(file, '{}', 'utf8')
      await new Promise((resolve) => setTimeout(resolve, 400))
      expect(fired).toBe(0)
    } finally {
      dispose()
    }
  })
})
