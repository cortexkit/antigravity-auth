import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type EnrollmentAuthority,
  loadCommonAuthClaustrum,
} from '@cortexkit/antigravity-auth-core'
import {
  createV1VaultActivationMethod,
  nativeOpenCodeAuthPath,
} from './vault-activation'

let root: string
let authFile: string
let authority: EnrollmentAuthority
let fileResolutions: number

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'v1-vault-activation-'))
  authFile = join(root, 'auth.json')
  authority = 'vault'
  fileResolutions = 0
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

async function flow() {
  const method = createV1VaultActivationMethod({
    providerId: 'google',
    readAuthority: async () => authority,
    authFile: () => {
      fileResolutions++
      return authFile
    },
  })
  if (method.type !== 'oauth')
    throw new Error('Expected an OAuth activation envelope')
  const result = await method.authorize()
  if (result.method !== 'auto') throw new Error('Expected automatic activation')
  return result
}

describe('OpenCode 1 vault activation', () => {
  it('uses the native data-directory path, treating an empty XDG override as unset', () => {
    expect(
      nativeOpenCodeAuthPath({ XDG_DATA_HOME: '/owned/data' }, '/owned/home'),
    ).toBe('/owned/data/opencode/auth.json')
    expect(nativeOpenCodeAuthPath({ XDG_DATA_HOME: '' }, '/owned/home')).toBe(
      '/owned/home/.local/share/opencode/auth.json',
    )
  })

  it('returns only the genuine marker for a missing native slot without writing auth files', async () => {
    const activation = await flow()
    expect(activation.url).toBe('')
    expect(activation.instructions).toContain('without signing in to Google')
    const result = await activation.callback()
    const claustrum = await loadCommonAuthClaustrum()
    expect(result).toEqual({
      ...claustrum.custodyPlaceholder('google'),
      type: 'success',
    })
    expect(existsSync(authFile)).toBe(false)
    expect(fileResolutions).toBe(1)
  })

  it('allows an absent Google entry while preserving every other native entry byte-for-byte', async () => {
    const bytes = JSON.stringify({
      other: { type: 'api', key: 'synthetic-other-key' },
    })
    writeFileSync(authFile, bytes)
    expect((await (await flow()).callback()).type).toBe('success')
    expect(readFileSync(authFile, 'utf8')).toBe(bytes)
  })

  for (const state of ['local', 'unreadable'] as const) {
    it(`refuses a stale offered action under ${state} authority before reading native credentials`, async () => {
      const activation = await flow()
      authority = state
      expect(await activation.callback()).toEqual({ type: 'failed' })
      expect(fileResolutions).toBe(0)
      expect(existsSync(authFile)).toBe(false)
    })
  }

  for (const [label, value] of [
    [
      'OAuth login',
      {
        type: 'oauth',
        access: 'synthetic-local',
        refresh: 'synthetic-refresh',
        expires: 1,
      },
    ],
    ['API key', { type: 'api', key: 'synthetic-user-key' }],
    ['null entry', null],
    ['empty entry', {}],
  ] as const) {
    it(`refuses an existing ${label} without replacing it`, async () => {
      const bytes = JSON.stringify({ google: value })
      writeFileSync(authFile, bytes)
      expect(await (await flow()).callback()).toEqual({ type: 'failed' })
      expect(readFileSync(authFile, 'utf8')).toBe(bytes)
    })
  }

  it('refuses an existing vault marker rather than overwriting native auth', async () => {
    const claustrum = await loadCommonAuthClaustrum()
    const bytes = JSON.stringify({
      google: claustrum.custodyPlaceholder('google'),
    })
    writeFileSync(authFile, bytes)
    expect(await (await flow()).callback()).toEqual({ type: 'failed' })
    expect(readFileSync(authFile, 'utf8')).toBe(bytes)
  })

  for (const bytes of ['{', '[]', 'null', '"not a map"']) {
    it(`refuses malformed native auth ${JSON.stringify(bytes)} without writes`, async () => {
      writeFileSync(authFile, bytes)
      expect(await (await flow()).callback()).toEqual({ type: 'failed' })
      expect(readFileSync(authFile, 'utf8')).toBe(bytes)
    })
  }

  it('does not treat an unreadable auth-file directory as a fresh slot', async () => {
    mkdirSync(authFile)
    expect(await (await flow()).callback()).toEqual({ type: 'failed' })
    expect(existsSync(authFile)).toBe(true)
  })
})
