import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { caseNames, fixture, hash, repository } from './fixture.mjs'
import { validateResult } from './result-validator.mjs'

const owned = join(repository, 'test/common-auth-094-adoption/rpc/.owned')
await mkdir(owned, { recursive: true })
const start = Number(process.env.RPC_MUTATION_START ?? 0)
const receipts =
  start === 0
    ? []
    : JSON.parse(
        await readFile(join(owned, 'mutation-receipts.receipt'), 'utf8'),
      )
const git = (...argv) => {
  const child = spawnSync('git', argv, { cwd: repository, encoding: 'utf8' })
  assert.equal(child.status, 0, child.stderr)
  return child.stdout
}
const controls = [
  {
    control: 'Bypass raw pending parser',
    path: 'rpc/rpc-server.js',
    from: 'parsePending,',
    to: 'parsePending: undefined,',
    expected: 'rpc.auth_validation',
  },
  {
    control: 'Bypass apply validator',
    path: 'rpc/rpc-server.js',
    from: 'options.apply(parseApply(request))',
    to: 'options.apply(request)',
    expected: 'rpc.auth_validation',
  },
  {
    control: 'Drop client exactPid',
    path: 'rpc/rpc-client.js',
    from: 'exactPid: true',
    to: 'exactPid: false',
    expected: 'rpc.strict_pid',
  },
  {
    control: 'Drop discovery wrapper exactPid',
    path: 'rpc/port-file.js',
    from: 'exactPid: true',
    to: 'exactPid: false',
    expected: 'rpc.port_wrapper',
  },
  {
    control: 'Drop server secureDir directory repair',
    path: 'rpc/rpc-server.js',
    from: 'secureDir: true',
    to: 'secureDir: false',
    expected: 'rpc.port_wrapper',
  },
  {
    control: 'Allow nonexclusive stage overwrite',
    path: 'common-auth-embedded/rpc/port-file.js',
    from: "open(tmp, 'wx', 0o600)",
    to: "open(tmp, 'w', 0o600)",
    expected: 'rpc.stage_security',
  },
  {
    control: 'Remove owned stage cleanup',
    path: 'common-auth-embedded/rpc/port-file.js',
    from: 'if (created)\n                await unlink(tmp)',
    to: 'if (false)\n                await unlink(tmp)',
    expected: 'rpc.stage_security',
  },
  {
    control: 'Serialize a Promise instead of awaiting async drain',
    path: 'rpc/rpc-server.js',
    from: 'drainAsync: async (cursor, session) => Promise.resolve(options.drain(cursor, session)),',
    to: "drainAsync: options.dir.endsWith('/async') ? undefined : async (cursor, session) => Promise.resolve(options.drain(cursor, session)),\n        drain: options.dir.endsWith('/async') ? (cursor, session) => options.drain(cursor, session) : undefined,",
    expected: 'rpc.async_drain',
  },
  {
    control: 'Remove notification command/payload validator',
    path: 'rpc/rpc-client.js',
    from: 'messages.every(isNotification)',
    to: 'true',
    expected: 'rpc.notification_narrowing',
  },
  {
    control: 'Delete another token port file during stop',
    path: 'common-auth-embedded/rpc/rpc-server.js',
    from: 'if (current?.port === port && current.token === token)',
    to: 'if (current)',
    expected: 'rpc.shutdown_ownership',
  },
  {
    control: 'Disable tracked connection shutdown',
    path: 'common-auth-embedded/rpc/rpc-server.js',
    from: 'server.closeAllConnections?.();',
    to: 'void server;',
    expected: 'rpc.shutdown_ownership',
    additional: [
      [
        'for (const socket of connections)\n                    socket.destroy();',
        'for (const socket of connections)\n                    void socket;',
      ],
    ],
  },
  {
    control: 'Query-qualified Error creates a distinct instance',
    path: 'runtime-owned.mjs',
    from: 'throw new publicRpc.RpcRequestError(409,',
    to: 'throw new foreignRpc.RpcRequestError(409,',
    expected: 'identity.rpc_error',
    additional: [
      [
        "const publicClient = await load('common-auth-embedded/rpc/client.js')",
        "const publicClient = await load('common-auth-embedded/rpc/client.js')\nconst foreignRpc = await import(new URL('common-auth-embedded/rpc/rpc-server.js?identity', pathToFileURL(root + '/')).href)",
      ],
    ],
  },
  {
    control: 'Clone public client factory',
    path: 'common-auth-embedded/rpc/client.js',
    from: "export * from './rpc-client.js';",
    to: "export { DEFAULT_RPC_TIMEOUT_MS } from './rpc-client.js';\nimport { createRpcClient as original } from './rpc-client.js';\nexport function createRpcClient(...args) { return original(...args); }",
    expected: 'identity.client_public_objects',
  },
  {
    control: 'Neutralize reached live apply deadline',
    path: 'rpc/server-short.js',
    from: 'applyDeadlineMs: 150,',
    to: "applyDeadlineMs: options.dir.endsWith('/live504') ? undefined : 150,",
    expected: 'rpc.live_504',
  },
  {
    control: 'Re-reference stopped unresolved apply deadline',
    path: 'common-auth-embedded/rpc/rpc-server.js',
    from: 'timer.unref?.();',
    to: "if (!process.argv[3]?.startsWith('lifetime:')) timer.unref?.();",
    expected: 'rpc.lifetime_after_stop',
  },
  {
    control: 'Suppress an entered callback delayed effect',
    path: 'runtime-owned.mjs',
    from: 'await delay(350)\n          effects++',
    to: 'await delay(350)\n          void effects',
    expected: 'rpc.callback_noncancel',
  },
  {
    control: 'Dead proxy recorder witness',
    path: 'runtime-owned.mjs',
    from: 'recorderCount++',
    to: 'void recorderCount',
    expected: 'rpc.recorder_witness',
  },
  {
    control: 'Redirect direct loopback RPC through configured proxy recorder',
    path: 'common-auth-embedded/rpc/rpc-client.js',
    from: 'port: entry.port',
    to: "port: dir.endsWith('/proxy') ? Number(new URL(process.env.HTTP_PROXY).port) : entry.port",
    expected: 'rpc.no_proxy',
  },
  {
    control: 'Neutralize total client deadline',
    path: 'common-auth-embedded/rpc/rpc-client.js',
    from: 'setTimeout(() => done(null), timeoutMs)',
    to: "setTimeout(() => done(null), dir.includes('/deadline-') ? timeoutMs * 4 : timeoutMs)",
    expected: 'rpc.client_deadline_socket_close',
  },
  {
    control: 'NONZERO idle truncates reached long-lived zero requests',
    path: 'rpc/rpc-server.js',
    from: 'timeoutMs: 0,',
    to: "timeoutMs: 0, ...(options.dir.includes('idle-zero') ? { timeoutMs: 1500 } : {}),",
    expected: 'rpc.timeout_zero',
    matrix: true,
  },
  {
    control: 'Neutralize delivered response body cap',
    path: 'common-auth-embedded/rpc/rpc-client.js',
    from: 'if (bodyBytes > 8 * 1024 * 1024)',
    to: 'if (bodyBytes > 16 * 1024 * 1024)',
    expected: 'rpc.client_deadline_socket_close',
  },
  {
    control: 'Neutralize response header cap',
    path: 'common-auth-embedded/rpc/rpc-client.js',
    from: 'if ((headerBytes ?? prefix.length) > 16 * 1024)',
    to: 'if ((headerBytes ?? prefix.length) > 32 * 1024)',
    expected: 'rpc.client_deadline_socket_close',
  },
  {
    control: 'Remove client completion socket teardown',
    path: 'common-auth-embedded/rpc/rpc-client.js',
    from: 'socket?.destroy();',
    to: 'void socket;',
    expected: 'rpc.client_deadline_socket_close',
  },
]
const runtimes = [
  process.execPath,
  ...(process.env.RPC_MUTATION_EXTRA ?? '').split(':').filter(Boolean),
]
assert(Number.isInteger(start) && start >= 0 && start < controls.length)
if (start > 0) {
  const previous = controls.slice(0, start).map((control) => control.control)
  for (let i = receipts.length - 1; i >= 0; i--)
    if (!previous.includes(receipts[i].control)) receipts.splice(i, 1)
  assert.deepEqual(
    [...new Set(receipts.map((receipt) => receipt.control))],
    previous,
  )
}
for (const control of controls.slice(start)) {
  for (const executable of control.matrix ? runtimes : [process.execPath]) {
    const root = await mkdtemp(join(owned, 'mutation-'))
    await fixture(root)
    await writeFile(
      join(root, 'runtime-owned.mjs'),
      await readFile(
        join(repository, 'test/common-auth-094-adoption/rpc/runtime.mjs'),
      ),
    )
    const path = join(root, control.path)
    const relativePath = relative(repository, path)
    const original = await readFile(path)
    const originalHash = hash(original)
    git('add', '-f', '--', relativePath)
    assert.equal(
      git('diff', '--stat'),
      '',
      'stage intentional implementation files before running mutation proofs',
    )
    let applied, restored
    try {
      let mutant = original.toString()
      for (const [from, to] of [
        [control.from, control.to],
        ...(control.additional ?? []),
      ]) {
        assert(
          mutant.includes(from),
          `unreached mutation seam: ${control.control}`,
        )
        mutant = mutant.replace(from, to)
      }
      await writeFile(
        path,
        `// NON-VACUITY BREAK: ${control.control}\n${mutant}`,
      )
      applied = git('diff', '--stat')
      assert(applied.trim())
      const child = spawnSync(
        executable,
        [join(root, 'runtime-owned.mjs'), root],
        { cwd: repository, encoding: 'utf8', timeout: 45000 },
      )
      assert.equal(child.error, undefined, `${control.control}: ${child.error}`)
      const { result, failures: failed } = validateResult(
        JSON.parse(child.stdout.trim()),
        child.status,
      )
      assert.equal(
        child.status,
        1,
        `${control.control}: expected named red exit1`,
      )
      assert.deepEqual(
        failed.map((row) => row.name),
        [control.expected],
        JSON.stringify(failed),
      )
      receipts.push({
        control: control.control,
        executable,
        runtime: result.runtime,
        bun: result.bun,
        originalHash,
        expected_red: control.expected,
        captured_output: `${control.expected}: ${failed[0].error}`.slice(
          0,
          400,
        ),
        unaffected: result.rows
          .filter((row) => row.ok === true)
          .map((row) => row.name),
        outcome: 'reddened',
        applied,
      })
      console.log(
        `${control.control}: ONLY ${control.expected} red; ${caseNames.length - 1} unaffected (${result.bun ?? result.runtime})`,
      )
    } finally {
      // Restore exact bytes, not checkout/touch or a timestamp manipulation.
      await writeFile(path, original)
      assert.equal(hash(await readFile(path)), originalHash)
      restored = git('diff', '--stat')
      assert.equal(restored, '')
      if (receipts.at(-1)?.control === control.control)
        receipts.at(-1).applied_evidence =
          `${relativePath}: non-empty during mutation: ${applied.trim()}; empty after byte-exact restore: ${JSON.stringify(restored)}`
      git('rm', '--cached', '-f', '--', relativePath)
      await rm(root, { recursive: true, force: true })
      await writeFile(
        join(owned, 'mutation-receipts.receipt'),
        JSON.stringify(receipts, null, 2),
      )
    }
  }
}
await writeFile(
  join(owned, 'mutation-receipts.receipt'),
  JSON.stringify(receipts, null, 2),
)
console.log(
  `${receipts.length} intended-only mutation proofs; byte-exact restoration verified`,
)
