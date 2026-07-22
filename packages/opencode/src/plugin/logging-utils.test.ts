import { describe, expect, it, spyOn } from 'bun:test'
import {
  deriveDebugPolicy,
  formatAccountContextLabel,
  formatAccountLabel,
  formatBodyPreviewForLog,
  formatErrorForLog,
  redactSensitive,
  redactSensitiveFields,
  truncateTextForLog,
  writeConsoleLog,
} from './logging-utils'

describe('deriveDebugPolicy', () => {
  it('keeps debug_tui disabled when debug is disabled', () => {
    const policy = deriveDebugPolicy({
      configDebug: false,
      configDebugTui: true,
      envDebugFlag: '',
      envDebugTuiFlag: '1',
    })

    expect(policy.debugEnabled).toBe(false)
    expect(policy.debugTuiEnabled).toBe(false)
    expect(policy.verboseEnabled).toBe(false)
    expect(policy.debugLevel).toBe(0)
  })

  it('supports verbose mode override when debug config is enabled', () => {
    const policy = deriveDebugPolicy({
      configDebug: true,
      configDebugTui: false,
      envDebugFlag: 'verbose',
      envDebugTuiFlag: '',
    })

    expect(policy.debugEnabled).toBe(true)
    expect(policy.debugTuiEnabled).toBe(false)
    expect(policy.verboseEnabled).toBe(true)
    expect(policy.debugLevel).toBe(2)
  })
})

describe('format helpers', () => {
  it('formats account labels consistently', () => {
    expect(formatAccountLabel('person@example.com', 4)).toBe(
      'person@example.com',
    )
    expect(formatAccountLabel(undefined, 1)).toBe('Account 2')
    expect(formatAccountContextLabel(undefined, -1)).toBe('All accounts')
    expect(formatAccountContextLabel(undefined, 0)).toBe('Account 1')
  })

  it('formats errors defensively', () => {
    expect(formatErrorForLog(new Error('boom'))).toContain('boom')
    expect(formatErrorForLog({ code: 401 })).toBe('{"code":401}')

    const circular: { self?: unknown } = {}
    circular.self = circular
    expect(formatErrorForLog(circular)).toContain('[object Object]')
  })

  it('truncates long text with metadata', () => {
    const longText = 'x'.repeat(12)
    expect(truncateTextForLog(longText, 5)).toBe('xxxxx... (truncated 7 chars)')
    expect(truncateTextForLog('short', 10)).toBe('short')
  })

  it('formats body previews safely', () => {
    expect(formatBodyPreviewForLog('abcdef', 3)).toBe(
      'abc... (truncated 3 chars)',
    )
    expect(
      formatBodyPreviewForLog(new URLSearchParams({ q: 'value' }), 100),
    ).toBe('q=value')
    expect(formatBodyPreviewForLog(new Uint8Array([1, 2]), 100)).toBe(
      '[Uint8Array payload omitted]',
    )
  })
})

describe('writeConsoleLog', () => {
  it('routes to the level-specific console method', () => {
    const debugSpy = spyOn(console, 'debug').mockImplementation(() => {})
    const infoSpy = spyOn(console, 'info').mockImplementation(() => {})
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {})

    writeConsoleLog('debug', 'dbg')
    writeConsoleLog('info', 'inf')
    writeConsoleLog('warn', 'wrn')
    writeConsoleLog('error', 'err')

    expect(debugSpy).toHaveBeenCalledWith('dbg')
    expect(infoSpy).toHaveBeenCalledWith('inf')
    expect(warnSpy).toHaveBeenCalledWith('wrn')
    expect(errorSpy).toHaveBeenCalledWith('err')

    debugSpy.mockRestore()
    infoSpy.mockRestore()
    warnSpy.mockRestore()
    errorSpy.mockRestore()
  })
})

describe('redactSensitive', () => {
  it('masks all but the first 4 and last 4 characters', () => {
    expect(redactSensitive('my-project-1234567890abcdef')).toBe('my-p****cdef')
  })

  it('collapses short values to a placeholder so the full identifier never leaks', () => {
    expect(redactSensitive('short')).toBe('****')
    expect(redactSensitive('12345678')).toBe('****')
  })

  it('returns empty string for missing inputs', () => {
    expect(redactSensitive(undefined)).toBe('')
    expect(redactSensitive(null)).toBe('')
    expect(redactSensitive('')).toBe('')
  })
})

describe('redactSensitiveFields', () => {
  it('walks a deep object and masks every credential-shaped field', () => {
    const input = {
      projectId: 'my-project-1234567890abcdef',
      accessToken: 'ya29.abcdef-real-token-real-token',
      refreshToken: '1//abc-real-refresh-token',
      deviceId: 'dev-1234567890abcdef',
      fingerprint: 'fpr-1234567890abcdef',
      quota: {
        claude: 0.5,
        gemini: 0.9,
      },
      nested: {
        sessionId: 'sess-1234567890abcdef',
        unrelated: 'visible',
      },
    }
    const redacted = redactSensitiveFields(input) as Record<string, unknown>
    expect(redacted.projectId).toBe('my-p****cdef')
    expect(redacted.accessToken).toBe('ya29****oken')
    expect(redacted.refreshToken).toBe('1//a****oken')
    expect(redacted.deviceId).toBe('dev-****cdef')
    expect(redacted.fingerprint).toBe('fpr-****cdef')
    expect((redacted.quota as Record<string, unknown>).claude).toBe(0.5)
    expect((redacted.nested as Record<string, unknown>).sessionId).toBe(
      'sess****cdef',
    )
    expect((redacted.nested as Record<string, unknown>).unrelated).toBe(
      'visible',
    )
  })

  it('does not mutate the original', () => {
    const input = { projectId: 'my-project-1234567890abcdef' }
    const snapshot = JSON.stringify(input)
    redactSensitiveFields(input)
    expect(JSON.stringify(input)).toBe(snapshot)
  })
})
