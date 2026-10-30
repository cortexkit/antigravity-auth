/** @jsxImportSource @opentui/solid */

/**
 * The Antigravity sidebar frame, shared by the OpenCode 1 sidebar (`tui.tsx`)
 * and the OpenCode 2 sidebar (`ga/tui/host-ga.tsx`): the padded
 * panel, the clickable `▼`/`▶` header badge with the optional plugin version
 * at the right, one line per account when collapsed, and the
 * `Quota`, `Routing` and `Health` sections when expanded.
 *
 * Each renderer reads its own data source (the sidebar file, or the
 * location's `state` answer), maps its own host theme onto `FrameTheme` and
 * owns its own collapse state; everything drawn is decided here, so a change
 * of shape is made once for both hosts.
 *
 * This module stays inside both TUI import graphs: besides Solid and
 * OpenTUI it imports only the pure quota and sidebar-projection helpers and
 * the shared layouts. No sidebar file, preferences file, RPC, account
 * store, OAuth, token or host SDK module, no Node built-in, and nothing
 * that writes to the terminal.
 */

import type { RGBA } from '@opentui/core'
import { createMemo, createSignal, For, type JSX, Show } from 'solid-js'

import {
  formatQuota,
  isQuotaStale,
  type ProjectedLimit,
  type ProjectedQuota,
} from '../common-auth-embedded/quota/index.js'
import { formatResetIn, formatWait } from '../sidebar-projection'
import {
  ASSUMED_CONTENT_WIDTH,
  accountWindows,
  DEFAULT_QUOTA_APPEARANCE,
  fitLabel,
  GROUP_NAMES,
  QUOTA_ORDER,
  QuotaAccountBlock,
  type QuotaAppearance,
  type QuotaLayoutAccount,
  type QuotaPalette,
  type QuotaTone,
  quotaTone,
} from './quota-layout'
import { routeLineFits } from './route-layout'

type Tone = QuotaTone

// --- Theme -----------------------------------------------------------------

/** A theme color; `undefined` leaves the host's default color in place. */
export type FrameColor = string | RGBA | undefined

/**
 * The theme tokens the frame draws with, named after OpenCode 1's flat theme.
 * OpenCode 1 passes its live theme as is; OpenCode 2 maps its semantic tokens
 * onto these names. A token may be missing: every use falls back to a
 * sibling token or to the host's default color, never to a fixed color.
 */
export interface FrameTheme {
  readonly text: FrameColor
  readonly textMuted: FrameColor
  readonly accent: FrameColor
  readonly background: FrameColor
  readonly success: FrameColor
  readonly warning: FrameColor
  readonly error: FrameColor
}

// Every tone falls through to a sibling token, so a sparse custom theme still
// renders readably.
export function toneColor(theme: FrameTheme, tone: Tone): FrameColor {
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

// The shared quota layout reads its colors through this palette. Muted text
// and the account label read `textMuted` and `text` straight from the theme,
// without the `toneColor` fallback chain.
export function themePalette(theme: () => FrameTheme): QuotaPalette {
  return {
    text: () => theme().text,
    muted: () => theme().textMuted,
    tone: (tone) => toneColor(theme(), tone),
  }
}

// --- Frame inputs ----------------------------------------------------------

/** The account fields the frame reads: the quota layout's plus the state. */
export interface FrameAccount extends QuotaLayoutAccount {
  readonly enabled: boolean
  readonly current: boolean
  readonly cooldownUntil?: number
}

/** The route of the session the sidebar belongs to. */
export interface FrameRoute {
  readonly strategy?: string
  readonly family: string
  readonly style: string
}

/**
 * The settings the frame reads. OpenCode 1 passes its preferences; OpenCode 2
 * has no preferences file and passes the same defaults.
 */
export interface FrameSettings {
  readonly header: { readonly label: string; readonly showVersion: boolean }
  readonly sections: {
    readonly quota: boolean
    readonly fallbackAccounts: boolean
    readonly routing: boolean
    readonly health: boolean
  }
  readonly appearance: QuotaAppearance
}

/**
 * The OpenCode 1 preference defaults for the frame, for a renderer that has
 * no preferences file. A test keeps it equal to the matching part of
 * `DEFAULT_PREFS`.
 */
export const DEFAULT_FRAME_SETTINGS: FrameSettings = {
  header: { label: 'ANTIGRAVITY', showVersion: true },
  sections: {
    quota: true,
    fallbackAccounts: true,
    routing: true,
    health: true,
  },
  appearance: DEFAULT_QUOTA_APPEARANCE,
}

// --- Rows ------------------------------------------------------------------

// Section header: bold title, themed text color, top margin for vertical
// breathing room between sections.
export function SectionHeader(props: {
  theme: () => FrameTheme
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

// Muted label left, value (optionally tone-tinted, bold) right, for the
// routing and health rows.
export function StatRow(props: {
  theme: () => FrameTheme
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

// Muted label left, caller-supplied value right. The collapsed view renders
// one row for every visible account. The caller sizes both sides to the
// measured width, so neither side may wrap.
function CollapsedRow(props: {
  theme: () => FrameTheme
  label: string
  children: JSX.Element
}): JSX.Element {
  return (
    <box width='100%' flexDirection='row' justifyContent='space-between'>
      <text flexShrink={0} wrapMode='none' fg={props.theme().textMuted}>
        {props.label}
      </text>
      {props.children}
    </box>
  )
}

// One account in the Quota section: the shared quota block, with the status
// word computed from the account state. Status word priorities (first match
// wins):
//   - `off` when the account is disabled
//   - `cooling <wait>` when cooldownUntil is still in the future
//   - `active` when current === true
//   - `idle` for the fallback (current === false) case
function AccountBlock(props: {
  theme: () => FrameTheme
  appearance: QuotaAppearance
  account: FrameAccount
  now: () => number
  width: () => number
  marginTop?: number
}): JSX.Element {
  const cooldownMs = (): number => {
    const cd = props.account.cooldownUntil
    if (typeof cd !== 'number') return 0
    return Math.max(0, cd - props.now())
  }
  const statusWord = (): string => {
    if (!props.account.enabled) return 'off'
    if (cooldownMs() > 0) return `cooling ${formatWait(cooldownMs())}`
    return props.account.current ? 'active' : 'idle'
  }
  const statusTone = (): Tone => {
    if (!props.account.enabled) return 'muted'
    if (cooldownMs() > 0) return 'warn'
    return props.account.current ? 'ok' : 'muted'
  }
  return (
    <QuotaAccountBlock
      palette={themePalette(props.theme)}
      appearance={props.appearance}
      account={props.account}
      status={statusWord()}
      statusTone={statusTone()}
      now={props.now}
      width={props.width}
      marginTop={props.marginTop}
    />
  )
}

// Stored quota values are percentages and epoch-millisecond reset times.
// Adapt them to the shared projection so common-auth, not the renderer,
// decides how the narrow line reads.
export function sidebarQuotaProjection(
  account: QuotaLayoutAccount,
  now: number,
): ProjectedQuota | undefined {
  const limits: ProjectedLimit[] = []
  for (const { key, reading } of accountWindows(account, now)) {
    const { checkedAt, remainingPercent, resetAt, window } = reading
    if (
      typeof checkedAt !== 'number' ||
      !Number.isFinite(checkedAt) ||
      checkedAt < 0 ||
      !Number.isFinite(remainingPercent)
    )
      continue
    const resetsAt =
      typeof resetAt === 'number' &&
      Number.isFinite(resetAt) &&
      Math.abs(resetAt) <= 8.64e15
        ? new Date(resetAt).toISOString()
        : undefined
    limits.push({
      scope: key,
      label: GROUP_NAMES[key],
      kind: 'reading',
      checkedAt,
      remainingPercent: Math.max(0, Math.min(100, remainingPercent)),
      ...(window
        ? { windowMinutes: window === 'weekly' ? 7 * 24 * 60 : 5 * 60 }
        : {}),
      ...(resetsAt ? { resetsAt } : {}),
    })
  }
  if (limits.length === 0) return undefined
  return {
    scope: 'all',
    limits,
    checkedAt: Math.min(...limits.map((limit) => limit.checkedAt)),
    groups: QUOTA_ORDER.map((scope) => ({
      scope,
      label: GROUP_NAMES[scope],
    })),
  }
}

// One account on one measured, non-wrapping line: the label, the shared
// narrow quota text and a status dot (`⊘` while the account is off or
// cooling). The quota text is shown whole or not at all; the label is cut
// with `…` to make room.
function CollapsedAccount(props: {
  theme: () => FrameTheme
  appearance: () => QuotaAppearance
  account: FrameAccount
  now: () => number
  width: () => number
}): JSX.Element {
  const account = props.account
  const now = props.now
  const theme = props.theme
  const unavailable = () =>
    !account.enabled ||
    (account.cooldownUntil != null && account.cooldownUntil > now())
  const line = createMemo(() => {
    const currentTime = now()
    const projection = sidebarQuotaProjection(account, currentTime)
    const text = formatQuota(projection, {
      now: currentTime,
      form: 'narrow',
    })
    const remaining = projection?.limits.length
      ? Math.min(
          ...projection.limits.map((limit) => limit.remainingPercent ?? 100),
        )
      : undefined
    const tone =
      remaining === undefined
        ? 'muted'
        : quotaTone(100 - remaining, props.appearance())
    const stale = isQuotaStale(projection, { now: currentTime })
    const dot = unavailable() ? ' ⊘' : ' ●'
    const width = props.width()
    // Keep a complete shared line or omit it; a partial quota can make an
    // account look as if it has less remaining.
    const showQuota = text.length <= width
    const showDot =
      dot.length <= width && (!showQuota || text.length + dot.length <= width)
    const rightWidth =
      (showQuota ? text.length : 0) + (showDot ? dot.length : 0)
    const labelWidth = Math.max(0, width - rightWidth - 1)
    return {
      dot,
      label: fitLabel(account.label, labelWidth),
      showDot,
      showQuota,
      stale,
      text,
      tone,
    }
  })
  const quotaColor = () =>
    line().stale ? theme().textMuted : toneColor(theme(), line().tone)
  const dotColor = () =>
    line().stale
      ? theme().textMuted
      : toneColor(theme(), unavailable() ? 'err' : line().tone)
  return (
    <CollapsedRow theme={theme} label={line().label}>
      <box flexDirection='row' flexShrink={0}>
        <Show when={line().showQuota}>
          <text flexShrink={0} wrapMode='none' fg={quotaColor()}>
            <b>{line().text}</b>
          </text>
        </Show>
        <Show when={line().showDot}>
          <text flexShrink={0} wrapMode='none' fg={dotColor()}>
            {line().dot}
          </text>
        </Show>
      </box>
    </CollapsedRow>
  )
}

// --- Frame -----------------------------------------------------------------

export interface SidebarFrameProps {
  readonly theme: () => FrameTheme
  readonly settings: () => FrameSettings
  /** The plugin version shown at the right of the header; empty hides it. */
  readonly version: string
  readonly collapsed: () => boolean
  /** Called on a header click while there is data to collapse or expand. */
  readonly onToggleCollapsed: () => void
  readonly accounts: () => readonly FrameAccount[]
  /** The route of this sidebar's session, or `null` when it has none yet. */
  readonly route: () => FrameRoute | null
  /** Epoch ms until which quota checks are paused, when they are. */
  readonly quotaBackoffUntil: () => number | undefined
  readonly lastError: () => string | null | undefined
  readonly now: () => number
}

export function SidebarFrame(props: SidebarFrameProps): JSX.Element {
  const theme = props.theme
  const prefs = props.settings
  const collapsed = props.collapsed
  const now = props.now

  const hasData = () => props.accounts().length > 0
  const backoffActive = () => {
    const until = props.quotaBackoffUntil()
    return typeof until === 'number' && until > now()
  }
  const lastError = () => props.lastError()
  const degraded = () => backoffActive() || !!lastError()
  // Honors sections.fallbackAccounts. Both the expanded (AccountBlock list)
  // and the collapsed (CollapsedAccount list) paths use the same filter so
  // the user sees the same account set in either mode.
  const visibleAccounts = () => {
    const showFallback = prefs().sections.fallbackAccounts
    if (showFallback) return props.accounts()
    return props.accounts().filter((account) => account.current)
  }

  // The route on one `Route <value>` line when it fits, else one line per
  // part with the strategy last.
  const routeValue = (route: FrameRoute): string =>
    `${route.strategy ? `${route.strategy} · ` : ''}${route.family}: ${route.style}`
  const routeLines = (route: FrameRoute): string[] =>
    [`${route.family}: ${route.style}`, route.strategy ?? ''].filter(
      (line) => line !== '',
    )

  // The width available to content: the header row spans the panel inside
  // its padding. Layout reports it during a render pass, so the
  // signal is updated afterwards rather than rebuilding rows mid-pass.
  const [contentWidth, setContentWidth] = createSignal(ASSUMED_CONTENT_WIDTH)
  let headerRow: { width: number } | undefined
  const measureContentWidth = (): void => {
    const width = headerRow?.width
    if (typeof width !== 'number' || width <= 0) return
    queueMicrotask(() => {
      if (width !== contentWidth()) setContentWidth(width)
    })
  }

  // Header badge: ▼/▶ {label}, with the optional version at the right.
  const headerLabel = () => {
    const name = prefs().header.label
    return !hasData() ? name : collapsed() ? `\u25b6 ${name}` : `\u25bc ${name}`
  }

  return (
    <box
      width='100%'
      flexDirection='column'
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={1}
      paddingRight={1}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: opentui renders to a terminal, not the DOM — ARIA roles do not apply */}
      <box
        ref={(element) => {
          headerRow = element
        }}
        onSizeChange={measureContentWidth}
        width='100%'
        flexDirection='row'
        justifyContent='space-between'
        alignItems='center'
        onMouseDown={() => {
          // Only toggle when there is data to expand into. Without this a
          // click on the empty-awaiting header would just toggle the
          // affordance for nothing.
          if (hasData()) props.onToggleCollapsed()
        }}
      >
        <box paddingLeft={1} paddingRight={1} backgroundColor={theme().accent}>
          <text fg={theme().background}>
            <b>{headerLabel()}</b>
          </text>
        </box>
        <Show when={prefs().header.showVersion && props.version !== ''}>
          <text fg={theme().textMuted}>{`v${props.version}`}</text>
        </Show>
      </box>

      {/* Collapsed: one measured, non-wrapping row for each visible account. */}
      <Show when={collapsed() && hasData()}>
        <For each={visibleAccounts()}>
          {(account) => (
            <CollapsedAccount
              theme={theme}
              appearance={() => prefs().appearance}
              account={account}
              now={now}
              width={contentWidth}
            />
          )}
        </For>
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
                  width={contentWidth}
                  marginTop={index() === 0 ? 0 : 1}
                />
              )}
            </For>
          </Show>

          {/* Routing: the session's route, or one dim line before its first request. */}
          <Show when={prefs().sections.routing}>
            <SectionHeader theme={theme} title='Routing' />
            <Show
              when={props.route()}
              fallback={
                <text wrapMode='none' fg={theme().textMuted}>
                  {'No request yet'}
                </text>
              }
            >
              {(route) => (
                <Show
                  when={routeLineFits(
                    'Route',
                    routeValue(route()),
                    contentWidth(),
                  )}
                  fallback={
                    <For each={routeLines(route())}>
                      {(line) => (
                        <text wrapMode='none' fg={toneColor(theme(), 'accent')}>
                          <b>{line}</b>
                        </text>
                      )}
                    </For>
                  }
                >
                  <StatRow
                    theme={theme}
                    label='Route'
                    value={routeValue(route())}
                    tone='accent'
                  />
                </Show>
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
                value={`backoff ${formatResetIn(props.quotaBackoffUntil(), now())}`}
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
