import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertPrivateTokenDacl,
  readTokenDacl,
  redactDacl,
} from '../windows-vault/dacl.mjs'
import { redactFailureText } from '../windows-vault/failure.mjs'
import {
  cliEnvironment,
  runSetupWithEnvironment,
  verifyWithReceipt,
} from './harness.mjs'

if (process.platform !== 'win32') {
  console.error(
    'Native Windows Pi preflight proof not run: Windows is required.',
  )
  process.exit(77)
}
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
let root
const evidence = resolve(
  process.argv[2] ??
    join(
      repository,
      '.cortexkit/internal-docs/investigations/common-auth-0170/native-windows-pi.json',
    ),
)
const previous = { ...process.env }
const fixtureSecrets = [
  'synthetic-native-proof-refresh',
  'synthetic-native-proof-access',
  'synthetic-extension-decoy',
  'synthetic-foreign-login',
  'synthetic-foreign-access',
  'ab'.repeat(32),
]
const warnings = []
const onWarning = (warning) => {
  if (warning.name === 'PrivateFileMigration') {
    warnings.push(warning)
    console.error(warning.stack ?? `${warning.name}: ${warning.message}`)
  }
}
const result = {
  platform: process.platform,
  runtime: process.version,
  checks: [],
  source: {},
}
async function verify(stage) {
  stage('warning-policy')
  assert.notEqual(
    process.env.NODE_NO_WARNINGS,
    '1',
    'Migration warnings must remain visible',
  )
  assert.ok(
    !process.execArgv.includes('--no-warnings'),
    'Migration warnings must remain visible',
  )
  assert.ok(
    !/--(?:no-warnings|disable-warning)/.test(process.env.NODE_OPTIONS ?? ''),
    'Migration warnings must remain visible',
  )
  stage('isolated-profile')
  root = await mkdtemp(join(await realpath(homedir()), '.agy-pi-preflight-'))
  const nativeDir = join(root, 'pi-native')
  const extensionDir = join(root, 'pi-extension')
  const authPath = join(nativeDir, 'auth.json')
  const decoyAuthPath = join(extensionDir, 'auth.json')
  const stashPath = join(
    root,
    'pi-extension',
    'antigravity-auth-vault',
    'google-login-stash.json',
  )
  const env = {
    ...process.env,
    HOME: root,
    USERPROFILE: root,
    APPDATA: join(root, 'appdata'),
    LOCALAPPDATA: join(root, 'localappdata'),
    TEMP: join(root, 'temp'),
    TMP: join(root, 'temp'),
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'data'),
    XDG_STATE_HOME: join(root, 'state'),
    XDG_CACHE_HOME: join(root, 'cache'),
    OPENCODE_CONFIG_DIR: join(root, 'config', 'opencode'),
    OPENCODE_DB: join(root, 'isolated.db'),
    PI_AGENT_DIR: extensionDir,
    PI_CODING_AGENT_DIR: nativeDir,
    PI_ANTIGRAVITY_AUTH_FILE: join(extensionDir, 'antigravity-accounts.json'),
    SUBC_CONNECTION_FILE: join(root, 'absent-connection.json'),
    CLAUSTRUM_SUBC_CONNECTION: join(root, 'absent-connection.json'),
  }
  const inheritedHostConfig = [
    'OPENCODE_CONFIG',
    'OPENCODE_CONFIG_CONTENT',
    'OPENCODE_AUTH_CONTENT',
  ]
  for (const key of inheritedHostConfig) delete env[key]
  async function snapshotFiles(path = root, prefix = '') {
    const files = {}
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory())
        Object.assign(files, await snapshotFiles(join(path, entry.name), name))
      else
        files[name] = (await readFile(join(path, entry.name))).toString(
          'base64',
        )
    }
    return files
  }
  function weakenFile(path) {
    const child = spawnSync(
      'pwsh',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `
    $ErrorActionPreference = 'Stop'
    $acl = Get-Acl -LiteralPath $env:AGY_PI_ACL_FILE
    $sid = [System.Security.Principal.SecurityIdentifier]::new('S-1-1-0')
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, [System.Security.AccessControl.FileSystemRights]::Read, [System.Security.AccessControl.AccessControlType]::Allow)
    $acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $env:AGY_PI_ACL_FILE -AclObject $acl
  `,
      ],
      {
        env: { ...env, AGY_PI_ACL_FILE: path },
        encoding: 'utf8',
        timeout: 30000,
      },
    )
    assert.equal(child.error, undefined)
    assert.equal(child.status, 0, child.stderr)
  }
  await mkdir(env.TEMP, { recursive: true })
  for (const key of inheritedHostConfig) delete process.env[key]
  Object.assign(process.env, env)
  stage('source-and-archive-hashes')
  for (const path of [
    'packages/opencode/src/setup.ts',
    'packages/opencode/src/cli.ts',
    'test/windows-pi-preflight/product-entry.mjs',
    'packages/core/src/common-auth-embedded/pi-slot/slot.js',
    'packages/core/src/common-auth-embedded/fs/private-files.js',
    'packages/core/src/common-auth-embedded/claustrum/enrollment.js',
    'packages/opencode/src/common-auth-embedded/setup/types.d.ts',
  ]) {
    result.source[path] = createHash('sha256')
      .update(await readFile(join(repository, path)))
      .digest('hex')
  }
  const expectedArchive =
    '495996247a4d2a6dea8388998d0a09c01a9d49346aac7cb983f11955490c72dd'
  for (const receiptPath of [
    'packages/core/dist/common-auth-embedded/source-output.json',
    'packages/opencode/dist/src/common-auth-embedded/source-output.json',
  ]) {
    const receipt = JSON.parse(
      await readFile(join(repository, receiptPath), 'utf8'),
    )
    assert.equal(
      receipt.tarballSha256,
      expectedArchive,
      'Native proof must use the qualified built archive',
    )
  }
  result.archiveSha256 = expectedArchive
  const oracle = JSON.parse(
    await readFile(
      join(repository, 'test/common-auth-0170-producer/candidate.json'),
      'utf8',
    ),
  )
  assert.equal(oracle.sha256, expectedArchive)
  result.runtimeFiles = {}
  for (const path of [
    'packages/opencode/dist/windows-pi-preflight-product.mjs',
    'packages/opencode/dist/windows-pi-preflight-product.mjs.map',
    'packages/opencode/dist/cli.js',
  ]) {
    result.runtimeFiles[path] = createHash('sha256')
      .update(await readFile(join(repository, path)))
      .digest('hex')
  }
  // Check canonical emitted payloads separately from the bundled adapter runtime.
  result.archiveFiles = {}
  for (const [path, canonical] of [
    [
      'packages/opencode/dist/src/common-auth-embedded/setup/command.js',
      'setup/command.js',
    ],
    [
      'packages/opencode/dist/src/common-auth-embedded/setup/process-fence.js',
      'setup/process-fence.js',
    ],
    [
      'packages/core/dist/common-auth-embedded/pi-slot/slot.js',
      'pi-slot/slot.js',
    ],
    [
      'packages/core/dist/common-auth-embedded/claustrum/enrollment.js',
      'claustrum/enrollment.js',
    ],
    [
      'packages/core/dist/common-auth-embedded/fs/private-files.js',
      'fs/private-files.js',
    ],
  ]) {
    const bytes = await readFile(join(repository, path))
    const hash = createHash('sha256').update(bytes).digest('hex')
    result.archiveFiles[path] = hash
    const expected = oracle.files.find(([name]) => name === canonical)
    assert.ok(expected, `Missing independent archive pin: ${canonical}`)
    assert.equal(bytes.length, expected[1], `Wrong built payload size: ${path}`)
    assert.equal(hash, expected[2], `Wrong built payload bytes: ${path}`)
  }
  stage('product-runtime')
  const { loadCommonAuthFs, loadCommonAuthPiSlot, loadCommonAuthClaustrum } =
    await import('../../packages/core/dist/index.js')
  const {
    assertSetupHostsStopped,
    createSetupPlugin,
    createDefaultCliDependencies,
  } = await import(
    '../../packages/opencode/dist/windows-pi-preflight-product.mjs'
  )
  const fs = await loadCommonAuthFs()
  const { openPiSlot } = await loadCommonAuthPiSlot()
  stage('pi-fixtures')
  await assertSetupHostsStopped()
  await fs.writeJsonAtomic(authPath, {
    google: {
      type: 'oauth',
      refresh: 'synthetic-native-proof-refresh',
      access: 'synthetic-native-proof-access',
      expires: 1,
    },
  })
  const deps = createDefaultCliDependencies()
  deps.performLogin = async () => {
    throw new Error('This proof must not start OAuth')
  }
  const plugin = await createSetupPlugin(deps, async () => 0)
  await fs.writeJsonAtomic(decoyAuthPath, {
    google: {
      type: 'oauth',
      refresh: 'synthetic-extension-decoy',
      access: '',
      expires: 0,
    },
  })
  const decoyBytes = await readFile(decoyAuthPath)
  const decoyDacl = readTokenDacl(decoyAuthPath)
  const decoyParentDacl = readTokenDacl(extensionDir)
  const slot = openPiSlot({
    authPath,
    stashPath,
    provider: 'google',
    placeholderKey: 'antigravity-vault-custody',
  })
  // Use Pi's public slot API to stash the synthetic Google login;
  // no OAuth or vault enrollment request is made.
  await slot.enterVault()
  const paths = [authPath, stashPath]
  const bytes = await Promise.all(paths.map((path) => readFile(path)))
  const original = paths.map(readTokenDacl)
  for (const descriptor of original) assertPrivateTokenDacl(descriptor)
  const parent = readTokenDacl(dirname(authPath))
  stage('weak-dacl-controls')
  paths.forEach(weakenFile)
  const weak = paths.map(readTokenDacl)
  for (const descriptor of weak) {
    assert.equal(
      descriptor.aces.length,
      2,
      'Weak ACL control must add exactly one ACE',
    )
    assert.ok(
      descriptor.aces.some((ace) => ace.sid === 'S-1-1-0'),
      'Weak ACL control did not reach the file',
    )
    assert.throws(() => assertPrivateTokenDacl(descriptor))
  }
  stage('cli-dry-run')
  const bin = join(root, 'bin')
  await mkdir(bin)
  await mkdir(env.OPENCODE_CONFIG_DIR, { recursive: true })
  await writeFile(join(bin, 'opencode.cmd'), '@echo off\r\necho 1.0.0\r\n')
  await writeFile(join(bin, 'pi.cmd'), '@echo off\r\necho 1.0.0\r\n')
  await writeFile(join(bin, 'ck.cmd'), '@echo off\r\necho 1.0.0\r\n')
  const pathEntries = (environment) =>
    Object.entries(environment)
      .filter(([key]) => key.toLowerCase() === 'path')
      .sort(([left], [right]) => left.localeCompare(right))
  const inheritedPathKeys = Object.keys(env)
    .filter((key) => key.toLowerCase() === 'path')
    .sort()
  result.executableSearchPath = { inheritedKeySpellings: inheritedPathKeys }
  const cliEnv = cliEnvironment(env, bin)
  const childPathKeys = Object.keys(cliEnv).filter(
    (key) => key.toLowerCase() === 'path',
  )
  assert.equal(childPathKeys.length, 1, 'CLI must have one effective PATH key')
  assert.equal(
    cliEnv[childPathKeys[0]],
    `${bin};${env[inheritedPathKeys[0]] ?? ''}`,
    'CLI must retain its inherited executable search path',
  )
  result.executableSearchPath.childRetainedInheritedPath = true
  const { findExecutableOnPath } = await import(
    '../../packages/opencode/dist/src/common-auth-embedded/setup/index.js'
  )
  for (const name of ['opencode', 'pi', 'ck']) {
    assert.equal(
      findExecutableOnPath(name, { env: cliEnv }),
      join(bin, `${name}.cmd`),
      `Setup must admit its owned ${name} executable`,
    )
  }
  assert.deepEqual(pathEntries(process.env), pathEntries(previous))
  const beforePreview = await snapshotFiles()
  const preview = spawnSync(
    process.execPath,
    [
      join(repository, 'packages/opencode/dist/cli.js'),
      'setup',
      '--yes',
      '--dry-run',
      '--opencode=2',
      '--no-claustrum',
    ],
    { cwd: root, env: cliEnv, encoding: 'utf8', timeout: 60000 },
  )
  assert.equal(preview.error, undefined)
  assert.equal(preview.status, 0, preview.stderr)
  assert.match(preview.stdout, /Pi: found/)
  assert.ok(preview.stdout.includes(nativeDir))
  const afterPreview = await snapshotFiles()
  const changedNames = [
    ...new Set([...Object.keys(beforePreview), ...Object.keys(afterPreview)]),
  ].filter((name) => beforePreview[name] !== afterPreview[name])
  if (changedNames.length > 0) {
    // Record which files changed without uploading their credential-bearing bytes.
    const digest = (bytes) =>
      bytes === undefined
        ? null
        : createHash('sha256')
            .update(Buffer.from(bytes, 'base64'))
            .digest('hex')
    result.dryRunFileChanges = changedNames.map((name) => ({
      relativePath: name
        .split('/')
        .map((part) => redactFailureText(part, fixtureSecrets))
        .join('/'),
      beforeSha256: digest(beforePreview[name]),
      afterSha256: digest(afterPreview[name]),
      beforeBytes:
        beforePreview[name] === undefined
          ? null
          : Buffer.from(beforePreview[name], 'base64').length,
      afterBytes:
        afterPreview[name] === undefined
          ? null
          : Buffer.from(afterPreview[name], 'base64').length,
    }))
  }
  assert.deepEqual(afterPreview, beforePreview)
  assert.deepEqual(pathEntries(process.env), pathEntries(previous))
  result.executableSearchPath.parentUnchanged = true
  stage('dry-run-permission-oracle')
  assert.deepEqual(readTokenDacl(decoyAuthPath), decoyDacl)
  assert.equal(existsSync(`${decoyAuthPath}.lock`), false)
  assert.match(preview.stdout, /Would run .*pi\.cmd install/)
  for (let index = 0; index < paths.length; index++) {
    assert.deepEqual(await readFile(paths[index]), bytes[index])
    assert.deepEqual(
      readTokenDacl(paths[index]),
      weak[index],
      'Dry-run repaired a DACL',
    )
  }
  assert.equal(existsSync(`${authPath}.lock`), false)
  result.checks.push(
    'real CLI dry-run selected Pi without inspecting, locking or repairing its weak fixture files',
  )

  // Observe PrivateFileMigration warnings from repairing the fixture DACLs
  // without replacing emitWarning.
  stage('pi-permission-migration')
  process.on('warning', onWarning)
  await assertSetupHostsStopped()
  await assert.rejects(
    plugin.beforeSignIn('pi', {
      hosts: ['pi'],
      opencodeGeneration: '2',
      mode: 'local',
      piAgentDir: nativeDir,
    }),
    /vault marker/,
  )
  assert.deepEqual(await slot.inspect(), {
    slot: 'placeholder',
    stash: 'valid',
  })
  await new Promise(setImmediate)
  const repairedDescriptors = []
  for (let index = 0; index < paths.length; index++) {
    assert.deepEqual(
      await readFile(paths[index]),
      bytes[index],
      'Inspection changed credential/stash bytes',
    )
    const repaired = readTokenDacl(paths[index])
    repairedDescriptors.push(repaired)
    assertPrivateTokenDacl(repaired)
    assert.equal(
      repaired.ownerSid,
      original[index].ownerSid,
      'Inspection changed file ownership',
    )
  }
  assert.deepEqual(
    readTokenDacl(dirname(authPath)),
    parent,
    'Inspection changed existing parent permissions',
  )
  assert.equal(
    warnings.length,
    2,
    'Both named files must surface their migration warning',
  )
  assert.ok(warnings.some((warning) => warning.message.includes('auth.json')))
  assert.ok(
    warnings.some((warning) =>
      warning.message.includes('google-login-stash.json'),
    ),
  )
  result.checks.push(
    'real fenced public inspect repaired exactly the two weak file DACLs, preserving bytes, owners and parent DACL',
  )
  result.checks.push(
    'both ordinary PrivateFileMigration warnings remained surfaced',
  )

  stage('foreign-login-refusal')
  const { runSetup } = await import(
    '../../packages/opencode/dist/src/common-auth-embedded/setup/index.js'
  )
  await fs.writeJsonAtomic(authPath, {
    google: {
      type: 'oauth',
      refresh: 'synthetic-foreign-login',
      access: 'synthetic-foreign-access',
      expires: 2,
    },
  })
  const foreign = await readFile(authPath)
  const stashBefore = await readFile(stashPath)
  plugin.vault.connectionFile = join(root, 'synthetic-connection.json')
  await writeFile(plugin.vault.connectionFile, '{}')
  let ceremonies = 0
  const client = {
    close() {},
    async enrollPropose() {
      ceremonies++
      throw new Error('ceremony must not start')
    },
    async enrollPoll() {
      throw new Error('ceremony must not poll')
    },
  }
  const selectedHosts = []
  const observedPlugin = {
    ...plugin,
    async beforeSignIn(host, context) {
      selectedHosts.push([...context.hosts])
      return plugin.beforeSignIn(host, context)
    },
  }
  const beforeConflict = await snapshotFiles()
  await assert.rejects(
    runSetupWithEnvironment(
      runSetup,
      observedPlugin,
      ['--yes', '--claustrum', '--opencode=2'],
      cliEnv,
      {
        connect: async () => client,
      },
    ),
    /saved login|stash|conflict/i,
  )
  assert.deepEqual(selectedHosts, [['opencode', 'pi']])
  assert.equal(ceremonies, 0)
  assert.deepEqual(
    await snapshotFiles(),
    beforeConflict,
    'Rejected preflight changed enrollment, account or config files',
  )
  assert.deepEqual(await readFile(authPath), foreign)
  assert.deepEqual(await readFile(stashPath), stashBefore)
  result.checks.push(
    'foreign Pi login refused before any selected host enrollment ceremony; auth/stash bytes unchanged',
  )
  stage('missing-authority-parent')
  const claustrum = await loadCommonAuthClaustrum()
  const host = plugin.vault.hosts.opencode
  const authorityPaths = claustrum.hostEnrollmentPaths(host.paths)
  const stateParent = dirname(authorityPaths.statePath)
  assert.equal(
    existsSync(stateParent),
    false,
    'Missing-parent control must begin absent',
  )
  const configParentDacl = readTokenDacl(env.OPENCODE_CONFIG_DIR)
  const beforeMissing = await snapshotFiles()
  await plugin.beforeSignIn('opencode', {
    hosts: ['opencode'],
    piAgentDir: nativeDir,
    opencodeGeneration: '2',
    mode: 'local',
  })
  assert.equal(existsSync(stateParent), true)
  assert.deepEqual(
    await snapshotFiles(),
    beforeMissing,
    'Authority preflight changed file contents',
  )
  assert.deepEqual(readTokenDacl(env.OPENCODE_CONFIG_DIR), configParentDacl)
  result.checks.push(
    'Windows local authority preflight created only a missing owned state parent, not files or existing ancestor permission changes',
  )
  stage('authority-permission-migration')
  const manager = new claustrum.ClaustrumEnrollmentManager({
    paths: authorityPaths,
    proposedName: host.name,
    client: {
      enrollPropose: async () => ({ requestId: 'synthetic-authority-request' }),
      enrollPoll: async () => ({
        status: 'approved',
        name: host.name,
        token: 'ab'.repeat(32),
        tokenGeneration: 1,
      }),
    },
  })
  assert.equal((await manager.reconcile()).state, 'approved')
  const authorityFiles = [authorityPaths.statePath, authorityPaths.tokenPath]
  const authorityBytes = await Promise.all(
    authorityFiles.map((path) => readFile(path)),
  )
  const authorityOriginal = authorityFiles.map(readTokenDacl)
  authorityOriginal.forEach(assertPrivateTokenDacl)
  const authorityParentDacl = readTokenDacl(stateParent)
  authorityFiles.forEach(weakenFile)
  for (const path of authorityFiles)
    assert.throws(() => assertPrivateTokenDacl(readTokenDacl(path)))
  await assert.rejects(
    plugin.beforeSignIn('opencode', {
      hosts: ['opencode'],
      piAgentDir: nativeDir,
      opencodeGeneration: '2',
      mode: 'local',
    }),
    /Vault enrollment excludes local sign-in/,
  )
  await new Promise(setImmediate)
  const authorityRepaired = authorityFiles.map(readTokenDacl)
  for (let index = 0; index < authorityFiles.length; index++) {
    assert.deepEqual(
      await readFile(authorityFiles[index]),
      authorityBytes[index],
    )
    assertPrivateTokenDacl(authorityRepaired[index])
    assert.equal(
      authorityRepaired[index].ownerSid,
      authorityOriginal[index].ownerSid,
    )
  }
  assert.deepEqual(readTokenDacl(stateParent), authorityParentDacl)
  assert.deepEqual(readTokenDacl(env.OPENCODE_CONFIG_DIR), configParentDacl)
  assert.equal(
    await claustrum.enrollmentAuthority(authorityPaths, host.name),
    'vault',
  )
  assert.equal(
    warnings.length,
    4,
    'Auth, stash and both authority files must surface actual migration warnings',
  )
  result.authorityDacl = {
    original: authorityOriginal.map(redactDacl),
    repaired: authorityRepaired.map(redactDacl),
  }
  result.checks.push(
    'Windows local authority refusal preserved enrollment bytes, vault authority, owners and ancestor DACLs while tightening only its two owned files',
  )
  result.dacl = {
    original: original.map(redactDacl),
    weak: weak.map(redactDacl),
    repaired: repairedDescriptors.map(redactDacl),
  }
  stage('decoy-preservation')
  assert.deepEqual(pathEntries(process.env), pathEntries(previous))
  assert.deepEqual(await readFile(decoyAuthPath), decoyBytes)
  assert.deepEqual(readTokenDacl(decoyAuthPath), decoyDacl)
  assert.deepEqual(readTokenDacl(extensionDir), decoyParentDacl)
  assert.equal(existsSync(`${decoyAuthPath}.lock`), false)
  result.checks.push(
    'distinct extension auth decoy bytes, DACL and parent DACL remained unchanged while native auth controls executed',
  )
  result.warnings = warnings.map((warning) => ({
    name: warning.name,
    auth: warning.message.includes('auth.json'),
    stash: warning.message.includes('google-login-stash.json'),
  }))
}

await verifyWithReceipt({
  evidence,
  result,
  run: verify,
  nativeWindows: true,
  bundleUrl: new URL(
    '../../packages/opencode/dist/windows-pi-preflight-product.mjs',
    import.meta.url,
  ),
  secrets: fixtureSecrets,
  cleanup: [
    ['warning-listener', () => process.off('warning', onWarning)],
    [
      'restore-environment',
      () => {
        for (const key of Object.keys(process.env))
          if (!(key in previous)) delete process.env[key]
        Object.assign(process.env, previous)
      },
    ],
    [
      'remove-isolated-profile',
      async () => {
        if (root) await rm(root, { recursive: true, force: true })
      },
    ],
  ],
})
console.log(
  JSON.stringify({
    status: result.status,
    nativeWindowsQualified: result.nativeWindowsQualified,
    checks: result.checks.length,
    failedStage: result.failedStage,
    evidence,
  }),
)
