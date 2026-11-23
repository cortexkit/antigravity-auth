import { expect, test } from 'bun:test'
import { ANTIGRAVITY_SETTINGS } from '../../../../core/src/settings/definition.ts'
import { custodies, hostPackages } from '../cases.ts'
import { rows } from './applicability.ts'
import { renderSettingsDoc } from './settings-doc.ts'

const root = new URL('../../../../../', import.meta.url)
const text = (path: string) => Bun.file(new URL(path, root)).text()

test('every defined setting has exactly one row per host and custody with its declared source scope', () => {
  const expected = Object.entries(ANTIGRAVITY_SETTINGS.settings).flatMap(
    ([key, declaration]) =>
      Object.keys(hostPackages).flatMap((host) =>
        custodies.map(
          (custody) =>
            `${key}:${host}:${custody}:${declaration.project === 'allowed' ? 'project' : 'user-only'}`,
        ),
      ),
  )
  expect(
    rows
      .map(
        ({ key, host, custody, scope }) => `${key}:${host}:${custody}:${scope}`,
      )
      .sort(),
  ).toEqual(expected.sort())
})

test('every applied setting names an existing test and every exception has evidence', async () => {
  const sources = new Map<string, string>()
  for (const proof of new Set(rows.map(({ proof }) => proof))) {
    if (proof.status === 'applied') {
      expect(proof.file).toEndWith('.test.ts')
      if (!sources.has(proof.file))
        sources.set(proof.file, await text(proof.file))
      const source = sources.get(proof.file)!
      // Loop-generated cases contain literal parts of the test name rather than its expansion.
      const title = proof.test
        .replace(/^opencode2 |^pi /, '')
        .replace('cold round-robin sessions', `cold \${strategy} sessions`)
        .replace('Pi transport refusals', `Pi \${source} refusals`)
        .replace('Pi transport boundary', `Pi \${source} boundary`)
        .replace(
          'auxiliary HTTP 422 without',
          `auxiliary HTTP \${failure.status} without`,
        )
      expect(source).toContain(title)
    } else if (proof.status === 'host-limited') {
      expect(proof.package).toBe('@opencode/plugin')
      expect(proof.version).toBe('2.0.22')
      expect(proof.file).toStartWith('packages/plugin/src/promise/')
      expect(
        await text('packages/opencode/docs/opencode2-ga-2.0.22-contract.md'),
      ).toContain(proof.file.replace('packages/', ''))
    } else {
      expect(proof.reason.length).toBeGreaterThan(0)
    }
  }
})

test('the published settings table agrees with the checked applicability rows', async () => {
  expect(await text('packages/opencode/docs/SETTINGS.md')).toBe(
    renderSettingsDoc(),
  )
  expect(await text('README.md')).toContain(
    '(packages/opencode/docs/SETTINGS.md)',
  )
  expect(await text('packages/pi/README.md')).toContain(
    '(../opencode/docs/SETTINGS.md)',
  )
  expect(await text('packages/opencode/docs/CONFIGURATION.md')).toContain(
    '(SETTINGS.md)',
  )
})
