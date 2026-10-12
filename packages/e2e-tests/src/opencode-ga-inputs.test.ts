import { describe, expect, it } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  initializeFreshAccountStore,
  readAccountStoreAdmission,
} from '../../core/src/account-migration.ts'
import { createAccountRepositoryFactory } from '../../core/src/account-repository.ts'
import type { RowRef } from '../../core/src/account-repository-types.ts'
import {
  type AntigravityAccountLimitSource,
  type AntigravityRepositoryMenuOptions,
  createAntigravityCommandMenu,
} from '../../core/src/antigravity-command-menu.ts'
import {
  loadCommonAuthCommands,
  loadCommonAuthStoreModules,
} from '../../core/src/common-auth-runtime.ts'
import type { AntigravityStateSnapshot } from '../../opencode/src/ga/rpc/protocol.ts'
import type { HarnessAccountsObservation } from '../../opencode/src/ga/server/index.ts'
import {
  GA_KNOWN_ACCOUNT_ITEM_ACTIONS,
  GA_REAUTHORIZE_ACTION,
  type GaMenu,
  type GaOpenedMenu,
} from './opencode-ga-harness.ts'
import {
  actionShape,
  captureMenuItem,
  findAccountOverrideAction,
  findMenuSection,
  matchSameReadObservation,
  menuRequest,
  normalizeSameReadState,
} from './opencode-ga-inputs.ts'

// These tests exercise the parsing and menu-matching helpers on synthetic
// state answers, plus one block that runs createAntigravityCommandMenu from
// packages/core over a fresh account store in a temporary directory. None
// runs the plugin's createGaAntigravityPlugin factory,
// the generated SDK or a real OpenCode host.
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

// createAntigravityCommandMenu from packages/core over a fresh account store,
// so the targeting helpers are checked against the menu the product emits
// rather than a hand-built copy. The floor source is an in-memory stand-in
// that records the account reference (RowRef: the store's handle for one
// exact credential) the menu passes it. The OpenCode 2 plugin's own floor
// source, createStoreAccountLimits, is not run here.
describe('GA menu targeting against the core menu', () => {
  async function coreMenu(
    accountLimits?: AntigravityAccountLimitSource,
    reauthorize?: AntigravityRepositoryMenuOptions['reauthorize'],
  ) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'ga-core-menu-')))
    const legacyPath = join(root, 'antigravity-accounts.json')
    const modules = await loadCommonAuthStoreModules()
    const initialized = await initializeFreshAccountStore(modules, {
      legacyPath,
      now: Date.now,
    })
    if (initialized.status !== 'completed')
      throw new Error('store not initialized')
    const admission = await readAccountStoreAdmission(
      legacyPath,
      modules,
      Date.now,
    )
    if (admission.status !== 'active') throw new Error(admission.status)
    const repository = createAccountRepositoryFactory(modules)({
      paths: admission.paths,
      now: Date.now,
      exchange: async () => {
        throw new Error('token exchange is not part of these tests')
      },
    })
    for (const name of ['first', 'second'])
      await repository.login({
        id: crypto.randomUUID(),
        refreshToken: `synthetic-${name}-refresh`,
        identity: `${name}@example.invalid`,
        metadata: { email: `${name}@example.invalid`, addedAt: 1, lastUsed: 1 },
      })
    let settings = {
      routing: { cliFirst: false, quotaStyleFallback: false },
      killswitch: { enabled: false, minimumRemainingPercent: 5 },
    }
    const menu = createAntigravityCommandMenu({
      source: 'repository',
      commands: await loadCommonAuthCommands(),
      accounts: repository,
      settings: {
        read: () => settings,
        updateRouting: async (routing) => {
          settings = { ...settings, routing }
        },
        updateKillswitch: async (killswitch) => {
          settings = { ...settings, killswitch }
        },
      },
      ...(accountLimits ? { accountLimits } : {}),
      ...(reauthorize ? { reauthorize } : {}),
    })
    const read = await repository.read()
    if (read.status !== 'ready') throw new Error(read.status)
    const dispose = async () => {
      await repository.dispose()
      rmSync(root, { recursive: true, force: true })
    }
    return { menu, rows: read.rows, dispose }
  }
  const invocation = { notify: () => undefined }

  it('applies the account item limit action to exactly the captured credential', async () => {
    const floors: Array<{ ref: RowRef; value: number | null }> = []
    const { menu, rows, dispose } = await coreMenu({
      read: () => null,
      write: async (ref, value) => {
        floors.push({ ref, value })
        return 'applied'
      },
    })
    try {
      const payload = await menu.open(invocation)
      const state = twoAccountState()
      const { target, item } = captureMenuItem(
        { before: state, after: state, menu: payload.menu },
        'acct-1',
      )
      const override = findAccountOverrideAction(payload.menu, item)
      expect(override).toEqual({
        actionId: 'limit',
        knobId: 'minimumRemainingPercent',
      })
      const action = item.actions.find(
        (candidate) => candidate.id === override.actionId,
      )
      if (!action) throw new Error('limit action missing')
      const result = await menu.apply(
        {
          command: 'antigravity',
          ...menuRequest(
            target.sectionId,
            override.actionId,
            actionShape(action),
            { [override.knobId]: 0 },
            target.itemId,
          ),
        },
        invocation,
      )
      expect(result.ok).toBe(true)
      expect(floors).toHaveLength(1)
      expect(floors[0]?.value).toBe(0)
      expect(floors[0]?.ref).toEqual(rows[1]?.ref)
    } finally {
      await dispose()
    }
  })

  it('reports missing evidence when the host supplies no floor source', async () => {
    const { menu, dispose } = await coreMenu()
    try {
      const payload = await menu.open(invocation)
      const state = twoAccountState()
      const { item } = captureMenuItem(
        { before: state, after: state, menu: payload.menu },
        'acct-0',
      )
      expect(() => findAccountOverrideAction(payload.menu, item)).toThrow(
        'Missing evidence',
      )
    } finally {
      await dispose()
    }
  })

  it('offers no account-item action outside the known set', async () => {
    const { menu, dispose } = await coreMenu(
      { read: () => null, write: async () => 'applied' },
      { run: async () => 'started' },
    )
    try {
      const payload = await menu.open(invocation)
      const accounts = findMenuSection(payload.menu, 'accounts')
      const offered = accounts.items.flatMap((item) =>
        item.actions.map((action) => action.id),
      )
      expect(offered.length).toBeGreaterThan(0)
      expect(
        offered.filter((id) => !GA_KNOWN_ACCOUNT_ITEM_ACTIONS.has(id)),
      ).toEqual([])
    } finally {
      await dispose()
    }
  })

  it('runs Reauthorize for exactly the captured credential', async () => {
    const started: RowRef[] = []
    const { menu, rows, dispose } = await coreMenu(undefined, {
      run: async (ref) => {
        started.push(ref)
        return 'Sign in with the browser to reauthorize this account'
      },
    })
    try {
      const payload = await menu.open(invocation)
      const state = twoAccountState()
      const { target, item } = captureMenuItem(
        { before: state, after: state, menu: payload.menu },
        'acct-0',
      )
      expect(target.actions).toContain(GA_REAUTHORIZE_ACTION)
      expect(target.itemLabel).toBe('Account 1')
      expect(target.sectionTitle).toBe('Accounts')
      const action = item.actions.find(
        (candidate) => candidate.id === GA_REAUTHORIZE_ACTION,
      )
      if (!action) throw new Error('reauthorize action missing')
      expect(target.actionLabels[GA_REAUTHORIZE_ACTION]).toBe(action.label)
      const result = await menu.apply(
        {
          command: 'antigravity',
          ...menuRequest(
            target.sectionId,
            GA_REAUTHORIZE_ACTION,
            actionShape(action),
            {},
            target.itemId,
          ),
        },
        invocation,
      )
      expect(result.ok).toBe(true)
      expect(started).toHaveLength(1)
      expect(started[0]).toEqual(rows[0]?.ref)
    } finally {
      await dispose()
    }
  })

  it('offers no Reauthorize action when the host supplies no sign-in', async () => {
    const { menu, dispose } = await coreMenu()
    try {
      const payload = await menu.open(invocation)
      const state = twoAccountState()
      const { target } = captureMenuItem(
        { before: state, after: state, menu: payload.menu },
        'acct-0',
      )
      expect(target.actions).not.toContain(GA_REAUTHORIZE_ACTION)
    } finally {
      await dispose()
    }
  })
})
