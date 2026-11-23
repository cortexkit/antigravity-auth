import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

import {
  createOpenCodeV2Harness,
  type OpenCodeV2Harness,
} from './opencode-v2-harness.ts'

let harness: OpenCodeV2Harness | undefined

afterEach(async () => {
  await harness?.dispose()
  harness = undefined
})

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected an object')
  }
  return value as Record<string, unknown>
}

describe('OpenCode 2 host flow', () => {
  it('loads the built server contract and routes a real host request through Antigravity', async () => {
    harness = await createOpenCodeV2Harness()

    const result = await harness.run(
      'google/gemini-3.8-flash#medium',
      'Reply with the exact text E2E_OK.',
    )

    expect({ result, requests: harness.requests }).toMatchObject({
      result: { timedOut: false, code: 0 },
    })
    expect(result.stdout).toContain('E2E_OK')
    expect(existsSync(harness.databaseFile)).toBe(true)
    expect(
      harness.databaseFile.startsWith(process.env.ANTIGRAVITY_TEST_ROOT!),
    ).toBe(true)
    expect(existsSync(harness.logFile)).toBe(true)
    if (process.platform !== 'win32') {
      expect(statSync(harness.logFile).mode & 0o777).toBe(0o600)
      expect(statSync(dirname(harness.logFile)).mode & 0o777).toBe(0o700)
    }
    expect(
      harness.requests
        .filter((request) => request.kind === 'direct-provider')
        .map((request) => request.path),
    ).toEqual([])

    const routed = harness.requests.filter(
      (request) => request.kind === 'adapter',
    )
    expect(routed.length).toBeGreaterThan(0)

    const envelope = asRecord(
      routed.find(
        (recorded) =>
          asRecord(recorded.body).model === 'gemini-3.8-flash-medium',
      )?.body,
    )
    expect(envelope.model).toBe('gemini-3.8-flash-medium')
    expect(envelope.project).toBe('opencode-v2-e2e-project')
    expect(envelope.userAgent).toBe('antigravity')
    expect(envelope.requestType).toBe('agent')

    const request = asRecord(envelope.request)
    const labels = asRecord(request.labels)
    expect(labels.model_enum).toBe('MODEL_PLACEHOLDER_M319')
    expect(typeof labels.trajectory_id).toBe('string')
    expect(typeof request.sessionId).toBe('string')

    const tools = request.tools
    expect(Array.isArray(tools)).toBe(true)
    expect(tools).not.toHaveLength(0)
    const toolConfig = asRecord(request.toolConfig)
    expect(asRecord(toolConfig.functionCallingConfig).mode).toBe('VALIDATED')

    const contents = request.contents
    if (!Array.isArray(contents)) throw new Error('AGY request has no contents')
    expect(asRecord(contents.at(-1)).role).toBe('user')
  }, 30_000)

  it('preserves signed tool calls and native function-response roles across a real host continuation', async () => {
    harness = await createOpenCodeV2Harness('tool-roundtrip')

    const result = await harness.run(
      'google/gemini-3.8-flash#medium',
      'Read README.md, then reply with the exact text E2E_OK.',
    )

    expect({ result, requests: harness.requests }).toMatchObject({
      result: { timedOut: false, code: 0 },
    })
    expect(result.stdout).toContain('E2E_OK')
    const routed = harness.requests.filter(
      (request) =>
        request.path === '/agy/primary' &&
        asRecord(request.body).model === 'gemini-3.8-flash-medium',
    )
    expect(routed).toHaveLength(2)

    const continuationEnvelope = asRecord(routed[1]?.body)
    const continuationRequest = asRecord(continuationEnvelope.request)
    const contents = continuationRequest.contents
    if (!Array.isArray(contents)) {
      throw new Error('Tool continuation has no contents')
    }
    const contentRecords = contents.map(asRecord)
    const parts = contentRecords.flatMap((content) =>
      Array.isArray(content.parts) ? content.parts.map(asRecord) : [],
    )
    const functionCall = parts.find((part) => part.functionCall)
    expect(functionCall?.thoughtSignature).toBe('s'.repeat(64))
    const responseContent = contentRecords.find((content) =>
      Array.isArray(content.parts)
        ? content.parts.some((part) => asRecord(part).functionResponse)
        : false,
    )
    expect(responseContent?.role).toBe('model')
    expect(contentRecords.at(-1)).toEqual({
      role: 'user',
      parts: [{ text: '[Continue]' }],
    })

    const labels = asRecord(continuationRequest.labels)
    expect(labels.last_step_index).toBe(String(parts.length))
    expect(String(continuationEnvelope.requestId)).toEndWith(
      `/${parts.length + 1}`,
    )
  }, 30_000)

  it('preserves native Claude tool signatures across a real host continuation', async () => {
    harness = await createOpenCodeV2Harness('tool-roundtrip')

    const result = await harness.run(
      'google/claude-sonnet-4-6-thinking',
      'Read README.md, then reply with the exact text E2E_OK.',
    )

    expect({ result, requests: harness.requests }).toMatchObject({
      result: { timedOut: false, code: 0 },
    })
    expect(result.stdout).toContain('E2E_OK')
    const routed = harness.requests.filter(
      (request) =>
        request.path === '/agy/primary' &&
        asRecord(request.body).model === 'claude-sonnet-4-6',
    )
    expect(routed).toHaveLength(2)
    const continuationRequest = asRecord(asRecord(routed[1]?.body).request)
    const contents = continuationRequest.contents
    if (!Array.isArray(contents)) {
      throw new Error('Claude tool continuation has no contents')
    }
    const functionCall = contents
      .map(asRecord)
      .flatMap((content) =>
        Array.isArray(content.parts) ? content.parts.map(asRecord) : [],
      )
      .find((part) => part.functionCall)
    expect(functionCall?.thoughtSignature).toBe('s'.repeat(64))
  }, 30_000)

  it('applies the native Claude thinking contract on a real host request', async () => {
    harness = await createOpenCodeV2Harness()

    const result = await harness.run(
      'google/claude-sonnet-4-6-thinking',
      'Reply with the exact text E2E_OK.',
    )

    expect({ result, requests: harness.requests }).toMatchObject({
      result: { timedOut: false, code: 0 },
    })
    expect(result.stdout).toContain('E2E_OK')
    const envelope = asRecord(
      harness.requests.find(
        (request) =>
          request.path === '/agy/primary' &&
          asRecord(request.body).model === 'claude-sonnet-4-6',
      )?.body,
    )
    expect(envelope.model).toBe('claude-sonnet-4-6')
    const request = asRecord(envelope.request)
    const generationConfig = asRecord(request.generationConfig)
    expect(generationConfig.thinkingConfig).toEqual({
      includeThoughts: true,
      thinkingBudget: 1024,
    })
    expect(generationConfig.maxOutputTokens).toBe(64_000)
    expect(request.providerOptions).toBeUndefined()
    expect(
      asRecord(asRecord(request.toolConfig).functionCallingConfig).mode,
    ).toBe('VALIDATED')
  }, 30_000)

  it('serves an owned text-generation request without calling the native provider', async () => {
    harness = await createOpenCodeV2Harness()
    const result = await harness.run(
      'google/gemini-3.8-flash#low',
      'Reply with the exact text E2E_OK.',
    )

    expect(result).toMatchObject({ timedOut: false, code: 0 })
    expect(result.stdout).toContain('E2E_OK')
    expect(
      harness.requests.filter(({ kind }) => kind === 'direct-provider'),
    ).toEqual([])
    expect(
      harness.requests.find(
        ({ path, body }) =>
          path === '/agy/primary' &&
          asRecord(body).model === 'gemini-3.8-flash-low',
      ),
    ).toBeDefined()
  }, 30_000)

  it('disables an ineligible account on disk and rotates to the next account', async () => {
    harness = await createOpenCodeV2Harness('account-ineligible')

    const result = await harness.run(
      'google/gemini-3.8-flash#medium',
      'Reply with the exact text E2E_OK.',
    )

    expect({ result, requests: harness.requests }).toMatchObject({
      result: { timedOut: false, code: 0 },
    })
    expect(result.stdout).toContain('E2E_OK')
    const primaryRequests = harness.requests.filter(
      (request) =>
        request.path === '/agy/primary' &&
        asRecord(request.body).model === 'gemini-3.8-flash-medium',
    )
    expect(primaryRequests).toHaveLength(2)
    expect(primaryRequests[0]?.authorization).not.toBe(
      primaryRequests[1]?.authorization,
    )

    const rejectedRefresh = primaryRequests[0]?.authorization
      ?.replace(/^Bearer /, '')
      .replace(/-access$/, '')
    expect(rejectedRefresh).toBeTruthy()
    const storage = JSON.parse(readFileSync(harness.accountsFile, 'utf8')) as {
      accounts: Array<Record<string, unknown>>
    }
    const rejected = storage.accounts.find(
      (account) => account.refreshToken === rejectedRefresh,
    )
    const replacement = storage.accounts.find(
      (account) => account.refreshToken !== rejectedRefresh,
    )
    expect(rejected).toMatchObject({
      refreshToken: rejectedRefresh,
      enabled: false,
      accountIneligible: true,
      accountIneligibleReason: 'ACCOUNT_INELIGIBLE',
    })
    expect(replacement).toMatchObject({ enabled: true })
  }, 30_000)

  it('falls back from daily to prod on model capacity exhaustion', async () => {
    harness = await createOpenCodeV2Harness('capacity-fallback')

    const result = await harness.run(
      'google/gemini-3.8-flash#medium',
      'Reply with the exact text E2E_OK.',
    )

    expect({ result, requests: harness.requests }).toMatchObject({
      result: { timedOut: false, code: 0 },
    })
    expect(result.stdout).toContain('E2E_OK')
    const requests = harness.requests.filter(
      (request) =>
        request.path === '/agy/primary' &&
        asRecord(request.body).model === 'gemini-3.8-flash-medium',
    )
    expect(requests.map((request) => request.endpoint)).toEqual([
      'https://daily-cloudcode-pa.googleapis.com',
      'https://cloudcode-pa.googleapis.com',
    ])
  }, 30_000)

  it('propagates terminal transport failure after one pass over endpoint fallbacks', async () => {
    harness = await createOpenCodeV2Harness('transport-reset')

    const result = await harness.run(
      'google/gemini-3.8-flash#medium',
      'This request must expose the transport failure.',
    )

    expect({ result, requests: harness.requests }).toMatchObject({
      result: { timedOut: false, code: 1 },
    })
    expect(
      harness.requests.filter(
        (request) =>
          request.path === '/agy/primary' &&
          asRecord(request.body).model === 'gemini-3.8-flash-medium',
      ),
    ).toHaveLength(2)
  }, 30_000)

  it('surfaces an embedded Antigravity SSE error through the host error path', async () => {
    harness = await createOpenCodeV2Harness('embedded-error')

    const result = await harness.run(
      'google/gemini-3.8-flash#medium',
      'This request must expose the embedded stream failure.',
    )

    expect({ result, requests: harness.requests }).toMatchObject({
      result: { timedOut: false, code: 1 },
    })
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      'OpenCode 2 embedded E2E failure',
    )
    expect(
      harness.requests.filter(
        (request) =>
          request.path === '/agy/primary' &&
          asRecord(request.body).model === 'gemini-3.8-flash-medium',
      ),
    ).toHaveLength(1)
  }, 30_000)

  it('surfaces a clean upstream EOF as a host error without replaying the request', async () => {
    harness = await createOpenCodeV2Harness('clean-eof')

    const result = await harness.run(
      'google/gemini-3.8-flash#medium',
      'This request must fail at the mock stream boundary.',
    )

    expect({ result, requests: harness.requests }).toMatchObject({
      result: { timedOut: false, code: 1 },
    })
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      'Antigravity stream ended before a terminal frame',
    )
    expect(
      harness.requests.filter(
        (request) =>
          request.path === '/agy/primary' &&
          asRecord(request.body).model === 'gemini-3.8-flash-medium',
      ),
    ).toHaveLength(1)
  }, 30_000)
})
