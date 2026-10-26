/** @jsxImportSource @opentui/solid */

/**
 * Quota layout shared by the OpenCode 1 sidebar (`tui.tsx`) and the OpenCode 2
 * sidebar (`ga/tui/host-ga.tsx`): one account block with its header line, the
 * reading age once per account, plain-word group headers and one width-fitted
 * row per quota window.
 *
 * Each renderer supplies its own data source and colors. This module imports
 * only the pure quota presentation helpers, so it stays inside both TUI
 * import graphs: no sidebar file, preferences file, RPC, account store,
 * OAuth, token or host SDK module, and nothing that writes to the terminal.
 */

import type { RGBA } from '@opentui/core'
import { For, type JSX, Show } from 'solid-js'
import {
  NO_QUOTA_READING,
  type QuotaReading,
  type QuotaWindowText,
  quotaReadingAge,
  quotaWindowText,
} from '../quota-presentation'

export type QuotaTone = 'ok' | 'warn' | 'err' | 'muted' | 'accent' | 'text'

/** A text color; `undefined` leaves the host's default color in place. */
export type QuotaColor = string | RGBA | undefined

/**
 * How a renderer colors the quota layout. OpenCode 1 maps these onto its live
 * host theme; a renderer without a theme returns `undefined` everywhere.
 */
export interface QuotaPalette {
  readonly text: () => QuotaColor
  readonly muted: () => QuotaColor
  readonly tone: (tone: QuotaTone) => QuotaColor
}

/** The bar and threshold settings the layout reads. */
export interface QuotaAppearance {
  readonly barWidth: number
  readonly barFilledChar: string
  readonly barEmptyChar: string
  readonly warnThreshold: number
  readonly errorThreshold: number
}

/**
 * The OpenCode 1 preference defaults for the quota bar, for a renderer that
 * has no preferences file. A test keeps it equal to `DEFAULT_PREFS.appearance`.
 */
export const DEFAULT_QUOTA_APPEARANCE: QuotaAppearance = {
  barWidth: 10,
  barFilledChar: '█',
  barEmptyChar: '░',
  warnThreshold: 50,
  errorThreshold: 80,
}

export type QuotaGroupKey = 'gemini' | 'non-gemini' | 'gemini-argon'

export interface QuotaLayoutWindow {
  readonly window: 'weekly' | '5h'
  readonly remainingPercent: number
  readonly resetAt?: number
  readonly checkedAt?: number
}

export interface QuotaLayoutEntry {
  readonly remainingPercent: number
  readonly resetAt?: number
  readonly checkedAt?: number
  readonly windows?: readonly QuotaLayoutWindow[]
}

/** The account fields the quota layout reads, and nothing else. */
export interface QuotaLayoutAccount {
  readonly label: string
  readonly quota: {
    readonly gemini?: QuotaLayoutEntry
    readonly 'non-gemini'?: QuotaLayoutEntry
    /** Present only on accounts whose reading reports the Argon pool. */
    readonly 'gemini-argon'?: QuotaLayoutEntry
  }
}

// Group headers name each quota pool in plain words.
export const GROUP_NAMES: Record<QuotaGroupKey, string> = {
  gemini: 'Gemini',
  'non-gemini': 'Other models',
  'gemini-argon': 'Argon',
}

export const QUOTA_ORDER: readonly QuotaGroupKey[] = [
  'gemini',
  'non-gemini',
  'gemini-argon',
]

// Shown instead of a stored figure once the window has reset since it was
// read: the stored figure describes the window before the reset.
export const RESET_SINCE_READING = 'reset since last check'

// Content width used until the first layout pass reports the real one. It
// fits the narrowest OpenCode sidebar.
export const ASSUMED_CONTENT_WIDTH = 28

// A window row is `<name> <bar> <figure> <reset>`. The bar shrinks to this
// before the reset column is dropped; below it the bar is dropped too.
const MIN_BAR_WIDTH = 4
// The widest figure the formatter writes: `100% left`.
const FIGURE_WIDTH = 9
// A window name (`5h`, `7d`) and the space after it.
const NAME_WIDTH = 3

export function quotaTone(
  usedPct: number,
  appearance: QuotaAppearance,
): QuotaTone {
  if (usedPct < appearance.warnThreshold) return 'ok'
  if (usedPct < appearance.errorThreshold) return 'warn'
  return 'err'
}

interface BarSegment {
  text: string
  tone: QuotaTone
}

function quotaBarSegments(
  remainingPct: number,
  width: number,
  appearance: QuotaAppearance,
): BarSegment[] {
  const usedCells = Math.max(
    0,
    Math.min(Math.round((remainingPct / 100) * width), width),
  )
  const tone = quotaTone(100 - remainingPct, appearance)
  return [
    { text: appearance.barFilledChar.repeat(usedCells), tone },
    { text: appearance.barEmptyChar.repeat(width - usedCells), tone },
  ].filter((segment) => segment.text.length > 0)
}

// --- Width-fitted quota rows ------------------------------------------------
//
// The host sidebars are about 20 to 48 columns wide. Every quota line is
// sized from the measured content width so that it fits on one line: text is
// never left to the renderer's wrapping, which breaks a row mid-word or down
// to one character per line once the right-hand column runs out of room.

export interface AccountWindow {
  key: QuotaGroupKey
  reading: QuotaReading
  text: QuotaWindowText
}

// One entry per stored window, in group order. A pool stored before
// per-window readings existed contributes one window without a name.
export function accountWindows(
  account: QuotaLayoutAccount,
  now: number,
): AccountWindow[] {
  const result: AccountWindow[] = []
  for (const key of QUOTA_ORDER) {
    const entry = account.quota[key]
    if (!entry) continue
    const readings: QuotaReading[] =
      entry.windows && entry.windows.length > 0
        ? entry.windows.map((window) => ({
            window: window.window,
            remainingPercent: window.remainingPercent,
            resetAt: window.resetAt,
            checkedAt: window.checkedAt,
          }))
        : [
            {
              remainingPercent: entry.remainingPercent,
              resetAt: entry.resetAt,
              checkedAt: entry.checkedAt,
            },
          ]
    for (const reading of readings)
      result.push({ key, reading, text: quotaWindowText(reading, now) })
  }
  return result
}

// A window shows its figure only while no reset has happened since it was
// read and it has a read time at all.
export function showsFigure(window: AccountWindow): boolean {
  return window.text.remaining != null && !window.text.resetSinceReading
}

interface WindowRowLayout {
  bar: number
  reset: boolean
}

// Column widths for one `<name> <bar> <figure> <reset>` row within `width`
// cells. The bar shrinks first, down to MIN_BAR_WIDTH; then the reset column
// is dropped; when even that leaves less than MIN_BAR_WIDTH cells for the
// bar, the bar is left out and the row is just the name and figure.
function windowRowLayout(
  width: number,
  named: boolean,
  resetWidth: number,
  maxBar: number,
): WindowRowLayout {
  const room = width - (named ? NAME_WIDTH : 0) - FIGURE_WIDTH
  if (resetWidth > 0) {
    const bar = Math.min(maxBar, room - resetWidth - 2)
    if (bar >= MIN_BAR_WIDTH) return { bar, reset: true }
  }
  const bar = Math.min(maxBar, room - 1)
  return { bar: bar >= MIN_BAR_WIDTH ? bar : 0, reset: false }
}

// Shorten a label to `max` cells, marking the cut with an ellipsis.
export function fitLabel(label: string, max: number): string {
  if (label.length <= max) return label
  if (max <= 0) return ''
  if (max === 1) return '…'
  return `${label.slice(0, max - 1)}…`
}

// One quota window on one line. The bar fills with remaining quota; the
// figure and reset come from the shared formatter. A window that reset since
// its reading shows that fact, dim, in place of the stale figure.
function WindowRow(props: {
  palette: QuotaPalette
  appearance: QuotaAppearance
  window: AccountWindow
  layout: WindowRowLayout
}): JSX.Element {
  const text = () => props.window.text
  const tone = () => quotaTone(100 - (text().remaining ?? 0), props.appearance)
  return (
    <box width='100%' flexDirection='row'>
      <Show when={text().name !== ''}>
        <text
          width={NAME_WIDTH}
          flexShrink={0}
          wrapMode='none'
          fg={props.palette.muted()}
        >
          {text().name}
        </text>
      </Show>
      <Show
        when={showsFigure(props.window)}
        fallback={
          <text flexShrink={1} wrapMode='none' fg={props.palette.muted()}>
            {text().resetSinceReading ? RESET_SINCE_READING : text().figure}
          </text>
        }
      >
        <Show when={props.layout.bar > 0}>
          <box width={props.layout.bar + 1} flexShrink={0} flexDirection='row'>
            <For
              each={quotaBarSegments(
                text().remaining ?? 0,
                props.layout.bar,
                props.appearance,
              )}
            >
              {(segment) => (
                <text wrapMode='none' fg={props.palette.tone(segment.tone)}>
                  {segment.text}
                </text>
              )}
            </For>
          </box>
        </Show>
        <text flexShrink={0} wrapMode='none' fg={props.palette.tone(tone())}>
          {text().figure}
        </text>
        <box flexGrow={1} />
        <Show when={props.layout.reset && text().reset !== ''}>
          <text flexShrink={0} wrapMode='none' fg={props.palette.muted()}>
            {text().reset}
          </text>
        </Show>
      </Show>
    </box>
  )
}

/**
 * One account's quota block. The header line is the account label, the
 * reading age when the oldest reading is stale, and the caller's status word
 * right-aligned; the age moves to its own dim line when the three do not
 * fit. Below it each quota group present gets a plain-word header and one
 * row per window, or a single dim line when there is no reading at all.
 * `children` render after the quota rows (the OpenCode 2 health line).
 */
export function QuotaAccountBlock(props: {
  palette: QuotaPalette
  appearance: QuotaAppearance
  account: QuotaLayoutAccount
  status: string
  statusTone: QuotaTone
  now: () => number
  width: () => number
  marginTop?: number
  children?: JSX.Element
}): JSX.Element {
  const windows = () => accountWindows(props.account, props.now())
  const age = () =>
    quotaReadingAge(
      windows().map((window) => window.reading),
      props.now(),
    )
  const ageInline = () =>
    age() !== '' &&
    props.account.label.length + 3 + age().length + 1 + props.status.length <=
      props.width()
  const label = () =>
    fitLabel(props.account.label, props.width() - 1 - props.status.length)
  // One reset column width per account, so bars line up across its rows.
  const resetWidth = () =>
    Math.max(
      0,
      ...windows()
        .filter(showsFigure)
        .map((window) => window.text.reset.length),
    )
  const layoutFor = (window: AccountWindow) =>
    windowRowLayout(
      props.width(),
      window.text.name !== '',
      resetWidth(),
      props.appearance.barWidth,
    )
  const groups = () =>
    QUOTA_ORDER.map((key) => ({
      key,
      windows: windows().filter((window) => window.key === key),
    })).filter((group) => group.windows.length > 0)
  return (
    <box width='100%' flexDirection='column' marginTop={props.marginTop ?? 0}>
      <box width='100%' flexDirection='row'>
        <text flexShrink={0} wrapMode='none' fg={props.palette.text()}>
          <b>{label()}</b>
        </text>
        <Show when={ageInline()}>
          <text flexShrink={0} wrapMode='none' fg={props.palette.muted()}>
            {` · ${age()}`}
          </text>
        </Show>
        <box flexGrow={1} />
        <text
          flexShrink={0}
          wrapMode='none'
          fg={props.palette.tone(props.statusTone)}
        >
          <b>{props.status}</b>
        </text>
      </box>
      <Show when={age() !== '' && !ageInline()}>
        <text wrapMode='none' fg={props.palette.muted()}>
          {age()}
        </text>
      </Show>
      <Show
        when={groups().length > 0}
        fallback={
          <text wrapMode='none' fg={props.palette.muted()}>
            {NO_QUOTA_READING}
          </text>
        }
      >
        <For each={groups()}>
          {(group) => (
            <>
              <text wrapMode='none' fg={props.palette.muted()}>
                {GROUP_NAMES[group.key]}
              </text>
              <For each={group.windows}>
                {(window) => (
                  <WindowRow
                    palette={props.palette}
                    appearance={props.appearance}
                    window={window}
                    layout={layoutFor(window)}
                  />
                )}
              </For>
            </>
          )}
        </For>
      </Show>
      {props.children}
    </box>
  )
}
