import { describe, expect, it, spyOn } from 'bun:test'
import { readFileSync } from 'node:fs'
import identityProjection from '../../../test-fixtures/agy-cli-1.5.8/identity-projection.json'

import {
  AgyRequestSessionStore,
  buildAgyAgentRequestMetadata,
  countAgyRequestSteps,
  createAgyRequestSessionContext,
  fnv1a64Signed,
  getAgyModelEnum,
  orderAgyRequestPayloadInPlace,
} from './agy-request-metadata.ts'

type ModelMetadataFixture = {
  models: Record<
    string,
    {
      modelEnum: string
      thinkingBudget: number | null
      maxOutputTokens: number | null
    }
  >
}

const MODEL_METADATA_FIXTURES = ['1.1.3', '1.1.6', '1.1.13', '1.1.24'].map(
  (version) =>
    JSON.parse(
      readFileSync(
        new URL(
          `../../../test-fixtures/agy-cli-${version}-model-metadata.json`,
          import.meta.url,
        ),
        'utf8',
      ),
    ) as ModelMetadataFixture,
)

describe('agy request metadata', () => {
  it('matches the agy 1.5.8 signed FNV-1a session ID for the empty string', () => {
    expect(fnv1a64Signed('')).toBe('-3750763034362895579')
    expect(fnv1a64Signed('hello')).toBe('-6615550055289275125')
  })

  it('keeps contexts stable by key and allocates monotonic request timestamps', () => {
    const sessions = new AgyRequestSessionStore({
      now: () => 100,
    })

    const first = sessions.beginRequest('session-a')
    const second = sessions.beginRequest('session-a')
    const other = sessions.beginRequest('session-b')

    expect(second.session).toBe(first.session)
    expect(second.timestamp).toBe(101)
    expect(other.session).not.toBe(first.session)
    expect(other.session.numericSessionId).toBe(first.session.numericSessionId)
  })

  it('clears all stored session contexts', () => {
    const sessions = new AgyRequestSessionStore()
    sessions.getOrCreate('session-a')
    sessions.getOrCreate('session-b')

    sessions.clear()

    expect(sessions.size).toBe(0)
  })

  it('advances default generation identities even within the same millisecond', () => {
    const now = spyOn(Date, 'now').mockReturnValue(100)
    try {
      const session = createAgyRequestSessionContext()
      const payload = {
        contents: [{ role: 'user', parts: [{ text: 'prompt' }] }],
      }
      const first = buildAgyAgentRequestMetadata(
        session,
        payload,
        'gemini-3.8-flash-low',
      )
      const second = buildAgyAgentRequestMetadata(
        session,
        payload,
        'gemini-3.8-flash-low',
      )
      expect(first.labels.request_id).toBe(`${session.trajectoryId}-0`)
      expect(second.labels.request_id).toBe(`${session.trajectoryId}-1`)
      expect(first.requestId.split('/')[2]).toBe('100')
      expect(second.requestId.split('/')[2]).toBe('101')
      expect(
        buildAgyAgentRequestMetadata(
          session,
          payload,
          'gemini-3.8-flash-low',
          101,
        ),
      ).toEqual(second)
    } finally {
      now.mockRestore()
    }
  })

  it('creates stable session IDs with independently generated conversation and trajectory IDs', () => {
    expect(
      createAgyRequestSessionContext({
        conversationId: 'conversation-id',
        trajectoryId: 'trajectory-id',
      }),
    ).toEqual({
      conversationId: 'conversation-id',
      trajectoryId: 'trajectory-id',
      numericSessionId: '-3750763034362895579',
    })
  })

  it('orders request fields like captured agy payloads', () => {
    const payload: Record<string, unknown> = {
      generationConfig: {},
      sessionId: 'session',
      contents: [],
      labels: {},
      tools: [],
      systemInstruction: {},
    }

    orderAgyRequestPayloadInPlace(payload)

    expect(Object.keys(payload)).toEqual([
      'contents',
      'systemInstruction',
      'tools',
      'labels',
      'generationConfig',
      'sessionId',
    ])
  })

  it('counts contents regardless of part count, as captured in agy 1.5.8', () => {
    // agy 1.5.8 counts content entries, not thinking/tool parts or execution steps.
    const payload = {
      contents: [
        { role: 'user', parts: [{ text: 'prompt' }] },
        {
          role: 'model',
          parts: [
            { text: 'thinking', thought: true },
            { functionCall: { name: 'read', args: {} } },
          ],
        },
        {
          role: 'user',
          parts: [{ functionResponse: { name: 'read', response: {} } }],
        },
      ],
    }

    expect(countAgyRequestSteps(payload)).toBe(3)
    expect(countAgyRequestSteps({ contents: [] })).toBe(0)
    expect(countAgyRequestSteps({})).toBe(0)
  })

  it('counts a function response once as a content entry in agy 1.5.8', () => {
    const payload = {
      contents: [
        { role: 'user', parts: [{ text: 'prompt' }] },
        {
          role: 'model',
          parts: [
            {
              functionCall: { name: 'read', args: {} },
              thoughtSignature: 'sig',
            },
          ],
        },
        {
          role: 'model',
          parts: [{ functionResponse: { name: 'read', response: {} } }],
        },
      ],
    }

    expect(countAgyRequestSteps(payload)).toBe(3)
  })

  it('builds captured Claude request IDs, labels, and numeric session ID', () => {
    // The agy 1.5.8 labels identify both cascade IDs and a generation counter.
    const session = createAgyRequestSessionContext({
      conversationId: 'conversation-id',
      trajectoryId: 'trajectory-id',
    })
    const metadata = buildAgyAgentRequestMetadata(
      session,
      {
        contents: [
          { role: 'user', parts: [{ text: 'prompt' }] },
          {
            role: 'model',
            parts: [
              { text: 'thinking', thought: true },
              { functionCall: { name: 'read', args: {} } },
            ],
          },
          {
            role: 'user',
            parts: [{ functionResponse: { name: 'read', response: {} } }],
          },
        ],
      },
      'claude-sonnet-4-6',
      1_784_285_195_116,
    )

    expect(metadata).toEqual({
      requestId: 'agent/conversation-id/1784285195116/trajectory-id/3',
      sessionId: '-3750763034362895579',
      lastStepIndex: 2,
      labels: {
        cascade_id: 'conversation-id',
        last_step_index: '2',
        model_enum: 'MODEL_PLACEHOLDER_M35',
        request_id: 'trajectory-id-0',
        root_cascade_id: 'conversation-id',
        trajectory_id: 'trajectory-id',
        used_claude: 'true',
        used_claude_conservative: 'true',
        used_non_gemini_model: 'true',
      },
    })
  })

  it('matches every captured agy model enum fixture', () => {
    const expectedKeys = [
      [
        'gemini-3.5-flash-extra-low',
        'gemini-3.5-flash-low',
        'gemini-3-flash-agent',
        'gemini-3.1-pro-low',
        'gemini-pro-agent',
        'claude-sonnet-4-6',
        'claude-opus-4-6-thinking',
        'gemini-3.1-flash-image',
        'gpt-oss-120b-medium',
      ],
      [
        'gemini-3.6-flash-low',
        'gemini-3.6-flash-medium',
        'gemini-3.6-flash-high',
      ],
      [
        'gemini-3.7-flash-low',
        'gemini-3.7-flash-medium',
        'gemini-3.7-flash-high',
      ],
      [
        'gemini-3.8-flash-low',
        'gemini-3.8-flash-medium',
        'gemini-3.8-flash-high',
      ],
    ]
    expect(MODEL_METADATA_FIXTURES).toHaveLength(4)
    for (const [index, fixture] of MODEL_METADATA_FIXTURES.entries()) {
      expect(Object.keys(fixture.models).sort()).toEqual(
        expectedKeys[index]!.sort(),
      )
      for (const [model, expected] of Object.entries(fixture.models)) {
        expect(getAgyModelEnum(model), model).toBe(expected.modelEnum)
      }
    }
  })

  it('keeps cumulative non-Gemini usage flags when a session switches back to Gemini', () => {
    const session = createAgyRequestSessionContext({
      conversationId: 'conversation-id',
      trajectoryId: 'trajectory-id',
    })
    const payload = {
      contents: [{ role: 'user', parts: [{ text: 'prompt' }] }],
    }

    buildAgyAgentRequestMetadata(session, payload, 'claude-sonnet-4-6', 1)
    const gemini = buildAgyAgentRequestMetadata(
      session,
      payload,
      'gemini-3-flash-agent',
      2,
    )

    expect(gemini.labels.used_claude).toBe('true')
    expect(gemini.labels.used_claude_conservative).toBe('true')
    expect(gemini.labels.used_non_gemini_model).toBe('true')
  })

  it('replays the agy 1.5.8 four-turn model switch with fresh execution IDs', () => {
    const session = createAgyRequestSessionContext()
    let previousExecutionId: string | undefined
    for (const [index, capture] of identityProjection.runs[
      'r4-turns'
    ].entries()) {
      const contents = capture.contents_shape.map((content) => ({
        role: content.role,
        parts: content.parts_keys.map((keys) =>
          Object.fromEntries(keys.map((key) => [key, 'text'])),
        ),
      }))
      const metadata = buildAgyAgentRequestMetadata(
        session,
        { contents },
        capture.model,
        index + 1,
      )
      expect(metadata.lastStepIndex).toBe(
        Number(capture.labels.last_step_index),
      )
      expect(metadata.requestId.split('/').at(-1)).toBe(
        String(capture.contents_count),
      )
      expect(metadata.labels).toMatchObject({
        cascade_id: session.conversationId,
        root_cascade_id: session.conversationId,
        trajectory_id: session.trajectoryId,
        request_id: `${session.trajectoryId}-${index}`,
        used_claude: capture.labels.used_claude,
        used_claude_conservative: capture.labels.used_claude_conservative,
        used_non_gemini_model: capture.labels.used_non_gemini_model,
      })
      if (index === 0)
        expect(metadata.labels).not.toHaveProperty('last_execution_id')
      else {
        expect(metadata.labels.last_execution_id).toMatch(/^[\da-f-]{36}$/)
        expect(metadata.labels.last_execution_id).not.toBe(previousExecutionId)
      }
      previousExecutionId = metadata.labels.last_execution_id
      expect(
        buildAgyAgentRequestMetadata(
          session,
          { contents },
          capture.model,
          index + 1,
        ),
      ).toEqual(metadata)
    }
  })

  it('omits an unverified model enum while retaining safe labels', () => {
    const session = createAgyRequestSessionContext({
      conversationId: 'conversation-id',
      trajectoryId: 'trajectory-id',
    })
    const metadata = buildAgyAgentRequestMetadata(
      session,
      { contents: [{ role: 'user', parts: [{ text: 'prompt' }] }] },
      'unknown-model',
      1,
    )

    expect(metadata.labels).not.toHaveProperty('model_enum')
    expect(metadata.labels.used_claude).toBe('false')
    expect(metadata.labels.used_non_gemini_model).toBe('false')
  })
})
