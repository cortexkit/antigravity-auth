import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

export const repository = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../..',
)
export const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')

// Transpile only handwritten adapters. Supplied public modules stay byte-exact
// and share a single canonical module directory inside each owned test domain.
export async function fixture(root) {
  await mkdir(join(root, 'rpc'), { recursive: true })
  await cp(
    join(repository, 'packages/opencode/src/common-auth-embedded'),
    join(root, 'common-auth-embedded'),
    { recursive: true },
  )
  const inputs = []
  for (const name of ['rpc-server', 'rpc-client', 'port-file']) {
    const path = `packages/opencode/src/rpc/${name}.ts`
    const source = await readFile(join(repository, path), 'utf8')
    const compiled = ts.transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ES2022,
      },
    }).outputText
    await writeFile(join(root, `rpc/${name}.js`), compiled)
    inputs.push({ path, sha256: hash(source), compiledSha256: hash(compiled) })
    if (name === 'rpc-server') {
      if (
        !compiled.includes('timeoutMs: 0') ||
        !compiled.includes('applyDeadlineMs: 120_000')
      )
        throw new Error(
          'adapter timing settings changed; refuse unreachable controls',
        )
      await writeFile(
        join(root, 'rpc/server-nonzero.js'),
        compiled.replace('timeoutMs: 0', 'timeoutMs: 1500'),
      )
      await writeFile(
        join(root, 'rpc/server-short.js'),
        compiled.replace('applyDeadlineMs: 120_000', 'applyDeadlineMs: 150'),
      )
    }
  }
  await writeFile(join(root, 'package.json'), '{"type":"module"}')
  return inputs
}

export const caseNames = [
  'rpc.auth_validation',
  'identity.rpc_error',
  'identity.client_public_objects',
  'rpc.strict_pid',
  'rpc.port_wrapper',
  'rpc.stage_security',
  'rpc.async_drain',
  'rpc.shutdown_ownership',
  'rpc.notification_narrowing',
  'rpc.timeout_zero',
  'rpc.live_504',
  'rpc.callback_noncancel',
  'rpc.lifetime_after_stop',
  'rpc.recorder_witness',
  'rpc.no_proxy',
  'rpc.client_deadline_socket_close',
  'rpc.deadlines',
]
