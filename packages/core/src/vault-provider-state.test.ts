import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  loadCommonAuthClaustrum,
  loadCommonAuthFs,
} from './common-auth-runtime.ts'

import type { VaultRoster, VaultRosterRow } from './vault-account-source.ts'
import {
  type AntigravityVaultStateFs,
  type AntigravityVaultStateUpdate,
  type CommitVaultProviderStateInput,
  commitVaultProviderState,
  readVaultProviderState,
  VAULT_PROVIDER_STATE_LOCK,
  type VaultRosterGuardModule,
  type VaultStateAttribution,
} from './vault-provider-state.ts'

const A: VaultStateAttribution = {
  routeId: 'vault:a',
  credentialId: 'cred-a',
  accountIdentity: 'account-a',
  recordVersion: 3,
}

function row(overrides: Partial<VaultRosterRow> = {}): VaultRosterRow {
  return {
    routeId: A.routeId,
    credentialId: A.credentialId,
    credentialType: 'oauth',
    accountIdentity: A.accountIdentity,
    state: 'active',
    label: 'A',
    enabled: true,
    addedAt: 0,
    ...overrides,
  }
}

function roster(
  rows: VaultRosterRow[],
  declined: VaultRoster['declined'] = [],
): VaultRoster {
  return { version: 1, complete: true, rows, declined }
}

const FINGERPRINT = {
  deviceId: 'device',
  sessionToken: 'random-tracking-value',
  userAgent: 'ua',
  apiClient: 'client',
  clientMetadata: { ideType: 'IDE', platform: 'MACOS', pluginType: 'GEMINI' },
  createdAt: 1,
}

let dir: string
let statePath: string
let events: string[]
let currentRoster: VaultRoster | undefined
let rosterOwned: boolean
let stateOwned: boolean
let failRename: boolean

const guard: VaultRosterGuardModule = {
  async mutateVaultRoster(_path, change) {
    events.push('roster-lock')
    try {
      const outcome = await change(currentRoster, {
        assertOwned: async () => {
          events.push('assert-roster')
          if (!rosterOwned) throw new Error('roster lock lost')
        },
      })
      expect(outcome.next).toBeUndefined()
      return outcome.result
    } finally {
      events.push('roster-unlock')
    }
  },
  isDeclined(entries, credentialId, accountIdentity) {
    return entries.some(
      (entry) =>
        entry.credentialId === credentialId ||
        (entry.accountIdentity !== undefined &&
          entry.accountIdentity === accountIdentity),
    )
  },
}

const fs: AntigravityVaultStateFs = {
  async withLock(target, options, fn) {
    expect(target).toBe(statePath)
    expect(options).toEqual(VAULT_PROVIDER_STATE_LOCK)
    events.push('state-lock')
    try {
      return await fn({
        assertOwned: async () => {
          events.push('assert-state')
          if (!stateOwned) throw new Error('state lock lost')
        },
      })
    } finally {
      events.push('state-unlock')
    }
  },
  async writeJsonAtomic(path, value, options) {
    await options?.beforeRename?.()
    if (failRename) throw new Error('rename failed')
    events.push('rename')
    await writeFile(path, JSON.stringify(value))
  },
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agy-vault-state-'))
  statePath = join(dir, 'antigravity-vault-state.json')
  events = []
  currentRoster = roster([row()])
  rosterOwned = true
  stateOwned = true
  failRename = false
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function commit(
  update: AntigravityVaultStateUpdate,
  overrides: Partial<CommitVaultProviderStateInput> = {},
) {
  return commitVaultProviderState({
    claustrum: guard,
    fs,
    rosterPath: join(dir, 'roster.json'),
    statePath,
    attribution: A,
    verify: async () => {
      events.push('verify')
    },
    update,
    ...overrides,
  })
}

async function stored(): Promise<string | undefined> {
  return readFile(statePath, 'utf8').catch(() => undefined)
}

describe('vault provider-state commit fencing', () => {
  it('guards with the roster lock, then its own lock and a fresh check, asserting both before rename', async () => {
    const result = await commit(() => ({
      metadata: { addedAt: 1, lastUsed: 2, label: 'Work' },
    }))
    expect(result.status).toBe('written')
    expect(events).toEqual([
      'roster-lock',
      'state-lock',
      'verify',
      'assert-roster',
      'assert-state',
      'rename',
      'state-unlock',
      'roster-unlock',
    ])
    const file = await readVaultProviderState(statePath)
    expect(file.accounts['account-a']?.metadata?.label).toBe('Work')
    expect(file.accounts['account-a']?.observed).toEqual({
      routeId: 'vault:a',
      credentialId: 'cred-a',
      recordVersion: 3,
    })
  })

  it('refuses a stale binding before the fresh check or any write', async () => {
    const stale: [string, VaultRoster | undefined][] = [
      ['missing roster', undefined],
      ['removed', roster([])],
      ['declined', roster([row()], [{ credentialId: 'cred-a' }])],
      ['disabled', roster([row({ enabled: false })])],
      ['rebound credential', roster([row({ credentialId: 'cred-b' })])],
      ['other account', roster([row({ accountIdentity: 'account-b' })])],
      ['unclaimed', roster([row({ unclaimed: true })])],
      ['stale', roster([row({ stale: true })])],
      ['not active', roster([row({ state: 'needs-login' })])],
    ]
    for (const [, value] of stale) {
      currentRoster = value
      let updates = 0
      await expect(
        commit(() => {
          updates++
          return { metadata: { addedAt: 1, lastUsed: 2 } }
        }),
      ).rejects.toMatchObject({ kind: 'binding-stale' })
      expect(updates).toBe(0)
    }
    expect(events).not.toContain('verify')
    expect(await stored()).toBeUndefined()
  })

  it('writes nothing when the fresh vault check refuses', async () => {
    let updates = 0
    await expect(
      commit(
        () => {
          updates++
          return { metadata: { addedAt: 1, lastUsed: 2 } }
        },
        {
          verify: async () => {
            throw new Error('version moved')
          },
        },
      ),
    ).rejects.toThrow('version moved')
    expect(updates).toBe(0)
    expect(await stored()).toBeUndefined()
  })

  it('does not rename after losing either lock and reports the write as uncertain', async () => {
    await commit(() => ({
      metadata: { addedAt: 1, lastUsed: 2, label: 'old' },
    }))
    const before = await stored()
    for (const lose of ['roster', 'state'] as const) {
      rosterOwned = lose !== 'roster'
      stateOwned = lose !== 'state'
      const result = await commit(() => ({
        metadata: { addedAt: 1, lastUsed: 9, label: 'new' },
      }))
      expect(result.status).toBe('uncertain')
      if (result.status === 'uncertain')
        expect(result.state?.metadata?.label).toBe('old')
      expect(await stored()).toBe(before)
    }
  })

  it('refuses an asynchronous update', async () => {
    const asyncUpdate = (async () => ({
      metadata: { addedAt: 1, lastUsed: 2 },
    })) as unknown as AntigravityVaultStateUpdate
    await expect(commit(asyncUpdate)).rejects.toMatchObject({
      kind: 'invalid-update',
    })
    expect(await stored()).toBeUndefined()
  })

  it('refuses an attribution without an asserted account', async () => {
    await expect(
      commit(() => ({ metadata: { addedAt: 1, lastUsed: 2 } }), {
        attribution: { ...A, accountIdentity: '' },
      }),
    ).rejects.toMatchObject({ kind: 'invalid-attribution' })
    expect(events).toEqual([])
  })
})

describe('vault provider-state identity binding', () => {
  it('keeps the same account’s state across a record-version rotation', async () => {
    await commit(() => ({
      metadata: { addedAt: 1, lastUsed: 2, label: 'Kept' },
    }))
    let seen: string | null | undefined
    const result = await commit(
      (current) => {
        seen = current?.metadata?.label
        return current?.metadata
          ? { metadata: { ...current.metadata, lastUsed: 5 } }
          : undefined
      },
      { attribution: { ...A, recordVersion: 4 } },
    )
    expect(seen).toBe('Kept')
    expect(result.status).toBe('written')
    const entry = (await readVaultProviderState(statePath)).accounts[
      'account-a'
    ]
    expect(entry?.observed.recordVersion).toBe(4)
    expect(entry?.metadata?.lastUsed).toBe(5)
  })

  it('gives a different account on the same route none of the previous account’s state', async () => {
    await commit(() => ({
      metadata: { addedAt: 1, lastUsed: 2, coolingDownUntil: 99 },
      quota: { schemaVersion: 1, cachedQuotaUpdatedAt: 7 },
    }))
    currentRoster = roster([row({ accountIdentity: 'account-b' })])
    let seen: unknown = 'not called'
    await commit(
      (current) => {
        seen = current
        return { metadata: { addedAt: 3, lastUsed: 4 } }
      },
      { attribution: { ...A, accountIdentity: 'account-b' } },
    )
    expect(seen).toBeUndefined()
    const file = await readVaultProviderState(statePath)
    expect(file.accounts['account-b']?.metadata?.coolingDownUntil).toBe(
      undefined,
    )
    expect(file.accounts['account-b']?.quota).toBeUndefined()
    expect(file.accounts['account-a']?.metadata?.coolingDownUntil).toBe(99)
  })

  it('clears one account without touching another', async () => {
    await commit(() => ({ metadata: { addedAt: 1, lastUsed: 2 } }))
    expect((await commit(() => null)).status).toBe('cleared')
    expect((await readVaultProviderState(statePath)).accounts).toEqual({})
    expect((await commit(() => null)).status).toBe('unchanged')
  })
})

describe('vault provider-state content', () => {
  it('never persists a bearer, refresh secret, header or project', async () => {
    const refused: [string, Record<string, unknown>][] = [
      ['access token', { extensions: { accessToken: 'abc' } }],
      ['refresh token', { extensions: { nested: { refresh_token: 'abc' } } }],
      ['authorization', { extensions: { Authorization: 'x' } }],
      ['bearer value', { extensions: { note: 'ya29.secret' } }],
      [
        'refresh value',
        { metadata: { addedAt: 1, lastUsed: 2, label: '1//x' } },
      ],
      ['receipt', { extensions: { receipt: { recordVersion: 1 } } }],
      ['project', { metadata: { addedAt: 1, lastUsed: 2, projectId: 'p' } }],
      [
        'managed project',
        { metadata: { addedAt: 1, lastUsed: 2, managedProjectId: 'p' } },
      ],
      ['project extension', { extensions: { project: 'p' } }],
      [
        'misplaced session token',
        { extensions: { sessionToken: 'random-tracking-value' } },
      ],
    ]
    for (const [, value] of refused) {
      const update = (() => value) as unknown as AntigravityVaultStateUpdate
      await expect(commit(update)).rejects.toMatchObject({
        kind: expect.stringMatching(/^(credential-material|project-field)$/),
      })
    }
    expect(await stored()).toBeUndefined()
  })

  it('keeps the fingerprint session token and full quota losslessly', async () => {
    const quota = {
      schemaVersion: 1 as const,
      cachedQuota: {
        claude: {
          remainingFraction: null,
          modelCount: 2,
          windows: [
            { window: '5h' as const, remainingFraction: 0.5, resetTime: 'r1' },
            {
              window: 'weekly' as const,
              remainingFraction: 0.25,
              resetTime: 'r2',
            },
          ],
        },
      },
      cachedPerModelQuota: [
        { modelId: 'm2', group: null, remainingFraction: 1 },
        { modelId: 'm1', group: 'claude', remainingFraction: 0.5 },
      ],
      extensions: { futureField: [1, 2] },
    }
    await commit(() => ({
      metadata: {
        addedAt: 1,
        lastUsed: 2,
        fingerprint: FINGERPRINT,
        fingerprintHistory: [
          { fingerprint: FINGERPRINT, timestamp: 1, reason: 'initial' },
        ],
      },
      quota,
    }))
    const entry = (await readVaultProviderState(statePath)).accounts[
      'account-a'
    ]
    expect(entry?.metadata?.fingerprint?.sessionToken).toBe(
      'random-tracking-value',
    )
    expect(entry?.quota).toEqual(quota)
  })

  it('refuses a newer, malformed or credential-bearing file instead of stripping it', async () => {
    const files: [string, unknown][] = [
      ['newer', { schemaVersion: 2, accounts: {} }],
      ['unknown field', { schemaVersion: 1, accounts: {}, tokens: [] }],
      [
        'credential',
        {
          schemaVersion: 1,
          accounts: {
            'account-a': {
              observed: { routeId: 'r', credentialId: 'c', recordVersion: 1 },
              extensions: { refreshToken: 'x' },
            },
          },
        },
      ],
      [
        'project',
        {
          schemaVersion: 1,
          accounts: {
            'account-a': {
              observed: { routeId: 'r', credentialId: 'c', recordVersion: 1 },
              metadata: { addedAt: 1, lastUsed: 2, projectId: 'p' },
            },
          },
        },
      ],
    ]
    for (const [, value] of files) {
      const text = JSON.stringify(value)
      await writeFile(statePath, text)
      await expect(readVaultProviderState(statePath)).rejects.toMatchObject({
        kind: expect.stringMatching(
          /^(newer-schema|malformed|credential-material|project-field)$/,
        ),
      })
      await expect(
        commit(() => ({ metadata: { addedAt: 1, lastUsed: 2 } })),
      ).rejects.toThrow()
      expect(await stored()).toBe(text)
    }
  })
})

describe('vault provider-state with the real common-auth locks', () => {
  async function writeRoster(path: string): Promise<string> {
    const text = JSON.stringify(roster([row()]))
    await writeFile(path, text, { mode: 0o600 })
    return text
  }

  it('writes under the real roster and state locks without rewriting the roster', async () => {
    const rosterPath = join(dir, 'roster.json')
    const rosterText = await writeRoster(rosterPath)
    const result = await commitVaultProviderState({
      claustrum: await loadCommonAuthClaustrum(),
      fs: await loadCommonAuthFs(),
      rosterPath,
      statePath,
      attribution: A,
      verify: async () => {},
      update: () => ({ metadata: { addedAt: 1, lastUsed: 2, label: 'Real' } }),
    })
    expect(result.status).toBe('written')
    expect(
      (await readVaultProviderState(statePath)).accounts['account-a']?.metadata
        ?.label,
    ).toBe('Real')
    expect(await readFile(rosterPath, 'utf8')).toBe(rosterText)
  })

  it('does not publish after the real state lock is lost before rename', async () => {
    const rosterPath = join(dir, 'roster.json')
    await writeRoster(rosterPath)
    const claustrum = await loadCommonAuthClaustrum()
    const realFs = await loadCommonAuthFs()
    const input = {
      claustrum,
      fs: realFs,
      rosterPath,
      statePath,
      attribution: A,
    }
    await commitVaultProviderState({
      ...input,
      verify: async () => {},
      update: () => ({ metadata: { addedAt: 1, lastUsed: 2, label: 'old' } }),
    })
    const before = await stored()
    const result = await commitVaultProviderState({
      ...input,
      // Another writer takes over the state-file lock while the second
      // commit is running its fresh check, before it renames the file.
      verify: async () => {
        await rm(
          realFs.lockPathFor(statePath, VAULT_PROVIDER_STATE_LOCK.name),
          {
            recursive: true,
            force: true,
          },
        )
      },
      update: () => ({ metadata: { addedAt: 1, lastUsed: 9, label: 'new' } }),
    })
    expect(result.status).toBe('uncertain')
    if (result.status === 'uncertain') {
      expect(result.error).toBeInstanceOf(realFs.LockOwnershipError)
      expect(result.state?.metadata?.label).toBe('old')
    }
    expect(await stored()).toBe(before)
  })
})
