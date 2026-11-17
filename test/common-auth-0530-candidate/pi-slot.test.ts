import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as core from '../../packages/core/src/common-auth-embedded/pi-slot/slot.js'
import * as opencode from '../../packages/opencode/src/common-auth-embedded/pi-slot/slot.js'

const placeholderKey = 'antigravity-vault-custody'
const original =
  '{\n  "google": {"type":"oauth","refresh":"discard-me"},\n  "other": {"key":"keep-me"}\n}\n'

for (const [profile, module] of Object.entries({ core, opencode }))
  describe(`${profile} common-auth pi-slot candidate contract`, () => {
    async function fixture() {
      const directory = await mkdtemp(join(tmpdir(), 'agy-pi-slot-'))
      const authPath = join(directory, 'agent', 'auth.json')
      const stashPath = join(directory, 'vault', 'google-login-stash.json')
      await mkdir(join(directory, 'agent'), { mode: 0o700 })
      await mkdir(join(directory, 'vault'), { mode: 0o700 })
      await writeFile(authPath, original, { mode: 0o600 })
      const steps: string[] = []
      const slot = module.createPiSlot(
        { authPath, stashPath, provider: 'google', placeholderKey },
        (step) => steps.push(step),
      )
      return { directory, authPath, stashPath, slot, steps }
    }

    test('enter discards the Google login without creating a stash; exit clears only the marker', async () => {
      const f = await fixture()
      try {
        expect(await f.slot.inspect()).toMatchObject({ slot: 'original' })
        await f.slot.enterVault()
        expect(JSON.parse(await readFile(f.authPath, 'utf8'))).toEqual({
          google: { type: 'api_key', key: placeholderKey },
          other: { key: 'keep-me' },
        })
        expect(existsSync(f.stashPath)).toBe(false)
        expect(await f.slot.inspect()).toEqual({ slot: 'placeholder' })
        expect(await f.slot.exitVault()).toBe('cleared')
        expect(JSON.parse(await readFile(f.authPath, 'utf8'))).toEqual({
          other: { key: 'keep-me' },
        })
        expect(await f.slot.inspect()).toEqual({ slot: 'empty' })
        expect(await f.slot.exitVault()).toBe('nothing-to-do')
      } finally {
        await rm(f.directory, { recursive: true, force: true })
      }
    })

    for (const action of ['enterVault', 'exitVault'] as const)
      test(`${action} deletes unreadable legacy contents after the auth write`, async () => {
        const f = await fixture()
        try {
          if (action === 'exitVault') await f.slot.enterVault()
          f.steps.length = 0
          // Invalid UTF-8 and JSON cannot be parsed as an old credential stash.
          await writeFile(f.stashPath, Buffer.from([0xff, 0x00, 0x7b]), {
            mode: 0o000,
          })
          await f.slot[action]()
          expect(f.steps).toEqual(['auth-written', 'stash-deleted'])
          expect(existsSync(f.stashPath)).toBe(false)
        } finally {
          await rm(f.directory, { recursive: true, force: true })
        }
      })

    test('exit leaves a replacement login byte-identical and deletes a legacy stash', async () => {
      const f = await fixture()
      try {
        await f.slot.enterVault()
        await writeFile(f.authPath, original, { mode: 0o600 })
        await writeFile(f.stashPath, 'not a credential document', {
          mode: 0o600,
        })
        expect(await f.slot.inspect()).toEqual({ slot: 'original' })
        expect(existsSync(f.stashPath)).toBe(true)
        expect(await f.slot.exitVault()).toBe('nothing-to-do')
        expect(await readFile(f.authPath, 'utf8')).toBe(original)
        expect(existsSync(f.stashPath)).toBe(false)
      } finally {
        await rm(f.directory, { recursive: true, force: true })
      }
    })

    for (const action of ['enterVault', 'exitVault'] as const)
      test(`${action} refuses a symlink stash without changing its target`, async () => {
        const f = await fixture()
        const target = join(f.directory, 'untouched')
        try {
          if (action === 'exitVault') await f.slot.enterVault()
          await writeFile(target, 'keep these bytes', { mode: 0o600 })
          await rm(f.stashPath, { force: true })
          await symlink(target, f.stashPath)
          await expect(f.slot[action]()).rejects.toMatchObject({
            code: 'unsafe-path',
          })
          expect(await readFile(target, 'utf8')).toBe('keep these bytes')
          expect(existsSync(f.stashPath)).toBe(true)
        } finally {
          await rm(f.directory, { recursive: true, force: true })
        }
      })
  })
