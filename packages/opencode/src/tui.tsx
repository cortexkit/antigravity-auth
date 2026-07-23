/** @jsxImportSource @opentui/solid */

/**
 * Read-only OpenTUI sidebar for the Antigravity plugin.
 *
 * Mirrors the fleet sibling layout (see `anthropic-auth-live` /
 * `openai-auth-live` `packages/opencode/src/tui.tsx`): a single bordered
 * column with a labelled header badge, a Quota section that lists one
 * `AccountBlock` per visible account, a Routing section that surfaces the
 * most recent session route, and a Health section that only appears when
 * something is wrong. The Antigravity data model is richer than the
 * Claude/Codex one (per-account Claude + Gemini Pro + Gemini Flash quota
 * groups, a health score, and per-session routing decisions), so the
 * fleet components are adapted rather than copied verbatim:
 *
 * - `QuotaRow` reads `remainingPercent + resetAt` from the Antigravity
 *   `SidebarQuotaEntry` shape and colors via `quotaTone` (remaining
 *   threshold) instead of `usageTone` (used threshold).
 * - `AccountBlock` derives its status word (`active` / `idle` /
 *   `cooling` / `off` / `blocked`) from the Antigravity account state and
 *   surfaces health as a muted secondary line rather than a top-level
 *   bar — fleet parity for "Quota first, health second".
 * - `Routing` resolves to a single `Route` `StatRow` carrying the most
 *   recent `activeRouting` entry, since Antigravity does not maintain a
 *   per-session sidebar state alongside the slot-rendered tree.
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
  TuiPluginApi,
  TuiPluginModule,
  TuiThemeCurrent,
} from '@opencode-ai/plugin/tui'
import { createSlot } from '@opentui/solid'
import {
  createEffect,
  createSignal,
  For,
  type JSX,
  onCleanup,
  onMount,
  Show,
} from 'solid-js'
import type { RpcNotification } from './rpc/protocol'
import { createRpcClient } from './rpc/rpc-client'
import { getRpcDir } from './rpc/rpc-dir'
import {
  readSidebarState,
  type SidebarAccountState,
  type SidebarQuotaEntry,
  type SidebarQuotaKey,
  type SidebarStateV1,
} from './sidebar-state'
import { openCommandDialog } from './tui/command-dialogs'
import { createTuiFileLogger, type TuiLogger } from './tui/file-logger'
import {
  type AntigravityAuthTuiPrefs,
  type AppearancePrefs,
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
// `rpcPollStarted`, `lastNotificationId`, `rpcInFlight`, and the lazy
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
let lastNotificationId = 0
let rpcInFlight = false

const QUOTA_LABELS: Record<SidebarQuotaKey, string> = {
  claude: 'Cl',
  'gemini-pro': 'GP',
  'gemini-flash': 'GF',
}

const QUOTA_ORDER: readonly SidebarQuotaKey[] = [
  'claude',
  'gemini-pro',
  'gemini-flash',
]

// --- Theme tokens ----------------------------------------------------------
//
// The sidebar pulls its colors from the live host theme (`api.theme.current`
// — a Solid-friendly getter that re-emits when the user switches theme).
// Every render path resolves through `toneColor(theme, tone)` with a
// sibling-style `??` fallback chain, so the sidebar always tracks the
// active theme and never hardcodes an ANSI literal.
//
// `FALLBACK_THEME` is the safety net for tests and any future host that
// does not implement the theme surface. The fields the sidebar actually
// uses are populated; the rest of the TuiThemeCurrent fields are left
// undefined and the `??` chain in `toneColor` falls through cleanly.

type Tone = 'ok' | 'warn' | 'err' | 'muted' | 'accent' | 'text'
type Theme = TuiThemeCurrent
type ThemeColor = Theme['text']

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

// Mirror the fleet siblings' tone chain: every tone falls through to a
// sibling token, so a sparse custom theme still renders readably.
function toneColor(theme: Theme, tone: Tone): ThemeColor {
  switch (tone) {
    case 'ok':
      return theme.success ?? theme.accent
    case 'warn':
      return theme.warning ?? theme.accent
    case 'err':
      return theme.error ?? theme.accent
    case 'muted':
      return theme.textMuted ?? theme.text
    case 'accent':
      return theme.accent ?? theme.text
    default:
      return theme.text
  }
}

function quotaTone(usedPct: number, appearance: AppearancePrefs): Tone {
  if (usedPct < appearance.warnThreshold) return 'ok'
  if (usedPct < appearance.errorThreshold) return 'warn'
  return 'err'
}

interface BarSegment {
  text: string
  tone: Tone
}

function quotaBarSegments(
  usedPct: number,
  appearance: AppearancePrefs,
): BarSegment[] {
  const width = appearance.barWidth
  const usedCells = Math.max(
    0,
    Math.min(Math.round((usedPct / 100) * width), width),
  )
  const tone = quotaTone(usedPct, appearance)
  return [
    { text: appearance.barFilledChar.repeat(usedCells), tone },
    { text: appearance.barEmptyChar.repeat(width - usedCells), tone },
  ].filter((segment) => segment.text.length > 0)
}

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
  version: 1,
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

// --- Shared helpers (fleet shape, antigravity data) ------------------------

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min
  if (value > max) return max
  return value
}

// Render a "reset in Nm/Nh/NdNh" string from an epoch-ms reset time.
// Empty string when no resetAt is cached. The fleet's `formatResetIn`
// reads ISO strings; Antigravity persists resetAt as a numeric epoch, so
// the wrapper adapts to that without changing the shape of the output.
function formatResetIn(resetAt: number | undefined, now: () => number): string {
  if (!resetAt) return ''
  const ms = resetAt - now()
  if (ms <= 0) return 'now'
  const mins = Math.floor(ms / 60_000)
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) {
    const rm = mins % 60
    return rm > 0 ? `${hrs}h${rm}m` : `${hrs}h`
  }
  const days = Math.floor(hrs / 24)
  const rh = hrs % 24
  return rh > 0 ? `${days}d${rh}h` : `${days}d`
}

function formatError(value: unknown): string {
  if (value instanceof Error) return value.message
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

// --- Fleet components (adapted to antigravity data) ------------------------

// Section header — fleet pattern: bold title, themed text color, top margin
// for vertical breathing room between sections.
function SectionHeader(props: {
  theme: () => Theme
  title: string
}): JSX.Element {
  return (
    <box width='100%' marginTop={1}>
      <text fg={toneColor(props.theme(), 'text')}>
        <b>{props.title}</b>
      </text>
    </box>
  )
}

// Fleet StatRow: muted label left, value (optionally tone-tinted, bold)
// right. Mirrors the layout the Claude/Codex sidebars use for routing
// rows, plan rows, and "resets N" rows.
function StatRow(props: {
  theme: () => Theme
  label: string
  value: string
  tone?: Tone
}): JSX.Element {
  return (
    <box width='100%' flexDirection='row' justifyContent='space-between'>
      <text fg={props.theme().textMuted}>{props.label}</text>
      <text fg={toneColor(props.theme(), props.tone ?? 'text')}>
        <b>{props.value}</b>
      </text>
    </box>
  )
}

// Fleet CollapsedRow: muted label left, caller-supplied value right. Used
// for the collapsed sidebar view; the Antigravity adapter renders one
// CollapsedRow per visible account (Claude's sibling collapses to a
// single primary-quota line, but Antigravity's multi-quota model fits a
// per-account row better when the sidebar is collapsed).
function CollapsedRow(props: {
  theme: () => Theme
  label: string
  children: JSX.Element
}): JSX.Element {
  return (
    <box width='100%' flexDirection='row' justifyContent='space-between'>
      <text fg={props.theme().textMuted}>{props.label}</text>
      {props.children}
    </box>
  )
}

// Fleet QuotaRow, adapted to Antigravity's `remainingPercent + resetAt`
// shape. The left group stacks label + bar + pct in fixed columns so
// bars line up across rows; the right group carries the reset countdown
// when the plugin has cached a reset time. Tone is read off the
// remaining percentage via the antigravity threshold rules — the fleet's
// `usageTone` would invert the polarity (healthy = high remaining vs
// healthy = low used), so we keep the antigravity-local `quotaTone`.
function QuotaRow(props: {
  theme: () => Theme
  appearance: AppearancePrefs
  label: string
  entry: SidebarQuotaEntry | undefined
  now: () => number
}): JSX.Element {
  const used = () =>
    props.entry ? 100 - clamp(props.entry.remainingPercent, 0, 100) : null
  const reset = () =>
    props.entry ? formatResetIn(props.entry.resetAt, props.now) : ''
  return (
    <Show
      when={used() != null}
      fallback={
        <box width='100%' flexDirection='row' justifyContent='space-between'>
          <text fg={props.theme().textMuted}>{props.label.padEnd(3)}</text>
          <text fg={props.theme().textMuted}>{'\u2014'}</text>
        </box>
      }
    >
      <box width='100%' flexDirection='row' justifyContent='space-between'>
        <box flexDirection='row'>
          <text width={3} flexShrink={0} fg={props.theme().textMuted}>
            {props.label}
          </text>
          <box
            width={props.appearance.barWidth}
            flexShrink={0}
            flexDirection='row'
          >
            <For each={quotaBarSegments(used() ?? 0, props.appearance)}>
              {(segment) => (
                <text fg={toneColor(props.theme(), segment.tone)}>
                  {segment.text}
                </text>
              )}
            </For>
          </box>
          <text
            fg={toneColor(
              props.theme(),
              quotaTone(used() ?? 0, props.appearance),
            )}
          >
            {` ${String(Math.round(used() ?? 0)).padStart(3)}%`}
          </text>
        </box>
        <Show when={reset()}>
          <text fg={props.theme().textMuted}>{reset()}</text>
        </Show>
      </box>
    </Show>
  )
}

// Fleet AccountBlock, adapted to Antigravity's per-account data. Header
// row is account label (left) + status word (right). The body renders one
// QuotaRow per present quota group in the fleet's stable order, then a
// muted secondary line with the account's health score and, when
// relevant, a cooldown countdown. Status word priorities (first match
// wins):
//   - `off` when the account is disabled
//   - `cooling` when cooldownUntil is still in the future
//   - `active` when current === true
//   - `idle` for the fallback (current === false) case
function AccountBlock(props: {
  theme: () => Theme
  appearance: AppearancePrefs
  account: SidebarAccountState
  now: () => number
  active?: boolean
  marginTop?: number
}): JSX.Element {
  const active = () => props.active ?? props.account.current
  const statusWord = (): string => {
    if (!props.account.enabled) return 'off'
    const cd = props.account.cooldownUntil
    if (typeof cd === 'number' && cd > props.now()) return 'cooling'
    return active() ? 'active' : 'idle'
  }
  const statusTone = (): Tone => {
    if (!props.account.enabled) return 'muted'
    const cd = props.account.cooldownUntil
    if (typeof cd === 'number' && cd > props.now()) return 'warn'
    return active() ? 'ok' : 'muted'
  }
  const cooldownMs = (): number => {
    const cd = props.account.cooldownUntil
    if (typeof cd !== 'number') return 0
    return Math.max(0, cd - props.now())
  }
  const healthText = () => {
    const base = `health ${Math.round(clamp(props.account.health, 0, 100))}`
    return cooldownMs() > 0
      ? `${base} · cooling ${formatWait(cooldownMs())}`
      : base
  }
  return (
    <box width='100%' flexDirection='column' marginTop={props.marginTop ?? 0}>
      <box width='100%' flexDirection='row' justifyContent='space-between'>
        <text fg={props.theme().text}>
          <b>{props.account.label}</b>
        </text>
        <text fg={toneColor(props.theme(), statusTone())}>
          <b>{statusWord()}</b>
        </text>
      </box>
      <For each={QUOTA_ORDER}>
        {(key) => (
          <QuotaRow
            theme={props.theme}
            appearance={props.appearance}
            label={QUOTA_LABELS[key]}
            entry={props.account.quota[key]}
            now={props.now}
          />
        )}
      </For>
      <box width='100%' flexDirection='row'>
        <text fg={props.theme().textMuted}>{`   ${healthText()}`}</text>
      </box>
    </box>
  )
}

function formatWait(ms: number): string {
  const seconds = Math.ceil(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remaining = seconds % 60
  return remaining > 0 ? `${minutes}m ${remaining}s` : `${minutes}m`
}

export function resolveQuotaDialogActiveId(
  state: SidebarStateV1,
  sessionId: string | undefined,
): string | undefined {
  return (
    (sessionId ? state.activeRouting[sessionId]?.accountId : undefined) ??
    state.accounts.find((account) => account.current)?.id
  )
}

export function QuotaDialogContent(props: {
  api: TuiPluginApi
  controller: SidebarController
  sessionId: string | undefined
}): JSX.Element {
  const prefs = props.controller.prefs
  const [state, setState] = createSignal<SidebarStateV1>(EMPTY_STATE)
  const refresh = (): void => {
    setState(readSidebarState())
  }
  createEffect(() => {
    const timer = setInterval(refresh, prefs().pollMs)
    onCleanup(() => clearInterval(timer))
  })
  setTimeout(refresh, 0)

  const theme = (): Theme => props.api.theme.current
  const visibleAccounts = () => {
    if (prefs().sections.fallbackAccounts) return state().accounts
    return state().accounts.filter((account) => account.current)
  }
  const activeId = () => resolveQuotaDialogActiveId(state(), props.sessionId)

  return (
    <box flexDirection='column' padding={2} width='100%' alignItems='center'>
      <box flexDirection='column' width={58}>
        <box width='100%' justifyContent='center' marginBottom={1}>
          <text fg={theme().text}>
            <b>Antigravity Quota</b>
          </text>
        </box>
        <For each={visibleAccounts()}>
          {(account, index) => (
            <AccountBlock
              theme={theme}
              appearance={prefs().appearance}
              account={account}
              active={activeId() === account.id}
              now={() => Date.now()}
              marginTop={index() === 0 ? 0 : 1}
            />
          )}
        </For>
      </box>
    </box>
  )
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

  const hasData = () => state().loaded.accounts.length > 0
  const backoffActive = () => {
    const until = state().loaded.quotaBackoffUntil
    return typeof until === 'number' && until > now()
  }
  const lastError = () => state().lastError ?? state().loaded.lastError
  const degraded = () => backoffActive() || !!lastError()
  // Honors sections.fallbackAccounts. Both the expanded (AccountBlock list)
  // and the collapsed (CollapsedRow list) paths use the same filter so the
  // user sees the same account set in either mode.
  const visibleAccounts = () => {
    const showFallback = prefs().sections.fallbackAccounts
    if (showFallback) return state().loaded.accounts
    return state().loaded.accounts.filter((account) => account.current)
  }

  const currentRoute = (): {
    strategy?: 'sticky' | 'round-robin' | 'hybrid'
    family: string
    style: string
  } | null => {
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

  // Header badge: ▼/▶ {label}. The fleet shows the version string on the
  // right when no degraded state is present; the antigravity adapter keeps
  // that right-alignment and surfaces `degraded` as a "LIMITED" badge
  // instead of the "1/1 ready" count the previous revision rendered.
  const headerLabel = () => {
    const name = prefs().header.label
    return !hasData() ? name : collapsed() ? `\u25b6 ${name}` : `\u25bc ${name}`
  }

  return (
    <box
      width='100%'
      flexDirection='column'
      border={true}
      borderColor={theme().borderActive}
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={1}
      paddingRight={1}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: opentui renders to a terminal, not the DOM — ARIA roles do not apply */}
      <box
        width='100%'
        flexDirection='row'
        justifyContent='space-between'
        alignItems='center'
        onMouseDown={() => {
          // Mirror the fleet guard: only toggle when there is data to expand
          // into. Without this a click on the empty-awaiting header would just
          // toggle the affordance for nothing.
          if (hasData()) controller.toggleCollapsed()
        }}
      >
        <box paddingLeft={1} paddingRight={1} backgroundColor={theme().accent}>
          <text fg={theme().background}>
            <b>{headerLabel()}</b>
          </text>
        </box>
        <Show
          when={degraded()}
          fallback={
            <Show when={prefs().header.showVersion && PLUGIN_VERSION !== ''}>
              <text fg={theme().textMuted}>{`v${PLUGIN_VERSION}`}</text>
            </Show>
          }
        >
          <box
            paddingLeft={1}
            paddingRight={1}
            backgroundColor={theme().warning}
          >
            <text fg={theme().background}>
              <b>{'LIMITED'}</b>
            </text>
          </box>
        </Show>
      </box>

      {/* Collapsed: the active account's primary quota and fleet status dot. */}
      <Show when={collapsed() && hasData()}>
        {(() => {
          const account = () =>
            visibleAccounts().find((entry) => entry.current) ??
            visibleAccounts()[0]
          const used = () => {
            const entry = account()?.quota.claude
            return entry ? 100 - clamp(entry.remainingPercent, 0, 100) : null
          }
          const unavailable = () => {
            const selected = account()
            return (
              selected != null &&
              (!selected.enabled ||
                (selected.cooldownUntil != null &&
                  selected.cooldownUntil > now()))
            )
          }
          return (
            <Show when={account()}>
              {(selected) => (
                <CollapsedRow theme={theme} label={selected().label}>
                  <box flexDirection='row'>
                    <text
                      fg={toneColor(
                        theme(),
                        used() == null
                          ? 'muted'
                          : quotaTone(used() ?? 0, prefs().appearance),
                      )}
                    >
                      <b>
                        {used() == null
                          ? '—'
                          : `Cl: ${Math.round(used() ?? 0)}%`}
                      </b>
                    </text>
                    <text
                      fg={toneColor(
                        theme(),
                        unavailable()
                          ? 'err'
                          : quotaTone(used() ?? 0, prefs().appearance),
                      )}
                    >
                      {unavailable() ? ' ⊘' : ' ●'}
                    </text>
                  </box>
                </CollapsedRow>
              )}
            </Show>
          )
        })()}
      </Show>

      {/* Expanded: full sections. Also render when there's no data so the
          sidebar can never go blank if data clears while collapsed. */}
      <Show when={!collapsed() || !hasData()}>
        <Show
          when={hasData()}
          fallback={
            <box marginTop={1} width='100%'>
              <text fg={theme().textMuted}>{'Waiting for quota\u2026'}</text>
            </box>
          }
        >
          {/* Quota */}
          <Show when={prefs().sections.quota}>
            <SectionHeader theme={theme} title='Quota' />
            <For each={visibleAccounts()}>
              {(account, index) => (
                <AccountBlock
                  theme={theme}
                  appearance={prefs().appearance}
                  account={account}
                  now={now}
                  marginTop={index() === 0 ? 0 : 1}
                />
              )}
            </For>
          </Show>

          {/* Routing */}
          <Show when={prefs().sections.routing}>
            <SectionHeader theme={theme} title='Routing' />
            <Show
              when={currentRoute()}
              fallback={
                <StatRow theme={theme} label='Route' value='—' tone='muted' />
              }
            >
              {(route) => (
                <StatRow
                  theme={theme}
                  label='Route'
                  value={`${route().strategy ? `${route().strategy} · ` : ''}${route().family}: ${route().style}`}
                  tone='accent'
                />
              )}
            </Show>
          </Show>

          {/* Health — only when something is wrong AND sections.health is true */}
          <Show when={degraded() && prefs().sections.health}>
            <SectionHeader theme={theme} title='Health' />
            <Show when={backoffActive()}>
              <StatRow
                theme={theme}
                label='Quota API'
                value={`backoff ${formatResetIn(state().loaded.quotaBackoffUntil, now)}`}
                tone='warn'
              />
            </Show>
            <Show when={lastError()}>
              <StatRow
                theme={theme}
                label='Last error'
                value={lastError() ?? ''}
                tone='err'
              />
            </Show>
          </Show>
        </Show>
      </Show>
    </box>
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
  ) => Promise<RpcNotification[]>
  currentSessionId: () => string | undefined
  dispatch: (notification: RpcNotification) => void | Promise<void>
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
      const notifications = await options.pending(lastNotificationId, sessionId)
      for (const notification of [...notifications].sort(
        (a, b) => a.id - b.id,
      )) {
        if (notification.id <= lastNotificationId) continue
        lastNotificationId = Math.max(lastNotificationId, notification.id)
        await options.dispatch(notification)
      }
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
  const rpcClient = createRpcClient(
    getRpcDir(api.state.path.directory ?? ''),
    process.pid,
  )

  startRpcNotificationPolling({
    pending: (lastReceivedId, sessionId) =>
      rpcClient.pendingNotifications(lastReceivedId, sessionId),
    currentSessionId: () => {
      const current = (api.route as { current?: unknown }).current
      const resolved =
        typeof current === 'function' ? (current as () => unknown)() : current
      return (resolved as { params?: { sessionID?: string } } | undefined)
        ?.params?.sessionID
    },
    dispatch: async (notification) => {
      logger.debug('rpc-notification-received', {
        command: notification.payload.command,
        id: notification.id,
        sessionId: notification.sessionId,
      })
      // Call the imperative dispatcher directly — the prior
      // two-phase `collectDialogFlow` + `renderDialogFlow` is gone.
      // The dispatcher awaits `apply`, toasts the result, then clears
      // (or replaces for multi-step flows). The RPC `apply` accepts the
      // optional `timeoutMs` knob so account add / refresh can opt into
      // the 120s RPC timeout without the dialog layer having to know
      // about it.
      if (notification.payload.command === 'antigravity-quota') {
        api.ui.dialog.setSize('xlarge')
        api.ui.dialog.replace(() => (
          <QuotaDialogContent
            api={api}
            controller={getSidebarController()}
            sessionId={notification.sessionId}
          />
        ))
        return
      }
      openCommandDialog(api, notification.payload, (command, args, options) =>
        rpcClient.apply(
          { command, arguments: args, sessionId: notification.sessionId },
          options,
        ),
      )
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
