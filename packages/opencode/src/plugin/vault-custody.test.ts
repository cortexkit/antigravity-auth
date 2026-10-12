/**
 * OpenCode vault custody: paths, the mode file, the enrollment step over the
 * genuine vault library with an owned fake vault service, the custody
 * switch with dormant local logins, and the Vault menu section. Every path
 * is under a temporary directory; nothing connects to a real vault.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
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

let root: string
let accountFile: string

beforeEach(() => {
  // Build/test runners can put TMPDIR below a shared dependency directory.
  // Use the sticky system temporary directory for enrollment's ancestor checks.
  const temporary = process.platform === 'win32' ? tmpdir() : '/tmp'
  root = realpathSync(mkdtempSync(join(temporary, 'opencode-vault-')))
  // The vault library refuses enrollment under a directory others can write.
  mkdirSync(join(root, 'config'), { mode: 0o700 })
  accountFile = join(root, 'config', 'antigravity-accounts.json')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** An owned stand-in for the vault's enrollment service. */
function fakeEnrollmentService() {
  const proposals: { name: string }[] = []
  let approve = false
  return {
    proposals,
    approveNext() {
      approve = true
    },
    connect: async () => ({
      async enrollPropose(input: { name: string; requestSecretHash: string }) {
        proposals.push({ name: input.name })
        return { requestId: 'request-1' }
      },
      async enrollPoll() {
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
  return {
    service,
    custody: createOpenCodeVaultCustody({
      accountFile,
      readHostSlot: hostSlot,
      reporterSource: 'direct',
      connectionFile: () => join(root, 'vault-connection.json'),
      connectEnrollment: service.connect,
      connect: async () => {
        throw new Error(
          'the request-path vault client is not part of this test',
        )
      },
      ...extra,
    }),
  }
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
