/**
 * OpenCode vault custody: paths, the mode file, the enrollment step over the
 * genuine vault library with an owned fake vault service, the custody
 * switch with dormant local logins, and the Vault menu section. Every path
 * is under a temporary directory; nothing connects to a real vault.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadCommonAuthClaustrum } from '@cortexkit/antigravity-auth-core'
import { ClaustrumClient } from '@cortexkit/claustrum-client'

import { createVaultAccountPool } from './shared/vault-request-credentials.ts'
import {
  createOpenCodeVaultCustody,
  OPENCODE_VAULT_ENROLLMENT_NAME,
  OPENCODE_VAULT_HOST,
  type OpenCodeVaultCustodyOptions,
  openCodeVaultPaths,
  readOpenCodeVaultMode,
} from './vault-custody'

/** A well-formed enrollment token, as the vault issues them. */
const ENROLLMENT_TOKEN = 'ab'.repeat(32)
const OBSERVATION_NOW = Date.UTC(2026, 0, 10, 12, 0, 0)

let root: string
let accountFile: string
const custodies: ReturnType<typeof createOpenCodeVaultCustody>[] = []

beforeEach(() => {
  // Build/test runners can put TMPDIR below a shared dependency directory.
  // Use the sticky system temporary directory for enrollment's ancestor checks.
  const temporary = process.platform === 'win32' ? tmpdir() : '/tmp'
  root = realpathSync(mkdtempSync(join(temporary, 'opencode-vault-')))
  // The vault library refuses enrollment under a directory others can write.
  mkdirSync(join(root, 'config'), { mode: 0o700 })
  accountFile = join(root, 'config', 'antigravity-accounts.json')
})

afterEach(async () => {
  await Promise.all(custodies.splice(0).map((custody) => custody.dispose()))
  rmSync(root, { recursive: true, force: true })
})

/** An owned stand-in for the vault's enrollment service. */
function fakeEnrollmentService() {
  const proposals: { name: string }[] = []
  let approve = false
  let denied = false
  let blocked = false
  return {
    proposals,
    approveNext() {
      approve = true
    },
    denyNext() {
      denied = true
    },
    blockNext() {
      blocked = true
    },
    connect: async () => ({
      async enrollPropose(input: { name: string; requestSecretHash: string }) {
        proposals.push({ name: input.name })
        return { requestId: 'request-1' }
      },
      async enrollPoll() {
        if (denied) return { status: 'denied' as const }
        if (blocked) {
          const claustrum = await loadCommonAuthClaustrum()
          throw new claustrum.ClaustrumCredentialError(
            'invalid_request',
            'permanent',
            'gone',
          )
        }
        return approve
          ? {
              status: 'approved' as const,
              name: OPENCODE_VAULT_ENROLLMENT_NAME,
              token: ENROLLMENT_TOKEN,
              tokenGeneration: 1,
            }
          : { status: 'pending' as const }
      },
      close() {},
    }),
  }
}

function custodyWith(
  hostSlot: () => Promise<unknown>,
  service = fakeEnrollmentService(),
  extra: Partial<OpenCodeVaultCustodyOptions> = {},
) {
  const custody = createOpenCodeVaultCustody({
    accountFile,
    readHostSlot: hostSlot,
    reporterSource: 'direct',
    connectionFile: () => join(root, 'vault-connection.json'),
    connectEnrollment: service.connect,
    connect: async () => {
      throw new Error('the request-path vault client is not part of this test')
    },
    ...extra,
  })
  custodies.push(custody)
  return { service, custody }
}

describe('openCodeVaultPaths and the mode file', () => {
  it('keeps the vault files in their own directory beside the account file', () => {
    expect(openCodeVaultPaths(accountFile)).toEqual({
      dir: join(root, 'config', 'antigravity-auth-vault'),
      modeFile: join(
        root,
        'config',
        'antigravity-auth-vault',
        'opencode-mode.json',
      ),
      rosterFile: join(
        root,
        'config',
        'antigravity-auth-vault',
        'opencode-roster.json',
      ),
      stateFile: join(
        root,
        'config',
        'antigravity-auth-vault',
        'opencode-state.json',
      ),
    })
  })

  it('reads a missing mode file as local and refuses one it cannot understand', async () => {
    const { modeFile, dir } = openCodeVaultPaths(accountFile)
    expect(await readOpenCodeVaultMode(modeFile)).toEqual({
      ok: true,
      record: { version: 1, mode: 'local' },
    })
    mkdirSync(dir, { mode: 0o700 })
    writeFileSync(modeFile, '{"version":1,"mode":"custody","token":"x"}')
    expect(await readOpenCodeVaultMode(modeFile)).toEqual({
      ok: false,
      reason: 'the vault mode file has an unknown shape',
    })
  })
})

describe('createOpenCodeVaultCustody', () => {
  it('leaves missing enrollment directory creation to the vault library', async () => {
    const service = fakeEnrollmentService()
    const { dir } = openCodeVaultPaths(accountFile)
    let firstConnection = true
    const { custody } = custodyWith(async () => undefined, service, {
      connectEnrollment: async () => {
        if (firstConnection) {
          firstConnection = false
          expect(existsSync(dir)).toBe(false)
        }
        return service.connect()
      },
    })
    expect((await custody.requestAccess()).state).toBe('pending')
    expect(existsSync(dir)).toBe(true)
    service.approveNext()
    expect((await custody.requestAccess()).state).toBe('approved')
  })

  it('enrolls through the vault library and switches to custody only once approved', async () => {
    const { custody, service } = custodyWith(async () => undefined)
    await expect(custody.useVault()).rejects.toThrow('not enrolled')

    const pending = await custody.requestAccess()
    expect(pending.state).toBe('pending')
    expect(service.proposals).toEqual([{ name: 'antigravity-auth-opencode' }])
    service.approveNext()
    const approved = await custody.requestAccess()
    expect(approved.state).toBe('approved')

    await custody.useVault()
    const { dir, modeFile } = openCodeVaultPaths(accountFile)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    // The mode file holds the mode only.
    expect(JSON.parse(readFileSync(modeFile, 'utf8'))).toEqual({
      version: 1,
      mode: 'custody',
    })
    const status = await custody.status()
    expect(status.mode).toBe('custody')
    expect(JSON.stringify(status)).not.toContain(ENROLLMENT_TOKEN)

    await custody.useLocal()
    expect((await custody.status()).mode).toBe('local')
  })

  it('refuses disconnect while another enrollment operation holds the ceremony lock, preserving files and mode', async () => {
    const service = fakeEnrollmentService()
    let hold = false
    let release!: () => void
    let entered!: () => void
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    const polling = new Promise<void>((resolve) => {
      entered = resolve
    })
    const { custody } = custodyWith(async () => undefined, service, {
      connectEnrollment: async () => {
        const client = await service.connect()
        return {
          ...client,
          enrollPoll: async () => {
            if (hold) {
              entered()
              await barrier
            }
            return client.enrollPoll()
          },
        }
      },
    })
    await custody.requestAccess()
    const paths = openCodeVaultPaths(accountFile)
    writeFileSync(
      paths.modeFile,
      JSON.stringify({ version: 1, mode: 'custody' }),
      { mode: 0o600 },
    )
    const enrollment = (await loadCommonAuthClaustrum()).hostEnrollmentPaths({
      stateDir: paths.dir,
      host: OPENCODE_VAULT_HOST,
    })
    const state = readFileSync(enrollment.statePath)
    const mode = readFileSync(paths.modeFile)
    hold = true
    const pending = custody.requestAccess().then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    )
    try {
      await polling
      await expect(custody.useLocal()).rejects.toThrow(
        'Vault enrollment is busy',
      )
      expect(readFileSync(enrollment.statePath)).toEqual(state)
      expect(readFileSync(paths.modeFile)).toEqual(mode)
    } finally {
      release()
      await pending
      await custody.dispose()
    }
  })

  it('refuses disconnect of another consumer without deleting its token or state', async () => {
    const service = fakeEnrollmentService()
    service.approveNext()
    const { custody } = custodyWith(async () => undefined, service)
    try {
      await custody.requestAccess()
      await custody.useVault()
      const paths = openCodeVaultPaths(accountFile)
      const enrollment = (await loadCommonAuthClaustrum()).hostEnrollmentPaths({
        stateDir: paths.dir,
        host: OPENCODE_VAULT_HOST,
      })
      const foreign = {
        ...JSON.parse(readFileSync(enrollment.statePath, 'utf8')),
        proposedName: 'synthetic-foreign-consumer',
      }
      writeFileSync(enrollment.statePath, JSON.stringify(foreign))
      const state = readFileSync(enrollment.statePath)
      const token = readFileSync(enrollment.tokenPath)
      const mode = readFileSync(paths.modeFile)
      await expect(custody.useLocal()).rejects.toThrow('different consumer')
      expect(readFileSync(enrollment.statePath)).toEqual(state)
      expect(readFileSync(enrollment.tokenPath)).toEqual(token)
      expect(readFileSync(paths.modeFile)).toEqual(mode)
    } finally {
      await custody.dispose()
    }
  })

  it('approved enrollment ignores a retained native login and overrides a stale local preference', async () => {
    const service = fakeEnrollmentService()
    service.approveNext()
    const nativeFile = join(root, 'native-google-auth.json')
    const nativeBytes = JSON.stringify({
      type: 'oauth',
      refresh: 'synthetic-native-refresh',
      access: 'synthetic-native-access',
      expires: 1,
    })
    writeFileSync(nativeFile, nativeBytes)
    let slotReads = 0
    const signedIn = custodyWith(async () => {
      slotReads += 1
      return JSON.parse(readFileSync(nativeFile, 'utf8'))
    }, service)
    await signedIn.custody.requestAccess()
    await signedIn.custody.useVault()
    writeFileSync(
      openCodeVaultPaths(accountFile).modeFile,
      '{"version":1,"mode":"local"}',
    )
    expect((await signedIn.custody.status()).mode).toBe('custody')
    expect((await signedIn.custody.status()).hostSlot).toBe('not-used')
    expect(slotReads).toBe(0)
    expect(readFileSync(nativeFile, 'utf8')).toBe(nativeBytes)

    const unreadableNativeLogin = custodyWith(async () => {
      throw new Error('native login must not be read')
    }, service)
    await unreadableNativeLogin.custody.useVault()
    expect((await unreadableNativeLogin.custody.status()).mode).toBe('custody')
    expect((await unreadableNativeLogin.custody.status()).hostSlot).toBe(
      'not-used',
    )
  })

  it('opens no vault source unless the mode is custody', async () => {
    let connected = 0
    const { custody } = custodyWith(async () => undefined, undefined, {
      connect: async () => {
        connected += 1
        throw new Error('not reached')
      },
    })
    await expect(custody.custodySource()).rejects.toThrow(
      'not served from the vault',
    )
    expect(connected).toBe(0)
  })

  it('constructs the approved vault source without resolving the native login', async () => {
    let connected = 0
    let slotReads = 0
    const service = fakeEnrollmentService()
    service.approveNext()
    const { custody } = custodyWith(
      async () => {
        slotReads += 1
        throw new Error('native login must stay dormant')
      },
      service,
      {
        connect: async () => {
          connected += 1
          throw new Error('not reached')
        },
      },
    )
    await custody.requestAccess()
    const source = await custody.custodySource()
    await expect(source.refresh()).rejects.toThrow('not reached')
    expect(source.routes()).toEqual([])
    expect(slotReads).toBe(0)
    expect(connected).toBe(1)
    await custody.dispose()
  })

  it('shows non-secret status and setup actions in the Vault section', async () => {
    const { custody } = custodyWith(async () =>
      (await loadCommonAuthClaustrum()).custodyPlaceholder('google'),
    )
    const content = await custody
      .menuSection()
      .build({ notify: () => undefined })
    expect(content.lines).toEqual([
      'Mode: this computer',
      'Vault access: not requested',
      'OpenCode Google sign-in: holds the vault placeholder',
    ])
    expect(content.actions?.map((action) => action.id)).toEqual([
      'request-access',
      'use-vault',
    ])
  })
})

it('observes source transitions with the existing consumer while local credentials stay dormant', async () => {
  const authorities: string[] = []
  let resolveLocal: () => void = () => {}
  const firstLocal = new Promise<void>((resolve) => {
    resolveLocal = resolve
  })
  let connects = 0
  let nativeReads = 0
  const service = fakeEnrollmentService()
  const { custody } = custodyWith(
    async () => {
      nativeReads += 1
      throw new Error('observation must not resolve native credentials')
    },
    service,
    {
      onAuthorityChanged: (authority) => {
        authorities.push(authority)
        if (authority === 'local') resolveLocal()
      },
      connect: async () => {
        connects += 1
        throw new Error('synthetic vault unavailable')
      },
    },
  )
  try {
    await custody.startObservation()
    await firstLocal
    expect(connects).toBe(0)
    service.approveNext()
    await custody.requestAccess()
    const source = await custody.custodySource()
    await expect(source.refresh()).rejects.toThrow(
      'synthetic vault unavailable',
    )
    expect(connects).toBe(1)
    await custody.useLocal()
    expect(authorities).toEqual(['local', 'vault', 'local'])
    expect(nativeReads).toBe(0)
  } finally {
    await custody.dispose()
  }
})

describe('Vault section enrollment guidance', () => {
  const GRANT =
    'ck auth grant --principal enrolled:antigravity-auth-opencode --selector-kind category --selector antigravity-native --operation read'
  const pendingSteps = (approve: string) => [
    'Next, the vault operator runs these outside OpenCode:',
    approve,
    `2. Grant read access: ${GRANT}`,
    'Both are needed: an approval without the grant serves this host no accounts.',
    '3. OpenCode checks approval in the background and tells this session when the operator decides; once approved, accounts come from the vault.',
  ]
  const PENDING_EXISTS = [
    'An earlier request for antigravity-auth-opencode is still pending in the vault, possibly from an earlier, abandoned request on this host.',
    'It expires 15 minutes after it was made; request vault access again after that.',
    'Or the vault operator clears it now: find its ID with ck auth enroll list, run ck auth enroll deny --request-id <id>, then request vault access again here.',
  ]
  const NO_ACCOUNTS = [
    'Vault access is approved, but the vault serves antigravity-auth-opencode no Antigravity accounts.',
    `The vault operator grants read access with: ${GRANT}`,
  ]
  const invocation = { notify: () => undefined }

  async function runAction(
    custody: ReturnType<typeof custodyWith>['custody'],
    id: string,
  ) {
    const content = await custody.menuSection().build(invocation)
    const found = content.actions?.find((entry) => entry.id === id)
    if (!found) throw new Error(`no action ${id}`)
    return found.run({ values: {}, invocation })
  }

  it('gives the operator steps with the request ID while pending and offers no disconnect', async () => {
    const { custody } = custodyWith(async () => undefined)
    expect(await runAction(custody, 'request-access')).toEqual({
      ok: true,
      text: [
        'Vault access: waiting for operator approval',
        ...pendingSteps(
          '1. Approve the request: ck auth enroll approve --request-id request-1',
        ),
      ].join('\n'),
    })
    const content = await custody.menuSection().build(invocation)
    expect(content.lines).toEqual([
      'Mode: this computer',
      'Vault access: waiting for operator approval',
      'OpenCode Google sign-in: empty',
      ...pendingSteps(
        '1. Approve the request: ck auth enroll approve --request-id request-1',
      ),
    ])
    // Disconnecting would delete the only secret that can collect this
    // request's approval, while the vault keeps the request pending.
    expect(content.actions?.map((entry) => [entry.id, entry.label])).toEqual([
      ['request-access', 'Check vault approval'],
      ['use-vault', 'Serve accounts from the vault'],
    ])
  })

  it.skipIf(process.platform === 'win32')(
    'names a shared parent folder in one sentence when the vault key cannot be saved there',
    async () => {
      // Group-writable and sticky: the vault client refuses it even on hosts
      // where the user has a private group, while the embedded state checks
      // accept sticky folders, so the request reaches the key write.
      const config = join(root, 'config')
      chmodSync(config, 0o1770)
      const service = fakeEnrollmentService()
      service.approveNext()
      const { custody } = custodyWith(async () => undefined, service)
      const result = await runAction(custody, 'request-access')
      expect(result).toEqual({
        ok: false,
        code: 'vault-folder-shared',
        text: `The vault key can't be saved because the folder ${config} can be changed by other users. Make that folder owned by you and not writable by your group or by others, then try again.`,
      })
      expect(JSON.stringify(result)).not.toContain('not private')
    },
  )

  it('explains a pending_exists refusal once, with the wait and the operator remedy', async () => {
    const claustrum = await loadCommonAuthClaustrum()
    const { custody } = custodyWith(async () => undefined, undefined, {
      connectEnrollment: async () => ({
        enrollPropose: async () => {
          throw new claustrum.ClaustrumCredentialError(
            'pending_exists',
            'permanent',
            'gone',
          )
        },
        enrollPoll: async () => ({ status: 'pending' as const }),
        close() {},
      }),
    })
    expect(await runAction(custody, 'request-access')).toEqual({
      ok: false,
      text: ['Vault access: blocked (pending_exists)', ...PENDING_EXISTS].join(
        '\n',
      ),
    })
    expect((await custody.menuSection().build(invocation)).lines).toEqual([
      'Mode: this computer',
      'Vault access: blocked (pending_exists)',
      'OpenCode Google sign-in: empty',
      ...PENDING_EXISTS,
    ])
  })

  /**
   * Approve this host's enrollment, let the real consumer discover an empty
   * roster whose listing reports `grants` and `grantTuples`, then check the
   * Vault section lines and the request-access action's text.
   */
  async function expectEmptyRosterGuidance(
    grants: number | undefined,
    grantTuples:
      | { selectorKind: string; selector: string; operation: string }[]
      | undefined,
    expected: string[],
  ) {
    const service = fakeEnrollmentService()
    service.approveNext()
    const { custody } = custodyWith(async () => undefined, service, {
      connect: async () => ({
        listScoped: async () => ({
          view: 'view-1',
          rows: [],
          grants,
          grantTuples,
        }),
        getScoped: async () => {
          throw new Error('the menu never fetches a credential')
        },
        reportAuthFailureScoped: async () => {},
        close: () => {},
      }),
    })
    try {
      await custody.requestAccess()
      await (await custody.custodySource()).refresh()
      expect((await custody.menuSection().build(invocation)).lines).toEqual([
        'Mode: vault',
        'Vault access: approved as antigravity-auth-opencode',
        ...expected,
      ])
      expect(await runAction(custody, 'request-access')).toEqual({
        ok: true,
        text: [
          'Vault access: approved as antigravity-auth-opencode',
          ...expected,
        ].join('\n'),
      })
    } finally {
      await custody.dispose()
    }
  }

  it('names the missing read grant when the approved vault serves no accounts', async () => {
    // A vault that does not report grants leaves the cause unknown.
    await expectEmptyRosterGuidance(undefined, undefined, NO_ACCOUNTS)
  })

  it('says no grant exists and gives the grant command when the vault reports zero grants', async () => {
    await expectEmptyRosterGuidance(
      0,
      [],
      [
        'Vault access is approved. The vault has not granted antigravity-auth-opencode read access.',
        `The vault operator grants it with: ${GRANT}`,
      ],
    )
  })

  it('says the grant reaches no login and gives the reclassify and status commands when a grant exists', async () => {
    await expectEmptyRosterGuidance(
      1,
      [
        {
          selectorKind: 'category',
          selector: 'antigravity-native',
          operation: 'read',
        },
      ],
      [
        'Vault access is approved. antigravity-auth-opencode has read access, but it reaches no Antigravity login in the vault.',
        "The vault operator updates the vault's logins with: ck auth reclassify --from-registry",
        'Then they check them with: ck auth status',
      ],
    )
  })

  it('points an approved host still on local accounts at Serve accounts from the vault', async () => {
    const service = fakeEnrollmentService()
    service.approveNext()
    const { custody } = custodyWith(async () => undefined, service)
    await custody.requestAccess()
    // Approval switches OpenCode's authority to the vault at once, so a local
    // mode beside an approval is forced here through the status the menu
    // section builds from.
    const actual = custody.status.bind(custody)
    custody.status = async () => ({
      ...(await actual()),
      mode: 'local',
      hostSlot: 'empty',
    })
    const content = await custody.menuSection().build(invocation)
    expect(content.lines).toEqual([
      'Mode: this computer',
      'Vault access: approved as antigravity-auth-opencode',
      'OpenCode Google sign-in: empty',
      'Next: choose Serve accounts from the vault to use the accounts the vault serves this host.',
    ])
    expect(content.actions?.map((entry) => entry.id)).toContain('use-vault')
  })
})

describe('Vault menu background approval', () => {
  async function request(
    custody: ReturnType<typeof createOpenCodeVaultCustody>,
    notify: (message: string, kind?: 'info' | 'warning' | 'error') => void,
  ) {
    const invocation = { notify }
    const content = await custody.menuSection().build(invocation)
    const action = content.actions?.find(
      (entry) => entry.id === 'request-access',
    )
    if (!action) throw new Error('Missing vault request action')
    return action.run({ values: {}, invocation })
  }

  it('collects approval in the background and reports it once to the first invocation', async () => {
    const { custody, service } = custodyWith(async () => undefined)
    const first: string[] = []
    const second: string[] = []
    let notified!: () => void
    const notification = new Promise<void>((resolve) => {
      notified = resolve
    })
    expect(
      await request(custody, (message) => {
        first.push(message)
        notified()
      }),
    ).toMatchObject({ ok: true })
    expect(
      await request(custody, (message) => {
        second.push(message)
      }),
    ).toMatchObject({ ok: true })
    service.approveNext()
    await Promise.race([
      notification,
      new Promise<void>((_, reject) =>
        setTimeout(
          () => reject(new Error('No background approval notice')),
          4_000,
        ),
      ),
    ])
    expect(first).toHaveLength(1)
    expect(first[0]).toContain('approved as antigravity-auth-opencode')
    expect(second).toEqual([])
    expect(await custody.readMode()).toEqual({
      ok: true,
      record: { version: 1, mode: 'custody' },
    })
  }, 6_000)

  it('disposal cancels the wait without collecting or reporting a late approval', async () => {
    const { custody, service } = custodyWith(async () => undefined)
    const notices: string[] = []
    expect(
      await request(custody, (message) => {
        notices.push(message)
      }),
    ).toMatchObject({ ok: true })
    await custody.dispose()
    service.approveNext()
    await new Promise<void>((resolve) => setTimeout(resolve, 2_100))
    expect(notices).toEqual([])
    expect((await custody.status()).enrollment.state).toBe('pending')
  })

  it('stops when the local pending ceremony is disconnected rather than proposing again', async () => {
    const { custody, service } = custodyWith(async () => undefined)
    const notices: string[] = []
    expect(
      await request(custody, (message) => {
        notices.push(message)
      }),
    ).toMatchObject({ ok: true })
    await custody.useLocal()
    await new Promise<void>((resolve) => setTimeout(resolve, 2_100))
    expect(service.proposals).toHaveLength(1)
    expect(notices).toEqual([])
    expect((await custody.status()).enrollment.state).toBe('idle')
  })
})

describe('Vault request failure outcomes', () => {
  for (const state of [
    'blocked',
    'denied',
    'unavailable',
    'busy',
    'idle',
  ] as const) {
    it(`returns a failure with remedy text for ${state}`, async () => {
      const { custody } = custodyWith(async () => undefined)
      custody.requestAccess = async () => {
        const proposedName = OPENCODE_VAULT_ENROLLMENT_NAME
        if (state === 'blocked')
          return { state, proposedName, code: 'pending_exists' }
        if (state === 'unavailable')
          return { state, proposedName, code: 'connection-unavailable' }
        return { state, proposedName }
      }
      const invocation = { notify: () => undefined }
      const section = await custody.menuSection().build(invocation)
      const action = section.actions?.find(
        (entry) => entry.id === 'request-access',
      )
      if (!action) throw new Error('Missing vault action')
      const result = await action.run({ invocation, values: {} })
      if (typeof result === 'string')
        throw new Error('Expected a failure outcome')
      expect(result.ok).toBe(false)
      expect(result.text).toContain('Vault access:')
      if (state === 'blocked')
        expect(result.text).toContain('ck auth enroll deny')
      if (state === 'denied')
        expect(result.text).toContain('request vault access again')
      if (state === 'unavailable')
        expect(result.text).toContain('connection file')
    })
  }

  it('returns connection refusals as failures instead of a successful menu string', async () => {
    const { custody } = custodyWith(async () => undefined, undefined, {
      connectEnrollment: async () => {
        throw new Error('synthetic vault connection refused')
      },
    })
    const invocation = { notify: () => undefined }
    const content = await custody.menuSection().build(invocation)
    const action = content.actions?.find(
      (entry) => entry.id === 'request-access',
    )
    expect(await action?.run({ invocation, values: {} })).toMatchObject({
      ok: false,
      text: expect.stringContaining('Check the vault connection'),
    })
  })

  for (const outcome of ['denied', 'blocked'] as const) {
    it(`reports a background ${outcome} once without resetting the terminal ceremony`, async () => {
      const { custody, service } = custodyWith(async () => undefined)
      const notices: { message: string; kind?: string }[] = []
      let notified!: () => void
      const notification = new Promise<void>((resolve) => {
        notified = resolve
      })
      const invocation = {
        notify: (message: string, kind?: 'info' | 'warning' | 'error') => {
          notices.push({ message, kind })
          notified()
        },
      }
      const content = await custody.menuSection().build(invocation)
      const action = content.actions?.find(
        (entry) => entry.id === 'request-access',
      )
      expect(await action?.run({ invocation, values: {} })).toMatchObject({
        ok: true,
      })
      if (outcome === 'denied') service.denyNext()
      else service.blockNext()
      await Promise.race([
        notification,
        new Promise<void>((_, reject) =>
          setTimeout(
            () => reject(new Error('No terminal enrollment notice')),
            4_000,
          ),
        ),
      ])
      expect(notices).toHaveLength(1)
      expect(notices[0]?.kind).toBe('warning')
      expect(notices[0]?.message).toContain(outcome)
      expect(service.proposals).toHaveLength(1)
      expect((await custody.status()).enrollment.state).toBe(outcome)
    }, 6_000)
  }
})

it('starts vault-authority discovery when the request joins an old local observation', async () => {
  const claustrum = await loadCommonAuthClaustrum()
  let release!: () => void
  let entered!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const observed = new Promise<void>((resolve) => {
    entered = resolve
  })
  let firstRead = true
  let lists = 0
  const { custody, service } = custodyWith(async () => undefined, undefined, {
    loadClaustrum: async () => ({
      ...claustrum,
      enrollmentAuthority: async (paths, name) => {
        const authority = await claustrum.enrollmentAuthority(paths, name)
        if (firstRead) {
          firstRead = false
          entered()
          await held
        }
        return authority
      },
    }),
    connect: async () => ({
      listScoped: async () => {
        lists++
        return {
          view: 'approved-view',
          rows: [
            {
              id: 'credential',
              accountId: 'identity',
              credentialType: 'oauth',
              createdAtMs: 1,
              state: 'active',
              recordVersion: 1,
              categories: ['antigravity-native'],
              serves: ['google'],
              providerIds: ['google'],
              operations: ['read'],
              refreshAdapter: 'antigravity',
            },
          ],
          grants: undefined,
          grantTuples: undefined,
        }
      },
      getScoped: async () => {
        throw new Error('no credential send')
      },
      reportAuthFailureScoped: async () => {},
      close: () => {},
    }),
  })
  try {
    await custody.startObservation()
    await observed
    service.approveNext()
    expect((await custody.requestAccess()).state).toBe('approved')
    const pool = createVaultAccountPool({
      source: await custody.custodySource(),
    })
    const pending = pool.sync()
    release()
    await pending
    expect(lists).toBe(1)
    expect(pool.selector.rows).toHaveLength(1)
  } finally {
    release()
    await custody.dispose()
  }
})

type TestWatchNotice = {
  kind: 'changed'
  epoch: string
  seq: number
  view: string
  keys: string
}

type TestWatchEnd =
  | { kind: 'stopped' }
  | { kind: 'transport_lost'; error: unknown }

function fakeObservationClient(supportsWatch: boolean) {
  let listCalls = 0
  let watchCalls = 0
  let noticeCalls = 0
  let view = 'view-1'
  const notices: Array<(notice: TestWatchNotice) => void> = []
  const closeWatches: Array<(end: TestWatchEnd) => void> = []
  const client: Record<string, unknown> = {
    listScoped: async () => {
      listCalls++
      return {
        view,
        rows: [
          {
            id: 'credential',
            accountId: 'identity',
            credentialType: 'oauth',
            createdAtMs: 1,
            state: 'active',
            recordVersion: 1,
            categories: ['antigravity-native'],
            serves: ['google'],
            providerIds: ['google'],
            operations: ['read'],
            refreshAdapter: 'antigravity',
          },
        ],
        grants: undefined,
        grantTuples: undefined,
      }
    },
    getScoped: async () => {
      throw new Error('unexpected credential fetch')
    },
    reportAuthFailureScoped: async () => {},
    close: () => {
      for (const close of closeWatches) close({ kind: 'stopped' })
    },
  }
  if (supportsWatch) {
    client.watchScoped = (onNotice: (notice: TestWatchNotice) => void) => {
      const index = watchCalls++
      let close!: (end: TestWatchEnd) => void
      const closed = new Promise<TestWatchEnd>((resolve) => {
        close = resolve
      })
      notices[index] = (notice) => {
        noticeCalls++
        onNotice(notice)
      }
      closeWatches[index] = close
      queueMicrotask(() =>
        notices[index]?.({
          kind: 'changed',
          epoch: `epoch-${index}`,
          seq: 1,
          view,
          keys: '',
        }),
      )
      return {
        stop: () => close({ kind: 'stopped' }),
        closed,
      }
    }
  }
  return {
    client: client as never,
    get listCalls() {
      return listCalls
    },
    get watchCalls() {
      return watchCalls
    },
    get noticeCalls() {
      return noticeCalls
    },
    changeView(next: string) {
      view = next
      notices[0]?.({
        kind: 'changed',
        epoch: 'epoch-0',
        seq: 2,
        view: next,
        keys: 'credential',
      })
    },
    dropWatch(index: number) {
      closeWatches[index]?.({
        kind: 'transport_lost',
        error: new Error('simulated watch loss'),
      })
    },
  }
}

async function waitUntil(
  condition: () => boolean,
  description: string,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() >= deadline)
      throw new Error(`Timed out waiting for ${description}`)
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }
}

async function startObservedVault(
  client: ReturnType<typeof fakeObservationClient>,
  now: () => number,
  pollIntervalMs: number,
) {
  const service = fakeEnrollmentService()
  service.approveNext()
  const { custody } = custodyWith(async () => undefined, service, {
    connect: async () => client.client,
    now,
    pollIntervalMs,
  })
  expect((await custody.requestAccess()).state).toBe('approved')
  await custody.useVault()
  await custody.startObservation()
  return custody
}

it('OpenCode 1 vault observation watches the roster instead of listing every poll', async () => {
  const supportsWatch = Object.getOwnPropertyNames(
    ClaustrumClient.prototype,
  ).includes('watchScoped')
  // Model the public wrapper: its `watchScoped` method exists only in 0.12.0+.
  const client = fakeObservationClient(supportsWatch)
  let currentTime = OBSERVATION_NOW
  let clockReads = 0
  const custody = await startObservedVault(
    client,
    () => {
      clockReads++
      return currentTime
    },
    2_000,
  )
  try {
    await waitUntil(
      () =>
        client.listCalls === 1 &&
        client.watchCalls === 1 &&
        client.noticeCalls > 0,
      'the initial roster and accepted watch',
    )
    const beforePoll = clockReads
    currentTime += 6_001
    await waitUntil(
      () => clockReads > beforePoll,
      'the simulated post-five-second poll tick',
    )
    expect(client.listCalls).toBe(1)

    client.changeView('view-2')
    await waitUntil(() => client.listCalls === 2, 'the changed roster view')
    expect(client.listCalls).toBe(2)

    client.dropWatch(0)
    await waitUntil(
      () =>
        client.watchCalls === 2 &&
        client.listCalls === 3 &&
        client.noticeCalls > 1,
      'the replacement watch and its first roster read',
    )
    expect(client.listCalls).toBe(3)
  } finally {
    await custody.dispose()
  }
})

it('OpenCode 1 vault observation keeps polling when the client has no watch method', async () => {
  const client = fakeObservationClient(false)
  let currentTime = OBSERVATION_NOW
  let clockReads = 0
  const custody = await startObservedVault(
    client,
    () => {
      clockReads++
      return currentTime
    },
    50,
  )
  try {
    await waitUntil(() => client.listCalls === 1, 'the initial fallback roster')
    const beforePoll = clockReads
    currentTime += 6_001
    await waitUntil(
      () => clockReads > beforePoll && client.listCalls > 1,
      'the fallback roster poll',
    )
    expect(client.listCalls).toBe(2)
    expect(client.watchCalls).toBe(0)
  } finally {
    await custody.dispose()
  }
})
