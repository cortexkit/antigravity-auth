import { randomUUID } from 'node:crypto'
import { watch } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import {
  clearTimeout as nativeClearTimeout,
  setTimeout as nativeSetTimeout,
} from 'node:timers'
import { acquireFencedFileLock } from '@cortexkit/antigravity-auth-core/file-lock'
import { applyEdits, modify, type ParseError, parse } from 'jsonc-parser'

export const TUI_PREFS_FILE_ENV = 'OPENCODE_TUI_PREFERENCES_FILE'
const FILE_NAME = 'tui-preferences.jsonc'
const PREFERENCES_LOCK_NAME = 'preferences'
const PREFERENCES_LOCK_TTL_MS = 10_000
const PREFERENCES_LOCK_TIMEOUT_MS = 2_000
const PREFERENCES_LOCK_RETRY_MS = 25

// Shared preferences file for opencode TUI plugins. One top-level key per
// plugin (short name, e.g. "antigravity-auth"). The file is optional: every
// reader must fall back to defaults when it is missing or malformed.
export function getTuiPreferencesFile(): string {
  const override = process.env[TUI_PREFS_FILE_ENV]
  if (override) return override
  const configDir =
    process.env.OPENCODE_CONFIG_DIR ||
    join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode')
  return join(configDir, FILE_NAME)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Tolerant read: missing file, parse errors, or a non-object root all resolve
// to {} so the sidebar never crashes on user-edited content. jsonc-parser's
// fault-tolerant parse can still hand back a partial object for an
// unterminated/bracketed file or trailing garbage, so we collect errors and
// treat any reported fault as malformed.
export async function readTuiPreferencesFile(): Promise<
  Record<string, unknown>
> {
  try {
    const raw = await readFile(getTuiPreferencesFile(), 'utf8')
    const errors: ParseError[] = []
    const root: unknown = parse(raw, errors, { allowTrailingComma: true })
    if (errors.length > 0) return {}
    return isRecord(root) ? root : {}
  } catch {
    return {}
  }
}

export const PLUGIN_KEY = 'antigravity-auth'
export const DEFAULT_SLOT_ORDER = 160

export interface AntigravityAuthTuiPrefs {
  forceToTop: boolean
  order: number
  startCollapsed: boolean
  rememberCollapsed: boolean
  // null = never persisted; seed the UI from startCollapsed instead.
  collapsed: boolean | null
  pollMs: number
  refreshDebounceMs: number
  header: {
    label: string
    showVersion: boolean
  }
  sections: {
    quota: boolean
    fallbackAccounts: boolean
    routing: boolean
    health: boolean
  }
  appearance: {
    barWidth: number
    barFilledChar: string
    barEmptyChar: string
    warnThreshold: number
    errorThreshold: number
  }
}

export type AppearancePrefs = AntigravityAuthTuiPrefs['appearance']

export const DEFAULT_PREFS: AntigravityAuthTuiPrefs = {
  forceToTop: false,
  order: DEFAULT_SLOT_ORDER,
  startCollapsed: false,
  rememberCollapsed: true,
  collapsed: null,
  pollMs: 1500,
  refreshDebounceMs: 200,
  header: { label: 'ANTIGRAVITY', showVersion: true },
  sections: {
    quota: true,
    fallbackAccounts: true,
    routing: true,
    health: true,
  },
  appearance: {
    barWidth: 10,
    barFilledChar: '█',
    barEmptyChar: '░',
    warnThreshold: 50,
    errorThreshold: 80,
  },
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function int(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(Math.max(Math.round(value), min), max)
}

function label(value: unknown, fallback: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length === 0) return fallback
  return value.slice(0, maxLength)
}

function char(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const first = [...value][0]
  return first ?? fallback
}

// Per-key validation: every value is independently clamped/defaulted so one
// bad entry never poisons the rest. Never throws.
//
// Antigravity reads the thresholds as remaining-percent: healthy when the
// remaining is above `warnThreshold`, warn between `errorThreshold` and
// `warnThreshold`, error below `errorThreshold`. So `errorThreshold` is the
// smaller number (the danger floor) and must stay strictly below `warnThreshold`.
export function resolveAntigravityAuthPrefs(
  root: Record<string, unknown>,
): AntigravityAuthTuiPrefs {
  const entry = root[PLUGIN_KEY]
  if (!isRecord(entry)) return structuredClone(DEFAULT_PREFS)

  const d = DEFAULT_PREFS
  const header = isRecord(entry.header) ? entry.header : {}
  const sections = isRecord(entry.sections) ? entry.sections : {}
  const appearance = isRecord(entry.appearance) ? entry.appearance : {}

  const configuredWarnThreshold = int(
    appearance.warnThreshold,
    d.appearance.warnThreshold,
    0,
    99,
  )
  const configuredErrorThreshold = int(
    appearance.errorThreshold,
    d.appearance.errorThreshold,
    0,
    100,
  )
  // Older preferences stored remaining-percent thresholds, whose error value
  // was lower than warn. Convert that shape while accepting the fleet's new
  // used-percent ordering without a preferences schema migration.
  const [warnThreshold, errorThreshold] =
    configuredErrorThreshold < configuredWarnThreshold
      ? [100 - configuredWarnThreshold, 100 - configuredErrorThreshold]
      : [
          configuredWarnThreshold,
          Math.max(
            configuredErrorThreshold,
            Math.min(configuredWarnThreshold + 1, 100),
          ),
        ]

  return {
    forceToTop: bool(entry.forceToTop, d.forceToTop),
    order: int(entry.order, d.order, -10000, 10000),
    startCollapsed: bool(entry.startCollapsed, d.startCollapsed),
    rememberCollapsed: bool(entry.rememberCollapsed, d.rememberCollapsed),
    collapsed: typeof entry.collapsed === 'boolean' ? entry.collapsed : null,
    pollMs: int(entry.pollMs, d.pollMs, 500, 30000),
    refreshDebounceMs: int(
      entry.refreshDebounceMs,
      d.refreshDebounceMs,
      50,
      5000,
    ),
    header: {
      label: label(header.label, d.header.label, 20),
      showVersion: bool(header.showVersion, d.header.showVersion),
    },
    sections: {
      quota: bool(sections.quota, d.sections.quota),
      fallbackAccounts: bool(
        sections.fallbackAccounts,
        d.sections.fallbackAccounts,
      ),
      routing: bool(sections.routing, d.sections.routing),
      health: bool(sections.health, d.sections.health),
    },
    appearance: {
      barWidth: int(appearance.barWidth, d.appearance.barWidth, 4, 40),
      barFilledChar: char(appearance.barFilledChar, d.appearance.barFilledChar),
      barEmptyChar: char(appearance.barEmptyChar, d.appearance.barEmptyChar),
      warnThreshold,
      errorThreshold,
    },
  }
}

const FORCE_TOP_BASE = -100000

// Shared forceToTop convention: forced plugins sort below FORCE_TOP_BASE,
// ordered among themselves by their top-level key's position in the file, so
// users reprioritize by reordering keys. The user-facing `order` knob clamps
// to -10000..10000, strictly above the forced band, so a manual order can
// never beat forceToTop. Host slots render ascending by order; opencode's
// built-ins occupy 100-500.
//
// Key-naming requirement: plugin keys must be non-integer-like short names
// (e.g. "antigravity-auth"). JavaScript object key iteration order hoists
// integer-like keys ("0", "1", "42") ahead of any string keys, which would
// skew the indexOf-based ordering of forced plugins. The shared
// `tui-preferences.jsonc` convention requires non-numeric names, so this
// implementation does not paper over the JS quirk.
export function computeEffectiveOrder(
  root: Record<string, unknown>,
  pluginKey: string,
  defaultOrder: number,
): number {
  const entry = root[pluginKey]
  if (!isRecord(entry)) return defaultOrder
  if (entry.forceToTop === true) {
    return FORCE_TOP_BASE + Object.keys(root).indexOf(pluginKey)
  }
  return int(entry.order, defaultOrder, -10000, 10000)
}

const TEMPLATE = `// Shared preferences for opencode TUI plugins.
// One top-level key per plugin (short name). See each plugin's README for
// its supported settings. This file is safe to hand-edit; plugins update
// individual keys in place and preserve comments.
{}
`

type JsonValue = string | number | boolean | null

async function acquirePreferencesLock(file: string) {
  const deadline = Date.now() + PREFERENCES_LOCK_TIMEOUT_MS
  for (;;) {
    const lock = await acquireFencedFileLock({
      path: file,
      name: PREFERENCES_LOCK_NAME,
      ttlMs: PREFERENCES_LOCK_TTL_MS,
      renew: true,
    })
    if (lock) return lock
    if (Date.now() >= deadline) {
      throw new Error(`Timed out acquiring TUI preferences lock: ${file}`)
    }
    await new Promise<void>((resolve) =>
      nativeSetTimeout(resolve, PREFERENCES_LOCK_RETRY_MS),
    )
  }
}

async function writePreference(
  pluginKey: string,
  path: string[],
  value: JsonValue,
): Promise<void> {
  const file = getTuiPreferencesFile()
  await mkdir(dirname(file), { recursive: true })
  const lock = await acquirePreferencesLock(file)
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`
  try {
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch {
      text = ''
    }
    if (text.trim() === '') text = TEMPLATE
    const edits = modify(text, [pluginKey, ...path], value, {
      formattingOptions: { insertSpaces: true, tabSize: 2 },
    })
    const next = applyEdits(text, edits)
    await writeFile(tmp, next, { encoding: 'utf8', mode: 0o600 })
    await lock.assertOwned()
    await rename(tmp, file)
  } finally {
    await rm(tmp, { force: true }).catch(() => {})
    await lock.release()
  }
}

let writeChain: Promise<void> = Promise.resolve()

// Writes are serialized on a promise chain: each update re-reads the file,
// applies a minimal comment-preserving edit to one property, and replaces the
// file atomically (temp + rename in the same directory). Best-effort by
// design — preferences are never worth crashing the TUI over.
export function queueTuiPreferenceUpdate(
  pluginKey: string,
  path: string[],
  value: JsonValue,
): Promise<void> {
  writeChain = writeChain
    .then(() => writePreference(pluginKey, path, value))
    .catch(() => {})
  return writeChain
}

const WATCH_DEBOUNCE_MS = 150
const WATCH_POLL_MS = 100

// Watches the directory rather than the file: editors and our own atomic
// writes replace the file via rename, which kills file-level watchers.
//
// Filtering is two-stage:
//   1. Filename pre-filter: only debounce events for the preferences file
//      name, or our atomic-write temp file. This is a cheap first pass that
//      drops the common case (unrelated sibling files).
//   2. Content check inside the debounce: after the timer fires, re-read
//      the file and compare it against the last seen content. Only fire
//      `onChange` when the content actually changed. This is the authority.
//      Some platforms (notably macOS FSEvents and a few inotify backends)
//      can misattribute a rename of an unrelated sibling file to the
//      real preferences filename in addition to emitting the sibling's
//      own event, so a name-only filter still produces a stray callback.
//      A content comparison is robust against that, against coalesced
//      events, and against mtime granularity.
//
// Returns a disposer; never throws.
export function watchTuiPreferences(onChange: () => void): () => void {
  const file = getTuiPreferencesFile()
  const name = basename(file)
  let timer: ReturnType<typeof nativeSetTimeout> | null = null
  let lastSeen: string | null = null
  let observedEvent = false
  let disposed = false

  const checkForChange = async () => {
    const text = await readFile(file, 'utf8').catch(() => null)
    if (disposed || text === null) return
    if (text === lastSeen) return
    lastSeen = text
    onChange()
  }

  const scheduleCheck = () => {
    observedEvent = true
    if (timer) nativeClearTimeout(timer)
    timer = nativeSetTimeout(() => {
      timer = null
      void checkForChange()
    }, WATCH_DEBOUNCE_MS)
  }

  // Seed asynchronously. If a real file event arrives before the read resolves,
  // do not let the seed overwrite that pending change; the debounced re-read
  // will compare against the previous value and fire.
  void readFile(file, 'utf8')
    .then((text) => {
      if (!observedEvent && lastSeen === null) lastSeen = text
    })
    .catch(() => {})

  try {
    const watcher = watch(dirname(file), (_event, filename) => {
      // Exact match against the preferences file name, plus the temp file
      // we use for atomic writes (carrying our pid + `.tmp`).
      const isOurs =
        filename === name ||
        (filename?.startsWith(`${name}.`) && filename.endsWith('.tmp'))
      if (filename != null && !isOurs) return
      scheduleCheck()
    })

    // Bun's fs.watch can miss atomic temp-file rename updates on some
    // backends, so keep a low-cost polling loop as the correctness path.
    // Use recursive timers instead of fs.watchFile because watchFile can keep
    // Bun test processes alive long after unwatchFile().
    let pollTimer: ReturnType<typeof nativeSetTimeout> | null = null
    let pollInFlight = false
    const schedulePoll = () => {
      if (disposed || pollTimer) return
      pollTimer = nativeSetTimeout(() => {
        pollTimer = null
        if (disposed || pollInFlight) return
        pollInFlight = true
        void checkForChange().finally(() => {
          pollInFlight = false
          schedulePoll()
        })
      }, WATCH_POLL_MS)
      pollTimer.unref?.()
    }
    schedulePoll()

    return () => {
      disposed = true
      if (timer) nativeClearTimeout(timer)
      if (pollTimer) nativeClearTimeout(pollTimer)
      watcher.close()
    }
  } catch {
    return () => {}
  }
}
