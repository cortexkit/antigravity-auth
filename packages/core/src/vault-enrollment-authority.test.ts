import { afterEach, describe, expect, it } from 'bun:test'
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadCommonAuthClaustrum } from './common-auth-runtime.ts'
import { enrollmentAuthority } from './vault-enrollment-authority.ts'

const proposedName = 'antigravity-auth-opencode'
const syntheticPaths = {
  tokenPath: '/synthetic-token',
  statePath: '/synthetic-state',
}
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

async function fixture(name = proposedName, approved = false) {
  const temporary = process.platform === 'win32' ? tmpdir() : '/tmp'
  const root = realpathSync(mkdtempSync(join(temporary, 'vault-authority-')))
  roots.push(root)
  const claustrum = await loadCommonAuthClaustrum()
  const paths = claustrum.hostEnrollmentPaths({
    stateDir: root,
    host: 'opencode',
  })
  const manager = new claustrum.ClaustrumEnrollmentManager({
    paths,
    proposedName: name,
    client: {
      enrollPropose: async () => ({ requestId: 'synthetic-request' }),
      enrollPoll: async () =>
        approved
          ? {
              status: 'approved',
              name,
              token: 'ab'.repeat(32),
              tokenGeneration: 1,
            }
          : { status: 'pending' },
    },
  })
  expect((await manager.reconcile()).state).toBe(
    approved ? 'approved' : 'pending',
  )
  return { root, paths, claustrum }
}

describe('enrollment source authority', () => {
  for (const authority of ['local', 'vault', 'unreadable'] as const)
    it(`preserves the public library's ${authority} result and consumer binding`, async () => {
      expect(
        await enrollmentAuthority(syntheticPaths, proposedName, {
          enrollmentAuthority: async (paths, name) => {
            expect(paths).toBe(syntheticPaths)
            expect(name).toBe(proposedName)
            return authority
          },
        }),
      ).toBe(authority)
    })

  it('a failed public authority read cannot authorize local work', async () => {
    expect(
      await enrollmentAuthority(syntheticPaths, proposedName, {
        enrollmentAuthority: async () => {
          throw new Error('synthetic read failure')
        },
      }),
    ).toBe('unreadable')
  })

  it('a pending native ceremony leaves local accounts available', async () => {
    const { paths } = await fixture()
    expect(await enrollmentAuthority(paths, proposedName)).toBe('local')
  })

  for (const code of ['superseded', 'not_found', 'already_consumed'])
    it(`a readable terminal refusal ${code} leaves local accounts available`, async () => {
      const { paths } = await fixture()
      const state = JSON.parse(readFileSync(paths.statePath, 'utf8'))
      writeFileSync(
        paths.statePath,
        JSON.stringify({ ...state, phase: 'blocked', errorCode: code }),
      )
      expect(await enrollmentAuthority(paths, proposedName)).toBe('local')
    })

  for (const approved of [false, true])
    it(`refuses another consumer's ${approved ? 'approved' : 'pending'} native ceremony`, async () => {
      const { paths } = await fixture('synthetic-foreign-consumer', approved)
      expect(await enrollmentAuthority(paths, proposedName)).toBe('unreadable')
    })

  it('approved enrollment excludes local accounts even if its token disappears or corrupts', async () => {
    const { paths } = await fixture(proposedName, true)
    expect(await enrollmentAuthority(paths, proposedName)).toBe('vault')
    const token = readFileSync(paths.tokenPath)
    unlinkSync(paths.tokenPath)
    expect(await enrollmentAuthority(paths, proposedName)).toBe('vault')
    writeFileSync(paths.tokenPath, '{', { mode: 0o600 })
    expect(await enrollmentAuthority(paths, proposedName)).toBe('vault')
    writeFileSync(paths.tokenPath, token)
    expect(await enrollmentAuthority(paths, proposedName)).toBe('vault')
  })

  it('a malformed native ceremony never authorizes local work', async () => {
    const { paths } = await fixture()
    writeFileSync(paths.statePath, '{')
    expect(await enrollmentAuthority(paths, proposedName)).toBe('unreadable')
  })
})
