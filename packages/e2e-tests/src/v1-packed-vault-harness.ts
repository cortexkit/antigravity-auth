import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { networkInterfaces } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gzipSync } from 'node:zlib'
import { createPublicCommandInspector } from '../../core/src/__fixtures__/public-command-processes.test.ts'
import { measureNativeJob } from './fixtures/opencode-ga-host/native-job.ts'
import {
  bodyHasPrimaryNonce,
  createGaTlsFiles,
  type GaRawPeer,
  newGaNonce,
  prepareGaRoot,
  record,
  sha256,
  startGaRawPeer,
  verifiedArchiveFiles,
  verifyExecutable,
} from './opencode-ga-harness.ts'
import {
  assertGaFixturePins,
  GA_OFFLINE_FIXTURE,
  gaInstalledServer,
  installNativeGaPacks,
} from './opencode-ga-host-inputs.ts'
import {
  finite,
  SYNTHETIC_PROJECT,
  SYNTHETIC_TOKEN,
  startChild,
  withSyntheticVault,
} from './v1-vault-activation-harness.ts'

const ROOT = resolve(import.meta.dir, '../../..')
export const PACKED_PACKAGE = '@cortexkit/opencode-antigravity-auth'
const CORE_PACKAGE = '@cortexkit/antigravity-auth-core'
const HOST_ARCHIVE =
  '.cortexkit/parent-inputs/v1-packed-floor-r1/opencode-linux-x64-1.17.13.tgz'
const ARCHIVE_SHA =
  '04a172f44c3449e1251f6f4b4dc9c391166a078c5aba04c9c1717411b4e84331'
const ARCHIVE_SRI =
  'sha512-6naffcRwMLUM0kYuwJ3tRWt1/NXPybt9u8ZqTvSZwATM54+GhQmoiz8Qb9GYFTiwSJmB1rq8VoEmwh1VPzBcFw=='
const ELF_SHA =
  'ae98d78e8b9a4f3ef4fd16920bfb3dedeab731c0586badff501f75b53ece3b6d'
export const VAULT_MARKER = {
  google: {
    type: 'oauth',
    access: '',
    refresh: 'claustrum-tombstone:v1:google',
    expires: 0,
  },
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}
function json(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}

export interface PackedLoading {
  packageDirectory: string
  configuredPlugin: string
  manifestEntry: string
  resolvedEntry: string
  entrySha256: string
  packedEntrySha256: string
  trace: string
  sourceRoot: string
}

/** Require a package-directory configuration and an actual read of its manifest-selected server. */
export function assertPackedLoading(loading: PackedLoading): void {
  check(
    loading.configuredPlugin === pathToFileURL(loading.packageDirectory).href,
    'Not configured as the installed package directory',
  )
  check(
    loading.manifestEntry === join(loading.packageDirectory, 'dist/server.js'),
    'Unexpected manifest server arm',
  )
  check(
    loading.resolvedEntry === loading.manifestEntry,
    'Installed resolution disagrees with manifest',
  )
  check(
    loading.entrySha256 === loading.packedEntrySha256,
    'Loaded server differs from the pack',
  )
  const opens = loading.trace
    .split('\n')
    .filter((line) => /\bopen(at|at2)?\(/.test(line))
  check(
    opens.some(
      (line) =>
        line.includes(`"${loading.manifestEntry}"`) && !line.includes('= -1'),
    ),
    'Installed server entry was not read by the native host',
  )
  check(
    !opens.some(
      (line) =>
        line.includes(`${loading.sourceRoot}/packages/opencode/src/`) ||
        line.includes(`${loading.sourceRoot}/packages/core/src/`),
    ),
    'Checkout source loading is not the packed server route',
  )
}

/** Validate the primary decoded wire, not a title call or an unrelated nonce-bearing string. */
export function assertPackedWire(
  requests: GaRawPeer['requests'],
  nonce: string,
): void {
  check(requests.length === 1, 'Expected exactly one physical first request')
  const request = requests[0]!
  check(
    request.method === 'POST' &&
      request.url === '/v1internal:streamGenerateContent?alt=sse',
    'Wire method or endpoint identity changed',
  )
  const headers = new Headers()
  for (let i = 0; i < request.rawHeaders.length; i += 2)
    headers.append(request.rawHeaders[i]!, request.rawHeaders[i + 1]!)
  check(
    headers.get('authorization') === `Bearer ${SYNTHETIC_TOKEN}`,
    'Wire bearer did not come from the approved synthetic vault',
  )
  check(
    [
      'daily-cloudcode-pa.googleapis.com',
      'cloudcode-pa.googleapis.com',
    ].includes(headers.get('host') ?? ''),
    'Wire host identity changed',
  )
  const body = record(JSON.parse(request.body))
  check(body.project === SYNTHETIC_PROJECT, 'Wire project attribution changed')
  check(body.model === 'gemini-3.8-flash-high', 'Wire model identity changed')
  check(
    body.requestType === 'agent' &&
      body.userAgent === 'antigravity' &&
      typeof body.requestId === 'string' &&
      /^agent\/[0-9a-f-]{36}\/[0-9]+\/[0-9a-f-]{36}\/[0-9]+$/.test(
        body.requestId,
      ),
    'Wire agent request identity missing',
  )
  check(bodyHasPrimaryNonce(request.body, nonce), 'Primary wire nonce missing')
}

export function assertPackedDormancy(
  authBefore: string | null,
  authAfter: string | null,
  wire: GaRawPeer['requests'],
): void {
  check(
    authBefore !== null && authBefore === authAfter,
    'Dormant auth.json bytes changed during vault serving',
  )
  const slot = record(record(JSON.parse(authBefore)).google)
  const physicalWire = JSON.stringify(wire)
  for (const value of [slot.access, slot.refresh])
    if (typeof value === 'string' && value.length > 0)
      check(
        !physicalWire.includes(value),
        'Dormant host-slot credential appeared on the physical wire',
      )
}

export function assertNoGoogleSideCalls(
  networkSyscalls: readonly string[],
): void {
  check(
    !networkSyscalls.some(
      (line) =>
        /\b(sendto|sendmsg|sendmmsg)\(/.test(line) &&
        /oauth2|accounts|cloudresourcemanager|serviceusage|fetchUserQuota|loadCodeAssist/.test(
          line,
        ),
    ),
    'Google OAuth/project/quota network call attempted',
  )
  check(
    !networkSyscalls.some(
      (line) =>
        line.includes('connect(') &&
        /AF_INET/.test(line) &&
        !line.includes('127.0.0.1') &&
        !line.includes('::1'),
    ),
    'Native child attempted non-loopback networking',
  )
}

export interface PackedVaultReceipt {
  sourceTree: string | undefined
  sourceHashes: Record<string, string>
  runtime: {
    bun: string
    platform: string
    arch: string
    interfaces: string[]
    unprivilegedPortStart: string
  }
  profile: string
  archive: { path: string; bytes: number; sha256: string; sri: string }
  binary: { path: string; sha256: string; version: string }
  packs: Record<string, string>
  installed: Record<string, string>
  preparation: Record<string, unknown>
  boundary?: unknown
  serverArmControl?: {
    path: string
    originalSha256: string
    mutatedSha256: string
    restoredSha256?: string
    diff: string
  }
  loading?: PackedLoading
  authAbsentBefore: boolean
  marker?: unknown
  nonce: string
  processes: ReturnType<typeof startChild>['receipt'][]
  requests: GaRawPeer['requests']
  tlsEvents: GaRawPeer['events']
  wireHashes: string[]
  traceHashes: Record<string, string>
  vaultCalls: Record<string, unknown>[]
  controls: {
    name: string
    requests: number
    wire: GaRawPeer['requests']
    stdout: string
    stderr: string
    exitCode: number | null
    nonce: string
    authBefore: string | null
    authAfter: string | null
    wireHashes: string[]
    vaultCalls: Record<string, unknown>[]
    marker: unknown
  }[]
  traces: Record<string, string>
  localFileSyscalls: string[]
  networkSyscalls: string[]
  error?: string
}

export async function runPackedVault(): Promise<PackedVaultReceipt> {
  check(
    process.platform === 'linux' && process.arch === 'x64',
    'Packed native gate requires isolated Linux x64',
  )
  check(
    Object.keys(networkInterfaces()).every((name) => name === 'lo'),
    'Packed native runtime must expose only loopback',
  )
  const profile = realpathSync(mkdtempSync('/tmp/packed-v1-vault-'))
  chmodSync(profile, 0o700)
  mkdirSync(join(profile, 'host'), { mode: 0o700 })
  mkdirSync(join(profile, 'runtime'), { mode: 0o700 })
  const paths = prepareGaRoot(join(profile, 'host'))
  const project = paths.project
  const config = join(paths.config, 'opencode')
  const authFile = join(paths.data, 'opencode/auth.json')
  const accountFile = join(config, 'antigravity-accounts.json')
  const consumer = join(profile, 'consumer')
  const receipt: PackedVaultReceipt = {
    sourceTree: process.env.GA_SOURCE_TREE,
    sourceHashes: {},
    runtime: {
      bun: Bun.version,
      platform: process.platform,
      arch: process.arch,
      interfaces: Object.keys(networkInterfaces()),
      unprivilegedPortStart: readFileSync(
        '/proc/sys/net/ipv4/ip_unprivileged_port_start',
        'utf8',
      ).trim(),
    },
    profile,
    archive: { path: join(ROOT, HOST_ARCHIVE), bytes: 0, sha256: '', sri: '' },
    binary: { path: join(profile, 'opencode'), sha256: '', version: '' },
    packs: {},
    installed: {},
    preparation: {},
    authAbsentBefore: false,
    nonce: newGaNonce(),
    processes: [],
    requests: [],
    tlsEvents: [],
    wireHashes: [],
    traceHashes: {},
    vaultCalls: [],
    controls: [],
    traces: {},
    localFileSyscalls: [],
    networkSyscalls: [],
  }
  const env: NodeJS.ProcessEnv = {
    PATH: `${dirname(realpathSync(process.execPath))}:/usr/bin:/bin`,
    HOME: paths.home,
    XDG_CONFIG_HOME: paths.config,
    XDG_DATA_HOME: paths.data,
    XDG_CACHE_HOME: paths.cache,
    XDG_STATE_HOME: paths.state,
    XDG_RUNTIME_DIR: join(profile, 'runtime'),
    TMPDIR: paths.temp,
    OPENCODE_DB: paths.database,
    ANTIGRAVITY_ACCOUNTS_PATH: accountFile,
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
    OPENCODE_CONFIG_DIR: config,
  }
  const inspector = await createPublicCommandInspector()
  const children: ReturnType<typeof startChild>[] = []
  let peer: GaRawPeer | undefined
  let serverRestore: { path: string; bytes: Buffer } | undefined
  const command = async (
    name: string,
    args: string[],
    deadline = 15000,
    host = true,
  ) => {
    const argv = host
      ? [
          '/usr/bin/strace',
          '-f',
          '-e',
          'trace=%file,%network',
          '-s',
          '512',
          '-o',
          join(profile, `${name}.syscalls`),
          receipt.binary.path,
          ...args,
        ]
      : args
    const child = startChild(name, argv, project, env, deadline, inspector)
    children.push(child)
    receipt.processes.push(child.receipt)
    const result = await finite(
      child.result,
      deadline + 5000,
      `${name} did not exit`,
    )
    await child.stop()
    check(!result.timedOut, `${name} exceeded its finite deadline`)
    return result
  }
  const succeeded = async (name: string, args: string[], deadline = 15000) => {
    const result = await command(name, args, deadline)
    check(
      result.exitCode === 0,
      `${name} failed: ${result.exitCode}: ${result.stderr}`,
    )
    return result
  }
  try {
    check(
      receipt.runtime.unprivilegedPortStart === '0',
      'Namespace does not admit owned loopback port443',
    )
    await measureNativeJob(
      ROOT,
      paths.temp,
      env,
      join(profile, 'boundary.json'),
    )
    receipt.boundary = JSON.parse(
      readFileSync(join(profile, 'boundary.json'), 'utf8'),
    )
    const archive = readFileSync(receipt.archive.path)
    receipt.archive.bytes = archive.length
    receipt.archive.sha256 = sha256(archive)
    receipt.archive.sri = `sha512-${new Bun.CryptoHasher('sha512').update(archive).digest('base64')}`
    check(
      archive.length === 54631676 &&
        receipt.archive.sha256 === ARCHIVE_SHA &&
        receipt.archive.sri === ARCHIVE_SRI,
      'Admitted official archive bytes/SHA/SRI mismatch',
    )
    const hostFiles = verifiedArchiveFiles(archive, ARCHIVE_SRI)
    const binary = hostFiles.get('package/bin/opencode')
    check(binary, 'Official archive lacks the executable')
    writeFileSync(receipt.binary.path, binary, { mode: 0o700, flag: 'wx' })
    verifyExecutable(receipt.binary.path, ELF_SHA, 62)
    receipt.binary.sha256 = sha256(binary)
    receipt.binary.version = (
      await succeeded('version', ['--version'])
    ).stdout.trim()
    check(
      receipt.binary.version === '1.17.13',
      'Actual native version is not the admitted floor',
    )
    assertGaFixturePins(ROOT)
    mkdirSync(join(consumer, 'node_modules'), { recursive: true, mode: 0o700 })
    for (const name of [
      '@cortexkit/claustrum-client',
      '@cortexkit/subc-client',
      'jsonc-parser',
      'xdg-basedir',
      'zod',
    ]) {
      const from = realpathSync(
        join(ROOT, GA_OFFLINE_FIXTURE, 'node_modules', name),
      )
      check(
        from.startsWith(`${ROOT}/${GA_OFFLINE_FIXTURE}/node_modules/`),
        'Dependency escaped the admitted standalone fixture',
      )
      cpSync(from, join(consumer, 'node_modules', name), {
        recursive: true,
        dereference: false,
        force: false,
        errorOnExist: true,
      })
    }
    for (const name of ['@opencode-ai/plugin', '@opencode-ai/sdk']) {
      const from =
        name === '@opencode-ai/plugin'
          ? realpathSync(join(ROOT, 'node_modules', name))
          : realpathSync(
              resolve(
                dirname(
                  Bun.resolveSync(
                    name,
                    realpathSync(
                      join(ROOT, 'node_modules/@opencode-ai/plugin'),
                    ),
                  ),
                ),
                '..',
              ),
            )
      check(
        record(JSON.parse(readFileSync(join(from, 'package.json'), 'utf8')))
          .version === '1.17.13',
        'Installed offline SDK differs from the native floor',
      )
      cpSync(from, join(consumer, 'node_modules', name), {
        recursive: true,
        dereference: false,
        force: false,
        errorOnExist: true,
      })
    }
    await installNativeGaPacks(ROOT, consumer)
    for (const name of ['build', 'core.tgz', 'plugin.tgz'])
      receipt.preparation[name] = JSON.parse(
        readFileSync(join(consumer, `${name}.json`), 'utf8'),
      )
    for (const name of ['core.tgz', 'plugin.tgz'])
      receipt.packs[name] = sha256(readFileSync(join(consumer, name)))
    for (const path of [
      'packages/e2e-tests/src/v1-packed-vault-harness.ts',
      'packages/e2e-tests/src/v1-packed-vault.e2e.test.ts',
      'packages/e2e-tests/src/opencode-ga-harness.ts',
      'packages/e2e-tests/src/opencode-ga-host-inputs.ts',
      'packages/e2e-tests/src/v1-vault-activation-harness.ts',
      'packages/opencode/src/server.ts',
      'packages/opencode/src/plugin/index.ts',
      'packages/core/src/common-auth-embedded/source-output.json',
    ])
      receipt.sourceHashes[path] = sha256(readFileSync(join(ROOT, path)))
    const packageDirectory = join(consumer, 'node_modules', PACKED_PACKAGE)
    const installedEntry = gaInstalledServer(consumer, 'import')
    const coreEntry = Bun.resolveSync(CORE_PACKAGE, packageDirectory)
    check(
      coreEntry.startsWith(`${consumer}/node_modules/${CORE_PACKAGE}/`) &&
        realpathSync(coreEntry) === coreEntry,
      'Installed plugin resolves core outside the real pack',
    )
    for (const entry of [installedEntry, coreEntry])
      receipt.installed[entry] = sha256(readFileSync(entry))
    const pluginPack = readFileSync(join(consumer, 'plugin.tgz'))
    const packedFiles = verifiedArchiveFiles(
      pluginPack,
      `sha512-${new Bun.CryptoHasher('sha512').update(pluginPack).digest('base64')}`,
    )
    const packedEntry = packedFiles.get('package/dist/server.js')
    check(packedEntry, 'Pack lacks the manifest server entry')
    receipt.loading = {
      packageDirectory,
      configuredPlugin: pathToFileURL(packageDirectory).href,
      manifestEntry: installedEntry,
      resolvedEntry: Bun.resolveSync(`${PACKED_PACKAGE}/server`, consumer),
      entrySha256: sha256(readFileSync(installedEntry)),
      packedEntrySha256: sha256(packedEntry),
      trace: '',
      sourceRoot: ROOT,
    }
    if (process.env.PACKED_V1_SERVER_ARM_CONTROL === '1') {
      const original = readFileSync(installedEntry)
      const needle = 'server: AntigravityCLIOAuthPlugin'
      check(
        original.toString().split(needle).length === 2,
        'Packed hybrid server arm was not uniquely found',
      )
      const replacement =
        'server: () => { throw new Error("NON-VACUITY BREAK: installed hybrid.server called") }'
      const mutated = original.toString().replace(needle, replacement)
      serverRestore = { path: installedEntry, bytes: original }
      writeFileSync(installedEntry, mutated)
      receipt.serverArmControl = {
        path: installedEntry,
        originalSha256: sha256(original),
        mutatedSha256: sha256(Buffer.from(mutated)),
        diff: `-${needle}\n+${replacement}`,
      }
    }
    for (const directory of [config, join(project, '.opencode')]) {
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      symlinkSync(
        join(consumer, 'node_modules'),
        join(directory, 'node_modules'),
      )
      json(join(directory, 'package.json'), {
        private: true,
        dependencies: { '@opencode-ai/plugin': '1.17.13' },
      })
      json(join(directory, 'package-lock.json'), {
        lockfileVersion: 3,
        packages: {
          '': { dependencies: { '@opencode-ai/plugin': '1.17.13' } },
          'node_modules/@opencode-ai/plugin': { version: '1.17.13' },
        },
      })
    }
    json(join(project, '.opencode/antigravity.json'), {
      quiet_mode: true,
      auto_update: false,
      background_quota_refresh: false,
      quota_refresh_interval_minutes: 0,
      proactive_token_refresh: false,
      session_recovery: false,
      cache_warmup_on_switch: false,
    })
    json(join(config, 'opencode.json'), {
      plugin: [receipt.loading.configuredPlugin],
      enabled_providers: ['google'],
      permission: { '*': 'deny' },
      agent: { title: { disable: true }, summary: { disable: true } },
    })
    process.env.ANTIGRAVITY_GA_HOST_EXECUTION = '1'
    const tls = createGaTlsFiles(paths, 'matching')
    env.NODE_EXTRA_CA_CERTS = tls.ca
    let activeNonce = receipt.nonce
    peer = await startGaRawPeer(tls, 'success', () => activeNonce)
    receipt.requests = peer.requests
    receipt.tlsEvents = peer.events
    await withSyntheticVault(
      profile,
      receipt,
      env,
      async () => {
        // This child only prepares synthetic enrollment; the native host never imports its source or factory.
        const seed = await command(
          'enrollment',
          [
            realpathSync(process.execPath),
            join(ROOT, 'packages/e2e-tests/src/v1-vault-activation-harness.ts'),
            '--seed',
          ],
          15000,
          false,
        )
        check(
          seed.exitCode === 0,
          `Synthetic enrollment failed: ${seed.stderr}`,
        )
        receipt.authAbsentBefore = !existsSync(authFile)
        check(
          receipt.authAbsentBefore &&
            !existsSync(accountFile) &&
            !existsSync(`${accountFile}.store`),
          'Profile already has native auth or local accounts',
        )
        const catalog = await command('catalog', ['models', 'google'], 15000)
        check(
          catalog.exitCode === 0 &&
            catalog.stdout
              .split('\n')
              .includes('google/antigravity-gemini-3.8-flash'),
          'Packed plugin did not register its catalog',
        )
        check(
          !existsSync(authFile),
          'Catalog probe created native auth before activation',
        )
        await succeeded(
          'login',
          [
            'auth',
            'login',
            '--provider',
            'google',
            '--method',
            'Activate approved Antigravity vault',
            '--print-logs',
            '--log-level',
            'INFO',
          ],
          30000,
        )
        receipt.marker = JSON.parse(readFileSync(authFile, 'utf8'))
        await succeeded(
          'first-request',
          [
            'run',
            '--dir',
            project,
            '--format',
            'json',
            '--model',
            'google/antigravity-gemini-3.8-flash',
            `Reply with GA_OK_${receipt.nonce}. Primary request nonce: ${receipt.nonce}`,
          ],
          30000,
        )
        receipt.requests = [...peer!.requests]
        for (const name of [
          'missing-placeholder',
          'foreign-tombstone',
          'dormant-login',
        ]) {
          if (name === 'missing-placeholder') unlinkSync(authFile)
          else
            json(authFile, {
              google:
                name === 'foreign-tombstone'
                  ? {
                      ...VAULT_MARKER.google,
                      refresh: 'claustrum-tombstone:v1:other-provider',
                    }
                  : {
                      type: 'oauth',
                      access: 'dormant-google-access',
                      refresh: 'dormant-google-refresh',
                      expires: 0,
                    },
            })
          const authBefore = existsSync(authFile)
            ? readFileSync(authFile, 'utf8')
            : null
          const marker = authBefore === null ? null : JSON.parse(authBefore)
          const before = peer!.requests.length
          const vaultBefore = receipt.vaultCalls.length
          activeNonce = newGaNonce()
          const result = await command(
            name,
            [
              'run',
              '--dir',
              project,
              '--format',
              'json',
              '--model',
              'google/antigravity-gemini-3.8-flash',
              `Reply with GA_OK_${activeNonce}. Primary request nonce: ${activeNonce}`,
            ],
            30000,
          )
          const wire = peer!.requests.slice(before)
          receipt.controls.push({
            name,
            marker,
            nonce: activeNonce,
            authBefore,
            authAfter: existsSync(authFile)
              ? readFileSync(authFile, 'utf8')
              : null,
            wireHashes: wire.map((request) =>
              sha256(Buffer.from(request.body)),
            ),
            vaultCalls: receipt.vaultCalls.slice(vaultBefore),
            requests: wire.length,
            wire,
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.exitCode,
          })
        }
        json(authFile, receipt.marker)
      },
      consumer,
    )
  } catch (error) {
    receipt.error = error instanceof Error ? error.stack : String(error)
  } finally {
    for (const child of children) {
      try {
        await child.stop()
      } catch (error) {
        receipt.error = `${receipt.error ?? ''}\nCleanup: ${String(error)}`
      }
      const trace = join(profile, `${child.receipt.name}.syscalls`)
      if (existsSync(trace)) {
        const text = readFileSync(trace, 'utf8')
        receipt.traces[child.receipt.name] = text
        receipt.traceHashes[child.receipt.name] = sha256(Buffer.from(text))
        receipt.localFileSyscalls.push(
          ...text.split('\n').filter((line) => line.includes(accountFile)),
        )
        receipt.networkSyscalls.push(
          ...text
            .split('\n')
            .filter((line) =>
              /\b(connect|sendmmsg|sendmsg|sendto)\(/.test(line),
            ),
        )
      }
    }
    inspector.close()
    if (peer) {
      try {
        await finite(peer.close(), 5000, 'Raw TLS peer cleanup did not finish')
      } catch (error) {
        receipt.error = `${receipt.error ?? ''}\nTLS cleanup: ${String(error)}`
      }
    }
    if (serverRestore) {
      writeFileSync(serverRestore.path, serverRestore.bytes)
      if (receipt.serverArmControl)
        receipt.serverArmControl.restoredSha256 = sha256(
          readFileSync(serverRestore.path),
        )
    }
    if (receipt.loading) {
      receipt.loading.trace =
        receipt.traces['first-request'] ?? receipt.traces.login ?? ''
      const configured = record(
        JSON.parse(readFileSync(join(config, 'opencode.json'), 'utf8')),
      ).plugin
      receipt.loading.configuredPlugin =
        Array.isArray(configured) && typeof configured[0] === 'string'
          ? configured[0]
          : ''
      receipt.loading.entrySha256 = sha256(
        readFileSync(receipt.loading.manifestEntry),
      )
    }
    receipt.wireHashes = receipt.requests.map((request) =>
      sha256(Buffer.from(request.body)),
    )
    if (existsSync(accountFile) || existsSync(`${accountFile}.store`))
      receipt.error = `${receipt.error ?? ''}\nLocal account artifact created`
    json(join(profile, 'receipt.json'), receipt)
  }
  return receipt
}

export function emitPackedReceipt(receipt: PackedVaultReceipt): void {
  console.log('PACKED_V1_RECEIPT_GZIP_BASE64_BEGIN')
  const encoded = gzipSync(JSON.stringify(receipt)).toString('base64')
  for (let start = 0; start < encoded.length; start += 120)
    console.log(encoded.slice(start, start + 120))
  console.log('PACKED_V1_RECEIPT_GZIP_BASE64_END')
}
if (import.meta.main && process.argv.includes('--run')) {
  const receipt = await runPackedVault()
  emitPackedReceipt(receipt)
  if (receipt.error) {
    console.error(receipt.error)
    process.exitCode = 1
  }
}
