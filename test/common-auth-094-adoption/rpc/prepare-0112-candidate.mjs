import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  stat,
  writeFile,
} from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { hash, repository } from './fixture.mjs'

// Create four isolated RPC test fixtures and record verified inputs/commands.
// Do not run/import the candidate, install dependencies, alter the embedded
// producer, or offer execution from this preparation-only script.
const packet = join(
  repository,
  '.cortexkit/parent-inputs/rpc-0112-stop-order-prep-r1',
)
const packetHash =
  'dfa2b5c0489adc9cfca1e5ea70a884dfaf4b387a49940ad0c3e3aff803d1ad42'
const archiveHash =
  '19331d5b8935d3309e769dec04591d5649dbc3cdafe47f1a0c0b7f12ae393146'
const baseline = 'e0426393cfda2e03674ec25cfd1b53256ee9944b'
const owned = join(repository, 'test/common-auth-094-adoption/rpc/.owned')
const acceptedPacket = join(
  repository,
  '.cortexkit/parent-inputs/rpc-0112-accepted-matrix-r1',
)
const acceptedPacketHash =
  'af4c2f874fc8c3a9f086b4f48d4eefe5c21c4f05ce624f47acb56107306f64e3'

const fromGit = (path) => {
  const child = spawnSync('git', ['show', `${baseline}:${path}`], {
    cwd: repository,
    encoding: 'buffer',
  })
  assert.equal(child.status, 0)
  return child.stdout
}
const parse = (path, bytes) => {
  const source = ts.createSourceFile(
    path,
    bytes.toString(),
    ts.ScriptTarget.Latest,
    true,
    path.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS,
  )
  assert.equal(source.parseDiagnostics.length, 0, `${path}: parse failure`)
  return source
}
const normalized = (path, bytes) =>
  ts.createPrinter({ removeComments: true }).printFile(parse(path, bytes))
const safePath = (path) => {
  assert(
    typeof path === 'string' &&
      path.length > 0 &&
      !isAbsolute(path) &&
      !path.split('/').includes('..'),
    path,
  )
  return path
}
async function fileNames(root, prefix = '') {
  const result = []
  for (const entry of await readdir(join(root, prefix), {
    withFileTypes: true,
  })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) result.push(...(await fileNames(root, path)))
    else {
      assert(entry.isFile(), `${path}: require regular payload`)
      result.push(path)
    }
  }
  return result.sort()
}

async function admitPacket() {
  const inventoryBytes = await readFile(join(packet, 'packet-final.json'))
  assert.equal(
    hash(inventoryBytes),
    packetHash,
    'out-of-band packet digest mismatch',
  )
  const inventory = JSON.parse(inventoryBytes)
  const rows = inventory.files
  assert.equal(rows.length, 191)
  assert.equal(new Set(rows.map((row) => row.path)).size, 191)
  let bytes = 0
  for (const row of rows) {
    const payload = await readFile(join(packet, safePath(row.path)))
    assert.equal(payload.length, row.bytes, row.path)
    assert.equal(hash(payload), row.sha256, row.path)
    bytes += payload.length
  }
  assert.equal(bytes, 1146442)
  // Verify the externally expected archive checksum before trusting the
  // separately copied/extracted file inventory.
  assert.equal(
    hash(await readFile(join(packet, 'candidate/archive.tgz'))),
    archiveHash,
  )
  const admission = JSON.parse(
    await readFile(join(packet, 'candidate/admission.json'), 'utf8'),
  )
  assert.equal(admission.sha256, archiveHash)
  assert.equal(admission.version, '0.11.2')
  assert.equal(admission.regularFiles, 175)
  const names = await fileNames(join(packet, 'candidate/package'))
  assert.deepEqual(names, admission.files.map((row) => row.path).sort())
  let packageBytes = 0
  for (const row of admission.files) {
    const payload = await readFile(
      join(packet, 'candidate/package', safePath(row.path)),
    )
    assert.equal(hash(payload), row.sha256, row.path)
    assert.equal(payload.length, row.bytes, row.path)
    packageBytes += payload.length
  }
  assert.equal(packageBytes, admission.bytes)
  return { inventory, admission, bytes, packageBytes }
}

function importPaths(source) {
  const paths = []
  function visit(node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier
    ) {
      assert(ts.isStringLiteral(node.moduleSpecifier))
      paths.push(node.moduleSpecifier.text)
    }
    if (ts.isImportTypeNode(node)) {
      assert(
        ts.isLiteralTypeNode(node.argument) &&
          ts.isStringLiteral(node.argument.literal),
      )
      paths.push(node.argument.literal.text)
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      assert.equal(node.arguments.length, 1)
      assert(ts.isStringLiteral(node.arguments[0]))
      paths.push(node.arguments[0].text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return paths
}

async function publicClosure(manifest, declarations) {
  const packageRoot = join(packet, 'candidate/package')
  const allowed = new Set()
  const builtins = new Set()
  const roots = ['./rpc', './rpc/client'].map((key) => {
    const target = manifest.exports[key][declarations ? 'types' : 'import']
    assert(target.startsWith('./dist/rpc/'), `${key}: unexpected public target`)
    return { export: key, target: target.slice(2) }
  })
  async function visit(path) {
    if (allowed.has(path)) return
    safePath(path)
    assert(
      path.startsWith('dist/rpc/'),
      `${path}: refuse non-RPC package reachability`,
    )
    allowed.add(path)
    const bytes = await readFile(join(packageRoot, path))
    for (const dependency of importPaths(parse(path, bytes))) {
      if (dependency.startsWith('node:')) {
        builtins.add(dependency)
        continue
      }
      assert(
        dependency.startsWith('.'),
        `${path}: refuse nonbuiltin bare/dynamic dependency ${dependency}`,
      )
      let resolved = relative(
        packageRoot,
        resolve(packageRoot, path, '..', dependency),
      ).replaceAll('\\', '/')
      if (declarations && resolved.endsWith('.js'))
        resolved = `${resolved.slice(0, -3)}.d.ts`
      await visit(resolved)
    }
  }
  for (const root of roots) await visit(root.target)
  return { roots, files: [...allowed].sort(), builtins: [...builtins].sort() }
}

function callbackRows(path, bytes) {
  const source = parse(path, bytes)
  const rows = []
  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'run' &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      const callback = node.arguments[1]
      assert(ts.isArrowFunction(callback))
      const text = bytes
        .toString()
        .slice(callback.getStart(source), callback.end)
      rows.push({
        name: node.arguments[0].text,
        sha256: hash(text),
        bytes: Buffer.byteLength(text),
      })
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  assert.equal(rows.length, 17)
  assert.equal(new Set(rows.map((row) => row.name)).size, 17)
  return rows
}

const admitted = await admitPacket()
const acceptedInventoryBytes = await readFile(
  join(acceptedPacket, 'copy-manifest.json'),
)
assert.equal(
  hash(acceptedInventoryBytes),
  acceptedPacketHash,
  'accepted-result out-of-band digest mismatch',
)
const acceptedInventory = JSON.parse(acceptedInventoryBytes)
assert.equal(acceptedInventory.files.length, 31)
assert.equal(new Set(acceptedInventory.files.map((row) => row.path)).size, 31)
let acceptedBytes = 0
for (const row of acceptedInventory.files) {
  const bytes = await readFile(join(acceptedPacket, safePath(row.path)))
  assert.equal(bytes.length, row.bytes, row.path)
  assert.equal(hash(bytes), row.sha256, row.path)
  acceptedBytes += bytes.length
}
assert.equal(acceptedBytes, 85122)
const acceptedResult = JSON.parse(
  await readFile(join(acceptedPacket, 'FINAL-ACCEPTANCE.json'), 'utf8'),
)
assert.equal(acceptedResult.candidateArchiveSha256, archiveHash)
assert.equal(acceptedResult.positiveContractsPassed, 68)
assert.equal(acceptedResult.positiveFailures, 0)
assert.equal(acceptedResult.rpcTechnicalAcceptance, true)
const manifest = JSON.parse(
  await readFile(join(packet, 'candidate/package/package.json'), 'utf8'),
)
assert.equal(manifest.name, '@cortexkit/common-auth')
assert.equal(manifest.version, '0.11.2')
const runtimeClosure = await publicClosure(manifest, false)
const typeClosure = await publicClosure(manifest, true)
const delta = JSON.parse(
  await readFile(join(packet, 'candidate/delta.json'), 'utf8'),
)
assert.equal(delta.comparedFiles, 175)
assert.equal(delta.byteIdenticalFiles, 174)
assert.deepEqual(delta.changed, ['dist/rpc/rpc-server.js'])
assert.equal(
  delta.oldSha256,
  '99323ae4f4ab402d4579c59b32f6f73e8f4561a343887f5cf5f3d7a04369f2b9',
)
assert.equal(delta.newSha256, archiveHash)

const runtimeRecord = JSON.parse(
  await readFile(join(packet, 'runtimes/runtime-admission-final.json'), 'utf8'),
)
const expected = [
  ['node20', 'v20.0.0'],
  ['node24', 'v24.16.0'],
  ['bun1314', '1.3.14'],
  ['bun142', '1.4.2'],
]
assert.deepEqual(
  runtimeRecord.runtimes.map((runtime) => [runtime.role, runtime.version]),
  expected,
)
const runtimes = []
for (const runtime of runtimeRecord.runtimes) {
  const executable = runtime.currentExecutable.path
  const info = await stat(executable)
  assert(info.isFile(), `${runtime.role}: missing regular executable`)
  assert(info.mode & 0o111, `${runtime.role}: executable mode missing`)
  const bytes = await readFile(executable)
  assert.equal(
    hash(bytes),
    runtime.sha256,
    `${runtime.role}: independent expected hash mismatch`,
  )
  assert.equal(hash(bytes), runtime.currentExecutable.sha256)
  runtimes.push({
    role: runtime.role,
    version: runtime.version,
    executable,
    sha256: runtime.sha256,
    bytes: bytes.length,
    authority: runtime.authority,
    versionInvocationPerformed: false,
  })
}

await mkdir(owned, { recursive: true })
const root = await mkdtemp(join(owned, 'candidate-0112-corrected-prep-'))
const immutable = []
async function put(path, bytes) {
  await mkdir(join(root, path, '..'), { recursive: true })
  await writeFile(join(root, path), bytes)
  immutable.push({ path, bytes: Buffer.byteLength(bytes), sha256: hash(bytes) })
}

// Keep adapter imports of ../common-auth-embedded/rpc/index.js and
// ../common-auth-embedded/rpc/client.js.
// The temporary layout changes only which package supplies those implementation
// bytes, so namespace reads and adapter imports still use the same module URLs.
const closureFiles = [
  ...new Set([...runtimeClosure.files, ...typeClosure.files]),
].sort()
const moduleBindings = []
for (const path of closureFiles) {
  const bytes = await readFile(join(packet, 'candidate/package', path))
  const target = `common-auth-embedded/${path.slice('dist/'.length)}`
  await put(target, bytes)
  moduleBindings.push({
    packagePath: path,
    syntheticPath: target,
    sha256: hash(bytes),
  })
}
await put(
  'public-package.json',
  await readFile(join(packet, 'candidate/package/package.json')),
)
await put(
  'LICENSE.candidate',
  await readFile(join(packet, 'candidate/package/LICENSE')),
)
await put('package.json', '{"type":"module","private":true}\n')

const adapters = []
for (const name of ['rpc-server', 'rpc-client', 'port-file']) {
  const path = `packages/opencode/src/rpc/${name}.ts`
  const source = fromGit(path)
  assert.deepEqual(
    await readFile(join(repository, path)),
    source,
    `${path}: production source drift`,
  )
  const output = ts.transpileModule(source.toString(), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
    },
  }).outputText
  await put(`rpc/${name}.js`, output)
  adapters.push({
    path,
    sourceSha256: hash(source),
    compiledSha256: hash(output),
    importSpecifierChanged: false,
  })
  if (name === 'rpc-server') {
    assert(
      output.includes('timeoutMs: 0') &&
        output.includes('applyDeadlineMs: 120_000'),
    )
    await put(
      'rpc/server-nonzero.js',
      output.replace('timeoutMs: 0', 'timeoutMs: 1500'),
    )
    await put(
      'rpc/server-short.js',
      output.replace('applyDeadlineMs: 120_000', 'applyDeadlineMs: 150'),
    )
  }
}
const canonicalRuntime = fromGit(
  'test/common-auth-094-adoption/rpc/runtime.mjs',
)
assert.deepEqual(
  await readFile(
    join(repository, 'test/common-auth-094-adoption/rpc/runtime.mjs'),
  ),
  canonicalRuntime,
)
await put('runtime.mjs', canonicalRuntime)
const contracts = callbackRows('runtime.mjs', canonicalRuntime)
assert.equal(
  normalized('runtime.mjs', await readFile(join(root, 'runtime.mjs'))),
  normalized('runtime.mjs', canonicalRuntime),
)

const environments = []
const sandbox = '/usr/bin/sandbox-exec'
assert(
  (await stat(sandbox)).isFile(),
  'required loopback sandbox unavailable; no unsandboxed fallback',
)
for (const runtime of runtimes) {
  // Failed publication leaves port-<pid>.json as a directory in the test state.
  // Each runtime gets fresh immutable inputs and a new, initially absent state
  // directory so that leftover cannot contaminate another runtime's run.
  const roleRoot = join(root, 'isolated-runtimes', runtime.role)
  const roleFiles = []
  for (const row of immutable) {
    const bytes = await readFile(join(root, row.path))
    assert.equal(hash(bytes), row.sha256)
    await mkdir(join(roleRoot, row.path, '..'), { recursive: true })
    await writeFile(join(roleRoot, row.path), bytes)
    roleFiles.push({ ...row })
  }
  const layout = join(roleRoot, 'environment', runtime.role)
  for (const dir of ['home', 'config', 'cache', 'data', 'state', 'tmp'])
    await mkdir(join(layout, dir), { recursive: true })
  const env = {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: join(layout, 'home'),
    USERPROFILE: join(layout, 'home'),
    XDG_CONFIG_HOME: join(layout, 'config'),
    XDG_CACHE_HOME: join(layout, 'cache'),
    XDG_DATA_HOME: join(layout, 'data'),
    XDG_STATE_HOME: join(layout, 'state'),
    TMPDIR: `${join(layout, 'tmp')}/`,
    TMP: join(layout, 'tmp'),
    TEMP: join(layout, 'tmp'),
    APPDATA: join(layout, 'config'),
    LOCALAPPDATA: join(layout, 'cache'),
    LC_ALL: 'C',
    NO_COLOR: '1',
  }
  for (const key of [
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'http_proxy',
    'https_proxy',
    'all_proxy',
  ])
    env[key] = 'http://127.0.0.1:9'
  // HTTP_PROXY/http_proxy can route Bun's node:http helper through a proxy at
  // startup; NO_PROXY/no_proxy exclude loopback for that helper. rpc.no_proxy
  // clears NO_PROXY and no_proxy, using a live recorder to test the raw client.
  env.NO_PROXY = '127.0.0.1'
  env.no_proxy = '127.0.0.1'
  const quote = (value) => JSON.stringify(value)
  // Retained policy controls establish deny-network except localhost TCP and
  // deny-writes except the disposable role directory and /dev/null. This script
  // only records those rules, changing the private directory path per role.
  const profile = `(version 1)(allow default)(deny network*)(allow network-outbound (remote tcp "localhost:*"))(allow network-inbound (local tcp "localhost:*"))(deny file-write*)(allow file-write* (subpath ${quote(roleRoot)}) (literal "/dev/null"))`
  await writeFile(join(roleRoot, 'loopback.sb'), profile)
  roleFiles.push({
    path: 'loopback.sb',
    bytes: Buffer.byteLength(profile),
    sha256: hash(profile),
  })
  assert.deepEqual(
    await readFile(join(roleRoot, 'runtime.mjs')),
    canonicalRuntime,
  )
  assert.equal(roleFiles.length, 24)
  environments.push({
    role: runtime.role,
    root: roleRoot,
    immutableFiles: roleFiles,
    env,
    argv: [
      sandbox,
      '-p',
      profile,
      runtime.executable,
      join(roleRoot, 'runtime.mjs'),
      roleRoot,
    ],
    executableVersionAdmissionArgv: [runtime.executable, '--version'],
    expectedVersion: runtime.version,
    totalChildBudgetMs: 60000,
    originalCaseGuardMs: 15000,
    originalStopGuardMs: 1000,
    originalPeerCloseGuardMs: 500,
  })
}

const candidateServer = await readFile(
  join(root, 'common-auth-embedded/rpc/rpc-server.js'),
)
const ordered =
  'server.closeAllConnections?.();\n                server.close(() => resolve());'
assert.equal(
  candidateServer.toString().split(ordered).length - 1,
  1,
  'exact candidate stop-order site required',
)
const reversed = candidateServer
  .toString()
  .replace(
    ordered,
    'server.close(() => resolve());\n                server.closeAllConnections?.();',
  )
const candidateAst = parse('rpc-server.js', candidateServer)
const reversedAst = parse('rpc-server.js', reversed)
assert.equal(candidateAst.parseDiagnostics.length, 0)
assert.equal(reversedAst.parseDiagnostics.length, 0)
// Only record the proposed close()/closeAllConnections() order reversal;
// preparation never writes or imports an altered server file.
const mutationPlan = {
  runtimeRole: 'bun1314',
  target: 'common-auth-embedded/rpc/rpc-server.js',
  admittedOriginalSha256: hash(candidateServer),
  plannedOrderOnlySha256: hash(reversed),
  marker: 'NON-VACUITY BREAK',
  expectedOnlyRed: 'rpc.shutdown_ownership',
  otherSixteenContractsMustPass: true,
  bun142RedExpectation: false,
  apply:
    'After positive four-runtime admission, use a separate owned copy; stage its admitted target, confirm empty unstaged diff, save original bytes/hash, apply only the two-call reversal plus marker, capture nonempty diffstat.',
  restore:
    'In finally, restore saved bytes without checkout/touch/stash; recheck the independent admission hash and empty unstaged diff, remove only the disposable index entry. Rerun no control without approval.',
  noRuntimeOrMutationExecution: true,
  acceptedParentControlAlreadyPerformed: true,
  repeatControlAuthorized: false,
}

const preparation = {
  candidateOnly: true,
  acceptance: false,
  executionAuthorized: false,
  committed: false,
  baseline,
  preservedDiagnosticCommit: '1d85fda63ba6faadaf9e797ec30acf016b428a27',
  packetSha256: packetHash,
  payloads: admitted.inventory.files.length,
  packetBytes: admitted.bytes,
  archiveSha256: archiveHash,
  admittedPackagePayloads: admitted.admission.regularFiles,
  admittedPackageBytes: admitted.packageBytes,
  authority: admitted.admission.sourceAssociation,
  deltaComparedToSupersededPrivate0112: delta,
  notProduction094Parity: true,
  root,
  runtimeClosure,
  typeClosure,
  moduleBindings,
  adapters,
  canonicalRuntimeByteEqual: true,
  canonicalRuntimeSha256: hash(canonicalRuntime),
  contracts,
  runtimeInputs: runtimes,
  environmentAndArgv: environments,
  sandboxProfileSyntaxExecutedByThisWorker: false,
  sandboxProfileGrammarMeasuredByParent: true,
  freshStateRootPerRuntime: true,
  startupLoopbackExclusionsOnly: true,
  parentTechnicalAcceptance: {
    manifestSha256: acceptedPacketHash,
    finalResultSha256: hash(
      await readFile(join(acceptedPacket, 'FINAL-ACCEPTANCE.json')),
    ),
    positiveContractsPassed: acceptedResult.positiveContractsPassed,
    positiveFailures: acceptedResult.positiveFailures,
    orderOnlyControl: acceptedResult.orderOnlyControl,
    noWorkerReplay: true,
    notProductionPinAcceptance: true,
  },
  immutableFiles: immutable,
  mutationPlan,
  held: 'No candidate import/evaluation, version invocation, matrix/control replay, acquisition, pin bump, commit, integration, publication or full RPC acceptance.',
}
await writeFile(
  join(root, 'preparation.receipt'),
  JSON.stringify(preparation, null, 2),
)
console.log(
  JSON.stringify({
    root,
    packetSha256: packetHash,
    verifiedPayloads: admitted.inventory.files.length,
    bytes: admitted.bytes,
    candidatePackagePayloads: admitted.admission.regularFiles,
    publicRuntimeClosure: runtimeClosure,
    publicTypeClosure: typeClosure,
    exactContractCallbacks: contracts.length,
    runtimeHashesVerified: runtimes.map(({ role, sha256 }) => ({
      role,
      sha256,
    })),
    executionPerformed: false,
    preparationReceipt: join(root, 'preparation.receipt'),
  }),
)
