import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  type CommonAuthClaustrumModule,
  loadCommonAuthClaustrum,
} from '@cortexkit/antigravity-auth-core'
import type {
  ClaustrumEnrollmentConnection,
  EnrollmentTokenFile,
} from '@cortexkit/antigravity-auth-core/common-auth/claustrum'
import type {
  ActionDefinition,
  CommandInvocation,
  PluginExtraSection,
  SectionContent,
} from '@cortexkit/antigravity-auth-core/common-auth/commands'

import {
  createPiVaultSection,
  formatPiVaultSetupStatus,
  PI_ANTIGRAVITY_ENROLLMENT_NAME,
  PI_ANTIGRAVITY_PROVIDER_ID,
  type PiVaultAccountChoice,
  type PiVaultAccountsPort,
  type PiVaultModeRecord,
  PiVaultSetup,
  PiVaultSetupError,
  readPiVaultMode,
  writePiVaultMode,
} from './vault-setup.ts'

// A 64-hex enrollment token, the only shape the vault library accepts.
const ENROLLMENT_SECRET = 'b'.repeat(64)
const LOGIN = {
  type: 'oauth',
  access: 'real-access',
  refresh: 'real-refresh',
  expires: 1,
}

type PollStep = 'pending' | 'approved' | 'denied'

/** The vault's enrollment endpoint, answering polls from a script. */
function enrollmentEndpoint(script: PollStep[]) {
  const calls = { proposals: 0, polls: 0, opened: 0, closed: 0 }
  const connect = async (): Promise<ClaustrumEnrollmentConnection> => {
    calls.opened++
    return {
      enrollPropose: async () => {
        calls.proposals++
        return { requestId: `request-${calls.proposals}` }
      },
      enrollPoll: async () => {
        const step = script[Math.min(calls.polls, script.length - 1)]
        calls.polls++
        if (step === 'approved')
          return {
            status: 'approved',
            name: PI_ANTIGRAVITY_ENROLLMENT_NAME,
            token: ENROLLMENT_SECRET,
            tokenGeneration: 1,
          }
        return { status: step ?? 'pending' }
      },
      close: () => {
        calls.closed++
      },
    }
  }
  return { connect, calls }
}

let claustrum: CommonAuthClaustrumModule
let dir: string
let modeFile: string
let hostSlot: unknown
let modeChanges: PiVaultModeRecord[]

function makeSetup(endpoint = enrollmentEndpoint(['pending'])) {
  return new PiVaultSetup({
    claustrum,
    stateDir: join(dir, 'vault'),
    modeFile,
    readHostSlot: () => hostSlot,
    connectEnrollment: endpoint.connect,
    onModeChanged: (record) => {
      modeChanges.push(record)
    },
  })
}

/** Setup whose enrollment the operator has approved. */
async function approvedSetup() {
  const setup = makeSetup(enrollmentEndpoint(['approved']))
  expect((await setup.connectStep()).state).toBe('approved')
  return setup
}

beforeEach(async () => {
  claustrum = await loadCommonAuthClaustrum()
  dir = await mkdtemp(
    join(process.platform === 'win32' ? tmpdir() : '/tmp', 'pi-vault-setup-'),
  )
  modeFile = join(dir, 'pi-mode.json')
  hostSlot = undefined
  modeChanges = []
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('Pi vault mode file', () => {
  it('reads a missing file as local mode', () => {
    expect(readPiVaultMode(modeFile)).toEqual({
      ok: true,
      record: { version: 1, mode: 'local' },
    })
  })

  it('round-trips custody mode with a selected route', async () => {
    await writePiVaultMode(modeFile, {
      version: 1,
      mode: 'custody',
      routeId: 'vault:route-1',
    })
    expect(readPiVaultMode(modeFile)).toEqual({
      ok: true,
      record: { version: 1, mode: 'custody', routeId: 'vault:route-1' },
    })
  })

  it('reports malformed or unknown files instead of guessing a mode', async () => {
    await writeFile(modeFile, '{not json')
    expect(readPiVaultMode(modeFile).ok).toBe(false)
    await writeFile(modeFile, JSON.stringify({ version: 2, mode: 'custody' }))
    expect(readPiVaultMode(modeFile).ok).toBe(false)
    await writeFile(
      modeFile,
      JSON.stringify({ version: 1, mode: 'custody', accessToken: 'x' }),
    )
    expect(readPiVaultMode(modeFile).ok).toBe(false)
    await writeFile(modeFile, JSON.stringify({ version: 1, mode: 'vault' }))
    expect(readPiVaultMode(modeFile).ok).toBe(false)
  })
})

describe('Pi vault setup', () => {
  it('enrolls under the antigravity-auth-pi host name with the library host paths', () => {
    const setup = makeSetup()
    expect(PI_ANTIGRAVITY_ENROLLMENT_NAME).toBe('antigravity-auth-pi')
    expect(setup.paths).toEqual(
      claustrum.hostEnrollmentPaths({
        stateDir: join(dir, 'vault'),
        host: 'pi',
      }),
    )
  })

  it('reports non-secret status without showing the token', async () => {
    const setup = await approvedSetup()
    hostSlot = claustrum.custodyPlaceholder(PI_ANTIGRAVITY_PROVIDER_ID)
    const token: EnrollmentTokenFile =
      await claustrum.readClaustrumEnrollmentToken(setup.paths.tokenPath)
    expect(token.token).toBe(ENROLLMENT_SECRET)

    const status = await setup.status()
    expect(status.mode).toBe('custody')
    expect(status.enrollment.state).toBe('approved')
    expect(status.hostSlot).toBe('dormant')
    const text = `${JSON.stringify(status)}\n${formatPiVaultSetupStatus(status).join('\n')}`
    expect(text).not.toContain(ENROLLMENT_SECRET)
    expect(formatPiVaultSetupStatus(status)).toContain(
      'Pi auth slot: dormant (not read)',
    )
  })

  it('runs the enrollment ceremony only from an explicit step and closes each connection', async () => {
    const endpoint = enrollmentEndpoint(['pending', 'approved'])
    const setup = makeSetup(endpoint)
    await setup.status()
    expect(endpoint.calls.opened).toBe(0)

    expect((await setup.connectStep()).state).toBe('pending')
    expect((await setup.connectStep()).state).toBe('approved')
    expect(endpoint.calls.proposals).toBe(1)
    expect(endpoint.calls.opened).toBe(2)
    expect(endpoint.calls.closed).toBe(2)
  })

  it('clears a denied request before proposing again', async () => {
    const denied = makeSetup(enrollmentEndpoint(['denied']))
    await denied.connectStep()
    expect((await denied.status()).enrollment.state).toBe('denied')

    const retry = enrollmentEndpoint(['pending'])
    expect((await makeSetup(retry).connectStep()).state).toBe('pending')
    expect(retry.calls.proposals).toBe(1)
  })

  it('refuses custody before approval and leaves an existing Pi login dormant after approval', async () => {
    await expect(makeSetup().useVault()).rejects.toBeInstanceOf(
      PiVaultSetupError,
    )

    const setup = await approvedSetup()
    hostSlot = LOGIN
    await expect(setup.useVault()).resolves.toEqual({
      version: 1,
      mode: 'custody',
    })
    expect(readPiVaultMode(modeFile)).toEqual({
      ok: true,
      record: { version: 1, mode: 'custody' },
    })
    expect(modeChanges).toEqual([
      { version: 1, mode: 'custody' },
      { version: 1, mode: 'custody' },
    ])
    expect(hostSlot).toBe(LOGIN)
  })

  it('switches to custody with an empty or placeholder slot and back to local', async () => {
    const setup = await approvedSetup()
    await setup.useVault('vault:route-1')
    expect(readPiVaultMode(modeFile)).toEqual({
      ok: true,
      record: { version: 1, mode: 'custody', routeId: 'vault:route-1' },
    })
    hostSlot = claustrum.custodyPlaceholder(PI_ANTIGRAVITY_PROVIDER_ID)
    await setup.useVault()
    const before = await readFile(modeFile, 'utf8')
    await expect(setup.useLocal()).rejects.toThrow(
      'Disconnect vault enrollment',
    )
    expect(await readFile(modeFile, 'utf8')).toBe(before)
    await setup.disconnect()
    await setup.useLocal()
    expect(modeChanges.map((record) => record.mode)).toEqual([
      'custody',
      'custody',
      'custody',
      'local',
      'local',
    ])
  })

  it('forgets the enrollment token and state and returns to local mode', async () => {
    const setup = await approvedSetup()
    await setup.useVault()
    await setup.disconnect()
    expect(existsSync(setup.paths.tokenPath)).toBe(false)
    expect(existsSync(setup.paths.statePath)).toBe(false)
    expect(JSON.parse(await readFile(modeFile, 'utf8'))).toEqual({
      version: 1,
      mode: 'local',
    })
  })
})

function accountsPort(accounts: PiVaultAccountChoice[]) {
  const calls: string[] = []
  const port: PiVaultAccountsPort = {
    list: async () => accounts,
    decline: async (routeId) => {
      calls.push(`decline:${routeId}`)
    },
    accept: async (routeId) => {
      calls.push(`accept:${routeId}`)
    },
  }
  return { port, calls }
}

const ACCOUNTS: PiVaultAccountChoice[] = [
  { routeId: 'vault:a', label: 'Account A', declined: false },
  {
    routeId: 'vault:b',
    label: 'Account B',
    email: 'b@example.com',
    declined: true,
  },
]

function invocation() {
  const notices: { message: string; kind?: string }[] = []
  const value: CommandInvocation = {
    sessionId: 'session-1',
    notify: (message, kind) => {
      notices.push({ message, ...(kind && { kind }) })
    },
  }
  return { value, notices }
}

async function build(section: PluginExtraSection) {
  return section.build(invocation().value)
}

function action(
  content: SectionContent,
  id: string,
  itemLabel?: string,
): ActionDefinition {
  const list = itemLabel
    ? content.items?.find((item) => item.label === itemLabel)?.actions
    : content.actions
  const found = list?.find((entry) => entry.id === id)
  if (!found) throw new Error(`no action ${id}`)
  return found
}

describe('Pi vault menu section', () => {
  it('offers only request access before enrollment and reports the approval later', async () => {
    const endpoint = enrollmentEndpoint(['pending', 'approved'])
    const setup = makeSetup(endpoint)
    const section = createPiVaultSection({
      setup: async () => setup,
      wait: { pollIntervalMs: 0, sleep: async () => {} },
    })
    const content = await build(section)
    expect(section.id).toBe('vault')
    expect(content.actions?.map((entry) => entry.id)).toEqual([
      'request-access',
    ])
    expect(endpoint.calls.opened).toBe(0)

    const call = invocation()
    expect(
      await action(content, 'request-access').run({
        values: {},
        invocation: call.value,
      }),
    ).toMatchObject({ ok: true })
    for (let i = 0; i < 20 && call.notices.length === 0; i++) await Bun.sleep(1)
    expect(call.notices.at(-1)).toEqual({
      message: 'Enrollment: approved as antigravity-auth-pi',
      kind: 'info',
    })
    expect(endpoint.calls.closed).toBe(endpoint.calls.opened)
  })

  it('lists vault accounts and declines or accepts them through the vault port', async () => {
    const setup = await approvedSetup()
    const { port, calls } = accountsPort(ACCOUNTS)
    const content = await build(
      createPiVaultSection({ setup: async () => setup, accounts: () => port }),
    )
    expect(content.items?.map((item) => [item.label, item.detail])).toEqual([
      ['Vault account 1', 'available'],
      ['Vault account 2', 'declined on this host'],
    ])
    await action(content, 'decline', 'Vault account 1').run({
      values: {},
      invocation: invocation().value,
    })
    await action(content, 'accept', 'Vault account 2').run({
      values: {},
      invocation: invocation().value,
    })
    expect(calls).toEqual(['decline:vault:a', 'accept:vault:b'])
  })

  it('serves Pi from a chosen account and records only its route id', async () => {
    const setup = await approvedSetup()
    const { port } = accountsPort(ACCOUNTS)
    const content = await build(
      createPiVaultSection({ setup: async () => setup, accounts: () => port }),
    )
    await action(content, 'use', 'Vault account 1').run({
      values: {},
      invocation: invocation().value,
    })
    expect(JSON.parse(await readFile(modeFile, 'utf8'))).toEqual({
      version: 1,
      mode: 'custody',
      routeId: 'vault:a',
    })
  })

  it('selects the vault without removing the dormant Pi login', async () => {
    const setup = await approvedSetup()
    hostSlot = LOGIN
    const content = await build(
      createPiVaultSection({ setup: async () => setup }),
    )
    expect(
      content.actions?.some((candidate) => candidate.id === 'use-vault'),
    ).toBe(false)
    expect(readPiVaultMode(modeFile)).toEqual({
      ok: true,
      record: { version: 1, mode: 'custody' },
    })
    expect(hostSlot).toBe(LOGIN)
  })

  it('confirms forgetting the enrollment as an irreversible action', async () => {
    const setup = await approvedSetup()
    const content = await build(
      createPiVaultSection({ setup: async () => setup }),
    )
    const forget = action(content, 'forget')
    expect(forget.irreversible).toBe(true)
    expect(forget.confirm).toContain('antigravity-auth-pi')
    await forget.run({ values: {}, invocation: invocation().value })
    expect(existsSync(setup.paths.tokenPath)).toBe(false)
  })

  it('keeps the token, raw route ids and emails out of the menu with stable opaque item ids', async () => {
    const setup = await approvedSetup()
    await setup.useVault('vault:a')
    const section = createPiVaultSection({
      setup: async () => setup,
      accounts: () => accountsPort(ACCOUNTS).port,
    })
    const first = await build(section)
    const second = await build(section)
    const text = JSON.stringify(first)
    expect(text).not.toContain(ENROLLMENT_SECRET)
    expect(text).not.toContain('vault:a')
    expect(text).not.toContain('vault:b')
    expect(text).not.toContain('b@example.com')
    expect(text).not.toContain('Account A')
    expect(first.items?.map((item) => item.id)).toEqual(
      second.items?.map((item) => item.id),
    )
    expect(new Set(first.items?.map((item) => item.id)).size).toBe(2)
    expect(first.items?.[0]?.detail).toBe('serving Pi')
  })
})

it('waits for the native credential-slot transition before enrollment activation returns', async () => {
  const endpoint = enrollmentEndpoint(['approved'])
  let entered!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  let release!: () => void
  const barrier = new Promise<void>((resolve) => {
    release = resolve
  })
  let finished = false
  const setup = new PiVaultSetup({
    claustrum,
    stateDir: join(dir, 'vault'),
    modeFile,
    readHostSlot: () => hostSlot,
    connectEnrollment: endpoint.connect,
    onModeChanged: async () => {
      entered()
      await barrier
    },
  })
  const pending = setup.connectStep().then((result) => {
    finished = true
    return result
  })
  try {
    await started
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(finished).toBe(false)
    expect(readPiVaultMode(modeFile)).toEqual({
      ok: true,
      record: { version: 1, mode: 'custody' },
    })
  } finally {
    release()
    await pending
  }
  expect(finished).toBe(true)
})
