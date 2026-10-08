import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { fixture, hash, repository } from './fixture.mjs'

const baseline = 'e0426393cfda2e03674ec25cfd1b53256ee9944b'
const runtimeHash =
  'e0c90ec15d33363e6b70713d56bc3b2c7585c17f40a0fe0f8fd9305901d4e233'
const publicServerHash =
  'a31758c7d74ded7b781e9b88170fc50c2b3fbd7016413adc92fc6ed039237934'
const input = join(repository, '.cortexkit/parent-inputs/rpc-shutdown-r2')
const owned = join(repository, 'test/common-auth-094-adoption/rpc/.owned')
const observerPath = join(
  repository,
  'test/common-auth-094-adoption/rpc/shutdown-observer.mjs',
)
const runtimePath = 'test/common-auth-094-adoption/rpc/runtime.mjs'

function original(path) {
  const child = spawnSync('git', ['show', `${baseline}:${path}`], {
    cwd: repository,
    encoding: 'buffer',
  })
  assert.equal(child.status, 0)
  return child.stdout
}

const parse = (path, source) => {
  const file = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  )
  assert.equal(file.parseDiagnostics.length, 0, `${path}: syntax diagnostics`)
  return file
}
const printed = (node, file) =>
  ts
    .createPrinter({ removeComments: true })
    .printNode(ts.EmitHint.Unspecified, node, file)

function selection(source) {
  const file = parse(runtimePath, source)
  const calls = []
  let runner, rows
  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'run' &&
      ts.isStringLiteral(node.arguments[0]) &&
      node.arguments[0].text === 'rpc.shutdown_ownership'
    )
      calls.push(node)
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      if (node.name.text === 'run') runner = node.parent.parent
      if (node.name.text === 'rows') rows = node.parent.parent
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  assert.equal(calls.length, 1)
  const call = calls[0]
  assert(ts.isArrowFunction(call.arguments[1]))
  const callback = call.arguments[1]
  const prefixEnd = source.indexOf('// Child liveness is observed')
  assert(prefixEnd > 0)
  const cleanupMatches = []
  function findCleanup(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.getText(file) === 'socket.destroy'
    )
      cleanupMatches.push(node)
    ts.forEachChild(node, findCleanup)
  }
  findCleanup(callback)
  assert.equal(cleanupMatches.length, 1)
  return {
    file,
    callback,
    callbackBytes: source.slice(callback.getStart(file), callback.end),
    callBytes: source.slice(call.getStart(file), call.end),
    prefix: source.slice(0, prefixEnd),
    runnerBytes: source.slice(runner.getStart(file), runner.end),
    rowsBytes: source.slice(rows.getStart(file), rows.end),
    cleanupOffset: cleanupMatches[0].getStart(file) - call.getStart(file),
  }
}

async function validateInputs(executable) {
  assert.equal(
    hash(await readFile(executable)),
    runtimeHash,
    'exact Bun binary hash mismatch',
  )
  const handoff = JSON.parse(
    await readFile(join(input, 'receipt.json'), 'utf8'),
  )
  assert.equal(handoff.regularPayloads, 41)
  let total = 0
  for (const row of handoff.rows) {
    const bytes = await readFile(join(input, row.destination))
    assert.equal(bytes.length, row.bytes, row.destination)
    assert.equal(hash(bytes), row.sha256, row.destination)
    total += bytes.length
  }
  assert.equal(total, handoff.bytes)
  const snapshot = JSON.parse(
    await readFile(join(input, 'rpc-evidence/snapshot.json'), 'utf8'),
  )
  assert.equal(snapshot.candidate, baseline)
  for (const row of snapshot.sourceRows) {
    const frozen = await readFile(join(input, 'rpc-evidence/source', row.path))
    assert.equal(hash(frozen), row.sha256, row.path)
    assert.deepEqual(frozen, original(row.path), row.path)
    assert.deepEqual(
      await readFile(join(repository, row.path)),
      frozen,
      `${row.path}: live source changed`,
    )
  }
  assert.equal(
    hash(
      await readFile(
        join(
          repository,
          'packages/opencode/src/common-auth-embedded/rpc/rpc-server.js',
        ),
      ),
    ),
    publicServerHash,
  )
  return {
    handoffSha256: hash(await readFile(join(input, 'receipt.json'))),
    payloads: handoff.rows.length,
    bytes: total,
    sourceFiles: snapshot.sourceRows.length,
    runtimeSha256: runtimeHash,
    canonicalServerSha256: publicServerHash,
  }
}

async function canonicalRows(root) {
  const manifestPath =
    'packages/opencode/src/common-auth-embedded/source-output.json'
  const manifest = JSON.parse(original(manifestPath).toString())
  const rows = []
  // Enumerate independently from the committed canonical tree, not the clone.
  const paths = spawnSync(
    'git',
    [
      'ls-tree',
      '-r',
      '--name-only',
      baseline,
      'packages/opencode/src/common-auth-embedded',
    ],
    { cwd: repository, encoding: 'utf8' },
  )
  assert.equal(paths.status, 0)
  for (const path of paths.stdout.trim().split('\n')) {
    const tail = relative('packages/opencode/src/common-auth-embedded', path)
    const bytes = original(path)
    assert.deepEqual(await readFile(join(repository, path)), bytes)
    assert.deepEqual(
      await readFile(join(root, 'common-auth-embedded', tail)),
      bytes,
    )
    rows.push({
      path: join('common-auth-embedded', tail),
      sha256: hash(bytes),
      bytes: bytes.length,
    })
  }
  assert(rows.length >= 24)
  return {
    rows,
    manifestSha256: hash(original(manifestPath)),
    manifestIdentity: manifest.identity,
  }
}

async function prepare(executable) {
  const inputs = await validateInputs(executable)
  await mkdir(owned, { recursive: true })
  const root = await mkdtemp(join(owned, 'shutdown-trace-'))
  const compiledInputs = await fixture(root)
  const canonical = await canonicalRows(root)
  const source = original(runtimePath).toString()
  const selected = selection(source)
  let generated =
    selected.prefix +
    '\nimport { observedDeferred, recordResult } from "./shutdown-observer.mjs"\n' +
    'const originalDeferred = deferred\n{\nlet deferredIndex = 0\nconst deferred = () => observedDeferred(originalDeferred, deferredIndex++)\n' +
    selected.rowsBytes +
    '\n' +
    selected.runnerBytes +
    '\nawait '
  const callOffset = generated.length
  generated +=
    selected.callBytes +
    '\nrecordResult(rows[0])\nconsole.log(JSON.stringify({diagnosticOnly:true,acceptance:false,rows}))\n}\n'
  const cleanupLine = generated
    .slice(0, callOffset + selected.cleanupOffset)
    .split('\n').length
  const parsed = selectionForGenerated(generated)
  assert.equal(
    parsed.bytes,
    selected.callbackBytes,
    'selected callback bytes changed',
  )
  assert.equal(
    printed(parsed.callback, parsed.file),
    printed(selected.callback, selected.file),
    'selected callback AST changed',
  )
  await writeFile(join(root, 'shutdown-case.mjs'), generated)
  await cp(observerPath, join(root, 'shutdown-observer.mjs'))
  await writeFile(
    join(root, 'shutdown-entry.mjs'),
    "import './shutdown-observer.mjs'\nawait import('./shutdown-case.mjs')\n",
  )
  await writeFile(
    join(root, 'observer-config.receipt'),
    JSON.stringify({ baseline, cleanupLine }, null, 2),
  )
  const generatedPaths = [
    'shutdown-case.mjs',
    'shutdown-observer.mjs',
    'shutdown-entry.mjs',
    'observer-config.receipt',
    'rpc/rpc-server.js',
    'rpc/rpc-client.js',
    'rpc/port-file.js',
  ]
  const generatedRows = []
  for (const path of generatedPaths) {
    const bytes = await readFile(join(root, path))
    if (path.endsWith('.mjs') || path.endsWith('.js'))
      parse(path, bytes.toString())
    generatedRows.push({ path, sha256: hash(bytes), bytes: bytes.length })
  }
  const preparation = {
    diagnosticOnly: true,
    acceptance: false,
    baseline,
    executable: resolve(executable),
    root,
    inputs,
    compiledInputs,
    canonical,
    generatedRows,
    callbackSha256: hash(selected.callbackBytes),
    callbackBytes: Buffer.byteLength(selected.callbackBytes),
    originalRuntimeSha256: hash(source),
    cleanupLine,
    originalLimitsMs: [500, 1000, 15000],
    selection: ['rpc.shutdown_ownership'],
    sourceCoverageLimit:
      'The supplied tag files do not contain JS node:http Server.close/closeAllConnections or connection/request event implementation. Builtin method text will be observed in the one pinned process only.',
  }
  await writeFile(
    join(root, 'preparation.receipt'),
    JSON.stringify(preparation, null, 2),
  )
  console.log(
    JSON.stringify({
      prepared: root,
      ...inputs,
      callbackSha256: preparation.callbackSha256,
      callbackByteAndAstEqual: true,
      canonicalFilesByteEqual: canonical.rows.length,
      originalLimitsMs: preparation.originalLimitsMs,
    }),
  )
}

function selectionForGenerated(source) {
  const file = parse('shutdown-case.mjs', source)
  const matches = []
  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'run' &&
      ts.isStringLiteral(node.arguments[0]) &&
      node.arguments[0].text === 'rpc.shutdown_ownership'
    )
      matches.push(node.arguments[1])
    ts.forEachChild(node, visit)
  }
  visit(file)
  assert.equal(matches.length, 1)
  return {
    file,
    callback: matches[0],
    bytes: source.slice(matches[0].getStart(file), matches[0].end),
  }
}

async function run(root) {
  assert(
    resolve(root).startsWith(`${owned}/shutdown-trace-`),
    'run only an owned prepared diagnostic',
  )
  const preparation = JSON.parse(
    await readFile(join(root, 'preparation.receipt'), 'utf8'),
  )
  await validateInputs(preparation.executable)
  await canonicalRows(root)
  for (const row of preparation.generatedRows)
    assert.equal(
      hash(await readFile(join(root, row.path))),
      row.sha256,
      row.path,
    )
  const callback = selectionForGenerated(
    await readFile(join(root, 'shutdown-case.mjs'), 'utf8'),
  )
  assert.equal(hash(callback.bytes), preparation.callbackSha256)
  assert.equal(
    callback.bytes,
    selection(original(runtimePath).toString()).callbackBytes,
  )
  // Exclusive acquisition happens before execution; this directory cannot run twice.
  await writeFile(
    join(root, 'sole-invocation.receipt'),
    JSON.stringify({
      baseline,
      executable: preparation.executable,
      sha256: runtimeHash,
      argv: [join(root, 'shutdown-entry.mjs'), root],
      cwd: repository,
    }),
    { flag: 'wx' },
  )
  const child = spawnSync(
    preparation.executable,
    [join(root, 'shutdown-entry.mjs'), root],
    {
      cwd: repository,
      encoding: 'utf8',
      timeout: 20000,
      maxBuffer: 2 * 1024 * 1024,
    },
  )
  await writeFile(join(root, 'stdout.receipt'), child.stdout ?? '')
  await writeFile(join(root, 'stderr.receipt'), child.stderr ?? '')
  await writeFile(
    join(root, 'execution.receipt'),
    JSON.stringify(
      {
        diagnosticOnly: true,
        acceptance: false,
        exit: child.status,
        signal: child.signal,
        error: child.error ? String(child.error) : null,
      },
      null,
      2,
    ),
  )
  assert.equal(hash(await readFile(preparation.executable)), runtimeHash)
  await validateInputs(preparation.executable)
  await canonicalRows(root)
  console.log(
    JSON.stringify({
      diagnosticOnly: true,
      acceptance: false,
      root,
      exit: child.status,
      signal: child.signal,
      executionError: child.error ? String(child.error) : null,
      traceWritten: (() => {
        try {
          return readFileSync(join(root, 'shutdown-trace.receipt')).length
        } catch {
          return 0
        }
      })(),
    }),
  )
}

const [mode, path, ...extra] = process.argv.slice(2)
assert.equal(extra.length, 0)
if (mode === '--prepare') await prepare(path)
else if (mode === '--run') await run(resolve(path))
else
  throw new Error(
    'Use --prepare <verified Bun1.3.14 executable> or --run <owned prepared directory>',
  )
