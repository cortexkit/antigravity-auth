import { removeSidebarActiveRouting } from '../sidebar-state'
import type { AntigravityConfig } from './config'
import type { Logger } from './logger'
import { getRecoverySuccessToast } from './recovery'
import type { PluginClient } from './types'

type EventInput = {
  event: { type: string; properties?: unknown }
}

type SessionSummary = {
  durationMinutes: number
  totalClaude: number
  totalGemini: number
  requestsPerHour: number
  accountsUsed: number
}

type EventAccountManager = {
  getSessionSummary(): SessionSummary
  deleteSessionState(sessionId: string): void
}

type EventLifecycle = {
  getAccountManager(): EventAccountManager | null
}

type EventSessionRegistry = {
  register(sessionId: string, parentSessionId: string | null): void
  delete(sessionId: string): void
  getParentSessionId(sessionId: string): string | null
}

type EventSessionRecovery = {
  isRecoverableError(error: unknown): boolean
  handleSessionRecovery(info: {
    id?: string
    role: 'assistant'
    sessionID?: string
    error: unknown
  }): Promise<boolean>
}

type EventUpdateChecker = {
  event(input: EventInput): void | Promise<void>
}

export interface CreateEventHandlerOptions {
  client: PluginClient
  config: Pick<AntigravityConfig, 'auto_resume' | 'resume_text' | 'toast_scope'>
  directory: string
  lifecycle: EventLifecycle
  sessionRegistry: EventSessionRegistry
  sessionRecovery: EventSessionRecovery | null
  updateChecker: EventUpdateChecker
  logger: Pick<Logger, 'debug'>
}

export function createEventHandler({
  client,
  config,
  directory,
  lifecycle,
  sessionRegistry,
  sessionRecovery,
  updateChecker,
  logger,
}: CreateEventHandlerOptions) {
  return async (input: EventInput): Promise<void> => {
    await updateChecker.event(input)

    if (input.event.type === 'session.created') {
      const properties = input.event.properties as
        | { info?: { id?: string; parentID?: string } }
        | undefined
      const sessionId = properties?.info?.id
      const parentSessionId = properties?.info?.parentID ?? null

      if (sessionId) {
        sessionRegistry.register(sessionId, parentSessionId)
      }

      if (parentSessionId) {
        logger.debug('child-session-detected', {
          sessionId,
          parentID: parentSessionId,
        })
      } else {
        const previousSummary = lifecycle
          .getAccountManager()
          ?.getSessionSummary()
        if (
          previousSummary &&
          (previousSummary.totalClaude > 0 || previousSummary.totalGemini > 0)
        ) {
          logger.debug('prev-session-quota-summary', {
            durationMinutes: previousSummary.durationMinutes,
            totalClaude: previousSummary.totalClaude,
            totalGemini: previousSummary.totalGemini,
            requestsPerHour: previousSummary.requestsPerHour,
            accountsUsed: previousSummary.accountsUsed,
          })
        }
        logger.debug('root-session-detected', { sessionId })
      }
    }

    if (input.event.type === 'session.deleted') {
      const properties = input.event.properties as
        | { sessionID?: string; info?: { id?: string } }
        | undefined
      const sessionId = properties?.sessionID ?? properties?.info?.id
      if (sessionId) {
        sessionRegistry.delete(sessionId)
        lifecycle.getAccountManager()?.deleteSessionState(sessionId)
        // Drop the session's sidebar route so the TUI does not retain a
        // dead route after the session ends. Fire-and-forget; the next
        // sidebar poll will see the pruned map.
        const eventLogger = logger as Pick<Logger, 'debug'>
        void removeSidebarActiveRouting(sessionId).catch((error: unknown) => {
          eventLogger.debug('sidebar-route-remove-failed', {
            sessionId,
            error: String(error),
          })
        })
      }
    }

    if (!sessionRecovery || input.event.type !== 'session.error') {
      return
    }

    const properties = input.event.properties as
      | Record<string, unknown>
      | undefined
    const sessionID = properties?.sessionID as string | undefined
    const messageID = properties?.messageID as string | undefined
    const error = properties?.error

    if (!sessionRecovery.isRecoverableError(error)) {
      return
    }

    const recovered = await sessionRecovery.handleSessionRecovery({
      id: messageID,
      role: 'assistant',
      sessionID,
      error,
    })

    if (!recovered || !sessionID || !config.auto_resume) {
      return
    }

    await client.session
      .prompt({
        path: { id: sessionID },
        body: { parts: [{ type: 'text', text: config.resume_text }] },
        query: { directory },
      })
      .catch(() => {})

    const successToast = getRecoverySuccessToast()
    const isChildSession =
      sessionRegistry.getParentSessionId(sessionID) !== null
    logger.debug('recovery-toast', {
      ...successToast,
      isChildSession,
      toastScope: config.toast_scope,
    })

    if (config.toast_scope === 'root_only' && isChildSession) {
      return
    }

    await client.tui
      .showToast({
        body: {
          title: successToast.title,
          message: successToast.message,
          variant: 'success',
        },
      })
      .catch(() => {})
  }
}
