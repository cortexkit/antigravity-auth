/** @jsxImportSource @opentui/solid */

/** Plugin-owned projection and Routing/Health sections for the shared quota frame. */

import type { RGBA } from '@opentui/core'
import { createMemo, createSignal, For, type JSX, Show } from 'solid-js'

import {
  isQuotaStale,
  NO_QUOTA_READING,
  type ProjectedLimit,
  type ProjectedQuota,
} from '../common-auth-embedded/quota/index.js'
import {
  type AccountView,
  SidebarFrame,
  SidebarSection,
  SidebarTextRow,
  type SidebarTheme,
  type Tone,
} from '../common-auth-embedded/quota-sidebar/index'
import { formatResetIn, formatWait } from '../sidebar-projection'
import {
  accountWindows,
  DEFAULT_QUOTA_APPEARANCE,
  GROUP_NAMES,
  QUOTA_ORDER,
  type QuotaAppearance,
  type QuotaLayoutAccount,
  quotaTone,
} from './quota-layout'
import { routeLineFits } from './route-layout'

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

// --- Frame inputs ----------------------------------------------------------

/** The account fields the frame reads: the quota layout's plus the state. */
export interface FrameAccount extends QuotaLayoutAccount {
  readonly id: string
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

/** Preserve provider status and projection policy; the library owns all quota layout. */
function accountView(
  account: FrameAccount,
  now: number,
  appearance: QuotaAppearance,
): AccountView {
  const cooldown = Math.max(0, (account.cooldownUntil ?? 0) - now)
  const status: AccountView['status'] = !account.enabled
    ? { text: 'off', tone: 'textMuted' }
    : cooldown > 0
      ? { text: `cooling ${formatWait(cooldown)}`, tone: 'warning' }
      : account.current
        ? { text: 'active', tone: 'success' }
        : { text: 'idle', tone: 'textMuted' }
  const quota = sidebarQuotaProjection(account, now)
  const stale = isQuotaStale(quota, { now })
  const remaining = quota?.limits.length
    ? Math.min(...quota.limits.map((limit) => limit.remainingPercent ?? 100))
    : undefined
  const quotaColor =
    remaining === undefined
      ? 'textMuted'
      : quotaTone(100 - remaining, appearance)
  const blocked = !account.enabled || cooldown > 0
  const windows = accountWindows(account, now).filter(
    ({ reading, text }) =>
      typeof reading.checkedAt === 'number' &&
      Number.isFinite(reading.checkedAt) &&
      reading.checkedAt >= 0 &&
      text.remaining !== null,
  )
  return {
    id: account.id,
    label: account.label,
    status,
    blocked,
    indicatorTone: stale ? 'textMuted' : blocked ? 'error' : quotaColor,
    quota,
    collapsed: {
      quotaTone: quotaColor,
      muted: stale || status.text !== 'active',
    },
    emptyQuotaText: { expanded: NO_QUOTA_READING, collapsed: NO_QUOTA_READING },
    groups: QUOTA_ORDER.flatMap((key) => {
      const rows = windows
        .filter((window) => window.key === key)
        .map(({ reading, text }) => ({
          part: {
            kind: 'window' as const,
            name: text.name,
            short: text.name,
            figure: text.figure,
            remainingPercent: text.remaining ?? undefined,
            resetIn: text.reset || undefined,
            checkedAt: reading.checkedAt ?? now,
            resetSinceReading: text.resetSinceReading,
          },
        }))
      return rows.length ? [{ title: GROUP_NAMES[key], rows }] : []
    }),
  }
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

function StatRow(props: {
  theme: () => SidebarTheme
  label: string
  value: string
  tone?: Tone
}): JSX.Element {
  return (
    <box width='100%' flexDirection='row' justifyContent='space-between'>
      <text fg={props.theme().textMuted}>{props.label}</text>
      <text fg={props.theme()[props.tone ?? 'text']}>
        <b>{props.value}</b>
      </text>
    </box>
  )
}

export function AntigravitySidebar(props: SidebarFrameProps): JSX.Element {
  const prefs = props.settings
  const now = props.now
  const hasData = () => props.accounts().length > 0
  const backoffActive = () => {
    const until = props.quotaBackoffUntil()
    return typeof until === 'number' && until > now()
  }
  const visibleAccounts = createMemo(() =>
    props
      .accounts()
      .filter((account) => prefs().sections.fallbackAccounts || account.current)
      .map((account) => accountView(account, now(), prefs().appearance)),
  )
  const theme = (): SidebarTheme => {
    const source = props.theme()
    return {
      ...source,
      textMuted: source.textMuted ?? source.text,
      accent: source.accent ?? source.text,
      success: source.success ?? source.accent ?? source.text,
      warning: source.warning ?? source.accent ?? source.text,
      error: source.error ?? source.accent ?? source.text,
    }
  }

  // Routing keeps whole parts on separate lines when the single stat row is too wide.
  const [contentWidth, setContentWidth] = createSignal(28)
  let sections: { width: number } | undefined
  const measureContentWidth = () => {
    const width = sections?.width
    if (width && width !== contentWidth())
      queueMicrotask(() => setContentWidth(width))
  }
  const routeValue = (route: FrameRoute): string =>
    `${route.strategy ? `${route.strategy} · ` : ''}${route.family}: ${route.style}`
  const routeLines = (route: FrameRoute): string[] =>
    [`${route.family}: ${route.style}`, route.strategy ?? ''].filter(Boolean)

  return (
    <SidebarFrame
      header={{
        badge: prefs().header.label,
        version:
          prefs().header.showVersion && props.version
            ? `v${props.version}`
            : undefined,
      }}
      theme={theme()}
      appearance={prefs().appearance}
      accounts={visibleAccounts()}
      showQuota={prefs().sections.quota}
      now={now()}
      collapsed={props.collapsed()}
      onToggle={props.onToggleCollapsed}
      sections={() => (
        <Show when={!props.collapsed() || !hasData()}>
          <box
            width='100%'
            flexDirection='column'
            ref={(element) => {
              sections = element
            }}
            onSizeChange={measureContentWidth}
          >
            <Show
              when={hasData()}
              fallback={
                <box marginTop={1} width='100%'>
                  <SidebarTextRow text='Waiting for quota…' wrapMode='none' />
                </box>
              }
            >
              <Show
                when={prefs().sections.quota && visibleAccounts().length === 0}
              >
                <SidebarSection title='Quota' />
              </Show>
              <Show when={prefs().sections.routing}>
                <SidebarSection title='Routing'>
                  <Show
                    when={props.route()}
                    fallback={
                      <SidebarTextRow text='No request yet' wrapMode='none' />
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
                              <text fg={theme().accent} wrapMode='none'>
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
                </SidebarSection>
              </Show>
              <Show
                when={
                  (backoffActive() || !!props.lastError()) &&
                  prefs().sections.health
                }
              >
                <SidebarSection title='Health'>
                  <Show when={backoffActive()}>
                    <StatRow
                      theme={theme}
                      label='Quota API'
                      value={`backoff ${formatResetIn(props.quotaBackoffUntil(), now())}`}
                      tone='warning'
                    />
                  </Show>
                  <Show when={props.lastError()}>
                    <StatRow
                      theme={theme}
                      label='Last error'
                      value={props.lastError() ?? ''}
                      tone='error'
                    />
                  </Show>
                </SidebarSection>
              </Show>
            </Show>
          </box>
        </Show>
      )}
    />
  )
}
