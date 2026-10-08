import { describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  ANTIGRAVITY_RPC_COMMANDS,
  ANTIGRAVITY_RPC_CONTRACT,
  ANTIGRAVITY_RPC_DEFINITION,
  ANTIGRAVITY_RPC_ID,
  ANTIGRAVITY_RPC_LIMITS,
  ANTIGRAVITY_RPC_METHODS,
  ANTIGRAVITY_RPC_VERSION,
  type AntigravityAccountDto,
  AntigravityApplyInputSchema,
  AntigravityApplyOutputSchema,
  type AntigravityCommandResult,
  AntigravityCommandResultSchema,
  type AntigravityRpcParseResult,
  type AntigravityStateInput,
  AntigravityStateInputSchema,
  AntigravityStateOutputSchema,
  type AntigravityStateSnapshot,
  applyCall,
  readApplyCallOutput,
  readStateCallOutput,
  stateCall,
} from './protocol.ts'

const GENERATION = 'g-0b6f3c1e-2a4d-4e5f-8a9b-0c1d2e3f4a5b'

const STATE_INPUT: AntigravityStateInput = {
  version: 1,
  generation: GENERATION,
  scope: { kind: 'session', sessionID: 'ses_fake_one' },
  cursor: 0,
}

const SELECTOR = `sel-${'A'.repeat(31)}_`

const ACCOUNT: AntigravityAccountDto = {
  selector: SELECTOR,
  id: 'acct-0',
  label: 'Account 1',
  enabled: true,
  health: 100,
  current: true,
  quota: {
    gemini: {
      remainingPercent: 42,
      resetAt: 1_700_000_000_000,
      windows: [{ window: '5h', remainingPercent: 42 }],
    },
  },
  tier: { id: 'free-tier', capturedAt: 1_700_000_000_000 },
}

const SNAPSHOT: AntigravityStateSnapshot = {
  version: 1,
  kind: 'snapshot',
  generation: GENERATION,
  scope: { kind: 'sessionless' },
  reset: null,
  cursor: 2,
  dropped: 0,
  more: false,
  notifications: [
    { cursor: 1, type: 'open-dialog', command: 'antigravity-quota', text: 'q' },
    { cursor: 2, type: 'open-dialog', command: 'antigravity-dump', text: 'd' },
  ],
  readSeq: 1,
  accountsStatus: { kind: 'complete' },
  accounts: [ACCOUNT],
  route: null,
  status: {
    checkedAt: null,
    quotaBackoffUntil: null,
    routingAuthoritative: false,
  },
  settings: {
    routing: { cliFirst: false, quotaStyleFallback: true },
    killswitch: { enabled: false, minimumRemainingPercent: 5 },
    logLevel: 'info',
    dump: { enabled: false },
  },
}

function issuesOf<T>(result: AntigravityRpcParseResult<T>) {
  expect(result.ok).toBe(false)
  return result.ok ? [] : result.issues
}

function pathsOf<T>(result: AntigravityRpcParseResult<T>): string[] {
  return issuesOf(result).map((issue) => issue.path.join('.'))
}

describe('antigravity-auth RPC identity', () => {
  it('names the self-owned id, version 1 and exactly the state/apply methods', () => {
    expect(ANTIGRAVITY_RPC_ID).toBe('antigravity-auth')
    expect(ANTIGRAVITY_RPC_VERSION).toBe(1)
    expect([...ANTIGRAVITY_RPC_METHODS]).toEqual(['state', 'apply'])
    expect(ANTIGRAVITY_RPC_DEFINITION.id).toBe('antigravity-auth')
    expect(Object.keys(ANTIGRAVITY_RPC_DEFINITION.methods)).toEqual([
      'state',
      'apply',
    ])
    expect(Object.keys(ANTIGRAVITY_RPC_DEFINITION.events)).toEqual(['changed'])
  })

  it('keeps the OpenCode 1 command names in their original order', () => {
    expect([...ANTIGRAVITY_RPC_COMMANDS]).toEqual([
      'antigravity-quota',
      'antigravity-account',
      'antigravity-routing',
      'antigravity-killswitch',
      'antigravity-dump',
      'antigravity-logging',
    ])
  })

  it('every definition schema is a Standard Schema V1 object', () => {
    const schemas = [
      ANTIGRAVITY_RPC_DEFINITION.methods.state.input,
      ANTIGRAVITY_RPC_DEFINITION.methods.state.output,
      ANTIGRAVITY_RPC_DEFINITION.methods.apply.input,
      ANTIGRAVITY_RPC_DEFINITION.methods.apply.output,
      ANTIGRAVITY_RPC_DEFINITION.events.changed.schema,
    ]
    for (const schema of schemas) {
      expect(schema['~standard'].version).toBe(1)
      expect(schema['~standard'].vendor).toBe('cortexkit.antigravity-auth')
    }
    expect(
      ANTIGRAVITY_RPC_DEFINITION.methods.state.input['~standard'].validate(
        STATE_INPUT,
      ),
    ).toEqual({ value: STATE_INPUT })
    const refused = ANTIGRAVITY_RPC_DEFINITION.methods.state.input[
      '~standard'
    ].validate({ ...STATE_INPUT, cursor: '1' })
    expect('issues' in refused && refused.issues?.length).toBe(1)
  })

  it('pins the frozen contract descriptor hash', () => {
    // Changing any wire name, literal or limit changes this hash. Update it
    // only together with every client of the contract and every test tool
    // that maps or replays its messages.
    const hash = createHash('sha256')
      .update(JSON.stringify(ANTIGRAVITY_RPC_CONTRACT))
      .digest('hex')
    expect(hash).toBe(
      'faf4683aade586900aa13b29e2d197584c050a22ef34cd144ee8b395489fe3d6',
    )
  })

  it('has no runtime import, only a type-only import of the V1 command union', () => {
    const source = readFileSync(join(import.meta.dir, 'protocol.ts'), 'utf8')
    const imports = source
      .split('\n')
      .filter((line) => /^import\b/.test(line) || /^export .* from /.test(line))
    expect(imports).toEqual([
      "import type { CommandModalName } from '../../rpc/protocol.ts'",
    ])
  })
})

describe('state input', () => {
  it('accepts session and sessionless scopes and a null first-contact generation', () => {
    expect(AntigravityStateInputSchema.parse(STATE_INPUT).ok).toBe(true)
    expect(
      AntigravityStateInputSchema.parse({
        version: 1,
        generation: null,
        scope: { kind: 'sessionless' },
        cursor: 0,
      }).ok,
    ).toBe(true)
  })

  it('returns the validated value itself, without copying or coercing', () => {
    const result = AntigravityStateInputSchema.parse(STATE_INPUT)
    expect(result.ok && result.value).toBe(STATE_INPUT)
  })

  it('refuses every non-integer, coerced or negative cursor', () => {
    const cursors: unknown[] = [
      true,
      false,
      '5',
      '0',
      5.5,
      -1,
      -0,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      2 ** 53,
      null,
      [1],
      { valueOf: () => 1 },
    ]
    for (const cursor of cursors) {
      expect(
        pathsOf(AntigravityStateInputSchema.parse({ ...STATE_INPUT, cursor })),
      ).toEqual(['cursor'])
    }
    expect(
      AntigravityStateInputSchema.parse({
        ...STATE_INPUT,
        cursor: Number.MAX_SAFE_INTEGER,
      }).ok,
    ).toBe(true)
  })

  it('refuses any version other than the number 1', () => {
    for (const version of ['1', 2, 0, true, 1.0000001, null]) {
      expect(
        pathsOf(AntigravityStateInputSchema.parse({ ...STATE_INPUT, version })),
      ).toEqual(['version'])
    }
  })

  it('requires the generation key even though it may be null', () => {
    const { generation: _omitted, ...withoutGeneration } = STATE_INPUT
    expect(
      pathsOf(AntigravityStateInputSchema.parse(withoutGeneration)),
    ).toEqual(['generation'])
    for (const generation of ['', 'has space', 'x'.repeat(65), 7]) {
      expect(
        pathsOf(
          AntigravityStateInputSchema.parse({ ...STATE_INPUT, generation }),
        ),
      ).toEqual(['generation'])
    }
  })

  it('treats a missing session as an error, never as the sessionless scope', () => {
    expect(
      pathsOf(
        AntigravityStateInputSchema.parse({
          ...STATE_INPUT,
          scope: { kind: 'session' },
        }),
      ),
    ).toEqual(['scope.sessionID'])
    expect(
      pathsOf(
        AntigravityStateInputSchema.parse({
          ...STATE_INPUT,
          scope: { kind: 'sessionless', sessionID: 'ses_fake_one' },
        }),
      ),
    ).toEqual(['scope.sessionID'])
    const { scope: _omitted, ...withoutScope } = STATE_INPUT
    expect(pathsOf(AntigravityStateInputSchema.parse(withoutScope))).toEqual([
      'scope',
    ])
    for (const sessionID of ['', 'has space', 'x'.repeat(257), 'tab\t']) {
      expect(
        pathsOf(
          AntigravityStateInputSchema.parse({
            ...STATE_INPUT,
            scope: { kind: 'session', sessionID },
          }),
        ),
      ).toEqual(['scope.sessionID'])
    }
  })

  it('refuses unexpected keys, including a caller-supplied directory', () => {
    expect(
      pathsOf(
        AntigravityStateInputSchema.parse({
          ...STATE_INPUT,
          directory: '/tmp/other-location',
        }),
      ),
    ).toEqual(['directory'])
    expect(
      pathsOf(
        AntigravityStateInputSchema.parse({
          ...STATE_INPUT,
          scope: { kind: 'session', sessionID: 'ses_a', directory: '/x' },
        }),
      ),
    ).toEqual(['scope.directory'])
  })

  it('refuses arrays, class instances and null as the input object', () => {
    class Holder {
      version = 1
      generation = null
      scope = { kind: 'sessionless' }
      cursor = 0
    }
    for (const value of [null, [], new Holder(), 'state', 1]) {
      expect(pathsOf(AntigravityStateInputSchema.parse(value))).toEqual([''])
    }
  })

  it('reports a throwing getter as malformed instead of crashing', () => {
    const hostile = {
      ...STATE_INPUT,
      get cursor(): number {
        throw new Error('boom')
      },
    }
    expect(issuesOf(AntigravityStateInputSchema.parse(hostile))).toEqual([
      { path: [], message: 'value could not be read' },
    ])
  })
})

describe('apply input', () => {
  const APPLY = {
    version: 1,
    generation: GENERATION,
    scope: { kind: 'session', sessionID: 'ses_fake_one' },
    command: 'antigravity-account',
    arguments: 'toggle 0',
  } as const

  it('accepts every OpenCode 1 command with a string argument', () => {
    for (const command of ANTIGRAVITY_RPC_COMMANDS) {
      expect(AntigravityApplyInputSchema.parse({ ...APPLY, command }).ok).toBe(
        true,
      )
    }
  })

  it('refuses unknown commands, null generation, non-string and oversized arguments', () => {
    expect(
      pathsOf(
        AntigravityApplyInputSchema.parse({ ...APPLY, command: 'gemini-dump' }),
      ),
    ).toEqual(['command'])
    expect(
      pathsOf(
        AntigravityApplyInputSchema.parse({ ...APPLY, generation: null }),
      ),
    ).toEqual(['generation'])
    for (const args of [1, true, ['toggle'], { text: 'toggle' }]) {
      expect(
        pathsOf(
          AntigravityApplyInputSchema.parse({ ...APPLY, arguments: args }),
        ),
      ).toEqual(['arguments'])
    }
    expect(
      pathsOf(
        AntigravityApplyInputSchema.parse({
          ...APPLY,
          arguments: 'x'.repeat(ANTIGRAVITY_RPC_LIMITS.argumentsMaxLength + 1),
        }),
      ),
    ).toEqual(['arguments'])
    expect(
      pathsOf(
        AntigravityApplyInputSchema.parse({ ...APPLY, arguments: 'a\u0000b' }),
      ),
    ).toEqual(['arguments'])
  })

  it('refuses the OpenCode 1 knobs and sessionId fields', () => {
    expect(
      pathsOf(
        AntigravityApplyInputSchema.parse({
          ...APPLY,
          knobs: { timeoutMs: 1 },
          sessionId: 'ses_fake_one',
        }),
      ).sort(),
    ).toEqual(['knobs', 'sessionId'])
  })

  it('never echoes a rejected value in an issue message', () => {
    const secret = 'add-oauth-finish 4/0AVMBsJ-fake-code-value'
    const result = AntigravityApplyInputSchema.parse({
      ...APPLY,
      arguments: `${secret}\u0000`,
      command: secret,
    })
    const text = JSON.stringify(issuesOf(result))
    expect(text).not.toContain('fake-code-value')
  })
})

describe('state output', () => {
  it('accepts a complete snapshot and the disposed answer', () => {
    expect(AntigravityStateOutputSchema.parse(SNAPSHOT).ok).toBe(true)
    expect(
      AntigravityStateOutputSchema.parse({
        version: 1,
        kind: 'disposed',
        generation: GENERATION,
      }).ok,
    ).toBe(true)
  })

  it('accepts the sidebar projection, whose optional fields may be undefined', () => {
    const projected = {
      ...ACCOUNT,
      cooldownUntil: undefined,
      tier: undefined,
    }
    expect(
      AntigravityStateOutputSchema.parse({ ...SNAPSHOT, accounts: [projected] })
        .ok,
    ).toBe(true)
  })

  it('refuses credential and identity fields on an account', () => {
    const leaks: Record<string, unknown> = {
      email: 'person@example.com',
      refreshToken: 'fake-refresh',
      access: 'fake-access',
      projectId: 'fake-project',
      managedProjectId: 'fake-managed',
      fingerprint: { deviceId: 'fake' },
      profileName: 'Work',
      lastError: 'upstream said something',
    }
    for (const [key, value] of Object.entries(leaks)) {
      expect(
        pathsOf(
          AntigravityStateOutputSchema.parse({
            ...SNAPSHOT,
            accounts: [{ ...ACCOUNT, [key]: value }],
          }),
        ),
      ).toEqual([`accounts.0.${key}`])
    }
  })

  it('refuses non-ordinal account ids and labels', () => {
    expect(
      pathsOf(
        AntigravityStateOutputSchema.parse({
          ...SNAPSHOT,
          accounts: [{ ...ACCOUNT, id: 'person@example.com', label: 'Work' }],
        }),
      ).sort(),
    ).toEqual(['accounts.0.id', 'accounts.0.label'])
  })

  it('refuses a status error text and a missing nullable status key', () => {
    expect(
      pathsOf(
        AntigravityStateOutputSchema.parse({
          ...SNAPSHOT,
          status: { ...SNAPSHOT.status, lastError: 'token expired for x' },
        }),
      ),
    ).toEqual(['status.lastError'])
    const { checkedAt: _omitted, ...status } = SNAPSHOT.status
    expect(
      pathsOf(AntigravityStateOutputSchema.parse({ ...SNAPSHOT, status })),
    ).toEqual(['status.checkedAt'])
  })

  it('refuses notifications past the answer cursor or out of order', () => {
    expect(
      pathsOf(AntigravityStateOutputSchema.parse({ ...SNAPSHOT, cursor: 1 })),
    ).toEqual(['notifications.1.cursor'])
    expect(
      pathsOf(
        AntigravityStateOutputSchema.parse({
          ...SNAPSHOT,
          notifications: [...SNAPSHOT.notifications].reverse(),
        }),
      ),
    ).toEqual(['notifications.1.cursor'])
  })

  it('refuses an unknown reset reason and an over-long notification page', () => {
    expect(
      pathsOf(
        AntigravityStateOutputSchema.parse({
          ...SNAPSHOT,
          reset: 'cursor-evicted',
        }),
      ),
    ).toEqual(['reset'])
    const many = Array.from(
      { length: ANTIGRAVITY_RPC_LIMITS.notificationsPerState + 1 },
      (_, index) => ({
        cursor: index + 1,
        type: 'open-dialog',
        command: 'antigravity-quota',
        text: '',
      }),
    )
    expect(
      pathsOf(
        AntigravityStateOutputSchema.parse({
          ...SNAPSHOT,
          cursor: many.length,
          notifications: many,
        }),
      ),
    ).toEqual(['notifications'])
  })
})

describe('apply output', () => {
  const RESULTS: AntigravityCommandResult[] = [
    {
      command: 'antigravity-quota',
      status: 'applied',
      text: 'Quota refreshed',
      accounts: [ACCOUNT],
    },
    {
      command: 'antigravity-account',
      status: 'applied',
      text: 'Open this URL',
      accounts: null,
      authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?x=1',
      targetOutcome: null,
    },
    {
      command: 'antigravity-routing',
      status: 'applied',
      text: 'Routing updated',
      routing: { cliFirst: true, quotaStyleFallback: false },
    },
    {
      command: 'antigravity-killswitch',
      status: 'failed',
      text: 'Killswitch update failed',
      killswitch: null,
    },
    {
      command: 'antigravity-dump',
      status: 'applied',
      text: 'Dump on',
      dump: { enabled: true },
    },
    {
      command: 'antigravity-logging',
      status: 'rejected',
      text: 'Unknown level',
      logLevel: null,
    },
  ]

  it('accepts one result per command, discriminated by the command name', () => {
    for (const result of RESULTS) {
      expect(AntigravityCommandResultSchema.parse(result).ok).toBe(true)
      expect(
        AntigravityApplyOutputSchema.parse({
          version: 1,
          kind: 'applied',
          generation: GENERATION,
          scope: { kind: 'sessionless' },
          result,
        }).ok,
      ).toBe(true)
    }
  })

  it('refuses another command’s fields, a missing nullable field and free knobs', () => {
    expect(
      pathsOf(
        AntigravityCommandResultSchema.parse({
          ...RESULTS[0],
          routing: { cliFirst: true, quotaStyleFallback: true },
        }),
      ),
    ).toEqual(['routing'])
    const { authorizationUrl: _omitted, ...account } = RESULTS[1] as Extract<
      AntigravityCommandResult,
      { command: 'antigravity-account' }
    >
    expect(pathsOf(AntigravityCommandResultSchema.parse(account))).toEqual([
      'authorizationUrl',
    ])
    expect(
      pathsOf(
        AntigravityCommandResultSchema.parse({
          ...RESULTS[4],
          knobs: { timeoutMs: 2000 },
        }),
      ),
    ).toEqual(['knobs'])
  })

  it('refuses a non-https authorization URL and unknown statuses', () => {
    expect(
      pathsOf(
        AntigravityCommandResultSchema.parse({
          ...RESULTS[1],
          authorizationUrl: 'http://127.0.0.1/callback',
        }),
      ),
    ).toEqual(['authorizationUrl'])
    expect(
      pathsOf(
        AntigravityCommandResultSchema.parse({ ...RESULTS[0], status: 'ok' }),
      ),
    ).toEqual(['status'])
  })

  it('accepts the stale-generation and disposed answers with nothing else', () => {
    for (const kind of ['stale-generation', 'disposed'] as const) {
      expect(
        AntigravityApplyOutputSchema.parse({
          version: 1,
          kind,
          generation: GENERATION,
        }).ok,
      ).toBe(true)
      expect(
        pathsOf(
          AntigravityApplyOutputSchema.parse({
            version: 1,
            kind,
            generation: GENERATION,
            result: RESULTS[0],
          }),
        ),
      ).toEqual(['result'])
    }
    expect(
      pathsOf(
        AntigravityApplyOutputSchema.parse({
          version: 1,
          kind: 'ok',
          generation: GENERATION,
        }),
      ),
    ).toEqual(['kind'])
  })
})

describe('client call helpers', () => {
  it('build the host rpc.call arguments for each method', () => {
    expect(stateCall(STATE_INPUT)).toEqual({
      rpcID: 'antigravity-auth',
      method: 'state',
      input: STATE_INPUT,
    })
    const apply = {
      version: 1,
      generation: GENERATION,
      scope: { kind: 'sessionless' },
      command: 'antigravity-dump',
      arguments: 'status',
    } as const
    expect(applyCall(apply)).toEqual({
      rpcID: 'antigravity-auth',
      method: 'apply',
      input: apply,
    })
  })

  it('validate the output member of the host answer', () => {
    expect(readStateCallOutput({ output: SNAPSHOT }).ok).toBe(true)
    expect(pathsOf(readStateCallOutput({}))).toEqual(['output'])
    expect(
      pathsOf(readStateCallOutput({ output: SNAPSHOT, extra: true })),
    ).toEqual(['extra'])
    expect(
      pathsOf(
        readApplyCallOutput({
          output: { version: 1, kind: 'disposed', generation: '' },
        }),
      ),
    ).toEqual(['output.generation'])
  })
})

describe('selectors, typed account actions, account limit and settings', () => {
  const ACTION_BASE = {
    version: 1,
    generation: GENERATION,
    scope: { kind: 'sessionless' },
    command: 'antigravity-account',
  } as const

  it('accepts each typed account action with a well-formed selector', () => {
    for (const action of [
      { kind: 'select', selector: SELECTOR, target: 'claude' },
      { kind: 'enable', selector: SELECTOR },
      { kind: 'disable', selector: SELECTOR },
      { kind: 'remove', selector: SELECTOR },
    ] as const) {
      expect(
        AntigravityApplyInputSchema.parse({ ...ACTION_BASE, action }).ok,
      ).toBe(true)
    }
  })

  it('refuses positions, acct ids and malformed selectors as targets', () => {
    for (const selector of [
      0,
      '0',
      'acct-0',
      'sel-short',
      `sel-${'A'.repeat(33)}`,
      `sel-${'A'.repeat(31)}=`,
      `SEL-${'A'.repeat(32)}`,
    ]) {
      expect(
        pathsOf(
          AntigravityApplyInputSchema.parse({
            ...ACTION_BASE,
            action: { kind: 'remove', selector },
          }),
        ),
      ).toEqual(['action.selector'])
    }
  })

  it('refuses an action and an argument string together, or an action on another command', () => {
    expect(
      pathsOf(
        AntigravityApplyInputSchema.parse({
          ...ACTION_BASE,
          arguments: 'remove 0',
          action: { kind: 'remove', selector: SELECTOR },
        }),
      ),
    ).toEqual(['arguments'])
    expect(
      pathsOf(
        AntigravityApplyInputSchema.parse({
          ...ACTION_BASE,
          command: 'antigravity-routing',
          action: { kind: 'remove', selector: SELECTOR },
        }),
      ),
    ).toEqual(['command'])
  })

  it('refuses unknown action kinds, extra action keys and a bad select target', () => {
    expect(
      pathsOf(
        AntigravityApplyInputSchema.parse({
          ...ACTION_BASE,
          action: { kind: 'rename', selector: SELECTOR },
        }),
      ),
    ).toEqual(['action.kind'])
    expect(
      pathsOf(
        AntigravityApplyInputSchema.parse({
          ...ACTION_BASE,
          action: { kind: 'enable', selector: SELECTOR, index: 0 },
        }),
      ),
    ).toEqual(['action.index'])
    expect(
      pathsOf(
        AntigravityApplyInputSchema.parse({
          ...ACTION_BASE,
          action: { kind: 'select', selector: SELECTOR, target: 'openai' },
        }),
      ),
    ).toEqual(['action.target'])
  })

  it('requires a selector on every account', () => {
    const { selector: _omitted, ...withoutSelector } = ACCOUNT
    expect(
      pathsOf(
        AntigravityStateOutputSchema.parse({
          ...SNAPSHOT,
          accounts: [withoutSelector],
        }),
      ),
    ).toEqual(['accounts.0.selector'])
  })

  it('answers an over-limit roster with no accounts, never a shortened list', () => {
    const overLimit = {
      ...SNAPSHOT,
      accountsStatus: { kind: 'over-limit', count: 65, limit: 64 },
      accounts: [],
    }
    expect(AntigravityStateOutputSchema.parse(overLimit).ok).toBe(true)
    expect(
      pathsOf(
        AntigravityStateOutputSchema.parse({
          ...overLimit,
          accounts: [ACCOUNT],
        }),
      ),
    ).toEqual(['accounts'])
    expect(
      pathsOf(
        AntigravityStateOutputSchema.parse({
          ...overLimit,
          accountsStatus: { kind: 'over-limit', count: 64, limit: 64 },
        }),
      ),
    ).toEqual(['accountsStatus.count'])
  })

  it('requires settings and a positive readSeq on every snapshot', () => {
    const { settings: _settings, ...withoutSettings } = SNAPSHOT
    expect(
      pathsOf(AntigravityStateOutputSchema.parse(withoutSettings)),
    ).toEqual(['settings'])
    expect(
      pathsOf(AntigravityStateOutputSchema.parse({ ...SNAPSHOT, readSeq: 0 })),
    ).toEqual(['readSeq'])
    expect(
      pathsOf(
        AntigravityStateOutputSchema.parse({
          ...SNAPSHOT,
          settings: { ...SNAPSHOT.settings, logLevel: 'verbose' },
        }),
      ),
    ).toEqual(['settings.logLevel'])
    expect(
      pathsOf(
        AntigravityStateOutputSchema.parse({
          ...SNAPSHOT,
          settings: {
            ...SNAPSHOT.settings,
            killswitch: {
              enabled: true,
              minimumRemainingPercent: 5,
              accounts: { abc123def456: 10 },
            },
          },
        }),
      ),
    ).toEqual(['settings.killswitch.accounts'])
  })

  it('accepts every target outcome on an account result and refuses others', () => {
    for (const targetOutcome of [
      'applied',
      'stale-target',
      'unknown-target',
      'unsupported-index-action',
      'failed',
      null,
    ] as const) {
      expect(
        AntigravityCommandResultSchema.parse({
          command: 'antigravity-account',
          status: 'rejected',
          text: '',
          accounts: null,
          authorizationUrl: null,
          targetOutcome,
        }).ok,
      ).toBe(true)
    }
    expect(
      pathsOf(
        AntigravityCommandResultSchema.parse({
          command: 'antigravity-account',
          status: 'rejected',
          text: '',
          accounts: null,
          authorizationUrl: null,
          targetOutcome: 'index-fallback',
        }),
      ),
    ).toEqual(['targetOutcome'])
  })
})
