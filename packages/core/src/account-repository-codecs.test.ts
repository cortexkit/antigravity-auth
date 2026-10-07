import { describe, expect, it } from 'bun:test'

import {
  AccountCodecError,
  createProviderStateCodec,
  decodeProviderMetadata,
  decodeProviderState,
  decodeQuotaState,
  decodeRoutingSettings,
  decodeRowRef,
  encodeProviderMetadata,
  encodeProviderState,
  encodeQuotaState,
  encodeRoutingSettings,
  encodeRowRef,
  isValidProviderState,
  isValidQuotaState,
  mergeQuotaState,
  providerStateCredentialBound,
  QUOTA_CODEC,
} from './account-repository-codecs.ts'
import {
  CREDENTIAL_BOUND_METADATA_FIELDS,
  type JsonObject,
  legacyAccountsLock,
  type ProviderMetadata,
  type ProviderStateEnvelope,
  type ProviderStatePolicy,
  refreshProviderLock,
} from './account-repository-types.ts'

// Every value below is synthetic. Nothing here reads account files or talks
// to a provider.

/**
 * A stand-in for the repository's rules: merge lets incoming metadata fields
 * win, and a replace keeps only the metadata handed to it.
 */
const testPolicy: ProviderStatePolicy = {
  merge: (onDisk, incoming) => ({
    ...onDisk,
    metadata: { ...onDisk.metadata, ...incoming.metadata },
  }),
  onReplace: (_previous, replacement) => replacement.incoming,
}
const PROVIDER_STATE_CODEC = createProviderStateCodec(testPolicy)

const json = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

function fingerprintWire(seed: string, extra: JsonObject = {}): JsonObject {
  return {
    deviceId: `device-${seed}`,
    sessionToken: `session-${seed}`,
    userAgent: `antigravity-cli/test ${seed}`,
    apiClient: 'antigravity-cli',
    clientMetadata: {
      ideType: 'IDE_UNSPECIFIED',
      platform: 'darwin',
      pluginType: 'GEMINI',
      osVersion: 'legacy-extra',
    },
    createdAt: 1_700_000_000_000,
    ...extra,
  }
}

/** A v4 metadata record carrying every field the field map names. */
function fullMetadataWire(): JsonObject {
  return {
    email: 'Synthetic.User+Tag@Example.TEST',
    projectId: 'proj-synthetic',
    managedProjectId: 'managed-synthetic',
    addedAt: 1_700_000_000_001,
    lastUsed: 1_700_000_000_002,
    enabled: false,
    lastSwitchReason: 'rate-limit',
    rateLimitResetTimes: {
      claude: 1_700_000_100_000,
      'gemini-antigravity': null,
      'gemini-cli': 1_700_000_200_000,
      'gemini-antigravity:gemini-3-pro': 1_700_000_300_000,
    },
    coolingDownUntil: 1_700_000_400_000,
    cooldownReason: 'project-error',
    label: 'work laptop',
    fingerprint: fingerprintWire('current', { futureField: { nested: [1] } }),
    fingerprintHistory: [
      {
        fingerprint: fingerprintWire('h0'),
        timestamp: 1_699_000_000_000,
        reason: 'initial',
      },
      {
        fingerprint: fingerprintWire('h1'),
        timestamp: 1_699_100_000_000,
        reason: 'regenerated',
        note: 'kept',
      },
      {
        fingerprint: fingerprintWire('h2'),
        timestamp: 1_699_200_000_000,
        reason: 'restored',
      },
    ],
    verificationRequired: true,
    verificationRequiredAt: 1_700_000_500_000,
    verificationRequiredReason: 'Verify your account',
    verificationUrl:
      'https://accounts.google.com/signin/continue?plt=synthetic',
    accountIneligible: false,
    accountIneligibleAt: 1_700_000_600_000,
    accountIneligibleReason: 'ineligible reason',
    eligibilityStateUpdatedAt: 1_700_000_700_000,
    capturedTierId: 'free-tier',
    capturedPaidTierId: 'g1-pro-tier',
    capturedTierAt: 1_700_000_800_000,
    capturedTierSchemaVersion: 2,
    dailyRequestCounts: { date: '2023-11-14', claude: 3, gemini: 0 },
    futureTopLevel: { anything: ['goes', null, true, 1.5] },
  }
}

function fullEnvelopeWire(): JsonObject {
  return {
    schemaVersion: 1,
    metadata: fullMetadataWire(),
    envelopeExtra: 'kept',
  }
}

function fullQuotaWire(): JsonObject {
  return {
    schemaVersion: 1,
    cachedQuotaAccountId: 'opaque-account-stamp',
    cachedQuota: {
      claude: {
        remainingFraction: 0.123456789,
        resetTime: '2023-11-15T00:00:00Z',
        modelCount: 2,
        windows: [
          {
            window: 'weekly',
            remainingFraction: 0.5,
            resetTime: '2023-11-20T00:00:00Z',
          },
          {
            window: '5h',
            remainingFraction: 0.25,
            resetTime: '2023-11-14T05:00:00Z',
            extraWindowField: 7,
          },
        ],
      },
      'gemini-pro': {
        remainingFraction: null,
        resetTime: null,
        modelCount: 0,
        windows: null,
      },
      'gemini-flash': { modelCount: 1, windows: [] },
    },
    cachedPerModelQuota: [
      {
        modelId: 'claude-sonnet',
        displayName: 'Claude Sonnet',
        group: 'claude',
        remainingFraction: 0.9,
        resetTime: '2023-11-15T00:00:00Z',
      },
      { modelId: 'orphan-model', group: null, remainingFraction: 0 },
      {
        modelId: 'gemini-flash',
        displayName: null,
        group: 'gemini-flash',
        remainingFraction: 1,
        resetTime: null,
        upstreamOnly: { a: 1 },
      },
    ],
    cachedQuotaUpdatedAt: 1_700_000_900_000,
    quotaExtra: [1, 2, 3],
  }
}

function expectRefused(action: () => unknown, path: string): AccountCodecError {
  let caught: unknown
  try {
    action()
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(AccountCodecError)
  const error = caught as AccountCodecError
  expect(error.path).toBe(path)
  return error
}

function withMetadata(patch: Record<string, unknown>): Record<string, unknown> {
  return {
    schemaVersion: 1,
    metadata: { ...fullMetadataWire(), ...patch },
  }
}

describe('provider-state codec roundtrip', () => {
  it('roundtrips every field-map field and unknown key losslessly', () => {
    const wire = fullEnvelopeWire()
    const decoded = decodeProviderState(json(wire))
    const encoded = encodeProviderState(decoded)

    expect(encoded).toEqual(wire)
    expect(json(encoded)).toEqual(wire)
    expect(decodeProviderState(encoded)).toEqual(decoded)
    expect(isValidProviderState(wire)).toBe(true)
    expect(PROVIDER_STATE_CODEC.validate(wire)).toBe(true)
  })

  it('moves unknown JSON into extensions at every nesting level', () => {
    const decoded = decodeProviderState(fullEnvelopeWire())
    const metadata = decoded.metadata

    expect(decoded.extensions).toEqual({ envelopeExtra: 'kept' })
    expect(metadata.extensions).toEqual({
      futureTopLevel: { anything: ['goes', null, true, 1.5] },
    })
    expect(metadata.fingerprint?.extensions).toEqual({
      futureField: { nested: [1] },
    })
    expect(metadata.fingerprint?.clientMetadata.extensions).toEqual({
      osVersion: 'legacy-extra',
    })
    expect(metadata.fingerprintHistory?.[1]?.extensions).toEqual({
      note: 'kept',
    })
    // A record without unknown keys gets no empty extensions slot.
    expect(metadata.dailyRequestCounts).toEqual({
      date: '2023-11-14',
      claude: 3,
      gemini: 0,
    })
    expect(Object.hasOwn(metadata.dailyRequestCounts ?? {}, 'extensions')).toBe(
      false,
    )
  })

  it('keeps the email exactly as written', () => {
    const decoded = decodeProviderState(fullEnvelopeWire())
    expect(decoded.metadata.email).toBe('Synthetic.User+Tag@Example.TEST')
  })

  it('keeps null and absent apart for every optional field', () => {
    const optionalFields = Object.keys(fullMetadataWire()).filter(
      (key) => !['addedAt', 'lastUsed', 'futureTopLevel'].includes(key),
    )
    const allNull: Record<string, unknown> = { addedAt: 1, lastUsed: 2 }
    for (const key of optionalFields) allNull[key] = null

    const nullDecoded = decodeProviderMetadata(allNull)
    for (const key of optionalFields) {
      expect(Object.hasOwn(nullDecoded, key)).toBe(true)
      expect(nullDecoded[key as keyof ProviderMetadata]).toBeNull()
    }
    expect<unknown>(encodeProviderMetadata(nullDecoded)).toEqual(allNull)

    const minimal = { addedAt: 1, lastUsed: 2 }
    const minimalDecoded = decodeProviderMetadata(minimal)
    expect(Object.keys(minimalDecoded).sort()).toEqual(['addedAt', 'lastUsed'])
    expect(encodeProviderMetadata(minimalDecoded)).toEqual(minimal)
  })

  it('keeps empty collections instead of dropping them', () => {
    const wire = withMetadata({
      rateLimitResetTimes: {},
      fingerprintHistory: [],
    })
    const decoded = decodeProviderState(wire)
    expect(decoded.metadata.rateLimitResetTimes).toEqual({})
    expect(decoded.metadata.fingerprintHistory).toEqual([])
    expect<unknown>(encodeProviderState(decoded)).toEqual(wire)
  })

  it('keeps every dynamic rate-limit key in order and an untruncated ordered history', () => {
    const resets = {
      'gemini-cli': 5,
      claude: null,
      gemini: 4,
      'claude-opus:thinking': 3,
      constructor: 2,
    }
    const history = Array.from({ length: 8 }, (_, index) => ({
      fingerprint: fingerprintWire(`h${index}`),
      timestamp: 1_000 + index,
      reason: index === 0 ? 'initial' : 'regenerated',
    }))
    const wire = withMetadata({
      rateLimitResetTimes: resets,
      fingerprintHistory: history,
    })

    const decoded = decodeProviderState(wire)
    expect(Object.keys(decoded.metadata.rateLimitResetTimes ?? {})).toEqual(
      Object.keys(resets),
    )
    expect(
      Object.getOwnPropertyDescriptor(
        decoded.metadata.rateLimitResetTimes ?? {},
        'constructor',
      )?.value,
    ).toBe(2)
    expect(
      decoded.metadata.fingerprintHistory?.map((entry) => entry.timestamp),
    ).toEqual(history.map((entry) => entry.timestamp))
    expect<unknown>(encodeProviderState(decoded)).toEqual(wire)
  })

  it('returns copies that do not alias the input', () => {
    const wire = fullEnvelopeWire()
    const decoded = decodeProviderState(wire)
    const fingerprint = decoded.metadata.fingerprint
    if (!fingerprint) throw new Error('fixture has a fingerprint')
    fingerprint.deviceId = 'changed'
    expect(
      (wire.metadata as { fingerprint: { deviceId: string } }).fingerprint
        .deviceId,
    ).toBe('device-current')
  })

  it('encodes a typed value built in memory and reads it back unchanged', () => {
    const typed: ProviderStateEnvelope = {
      schemaVersion: 1,
      metadata: {
        addedAt: 10,
        lastUsed: 20,
        email: null,
        enabled: true,
        dailyRequestCounts: { date: '2024-01-01', claude: 0, gemini: 1 },
        extensions: { carried: { from: 'newer build' } },
      },
    }
    const wire = encodeProviderState(typed)
    expect(wire).toEqual({
      schemaVersion: 1,
      metadata: {
        addedAt: 10,
        lastUsed: 20,
        email: null,
        enabled: true,
        dailyRequestCounts: { date: '2024-01-01', claude: 0, gemini: 1 },
        carried: { from: 'newer build' },
      },
    })
    expect(decodeProviderState(wire)).toEqual(typed)
  })
})

describe('provider-state codec refusals', () => {
  const cases: Array<[string, () => unknown, string]> = [
    [
      'a credential field in metadata',
      () => decodeProviderState(withMetadata({ refreshToken: 'synthetic-rt' })),
      '$.metadata.refreshToken',
    ],
    [
      'a credential field beside the metadata',
      () =>
        decodeProviderState({
          ...fullEnvelopeWire(),
          refreshToken: 'synthetic-rt',
        }),
      '$.refreshToken',
    ],
    [
      'a newer schema version',
      () => decodeProviderState({ ...fullEnvelopeWire(), schemaVersion: 2 }),
      '$.schemaVersion',
    ],
    [
      'a missing schema version',
      () => decodeProviderState({ metadata: fullMetadataWire() }),
      '$.schemaVersion',
    ],
    [
      'missing metadata',
      () => decodeProviderState({ schemaVersion: 1 }),
      '$.metadata',
    ],
    [
      'a missing addedAt',
      () => {
        const metadata = fullMetadataWire()
        delete metadata.addedAt
        return decodeProviderState({ schemaVersion: 1, metadata })
      },
      '$.metadata.addedAt',
    ],
    [
      'a null lastUsed',
      () => decodeProviderState(withMetadata({ lastUsed: null })),
      '$.metadata.lastUsed',
    ],
    [
      'a non-finite timestamp',
      () => decodeProviderState(withMetadata({ coolingDownUntil: Number.NaN })),
      '$.metadata.coolingDownUntil',
    ],
    [
      'a numeric string where a number belongs',
      () => decodeProviderState(withMetadata({ capturedTierAt: '5' })),
      '$.metadata.capturedTierAt',
    ],
    [
      'a non-string email',
      () => decodeProviderState(withMetadata({ email: 42 })),
      '$.metadata.email',
    ],
    [
      'a non-boolean enabled encoding',
      () => decodeProviderState(withMetadata({ enabled: 'false' })),
      '$.metadata.enabled',
    ],
    [
      'an unknown switch reason',
      () => decodeProviderState(withMetadata({ lastSwitchReason: 'manual' })),
      '$.metadata.lastSwitchReason',
    ],
    [
      'an unknown cooldown reason',
      () => decodeProviderState(withMetadata({ cooldownReason: 'tired' })),
      '$.metadata.cooldownReason',
    ],
    [
      'a non-numeric rate-limit reset',
      () =>
        decodeProviderState(
          withMetadata({ rateLimitResetTimes: { claude: 'soon' } }),
        ),
      '$.metadata.rateLimitResetTimes.claude',
    ],
    [
      'a fingerprint missing a client metadata field',
      () => {
        const fingerprint = fingerprintWire('broken')
        delete (fingerprint.clientMetadata as JsonObject).platform
        return decodeProviderState(withMetadata({ fingerprint }))
      },
      '$.metadata.fingerprint.clientMetadata.platform',
    ],
    [
      'an unknown fingerprint history reason',
      () =>
        decodeProviderState(
          withMetadata({
            fingerprintHistory: [
              {
                fingerprint: fingerprintWire('x'),
                timestamp: 1,
                reason: 'bogus',
              },
            ],
          }),
        ),
      '$.metadata.fingerprintHistory[0].reason',
    ],
    [
      'a sparse fingerprintHistory array',
      () => {
        // biome-ignore lint/suspicious/noSparseArray: the hole is the case under test
        const history = [
          ,
          {
            fingerprint: fingerprintWire('x'),
            timestamp: 1,
            reason: 'initial',
          },
        ]
        return decodeProviderState(
          withMetadata({ fingerprintHistory: history }),
        )
      },
      '$.metadata.fingerprintHistory',
    ],
    [
      'an array carrying a property JSON would drop',
      () => {
        const history = [
          {
            fingerprint: fingerprintWire('x'),
            timestamp: 1,
            reason: 'initial',
          },
        ]
        Object.assign(history, { note: 'would be lost' })
        return decodeProviderState(
          withMetadata({ fingerprintHistory: history }),
        )
      },
      '$.metadata.fingerprintHistory',
    ],
    [
      'a negative request count',
      () =>
        decodeProviderState(
          withMetadata({
            dailyRequestCounts: { date: '2024-01-01', claude: -1, gemini: 0 },
          }),
        ),
      '$.metadata.dailyRequestCounts.claude',
    ],
    [
      'a fractional request count',
      () =>
        decodeProviderState(
          withMetadata({
            dailyRequestCounts: { date: '2024-01-01', claude: 1, gemini: 0.5 },
          }),
        ),
      '$.metadata.dailyRequestCounts.gemini',
    ],
    [
      'a prototype key in a dynamic map',
      () =>
        decodeProviderState(
          JSON.parse(
            '{"schemaVersion":1,"metadata":{"addedAt":1,"lastUsed":2,"rateLimitResetTimes":{"__proto__":1}}}',
          ),
        ),
      '$.metadata.rateLimitResetTimes.__proto__',
    ],
    [
      'a prototype key among unknown fields',
      () =>
        decodeProviderState(
          JSON.parse(
            '{"schemaVersion":1,"metadata":{"addedAt":1,"lastUsed":2,"__proto__":{"polluted":true}}}',
          ),
        ),
      '$.metadata.__proto__',
    ],
    [
      'a quota field in provider metadata',
      () => decodeProviderState(withMetadata({ cachedQuota: {} })),
      '$.metadata.cachedQuota',
    ],
    [
      'a pre-v4 field that the migration must normalise',
      () => decodeProviderState(withMetadata({ isRateLimited: true })),
      '$.metadata.isRateLimited',
    ],
    [
      'an undefined field',
      () => decodeProviderState(withMetadata({ label: undefined })),
      '$.metadata.label',
    ],
    [
      'a non-JSON object among unknown fields',
      () => decodeProviderState(withMetadata({ seenAt: new Date(0) })),
      '$.metadata.seenAt',
    ],
    [
      'a circular unknown field',
      () => {
        const loop: Record<string, unknown> = {}
        loop.self = loop
        return decodeProviderState(withMetadata({ loop }))
      },
      '$.metadata.loop.self',
    ],
    [
      'a misspelled typed field on encode',
      () =>
        encodeProviderState({
          schemaVersion: 1,
          metadata: { addedAt: 1, lastUsed: 2, emial: 'x' },
        } as unknown as ProviderStateEnvelope),
      '$.metadata.emial',
    ],
    [
      'an extension that collides with a known field on encode',
      () =>
        encodeProviderState({
          schemaVersion: 1,
          metadata: { addedAt: 1, lastUsed: 2, extensions: { email: 'x' } },
        }),
      '$.metadata.extensions.email',
    ],
    [
      'a credential smuggled through extensions on encode',
      () =>
        encodeProviderState({
          schemaVersion: 1,
          metadata: {
            addedAt: 1,
            lastUsed: 2,
            extensions: { refreshToken: 'synthetic-rt' },
          },
        }),
      '$.metadata.extensions.refreshToken',
    ],
  ]

  for (const [name, action, path] of cases) {
    it(`rejects ${name}`, () => {
      expectRefused(action, path)
    })
  }

  it('reports invalid input through validate instead of throwing', () => {
    expect(isValidProviderState(withMetadata({ enabled: 'yes' }))).toBe(false)
    expect(PROVIDER_STATE_CODEC.validate(null)).toBe(false)
    expect(PROVIDER_STATE_CODEC.validate([])).toBe(false)
  })

  it('names the field but never the refused value', () => {
    const error = expectRefused(
      () =>
        decodeProviderState(
          withMetadata({ verificationRequired: 'person@example.test' }),
        ),
      '$.metadata.verificationRequired',
    )
    expect(error.message).not.toContain('person@example.test')
    const credential = expectRefused(
      () => decodeProviderState(withMetadata({ refreshToken: 'synthetic-rt' })),
      '$.metadata.refreshToken',
    )
    expect(credential.message).not.toContain('synthetic-rt')
  })
})

describe('provider-state credential-bound projection', () => {
  it('projects exactly the present bound fields, null included', () => {
    const wire = withMetadata({ projectId: null })
    delete (wire.metadata as JsonObject).managedProjectId

    const bound = providerStateCredentialBound(wire)
    const metadata = bound.metadata as JsonObject
    const expectedKeys = CREDENTIAL_BOUND_METADATA_FIELDS.filter(
      (key) => key !== 'managedProjectId',
    )
    expect(Object.keys(metadata).sort()).toEqual([...expectedKeys].sort())
    expect(metadata.projectId).toBeNull()
    expect(Object.hasOwn(metadata, 'managedProjectId')).toBe(false)
    expect(bound.schemaVersion).toBe(1)
    expect(PROVIDER_STATE_CODEC.credentialBound(wire)).toEqual(bound)
  })

  it('ignores fields the stamp must not cover', () => {
    const base = providerStateCredentialBound(fullEnvelopeWire())
    const changed = providerStateCredentialBound({
      ...fullEnvelopeWire(),
      envelopeExtra: 'different',
      metadata: {
        ...fullMetadataWire(),
        addedAt: 1,
        lastUsed: 2,
        enabled: true,
        lastSwitchReason: 'initial',
        rateLimitResetTimes: { claude: null },
        coolingDownUntil: null,
        cooldownReason: 'network-error',
        label: 'another label',
        dailyRequestCounts: { date: '2030-01-01', claude: 9, gemini: 9 },
        futureTopLevel: 'changed',
      },
    })
    expect(changed).toEqual(base)
  })

  it('changes when a bound field or a nested bound extension changes', () => {
    const base = JSON.stringify(
      providerStateCredentialBound(fullEnvelopeWire()),
    )
    const project = JSON.stringify(
      providerStateCredentialBound(withMetadata({ projectId: 'other' })),
    )
    const nested = JSON.stringify(
      providerStateCredentialBound(
        withMetadata({
          fingerprint: fingerprintWire('current', {
            futureField: { nested: [2] },
          }),
        }),
      ),
    )
    const absent = JSON.stringify(
      providerStateCredentialBound(withMetadata({ capturedPaidTierId: null })),
    )
    expect(project).not.toBe(base)
    expect(nested).not.toBe(base)
    expect(absent).not.toBe(base)
  })

  it('is key-sorted and independent of input key order', () => {
    const wire = fullEnvelopeWire()
    const reverse = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(reverse)
      if (value === null || typeof value !== 'object') return value
      return Object.fromEntries(
        Object.entries(value)
          .reverse()
          .map(([key, item]) => [key, reverse(item)]),
      )
    }
    const forward = JSON.stringify(providerStateCredentialBound(wire))
    const backward = JSON.stringify(providerStateCredentialBound(reverse(wire)))
    expect(backward).toBe(forward)

    const sortedAtEveryDepth = (value: unknown): boolean => {
      if (Array.isArray(value)) return value.every(sortedAtEveryDepth)
      if (value === null || typeof value !== 'object') return true
      const keys = Object.keys(value)
      return (
        keys.join('\u0000') === [...keys].sort().join('\u0000') &&
        Object.values(value).every(sortedAtEveryDepth)
      )
    }
    expect(sortedAtEveryDepth(JSON.parse(forward))).toBe(true)
  })

  it('refuses to project an invalid value', () => {
    expectRefused(
      () => providerStateCredentialBound(withMetadata({ email: 1 })),
      '$.metadata.email',
    )
  })
})

describe('provider-state codec factory', () => {
  it('opens with every store hook when both rules are given', () => {
    const codec = createProviderStateCodec(testPolicy)
    for (const hook of [
      'validate',
      'credentialBound',
      'merge',
      'onReplace',
    ] as const) {
      expect(typeof codec[hook]).toBe('function')
    }
    expect(codec.validate(fullEnvelopeWire())).toBe(true)
    expect(codec.validate(withMetadata({ email: 1 }))).toBe(false)
    expect(codec.credentialBound(fullEnvelopeWire())).toEqual(
      providerStateCredentialBound(fullEnvelopeWire()),
    )
  })

  it('hands merge decoded values and stores its encoded result', () => {
    const seen: ProviderStateEnvelope[] = []
    const codec = createProviderStateCodec({
      ...testPolicy,
      merge: (onDisk, incoming) => {
        seen.push(onDisk, incoming)
        return testPolicy.merge(onDisk, incoming)
      },
    })
    const incoming: ProviderStateEnvelope = {
      schemaVersion: 1,
      metadata: { addedAt: 1, lastUsed: 99, projectId: 'proj-new' },
    }
    const merged = codec.merge(fullEnvelopeWire(), incoming) as JsonObject

    expect(seen[0]?.metadata.extensions).toEqual({
      futureTopLevel: { anything: ['goes', null, true, 1.5] },
    })
    expect(seen[1]).toEqual(incoming)
    const metadata = merged.metadata as JsonObject
    expect(metadata.projectId).toBe('proj-new')
    expect(metadata.lastUsed).toBe(99)
    expect(metadata.futureTopLevel).toEqual({
      anything: ['goes', null, true, 1.5],
    })
    expect(merged.envelopeExtra).toBe('kept')
  })

  it('refuses to show merge invalid stored metadata', () => {
    let called = false
    const codec = createProviderStateCodec({
      ...testPolicy,
      merge: (onDisk) => {
        called = true
        return onDisk
      },
    })
    expectRefused(
      () => codec.merge(withMetadata({ enabled: 'yes' }), fullEnvelopeWire()),
      '$.metadata.enabled',
    )
    expect(called).toBe(false)
  })

  it('refuses a merge result that is not valid metadata', () => {
    const codec = createProviderStateCodec({
      ...testPolicy,
      merge: () => undefined as unknown as ProviderStateEnvelope,
    })
    expectRefused(
      () => codec.merge(fullEnvelopeWire(), fullEnvelopeWire()),
      '$',
    )
  })

  it('hands onReplace decoded values, and an undefined result clears', () => {
    const calls: unknown[][] = []
    const codec = createProviderStateCodec({
      ...testPolicy,
      onReplace: (previous, replacement) => {
        calls.push([previous, replacement])
        return replacement.identity === 'clear-me'
          ? undefined
          : replacement.incoming
      },
    })
    const incoming = { schemaVersion: 1, metadata: { addedAt: 5, lastUsed: 6 } }
    expect(
      codec.onReplace(fullEnvelopeWire(), {
        id: 'row-1',
        credentialEpoch: 4,
        identity: 'wire-id',
        incoming,
      }),
    ).toEqual(incoming)
    expect(calls[0]?.[0]).toEqual(decodeProviderState(fullEnvelopeWire()))
    expect(calls[0]?.[1]).toEqual({
      id: 'row-1',
      credentialEpoch: 4,
      identity: 'wire-id',
      incoming,
    })

    expect(
      codec.onReplace(undefined, {
        id: 'row-1',
        credentialEpoch: 5,
        identity: 'clear-me',
      }),
    ).toBeUndefined()
    expect(calls[1]?.[0]).toBeUndefined()
    expect(Object.hasOwn(calls[1]?.[1] as object, 'incoming')).toBe(false)
  })

  it('lets the replacement rule refuse a replace whose epoch is not the expected successor', () => {
    // The repository's fence for replaceCredential: the store reports the
    // new epoch, which is the replaced one plus one.
    const expected = { id: 'row-1', credentialEpoch: 3 }
    const codec = createProviderStateCodec({
      ...testPolicy,
      onReplace: (previous, replacement) => {
        if (replacement.credentialEpoch !== expected.credentialEpoch + 1) {
          throw new Error('stale replacement')
        }
        return previous
      },
    })
    expect(
      codec.onReplace(fullEnvelopeWire(), { id: 'row-1', credentialEpoch: 4 }),
    ).toEqual(fullEnvelopeWire())
    expect(() =>
      codec.onReplace(fullEnvelopeWire(), { id: 'row-1', credentialEpoch: 5 }),
    ).toThrow('stale replacement')
  })

  it('refuses a policy without a merge rule', () => {
    expectRefused(
      () =>
        createProviderStateCodec({
          onReplace: testPolicy.onReplace,
        } as unknown as ProviderStatePolicy),
      'policy.merge',
    )
  })

  it('refuses a policy without an onReplace rule', () => {
    expectRefused(
      () =>
        createProviderStateCodec({
          merge: testPolicy.merge,
        } as unknown as ProviderStatePolicy),
      'policy.onReplace',
    )
  })

  it('refuses a policy whose merge rule is not a function', () => {
    expectRefused(
      () =>
        createProviderStateCodec({
          merge: 'last-write-wins',
          onReplace: testPolicy.onReplace,
        } as unknown as ProviderStatePolicy),
      'policy.merge',
    )
  })

  it('refuses a missing policy', () => {
    expectRefused(
      () =>
        createProviderStateCodec(undefined as unknown as ProviderStatePolicy),
      'policy',
    )
  })
})

describe('quota codec', () => {
  it('roundtrips every quota field, null, empty and unknown key losslessly', () => {
    const wire = fullQuotaWire()
    const decoded = decodeQuotaState(json(wire))
    expect(encodeQuotaState(decoded)).toEqual(wire)
    expect(decodeQuotaState(encodeQuotaState(decoded))).toEqual(decoded)
    expect(decoded.extensions).toEqual({ quotaExtra: [1, 2, 3] })
    expect(decoded.cachedQuota?.claude?.windows?.[1]?.extensions).toEqual({
      extraWindowField: 7,
    })
    expect(decoded.cachedQuota?.claude?.remainingFraction).toBe(0.123456789)
    expect(decoded.cachedPerModelQuota?.map((entry) => entry.modelId)).toEqual([
      'claude-sonnet',
      'orphan-model',
      'gemini-flash',
    ])
    expect(decoded.cachedPerModelQuota?.[1]?.group).toBeNull()
    expect(
      Object.hasOwn(decoded.cachedPerModelQuota?.[1] ?? {}, 'displayName'),
    ).toBe(false)
    expect(decoded.cachedPerModelQuota?.[2]?.displayName).toBeNull()
    expect(QUOTA_CODEC.validate(wire)).toBe(true)
  })

  const cases: Array<[string, unknown, string]> = [
    ['a newer schema version', { schemaVersion: 3 }, '$.schemaVersion'],
    [
      'a group without modelCount',
      { schemaVersion: 1, cachedQuota: { claude: { remainingFraction: 1 } } },
      '$.cachedQuota.claude.modelCount',
    ],
    [
      'an unknown quota window',
      {
        schemaVersion: 1,
        cachedQuota: {
          claude: {
            modelCount: 1,
            windows: [{ window: '1d', remainingFraction: 1, resetTime: 'x' }],
          },
        },
      },
      '$.cachedQuota.claude.windows[0].window',
    ],
    [
      'a per-model entry without its group key',
      {
        schemaVersion: 1,
        cachedPerModelQuota: [{ modelId: 'm', remainingFraction: 1 }],
      },
      '$.cachedPerModelQuota[0].group',
    ],
    [
      'a null per-model remaining fraction',
      {
        schemaVersion: 1,
        cachedPerModelQuota: [
          { modelId: 'm', group: null, remainingFraction: null },
        ],
      },
      '$.cachedPerModelQuota[0].remainingFraction',
    ],
    [
      'a provider-metadata field in quota',
      { schemaVersion: 1, email: 'x@example.test' },
      '$.email',
    ],
    [
      'a credential in quota',
      { schemaVersion: 1, accessToken: 'synthetic-at' },
      '$.accessToken',
    ],
  ]
  for (const [name, raw, path] of cases) {
    it(`rejects ${name}`, () => {
      expectRefused(() => decodeQuotaState(raw), path)
      expect(isValidQuotaState(raw)).toBe(false)
    })
  }

  it('merges a reading by replacing the fields it carries and keeping the rest', () => {
    const stored = fullQuotaWire()
    const merged = mergeQuotaState(stored, {
      schemaVersion: 1,
      cachedQuota: { claude: { modelCount: 5 } },
      cachedQuotaUpdatedAt: null,
    })
    expect(merged.cachedQuota).toEqual({ claude: { modelCount: 5 } })
    expect(merged.cachedQuotaUpdatedAt).toBeNull()
    expect(merged.cachedPerModelQuota).toEqual(stored.cachedPerModelQuota)
    expect(merged.cachedQuotaAccountId).toBe('opaque-account-stamp')
    expect(merged.quotaExtra).toEqual([1, 2, 3])
    expect(QUOTA_CODEC.merge(undefined, { schemaVersion: 1 })).toEqual({
      schemaVersion: 1,
    })
  })

  it('refuses to merge an invalid reading or stored value', () => {
    expectRefused(
      () =>
        mergeQuotaState(fullQuotaWire(), { schemaVersion: 1, cachedQuota: [] }),
      '$.cachedQuota',
    )
    expectRefused(
      () => mergeQuotaState({ schemaVersion: 2 }, { schemaVersion: 1 }),
      '$.schemaVersion',
    )
  })
})

describe('routing settings and row refs', () => {
  const ref = { id: 'row-uuid-1', credentialEpoch: 3, identity: 'wire-id-1' }

  it('roundtrips legacy index encodings beside independent family refs', () => {
    const wire = {
      schemaVersion: 1,
      activeIndex: 7,
      activeIndexByFamily: { claude: 9, gemini: null, other: 1 },
      activeRow: ref,
      activeRowByFamily: {
        claude: { id: 'row-uuid-2', credentialEpoch: 1 },
        gemini: null,
      },
      routingExtra: true,
    }
    const decoded = decodeRoutingSettings(json(wire))
    expect(decoded.activeIndexByFamily?.extensions).toEqual({ other: 1 })
    expect(
      Object.hasOwn(decoded.activeRowByFamily?.claude ?? {}, 'identity'),
    ).toBe(false)
    expect(encodeRoutingSettings(decoded)).toEqual(wire)
  })

  it('roundtrips a row ref and keeps a missing identity missing', () => {
    expect(encodeRowRef(decodeRowRef(ref))).toEqual(ref)
    const noIdentity = decodeRowRef({ id: 'row-uuid-2', credentialEpoch: 1 })
    expect(Object.hasOwn(noIdentity, 'identity')).toBe(false)
  })

  const refusals: Array<[string, unknown, string]> = [
    ['an epoch of zero', { id: 'a', credentialEpoch: 0 }, '$.credentialEpoch'],
    [
      'a fractional epoch',
      { id: 'a', credentialEpoch: 1.5 },
      '$.credentialEpoch',
    ],
    ['an id with surrounding space', { id: ' a', credentialEpoch: 1 }, '$.id'],
    ['a prototype id', { id: 'constructor', credentialEpoch: 1 }, '$.id'],
    [
      'an empty identity',
      { id: 'a', credentialEpoch: 1, identity: '' },
      '$.identity',
    ],
    [
      'an unknown ref key',
      { id: 'a', credentialEpoch: 1, index: 0 },
      '$.index',
    ],
  ]
  for (const [name, raw, path] of refusals) {
    it(`rejects a row ref with ${name}`, () => {
      expectRefused(() => decodeRowRef(raw), path)
    })
  }

  it('rejects routing settings from a newer build', () => {
    expectRefused(
      () => decodeRoutingSettings({ schemaVersion: 2 }),
      '$.schemaVersion',
    )
  })
})

describe('lock specs', () => {
  it('keys the refresh provider lock by encoded identity, else id', () => {
    expect(
      refreshProviderLock('/tmp/synthetic/state.json', {
        id: 'row-1',
        identity: 'person@example.test/1',
      }),
    ).toEqual({
      path: '/tmp/synthetic/state.json',
      name: 'agy-refresh-person%40example.test%2F1',
    })
    expect(
      refreshProviderLock('/tmp/synthetic/state.json', { id: 'row-1' }).name,
    ).toBe('agy-refresh-row-1')
  })

  it('takes the legacy accounts lock with a renewed ten-second lease', () => {
    expect(
      legacyAccountsLock('/tmp/synthetic/antigravity-accounts.json'),
    ).toEqual({
      path: '/tmp/synthetic/antigravity-accounts.json',
      name: 'accounts',
      ttlMs: 10_000,
      renew: true,
    })
  })
})
