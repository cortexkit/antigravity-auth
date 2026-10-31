import type { RGBA } from '@opentui/core'
import type { JSX } from '@opentui/solid'
import {
  createContext,
  createMemo,
  createSignal,
  For,
  Index,
  mergeProps,
  Show,
  useContext,
} from 'solid-js'
import type { QuotaWindowPart } from '../quota/format.js'
import { formatQuota, quotaWindowParts } from '../quota/format.js'
import type { ProjectedQuota } from '../quota/projection.js'

export type Tone =
  | 'text'
  | 'textMuted'
  | 'accent'
  | 'success'
  | 'warning'
  | 'error'

export type SidebarTheme = Readonly<
  Partial<
    Record<Tone | 'background' | 'borderActive', RGBA | string | undefined>
  >
>

export interface SidebarAppearance {
  barWidth: number
  barFilledChar: string
  barEmptyChar: string
  warnThreshold: number
  errorThreshold: number
}

export interface PaceView {
  text: string
  tone: Tone
  /** The elapsed-window percentage, not the difference from usage. */
  overlay?: { kind: 'reserve' | 'deficit'; percent: number }
}

export interface QuotaGroupView {
  title?: string
  rows: readonly { part: QuotaWindowPart; pace?: PaceView }[]
}

export interface AccountView {
  id: string
  label: string
  titleSuffix?: string
  status: { text: string; tone: Tone }
  blocked: boolean
  indicatorTone: Tone
  quota: ProjectedQuota | undefined
  groups: readonly QuotaGroupView[]
  emptyQuotaText?: { expanded: string; collapsed: string }
  /** Presentation decided by the plugin, never inferred from status or freshness. */
  collapsed?: { quotaTone?: Tone; muted?: boolean }
}

export interface SidebarFrameProps {
  header: { badge: string; version?: string }
  accounts: readonly AccountView[]
  theme?: SidebarTheme
  appearance: SidebarAppearance
  showQuota: boolean
  now: number
  collapsed: boolean
  onToggle: () => void
  beforeQuota?: (account: AccountView) => JSX.Element
  afterQuota?: (account: AccountView) => JSX.Element
  sections?: () => JSX.Element
  collapsedSections?: () => JSX.Element
}

type FrameContextProps = Omit<SidebarFrameProps, 'theme'> & {
  theme: SidebarTheme
}

const FrameContext = createContext<FrameContextProps>()

function frameContext(): FrameContextProps {
  const context = useContext(FrameContext)
  if (!context)
    throw new Error('Sidebar primitives must be inside SidebarFrame')
  return context
}

function displayWidth(text: string): number {
  const bun = (
    globalThis as { Bun?: { stringWidth?: (text: string) => number } }
  ).Bun
  return bun?.stringWidth ? bun.stringWidth(text) : Array.from(text).length
}

function fitText(text: string, columns: number): string {
  if (displayWidth(text) <= columns) return text
  if (columns < 1) return ''
  let kept = ''
  let used = 0
  for (const char of text) {
    const width = displayWidth(char)
    if (used + width > columns - 1) break
    kept += char
    used += width
  }
  return `${kept}\u2026`
}

/** A heading and its plugin-owned rows, with the frame's section spacing. */
export function SidebarSection(props: {
  title: string
  children?: JSX.Element
}) {
  const context = frameContext()
  return (
    <>
      <box width='100%' marginTop={1}>
        <text fg={context.theme.text}>
          <b>{props.title}</b>
        </text>
      </box>
      {props.children}
    </>
  )
}

/** Keep labels whole and reserve one blank cell before an ellipsized value. */
export function SidebarStatRow(props: {
  label: string
  value: string
  tone?: Tone
}) {
  const context = frameContext()
  const [width, setWidth] = createSignal(0)
  let row: { width: number } | undefined
  const value = () =>
    width() <= 0
      ? props.value
      : fitText(props.value, width() - displayWidth(props.label) - 1)
  return (
    <box
      ref={(element: { width: number }) => {
        row = element
      }}
      onSizeChange={() => setWidth(row?.width ?? 0)}
      width='100%'
      flexDirection='row'
      justifyContent='space-between'
      columnGap={1}
    >
      <text fg={context.theme.textMuted} wrapMode='none' flexShrink={0}>
        {props.label}
      </text>
      <text
        fg={context.theme[props.tone ?? 'text']}
        wrapMode='none'
        flexShrink={1}
      >
        <b>{value()}</b>
      </text>
    </box>
  )
}

export function SidebarTextRow(props: {
  text: string
  tone?: Tone
  wrapMode?: JSX.IntrinsicElements['text']['wrapMode']
}) {
  const context = frameContext()
  return (
    <text
      fg={context.theme[props.tone ?? 'textMuted']}
      wrapMode={props.wrapMode}
    >
      {props.text}
    </text>
  )
}

function usageTone(used: number, appearance: SidebarAppearance): Tone {
  if (used >= appearance.errorThreshold) return 'error'
  if (used >= appearance.warnThreshold) return 'warning'
  return 'success'
}

function barSegments(
  used: number,
  appearance: SidebarAppearance,
  pace?: PaceView,
) {
  const width = appearance.barWidth
  const cells = (pct: number) =>
    Math.max(0, Math.min(Math.round((pct / 100) * width), width))
  const usedCells = cells(used)
  const tone = usageTone(used, appearance)
  // Keep the overlay's slot even when empty so live pacing changes reuse nodes.
  const plain = [
    { text: appearance.barFilledChar.repeat(usedCells), tone },
    { text: '', tone },
    { text: appearance.barEmptyChar.repeat(width - usedCells), tone },
  ]
  const overlay = pace?.overlay
  if (!overlay) return plain
  const paceCells = cells(overlay.percent)
  const lo = Math.min(usedCells, paceCells)
  const hi = Math.max(usedCells, paceCells)
  if (lo === hi) return plain
  return [
    { text: appearance.barFilledChar.repeat(lo), tone },
    {
      text: (overlay.kind === 'deficit' ? '\u2593' : '\u2592').repeat(hi - lo),
      tone:
        overlay.kind === 'deficit' ? ('error' as const) : ('success' as const),
    },
    { text: appearance.barEmptyChar.repeat(width - hi), tone },
  ]
}

function QuotaRow(props: {
  part: QuotaWindowPart
  pace?: PaceView
  labelWidth: number
  barCells: number
  resetWidth: number
  showReset: boolean
}) {
  const context = frameContext()
  const [columns, setColumns] = createSignal(0)
  let row: { width: number } | undefined
  const label = () =>
    props.part.name +
    ' '.repeat(Math.max(0, props.labelWidth - displayWidth(props.part.name)))
  const figure = () =>
    ` ${props.part.kind === 'budget' && props.part.figure.startsWith(`${props.part.name} `) ? props.part.figure.slice(props.part.name.length + 1) : props.part.figure}`
  const used = () => 100 - (props.part.remainingPercent ?? 100)
  // Size notifications can recompute an unchanged fit after text has been flushed
  // for the frame. Keep equal segments, and update fixed slots in place when the
  // bar changes, rather than replacing text nodes during layout.
  const segments = createMemo(
    () =>
      barSegments(
        used(),
        { ...context.appearance, barWidth: props.barCells },
        props.pace,
      ),
    undefined,
    {
      equals: (previous, next) =>
        previous.length === next.length &&
        previous.every(
          (segment, index) =>
            segment.text === next[index]?.text &&
            segment.tone === next[index]?.tone,
        ),
    },
  )
  const paceLine = () => {
    const text = props.pace?.text
    if (!text || columns() <= 0) return text
    return fitText(text, columns() - props.labelWidth)
  }
  return (
    <>
      <box
        ref={(element: { width: number }) => {
          row = element
        }}
        onSizeChange={() => setColumns(row?.width ?? 0)}
        width='100%'
        flexDirection='row'
        justifyContent='space-between'
      >
        <box
          flexDirection='row'
          flexShrink={props.part.resetSinceReading ? 1 : 0}
        >
          <Show when={props.labelWidth > 0}>
            <text fg={context.theme.textMuted} wrapMode='none' flexShrink={0}>
              {label()}
            </text>
          </Show>
          <Show
            when={!props.part.resetSinceReading}
            fallback={
              <text fg={context.theme.textMuted} wrapMode='none'>
                reset since last check
              </text>
            }
          >
            <Show when={props.barCells > 0}>
              {/* Text nodes clear omitted theme colours; empty slots must not reserve a cell. */}
              <Index each={segments()}>
                {(segment) => (
                  <text
                    fg={context.theme[segment().tone]}
                    wrapMode='none'
                    width={segment().text ? undefined : 0}
                  >
                    {segment().text}
                  </text>
                )}
              </Index>
            </Show>
            <text
              fg={context.theme[usageTone(used(), context.appearance)]}
              wrapMode='none'
            >
              {figure()}
            </text>
          </Show>
        </box>
        <Show when={props.showReset && !props.part.resetSinceReading}>
          <box
            width={props.resetWidth}
            flexShrink={0}
            flexDirection='row'
            justifyContent='flex-end'
          >
            <Show when={props.part.resetIn}>
              <text fg={context.theme.textMuted} wrapMode='none'>
                {props.part.resetIn}
              </text>
            </Show>
          </box>
        </Show>
      </box>
      {/* A changed fitted line needs a fresh text node to draw at its new width. */}
      <Show when={!props.part.resetSinceReading && paceLine()} keyed>
        {(line: string) => (
          <box width='100%' flexDirection='row'>
            <Show when={props.labelWidth > 0}>
              <text fg={context.theme.textMuted}>
                {''.padEnd(props.labelWidth)}
              </text>
            </Show>
            <text
              fg={context.theme[props.pace?.tone ?? 'textMuted']}
              wrapMode='none'
            >
              {line}
            </text>
          </box>
        )}
      </Show>
    </>
  )
}

function CollapsedAccountRow(props: { account: AccountView }) {
  const context = frameContext()
  const [width, setWidth] = createSignal(0)
  let row: { width: number } | undefined
  const hasQuota = () =>
    quotaWindowParts(props.account.quota, { now: context.now }).windows.length >
    0
  const text = () =>
    hasQuota()
      ? formatQuota(props.account.quota, { now: context.now, form: 'narrow' })
      : (props.account.emptyQuotaText?.collapsed ?? '\u2014')
  // Reserve an ellipsis, a separator and the trailing indicator before keeping quota.
  const showQuota = () => width() <= 0 || displayWidth(text()) + 4 <= width()
  const label = () => {
    if (width() <= 0) return props.account.label
    return fitText(
      props.account.label,
      width() - (showQuota() ? displayWidth(text()) + 3 : 2),
    )
  }
  const muted = () => props.account.collapsed?.muted ?? false
  const quotaTone = () =>
    muted() ? 'textMuted' : (props.account.collapsed?.quotaTone ?? 'success')
  return (
    <box
      ref={(element: { width: number }) => {
        row = element
      }}
      onSizeChange={() => setWidth(row?.width ?? 0)}
      width='100%'
      flexDirection='row'
      justifyContent='space-between'
      columnGap={label() ? 1 : 0}
    >
      <Show when={label()}>
        <text
          fg={context.theme[muted() ? 'textMuted' : 'text']}
          wrapMode='none'
          flexShrink={1}
        >
          {label()}
        </text>
      </Show>
      <box flexDirection='row' flexShrink={0}>
        <Show when={showQuota()}>
          <Show
            when={hasQuota() && !muted()}
            fallback={<text fg={context.theme.textMuted}>{text()}</text>}
          >
            <text fg={context.theme[quotaTone()]}>
              <b>{text()}</b>
            </text>
          </Show>
        </Show>
        <text fg={context.theme[props.account.indicatorTone]}>
          {showQuota() ? ' ' : ''}
          {props.account.blocked ? '\u2298' : '\u25cf'}
        </text>
      </box>
    </box>
  )
}

function AccountBlock(props: { account: AccountView; marginTop: number }) {
  const context = frameContext()
  const [columns, setColumns] = createSignal(0)
  let block: { width: number } | undefined
  const rows = () => props.account.groups.flatMap((group) => group.rows)
  const labelWidth = () =>
    Math.max(
      0,
      ...rows().map(({ part }) =>
        part.name ? Math.max(3, displayWidth(part.name) + 1) : 0,
      ),
    )
  const resetWidth = () =>
    Math.max(
      0,
      ...rows().map(({ part }) =>
        part.resetSinceReading ? 0 : displayWidth(part.resetIn ?? ''),
      ),
    )
  const figureWidth = createMemo(() =>
    Math.max(
      10,
      ...rows()
        .filter(({ part }) => !part.resetSinceReading)
        .map(({ part }) =>
          displayWidth(
            ` ${part.kind === 'budget' && part.figure.startsWith(`${part.name} `) ? part.figure.slice(part.name.length + 1) : part.figure}`,
          ),
        ),
    ),
  )
  const fit = (rowLabelWidth: number) => {
    const desired = context.appearance.barWidth
    // Four cells still distinguish quarters of a window without sacrificing its reset.
    const minimum = Math.min(4, desired)
    if (columns() <= 0)
      return { barCells: desired, showReset: resetWidth() > 0 }
    const room = columns() - rowLabelWidth - figureWidth()
    const withReset = room - resetWidth() - 1
    const showReset = resetWidth() > 0 && withReset >= minimum
    const available = showReset ? withReset : room
    return {
      barCells: available >= minimum ? Math.min(desired, available) : 0,
      showReset,
    }
  }
  const label = () => {
    const full = `${props.account.label}${props.account.titleSuffix ? ` · ${props.account.titleSuffix}` : ''}`
    return columns() <= 0
      ? full
      : fitText(full, columns() - displayWidth(props.account.status.text) - 1)
  }
  const age = () =>
    quotaWindowParts(props.account.quota, { now: context.now }).age
  const hasRows = () =>
    props.account.groups.some((group) => group.rows.length > 0)
  return (
    <box
      ref={(element: { width: number }) => {
        block = element
      }}
      onSizeChange={() => setColumns(block?.width ?? 0)}
      width='100%'
      flexDirection='column'
      marginTop={props.marginTop}
    >
      <box
        width='100%'
        flexDirection='row'
        justifyContent='space-between'
        columnGap={1}
      >
        <text fg={context.theme.text} wrapMode='none' flexShrink={1}>
          <b>{label()}</b>
        </text>
        <text
          fg={context.theme[props.account.status.tone]}
          wrapMode='none'
          flexShrink={0}
        >
          <b>{props.account.status.text}</b>
        </text>
      </box>
      {context.beforeQuota?.(props.account)}
      <Show
        when={hasRows()}
        fallback={
          <SidebarTextRow
            text={props.account.emptyQuotaText?.expanded ?? '\u2014'}
            wrapMode='none'
          />
        }
      >
        <For each={props.account.groups}>
          {(group) => (
            <>
              <Show when={group.title}>
                <SidebarTextRow
                  text={group.title ?? ''}
                  tone='text'
                  wrapMode='none'
                />
              </Show>
              <For each={group.rows}>
                {(row) => {
                  const rowLabelWidth = () => (row.part.name ? labelWidth() : 0)
                  const rowFit = createMemo(() => fit(rowLabelWidth()))
                  return (
                    <QuotaRow
                      part={row.part}
                      pace={row.pace}
                      labelWidth={rowLabelWidth()}
                      barCells={rowFit().barCells}
                      resetWidth={resetWidth()}
                      showReset={rowFit().showReset}
                    />
                  )
                }}
              </For>
            </>
          )}
        </For>
      </Show>
      <Show when={age()}>
        {(text: () => string) => (
          <SidebarTextRow text={text()} wrapMode='none' />
        )}
      </Show>
      {context.afterQuota?.(props.account)}
    </box>
  )
}

/** Borderless, controlled presentation; host registration and provider policy stay in the plugin. */
export function SidebarFrame(props: SidebarFrameProps) {
  const hasData = () => props.accounts.length > 0
  const headerLabel = () =>
    !hasData()
      ? props.header.badge
      : `${props.collapsed ? '\u25b6' : '\u25bc'} ${props.header.badge}`
  // Missing semantic colors inherit normal text; an unset palette uses terminal defaults.
  const context = mergeProps(props, {
    get theme(): SidebarTheme {
      const theme = props.theme
      return {
        ...theme,
        textMuted: theme?.textMuted ?? theme?.text,
        accent: theme?.accent ?? theme?.text,
        success: theme?.success ?? theme?.text,
        warning: theme?.warning ?? theme?.text,
        error: theme?.error ?? theme?.text,
      }
    },
  })
  // Inverting an incomplete badge palette can put light text on a light background.
  const invertBadge = () =>
    props.theme?.accent !== undefined && props.theme?.background !== undefined
  return (
    <FrameContext.Provider value={context}>
      <box width='100%' flexDirection='column'>
        {/* Blocked accounts retain their own indicators; the header always keeps its version. */}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: OpenTUI terminal widgets do not have DOM roles */}
        <box
          width='100%'
          flexDirection='row'
          justifyContent='space-between'
          alignItems='center'
          onMouseDown={() => {
            if (hasData()) props.onToggle()
          }}
        >
          <box
            paddingLeft={1}
            paddingRight={1}
            backgroundColor={invertBadge() ? props.theme?.accent : undefined}
          >
            <text
              fg={
                invertBadge() ? props.theme?.background : context.theme.accent
              }
            >
              <b>{headerLabel()}</b>
            </text>
          </box>
          <Show when={props.header.version}>
            <text fg={context.theme.textMuted}>{props.header.version}</text>
          </Show>
        </box>
        <Show when={props.collapsed && hasData()}>
          <For each={props.accounts}>
            {(account) => <CollapsedAccountRow account={account} />}
          </For>
          {props.collapsedSections?.()}
        </Show>
        <Show when={!props.collapsed || !hasData()}>
          <Show when={props.showQuota && hasData()}>
            <SidebarSection title='Quota'>
              <For each={props.accounts}>
                {(account, index) => (
                  <AccountBlock
                    account={account}
                    marginTop={index() === 0 ? 0 : 1}
                  />
                )}
              </For>
            </SidebarSection>
          </Show>
          {props.sections?.()}
        </Show>
      </box>
    </FrameContext.Provider>
  )
}
