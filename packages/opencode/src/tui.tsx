/** @jsxImportSource @opentui/solid */

/**
 * Read-only OpenTUI sidebar for the Antigravity plugin.
 *
 * Mirrors the fleet sibling layout (see `anthropic-auth-live` /
 * `openai-auth-live` `packages/opencode/src/tui.tsx`): a single bordered
 * column with a labelled header badge, a Quota section that lists one
 * `AccountBlock` per visible account, a Routing section that surfaces the
 * most recent session route, and a Health section that only appears when
 * something is wrong. The frame itself lives in `tui/sidebar-frame.tsx`,
 * shared with the OpenCode 2 sidebar; this file reads the sidebar file and
 * the preferences and hands them to it. The Antigravity data model is
 * richer than the Claude/Codex one (per-account Gemini + Non-Gemini quota
 * pools, a health score, and per-session routing decisions), so the fleet
 * components are adapted rather than copied verbatim:
 *
 * - The quota rows come from `tui/quota-layout.tsx`, shared with the
 *   OpenCode 2 sidebar: each window reads `remainingPercent + resetAt` from
 *   the Antigravity `SidebarQuotaEntry` shape, is colored via `quotaTone`
 *   (remaining threshold) instead of `usageTone` (used threshold), and is
 *   one line sized from the measured sidebar width.
 * - `AccountBlock` derives its status word (`active` / `idle` /
 *   `cooling` / `off`) from the Antigravity account state; the shared block
 *   shows the reading age once per account and groups windows under
 *   `Gemini` and `Other models` headers. The routing health score is not
 *   shown.
 * - `Routing` shows the mounted session's most recent `activeRouting`
 *   entry, or `No request yet` before the session's first request, since
 *   Antigravity does not maintain a per-session sidebar state alongside the
 *   slot-rendered tree.
 *
 * Hard rules for this file:
 *
 * - NO direct writes to the host terminal anywhere in the render path.
 *   The host terminal is the frame buffer; one stray byte corrupts every
 *   subsequent cell. Errors flow through `createTuiFileLogger()`.
 * - NO imports from `./plugin/storage`, `./plugin/accounts`, OAuth code,
 *   or anything that touches tokens.
 * - The component uses Solid's `onCleanup` to release the polling timer
 *   on unmount so a route change can never leak an interval.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  TuiPlugin,
  TuiPluginModule,
  TuiThemeCurrent,
} from '@opencode-ai/plugin/tui'
import { createSlot } from '@opentui/solid'
import { createSignal, type JSX, onCleanup, onMount } from 'solid-js'

import { getRpcDir } from './rpc/rpc-dir'
import { readSidebarState, type SidebarStateV1 } from './sidebar-state'
import { createTuiFileLogger, type TuiLogger } from './tui/file-logger'
import {
  createV1MenuTransport,
  dispatchV1Notification,
  type V1Notification,
} from './tui/host-v1'
import { type FrameRoute, SidebarFrame } from './tui/sidebar-frame'
import {
  type AntigravityAuthTuiPrefs,
  computeEffectiveOrder,
  DEFAULT_PREFS,
  DEFAULT_SLOT_ORDER,
  PLUGIN_KEY,
  queueTuiPreferenceUpdate,
  readTuiPreferencesFile,
  resolveAntigravityAuthPrefs,
  watchTuiPreferences,
} from './tui-preferences'

const ID = 'cortexkit.antigravity-auth'

const POLL_INTERVAL_MS = 2000
const RPC_POLL_MS = 500

// Read package metadata from either the raw src/ entry or its generated
// src/tui-compiled/ counterpart. Avoid a JSON import because package.json sits
// outside the declaration build's rootDir.
const PLUGIN_VERSION: string = (() => {
  const here = dirname(fileURLToPath(import.meta.url))
  for (const packageFile of [
    join(here, '..', 'package.json'),
    join(here, '..', '..', 'package.json'),
  ]) {
    try {
      const raw = readFileSync(packageFile, 'utf8')
      const version = (JSON.parse(raw) as { version?: string }).version
      if (version) return version
    } catch {
      // Try the path for the other TUI entry layout.
    }
  }
  return ''
})()
// Module-scoped state — TEST ISOLATION CONTRACT:
//
// `rpcPollStarted`, notification cursor/deduplication state, `rpcInFlight`, and the lazy
// `sidebarController` below persist across tests via the cached ES
// module Bun loads once per `--isolate` file. Tests must NOT assert
// fresh-process behaviour from these variables — by the time the first
// `startRpcNotificationPolling` runs, all four carry stale values from
// prior tests in the same file. Test isolation comes from:
//   1. fresh-importing `tui.tsx` via a cache-busted dynamic `import`
//      so the module re-evaluates with fresh module-scoped bindings, and
//   2. constructing a fresh `SidebarController` via
//      `createSidebarController(prefs)` and passing it through
//      `SidebarPanel.props.controller` — never through
//      `getSidebarController()`, which lazily seeds the module-scoped
//      singleton.
let rpcPollStarted = false
const notificationCursorBySession = new Map<string, number>()
const dispatchedNotificationIds = new Set<number>()
let rpcInFlight = false
const GLOBAL_NOTIFICATION_CURSOR = '__global__'
const MAX_NOTIFICATION_CURSORS = 256

// --- Theme tokens ----------------------------------------------------------
//
// The sidebar pulls its colors from the live host theme (`api.theme.current`
// — a Solid-friendly getter that re-emits when the user switches theme).
// `tui/sidebar-frame.tsx` reads every color from this theme: tone colors
// through `toneColor(theme, tone)` with its sibling-token `??` fallbacks,
// the rest straight from their theme field. So the sidebar tracks the
// active theme and never hardcodes an ANSI literal.
//
// `FALLBACK_THEME` is the safety net for tests and any future host that
// does not implement the theme surface. The fields the sidebar actually
// uses are populated; the rest of the TuiThemeCurrent fields are left
// undefined and the `??` chain in `toneColor` falls through cleanly.

type Theme = TuiThemeCurrent

const FALLBACK_THEME = {
  primary: '#3b82f6',
  secondary: '#a855f7',
  accent: '#7c3aed',
  error: '#ef4444',
  warning: '#eab308',
  success: '#22c55e',
  info: '#0ea5e9',
  text: '#e5e7eb',
  textMuted: '#6b7280',
  selectedListItemText: '#ffffff',
  background: '#0b0d12',
  backgroundPanel: '#11131a',
  backgroundElement: '#1a1d27',
  backgroundMenu: '#1a1d27',
  border: '#2a2d3a',
  borderActive: '#7c3aed',
  borderSubtle: '#2a2d3a',
  diffAdded: '#22c55e',
  diffRemoved: '#ef4444',
  diffContext: '#6b7280',
  diffHunkHeader: '#7c3aed',
  diffHighlightAdded: '#166534',
  diffHighlightRemoved: '#7f1d1d',
  diffAddedBg: '#0a1f12',
  diffRemovedBg: '#1f0a0a',
  diffContextBg: '#0b0d12',
  diffLineNumber: '#4b5563',
  diffAddedLineNumberBg: '#0a1f12',
  diffRemovedLineNumberBg: '#1f0a0a',
  markdownText: '#e5e7eb',
  markdownHeading: '#7c3aed',
  markdownLink: '#3b82f6',
  markdownLinkText: '#60a5fa',
  markdownCode: '#22c55e',
  markdownBlockQuote: '#6b7280',
  markdownEmph: '#eab308',
  markdownStrong: '#7c3aed',
  markdownHorizontalRule: '#2a2d3a',
  markdownListItem: '#7c3aed',
  markdownListEnumeration: '#a855f7',
  markdownImage: '#3b82f6',
  markdownImageText: '#60a5fa',
  markdownCodeBlock: '#11131a',
  syntaxComment: '#6b7280',
  syntaxKeyword: '#a855f7',
  syntaxFunction: '#3b82f6',
  syntaxVariable: '#e5e7eb',
  syntaxString: '#22c55e',
  syntaxNumber: '#eab308',
  syntaxType: '#7c3aed',
  syntaxOperator: '#e5e7eb',
  syntaxPunctuation: '#6b7280',
  thinkingOpacity: 0.6,
} as unknown as Theme

export interface SidebarPanelProps {
  /** Override the file the TUI polls. Defaults to `getSidebarStateFile()`. */
  stateFile?: string
  /** Override the polling interval. Defaults to 2000ms. */
  pollIntervalMs?: number
  /** Override the logger; tests inject a logger that captures into memory. */
  logger?: TuiLogger
  /** Optional override for the current epoch in milliseconds (tests). */
  now?: () => number
  /** Optional prefs controller — when present, drives collapse/expand and
   * section toggles. Module-scoped controller is created at plugin init. */
  controller?: SidebarController
  /** Optional live-theme accessor. The host's `api.theme.current` is wired
   * through here in production; tests pass a custom accessor to flip theme
   * and assert re-render. Falls back to FALLBACK_THEME when unset. */
  theme?: () => Theme
  /** The slot session determines which route is relevant to this sidebar. */
  sessionId?: string
}

export interface SidebarController {
  prefs: () => AntigravityAuthTuiPrefs
  collapsed: () => boolean
  toggleCollapsed: () => void
}

interface InternalState {
  loaded: SidebarStateV1
  lastReadAt: number
  lastError: string | null
}

const EMPTY_STATE: SidebarStateV1 = {
  version: 2,
  checkedAt: 0,
  accounts: [],
  activeRouting: {},
  routingAuthoritative: false,
}

function resolveLogger(logger: TuiLogger | undefined): TuiLogger {
  if (logger) return logger
  try {
    return createTuiFileLogger()
  } catch {
    // Fall back to a stub that drops everything — the sidebar must still
    // render even if file logging cannot be initialized.
    return noopLogger()
  }
}

function noopLogger(): TuiLogger {
  const drop = () => undefined
  return {
    debug: drop,
    info: drop,
    warn: drop,
    error: drop,
    getLogPath: () => undefined,
  }
}

// Module-scoped controller singleton, initialized at plugin startup. The
// watcher is intentionally never disposed — collapse/prefs state survives
// sidebar remounts (route changes) for the lifetime of the TUI process,
// mirroring the fleet siblings.
//
// TEST ISOLATION: this singleton, like `rpcPollStarted` above, persists
// across tests via the cached ES module. Tests construct a controller
// via `createSidebarController(prefs)` and pass it through
// `SidebarPanel.props.controller` — they MUST NOT rely on this lazy
// singleton for isolation. See the block above for the full contract.
let sidebarController: SidebarController | null = null

// The TUI may unmount and remount sidebar_content when the user switches
// views. A remount re-runs the component body, so any signal created inside
// the component would reset to its seed. The controller lives in the plugin
// closure (process lifetime) and owns the durable prefs/collapse signals
// plus the single shared watcher subscription, so collapse and live pref
// reloads survive the remount.
//
// Exported so tests can construct a controller with a controlled initial
// prefs snapshot without touching the module-scoped singleton.
export function createSidebarController(
  initialPrefs: AntigravityAuthTuiPrefs,
): SidebarController {
  const [prefs, setPrefs] = createSignal<AntigravityAuthTuiPrefs>(initialPrefs)
  const seedCollapsed =
    initialPrefs.rememberCollapsed && initialPrefs.collapsed != null
      ? initialPrefs.collapsed
      : initialPrefs.startCollapsed
  const [collapsed, setCollapsed] = createSignal(seedCollapsed)
  let lastPersistedCollapsed: boolean | null = initialPrefs.collapsed
  let lastApplied = JSON.stringify(initialPrefs)

  // The watcher lives for the plugin/process lifetime — it is intentionally
  // never disposed. Collapse guard mirrors the race-fix in toggleCollapsed:
  // lastPersistedCollapsed is advanced only once our own write lands, so
  // watcher echoes of the previous persisted value are rejected by the
  // `!==` check and cannot revert a user click.
  watchTuiPreferences(() => {
    void (async () => {
      const next = resolveAntigravityAuthPrefs(await readTuiPreferencesFile())
      const serialized = JSON.stringify(next)
      if (serialized === lastApplied) return
      lastApplied = serialized
      setPrefs(next)
      if (
        next.rememberCollapsed &&
        next.collapsed != null &&
        next.collapsed !== lastPersistedCollapsed
      ) {
        lastPersistedCollapsed = next.collapsed
        setCollapsed(next.collapsed)
      }
    })()
  })

  function toggleCollapsed() {
    const next = !collapsed()
    setCollapsed(next)
    if (prefs().rememberCollapsed) {
      void queueTuiPreferenceUpdate(PLUGIN_KEY, ['collapsed'], next).then(
        () => {
          lastPersistedCollapsed = next
        },
      )
    }
  }

  return { prefs, collapsed, toggleCollapsed }
}

// Lazy module-scoped accessor used by the plugin entry. Tests should NOT go
// through this — they construct their own controller via createSidebarController
// and pass it via SidebarPanelProps.controller.
function getSidebarController(): SidebarController {
  if (!sidebarController) {
    sidebarController = createSidebarController(DEFAULT_PREFS)
  }
  return sidebarController
}

function formatError(value: unknown): string {
  if (value instanceof Error) return value.message
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

// --- SidebarPanel ----------------------------------------------------------

export function SidebarPanel(props: SidebarPanelProps): JSX.Element {
  const logger = resolveLogger(props.logger)
  const now = props.now ?? (() => Date.now())
  const pollMs = props.pollIntervalMs ?? POLL_INTERVAL_MS
  const controller = props.controller ?? getSidebarController()
  const collapsed = controller.collapsed
  const prefs = controller.prefs
  // Live host theme — falls back to a sensible dark palette when the host
  // does not expose one. Solid tracks `theme()` so a theme switch re-renders
  // every styled span/border without a manual subscription.
  const theme = (): Theme => props.theme?.() ?? FALLBACK_THEME

  const [state, setState] = createSignal<InternalState>({
    loaded: EMPTY_STATE,
    lastReadAt: 0,
    lastError: null,
  })

  const refresh = (): void => {
    try {
      const loaded = readSidebarState(props.stateFile)
      setState({
        loaded,
        lastReadAt: now(),
        lastError: null,
      })
    } catch (error) {
      logger.warn('sidebar-poll-failed', { error: formatError(error) })
      setState((prev) => ({
        ...prev,
        lastReadAt: now(),
        lastError: formatError(error),
      }))
    }
  }

  onMount(() => {
    refresh()
    const interval = setInterval(refresh, pollMs)
    onCleanup(() => clearInterval(interval))
  })

  const lastError = () => state().lastError ?? state().loaded.lastError

  const currentRoute = (): FrameRoute | null => {
    const routes = state().loaded.activeRouting
    const entry = props.sessionId
      ? routes[props.sessionId]
      : Object.values(routes).sort((a, b) => b.updatedAt - a.updatedAt)[0]
    if (!entry) return null
    return {
      strategy: entry.strategy,
      family: entry.modelFamily,
      style: entry.headerStyle,
    }
  }

  return (
    <SidebarFrame
      theme={theme}
      settings={prefs}
      version={PLUGIN_VERSION}
      collapsed={collapsed}
      onToggleCollapsed={controller.toggleCollapsed}
      accounts={() => state().loaded.accounts}
      route={currentRoute}
      quotaBackoffUntil={() => state().loaded.quotaBackoffUntil}
      lastError={lastError}
      now={now}
    />
  )
}

/**
 * Solid slot registry binding exposed for hosts that want to mount the
 * sidebar inside their renderer. Hosts that already own a slot registry can
 * use `createSlot` directly; we re-export for convenience and to keep the
 * contract visible at the module entry point.
 */
export const sidebar_content = createSlot

interface RpcNotificationPollOptions {
  pending: (
    lastReceivedId: number,
    sessionId?: string,
  ) => Promise<readonly V1Notification[]>
  currentSessionId: () => string | undefined
  dispatch: (notification: V1Notification) => void | Promise<void>
  schedule: (poll: () => Promise<void>, intervalMs: number) => void
  /**
   * File logger used to surface poll errors. Must be a file logger — the
   * host terminal is the frame buffer, so writes to stdout/stderr would
   * corrupt the sidebar render. The plugin production path uses
   * `resolveLogger(undefined)` to fall through to the on-disk file
   * logger.
   */
  logger: TuiLogger
}

export function startRpcNotificationPolling(
  options: RpcNotificationPollOptions,
): void {
  if (rpcPollStarted) return
  rpcPollStarted = true
  options.schedule(async () => {
    if (rpcInFlight) return
    rpcInFlight = true
    try {
      const sessionId = options.currentSessionId()
      const cursorKey = sessionId ?? GLOBAL_NOTIFICATION_CURSOR
      let cursor = notificationCursorBySession.get(cursorKey) ?? 0
      const notifications = await options.pending(cursor, sessionId)
      for (const notification of [...notifications].sort(
        (a, b) => a.id - b.id,
      )) {
        if (notification.id <= cursor) continue
        cursor = Math.max(cursor, notification.id)
        if (dispatchedNotificationIds.has(notification.id)) continue
        dispatchedNotificationIds.add(notification.id)
        if (dispatchedNotificationIds.size > 100) {
          const oldestId = dispatchedNotificationIds.values().next().value
          if (oldestId !== undefined) dispatchedNotificationIds.delete(oldestId)
        }
        await options.dispatch(notification)
      }
      if (!notificationCursorBySession.has(cursorKey)) {
        while (notificationCursorBySession.size >= MAX_NOTIFICATION_CURSORS) {
          const oldest = notificationCursorBySession.keys().next().value
          if (oldest === undefined) break
          notificationCursorBySession.delete(oldest)
        }
      }
      notificationCursorBySession.set(cursorKey, cursor)
    } catch (error) {
      // Surface the swallowed error through the file logger rather than
      // stdout/stderr (the host terminal is the frame buffer — any byte
      // written here corrupts every subsequent cell). Without this, a
      // transient RPC outage is invisible to operators. The catch stays
      // because one failed poll must never break the next — the scheduler
      // is a setInterval and a thrown error there would crash the
      // process.
      options.logger.warn('rpc-poll-failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      rpcInFlight = false
    }
  }, RPC_POLL_MS)
}

const tui: TuiPlugin = async (api) => {
  const logger = resolveLogger(undefined)
  const prefsRoot = await readTuiPreferencesFile()
  if (!sidebarController) {
    sidebarController = createSidebarController(
      resolveAntigravityAuthPrefs(prefsRoot),
    )
  }
  // The `/antigravity` drawer: the server pushes the menu as a notification
  // on this process's private RPC; the drawer applies through the same RPC.
  const transport = createV1MenuTransport(
    getRpcDir(api.state.path.directory ?? ''),
    process.pid,
  )
  startRpcNotificationPolling({
    pending: (lastReceivedId, sessionId) =>
      transport.pending(lastReceivedId, sessionId),
    currentSessionId: () => {
      const current = (api.route as { current?: unknown }).current
      const resolved =
        typeof current === 'function' ? (current as () => unknown)() : current
      return (resolved as { params?: { sessionID?: string } } | undefined)
        ?.params?.sessionID
    },
    dispatch: (notification) => {
      logger.debug('rpc-notification-received', {
        id: notification.id,
        sessionId: notification.sessionId,
      })
      dispatchV1Notification(api, transport, notification, logger)
    },
    schedule: (poll, intervalMs) => {
      setInterval(() => void poll(), intervalMs)
    },
    logger,
  })

  // The host supplies the live theme via `api.theme.current` — the slot
  // callback's closure captures `api` so the accessor always reads the
  // current theme. A Solid re-render follows whenever the user switches.
  const liveTheme = (): TuiThemeCurrent => api.theme.current

  api.slots.register({
    order: computeEffectiveOrder(prefsRoot, PLUGIN_KEY, DEFAULT_SLOT_ORDER),
    slots: {
      sidebar_content: (_context, { session_id: sessionId }) => (
        <SidebarPanel logger={logger} theme={liveTheme} sessionId={sessionId} />
      ),
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: ID,
  tui,
}

export default plugin
