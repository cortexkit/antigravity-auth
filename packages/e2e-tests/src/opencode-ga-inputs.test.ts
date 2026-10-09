import { describe, expect, it } from 'bun:test'
import type { AntigravityStateSnapshot } from '../../opencode/src/ga/rpc/protocol.ts'
import type { HarnessAccountsObservation } from '../../opencode/src/ga/server/index.ts'
import type { GaMenu, GaOpenedMenu } from './opencode-ga-harness.ts'
import {
  actionShape,
  captureMenuItem,
  findAccountOverrideAction,
  findMenuSection,
  matchSameReadObservation,
  menuRequest,
  normalizeSameReadState,
} from './opencode-ga-inputs.ts'

// Synthetic state answers and observations only. These tests exercise the
// parsing and menu-matching helpers; they never run the production factory,
// the account store, the generated SDK or a real OpenCode host.
const selector = `sel-${'A'.repeat(32)}`
function snapshot(): AntigravityStateSnapshot {
  return {
    version: 1,
    kind: 'snapshot',
    generation: 'test-generation',
    scope: { kind: 'session', sessionID: 'synthetic-session' },
    reset: 'initial',
    cursor: 0,
    dropped: 0,
    more: false,
    notifications: [],
    readSeq: 1,
    accountsStatus: { kind: 'complete' },
    accounts: [
      {
        selector,
        id: 'acct-0',
        label: 'Account 1',
        enabled: true,
        health: 100,
        current: true,
        quota: { gemini: { remainingPercent: 75 } },
      },
    ],
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
}
function observation(): HarnessAccountsObservation {
  return {
    generation: 'test-generation',
    readSeq: 1,
    status: 'ready',
    accountsStatus: 'complete',
    accounts: [
      {
        selector,
        position: 0,
        enabled: true,
        usable: true,
        metadataStatus: 'present',
        accessBlock: { kind: 'none' },
        currentFor: ['active'],
        cooldownUntil: null,
      },
    ],
    retiredSelectors: [],
  }
}

describe('GA tracked input same-read/source controls', () => {
  it('requires the exact generation and read sequence, not a cached account snapshot', () => {
    const state = snapshot()
    expect(matchSameReadObservation(state, [observation()]).readSeq).toBe(1)
    expect(() =>
      matchSameReadObservation(state, [{ ...observation(), readSeq: 2 }]),
    ).toThrow('Missing or ambiguous')
    expect(() =>
      matchSameReadObservation(state, [observation(), observation()]),
    ).toThrow('Missing or ambiguous')
    expect(() =>
      matchSameReadObservation(state, [
        { ...observation(), generation: 'foreign' },
      ]),
    ).toThrow('Missing or ambiguous')
  })

  it('never synthesizes ready/complete data for missing, invalid or over-limit reads', () => {
    expect(() =>
      matchSameReadObservation(snapshot(), [
        { ...observation(), status: 'error' },
      ]),
    ).toThrow('pending/error/over-limit')
    expect(() =>
      matchSameReadObservation(snapshot(), [
        { ...observation(), accountsStatus: 'over-limit' },
      ]),
    ).toThrow('pending/error/over-limit')
    expect(() =>
      matchSameReadObservation(snapshot(), [
        { ...observation(), accounts: [] },
      ]),
    ).toThrow('same complete read')
  })

  it('keeps unknown/invalid metadata truthful rather than asserting no access block', () => {
    for (const kind of ['unknown', 'invalid'] as const) {
      const observed = {
        ...observation(),
        accounts: [
          {
            ...observation().accounts[0]!,
            metadataStatus: 'dropped-invalid' as const,
            accessBlock: { kind },
          },
        ],
      }
      const view = normalizeSameReadState(snapshot(), observed, 500)
      expect(view.rows[0]?.accessBlock.kind).toBe(kind)
      expect(view.rows[0]?.verificationRequired).toBeUndefined()
      expect(view.rows[0]?.accountIneligible).toBeUndefined()
      expect(view.rows[0]?.reason).toBeUndefined()
    }
  })

  it('uses fresh settings carried by the same actual state response', () => {
    const first = snapshot()
    const second = {
      ...snapshot(),
      readSeq: 2,
      settings: {
        ...first.settings,
        routing: { cliFirst: true, quotaStyleFallback: false },
        logLevel: 'debug' as const,
        dump: { enabled: true },
      },
    }
    expect(normalizeSameReadState(first, observation(), 500).routing).toBe(
      'antigravity_first',
    )
    const view = normalizeSameReadState(
      second,
      { ...observation(), readSeq: 2 },
      500,
    )
    expect(view.routing).toBe('cli_first')
    expect(view.logging).toBe('debug')
    expect(view.dump).toEqual({ enabled: true })
  })
})

// A menu shaped like the one core's createAntigravityCommandMenu emits for a
// two-account repository: item ids are opaque and labels follow positions.
const selectorB = `sel-${'B'.repeat(32)}`
function twoAccountState(
  selectors = [selector, selectorB],
): AntigravityStateSnapshot {
  const base = snapshot()
  return {
    ...base,
    accounts: selectors.map((value, index) => ({
      selector: value,
      id: `acct-${index}`,
      label: `Account ${index + 1}`,
      enabled: true,
      health: 100,
      current: index === 0,
      quota: {},
    })),
  }
}
function menu(
  itemLabels = ['Account 1', 'Account 2'],
  extraItemActions: GaMenu['sections'][number]['items'][number]['actions'] = [],
): GaMenu {
  return {
    command: 'antigravity',
    title: 'Antigravity',
    sections: [
      {
        id: 'accounts',
        slot: 'accounts',
        title: 'Accounts',
        lines: [],
        actions: [],
        items: itemLabels.map((label, index) => ({
          id: `acct-opaque${index}`,
          label,
          actions: [
            { id: 'disable', label: 'Disable', knobs: [] },
            {
              id: 'remove',
              label: 'Remove',
              knobs: [],
              confirm: { message: 'Remove?', irreversible: true },
            },
            ...extraItemActions,
          ],
        })),
      },
      {
        id: 'limits',
        slot: 'limits',
        title: 'Limits',
        lines: [],
        items: [],
        actions: [
          {
            id: 'set',
            label: 'Change limits',
            knobs: [
              {
                kind: 'toggle',
                id: 'enabled',
                label: 'Quota killswitch',
                value: false,
              },
              {
                kind: 'number',
                id: 'minimumRemainingPercent',
                label: 'Minimum remaining percent',
                value: 5,
                min: 0,
                max: 100,
              },
            ],
          },
        ],
      },
    ],
  }
}
function opened(
  before = twoAccountState(),
  after = twoAccountState(),
  emitted = menu(),
): GaOpenedMenu {
  return { before, after, menu: emitted }
}

describe('GA menu targeting', () => {
  it('targets the server-issued item id of the row the redacted id picks', () => {
    const { target } = captureMenuItem(opened(), 'acct-1')
    expect(target.itemId).toBe('acct-opaque1')
    expect(target.selector).toBe(selectorB)
    expect(target.sectionId).toBe('accounts')
    expect(target.actions).toEqual(['disable', 'remove'])
  })

  it('refuses to match items when the roster changed while the menu was built', () => {
    expect(() =>
      captureMenuItem(
        opened(twoAccountState(), twoAccountState([selectorB, selector])),
        'acct-1',
      ),
    ).toThrow('Accounts changed while the menu was built')
    expect(() =>
      captureMenuItem(
        opened(twoAccountState(), {
          ...twoAccountState(),
          generation: 'other',
        }),
        'acct-1',
      ),
    ).toThrow('Accounts changed while the menu was built')
  })

  it('refuses menu items that do not line up with the state roster', () => {
    expect(() =>
      captureMenuItem(
        opened(undefined, undefined, menu(['Account 1'])),
        'acct-0',
      ),
    ).toThrow('do not line up')
    expect(() =>
      captureMenuItem(
        opened(undefined, undefined, menu(['Account 2', 'Account 1'])),
        'acct-0',
      ),
    ).toThrow('do not line up')
    expect(() => captureMenuItem(opened(), 'acct-9')).toThrow(
      'no account with the requested redacted id',
    )
  })

  it('sends only emitted knobs and confirms only actions that asked for it', () => {
    const accounts = findMenuSection(menu(), 'accounts')
    const [disable, remove] = accounts.items[0]!.actions
    expect(
      menuRequest(
        'accounts',
        'disable',
        actionShape(disable!),
        {},
        'acct-opaque0',
      ),
    ).toEqual({
      sectionId: 'accounts',
      actionId: 'disable',
      itemId: 'acct-opaque0',
    })
    expect(
      menuRequest(
        'accounts',
        'remove',
        actionShape(remove!),
        {},
        'acct-opaque0',
      ),
    ).toEqual({
      sectionId: 'accounts',
      actionId: 'remove',
      itemId: 'acct-opaque0',
      confirmed: true,
    })
    const limits = findMenuSection(menu(), 'limits')
    expect(
      menuRequest('limits', 'set', actionShape(limits.actions[0]!), {
        enabled: true,
        minimumRemainingPercent: 95,
      }),
    ).toEqual({
      sectionId: 'limits',
      actionId: 'set',
      values: { enabled: true, minimumRemainingPercent: 95 },
    })
    expect(() =>
      menuRequest('limits', 'set', actionShape(limits.actions[0]!), {
        accountKey: 'abc',
      }),
    ).toThrow('has no accountKey knob')
  })

  it('reports a missing per-account override action as missing evidence', () => {
    const { item } = captureMenuItem(opened(), 'acct-0')
    expect(() => findAccountOverrideAction(menu(), item)).toThrow(
      'Missing evidence',
    )
    const withOverride = menu(undefined, [
      {
        id: 'limit',
        label: 'Account limit',
        knobs: [
          {
            kind: 'number',
            id: 'minimumRemainingPercent',
            label: 'Minimum remaining percent',
            min: 0,
            max: 100,
          },
        ],
      },
    ])
    const captured = captureMenuItem(
      opened(undefined, undefined, withOverride),
      'acct-0',
    )
    expect(findAccountOverrideAction(withOverride, captured.item)).toEqual({
      actionId: 'limit',
      knobId: 'minimumRemainingPercent',
    })
    // Only the action with id `limit` is the per-account floor; the same
    // number knob on an action with another id does not count.
    const otherAction = menu(undefined, [
      {
        id: 'threshold',
        label: 'Other',
        knobs: [
          {
            kind: 'number',
            id: 'minimumRemainingPercent',
            label: 'Minimum remaining percent',
          },
        ],
      },
    ])
    expect(() =>
      findAccountOverrideAction(
        otherAction,
        captureMenuItem(opened(undefined, undefined, otherAction), 'acct-0')
          .item,
      ),
    ).toThrow('Missing evidence')
  })
})
