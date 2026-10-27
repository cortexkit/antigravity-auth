import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type CommonAuthClaustrumModule,
  loadCommonAuthClaustrum,
  UNSUPPORTED_VAULT_CODE,
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
  type PiVaultSetupStatus,
  readPiVaultMode,
  writePiVaultMode,
} from './vault-setup.ts'
import {
  createPiVaultAccountsPort,
  createPiVaultRuntime,
  createPiVaultSend,
  PiVaultSendError,
} from './vault-source.ts'

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

function makeSetup(
  endpoint: Pick<
    ReturnType<typeof enrollmentEndpoint>,
    'connect'
  > = enrollmentEndpoint(['pending']),
) {
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
    expect(formatPiVaultSetupStatus(status)).toContain(CUSTODY)
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
    await expect(setup.useLocal()).rejects.toThrow('Disconnect from the vault')
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
    grantReach: () => undefined,
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

/** Drain setup I/O and its continuations, leaving only explicitly held poll sleeps. */
function watchWork(setup: PiVaultSetup) {
  const pending = new Set<Promise<unknown>>()
  let started = 0
  let connectEntries = 0
  async function track<T>(operation: () => Promise<T>): Promise<T> {
    started++
    const work = operation()
    pending.add(work)
    try {
      return await work
    } finally {
      pending.delete(work)
    }
  }
  const connect = setup.connectStep.bind(setup)
  const status = setup.sourceStatus.bind(setup)
  setup.connectStep = () => {
    connectEntries++
    return track(connect)
  }
  setup.sourceStatus = () => track(status)
  const drain = async () => {
    let before: number
    do {
      before = started
      await Promise.all([...pending])
      await new Promise<void>((resolve) => setImmediate(resolve))
    } while (pending.size > 0 || started !== before)
  }
  return Object.assign(drain, { entries: () => connectEntries })
}

function invocation() {
  const delivered = Promise.withResolvers<void>()
  const notices: { message: string; kind?: string }[] = []
  const value: CommandInvocation = {
    sessionId: 'session-1',
    notify: (message, kind) => {
      notices.push({ message, ...(kind && { kind }) })
      delivered.resolve()
    },
  }
  return { value, notices, delivered: delivered.promise }
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
    const drain = watchWork(setup)
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
    await call.delivered
    await drain()
    expect(call.notices.at(-1)).toEqual({
      message: APPROVED,
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
      ['Vault account 2', 'turned off for Pi on this computer'],
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
    expect(forget.confirm).toBe(
      'Disconnect this computer from the vault? Pi goes back to its own login, and using the vault here again needs a new approval from the vault operator.',
    )
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
    expect(first.items?.[0]?.detail).toBe('in use by Pi')
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

// ---------------------------------------------------------------------------
// Enrollment guidance: what the user and the vault operator do next
// ---------------------------------------------------------------------------

const GRANT =
  'ck auth grant --principal enrolled:antigravity-auth-pi --selector-kind category --selector antigravity-native --operation read'

// The Vault section's status lines, as a newcomer reads them.
const LOCAL =
  "Using Pi's own login, not the vault, but you are not signed in. Run /login to sign in."
const CUSTODY =
  "Using the vault for Antigravity accounts; Pi's own login is set aside."
const WAITING =
  'Vault access: waiting for the vault operator to approve this request.'
const APPROVED = 'Vault access: approved by the vault operator.'
const PENDING_EXISTS_STATE =
  'Vault access: the vault turned down a new request because an earlier request from Pi is still waiting.'

function pendingSteps(approve: string): string[] {
  return [
    'Next, the vault operator runs these outside Pi:',
    approve,
    `2. Grant read access to the name approved in step 1, for example: ${GRANT}`,
    'Both are needed: without the grant, Pi can see no accounts in the vault.',
    '3. Pi switches to the vault once it sees the approval. Choose Request vault access to check again.',
  ]
}

const APPROVE_REQUEST_1 =
  '1. Approve the request: ck auth enroll approve --request-id request-1'

const PENDING_EXISTS = [
  'The earlier request may come from a vault setup that was disconnected here before the operator answered it.',
  'It expires 15 minutes after it was made; request vault access again after that.',
  'Or the vault operator clears it now: find the request from antigravity-auth-pi with ck auth enroll list, run ck auth enroll deny --request-id <id>, then request vault access again here.',
]

const NO_ACCOUNTS = [
  "The vault operator approved Pi, but Pi can't see any Antigravity accounts in the vault yet.",
  `If the operator has not granted Pi read access yet, they run: ${GRANT}`,
]

/**
 * The vault's enrollment endpoint with answers the test changes as it goes:
 * `refuse` makes the next proposals fail with a vault refusal code, and
 * `approvedName` is the name the operator approves the request under.
 */
function vaultEndpoint() {
  const calls = { proposals: 0 }
  const answers: {
    refuse?: { code: string; retry: boolean }
    poll: PollStep
    approvedName?: string
  } = { poll: 'pending' }
  const connect = async (): Promise<ClaustrumEnrollmentConnection> => ({
    enrollPropose: async () => {
      calls.proposals++
      const refusal = answers.refuse
      if (refusal)
        throw new claustrum.ClaustrumCredentialError(
          refusal.code,
          refusal.retry ? 'transient' : 'permanent',
          refusal.retry ? 'retry' : 'gone',
        )
      return { requestId: `request-${calls.proposals}` }
    },
    enrollPoll: async () =>
      answers.poll === 'approved'
        ? {
            status: 'approved' as const,
            name: answers.approvedName ?? PI_ANTIGRAVITY_ENROLLMENT_NAME,
            token: ENROLLMENT_SECRET,
            tokenGeneration: 1,
          }
        : { status: answers.poll },
    close: () => {},
  })
  return { connect, calls, answers }
}

/** A sleep the test releases by hand, so the approval watch waits where the test wants it. */
function heldSleep() {
  const waiting: Array<() => void> = []
  return {
    sleep: () =>
      new Promise<void>((resolve) => {
        waiting.push(resolve)
      }),
    waiting: () => waiting.length,
    release: () => {
      for (const resolve of waiting.splice(0)) resolve()
    },
  }
}

/**
 * Bound positive notification observations in tests that do not hold poll sleeps.
 */
async function settle(until: () => boolean, ms: number) {
  const deadline = Date.now() + ms
  while (!until() && Date.now() < deadline) await Bun.sleep(2)
}

/** Generous bound for work the test expects to finish. */
const EXPECTED_MS = 5_000

describe('Pi vault enrollment guidance', () => {
  it('gives the operator steps with the request ID while pending, offers no Forget, and reports the decision once', async () => {
    const endpoint = vaultEndpoint()
    const setup = makeSetup(endpoint)
    const held = heldSleep()
    const drain = watchWork(setup)
    const section = createPiVaultSection({
      setup: async () => setup,
      wait: { pollIntervalMs: 0, sleep: held.sleep },
    })
    const call = invocation()
    expect(
      await action(await build(section), 'request-access').run({
        values: {},
        invocation: call.value,
      }),
    ).toEqual({
      ok: true,
      text: [
        `${WAITING} Pi tells you here when the operator decides.`,
        ...pendingSteps(APPROVE_REQUEST_1),
      ].join('\n'),
    })

    const content = await build(section)
    expect(content.lines).toEqual([
      LOCAL,
      WAITING,
      ...pendingSteps(APPROVE_REQUEST_1),
      "You can't disconnect while this request waits for the vault operator. To withdraw it, ask the vault operator to run ck auth enroll deny --request-id request-1, then choose Request vault access here so Pi sees the answer.",
    ])
    expect(content.actions?.map((entry) => entry.id)).toEqual([
      'request-access',
    ])

    // Asking again while the first request is watched starts no second
    // watch, so the operator's decision is reported once.
    await drain()
    expect(held.waiting()).toBe(1)
    expect(drain.entries()).toBe(2)
    await action(content, 'request-access').run({
      values: {},
      invocation: call.value,
    })
    await drain()
    expect(held.waiting()).toBe(1)
    expect(drain.entries()).toBe(3)
    endpoint.answers.poll = 'approved'
    held.release()
    await call.delivered
    await drain()
    expect(drain.entries()).toBe(4)
    expect(held.waiting()).toBe(0)
    expect(call.notices).toEqual([{ message: APPROVED, kind: 'info' }])
  })

  it('names a Claustrum vault that cannot connect plugins in the request-access result', async () => {
    const setup = makeSetup()
    setup.connectStep = async () => ({
      state: 'unavailable',
      proposedName: PI_ANTIGRAVITY_ENROLLMENT_NAME,
      code: UNSUPPORTED_VAULT_CODE,
    })
    const call = invocation()
    const result = await action(
      await build(createPiVaultSection({ setup: async () => setup })),
      'request-access',
    ).run({ values: {}, invocation: call.value })

    expect(result).toEqual({
      ok: false,
      text: 'Vault access: this Claustrum vault is too old to connect plugins. Run ck upgrade to move to Claustrum v0.2.0 or newer (read "Upgrading from v0.1.3" in its release notes first), or keep using your local accounts.',
    })
    expect(call.notices).toEqual([])
  })

  it('keeps the reachability text for other unavailable enrollment codes', async () => {
    const setup = makeSetup()
    setup.connectStep = async () => ({
      state: 'unavailable',
      proposedName: PI_ANTIGRAVITY_ENROLLMENT_NAME,
      code: 'connection-lost',
    })
    const result = await action(
      await build(createPiVaultSection({ setup: async () => setup })),
      'request-access',
    ).run({ values: {}, invocation: invocation().value })

    expect(result).toEqual({
      ok: false,
      text: "Vault access: Pi can't reach the vault right now. Try again later (reference: connection-lost).",
    })
  })

  it('says where to find the request ID when Pi does not know it', async () => {
    const endpoint = vaultEndpoint()
    endpoint.answers.refuse = { code: 'pending_queue_full', retry: true }
    const setup = makeSetup(endpoint)
    expect(await setup.connectStep()).toMatchObject({
      state: 'pending',
      retryCode: 'pending_queue_full',
    })
    const content = await build(
      createPiVaultSection({ setup: async () => setup }),
    )
    expect(content.lines?.slice(2)).toEqual([
      ...pendingSteps(
        '1. Find the request from antigravity-auth-pi with ck auth enroll list, then approve it: ck auth enroll approve --request-id <id>',
      ),
      "You can't disconnect while this request waits for the vault operator. To withdraw it, ask the vault operator to run ck auth enroll deny --request-id <id>, then choose Request vault access here so Pi sees the answer.",
    ])
  })

  it('names the missing read grant when approval serves an empty roster', async () => {
    const endpoint = vaultEndpoint()
    const setup = makeSetup(endpoint)
    const call = invocation()
    const section = createPiVaultSection({
      setup: async () => setup,
      accounts: () => accountsPort([]).port,
      wait: { pollIntervalMs: 0, sleep: async () => {} },
    })
    await action(await build(section), 'request-access').run({
      values: {},
      invocation: call.value,
    })
    endpoint.answers.poll = 'approved'
    await settle(() => call.notices.length > 0, EXPECTED_MS)
    expect(call.notices).toEqual([
      {
        message: [APPROVED, ...NO_ACCOUNTS].join('\n'),
        kind: 'info',
      },
    ])

    expect((await build(section)).lines).toEqual([
      CUSTODY,
      APPROVED,
      ...NO_ACCOUNTS,
    ])
  })

  it('names the enrollment the operator approved under another name in the menu, request access and a send', async () => {
    const OTHER_GRANT =
      'ck auth grant --principal enrolled:antigravity-auth-pi-2 --selector-kind category --selector antigravity-native --operation read'
    const NO_GRANT = [
      'The vault operator approved Pi. The vault has not granted Pi read access.',
      `The vault operator grants it with: ${OTHER_GRANT}`,
    ]
    const endpoint = vaultEndpoint()
    endpoint.answers.poll = 'approved'
    endpoint.answers.approvedName = 'antigravity-auth-pi-2'
    // Pi's real vault composition over a vault that lists no account for Pi
    // and reports zero grants.
    const runtime = () =>
      createPiVaultRuntime(() => hostSlot, {
        vaultDir: join(dir, 'vault'),
        modeFile,
        rosterFile: join(dir, 'roster.json'),
        connectEnrollment: endpoint.connect,
        connect: async () => ({
          listScoped: async () => ({
            view: 'empty-view',
            rows: [],
            grants: 0,
            grantTuples: [],
          }),
          getScoped: async () => {
            throw new Error('an empty roster admits no send')
          },
          reportAuthFailureScoped: async () => {},
          close() {},
        }),
      })
    const first = runtime()
    const section = createPiVaultSection({
      setup: first.setup,
      accounts: () => createPiVaultAccountsPort(first.requestPath),
    })
    expect(
      await action(await build(section), 'request-access').run({
        values: {},
        invocation: invocation().value,
      }),
    ).toEqual({ ok: true, text: [APPROVED, ...NO_GRANT].join('\n') })
    expect((await build(section)).lines).toEqual([
      CUSTODY,
      APPROVED,
      ...NO_GRANT,
    ])

    // A fresh composition, as after a restart: the send path learns the
    // approved name from the enrollment status it reads before sending.
    let dispatched = 0
    const refusal = await createPiVaultSend(runtime().requestPath)(async () => {
      dispatched++
      return new Response('{}')
    }, new AbortController().signal).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(dispatched).toBe(0)
    expect(refusal).toBeInstanceOf(PiVaultSendError)
    expect((refusal as Error).message).toBe(NO_GRANT.join('\n'))
  })

  it('points an approved host with vault accounts but local mode at Serve Pi from the vault', async () => {
    // Pi's authority reads custody as soon as enrollment is approved, so a
    // local mode beside an approval is forced here through the status the
    // menu builds from.
    class LocalModeSetup extends PiVaultSetup {
      override async status(): Promise<PiVaultSetupStatus> {
        return { ...(await super.status()), mode: 'local', hostSlot: 'empty' }
      }
    }
    const setup = new LocalModeSetup({
      claustrum,
      stateDir: join(dir, 'vault'),
      modeFile,
      readHostSlot: () => hostSlot,
      connectEnrollment: enrollmentEndpoint(['approved']).connect,
    })
    expect((await setup.connectStep()).state).toBe('approved')
    const content = await build(
      createPiVaultSection({
        setup: async () => setup,
        accounts: () => accountsPort(ACCOUNTS).port,
      }),
    )
    expect(content.lines).toEqual([
      LOCAL,
      APPROVED,
      'Next: choose Use the vault to have Pi use these accounts.',
    ])
    expect(content.actions?.map((entry) => entry.id)).toContain('use-vault')
  })

  it('explains a pending_exists refusal once, with the wait and the operator remedy', async () => {
    const endpoint = vaultEndpoint()
    endpoint.answers.refuse = { code: 'pending_exists', retry: false }
    const setup = makeSetup(endpoint)
    const drain = watchWork(setup)
    const section = createPiVaultSection({
      setup: async () => setup,
      wait: { pollIntervalMs: 0, sleep: async () => {} },
    })
    const call = invocation()
    expect(
      await action(await build(section), 'request-access').run({
        values: {},
        invocation: call.value,
      }),
    ).toEqual({
      ok: false,
      text: [PENDING_EXISTS_STATE, ...PENDING_EXISTS].join('\n'),
    })
    await drain()
    expect(call.notices).toEqual([])

    const content = await build(section)
    expect(content.lines).toEqual([
      LOCAL,
      PENDING_EXISTS_STATE,
      ...PENDING_EXISTS,
    ])
    expect(content.actions?.map((entry) => entry.id)).toEqual([
      'request-access',
      'forget',
    ])
  })

  it('stops watching a request forgotten while it waits, and the next request states the remedy once', async () => {
    const endpoint = vaultEndpoint()
    // Counts the local reads that find no request, so the test knows when
    // the approval watch has looked and stopped.
    class WatchedSetup extends PiVaultSetup {
      idleReads = 0
      override async sourceStatus() {
        const status = await super.sourceStatus()
        if (status.enrollment.state === 'idle') this.idleReads++
        return status
      }
    }
    const setup = new WatchedSetup({
      claustrum,
      stateDir: join(dir, 'vault'),
      modeFile,
      readHostSlot: () => hostSlot,
      connectEnrollment: endpoint.connect,
    })
    const held = heldSleep()
    const drain = watchWork(setup)
    const section = createPiVaultSection({
      setup: async () => setup,
      wait: { pollIntervalMs: 0, sleep: held.sleep },
    })
    const call = invocation()
    await action(await build(section), 'request-access').run({
      values: {},
      invocation: call.value,
    })
    await drain()
    expect(held.waiting()).toBe(1)

    // Pi's request secret is deleted while the vault still holds the
    // request, so any new proposal is refused until that request goes.
    await setup.disconnect()
    endpoint.answers.refuse = { code: 'pending_exists', retry: false }
    held.release()
    await drain()
    expect(setup.idleReads).toBeGreaterThan(0)
    expect(held.waiting()).toBe(0)
    expect(endpoint.calls.proposals).toBe(1)
    expect(call.notices).toEqual([])

    const retry = invocation()
    expect(
      await action(await build(section), 'request-access').run({
        values: {},
        invocation: retry.value,
      }),
    ).toEqual({
      ok: false,
      text: [PENDING_EXISTS_STATE, ...PENDING_EXISTS].join('\n'),
    })
    await drain()
    expect([...call.notices, ...retry.notices]).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// A vault key the vault library refuses to save under a shared folder
// ---------------------------------------------------------------------------

describe.skipIf(process.platform === 'win32')(
  'Pi vault key under a shared folder',
  () => {
    /**
     * Pi's vault folder below a folder its group can write. The sticky bit
     * makes the vault client refuse it even on hosts where the user has a
     * private group (which it would otherwise trust); the embedded state
     * checks accept sticky folders, so the request reaches the key write.
     */
    async function sharedFolderSetup(script: PollStep[]) {
      const shared = join(dir, 'shared')
      await mkdir(shared, { mode: 0o700 })
      await chmod(shared, 0o1770)
      const setup = new PiVaultSetup({
        claustrum,
        stateDir: join(shared, 'vault'),
        modeFile,
        readHostSlot: () => hostSlot,
        connectEnrollment: enrollmentEndpoint(script).connect,
      })
      return { setup, shared: await realpath(shared) }
    }

    const sentence = (folder: string) =>
      `The vault key can't be saved because the folder ${folder} can be changed by other users. Make that folder owned by you and not writable by your group or by others, then try again.`

    it('reports the refusal as a failure that names the folder, without the raw error', async () => {
      const { setup, shared } = await sharedFolderSetup(['approved'])
      const section = createPiVaultSection({ setup: async () => setup })
      const result = await action(await build(section), 'request-access').run({
        values: {},
        invocation: invocation().value,
      })
      expect(result).toEqual({
        ok: false,
        code: 'vault-folder-shared',
        text: sentence(shared),
      })
      expect(JSON.stringify(result)).not.toContain('not private')
    })

    it('tells the waiting session the same sentence when the approval arrives later', async () => {
      const { setup, shared } = await sharedFolderSetup(['pending', 'approved'])
      const section = createPiVaultSection({
        setup: async () => setup,
        wait: { pollIntervalMs: 0, sleep: async () => {} },
      })
      const call = invocation()
      expect(
        await action(await build(section), 'request-access').run({
          values: {},
          invocation: call.value,
        }),
      ).toMatchObject({ ok: true })
      await settle(() => call.notices.length > 0, EXPECTED_MS)
      expect(call.notices).toEqual([
        { message: sentence(shared), kind: 'error' },
      ])
    })
  },
)
