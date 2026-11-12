import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  type CommonAuthCommandsModule,
  loadCommonAuthClaustrum,
  loadCommonAuthCommands,
} from '@cortexkit/antigravity-auth-core'
import type { ClaustrumScopedClient } from '@cortexkit/antigravity-auth-core/common-auth/claustrum'
import type {
  CommandDialogPayload,
  CommandInvocation,
  CommandMenu,
  PiMenuUi,
} from '@cortexkit/antigravity-auth-core/common-auth/commands'
import type { Api, Provider } from '@earendil-works/pi-ai'
import type {
  ExtensionCommandContext,
  ProviderConfig,
  RegisteredCommand,
} from '@earendil-works/pi-coding-agent'

import { registerCortexKitPiAntigravity } from './index.ts'
import { PiVaultSetup } from './vault-setup.ts'

const TOKEN = 'd'.repeat(64)

/** The vault's scoped API answering from a script; one Antigravity account unless `emptyRoster`. */
function loopbackVault(): ClaustrumScopedClient {
  return {
    listScoped: async () => ({
      view: 'view-1',
      rows: emptyRoster
        ? []
        : [
            {
              id: 'cred-a',
              categories: ['antigravity-native'],
              credentialType: 'oauth',
              serves: [],
              providerIds: [],
              refreshAdapter: 'antigravity',
              state: 'active',
              recordVersion: 1,
              operations: ['read'],
              createdAtMs: null,
              accountId: 'account-a',
              email: 'a@example.com',
            },
          ],
      grants: rosterGrants.grants,
      grantTuples: rosterGrants.grantTuples,
    }),
    getScoped: async () => {
      throw new Error('the menu never fetches a credential')
    },
    reportAuthFailureScoped: async () => {},
    close: () => {},
  }
}

function enrollmentEndpoint() {
  return {
    enrollPropose: async () => ({ requestId: 'request-1' }),
    enrollPoll: async () => ({
      status: 'approved' as const,
      name: 'antigravity-auth-pi',
      token: TOKEN,
      tokenGeneration: 1,
    }),
    close: () => {},
  }
}

let dir: string
let hostSlot: unknown
/** True when the vault grants this host no Antigravity accounts. */
let emptyRoster: boolean
/** The grants the vault names in its listing; both undefined for a vault that names none. */
let rosterGrants: Pick<
  Awaited<ReturnType<ClaustrumScopedClient['listScoped']>>,
  'grants' | 'grantTuples'
>

beforeEach(async () => {
  dir = await mkdtemp(
    join(process.platform === 'win32' ? tmpdir() : '/tmp', 'pi-menu-'),
  )
  hostSlot = undefined
  emptyRoster = false
  rosterGrants = { grants: undefined, grantTuples: undefined }
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/**
 * Registers Pi's extension and opens its `/antigravity` command once. The
 * genuine commands library builds the menu; only its Pi renderer is
 * replaced so the test receives the menu instead of drawing it.
 */
async function openPiMenu(trace: (phase: string) => void = () => {}) {
  trace('commands-load-start')
  const genuine = await loadCommonAuthCommands()
  trace('commands-load-finish')
  const menus: CommandMenu[] = []
  const commands: CommonAuthCommandsModule = {
    ...genuine,
    runPiCommandMenu: async (menu: CommandMenu, _ui: PiMenuUi) => {
      menus.push(menu)
    },
  }
  const registered: Array<{
    name: string
    options: Omit<RegisteredCommand, 'name' | 'sourceInfo'>
  }> = []
  const providers: ProviderConfig[] = []
  function registerProvider(provider: Provider<Api>): void
  function registerProvider(name: string, config: ProviderConfig): void
  function registerProvider(
    name: string | Provider<Api>,
    config?: ProviderConfig,
  ): void {
    if (typeof name === 'string' && config) {
      providers.push(config)
      trace('provider-registered')
    }
  }
  await registerCortexKitPiAntigravity(
    {
      registerProvider,
      registerCommand: (name, options) => {
        registered.push({ name, options })
      },
    },
    {
      vaultDir: join(dir, 'vault'),
      nativeAuthPath: join(dir, 'native', 'auth.json'),
      nativeStashPath: join(dir, 'vault', 'google-login-stash.json'),
      modeFile: join(dir, 'vault', 'pi-mode.json'),
      rosterFile: join(dir, 'vault', 'pi-roster.json'),
      readHostSlot: () => hostSlot,
      loadClaustrum: async () => {
        trace('claustrum-load-start')
        const module = await loadCommonAuthClaustrum()
        trace('claustrum-load-finish')
        return module
      },
      connect: async () => {
        trace('vault-connect')
        const client = loopbackVault()
        return {
          ...client,
          listScoped: async () => {
            trace('roster-list-start')
            const roster = await client.listScoped()
            trace('roster-list-finish')
            return roster
          },
        }
      },
      connectEnrollment: async () => {
        trace('enrollment-connect')
        const client = enrollmentEndpoint()
        return {
          ...client,
          enrollPropose: async () => {
            trace('propose')
            return client.enrollPropose()
          },
          enrollPoll: async () => {
            trace('approval-poll')
            return client.enrollPoll()
          },
          close: () => {
            trace('enrollment-close')
            client.close()
          },
        }
      },
      loadCommands: async () => commands,
    },
  )
  expect(registered.map((entry) => entry.name)).toEqual(['antigravity'])
  const ctx = {
    ui: {
      select: async () => undefined,
      confirm: async () => false,
      input: async () => undefined,
      notify: () => {},
    },
    sessionManager: { getSessionId: () => 'session-1' },
  } as unknown as ExtensionCommandContext
  await registered[0]?.options.handler('', ctx)
  const menu = menus[0]
  if (!menu) throw new Error('the command opened no menu')
  return { menu, providers }
}

const invocation: CommandInvocation = {
  sessionId: 'session-1',
  notify: () => {},
}

function section(payload: CommandDialogPayload, id: string) {
  const found = payload.menu.sections.find((entry) => entry.id === id)
  if (!found) throw new Error(`no section ${id}`)
  return found
}

async function apply(menu: CommandMenu, sectionId: string, actionId: string) {
  return menu.apply(
    {
      command: 'antigravity',
      sectionId,
      actionId,
      confirmed: true,
      sessionId: 'session-1',
    },
    invocation,
  )
}

it('public unreadable enrollment makes Accounts and Routing refuse local serving and keeps Disconnect reachable', async () => {
  const claustrum = await loadCommonAuthClaustrum()
  const setup = new PiVaultSetup({
    claustrum,
    stateDir: join(dir, 'vault'),
    modeFile: join(dir, 'vault', 'pi-mode.json'),
    readHostSlot: () => hostSlot,
    connectEnrollment: async () => enrollmentEndpoint(),
  })
  await setup.connectStep()
  await writeFile(setup.paths.statePath, '{broken enrollment')
  const { menu } = await openPiMenu()
  const payload = await menu.open(invocation)
  expect(section(payload, 'accounts').lines.join('\n')).toContain(
    "Pi can't tell whether to use the vault or its own login",
  )
  expect(section(payload, 'routing').lines.join('\n')).toContain('refused')
  expect(section(payload, 'routing').lines.join('\n')).not.toContain(
    "uses Pi's own login",
  )
  expect(
    section(payload, 'vault').actions.some((action) => action.id === 'forget'),
  ).toBe(true)
  const bytes = await readFile(setup.paths.statePath, 'utf8')
  await expect(setup.useLocal()).rejects.toThrow()
  expect(await readFile(setup.paths.statePath, 'utf8')).toBe(bytes)
})

describe('Pi /antigravity menu', () => {
  it('shows the four account slots then the Vault extra, for the local login', async () => {
    hostSlot = {
      type: 'oauth',
      access: 'real-access',
      refresh: 'real-refresh',
      expires: 1,
    }
    const { menu } = await openPiMenu()
    const payload = await menu.open(invocation)

    expect(payload.menu.sections.map((entry) => entry.slot)).toEqual([
      'accounts',
      'quota',
      'routing',
      'limits',
      'extra',
    ])
    expect(section(payload, 'vault').title).toBe('Vault')
    expect(section(payload, 'accounts').lines).toContain(
      "Signed in with Pi's own login. Pi's /login replaces it and /logout removes it.",
    )
    expect(section(payload, 'routing').lines).toEqual([
      "Every request uses Pi's own login. There is no account rotation.",
    ])
    expect(JSON.stringify(payload)).not.toContain('real-access')
  })

  it('enrolls and switches to the vault through the shared dispatcher, then names the serving account', async () => {
    const startedAt = performance.now()
    const trace = (phase: string) =>
      console.log(
        JSON.stringify({
          piMenuPhase: phase,
          elapsedMs: performance.now() - startedAt,
        }),
      )
    const { menu, providers } = await openPiMenu(trace)

    trace('request-access-start')
    const requested = await apply(menu, 'vault', 'request-access')
    trace('request-access-finish')
    expect(requested.ok).toBe(true)
    expect(requested.text).toContain(
      'Vault access: approved by the vault operator.',
    )

    trace('stale-use-vault-start')
    const switched = await apply(menu, 'vault', 'use-vault')
    trace('stale-use-vault-finish')
    expect(switched).toMatchObject({ ok: false })
    expect(switched.text).toContain('That action is no longer available')
    expect(providers.at(-1)?.oauth).toBeUndefined()

    trace('menu-open-start')
    const payload = await menu.open(invocation)
    trace('menu-open-finish')
    const accounts = section(payload, 'accounts')
    expect(accounts.items.map((item) => [item.label, item.detail])).toEqual([
      ['Vault account 1', 'in use by Pi · All models'],
    ])
    expect(section(payload, 'routing').lines[0]).toContain(
      'with a fresh token and project from the vault for each send',
    )
    const text = JSON.stringify(payload)
    expect(text).not.toContain(TOKEN)
    expect(text).not.toContain('cred-a')
    expect(text).not.toContain('a@example.com')
    expect(text).not.toContain('account-a')
  })

  /** Approve with an empty roster and check every place the menu explains it. */
  async function expectEmptyRosterGuidance(grant: string[]) {
    emptyRoster = true
    const { menu } = await openPiMenu()
    const requested = await apply(menu, 'vault', 'request-access')
    expect(requested).toMatchObject({
      ok: true,
      text: ['Vault access: approved by the vault operator.', ...grant].join(
        '\n',
      ),
    })

    const payload = await menu.open(invocation)
    expect(section(payload, 'accounts').lines).toEqual([
      'Pi uses the vault for Antigravity, one account at a time. Choose an account, or turn accounts off and on, in the Vault section.',
      ...grant,
    ])
    expect(section(payload, 'routing').lines).toEqual([
      'The vault gives Pi no accounts, so requests are refused. There is no account rotation.',
      ...grant,
    ])
    expect(section(payload, 'vault').lines.slice(-grant.length)).toEqual(grant)
  }

  const GRANT_COMMAND =
    'ck auth grant --principal enrolled:antigravity-auth-pi --selector-kind category --selector antigravity-native --operation read'

  it('names the missing read grant when the approved vault serves Pi no accounts', async () => {
    // A vault that does not report grants leaves the cause unknown.
    await expectEmptyRosterGuidance([
      "The vault operator approved Pi, but Pi can't see any Antigravity accounts in the vault yet.",
      `If the operator has not granted Pi read access yet, they run: ${GRANT_COMMAND}`,
    ])
  })

  it('says no grant exists and gives the grant command when the vault reports zero grants', async () => {
    rosterGrants = { grants: 0, grantTuples: [] }
    await expectEmptyRosterGuidance([
      'The vault operator approved Pi. The vault has not granted Pi read access.',
      `The vault operator grants it with: ${GRANT_COMMAND}`,
    ])
  })

  it('says the grant reaches no login and gives the reclassify and status commands when a grant exists', async () => {
    rosterGrants = {
      grants: 1,
      grantTuples: [
        {
          selectorKind: 'category',
          selector: 'antigravity-native',
          operation: 'read',
        },
      ],
    }
    await expectEmptyRosterGuidance([
      'The vault operator approved Pi. Pi has read access, but it reaches no Antigravity login in the vault.',
      "The vault operator updates the vault's logins with: ck auth reclassify --from-registry",
      'Then they check them with: ck auth status',
    ])
  })

  it('selects vault custody while leaving Pi’s native login unchanged', async () => {
    hostSlot = {
      type: 'oauth',
      access: 'real-access',
      refresh: 'real-refresh',
      expires: 1,
    }
    const before = JSON.stringify(hostSlot)
    const { menu, providers } = await openPiMenu()
    expect(await apply(menu, 'vault', 'request-access')).toMatchObject({
      ok: true,
    })
    expect(await apply(menu, 'vault', 'use-vault')).toMatchObject({ ok: false })
    expect(providers.at(-1)?.oauth).toBeUndefined()
    expect(JSON.stringify(hostSlot)).toBe(before)
    // The placeholder login is genuinely recognised as not a login.
    const claustrum = await loadCommonAuthClaustrum()
    expect(
      claustrum.classifyHostSlot(
        claustrum.custodyPlaceholder('google'),
        'google',
      ),
    ).toBe('placeholder')
  })
})
