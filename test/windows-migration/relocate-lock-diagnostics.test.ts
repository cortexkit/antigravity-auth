import { afterEach, beforeEach, expect, it } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { relocationLockDiagnostics } from './relocate-lock-diagnostics.mjs'

const OWNER = '11111111-1111-4111-8111-111111111111'
const MARKER_OWNER = '22222222-2222-4222-8222-222222222222'
let root: string
let anchor: string
let directory: string
let lock: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'relocate-lock-diagnostics-'))
  anchor = join(root, 'antigravity-accounts.json')
  directory = `${anchor}.store.33333333-3333-4333-8333-333333333333.generation`
  lock = join(directory, 'config.json.antigravity-management.lock')
  await mkdir(directory)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

it('captures the lease and fresh eviction owner without changing either', async () => {
  const lease = { ownerId: OWNER, expiresAt: Date.now() + 10_000 }
  const marker = { ownerId: MARKER_OWNER, createdAt: Date.now() }
  await writeFile(lock, JSON.stringify(lease))
  await mkdir(`${lock}.evicting`)
  await writeFile(
    join(`${lock}.evicting`, 'owner.json'),
    JSON.stringify(marker),
  )
  const snapshot = await relocationLockDiagnostics(root, [anchor])
  expect(snapshot).toMatchObject({
    capturedAt: expect.any(Number),
    generations: [
      {
        locks: [
          {
            lease: { kind: 'file', owner: lease },
            evictionMarker: {
              kind: 'directory',
              ageMs: expect.any(Number),
              owner: marker,
            },
          },
        ],
      },
    ],
  })
  expect(JSON.parse(await readFile(lock, 'utf8'))).toEqual(lease)
  expect(
    JSON.parse(await readFile(join(`${lock}.evicting`, 'owner.json'), 'utf8')),
  ).toEqual(marker)
})

it('reports a missing lease even when only its eviction marker remains', async () => {
  await mkdir(`${lock}.evicting`)
  const snapshot = await relocationLockDiagnostics(root, [anchor])
  expect(snapshot.generations).toMatchObject([
    {
      locks: [
        {
          lease: { error: 'ENOENT' },
          evictionMarker: { kind: 'directory', error: 'ENOENT' },
        },
      ],
    },
  ])
})

it('reads legacy directory leases and omits unrelated payloads', async () => {
  await mkdir(lock)
  await writeFile(
    join(lock, 'owner.json'),
    JSON.stringify({
      ownerId: OWNER,
      expiresAt: 123,
      pid: 456,
      refreshToken: 'not-diagnostic-data',
    }),
  )
  await writeFile(join(directory, 'config.json'), 'not-diagnostic-data')
  await writeFile(join(directory, 'state.json'), 'not-diagnostic-data')
  const snapshot = await relocationLockDiagnostics(root, [anchor])
  expect(snapshot.generations).toMatchObject([
    {
      locks: [
        {
          lease: {
            kind: 'directory',
            owner: { ownerId: OWNER, expiresAt: 123, pid: 456 },
          },
        },
      ],
    },
  ])
  expect(JSON.stringify(snapshot)).not.toContain('not-diagnostic-data')
  expect(JSON.stringify(snapshot)).not.toContain(root)
})

it('keeps malformed records and absent anchor parents diagnostic, not fatal', async () => {
  await writeFile(lock, '{')
  const snapshot = await relocationLockDiagnostics(root, [
    anchor,
    join(root, 'missing', 'accounts.json'),
  ])
  expect(snapshot.generations).toMatchObject([
    { locks: [{ lease: { kind: 'file', error: 'SyntaxError' } }] },
    { error: 'ENOENT' },
  ])
})
