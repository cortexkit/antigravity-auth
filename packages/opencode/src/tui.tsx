/** @jsxImportSource @opentui/solid */

/**
 * Read-only OpenTUI sidebar for the Antigravity plugin.
 *
 * The plugin writes a redacted snapshot of the account pool to the file
 * resolved by `getSidebarStateFile()`. This component polls that file every
 * 2 seconds and renders a compact panel: one block per account (label, health
 * bar, cooldown, per-model quota bars), a "active session route" row, and
 * stale/backoff status indicators.
 *
 * Hard rules for this file:
 *
 * - NO direct writes to the host terminal anywhere in the render path. The
 *   host terminal is the frame buffer; one stray byte corrupts every
 *   subsequent cell. Errors flow through `createTuiFileLogger()`.
 * - NO imports from `./plugin/storage`, `./plugin/accounts`, OAuth code, or
 *   anything that touches tokens. The sidebar is a read-only view of an
 *   already-redacted snapshot.
 * - The component uses Solid's `onCleanup` to release the polling timer on
 *   unmount so a route change can never leak an interval.
 */

import type { TuiPlugin } from '@opencode-ai/plugin/tui'
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
import { createRpcClient, type RpcClient } from './rpc/rpc-client'
import { getRpcDir } from './rpc/rpc-dir'
import {
  readSidebarState,
  type SidebarAccountState,
  type SidebarQuotaEntry,
  type SidebarQuotaKey,
  type SidebarRoutingEntry,
  type SidebarStateV1,
} from './sidebar-state'
import { ANSI } from './tui/ansi'
import { collectDialogFlow, renderDialogFlow } from './tui/command-dialogs'
import { createTuiFileLogger, type TuiLogger } from './tui/file-logger'

const POLL_INTERVAL_MS = 2000
const STALE_AFTER_MS = 15_000

const QUOTA_LABELS: Record<SidebarQuotaKey, string> = {
  claude: 'Claude',
  'gemini-pro': 'Gemini Pro',
  'gemini-flash': 'Gemini Flash',
}

const QUOTA_ORDER: readonly SidebarQuotaKey[] = [
  'claude',
  'gemini-pro',
  'gemini-flash',
]

export interface SidebarPanelProps {
  /** Override the file the TUI polls. Defaults to `getSidebarStateFile()`. */
  stateFile?: string
  /** Override the polling interval. Defaults to 2000ms. */
  pollIntervalMs?: number
  /** Override the logger; tests inject a logger that captures into memory. */
  logger?: TuiLogger
  /** Optional override for the current epoch in milliseconds (tests). */
  now?: () => number
  rpcClient?: RpcClient
  rpcPollIntervalMs?: number
  sessionId?: string
  onRpcNotification?: (notification: RpcNotification) => void
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

export function SidebarPanel(props: SidebarPanelProps): JSX.Element {
  const logger = resolveLogger(props.logger)
  const now = props.now ?? (() => Date.now())
  const pollMs = props.pollIntervalMs ?? POLL_INTERVAL_MS

  const [state, setState] = createSignal<InternalState>({
    loaded: EMPTY_STATE,
    lastReadAt: 0,
    lastError: null,
  })

  const lastReceivedBySession = new Map<string, number>()
  let lastRpcError: string | null = null
  createEffect(() => {
    const rpcClient = props.rpcClient
    const sessionId = props.sessionId
    const intervalMs = props.rpcPollIntervalMs ?? 500
    if (!rpcClient) return

    const sessionKey = sessionId ?? ''
    let active = true
    let polling = false
    const poll = async (): Promise<void> => {
      if (!active || polling) return
      polling = true
      try {
        const notifications = await rpcClient.pendingNotifications(
          lastReceivedBySession.get(sessionKey) ?? 0,
          sessionId,
        )
        if (!active) return
        for (const notification of notifications) {
          const previousId = lastReceivedBySession.get(sessionKey) ?? 0
          if (notification.id <= previousId) continue
          lastReceivedBySession.set(sessionKey, notification.id)
          props.onRpcNotification?.(notification)
        }
        lastRpcError = null
      } catch (error) {
        const message = formatError(error)
        if (message !== lastRpcError) {
          logger.warn('rpc-notification-poll-failed', { error: message })
          lastRpcError = message
        }
      } finally {
        polling = false
      }
    }

    void poll()
    const interval = setInterval(() => void poll(), intervalMs)
    onCleanup(() => {
      active = false
      clearInterval(interval)
    })
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

  return (
    <box flexDirection='column' paddingX={1} paddingY={1}>
      <ShowHeader state={state} now={now} />
      <Show
        when={state().loaded.accounts.length > 0}
        fallback={<AwaitingState now={now} state={state()} />}
      >
        <ActiveRoute state={state()} />
        <RoutingStatus state={state()} now={now} />
        <box flexDirection='column' marginTop={1}>
          <For each={state().loaded.accounts}>
            {(account) => <AccountBlock account={account} now={now} />}
          </For>
        </box>
        <FooterState state={state()} now={now} />
      </Show>
    </box>
  )
}

function ShowHeader(props: {
  state: () => InternalState
  now: () => number
}): JSX.Element {
  // `loaded` is read inside JSX so Solid tracks the signal — without the
  // accessor wrapper the header would freeze at the value captured when
  // the component body first ran, never reflecting subsequent polls.
  const loaded = () => props.state().loaded
  return (
    <box flexDirection='row' justifyContent='space-between'>
      <text>Antigravity</text>
      <text>
        {loaded().accounts.filter((a) => a.enabled).length}/
        {loaded().accounts.length} ready
      </text>
    </box>
  )
}

function AwaitingState(props: {
  now: () => number
  state: InternalState
}): JSX.Element {
  const lastError = props.state.lastError ?? props.state.loaded.lastError
  return (
    <box flexDirection='column' marginTop={1}>
      <text>Awaiting Antigravity state</text>
      <Show when={lastError}>
        <text fg={ANSI.dim}>last error: {lastError ?? ''}</text>
      </Show>
      <text fg={ANSI.dim}>
        waiting for first poll · last tried {formatTime(props.now())}
      </text>
    </box>
  )
}

function ActiveRoute(props: { state: InternalState }): JSX.Element {
  const routes = Object.entries(props.state.loaded.activeRouting)
  if (routes.length === 0) {
    return (
      <box flexDirection='row' marginTop={1}>
        <text fg={ANSI.dim}>no active session route</text>
      </box>
    )
  }
  const [, route] = routes[0] as [string, SidebarRoutingEntry]
  const account = props.state.loaded.accounts.find(
    (entry) => entry.id === route.accountId,
  )
  const label = account?.label ?? route.accountId
  return (
    <box flexDirection='row' marginTop={1}>
      <text>
        routing → {route.modelFamily} via {label} ({route.headerStyle})
      </text>
    </box>
  )
}

function RoutingStatus(props: {
  state: InternalState
  now: () => number
}): JSX.Element {
  const { loaded } = props.state
  const isStale = props.now() - loaded.checkedAt > STALE_AFTER_MS
  const isAuthoritative = loaded.routingAuthoritative
  if (isAuthoritative && !isStale) return null
  return (
    <box flexDirection='row'>
      <text fg={isStale ? ANSI.yellow : ANSI.dim}>
        {isStale
          ? 'stale routing snapshot'
          : 'routing snapshot not authoritative'}
      </text>
    </box>
  )
}

function AccountBlock(props: {
  account: SidebarAccountState
  now: () => number
}): JSX.Element {
  const { account } = props
  const inCooldown =
    typeof account.cooldownUntil === 'number' &&
    account.cooldownUntil > props.now()
  const remainingCooldownMs =
    inCooldown && typeof account.cooldownUntil === 'number'
      ? Math.max(0, account.cooldownUntil - props.now())
      : 0
  return (
    <box
      flexDirection='column'
      borderStyle='rounded'
      borderColor={account.current ? ANSI.green : ANSI.dim}
      paddingX={1}
      paddingY={0}
      marginBottom={1}
    >
      <box flexDirection='row' justifyContent='space-between'>
        <text>
          {account.current ? '●' : '○'} {account.label}
        </text>
        <text fg={account.enabled ? ANSI.green : ANSI.dim}>
          {account.enabled ? 'on' : 'off'}
        </text>
      </box>
      <HealthBar health={account.health} />
      <Show when={inCooldown}>
        <text fg={ANSI.yellow}>cooldown {formatWait(remainingCooldownMs)}</text>
      </Show>
      <box flexDirection='column' marginTop={0}>
        <For each={QUOTA_ORDER}>
          {(key) => {
            const entry = account.quota[key]
            return <QuotaBar key={key} entry={entry} />
          }}
        </For>
      </box>
    </box>
  )
}

function HealthBar(props: { health: number }): JSX.Element {
  const filled = Math.round(clamp(props.health, 0, 100) / 10)
  const empty = 10 - filled
  const bar = `${'█'.repeat(filled)}${'░'.repeat(empty)}`
  const color = props.health >= 60 ? ANSI.green : ANSI.yellow
  return (
    <box flexDirection='row'>
      <text fg={color}>
        health {bar} {Math.round(props.health)}
      </text>
    </box>
  )
}

function QuotaBar(props: {
  key: SidebarQuotaKey
  entry: SidebarQuotaEntry | undefined
}): JSX.Element {
  return (
    <Show
      when={props.entry}
      fallback={
        <box flexDirection='row'>
          <text fg={ANSI.dim}>{QUOTA_LABELS[props.key]} —</text>
        </box>
      }
    >
      {(entry) => (
        <box flexDirection='row'>
          <QuotaBarLine entry={entry()} label={QUOTA_LABELS[props.key]} />
        </box>
      )}
    </Show>
  )
}

function QuotaBarLine(props: {
  label: string
  entry: SidebarQuotaEntry
}): JSX.Element {
  const remaining = clamp(props.entry.remainingPercent, 0, 100)
  const filled = Math.round(remaining / 10)
  const empty = 10 - filled
  const color =
    remaining < 20 ? ANSI.red : remaining < 50 ? ANSI.yellow : ANSI.green
  const bar = `${'▰'.repeat(filled)}${'▱'.repeat(empty)}`
  return (
    <text fg={color}>
      {props.label} {bar} {Math.round(remaining)}%
    </text>
  )
}

function FooterState(props: {
  state: InternalState
  now: () => number
}): JSX.Element {
  const { loaded, lastError } = props.state
  const backoffActive =
    typeof loaded.quotaBackoffUntil === 'number' &&
    loaded.quotaBackoffUntil > props.now()
  if (!backoffActive && !lastError) return null
  return (
    <box flexDirection='column' marginTop={1}>
      <Show when={backoffActive}>
        <text fg={ANSI.yellow}>
          quota backoff until {formatTime(loaded.quotaBackoffUntil ?? 0)}
        </text>
      </Show>
      <Show when={lastError}>
        <text fg={ANSI.red}>last error: {lastError ?? ''}</text>
      </Show>
    </box>
  )
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min
  if (value > max) return max
  return value
}

function formatWait(ms: number): string {
  const seconds = Math.ceil(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remaining = seconds % 60
  return remaining > 0 ? `${minutes}m ${remaining}s` : `${minutes}m`
}

function formatTime(epoch: number): string {
  if (!epoch) return 'never'
  const date = new Date(epoch)
  return date.toISOString().replace('T', ' ').slice(0, 19)
}

function formatError(value: unknown): string {
  if (value instanceof Error) return value.message
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/**
 * Solid slot registry binding exposed for hosts that want to mount the
 * sidebar inside their renderer. Hosts that already own a slot registry can
 * use `createSlot` directly; we re-export for convenience and to keep the
 * contract visible at the module entry point.
 */
export const sidebar_content = createSlot

const tui: TuiPlugin = async (api) => {
  const logger = resolveLogger(undefined)
  const rpcClient = createRpcClient(
    getRpcDir(api.state.path.directory ?? ''),
    process.pid,
  )

  api.slots.register({
    slots: {
      sidebar_content: (_context, { session_id: sessionID }) => (
        <SidebarPanel
          logger={logger}
          rpcClient={rpcClient}
          sessionId={sessionID}
          onRpcNotification={async (notification) => {
            logger.debug('rpc-notification-received', {
              command: notification.command,
              id: notification.id,
              sessionId: notification.sessionId,
            })
            await openCommandDialogFromNotification(
              api,
              rpcClient,
              notification,
            )
          }}
        />
      ),
    },
  })
}

/**
 * Mount the OpenTUI dialog for an inbound RPC notification.
 *
 * Each modal command maps to a single-dialog flow rendered through
 * the host's `DialogSelect` (or confirm/prompt for sub-steps). Errors
 * here are deliberately swallowed — the host may have multiple
 * incoming notifications queued and one bad render must not break
 * the next one.
 */
async function openCommandDialogFromNotification(
  api: Parameters<TuiPlugin>[0],
  rpcClient: RpcClient,
  notification: RpcNotification,
): Promise<void> {
  try {
    const flow = await collectDialogFlow(notification.command, '', {
      settings: {
        get: () => ({ log_level: 'info' }),
      },
    })
    await renderDialogFlow({
      api: api as unknown as Parameters<typeof renderDialogFlow>[0]['api'],
      flow,
      apply: async (command, args) => {
        const result = await rpcClient.apply({
          command,
          arguments: args,
          sessionId: notification.sessionId,
        })
        return { text: result.text }
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    try {
      await api.client.app.log({
        service: 'antigravity.tui',
        level: 'warn',
        message: 'dialog-open-failed',
        extra: { command: notification.command, error: message },
      })
    } catch {
      // ignore — host may not expose app.log
    }
  }
}

export default tui
