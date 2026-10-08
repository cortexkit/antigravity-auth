/**
 * The `/antigravity` menu over the genuine common-auth `./commands` entry
 * and a genuine account repository on the public pool store, in a fresh
 * store under a disposable directory. Token exchange is never called.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  initializeFreshAccountStore,
  readAccountStoreAdmission,
} from './account-migration.ts'
import { createAccountRepositoryFactory } from './account-repository.ts'
import type {
  AccountRepository,
  AccountRepositoryRead,
} from './account-repository-types.ts'
import {
  type AntigravityMenuSettings,
  type AntigravityRepositoryMenuOptions,
  createAntigravityCommandMenu,
} from './antigravity-command-menu.ts'
import {
  loadCommonAuthCommands,
  loadCommonAuthStoreModules,
} from './common-auth-runtime.ts'

let root: string
let repository: AccountRepository

beforeEach(async () => {
  // The migration module refuses a parent path that traverses a symlink,
  // and the system temp directory is one on macOS.
  root = realpathSync(mkdtempSync(join(tmpdir(), 'antigravity-menu-')))
  const legacyPath = join(root, 'antigravity-accounts.json')
  const modules = await loadCommonAuthStoreModules()
  const initialized = await initializeFreshAccountStore(modules, {
    legacyPath,
    now: Date.now,
  })
  if (initialized.status !== 'completed') throw new Error('init pending')
  const admission = await readAccountStoreAdmission(
    legacyPath,
    modules,
    Date.now,
  )
  if (admission.status !== 'active') throw new Error(admission.status)
  repository = createAccountRepositoryFactory(modules)({
    paths: admission.paths,
    now: Date.now,
    exchange: async () => {
      throw new Error('token exchange is not part of these tests')
    },
  })
  for (const name of ['first', 'second']) {
    await repository.login({
      id: crypto.randomUUID(),
      refreshToken: `refresh-${name}-secret`,
      identity: `${name}@example.com`,
      metadata: { email: `${name}@example.com`, addedAt: 1, lastUsed: 1 },
    })
  }
})

afterEach(async () => {
  await repository.dispose()
  rmSync(root, { recursive: true, force: true })
})

const invocation = { notify: () => undefined }

async function readyRows(): Promise<
  Extract<AccountRepositoryRead, { status: 'ready' }>['rows']
> {
  const read = await repository.read()
  if (read.status !== 'ready') throw new Error(read.status)
  return read.rows
}

async function menu(
  settingsLog: AntigravityMenuSettings[] = [],
  refreshQuota?: AntigravityRepositoryMenuOptions['refreshQuota'],
) {
  let settings: AntigravityMenuSettings = {
    routing: { cliFirst: false, quotaStyleFallback: false },
    killswitch: { enabled: false, minimumRemainingPercent: 5 },
  }
  return createAntigravityCommandMenu({
    source: 'repository',
    commands: await loadCommonAuthCommands(),
    accounts: repository,
    settings: {
      read: () => settings,
      updateRouting: async (routing) => {
        settings = { ...settings, routing }
        settingsLog.push(settings)
      },
      updateKillswitch: async (killswitch) => {
        settings = { ...settings, killswitch }
        settingsLog.push(settings)
      },
    },
    ...(refreshQuota ? { refreshQuota } : {}),
  })
}

async function accountItemIds(
  built: Awaited<ReturnType<typeof menu>>,
): Promise<string[]> {
  const payload = await built.open(invocation)
  const accounts = payload.menu.sections.find(
    (section) => section.id === 'accounts',
  )
  return accounts?.items.map((item) => item.id) ?? []
}

describe('createAntigravityCommandMenu', () => {
  it('shows the four account slots in order without row ids, emails or tokens', async () => {
    const built = await menu()
    const payload = await built.open(invocation)
    expect(payload.command).toBe('antigravity')
    expect(payload.menu.sections.map((section) => section.slot)).toEqual([
      'accounts',
      'quota',
      'routing',
      'limits',
    ])
    const text = JSON.stringify(payload)
    for (const row of await readyRows()) expect(text).not.toContain(row.ref.id)
    expect(text).not.toContain('@example.com')
    expect(text).not.toContain('secret')
    const items = payload.menu.sections[0]?.items ?? []
    expect(items.map((item) => item.label)).toEqual(['Account 1', 'Account 2'])
    expect(items.every((item) => item.account === undefined)).toBe(true)
  })

  it('disables exactly the credential the item was opened for', async () => {
    const built = await menu()
    const [, second] = await accountItemIds(built)
    const result = await built.apply(
      {
        command: 'antigravity',
        sectionId: 'accounts',
        itemId: second,
        actionId: 'disable',
      },
      invocation,
    )
    expect(result.ok).toBe(true)
    expect((await readyRows()).map((row) => row.enabled)).toEqual([true, false])
  })

  it('refuses an item whose credential was replaced, writing nothing', async () => {
    const built = await menu()
    const [first] = await accountItemIds(built)
    const [row] = await readyRows()
    if (!row) throw new Error('missing row')
    await repository.replaceCredential(row.ref, {
      refreshToken: 'refresh-replaced-secret',
      identity: 'first@example.com',
      disabled: 'keep',
    })
    const result = await built.apply(
      {
        command: 'antigravity',
        sectionId: 'accounts',
        itemId: first,
        actionId: 'disable',
      },
      invocation,
    )
    expect(result.ok).toBe(false)
    expect(result.code).toBe('unavailable')
    expect((await readyRows()).map((entry) => entry.enabled)).toEqual([
      true,
      true,
    ])
    const [renewed] = await accountItemIds(built)
    expect(renewed).not.toBe(first)
  })

  it('keeps item ids across a reorder', async () => {
    const built = await menu()
    const [first, second] = await accountItemIds(built)
    if (!first || !second) throw new Error('missing items')
    const rows = await readyRows()
    await repository.reorder(rows.map((row) => row.ref.id).reverse())
    expect(await accountItemIds(built)).toEqual([second, first])
  })

  it('removes only after the library confirmation', async () => {
    const built = await menu()
    const [first] = await accountItemIds(built)
    const request = {
      command: 'antigravity',
      sectionId: 'accounts',
      itemId: first,
      actionId: 'remove',
    }
    const unconfirmed = await built.apply(request, invocation)
    expect(unconfirmed.needsConfirmation).toBe(true)
    expect(await readyRows()).toHaveLength(2)
    const confirmed = await built.apply(
      { ...request, confirmed: true },
      invocation,
    )
    expect(confirmed.ok).toBe(true)
    expect(await readyRows()).toHaveLength(1)
  })

  it('reads routing fresh and writes it only through the settings source', async () => {
    const log: AntigravityMenuSettings[] = []
    const built = await menu(log)
    const result = await built.apply(
      {
        command: 'antigravity',
        sectionId: 'routing',
        actionId: 'set',
        values: { cliFirst: true },
      },
      invocation,
    )
    expect(result.ok).toBe(true)
    expect(log).toHaveLength(1)
    const routing = result.menu.sections.find(
      (section) => section.id === 'routing',
    )
    expect(routing?.lines[0]).toBe('Gemini CLI headers first: on')
  })
})

describe('createAntigravityCommandMenu quota check', () => {
  const request = {
    command: 'antigravity',
    sectionId: 'quota',
    actionId: 'refresh',
  }

  it('offers no check action without a quota service', async () => {
    const payload = await (await menu()).open(invocation)
    const quota = payload.menu.sections.find((entry) => entry.id === 'quota')
    expect(quota?.actions).toEqual([])
  })

  it('checks exactly the rows read and reports the readings taken', async () => {
    const asked: string[][] = []
    const built = await menu([], async (refs) => {
      asked.push(refs.map((ref) => ref.id))
      return { checked: 1, notChecked: 1 }
    })
    const result = await built.apply(request, invocation)
    expect(asked).toEqual([(await readyRows()).map((row) => row.ref.id)])
    expect(result).toMatchObject({
      ok: true,
      text: 'Quota checked for 1 of 2 accounts; 1 could not be checked',
    })
  })

  it('never reports success when no reading was taken', async () => {
    const built = await menu([], async () => ({ checked: 0, notChecked: 2 }))
    const result = await built.apply(request, invocation)
    expect(result).toMatchObject({ ok: false, code: 'quota-unavailable' })
  })
})

describe('createAntigravityCommandMenu sections mode', () => {
  it('dispatches host item ids through the library without reading the repository', async () => {
    // Sections mode takes no repository at all; the store must be exactly
    // as it was after the host's action ran.
    const before = JSON.stringify(await readyRows())
    const ran: string[] = []
    const section = (title: string) => ({
      title,
      build: () => ({
        lines: [`${title} for the signed-in account`],
        items: [
          {
            id: 'login-1',
            label: 'Signed-in account',
            actions: [
              {
                id: 'sign-out',
                label: 'Sign out',
                irreversible: true as const,
                confirm: 'Sign out?',
                run: async () => {
                  ran.push(title)
                  return 'Signed out'
                },
              },
            ],
          },
        ],
      }),
    })
    const built = createAntigravityCommandMenu({
      source: 'sections',
      commands: await loadCommonAuthCommands(),
      sections: {
        accounts: section('Accounts'),
        quota: section('Quota'),
        routing: section('Routing'),
        limits: section('Limits'),
      },
    })
    const payload = await built.open(invocation)
    expect(payload.menu.sections.map((entry) => entry.slot)).toEqual([
      'accounts',
      'quota',
      'routing',
      'limits',
    ])
    const request = {
      command: 'antigravity',
      sectionId: 'accounts',
      itemId: 'login-1',
      actionId: 'sign-out',
    }
    expect((await built.apply(request, invocation)).needsConfirmation).toBe(
      true,
    )
    expect(ran).toEqual([])
    const done = await built.apply({ ...request, confirmed: true }, invocation)
    expect(done.ok).toBe(true)
    expect(ran).toEqual(['Accounts'])
    expect(JSON.stringify(await readyRows())).toBe(before)
  })

  it('refuses an incomplete sections mode at construction', async () => {
    const commands = await loadCommonAuthCommands()
    const sections = {
      accounts: { title: 'Accounts', build: () => ({}) },
      quota: { title: 'Quota', build: () => ({}) },
      routing: { title: 'Routing', build: () => ({}) },
    }
    // Built outside the type checker, as a JavaScript caller would.
    expect(() =>
      Reflect.apply(createAntigravityCommandMenu, undefined, [
        { source: 'sections', commands, sections },
      ]),
    ).toThrow('limits section')
    expect(() =>
      Reflect.apply(createAntigravityCommandMenu, undefined, [
        { source: 'pool', commands },
      ]),
    ).toThrow('repository or sections')
  })
})
