import { expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { producerVersion } from '../../../packages/opencode/scripts/embed-common-auth.ts'

test('build.compiler_predecessor_lists_match', async () => {
  const markers = (source: string) =>
    [
      ...new Set(
        source.match(/@cortexkit\/common-auth\/tui-build@\d+\.\d+\.\d+/g),
      ),
    ].sort()
  const product = await readFile(
    new URL('../../../packages/opencode/scripts/build-tui.ts', import.meta.url),
    'utf8',
  )
  const preflight = await readFile(
    new URL('../../../tools/common-auth-build/build.mjs', import.meta.url),
    'utf8',
  )
  expect(
    markers(preflight.replace(`\${producerVersion}`, producerVersion)),
  ).toEqual(markers(product))
})
