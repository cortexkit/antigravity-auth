import { describe, expect, it, mock } from 'bun:test'

import { createEventHandler } from './event-handler'
import type { PluginClient } from './types'

function createHarness(
  options: {
    summary?: {
      durationMinutes: number
      totalClaude: number
      totalGemini: number
      requestsPerHour: number
      accountsUsed: number
    } | null
    recovered?: boolean
    recoverable?: boolean
    autoResume?: boolean
    toastScope?: 'root_only' | 'all'
    parentSessionId?: string | null
  } = {},
) {
  const updateEvent = mock(async () => {})
  const register = mock(
    (_sessionId: string, _parentSessionId: string | null) => {},
  )
  const deleteSession = mock((_sessionId: string) => {})
  const getParentSessionId = mock(
    (_sessionId: string) => options.parentSessionId ?? null,
  )
  const getSessionSummary = mock(
    () =>
      options.summary ?? {
        durationMinutes: 0,
        totalClaude: 0,
        totalGemini: 0,
        requestsPerHour: 0,
        accountsUsed: 0,
      },
  )
  const deleteSessionState = mock((_sessionId: string) => {})
  const accountManager = { getSessionSummary, deleteSessionState }
  const isRecoverableError = mock(
    (_error: unknown) => options.recoverable ?? true,
  )
  const handleSessionRecovery = mock(async () => options.recovered ?? true)
  const prompt = mock(async () => {})
  const showToast = mock(async () => {})
  const debug = mock((_message: string, _extra?: Record<string, unknown>) => {})

  const handler = createEventHandler({
    client: {
      session: { prompt },
      tui: { showToast },
    } as unknown as PluginClient,
    config: {
      auto_resume: options.autoResume ?? true,
      resume_text: 'continue from recovery',
      toast_scope: options.toastScope ?? 'root_only',
    },
    directory: '/tmp/project',
    lifecycle: {
      getAccountManager: () => accountManager,
    },
    sessionRegistry: {
      register,
      delete: deleteSession,
      getParentSessionId,
    },
    sessionRecovery: {
      isRecoverableError,
      handleSessionRecovery,
    },
    updateChecker: { event: updateEvent },
    logger: { debug },
  })

  return {
    accountManager,
    debug,
    deleteSession,
    deleteSessionState,
    getParentSessionId,
    getSessionSummary,
    handleSessionRecovery,
    handler,
    isRecoverableError,
    prompt,
    register,
    showToast,
    updateEvent,
  }
}

describe('createEventHandler', () => {
  it('forwards every event to the update checker', async () => {
    const harness = createHarness()
    const input = { event: { type: 'custom.event', properties: { value: 1 } } }

    await harness.handler(input)

    expect(harness.updateEvent).toHaveBeenCalledWith(input)
  })

  it('registers and logs child session creation', async () => {
    const harness = createHarness()

    await harness.handler({
      event: {
        type: 'session.created',
        properties: { info: { id: 'child', parentID: 'root' } },
      },
    })

    expect(harness.register).toHaveBeenCalledWith('child', 'root')
    expect(harness.debug).toHaveBeenCalledWith('child-session-detected', {
      sessionId: 'child',
      parentID: 'root',
    })
    expect(harness.getSessionSummary).not.toHaveBeenCalled()
  })

  it('logs the previous usage summary before a root session', async () => {
    const summary = {
      durationMinutes: 12,
      totalClaude: 3,
      totalGemini: 2,
      requestsPerHour: 25,
      accountsUsed: 2,
    }
    const harness = createHarness({ summary })

    await harness.handler({
      event: {
        type: 'session.created',
        properties: { info: { id: 'root' } },
      },
    })

    expect(harness.register).toHaveBeenCalledWith('root', null)
    expect(harness.debug).toHaveBeenCalledWith(
      'prev-session-quota-summary',
      summary,
    )
    expect(harness.debug).toHaveBeenCalledWith('root-session-detected', {
      sessionId: 'root',
    })
  })

  it('removes deleted sessions from the registry and account manager', async () => {
    const harness = createHarness()

    await harness.handler({
      event: {
        type: 'session.deleted',
        properties: { sessionID: 'deleted-session' },
      },
    })

    expect(harness.deleteSession).toHaveBeenCalledWith('deleted-session')
    expect(harness.deleteSessionState).toHaveBeenCalledWith('deleted-session')
  })

  it('recovers a session error, resumes it, and shows a success toast', async () => {
    const harness = createHarness({ toastScope: 'all' })
    const error = { name: 'ToolResultMissingError' }

    await harness.handler({
      event: {
        type: 'session.error',
        properties: {
          sessionID: 'failed-session',
          messageID: 'assistant-message',
          error,
        },
      },
    })

    expect(harness.isRecoverableError).toHaveBeenCalledWith(error)
    expect(harness.handleSessionRecovery).toHaveBeenCalledWith({
      id: 'assistant-message',
      role: 'assistant',
      sessionID: 'failed-session',
      error,
    })
    expect(harness.prompt).toHaveBeenCalledWith({
      path: { id: 'failed-session' },
      body: { parts: [{ type: 'text', text: 'continue from recovery' }] },
      query: { directory: '/tmp/project' },
    })
    expect(harness.showToast).toHaveBeenCalledWith({
      body: {
        title: 'Session Recovered',
        message: 'Continuing where you left off...',
        variant: 'success',
      },
    })
  })

  it('suppresses recovery toasts for child sessions in root-only scope', async () => {
    const harness = createHarness({ parentSessionId: 'root' })

    await harness.handler({
      event: {
        type: 'session.error',
        properties: {
          sessionID: 'child',
          messageID: 'assistant-message',
          error: { name: 'ToolResultMissingError' },
        },
      },
    })

    expect(harness.getParentSessionId).toHaveBeenCalledWith('child')
    expect(harness.showToast).not.toHaveBeenCalled()
    expect(harness.debug).toHaveBeenCalledWith(
      'recovery-toast',
      expect.objectContaining({
        isChildSession: true,
        toastScope: 'root_only',
      }),
    )
  })

  it('does not resume when recovery is skipped, fails, or auto-resume is disabled', async () => {
    const notRecoverable = createHarness({ recoverable: false })
    const failedRecovery = createHarness({ recovered: false })
    const autoResumeDisabled = createHarness({ autoResume: false })
    const input = {
      event: {
        type: 'session.error',
        properties: {
          sessionID: 'failed-session',
          messageID: 'assistant-message',
          error: { name: 'OtherError' },
        },
      },
    }

    await notRecoverable.handler(input)
    await failedRecovery.handler(input)
    await autoResumeDisabled.handler(input)

    expect(notRecoverable.handleSessionRecovery).not.toHaveBeenCalled()
    expect(notRecoverable.prompt).not.toHaveBeenCalled()
    expect(failedRecovery.prompt).not.toHaveBeenCalled()
    expect(autoResumeDisabled.prompt).not.toHaveBeenCalled()
  })
})
