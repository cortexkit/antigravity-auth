/**
 * OpenCode vault custody: paths, the mode file, the enrollment step over the
 * genuine vault library with an owned fake vault service, the custody
 * switch and its host-slot refusal, and the Vault menu section. Every path
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
  type OpenCodeVaultCustodyOptions,
  openCodeVaultPaths,
  readOpenCodeVaultMode,
} from './vault-custody'

/** A well-formed enrollment token, as the vault issues them. */
const ENROLLMENT_TOKEN = 'ab'.repeat(32)

let root: string
let accountFile: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'opencode-vault-')))
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

  it('refuses custody while OpenCode holds its own Google login, and when the slot cannot be read', async () => {
    const service = fakeEnrollmentService()
    service.approveNext()
    const signedIn = custodyWith(
      async () => ({
        type: 'oauth',
        refresh: 'host-refresh',
        access: 'host-access',
        expires: 1,
      }),
      service,
    )
    await signedIn.custody.requestAccess()
    await expect(signedIn.custody.useVault()).rejects.toThrow(
      'signed in to Google with its own login',
    )
    expect((await signedIn.custody.readMode()).ok).toBe(true)
    expect(
      (await readOpenCodeVaultMode(openCodeVaultPaths(accountFile).modeFile))
        .ok && (await signedIn.custody.status()).mode,
    ).toBe('local')

    const unreadable = custodyWith(async () => {
      throw new Error('host API failed')
    }, service)
    await expect(unreadable.custody.useVault()).rejects.toThrow(
      'could not be read',
    )
    expect((await unreadable.custody.status()).hostSlot).toBe('unreadable')
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

  it('refuses the custody source while OpenCode holds its own login, before connecting', async () => {
    let connected = 0
    const { custody } = custodyWith(
      async () => ({
        type: 'oauth',
        refresh: 'host-refresh',
        access: 'host-access',
        expires: 1,
      }),
      undefined,
      {
        connect: async () => {
          connected += 1
          throw new Error('not reached')
        },
      },
    )
    const { dir, modeFile } = openCodeVaultPaths(accountFile)
    mkdirSync(dir, { mode: 0o700 })
    writeFileSync(modeFile, '{"version":1,"mode":"custody"}')
    await expect(custody.custodySource()).rejects.toThrow(
      'signed in to Google with its own login',
    )
    expect(connected).toBe(0)
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
