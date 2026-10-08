import { describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ANTIGRAVITY_MENU_COMMAND,
  createAntigravityCommandMenu,
  loadCommonAuthCommands,
} from '@cortexkit/antigravity-auth-core'

import type {
  CommandApplyResult,
  RpcNotificationPayload,
} from '../../rpc/protocol.ts'
import {
  ANTIGRAVITY_MENU_COMMAND_NAME,
  ANTIGRAVITY_RPC_CONTRACT,
  ANTIGRAVITY_RPC_DEFINITION,
  ANTIGRAVITY_RPC_ID,
  ANTIGRAVITY_RPC_LIMITS,
  ANTIGRAVITY_RPC_METHODS,
  ANTIGRAVITY_RPC_VERSION,
  type AntigravityAccountDto,
  type AntigravityApplyInput,
  AntigravityApplyInputSchema,
  AntigravityApplyOutputSchema,
  AntigravityApplyResultSchema,
  AntigravityNotificationPayloadSchema,
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

/** A toast notification payload. */
const TOAST: RpcNotificationPayload = {
  command: 'antigravity',
  notify: { message: 'Quota refreshed', kind: 'info' },
}

/** A small menu as the shared menu's renderer payload. */
const MENU: CommandApplyResult['menu'] = {
  command: 'antigravity',
  title: 'Antigravity',
  sections: [
    {
      id: 'accounts',
      slot: 'accounts',
      title: 'Accounts',
      lines: ['1 account'],
      items: [
        {
          id: 'item-0f1e2d3c',
          label: 'Account 1',
          account: { id: 'item-0f1e2d3c', enabled: true, type: 'oauth' },
          facts: { tier: 'free', windows: [{ name: '5h', left: 42 }] },
          actions: [
            {
              id: 'remove',
              label: 'Remove',
              knobs: [],
              confirm: { message: 'Remove?', irreversible: true },
            },
          ],
        },
      ],
      actions: [
        {
          id: 'login',
          label: 'Add account',
          knobs: [
            { kind: 'text', id: 'code', label: 'Code', masked: true },
            { kind: 'toggle', id: 'manual', label: 'Paste', value: false },
            { kind: 'number', id: 'n', label: 'N', min: 0, max: 5 },
            {
              kind: 'choice',
              id: 'mode',
              label: 'Mode',
              choices: [{ value: 'browser', label: 'Browser' }],
            },
          ],
        },
      ],
    },
  ],
}

const DIALOG: RpcNotificationPayload = { command: 'antigravity', menu: MENU }

const RESULT: CommandApplyResult = {
  command: 'antigravity',
  ok: true,
  text: 'Done',
  menu: MENU,
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
    { cursor: 1, payload: TOAST },
    { cursor: 2, payload: DIALOG },
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

  it('names the shared menu by the same command core builds it under', () => {
    expect(ANTIGRAVITY_MENU_COMMAND_NAME).toBe('antigravity')
    expect(ANTIGRAVITY_MENU_COMMAND_NAME).toBe(ANTIGRAVITY_MENU_COMMAND)
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
      '8c6084fd187e9aca6c1f8b1740cfcc6f6effe8f8c11ca7ee7e90be8efe19b532',
    )
  })

  it('has only type-only imports: the menu types and core’s menu command', () => {
    const source = readFileSync(join(import.meta.dir, 'protocol.ts'), 'utf8')
    const statements = source.match(/^(?:import|export)\b[^;]*?from '[^']+'/gms)
    expect(
      (statements ?? []).map((statement) => statement.replace(/\s+/g, ' ')),
    ).toEqual([
      "import type { ANTIGRAVITY_MENU_COMMAND } from '@cortexkit/antigravity-auth-core'",
      "import type { CommandApplyRequest, CommandApplyResult, RpcNotificationPayload, } from '../../rpc/protocol.ts'",
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
  const APPLY: AntigravityApplyInput = {
    version: 1,
    generation: GENERATION,
    scope: { kind: 'session', sessionID: 'ses_fake_one' },
    request: {
      command: 'antigravity',
      sectionId: 'accounts',
      itemId: 'item-0f1e2d3c',
      actionId: 'remove',
      confirmed: true,
    },
  }

  it('accepts a menu action with or without an item, values and confirmation', () => {
    expect(AntigravityApplyInputSchema.parse(APPLY).ok).toBe(true)
    expect(
      AntigravityApplyInputSchema.parse({
        ...APPLY,
        request: {
          command: 'antigravity',
          sectionId: 'limits',
          actionId: 'set',
          values: { enabled: true, floor: 5, label: 'x', cleared: null },
        },
      }).ok,
    ).toBe(true)
  })

  it('refuses another command, a null generation and malformed ids', () => {
    expect(
      pathsOf(
        AntigravityApplyInputSchema.parse({
          ...APPLY,
          request: { ...APPLY.request, command: 'antigravity-account' },
        }),
      ),
    ).toEqual(['request.command'])
    expect(
      pathsOf(
        AntigravityApplyInputSchema.parse({ ...APPLY, generation: null }),
      ),
    ).toEqual(['generation'])
    for (const itemId of [
      '',
      'has space',
      7,
      'x'.repeat(ANTIGRAVITY_RPC_LIMITS.menuIdMaxLength + 1),
    ]) {
      expect(
        pathsOf(
          AntigravityApplyInputSchema.parse({
            ...APPLY,
            request: { ...APPLY.request, itemId },
          }),
        ),
      ).toEqual(['request.itemId'])
    }
  })

  it('refuses non-scalar values, too many values and a non-boolean confirmation', () => {
    for (const value of [[], { nested: true }, Number.NaN, 'a\u0000b']) {
      expect(
        pathsOf(
          AntigravityApplyInputSchema.parse({
            ...APPLY,
            request: { ...APPLY.request, values: { v: value } },
          }),
        ),
      ).toEqual(['request.values.v'])
    }
    const many = Object.fromEntries(
      Array.from({ length: ANTIGRAVITY_RPC_LIMITS.menuValues + 1 }, (_, i) => [
        `v${i}`,
        true,
      ]),
    )
    expect(
      pathsOf(
        AntigravityApplyInputSchema.parse({
          ...APPLY,
          request: { ...APPLY.request, values: many },
        }),
      ),
    ).toEqual(['request.values'])
    expect(
      pathsOf(
        AntigravityApplyInputSchema.parse({
          ...APPLY,
          request: { ...APPLY.request, confirmed: 'yes' },
        }),
      ),
    ).toEqual(['request.confirmed'])
  })

  it('refuses a request-level sessionId and the retired dialog fields', () => {
    expect(
      pathsOf(
        AntigravityApplyInputSchema.parse({
          ...APPLY,
          request: { ...APPLY.request, sessionId: 'ses_other' },
        }),
      ),
    ).toEqual(['request.sessionId'])
    expect(
      pathsOf(
        AntigravityApplyInputSchema.parse({
          version: 1,
          generation: GENERATION,
          scope: { kind: 'sessionless' },
          command: 'antigravity-dump',
          arguments: 'on',
        }),
      ).sort(),
    ).toEqual(['arguments', 'command', 'request'])
  })

  it('never echoes a rejected value in an issue message', () => {
    const secret = '4/0AVMBsJ-fake-code-value'
    const result = AntigravityApplyInputSchema.parse({
      ...APPLY,
      request: {
        ...APPLY.request,
        command: secret,
        values: { code: `${secret}\u0000` },
      },
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
      (_, index) => ({ cursor: index + 1, payload: TOAST }),
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

describe('notification payloads and apply output', () => {
  it('accepts the genuine shared menu’s payload and apply answer', async () => {
    // The real core menu over the embedded common-auth commands module, in
    // the host-sections mode, so the check needs no account store.
    const section = (title: string) => ({
      title,
      build: () => ({
        lines: [`${title} line`],
        items: [
          {
            id: `${title.toLowerCase()}-item`,
            label: `${title} item`,
            actions: [
              {
                id: 'run',
                label: 'Run',
                run: async () => 'ran',
              },
            ],
          },
        ],
      }),
    })
    const menu = createAntigravityCommandMenu({
      source: 'sections',
      commands: await loadCommonAuthCommands(),
      sections: {
        accounts: section('Accounts'),
        quota: section('Quota'),
        routing: section('Routing'),
        limits: section('Limits'),
      },
    })
    const invocation = { notify: () => undefined }
    const payload = await menu.open(invocation)
    expect(AntigravityNotificationPayloadSchema.parse(payload).ok).toBe(true)
    const result = await menu.apply(
      {
        command: 'antigravity',
        sectionId: payload.menu.sections[0]?.id ?? '',
        itemId: 'accounts-item',
        actionId: 'run',
      },
      invocation,
    )
    expect(result.ok).toBe(true)
    expect(AntigravityApplyResultSchema.parse(result).ok).toBe(true)
    expect(
      AntigravityApplyOutputSchema.parse({
        version: 1,
        kind: 'applied',
        generation: GENERATION,
        scope: { kind: 'sessionless' },
        result,
      }).ok,
    ).toBe(true)
  })

  it('accepts a toast and refuses a payload that mixes or misses its forms', () => {
    expect(AntigravityNotificationPayloadSchema.parse(TOAST).ok).toBe(true)
    expect(AntigravityNotificationPayloadSchema.parse(DIALOG).ok).toBe(true)
    expect(
      pathsOf(
        AntigravityNotificationPayloadSchema.parse({ ...TOAST, menu: MENU }),
      ),
    ).toEqual(['menu'])
    expect(
      pathsOf(
        AntigravityNotificationPayloadSchema.parse({
          command: 'antigravity',
          notify: { message: 'x', kind: 'debug' },
        }),
      ),
    ).toEqual(['notify.kind'])
    expect(
      pathsOf(
        AntigravityNotificationPayloadSchema.parse({ command: 'antigravity' }),
      ),
    ).toEqual(['menu'])
  })

  it('accepts the menu’s refusals: a stale or failed action and a missing confirmation', () => {
    // An account action whose item id names a credential that changed, a
    // failed action and an unconfirmed irreversible action all answer with
    // ok false, a stable code and the refreshed menu; none is reshaped here.
    for (const failure of [
      { ok: false, text: 'That account changed', code: 'refused' },
      { ok: false, text: 'Could not remove', code: 'action-failed' },
      {
        ok: false,
        text: 'Confirm first',
        code: 'needs-confirmation',
        needsConfirmation: true,
      },
    ]) {
      expect(
        AntigravityApplyResultSchema.parse({ ...RESULT, ...failure }).ok,
      ).toBe(true)
    }
    expect(
      pathsOf(
        AntigravityApplyResultSchema.parse({
          ...RESULT,
          ok: false,
          code: 'stale target',
        }),
      ),
    ).toEqual(['code'])
  })

  it('refuses a result for another command, without a menu or with unknown keys', () => {
    expect(
      pathsOf(AntigravityApplyResultSchema.parse({ ...RESULT, command: 'x' })),
    ).toEqual(['command'])
    const { menu: _menu, ...withoutMenu } = RESULT
    expect(pathsOf(AntigravityApplyResultSchema.parse(withoutMenu))).toEqual([
      'menu',
    ])
    expect(
      pathsOf(
        AntigravityApplyResultSchema.parse({ ...RESULT, accounts: [ACCOUNT] }),
      ),
    ).toEqual(['accounts'])
  })

  it('refuses an unknown section slot, knob kind and a function-valued fact', () => {
    const [section] = MENU.sections
    if (!section) throw new Error('fixture has a section')
    expect(
      pathsOf(
        AntigravityApplyResultSchema.parse({
          ...RESULT,
          menu: { ...MENU, sections: [{ ...section, slot: 'billing' }] },
        }),
      ),
    ).toEqual(['menu.sections.0.slot'])
    expect(
      pathsOf(
        AntigravityApplyResultSchema.parse({
          ...RESULT,
          menu: {
            ...MENU,
            sections: [
              {
                ...section,
                actions: [
                  {
                    id: 'a',
                    label: 'A',
                    knobs: [{ kind: 'slider', id: 's', label: 'S' }],
                  },
                ],
              },
            ],
          },
        }),
      ),
    ).toEqual(['menu.sections.0.actions.0.knobs.0.kind'])
    expect(
      pathsOf(
        AntigravityApplyResultSchema.parse({
          ...RESULT,
          menu: {
            ...MENU,
            sections: [{ ...section, facts: { run: () => undefined } }],
          },
        }),
      ),
    ).toEqual(['menu.sections.0.facts.run'])
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
            result: RESULT,
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
    const apply: AntigravityApplyInput = {
      version: 1,
      generation: GENERATION,
      scope: { kind: 'sessionless' },
      request: { command: 'antigravity', sectionId: 'limits', actionId: 'set' },
    }
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

describe('selectors, account limit and settings', () => {
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
})
