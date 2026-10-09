import {
  type ChildProcessWithoutNullStreams,
  execFileSync,
} from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import {
  appendFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import {
  createServer as createHttpServer,
  type IncomingMessage,
} from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import {
  createConnection,
  createServer as createTcpServer,
  type Socket,
} from 'node:net'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { Duplex } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { stripVTControlCharacters } from 'node:util'
import { gunzipSync } from 'node:zlib'
import {
  createSourceFile,
  forEachChild,
  isCallExpression,
  isExpressionStatement,
  isFunctionLike,
  isIdentifier,
  isPropertyAccessExpression,
  isVariableDeclaration,
  type Node,
  ScriptKind,
  ScriptTarget,
} from 'typescript'
import { getAgyModelEnum } from '../../core/src/agy-request-metadata.ts'
import { getPublicModelDefinitions } from '../../core/src/model-registry.ts'
import { resolveModelForHeaderStyle } from '../../core/src/transform/model-resolver.ts'
import type {
  AntigravityAppliedOutput,
  AntigravityApplyInput,
  AntigravityApplyOutput,
  AntigravityMenuRequest,
  AntigravityStateInput,
  AntigravityStateOutput,
  AntigravityStateSnapshot,
} from '../../opencode/src/ga/rpc/protocol.ts'
import {
  assertMeasuredNativeJob,
  measureNativeJob,
} from './fixtures/opencode-ga-host/native-job.ts'
import { startOwnedCommand } from './fixtures/opencode-ga-host/owned-command.ts'

// Committed repository files: the pinned OpenCode binary digest and the
// released host contract. The runner reads them from the checkout, never from
// a copy produced during a run.
export const GA_PIN_PATH = 'packages/e2e-tests/docker/ga-binary-pin.json'
export const GA_CONTRACT_PATH =
  'packages/opencode/docs/opencode2-ga-2.0.22-contract.md'
export const GA_PLATFORM = 'linux/amd64'
export const GA_VERSION = '2.0.22'
export const GA_HOSTNAMES = [
  'daily-cloudcode-pa.googleapis.com',
  'cloudcode-pa.googleapis.com',
] as const

function requireCondition(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) throw new Error(message)
}

export function record(value: unknown): Record<string, unknown> {
  requireCondition(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    'Expected an object',
  )
  return value as Record<string, unknown>
}

/** Refuse lexical escapes and symlink escapes, including a symlinked ancestor. */
export function ownedPath(root: string, path: string): string {
  requireCondition(
    isAbsolute(root) && isAbsolute(path),
    'Owned paths must be absolute',
  )
  const canonicalRoot = realpathSync(root)
  requireCondition(
    canonicalRoot === resolve(root),
    'Owned root must not contain symlinks',
  )
  const delta = relative(canonicalRoot, resolve(path))
  requireCondition(
    delta !== '' &&
      delta !== '..' &&
      !delta.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) &&
      !isAbsolute(delta),
    `Path escapes owned root: ${path}`,
  )
  let current = resolve(path)
  while (current !== canonicalRoot) {
    try {
      requireCondition(
        !lstatSync(current).isSymbolicLink(),
        `Symlink in owned path: ${current}`,
      )
    } catch (error) {
      if (record(error).code !== 'ENOENT') throw error
    }
    current = dirname(current)
  }
  return resolve(path)
}

export interface GaPaths {
  root: string
  home: string
  config: string
  data: string
  state: string
  cache: string
  temp: string
  project: string
  database: string
  opencodeConfig: string
  rpc: string
}

export function prepareGaRoot(root: string): GaPaths {
  requireCondition(
    isAbsolute(root) && existsSync(root),
    'Missing owned GA root',
  )
  requireCondition(
    lstatSync(root).isDirectory() && !lstatSync(root).isSymbolicLink(),
    'Unsafe owned GA root',
  )
  requireCondition(
    realpathSync(root) === resolve(root),
    'Unsafe symlinked GA root',
  )
  requireCondition(readdirSync(root).length === 0, 'GA root must be empty')
  // Every HOME, XDG, OpenCode database and plugin path of this run lives under
  // this empty root, so no state from another run or from the user's own
  // profile can reach the host.
  const paths: GaPaths = {
    root,
    home: join(root, 'home'),
    config: join(root, 'config'),
    data: join(root, 'data'),
    state: join(root, 'state'),
    cache: join(root, 'cache'),
    temp: join(root, 'tmp'),
    project: join(root, 'project'),
    database: join(root, 'data', 'opencode.db'),
    opencodeConfig: join(root, 'config', 'opencode'),
    rpc: join(root, 'state', 'rpc'),
  }
  for (const path of Object.values(paths)) {
    if (path === root || path === paths.database) continue
    ownedPath(root, path)
    requireCondition(!existsSync(path), `GA root is not fresh: ${path}`)
    mkdirSync(path, { recursive: true, mode: 0o700 })
  }
  return paths
}

/** Construct, rather than sanitize, the environment for every host launch. */
export function gaChildEnvironment(
  paths: GaPaths,
  inherited: NodeJS.ProcessEnv,
  options: { proxy?: Record<string, string>; trust?: string } = {},
): NodeJS.ProcessEnv {
  requireCondition(
    !Object.hasOwn(inherited, 'NODE_TLS_REJECT_UNAUTHORIZED'),
    'NODE_TLS_REJECT_UNAUTHORIZED presence forbids host launch',
  )
  requireCondition(Boolean(paths.database), 'Missing isolated OPENCODE_DB')
  for (const path of Object.values(paths)) {
    if (path !== paths.root) ownedPath(paths.root, path)
  }
  const environment: NodeJS.ProcessEnv = {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: paths.home,
    USERPROFILE: paths.home,
    XDG_CONFIG_HOME: paths.config,
    XDG_DATA_HOME: paths.data,
    XDG_STATE_HOME: paths.state,
    XDG_CACHE_HOME: paths.cache,
    TMPDIR: paths.temp,
    PWD: paths.project,
    INIT_CWD: paths.project,
    OPENCODE_CONFIG_DIR: paths.opencodeConfig,
    OPENCODE_DB: paths.database,
    ANTIGRAVITY_AUTH_RPC_DIR: paths.rpc,
    PI_AGENT_DIR: join(paths.config, 'pi-agent'),
    PI_CODING_AGENT_DIR: join(paths.config, 'pi-coding-agent'),
    GOOGLE_GENERATIVE_AI_API_KEY: 'synthetic-ga-key',
    OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
    TERM: 'xterm-256color',
    LANG: 'C.UTF-8',
  }
  for (const [name, value] of Object.entries(options.proxy ?? {})) {
    requireCondition(
      /^(HTTP_PROXY|http_proxy|HTTPS_PROXY|https_proxy|ALL_PROXY|all_proxy|NO_PROXY|no_proxy)$/.test(
        name,
      ),
      `Unexpected environment injection: ${name}`,
    )
    environment[name] = value
  }
  if (options.trust !== undefined) {
    ownedPath(paths.root, options.trust)
    requireCondition(
      statSync(options.trust).isFile(),
      'Missing startup CA fixture',
    )
    environment.NODE_EXTRA_CA_CERTS = options.trust
  }
  return environment
}

export function assertGaDatabase(paths: GaPaths): void {
  ownedPath(paths.root, paths.database)
  requireCondition(
    existsSync(paths.database) &&
      statSync(paths.database).isFile() &&
      statSync(paths.database).size > 0,
    'Host did not create isolated OPENCODE_DB',
  )
}

export interface NativeGaProvenance {
  hostUname: string
  daemonArchitecture: string
  containerUname: string
  elfMachine: number
  runtimeIdentity: string
}

export function assertNativeGa(
  provenance: NativeGaProvenance,
  runtimeIdentity: string,
): void {
  requireCondition(
    provenance.hostUname === 'x86_64' &&
      ['x86_64', 'amd64'].includes(provenance.daemonArchitecture) &&
      provenance.containerUname === 'x86_64',
    'not native x86_64: independent host and daemon provenance required',
  )
  requireCondition(provenance.elfMachine === 62, 'Wrong host ELF architecture')
  requireCondition(
    provenance.runtimeIdentity === runtimeIdentity &&
      runtimeIdentity.length > 0,
    'Wrong pinned runtime identity',
  )
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export function verifySri(bytes: Uint8Array, integrity: string): void {
  requireCondition(
    /^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity),
    'Malformed SHA-512 SRI',
  )
  const actual = `sha512-${createHash('sha512').update(bytes).digest('base64')}`
  requireCondition(
    actual === integrity,
    'Tarball SRI mismatch; extraction forbidden',
  )
}

export function verifyExecutable(
  path: string,
  digest: string,
  machine: number,
): void {
  requireCondition(
    /^[0-9a-f]{64}$/.test(digest),
    'Malformed executable SHA-256',
  )
  const bytes = readFileSync(path)
  requireCondition(
    sha256(bytes) === digest,
    'Executable digest mismatch; execution forbidden',
  )
  requireCondition(
    bytes.length >= 20 &&
      bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) &&
      bytes[4] === 2 &&
      bytes[5] === 1,
    'Expected little-endian ELF64 host',
  )
  requireCondition(
    bytes.readUInt16LE(18) === machine && machine === 62,
    'Wrong host ELF architecture',
  )
}

/**
 * Every case a complete GA run must execute. Running a selected subset is for
 * debugging; only a run of all of them counts as a complete result.
 */
export const GA_CASE_IDS = [
  'catalog-and-titles',
  'title-off-catalog',
  'title-primary-fallback',
  'title-overflow',
  'compaction',
  'gemini-tools',
  'claude-tools',
  'claude-thinking',
  'image-permissions',
  'validation-required',
  'account-ineligible',
  'refresh-401',
  'quota-429',
  'capacity-fallback',
  'transport-reset',
  'host-retryable-status',
  'terminal-frame',
  'late-eof-empty',
  'late-eof-after-content',
  'late-error-empty',
  'late-error-after-content',
  'late-immediate-first-chunk-error',
  'late-unrelated-response',
  'concurrent-sessions',
  'job-mismatch-location',
  'job-mismatch-origin',
  'job-mismatch-job',
  'job-mismatch-session',
  'job-mismatch-kind',
  'pty-interrupt-recovery',
  'sigint-natural-close',
  'cleanup-reload',
  'cleanup-disable',
  'cleanup-location-close',
  'cleanup-idempotent',
  'overflow-gemini',
  'overflow-claude',
  'overflow-changed-counts',
  'overflow-nonmatching-400',
  'raw-cancel-connecting-direct',
  'raw-cancel-connecting-proxy',
  'raw-cancel-pre-header-direct',
  'raw-cancel-pre-header-proxy',
  'raw-cancel-post-header-direct',
  'raw-cancel-post-header-proxy',
  'tls-positive-before',
  'tls-missing-trust',
  'tls-wrong-san',
  'tls-missing-san-wrong-cn',
  'tls-positive-after',
  'proxy-trigger-a',
  'proxy-trigger-b',
  'proxy-trigger-c',
  'proxy-trigger-d',
  'proxy-quoted-http-double',
  'proxy-quoted-http-single',
  'proxy-quoted-HTTP-double',
  'proxy-quoted-no-double-HTTP',
  'proxy-quoted-no-single-HTTP',
  'proxy-quoted-no-double-http',
  'proxy-quoted-no-single-http',
  'proxy-raw-empty-fallthrough',
  'proxy-comma-exclusion',
  'proxy-no-proxy',
  'proxy-wildcard',
  'proxy-raw-connect',
  'packed-proxy-pass',
  'packed-proxy-fail',
  'pty-sidebar-dialogs',
  'pty-reauthorize-listener',
  'pty-command-account',
  'pty-command-quota',
  'pty-command-routing',
  'pty-command-killswitch',
  'pty-command-logging',
  'pty-command-dump',
  'pty-two-location-toggle-quota',
  'pty-two-location-oauth-bearer',
  'pty-two-location-distinct-settings-a-first',
  'pty-two-location-distinct-settings-b-first',
  'pty-two-location-shared-settings',
  'pty-two-location-project-settings',
  'pty-two-location-poller',
  'pty-two-location-dispose',
  'pty-two-location-rebind',
  'pty-stale-handle-reload',
  'pty-credential-redaction',
  'killswitch-all-fresh-below',
  'killswitch-missing-quota',
  'killswitch-stale-quota',
  'killswitch-account-override',
  'raw-cancel-never-accepted-control',
  'pty-second-instance-control',
  'pty-raw-fallback-control',
  'cleanup-order-control',
  'cleanup-missing-control',
  'tls-missing-mapping-control',
  'tls-missing-observer-control',
  'tls-disabled-verification-control',
  'ga.raw-cancel.detached-dispatch-signal',
  'ga.raw-cancel.uncancelled-request-completes',
  'ga.raw-cancel.async-observer-rejected',
] as const
export type GaCaseId = (typeof GA_CASE_IDS)[number]

export interface GaCaseObservation {
  id: GaCaseId
  state: 'source-prepared' | 'runtime-verified'
  nonce: string
  databaseFile: string
  // Raw files kept on disk for this case (requests, host output, traces), so
  // the result can be checked against them rather than trusting `state`.
  evidenceFiles: string[]
  primaryRequests: number
  directProviderRequests: number
  elapsedMs: number
}

export function assertCompleteGaInventory(ids: readonly string[]): void {
  requireCondition(new Set(ids).size === ids.length, 'Duplicate GA case')
  const expected = new Set<string>(GA_CASE_IDS)
  requireCondition(
    ids.length === expected.size && ids.every((id) => expected.has(id)),
    'Incomplete or unexpected GA case inventory',
  )
}

/**
 * Checks the per-case results before any run-wide result is written: every
 * case must be present with its raw evidence files on disk.
 */
export function assertGaObservations(
  root: string,
  observations: readonly GaCaseObservation[],
): void {
  assertCompleteGaInventory(observations.map((observation) => observation.id))
  const nonces = new Set<string>()
  for (const observation of observations) {
    requireCondition(
      observation.state === 'runtime-verified',
      `Source-prepared is not runtime-verified: ${observation.id}`,
    )
    requireCondition(
      /^[a-f0-9]{32}$/.test(observation.nonce) &&
        !nonces.has(observation.nonce),
      `Missing or reused scenario nonce: ${observation.id}`,
    )
    nonces.add(observation.nonce)
    requireCondition(
      Number.isInteger(observation.directProviderRequests) &&
        observation.directProviderRequests === 0,
      `Public provider fallthrough: ${observation.id}`,
    )
    requireCondition(
      Number.isInteger(observation.primaryRequests) &&
        observation.primaryRequests >= 0,
      `Missing primary request observation: ${observation.id}`,
    )
    requireCondition(
      Number.isFinite(observation.elapsedMs) &&
        observation.elapsedMs > 0 &&
        observation.elapsedMs <= 60_000,
      `Missing or late scenario observation: ${observation.id}`,
    )
    const database = ownedPath(root, observation.databaseFile)
    requireCondition(
      existsSync(database) &&
        statSync(database).isFile() &&
        statSync(database).size > 0,
      `Missing actual scenario DB: ${observation.id}`,
    )
    requireCondition(
      observation.evidenceFiles.length > 0 &&
        new Set(observation.evidenceFiles).size ===
          observation.evidenceFiles.length,
      `Missing actual scenario observations: ${observation.id}`,
    )
    for (const path of observation.evidenceFiles) {
      ownedPath(root, path)
      requireCondition(
        statSync(path).isFile() && statSync(path).size > 0,
        `Empty scenario evidence: ${observation.id}`,
      )
    }
  }
}

/** Verify first, then parse only ordinary tar members; never invoke tar on untrusted bytes. */
export function verifiedArchiveMember(
  archive: Uint8Array,
  integrity: string,
  member: string,
): Buffer {
  requireCondition(
    /^package\/[A-Za-z0-9_./-]+$/.test(member) &&
      !member.split('/').includes('..'),
    'Unsafe binary member path',
  )
  const found = verifiedArchiveFiles(archive, integrity).get(member)
  requireCondition(found, 'Missing executable archive member')
  requireCondition(found.length > 0, 'Empty executable archive member')
  return found
}

/** The same bounded parser also installs locally packed files without running package lifecycle scripts. */
export function verifiedArchiveFiles(
  archive: Uint8Array,
  integrity: string,
): Map<string, Buffer> {
  verifySri(archive, integrity)
  const tar = gunzipSync(archive, { maxOutputLength: 512 * 1024 * 1024 })
  const files = new Map<string, Buffer>()
  const names = new Set<string>()
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const field = (start: number, length: number) =>
      header
        .subarray(start, start + length)
        .toString('utf8')
        .split('\0')[0] ?? ''
    const prefix = field(345, 155)
    const name = `${prefix ? `${prefix}/` : ''}${field(0, 100)}`
    requireCondition(
      /^package(?:\/[A-Za-z0-9_./-]*)?$/.test(name) &&
        !name.split('/').some((part) => part === '..' || part === '.'),
      `Unsafe archive path: ${name}`,
    )
    const type = header[156]
    requireCondition(
      !names.has(name) && names.size < 10_000,
      'Duplicate archive member or excessive inventory',
    )
    names.add(name)
    requireCondition(
      type === 0 || type === 48 || type === 53,
      `Unsupported archive member type: ${name}`,
    )
    const sizeField = field(124, 12).trim()
    requireCondition(
      /^[0-7]+$/.test(sizeField),
      'Malformed archive member size',
    )
    const size = Number.parseInt(sizeField, 8)
    requireCondition(
      Number.isSafeInteger(size) && offset + 512 + size <= tar.length,
      'Truncated archive member',
    )
    let checksum = 0
    for (let index = 0; index < 512; index++)
      checksum += index >= 148 && index < 156 ? 32 : (header[index] ?? 0)
    requireCondition(
      checksum === Number.parseInt(field(148, 8).trim(), 8),
      'Invalid archive header checksum',
    )
    if (type !== 53)
      files.set(
        name,
        Buffer.from(tar.subarray(offset + 512, offset + 512 + size)),
      )
    offset += 512 + Math.ceil(size / 512) * 512
  }
  requireCondition(files.size > 0, 'Missing executable archive member')
  return files
}

export interface GaRunResult {
  outputCapExceeded: boolean
  cleanupFailures?: string[]
  spawnError?: string
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  timedOut: boolean
}

export interface GaChild {
  process: ChildProcessWithoutNullStreams
  result: Promise<GaRunResult>
  output: () => { stdout: string; stderr: string }
  signal(value: NodeJS.Signals): void
}

export interface GaVerifiedExecutable {
  path: string
  sha256: string
  elfMachine: 62
}

/**
 * Every OpenCode process, including `--version` and the `run` client, gets
 * OPENCODE_DB set to this run's own database file, so no launch can fall back
 * to the default database in the user's profile.
 */
export function launchGaHost(
  executable: GaVerifiedExecutable,
  paths: GaPaths,
  args: readonly string[],
  options: {
    proxy?: Record<string, string>
    trust?: string
    pty?: boolean
    deadlineMs?: number
  } = {},
): GaChild {
  requireCondition(
    process.env.ANTIGRAVITY_GA_HOST_EXECUTION === '1',
    'GA host execution is not admitted',
  )
  if (process.env.GA_CONTAINMENT_MODE === 'native-job')
    assertMeasuredNativeJob()
  else {
    requireCondition(
      process.env.GA_CONTAINMENT_MODE === undefined,
      'Unknown GA containment mode',
    )
    requireCondition(
      process.platform === 'linux' &&
        process.arch === 'x64' &&
        existsSync('/.dockerenv'),
      'GA host launch requires native Linux amd64 Docker',
    )
    requireCondition(
      process.env.GA_HOST_UNAME === 'x86_64' &&
        ['x86_64', 'amd64'].includes(process.env.GA_DAEMON_ARCH ?? ''),
      'not native x86_64: outside host/daemon provenance is missing or emulated',
    )
  }
  requireCondition(
    readdirSync('/sys/class/net').join(',') === 'lo',
    'GA host launch requires network-none',
  )
  verifyExecutable(executable.path, executable.sha256, executable.elfMachine)
  const env = gaChildEnvironment(paths, process.env, options)
  const deadlineMs = options.deadlineMs ?? 30_000
  requireCondition(
    Number.isInteger(deadlineMs) && deadlineMs > 0 && deadlineMs <= 60_000,
    'Invalid host deadline',
  )
  // util-linux script allocates a real PTY; a pipe or import-only mount is not UI evidence.
  // Shell arguments are individually quoted and the command is never user-supplied.
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  const command = options.pty ? '/usr/bin/script' : executable.path
  const argv = options.pty
    ? [
        '--quiet',
        '--flush',
        '--return',
        '--command',
        [executable.path, ...args].map(quote).join(' '),
        '/dev/null',
      ]
    : [...args]
  const owned = startOwnedCommand(command, argv, {
    cwd: paths.project,
    env,
    deadlineMs,
  })
  return {
    ...owned,
    result: owned.result.then((result) => {
      writeFileSync(
        join(paths.state, `owned-child-${newGaNonce()}.json`),
        JSON.stringify({ command, argv, result }),
        { mode: 0o600, flag: 'wx' },
      )
      requireCondition(
        !result.spawnError && result.cleanupFailures.length === 0,
        `Host child ownership/reap failure: ${JSON.stringify(result)}`,
      )
      return result
    }),
  }
}

export async function waitForGaObservation(
  predicate: () => boolean | Promise<boolean>,
  label: string,
  deadlineMs = 5000,
): Promise<void> {
  const end = performance.now() + deadlineMs
  while (performance.now() < end) {
    if (await predicate()) return
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 25))
  }
  throw new Error(`Missing actual scenario observation: ${label}`)
}

async function availablePort(): Promise<number> {
  const server = createTcpServer()
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  requireCondition(
    address && typeof address !== 'string',
    'Missing loopback port',
  )
  const port = address.port
  await new Promise<void>((resolveClose, reject) =>
    server.close((error) => (error ? reject(error) : resolveClose())),
  )
  return port
}

export interface GaHostSession {
  url: string
  server: GaChild
  run(
    model: string,
    prompt: string,
    continuation?: boolean,
  ): Promise<GaRunResult>
  close(): Promise<GaRunResult>
}

/**
 * Starts the pinned OpenCode binary's `serve` and drives it with the same
 * binary's `run --server`. Nothing here is a host simulated through the SDK.
 */
export async function startGaHost(
  executable: GaVerifiedExecutable,
  paths: GaPaths,
  options: { proxy?: Record<string, string>; trust?: string } = {},
): Promise<GaHostSession> {
  const port = await availablePort()
  const url = `http://127.0.0.1:${port}`
  const server = launchGaHost(
    executable,
    paths,
    [
      'serve',
      '--hostname',
      '127.0.0.1',
      '--port',
      String(port),
      '--print-logs',
      '--log-level',
      'debug',
    ],
    { ...options, deadlineMs: 60_000 },
  )
  try {
    await waitForGaObservation(
      async () => {
        if (
          server.process.exitCode !== null ||
          server.process.signalCode !== null
        )
          throw new Error(
            `Host exited during startup: ${server.output().stderr}`,
          )
        try {
          await fetch(url, { signal: AbortSignal.timeout(500) })
          return true
        } catch {
          return false
        }
      },
      'loopback server readiness',
      15_000,
    )
  } catch (error) {
    server.signal('SIGKILL')
    try {
      await server.result
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        'Host startup and cleanup failed',
      )
    }
    throw error
  }
  return {
    url,
    server,
    async run(model, prompt, continuation = false) {
      const child = launchGaHost(
        executable,
        paths,
        [
          'run',
          '--server',
          url,
          '--format',
          'json',
          '--model',
          model,
          ...(continuation ? ['--continue'] : []),
          prompt,
        ],
        options,
      )
      const result = await child.result
      requireCondition(
        !result.timedOut && !result.outputCapExceeded,
        'Real CLI run deadline expired',
      )
      assertGaDatabase(paths)
      return result
    },
    async close() {
      server.signal('SIGTERM')
      const timer = setTimeout(() => server.signal('SIGKILL'), 3000)
      try {
        return await server.result
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

export function newGaNonce(): string {
  return randomBytes(16).toString('hex')
}
export function gaTimestamp(): number {
  // Kernel-monotonic time is comparable between the CLI child and mock peer;
  // performance.now() has a different origin in each process.
  return Number(process.hrtime.bigint() / 1_000_000n)
}

export function captureGaEvidence(
  path: string,
  event: string,
  fields: Record<string, unknown>,
): void {
  appendFileSync(
    path,
    `${JSON.stringify({ event, at: gaTimestamp(), ...fields })}\n`,
    { mode: 0o600 },
  )
}

export interface GaCancellationTrace {
  phase: 'connecting' | 'pre-header' | 'post-header'
  tcpAcceptedAt?: number
  parsedPrimaryAt?: number
  contentAt?: number
  interruptedAt: number
  senderAbortedAt?: number
  peerClosedAt?: number
  applicationBytes: number
  bytesAfterPeerClose: number
  forcedTeardown: boolean
}

/**
 * A cancellation counts only when the mock peer accepted the connection
 * before the interrupt, the raw sender's own AbortSignal fired, and the peer
 * saw the socket close on its own within 2 s (not harness teardown). Header
 * phases also need the parsed request, and post-header the first content
 * chunk, before the interrupt.
 */
export function assertGaCancellation(trace: GaCancellationTrace): void {
  const accepted = trace.tcpAcceptedAt
  const aborted = trace.senderAbortedAt
  const closed = trace.peerClosedAt
  requireCondition(
    accepted !== undefined && accepted <= trace.interruptedAt,
    'Missing naturally accepted raw TCP/TLS peer',
  )
  requireCondition(
    aborted !== undefined &&
      aborted >= trace.interruptedAt &&
      aborted - trace.interruptedAt <= 2000,
    'Missing sender AbortSignal transition within 2000 ms',
  )
  requireCondition(
    closed !== undefined &&
      closed >= trace.interruptedAt &&
      closed - trace.interruptedAt <= 2000 &&
      !trace.forcedTeardown,
    'Missing natural raw peer close within 2000 ms',
  )
  requireCondition(
    trace.bytesAfterPeerClose === 0,
    'Bytes after cancellation peer close',
  )
  if (trace.phase === 'connecting') {
    requireCondition(
      trace.parsedPrimaryAt === undefined && trace.applicationBytes === 0,
      'Connecting proof emitted AGY application bytes',
    )
  } else {
    requireCondition(
      trace.parsedPrimaryAt !== undefined &&
        trace.parsedPrimaryAt <= trace.interruptedAt &&
        trace.applicationBytes > 0,
      'Missing genuinely parsed primary before interrupt',
    )
    if (trace.phase === 'post-header')
      requireCondition(
        trace.contentAt !== undefined && trace.contentAt <= trace.interruptedAt,
        'Missing genuine post-header content',
      )
    else
      requireCondition(
        trace.contentAt === undefined,
        'Pre-header proof sent content',
      )
  }
}

export interface GaTlsTrace {
  nonce: string
  primaryBodies: string[]
  nativeErrors: unknown[]
}

export function bodyHasPrimaryNonce(body: string, nonce: string): boolean {
  try {
    const envelope = record(JSON.parse(body))
    if (
      typeof envelope.model !== 'string' ||
      envelope.model === 'gemini-3.5-flash-extra-low'
    )
      return false
    const contents = record(envelope.request).contents
    return (
      Array.isArray(contents) &&
      contents.some((content) => {
        const parts = record(content).parts
        return (
          Array.isArray(parts) &&
          parts.some(
            (part) =>
              typeof record(part).text === 'string' &&
              String(record(part).text).includes(nonce),
          )
        )
      })
    )
  } catch {
    return false
  }
}

/**
 * Five TLS runs in order: a success, then an untrusted chain, a wrong SAN and
 * a missing SAN that must each fail before a request is decrypted, then a
 * success again. The successes before and after show the failures came from
 * the certificates, not a broken setup.
 */
export function assertGaTlsSequence(traces: readonly GaTlsTrace[]): void {
  requireCondition(
    traces.length === 5,
    'Incomplete TLS positive/negative sequence',
  )
  for (const [index, trace] of traces.entries()) {
    requireCondition(
      /^[a-f0-9]{32}$/.test(trace.nonce),
      'Missing TLS primary nonce',
    )
    if (index === 0 || index === 4) {
      requireCondition(
        trace.primaryBodies.some((body) =>
          bodyHasPrimaryNonce(body, trace.nonce),
        ) && trace.nativeErrors.length === 0,
        'Missing nonce-matched primary TLS positive',
      )
    } else {
      requireCondition(
        trace.primaryBodies.length === 0 && trace.nativeErrors.length > 0,
        'TLS negative did not reject before decrypted application request',
      )
      const errors = trace.nativeErrors
        .map((value) => {
          const error = record(value)
          requireCondition(
            (error.type === 'provider.transport' ||
              (error.type === 'provider.internal' && error.status === 502)) &&
              typeof error.message === 'string',
            'TLS negative lacks a native provider error',
          )
          return error.message
        })
        .join('\n')
      const pattern =
        index === 1
          ? /certificate|issuer|self.signed|trust/i
          : /hostname|altname|SAN|certificate.*name/i
      requireCondition(
        pattern.test(errors),
        'TLS negative lacks chain or hostname rejection',
      )
    }
  }
}

export const GA_OVERFLOW_PATH =
  'packages/opencode/src/plugin/shared/__fixtures__'
export function loadGaOverflowFixture(
  repoRoot: string,
  family: 'gemini' | 'claude',
): { status: 400; contentType: string; bytes: Buffer } {
  const fixture = record(
    JSON.parse(
      readFileSync(
        join(repoRoot, GA_OVERFLOW_PATH, `overflow-${family}.json`),
        'utf8',
      ),
    ),
  )
  requireCondition(
    fixture.status === 400 &&
      typeof fixture.contentType === 'string' &&
      typeof fixture.body === 'string' &&
      typeof fixture.bodyBase64 === 'string',
    'Malformed overflow fixture',
  )
  const bytes = Buffer.from(fixture.bodyBase64, 'base64')
  const expected =
    family === 'gemini'
      ? '8f7c248c6ea08caa5db181b1e4f27290a5cc508e259ef00bc2281035c42e982a'
      : '773dfc1934b7d6b429f728b5842f5338ef69451b5513f4bf6b1ac48edbbec01f'
  requireCondition(
    bytes.toString('utf8') === fixture.body &&
      bytes.length === fixture.bodyByteLength &&
      sha256(bytes) === expected &&
      fixture.bodySha256 === expected,
    'Canned overflow bytes or digest changed',
  )
  const provenance = record(fixture.provenance)
  requireCondition(
    provenance.kind ===
      'retained canned mock response, not a live backend capture' &&
      provenance.observedHostVersion === 'opencode v2.0.20' &&
      provenance.observedMagicContextRevision ===
        'cda6851df61b3d53b900174e285cedcfecedb213' &&
      provenance.runChecks === 75 &&
      provenance.runRedChecks === 0,
    'Invalid MC canned-overflow provenance',
  )
  return { status: 400, contentType: fixture.contentType, bytes }
}

/**
 * Writes the wrapper plugin the host loads. `verifyConsumerBindings`
 * type-checks the same kind of consumer source against the installed
 * package's declarations.
 */
export function writeGaWrapper(input: {
  paths: GaPaths
  consumerPrefix: string
  packedServerEntry: string
  mockUrl: string
  rawSender: boolean
  duplicateCleanup?: boolean
}): string {
  const { paths, consumerPrefix, packedServerEntry, mockUrl, rawSender } = input
  requireCondition(
    isAbsolute(consumerPrefix) &&
      !consumerPrefix.startsWith(`${resolve('.')}/`),
    'Consumer prefix must be outside the repository',
  )
  requireCondition(
    realpathSync(packedServerEntry).startsWith(
      `${realpathSync(consumerPrefix)}/`,
    ),
    'Wrapper must import the packed ./server outside the repository',
  )
  const wrapper = join(consumerPrefix, `ga-wrapper-${newGaNonce()}`)
  mkdirSync(wrapper, { mode: 0o700 })
  writeFileSync(
    join(wrapper, 'package.json'),
    JSON.stringify({ private: true, type: 'module' }),
  )
  const fixturePath = join(paths.state, 'locations.json')
  writeFileSync(fixturePath, JSON.stringify({ [paths.project]: { mockUrl } }), {
    mode: 0o600,
  })
  const source = `import { appendFileSync, readFileSync } from 'node:fs'
import { createGaAntigravityPlugin, type GaPluginOverrides } from '@cortexkit/opencode-antigravity-auth/server'
import type { Plugin } from '@opencode/plugin'
export default { id: 'antigravity-e2e-wrapper', async setup(context: Plugin.Context) {
const scope = crypto.randomUUID()
const fixtures: unknown = JSON.parse(readFileSync(${JSON.stringify(fixturePath)}, 'utf8'))
const entry = fixtures && typeof fixtures === 'object' && context.location.directory in fixtures ? Reflect.get(fixtures, context.location.directory) : undefined
const transportMock = entry && typeof entry.mockUrl === 'string' ? entry.mockUrl : ${JSON.stringify(mockUrl)}
if (new URL(transportMock).hostname !== '127.0.0.1') throw new Error('Fixture transport escaped loopback')
const log = (event: string, fields: object = {}) => appendFileSync(${JSON.stringify(join(paths.state, 'wrapper.ndjson'))}, JSON.stringify({ event, scope, at: Number(process.hrtime.bigint() / 1000000n), ...fields }) + '\\n')
let observerDisposed = false
const observedSignals = new Map<AbortSignal, { identity: number, listener: () => void }>()
const observeRawSenderSignal: NonNullable<GaPluginOverrides['observeRawSenderSignal']> = (signal) => {
  try {
    if (observerDisposed) { log('raw.observer.failure', { message: 'Observer invoked after teardown' }); return undefined }
    if (!observedSignals.has(signal)) {
      const identity = observedSignals.size + 1
      const listener = () => log('raw.signal.aborted', { identity })
      observedSignals.set(signal, { identity, listener })
      signal.addEventListener('abort', listener, { once: true })
      log('raw.signal.observed', { identity, initiallyAborted: signal.aborted })
      if (signal.aborted) listener()
    }
  } catch (error) { log('raw.observer.failure', { message: String(error) }) }
  return undefined
}
const overrides: GaPluginOverrides = {
  ${rawSender ? 'observeRawSenderSignal,' : ''}
  observeAccountSnapshot: (observation) => {
    log('accounts.snapshot', { observation })
    return undefined
  },
  refreshAccessToken: async (auth) => ({ ...auth, access: auth.refresh.split('|')[0] + '-access', expires: Date.now() + 3600000 }),
  ensureProjectContext: async (auth) => {
    const response = await fetch(transportMock + '/loadCodeAssist', { method: 'POST', body: JSON.stringify({ project: 'synthetic-ga-project' }) })
    if (!response.ok) throw new Error('Fixture project context failed')
    return { auth, effectiveProjectId: 'synthetic-ga-project' }
  },
  loadManagedProject: async () => {
    const response = await fetch(transportMock + '/loadCodeAssist', { method: 'POST', body: '{}' })
    if (!response.ok) throw new Error('Fixture tier lookup failed')
    return { cloudaicompanionProject: 'synthetic-ga-project', currentTier: { id: 'free-tier' } }
  },
  quotaFetch: (_input, init) => fetch(transportMock + '/quota', init),
  oauth: {
    authorize: async (projectId = '') => {
      const verifier = 'synthetic-ga-pkce-verifier'
      const state = Buffer.from(JSON.stringify({ verifier, projectId })).toString('base64url')
      log('oauth.authorize', { state })
      return { url: ${JSON.stringify(`${mockUrl}/authorize`)} + '?state=' + state, verifier, projectId }
    },
    exchange: async (code, state) => {
      log('oauth.exchange', { codePresent: code === 'synthetic-ga-code', state })
      if (code !== 'synthetic-ga-code') return { type: 'failed', error: 'Unexpected fixture code' }
      // The same Google account as fixture account A, which the reauthorization
      // cases block: reauthorization refuses a sign-in to a different account.
      return { type: 'success', refresh: 'synthetic-ga-reauthorized|synthetic-ga-project', access: 'synthetic-ga-reauthorized-access', expires: Date.now() + 3600000, email: 'synthetic-A@example.invalid', projectId: 'synthetic-ga-project' }
    },
  },
  ${
    rawSender
      ? ''
      : `send: ({ envelope, auth, endpoint, signal, kind }) => {
    log('send.start', { kind, endpoint, aborted: signal.aborted })
    signal.addEventListener('abort', () => log('send.abort', { kind }), { once: true })
    return fetch(transportMock + '/agy/' + kind, { method: 'POST', headers: { authorization: 'Bearer ' + auth.access, 'content-type': 'application/json', 'x-agy-endpoint': endpoint }, body: JSON.stringify(envelope), signal })
  },`
  }
}
const plugin = createGaAntigravityPlugin(overrides)
  log('setup', { contextKeys: Object.keys(context) })
  const cleanup = await plugin.setup(context)
  if (typeof cleanup !== 'function') throw new Error('GA setup did not return initialized Cleanup')
  log('initialized', { runtime: { name: 'Bun', version: Bun.version, revision: Bun.revision } })
  try {
  const wire = await context.session.hook('http.request', (event) => {
    log('native.request', { sessionID: event.sessionID, kind: event.kind, model: event.model.id, url: event.request.url, method: event.request.method, headerNames: Array.from(event.request.headers.keys()) })
  }, { providerID: 'google' })
  const response = await context.session.hook('http.response', async (event) => {
    if (event.response.status === 400) {
      const bytes = Buffer.from(await event.response.clone().arrayBuffer())
      log('native.400', { status: event.response.status, contentType: event.response.headers.get('content-type'), bytes: bytes.toString('base64'), contextErrorHeader: event.response.headers.get('x-antigravity-context-error') })
    }
  }, { providerID: 'google' })
  return async () => {
    log('cleanup.start')
    try { await cleanup(); ${input.duplicateCleanup ? "await cleanup(); log('cleanup.duplicate');" : ''} log('cleanup.end') } finally {
      observerDisposed = true
      for (const [signal, observation] of observedSignals) signal.removeEventListener('abort', observation.listener)
      observedSignals.clear()
      await response.dispose(); await wire.dispose()
    }
  }
  } catch (error) {
    observerDisposed = true
    for (const [signal, observation] of observedSignals) signal.removeEventListener('abort', observation.listener)
    observedSignals.clear()
    try { await cleanup() } catch (rollbackError) { log('setup.rollback.failure', { message: String(rollbackError) }) }
    throw error
  }
} }
`
  writeFileSync(join(wrapper, 'index.ts'), source, { mode: 0o600 })
  // The installed package's public `./tui` entry chooses its compiled
  // OpenCode 2 build when the host mounts it; the wrapper imports neither raw
  // TSX nor its own copy of the UI framework.
  writeGaTuiWrapper(wrapper, paths)
  return wrapper
}

export interface GaTlsFiles {
  ca: string
  certificate: string
  key: string
}

/**
 * Creates a throwaway CA and leaf certificate that only this run's host is
 * told to trust at startup. The system trust store, the plugin's own CA
 * setting and its endpoint overrides are left untouched.
 */
export function createGaTlsFiles(
  paths: GaPaths,
  identity: 'matching' | 'wrong-san' | 'missing-san',
): GaTlsFiles {
  requireCondition(
    process.env.ANTIGRAVITY_GA_HOST_EXECUTION === '1',
    'TLS fixture execution is not admitted',
  )
  const root = join(paths.temp, `tls-${identity}`)
  ownedPath(paths.root, root)
  mkdirSync(root, { mode: 0o700 })
  const ca = join(root, 'ca.pem')
  const key = join(root, 'leaf.key')
  const certificate = join(root, 'leaf.pem')
  const caKey = join(root, 'ca.key')
  const csr = join(root, 'leaf.csr')
  const run = (args: string[]) =>
    execFileSync('/usr/bin/openssl', args, {
      cwd: root,
      env: gaChildEnvironment(paths, process.env),
      stdio: 'pipe',
      timeout: 10_000,
    })
  run([
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '2',
    '-subj',
    '/CN=Synthetic GA test CA',
    '-keyout',
    caKey,
    '-out',
    ca,
  ])
  // Missing-SAN deliberately uses a nonmatching CN. It makes no universal
  // assertion about a TLS implementation's legacy matching-CN fallback.
  run([
    'req',
    '-new',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-subj',
    '/CN=nonmatching.ga.invalid',
    '-keyout',
    key,
    '-out',
    csr,
  ])
  const extension = join(root, 'leaf.ext')
  writeFileSync(
    extension,
    `basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n${identity === 'missing-san' ? '' : `subjectAltName=${(identity === 'matching' ? GA_HOSTNAMES : ['wrong.ga.invalid']).map((hostname) => `DNS:${hostname}`).join(',')}\n`}`,
  )
  run([
    'x509',
    '-req',
    '-in',
    csr,
    '-CA',
    ca,
    '-CAkey',
    caKey,
    '-CAcreateserial',
    '-days',
    '2',
    '-extfile',
    extension,
    '-out',
    certificate,
  ])
  return { ca, certificate, key }
}

export interface GaRawPeer {
  requests: Array<{
    body: string
    rawHeaders: string[]
    receivedAt: number
    peer: number
  }>
  events: Array<{ event: string; at: number; peer: number }>
  forced: boolean
  close(): Promise<void>
}

/** Real 443 peer for the unchanged raw sender; it never dials an upstream. */
export async function startGaRawPeer(
  files: GaTlsFiles,
  mode: 'success' | 'connecting' | 'pre-header' | 'post-header',
  nonce: string,
): Promise<GaRawPeer> {
  requireCondition(
    process.env.ANTIGRAVITY_GA_HOST_EXECUTION === '1',
    'Raw TLS host case is not admitted',
  )
  const requests: GaRawPeer['requests'] = []
  const events: GaRawPeer['events'] = []
  const sockets = new Set<Socket>()
  let forced = false
  const emit = (event: string, peer: number) =>
    events.push({ event, at: gaTimestamp(), peer })
  const server =
    mode === 'connecting'
      ? createTcpServer()
      : createHttpsServer(
          {
            cert: readFileSync(files.certificate),
            key: readFileSync(files.key),
          },
          async (request, response) => {
            try {
              const body = await requestBody(request)
              requireCondition(
                GA_HOSTNAMES.includes(
                  String(request.headers.host) as (typeof GA_HOSTNAMES)[number],
                ),
                'Raw sender changed its pinned Host',
              )
              requireCondition(
                request.url === '/v1internal:streamGenerateContent?alt=sse',
                'Raw sender changed its pinned endpoint or port',
              )
              const peer = request.socket.remotePort ?? 0
              requests.push({
                body,
                rawHeaders: request.rawHeaders,
                receivedAt: gaTimestamp(),
                peer,
              })
              if (bodyHasPrimaryNonce(body, nonce)) emit('primary.parsed', peer)
              if (mode === 'pre-header') return
              response.writeHead(200, {
                'content-type': 'text/event-stream',
                'cache-control': 'no-cache',
              })
              const content = `data: ${JSON.stringify({ response: { candidates: [{ index: 0, content: { role: 'model', parts: [{ text: `GA_OK_${nonce}` }] } }] } })}\r\n\r\n`
              response.write(content)
              emit('content.sent', peer)
              if (mode === 'post-header') return
              response.end(
                `data: ${JSON.stringify({ response: { candidates: [{ index: 0, finishReason: 'STOP' }] } })}\r\n\r\n`,
              )
            } catch (error) {
              emit(
                `infrastructure.error:${String(error)}`,
                request.socket.remotePort ?? 0,
              )
              response.destroy(
                error instanceof Error ? error : new Error(String(error)),
              )
            }
          },
        )
  server.on('connection', (socket: Socket) => {
    sockets.add(socket)
    const peer = socket.remotePort ?? 0
    emit('tcp.accepted', peer)
    socket.on('close', () => {
      sockets.delete(socket)
      emit(forced ? 'forced.close' : 'peer.close', peer)
    })
    socket.on('error', (error) => emit(`socket.error:${error.message}`, peer))
  })
  if ('on' in server && mode !== 'connecting') {
    server.on('tlsClientError', (error: Error, socket: Socket) =>
      emit(`tls.error:${error.message}`, socket.remotePort ?? 0),
    )
  }
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(443, '127.0.0.1', resolveListen)
  })
  return {
    requests,
    events,
    get forced() {
      return forced
    },
    async close() {
      if (sockets.size > 0) {
        forced = true
        for (const socket of sockets) socket.destroy()
      }
      await new Promise<void>((resolveClose) =>
        server.close(() => resolveClose()),
      )
    },
  }
}

export interface GaProxyRecorder {
  url: string
  records: Array<{
    method: string
    target: string
    at: number
    tunnelPeer?: number
  }>
  close(): Promise<void>
}

export async function startGaProxyRecorder(): Promise<GaProxyRecorder> {
  const records: GaProxyRecorder['records'] = []
  const sockets = new Set<Duplex>()
  const server = createHttpServer((request, response) => {
    records.push({
      method: request.method ?? 'GET',
      target: request.url ?? '',
      at: gaTimestamp(),
    })
    response.writeHead(502)
    response.end('Synthetic recorder refuses HTTP proxy dispatch')
  })
  server.on('connect', (request, client, head) => {
    const target = request.url ?? ''
    if (!GA_HOSTNAMES.some((hostname) => target === `${hostname}:443`)) {
      records.push({ method: 'CONNECT', target, at: gaTimestamp() })
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n')
      return
    }
    const peer = createConnection({ host: '127.0.0.1', port: 443 })
    sockets.add(peer)
    sockets.add(client)
    peer.once('connect', () => {
      records.push({
        method: 'CONNECT',
        target,
        at: gaTimestamp(),
        tunnelPeer: peer.localPort,
      })
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) peer.write(head)
      client.pipe(peer)
      peer.pipe(client)
    })
    peer.once('error', () => client.destroy())
    client.once('error', () => peer.destroy())
    client.once('close', () => {
      sockets.delete(client)
      peer.destroy()
    })
    peer.once('close', () => {
      sockets.delete(peer)
      client.destroy()
    })
  })
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  requireCondition(
    address && typeof address !== 'string',
    'Missing proxy recorder port',
  )
  return {
    url: `http://127.0.0.1:${address.port}`,
    records,
    async close() {
      for (const socket of sockets) socket.destroy()
      server.closeAllConnections()
      await new Promise<void>((resolveClose) =>
        server.close(() => resolveClose()),
      )
    },
  }
}

export interface GaRecordedRequest {
  kind:
    | 'primary'
    | 'title'
    | 'compaction'
    | 'generate'
    | 'quota'
    | 'project'
    | 'unrelated'
    | 'direct-provider'
  body: string
  path: string
  authorization: string
  endpoint: string
}

export interface GaMock {
  url: string
  requests: GaRecordedRequest[]
  events: Array<{
    event: 'held-content' | 'peer-close' | 'forced-close'
    at: number
  }>
  close(): Promise<void>
}

function gaFrame(parts: unknown[], terminal = false): string {
  return `data: ${JSON.stringify({ response: { candidates: [{ index: 0, content: { role: 'model', parts }, ...(terminal ? { finishReason: 'STOP' } : {}) }], usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 2, totalTokenCount: 9 } } })}\r\n\r\n`
}

async function requestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk)
    size += bytes.length
    requireCondition(
      size <= 32 * 1024 * 1024,
      'Mock request body exceeded safety bound',
    )
    chunks.push(bytes)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Loopback mock of the Google endpoints that answers with each case's canned
 * responses. The real host and its own request path still run unchanged.
 */
export async function startGaMock(
  caseId: GaCaseId,
  nonce: string,
  repoRoot: string,
): Promise<GaMock> {
  const requests: GaRecordedRequest[] = []
  const events: GaMock['events'] = []
  const held = new Set<Socket>()
  let teardown = false
  let primaryCount = 0
  let titleCount = 0
  const canned =
    caseId === 'overflow-gemini' ||
    caseId === 'overflow-claude' ||
    caseId === 'title-overflow'
      ? loadGaOverflowFixture(
          repoRoot,
          caseId === 'overflow-claude' ? 'claude' : 'gemini',
        )
      : undefined
  const server = createHttpServer(async (request, response) => {
    try {
      const body = await requestBody(request)
      const path = request.url ?? '/'
      const kind = path.startsWith('/foreign/')
        ? 'unrelated'
        : path === '/loadCodeAssist'
          ? 'project'
          : path === '/agy/compaction'
            ? 'compaction'
            : path === '/agy/generate'
              ? 'generate'
              : path === '/agy/primary'
                ? 'primary'
                : path === '/agy/title'
                  ? 'title'
                  : path === '/quota'
                    ? 'quota'
                    : 'direct-provider'
      requests.push({
        kind,
        body,
        path,
        authorization: String(request.headers.authorization ?? ''),
        endpoint: String(request.headers['x-agy-endpoint'] ?? ''),
      })
      if (kind === 'unrelated') {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end(
          `data: ${JSON.stringify({ candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'UNRELATED_NATIVE_SUCCESS' }] }, finishReason: 'STOP' }] })}\r\n\r\n`,
        )
        return
      }
      if (kind === 'direct-provider') {
        response.writeHead(418, { 'content-type': 'application/json' })
        response.end(
          '{"error":{"message":"native driver bypassed Antigravity"}}',
        )
        return
      }
      if (kind === 'quota' || kind === 'project') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify({
            cloudaicompanionProject: 'synthetic-ga-project',
            currentTier: { id: 'free-tier' },
            models: {
              'gemini-3.5-flash': {
                quotaInfo: {
                  remainingFraction: 0.75,
                  resetTime: new Date(Date.now() + 3600000).toISOString(),
                },
              },
              'claude-sonnet-4-6': {
                quotaInfo: {
                  remainingFraction: 0.6,
                  resetTime: new Date(Date.now() + 3600000).toISOString(),
                },
              },
            },
          }),
        )
        return
      }
      if (kind === 'primary') primaryCount++
      const error = (status: number, message: string, reason?: string) => {
        response.writeHead(status, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify({
            error: {
              code: status,
              message,
              status:
                status === 401
                  ? 'UNAUTHENTICATED'
                  : status === 403
                    ? 'PERMISSION_DENIED'
                    : status === 429
                      ? 'RESOURCE_EXHAUSTED'
                      : 'UNAVAILABLE',
              ...(reason ? { details: [{ reason }] } : {}),
            },
          }),
        )
      }
      if (kind === 'title') titleCount++
      if (
        kind === 'title' &&
        caseId === 'title-primary-fallback' &&
        titleCount === 1
      ) {
        error(400, 'Title fixture refusal')
        return
      }
      if (
        canned &&
        ((kind === 'primary' && caseId !== 'title-overflow') ||
          (kind === 'title' && caseId === 'title-overflow'))
      ) {
        response.writeHead(canned.status, {
          'content-type': canned.contentType,
        })
        response.end(canned.bytes)
        return
      }
      if (kind === 'primary') {
        if (caseId === 'host-retryable-status') {
          error(500, 'GENUINE_HOST_RETRYABLE_FAILURE')
          return
        }
        if (caseId === 'transport-reset') {
          request.socket.destroy()
          return
        }
        if (caseId === 'validation-required' && primaryCount === 1) {
          error(403, 'Validation required', 'VALIDATION_REQUIRED')
          return
        }
        if (caseId === 'account-ineligible' && primaryCount === 1) {
          error(
            403,
            'Account is not eligible for Antigravity',
            'ACCOUNT_INELIGIBLE',
          )
          return
        }
        if (caseId === 'refresh-401' && primaryCount === 1) {
          error(401, 'Request had invalid authentication credentials.')
          return
        }
        if (caseId === 'quota-429' && primaryCount === 1) {
          error(429, 'Quota exhausted', 'QUOTA_EXHAUSTED')
          return
        }
        if (
          caseId === 'capacity-fallback' &&
          String(request.headers['x-agy-endpoint']).includes(
            'daily-cloudcode-pa.googleapis.com',
          )
        ) {
          error(503, 'Model capacity exhausted')
          return
        }
        if (caseId === 'overflow-changed-counts') {
          response.writeHead(400, { 'content-type': 'application/json' })
          response.end(
            JSON.stringify({
              error: {
                code: 400,
                status: 'INVALID_ARGUMENT',
                message:
                  'The input token count (999999) exceeds the maximum number of tokens allowed (1234).',
              },
            }),
          )
          return
        }
        if (caseId === 'overflow-nonmatching-400') {
          response.writeHead(400, { 'content-type': 'application/json' })
          response.end(
            JSON.stringify({
              error: {
                code: 400,
                status: 'INVALID_ARGUMENT',
                message:
                  'The input widget count (999999) exceeds the maximum number of widgets allowed (1234).',
              },
            }),
          )
          return
        }
      }
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
      })
      if (kind === 'title') {
        response.end(gaFrame([{ text: `GA_TITLE_${nonce}` }], true))
        return
      }
      if (
        caseId === 'sigint-natural-close' ||
        (caseId === 'pty-interrupt-recovery' && primaryCount === 2)
      ) {
        held.add(request.socket)
        request.socket.once('close', () => {
          held.delete(request.socket)
          events.push({
            event: teardown ? 'forced-close' : 'peer-close',
            at: gaTimestamp(),
          })
        })
        response.write(gaFrame([{ text: `GENUINE_HELD_${nonce}` }]))
        events.push({ event: 'held-content', at: gaTimestamp() })
        return
      }
      if (caseId === 'late-immediate-first-chunk-error') {
        response.end(
          gaFrame([{ text: `GENUINE_${nonce}` }]) +
            `data: ${JSON.stringify({ error: { code: 503, status: 'UNAVAILABLE', message: `GENUINE_FAILURE_${nonce}` } })}\r\n\r\n`,
        )
        return
      }
      if (caseId.startsWith('late-')) {
        if (caseId.endsWith('after-content'))
          response.write(gaFrame([{ text: `GENUINE_${nonce}` }]))
        if (caseId.startsWith('late-error'))
          response.write(
            `data: ${JSON.stringify({ error: { code: 503, status: 'UNAVAILABLE', message: `GENUINE_FAILURE_${nonce}` } })}\r\n\r\n`,
          )
        response.end()
        return
      }
      if (caseId === 'gemini-tools' || caseId === 'claude-tools') {
        if (primaryCount === 1) {
          const tools = record(record(JSON.parse(body)).request).tools
          requireCondition(
            Array.isArray(tools),
            'Native tool request has no tools',
          )
          const declarations = tools
            .flatMap((tool) => {
              const functions = record(tool).functionDeclarations
              return Array.isArray(functions) ? functions : []
            })
            .map(record)
          const read = declarations.find(
            (tool) => String(tool.name).toLowerCase() === 'read',
          )
          requireCondition(read, 'Native read tool is absent')
          const properties = record(record(read.parameters).properties)
          const argument = Object.hasOwn(properties, 'filePath')
            ? 'filePath'
            : Object.hasOwn(properties, 'path')
              ? 'path'
              : undefined
          requireCondition(
            argument,
            'Native read tool has no recognized file path argument',
          )
          response.end(
            gaFrame(
              [
                {
                  functionCall: {
                    name: read.name,
                    args: { [argument]: 'README.md' },
                  },
                  thoughtSignature: 's'.repeat(64),
                },
              ],
              true,
            ),
          )
          return
        }
      }
      if (caseId === 'image-permissions') {
        response.end(
          gaFrame(
            [
              {
                inlineData: {
                  mimeType: 'image/png',
                  data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/UcAAAAASUVORK5CYII=',
                },
              },
            ],
            true,
          ),
        )
        return
      }
      response.end(gaFrame([{ text: `GA_OK_${nonce}` }], true))
    } catch (error) {
      response.destroy(
        error instanceof Error ? error : new Error(String(error)),
      )
    }
  })
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  requireCondition(
    address && typeof address !== 'string',
    'Missing GA mock port',
  )
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    events,
    async close() {
      teardown = true
      server.closeAllConnections()
      await new Promise<void>((resolveClose) =>
        server.close(() => resolveClose()),
      )
    },
  }
}

export function seedGaHost(
  paths: GaPaths,
  wrapper: string,
  mockUrl: string,
  accountCount: 0 | 1 | 2 = 1,
): string {
  // Old-format account file used only as input to the account migration; the
  // host serves the migrated store. Runtime checks read accounts through the
  // state RPC and the menu, never from this file.
  const accountsFile = join(paths.opencodeConfig, 'antigravity-accounts.json')
  const now = Date.now()
  if (accountCount > 0)
    writeFileSync(
      accountsFile,
      JSON.stringify({
        version: 4,
        accounts: (accountCount === 2 ? ['A', 'B'] : ['A']).map(
          (label, index) => ({
            email: `synthetic-${label}@example.invalid`,
            label: `Synthetic fixture ${label}`,
            refreshToken: `synthetic-ga-refresh-${label}`,
            projectId: 'synthetic-ga-project',
            managedProjectId: 'synthetic-ga-project',
            addedAt: now + index,
            lastUsed: 0,
            enabled: true,
            rateLimitResetTimes: {},
          }),
        ),
        activeIndex: 0,
        activeIndexByFamily: { claude: 0, gemini: 0 },
      }),
      { mode: 0o600 },
    )
  writeFileSync(
    join(paths.opencodeConfig, 'opencode.json'),
    JSON.stringify({
      plugins: [wrapper],
      providers: {
        google: {
          settings: {
            apiKey: 'synthetic-ga-key',
            baseURL: `${mockUrl}/direct/v1`,
          },
        },
      },
    }),
    { mode: 0o600 },
  )
  writeFileSync(
    join(paths.project, 'README.md'),
    '# Synthetic GA tool fixture\n',
  )
  return accountsFile
}

export interface GaBinaryPin {
  schema: 1
  package: '@opencode/cli-linux-x64'
  version: '2.0.22'
  tarballURL: string
  sri: string
  binaryPath: 'package/bin/opencode'
  binarySha256: string
  binaryBytes: number
  elfMachine: 62
  platform: 'linux/amd64'
  reportedVersion: string
  runtime: { name: 'Bun'; version: string; revision: string }
  source: { repository: string; tag: string; commit: string }
  provenance: {
    artifact: string
    artifactRecordSha256: string
    runtime: string
    runtimeRecordSha256: string
    limits: string
  }
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): void {
  requireCondition(
    Object.keys(value).length === keys.length &&
      keys.every((key) => Object.hasOwn(value, key)),
    'Absent or unknown GA pin field',
  )
}

export function parseGaPin(input: unknown): GaBinaryPin {
  const value = record(input)
  exactKeys(value, [
    'schema',
    'package',
    'version',
    'tarballURL',
    'sri',
    'binaryPath',
    'binarySha256',
    'binaryBytes',
    'elfMachine',
    'platform',
    'reportedVersion',
    'runtime',
    'source',
    'provenance',
  ])
  requireCondition(
    value.schema === 1 &&
      value.package === '@opencode/cli-linux-x64' &&
      value.version === GA_VERSION &&
      value.platform === GA_PLATFORM &&
      value.elfMachine === 62 &&
      value.binaryPath === 'package/bin/opencode',
    'Wrong GA pin identity or architecture',
  )
  requireCondition(
    value.tarballURL ===
      'https://registry.npmjs.org/@opencode/cli-linux-x64/-/cli-linux-x64-2.0.22.tgz',
    'Wrong GA registry artifact URL',
  )
  requireCondition(
    typeof value.sri === 'string' &&
      /^sha512-[A-Za-z0-9+/]{86}==$/.test(value.sri),
    'Malformed GA pin SRI',
  )
  requireCondition(
    typeof value.binarySha256 === 'string' &&
      /^[a-f0-9]{64}$/.test(value.binarySha256) &&
      value.binaryBytes === 204482016,
    'Malformed GA pin executable digest or size',
  )
  requireCondition(
    value.reportedVersion === 'opencode v2.0.22',
    'Wrong GA pin reported version',
  )
  const runtime = record(value.runtime)
  const source = record(value.source)
  const provenance = record(value.provenance)
  exactKeys(runtime, ['name', 'version', 'revision'])
  exactKeys(source, ['repository', 'tag', 'commit'])
  exactKeys(provenance, [
    'artifact',
    'artifactRecordSha256',
    'runtime',
    'runtimeRecordSha256',
    'limits',
  ])
  requireCondition(
    runtime.name === 'Bun' &&
      runtime.version === '1.4.2' &&
      runtime.revision === '744846f844374847c902b5e7fd59b4342a51ef99',
    'Wrong GA pin runtime identity',
  )
  requireCondition(
    source.repository === 'https://github.com/anomalyco/opencode' &&
      source.tag === 'v2.0.22' &&
      source.commit === '527f0b931d1f9b3ebd34e106c51b31ce5db5b075',
    'Wrong GA pin source identity',
  )
  for (const key of ['artifact', 'runtime', 'limits'])
    requireCondition(
      typeof provenance[key] === 'string' && String(provenance[key]).length > 0,
      'Missing GA pin provenance',
    )
  for (const key of ['artifactRecordSha256', 'runtimeRecordSha256'])
    requireCondition(
      typeof provenance[key] === 'string' &&
        /^[a-f0-9]{64}$/.test(String(provenance[key])),
      'Malformed GA pin provenance digest',
    )
  return {
    schema: 1,
    package: '@opencode/cli-linux-x64',
    version: '2.0.22',
    tarballURL: String(value.tarballURL),
    sri: value.sri,
    binaryPath: 'package/bin/opencode',
    binarySha256: value.binarySha256,
    binaryBytes: 204482016,
    elfMachine: 62,
    platform: 'linux/amd64',
    reportedVersion: String(value.reportedVersion),
    runtime: {
      name: 'Bun',
      version: String(runtime.version),
      revision: String(runtime.revision),
    },
    source: {
      repository: String(source.repository),
      tag: String(source.tag),
      commit: String(source.commit),
    },
    provenance: {
      artifact: String(provenance.artifact),
      artifactRecordSha256: String(provenance.artifactRecordSha256),
      runtime: String(provenance.runtime),
      runtimeRecordSha256: String(provenance.runtimeRecordSha256),
      limits: String(provenance.limits),
    },
  }
}

export function readGaPin(repoRoot: string): GaBinaryPin {
  const path = join(repoRoot, GA_PIN_PATH)
  requireCondition(existsSync(path), `Missing tracked GA pin: ${GA_PIN_PATH}`)
  return parseGaPin(JSON.parse(readFileSync(path, 'utf8')))
}

async function prepareGaImage(repoRoot: string, prefix: string): Promise<void> {
  requireCondition(
    process.platform === 'linux' &&
      process.arch === 'x64' &&
      existsSync('/.dockerenv'),
    'Image preparation requires Linux amd64 Docker',
  )
  requireCondition(
    !existsSync(prefix) &&
      isAbsolute(prefix) &&
      !prefix.startsWith(`${repoRoot}/`),
    'Image consumer prefix must be fresh and outside the repository',
  )
  const pin = readGaPin(repoRoot)
  requireCondition(
    existsSync(join(repoRoot, GA_CONTRACT_PATH)),
    'Missing tracked GA contract note',
  )
  const response = await fetch(pin.tarballURL, {
    signal: AbortSignal.timeout(60_000),
    redirect: 'error',
  })
  requireCondition(response.ok, 'Pinned archive download failed')
  const archive = new Uint8Array(await response.arrayBuffer())
  const binary = verifiedArchiveMember(archive, pin.sri, pin.binaryPath)
  requireCondition(
    binary.length === pin.binaryBytes && sha256(binary) === pin.binarySha256,
    'Verified archive executable digest or length mismatch',
  )
  mkdirSync(prefix, { mode: 0o700 })
  const executable = join(prefix, 'opencode')
  writeFileSync(executable, binary, { mode: 0o700, flag: 'wx' })
  verifyExecutable(executable, pin.binarySha256, pin.elfMachine)
  // The package is packed from the repository build and installed into its
  // own prefix; the host never loads repository sources, and the plugin's
  // optional SDK and UI framework peers are not installed beside it.
  const env = {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: join(prefix, 'build-home'),
    XDG_CONFIG_HOME: join(prefix, 'build-config'),
    XDG_DATA_HOME: join(prefix, 'build-data'),
    XDG_STATE_HOME: join(prefix, 'build-state'),
    XDG_CACHE_HOME: join(prefix, 'build-cache'),
    TMPDIR: join(prefix, 'build-tmp'),
  }
  for (const path of Object.values(env).filter((path) => path !== env.PATH))
    mkdirSync(path, { recursive: true, mode: 0o700 })
  const pack = (directory: string, filename: string) => {
    const target = join(prefix, filename)
    execFileSync(
      '/usr/local/bin/bun',
      ['pm', 'pack', '--ignore-scripts', '--filename', target],
      {
        cwd: join(repoRoot, directory),
        env,
        stdio: 'pipe',
        timeout: 60_000,
      },
    )
    return target
  }
  const core = pack('packages/core', 'core.tgz')
  const plugin = pack('packages/opencode', 'plugin.tgz')
  writeFileSync(
    join(prefix, 'package.json'),
    JSON.stringify({ private: true, type: 'module' }),
  )
  execFileSync(
    '/usr/local/bin/npm',
    [
      'install',
      '--prefix',
      prefix,
      '--ignore-scripts',
      '--legacy-peer-deps',
      '--no-audit',
      '--no-fund',
      '--omit=optional',
      core,
      plugin,
    ],
    { cwd: prefix, env, stdio: 'pipe', timeout: 120_000 },
  )
  const entry = join(
    prefix,
    'node_modules',
    '@cortexkit',
    'opencode-antigravity-auth',
    'dist',
    'server.js',
  )
  requireCondition(
    existsSync(entry) && realpathSync(entry).startsWith(`${prefix}/`),
    'Missing actual packed GA facade',
  )
  for (const forbidden of [
    '@opencode',
    '@opencode-ai',
    'solid-js',
    '@opentui',
    'ga-opentui-core',
    'ga-opentui-solid',
    'ga-solid-js',
  ])
    requireCondition(
      !existsSync(join(prefix, 'node_modules', forbidden)),
      `Forbidden package-owned framework/SDK instance: ${forbidden}`,
    )
  writeFileSync(
    join(prefix, 'artifacts.json'),
    JSON.stringify({
      sourceRevision: process.env.GA_SOURCE_REVISION ?? null,
      pinSha256: sha256(readFileSync(join(repoRoot, GA_PIN_PATH))),
      contractSha256: sha256(readFileSync(join(repoRoot, GA_CONTRACT_PATH))),
      pluginSha256: sha256(readFileSync(plugin)),
      coreSha256: sha256(readFileSync(core)),
      binarySha256: pin.binarySha256,
    }),
    { flag: 'wx' },
  )
}

async function gaMain(): Promise<void> {
  const [mode, root, flag, inputPath, ...extra] = process.argv.slice(2)
  requireCondition(
    typeof root === 'string' && extra.length === 0,
    'Expected --prepare-image/--prepare-native <prefix> or --run <fresh-output-root> --inputs <repository-module>',
  )
  if (process.env.GA_CONTAINMENT_MODE === 'native-job') {
    requireCondition(
      process.env.ANTIGRAVITY_GA_HOST_EXECUTION === '1',
      'Native preparation/execution has not been admitted',
    )
    requireCondition(
      mode === '--prepare-native' || mode === '--run',
      'Native job cannot use online image preparation',
    )
    assertGaPinnedHostnameMappings(readFileSync('/etc/hosts', 'utf8'))
    const scratch = realpathSync(
      mkdtempSync(join(dirname(resolve(root)), 'ga-boundary-')),
    )
    const paths = prepareGaRoot(scratch)
    await measureNativeJob(
      realpathSync(resolve('.')),
      paths.temp,
      gaChildEnvironment(paths, process.env),
      `${resolve(root)}.boundary.json`,
    )
  }
  if (mode === '--prepare-native') {
    requireCondition(
      process.env.GA_CONTAINMENT_MODE === 'native-job' &&
        flag === undefined &&
        inputPath === undefined,
      'Native preparation requires the measured job path and no runtime inputs',
    )
    const { prepareNativeGaConsumer } = await import(
      './opencode-ga-host-inputs.ts'
    )
    await prepareNativeGaConsumer(realpathSync(resolve('.')), resolve(root))
    return
  }
  if (mode === '--prepare-image') {
    requireCondition(
      flag === undefined && inputPath === undefined,
      'Image preparation accepts no host/runtime inputs',
    )
    await prepareGaImage(resolve('.'), root)
    return
  }
  requireCondition(mode === '--run', 'Unknown GA harness command')
  requireCondition(
    process.env.ANTIGRAVITY_GA_HOST_EXECUTION === '1',
    'Actual host execution has not been admitted',
  )
  requireCondition(
    flag === '--inputs' && typeof inputPath === 'string',
    'Required approved account RPC/current-store/declaration/matrix input module is missing',
  )
  const repoRoot = realpathSync(resolve('.'))
  const modulePath = resolve(inputPath)
  requireCondition(
    modulePath.startsWith(`${repoRoot}/packages/`) &&
      realpathSync(modulePath) === modulePath &&
      !relative(repoRoot, modulePath)
        .split('/')
        .some((part) => part.startsWith('.')),
    'Host input must be an approved tracked package module, not ignored preparation context',
  )
  readGaPin(repoRoot)
  requireCondition(
    existsSync(join(repoRoot, GA_CONTRACT_PATH)),
    'Missing tracked GA contract note',
  )
  requireCondition(
    existsSync('packages/e2e-tests/docker/ga-proxy-env-matrix.json') &&
      existsSync(
        'packages/e2e-tests/docker/ga-proxy-env-matrix.provenance.json',
      ),
    'Verified native GA matrix/provenance join is required',
  )
  const supplied: unknown = await import(pathToFileURL(modulePath).href)
  const module = record(supplied)
  requireCondition(
    typeof module.createGaHostIntegrationInputs === 'function',
    'Approved module did not supply typed host integration inputs',
  )
  const inputs: unknown = await module.createGaHostIntegrationInputs()
  const boundary = record(inputs)
  requireCondition(
    typeof boundary.verifyConsumerBindings === 'function' &&
      typeof boundary.verifyNativeMatrix === 'function' &&
      typeof boundary.jobOwnershipSupplement === 'function',
    'Incomplete approved host/declaration/matrix input boundary',
  )
  const protocol = boundary.protocol ? record(boundary.protocol) : undefined
  requireCondition(
    protocol &&
      protocol.ANTIGRAVITY_RPC_ID === 'antigravity-auth' &&
      protocol.ANTIGRAVITY_RPC_VERSION === 1 &&
      [
        'stateCall',
        'applyCall',
        'readStateCallOutput',
        'readApplyCallOutput',
      ].every((name) => typeof protocol[name] === 'function'),
    'Actual portable protocol implementation/export join is missing',
  )
  const accounts = record(boundary.accounts)
  requireCondition(
    ['captureTarget', 'captureKillswitchOverride', 'applyCapturedTarget'].every(
      (name) => typeof accounts[name] === 'function',
    ),
    'Menu item capture is missing; redacted acct-<n> ids cannot stand in for menu-issued item ids',
  )
  requireCondition(
    [
      'seedCurrentStore',
      'assertCurrentStoreInput',
      'snapshot',
      'applyMenuAction',
      'assertNoPortOrSidebarFiles',
    ].every((name) => typeof accounts[name] === 'function'),
    'Actual account RPC/current-store input contract is incomplete',
  )
  // These checks only prove the functions exist. The protocol binding, menu
  // targeting and store seeding behind them live in opencode-ga-inputs.ts.
  await runGaFullDriver(root, inputs as GaHostIntegrationInputs)
}

if (import.meta.main)
  gaMain().catch((error: unknown) => {
    console.error(error)
    process.exitCode = 2
  })

export interface GaSenderSignalRecord {
  identity: number
  observedAt: number
  abortedAt?: number
  initiallyAborted: boolean
}

/**
 * Records the AbortSignal the production raw sender hands to its transport,
 * by adding an `abort` listener to that exact signal. The host Request's
 * signal and patched globals are not used: they could abort without the
 * sender's own request being cancelled.
 */
export function createGaSenderSignalObserver(): {
  observeRawSenderSignal: (signal: AbortSignal) => undefined
  records: GaSenderSignalRecord[]
  failures: string[]
  dispose: () => void
} {
  const records: GaSenderSignalRecord[] = []
  const failures: string[] = []
  const listeners = new Map<AbortSignal, () => void>()
  let disposed = false
  return {
    records,
    failures,
    observeRawSenderSignal(signal) {
      try {
        if (disposed) {
          failures.push('Observer invoked after teardown')
          return undefined
        }
        if (listeners.has(signal)) return undefined
        const observation: GaSenderSignalRecord = {
          identity: records.length + 1,
          observedAt: gaTimestamp(),
          initiallyAborted: signal.aborted,
        }
        const listener = () => {
          observation.abortedAt = gaTimestamp()
        }
        signal.addEventListener('abort', listener, { once: true })
        listeners.set(signal, listener)
        records.push(observation)
        if (signal.aborted) listener()
      } catch (error) {
        failures.push(String(error))
      }
      return undefined
    },
    dispose() {
      disposed = true
      for (const [signal, listener] of listeners)
        signal.removeEventListener('abort', listener)
      listeners.clear()
    },
  }
}

export interface GaRawCancelAssertion {
  name:
    | 'ga.raw-cancel.sender-signal-aborted'
    | 'ga.raw-cancel.peer-closed-before-teardown'
  passed: boolean
  observedAt: number | null
}

/** Always record BOTH independent outcomes before any deliberate fixture close. */
export async function collectGaRawCancelAssertions(input: {
  interruptedAt: number
  signals:
    | readonly GaSenderSignalRecord[]
    | (() => readonly GaSenderSignalRecord[])
  peerClosedAt: () => number | undefined
  forcedTeardown: () => boolean
}): Promise<GaRawCancelAssertion[]> {
  const deadline = input.interruptedAt + 2000
  while (gaTimestamp() < deadline) {
    const signals =
      typeof input.signals === 'function' ? input.signals() : input.signals
    if (
      signals.length === 1 &&
      signals[0]?.abortedAt !== undefined &&
      input.peerClosedAt() !== undefined
    )
      break
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10))
  }
  const signals =
    typeof input.signals === 'function' ? input.signals() : input.signals
  const aborted =
    signals.length === 1 && !signals[0]?.initiallyAborted
      ? signals[0]?.abortedAt
      : undefined
  const closed = input.peerClosedAt()
  const within = (time: number | undefined) =>
    time !== undefined && time >= input.interruptedAt && time <= deadline
  return [
    {
      name: 'ga.raw-cancel.sender-signal-aborted',
      passed: within(aborted),
      observedAt: aborted ?? null,
    },
    {
      name: 'ga.raw-cancel.peer-closed-before-teardown',
      passed: within(closed) && !input.forcedTeardown(),
      observedAt: closed ?? null,
    },
  ]
}

/**
 * Sources using the package's exported `GaPluginOverrides`. The synchronous
 * observer must compile; the async one must fail with exactly one type
 * error. Declarations that cannot be found are a setup failure, not that
 * expected type error.
 */
export function gaObserverTypeFixtures(): {
  synchronous: string
  asynchronous: string
} {
  const prefix =
    "import type { GaPluginOverrides } from '@cortexkit/opencode-antigravity-auth/server'\ntype Observer = NonNullable<GaPluginOverrides['observeRawSenderSignal']>\n"
  return {
    synchronous: `${prefix}const observer: Observer = (_signal) => undefined\nvoid observer\n`,
    asynchronous: `${prefix}const observer: Observer = async (_signal) => undefined\nvoid observer\n`,
  }
}

export function gaDetachedDispatchSignalMutation(source: string): {
  source: string
  line: number
  control: 'ga.raw-cancel.detached-dispatch-signal'
} {
  const tree = createSourceFile(
    'packed-server.js',
    source,
    ScriptTarget.ESNext,
    true,
    ScriptKind.JS,
  )
  const candidates: Array<{ statement: Node; options: string; scope: Node }> =
    []
  const observerAliases = new Set<string>(['observeRawSenderSignal'])
  const walk = (node: Node, visit: (node: Node) => void) => {
    visit(node)
    forEachChild(node, (child) => walk(child, visit))
  }
  walk(tree, (node) => {
    if (
      isVariableDeclaration(node) &&
      isIdentifier(node.name) &&
      node.initializer &&
      isPropertyAccessExpression(node.initializer) &&
      node.initializer.name.text === 'observeRawSenderSignal'
    )
      observerAliases.add(node.name.text)
  })
  walk(tree, (node) => {
    if (!isCallExpression(node)) return
    const callee = node.expression
    const name = isPropertyAccessExpression(callee)
      ? callee.name.text
      : isIdentifier(callee)
        ? callee.text
        : ''
    if (!observerAliases.has(name) || node.arguments.length !== 1) return
    const argument = node.arguments[0]
    if (
      !argument ||
      !isPropertyAccessExpression(argument) ||
      argument.name.text !== 'signal' ||
      !isIdentifier(argument.expression)
    )
      return
    if (!isExpressionStatement(node.parent)) return
    let scope: Node = node.parent
    while (scope.parent && !isFunctionLike(scope)) scope = scope.parent
    candidates.push({
      statement: node.parent,
      options: argument.expression.text,
      scope,
    })
  })
  requireCondition(
    candidates.length === 1,
    'Missing or ambiguous actual dispatch-signal observation binding',
  )
  const candidate = candidates[0]
  requireCondition(
    candidate,
    'Missing actual dispatch-signal observation binding',
  )
  let directDispatches = 0
  walk(candidate.scope, (node) => {
    if (!isCallExpression(node)) return
    const callee = node.expression
    const name = isPropertyAccessExpression(callee)
      ? callee.name.text
      : isIdentifier(callee)
        ? callee.text
        : ''
    if (
      (name === 'agyTransport' || name === 'fetchWithAgyCliTransport') &&
      node.arguments.some(
        (argument) =>
          isIdentifier(argument) && argument.text === candidate.options,
      )
    )
      directDispatches++
  })
  requireCondition(
    directDispatches === 1,
    'Observer and unchanged agyTransport do not share one dispatch-options object',
  )
  const position = candidate.statement.getStart(tree)
  return {
    source: `${source.slice(0, position)}${candidate.options}.signal = new AbortController().signal; // NON-VACUITY BREAK: detached actual dispatch signal\n${source.slice(position)}`,
    line: tree.getLineAndCharacterOfPosition(position).line + 1,
    control: 'ga.raw-cancel.detached-dispatch-signal',
  }
}

export function assertGaRawBindingControl(
  mutation: readonly GaRawCancelAssertion[],
  unaffected: {
    name: string
    completed: boolean
    primaryRequests: number
    infrastructureFailures: string[]
  },
): void {
  requireCondition(
    mutation.length === 2 &&
      mutation[0]?.name === 'ga.raw-cancel.sender-signal-aborted' &&
      mutation[1]?.name === 'ga.raw-cancel.peer-closed-before-teardown',
    'Missing independent raw binding assertions',
  )
  requireCondition(
    mutation.every(
      (assertion) =>
        assertion.passed === false && assertion.observedAt === null,
    ),
    'Detached binding did not redden both required mechanisms',
  )
  requireCondition(
    unaffected.name === 'ga.raw-cancel.uncancelled-request-completes' &&
      unaffected.completed &&
      unaffected.primaryRequests === 1 &&
      unaffected.infrastructureFailures.length === 0,
    'Unaffected request control did not complete without infrastructure failure',
  )
}

/** Calls the pinned host's documented HTTP API; it is not an SDK or fake host. */
export async function gaNativeRequest(
  url: string,
  method: string,
  path: string,
  body: unknown,
  status: number,
  empty = false,
  deadlineMs = 5000,
): Promise<unknown> {
  const origin = new URL(url)
  requireCondition(
    origin.protocol === 'http:' && origin.hostname === '127.0.0.1',
    'Native control must stay on owned IPv4 loopback',
  )
  const response = await fetch(new URL(path, url), {
    method,
    ...(body === undefined
      ? {}
      : {
          body: JSON.stringify(body),
          headers: { 'content-type': 'application/json' },
        }),
    signal: AbortSignal.timeout(deadlineMs),
  })
  const bytes = await response.text()
  requireCondition(
    response.status === status,
    `Native ${method} ${path} returned ${response.status}, expected ${status}: ${bytes}`,
  )
  if (empty) {
    requireCondition(
      bytes === '',
      'Native 204 operation unexpectedly returned a body',
    )
    return undefined
  }
  requireCondition(
    response.headers.get('content-type')?.includes('application/json'),
    'Native operation did not return JSON',
  )
  return JSON.parse(bytes)
}

export interface GaSessionRef {
  id: string
  directory: string
}
export function gaNativeControl(url: string) {
  return {
    async create(
      directory: string,
      model: string,
      title?: string,
      parentID?: string,
    ): Promise<GaSessionRef> {
      const [id, variant] = model.replace(/^google\//, '').split('#')
      requireCondition(id, 'Missing public catalog model')
      const result = record(
        await gaNativeRequest(
          url,
          'POST',
          '/api/session',
          {
            location: { directory },
            model: {
              id,
              providerID: 'google',
              ...(variant ? { variant } : {}),
            },
            ...(title ? { title } : {}),
            ...(parentID ? { parentID } : {}),
            permissions: [{ action: '*', resource: '*', effect: 'allow' }],
          },
          200,
        ),
      )
      const data = record(result.data)
      requireCondition(
        typeof data.id === 'string',
        'Native session.create returned no actual session id',
      )
      return { id: data.id, directory }
    },
    async prompt(session: GaSessionRef, text: string): Promise<void> {
      await gaNativeRequest(
        url,
        'POST',
        `/api/session/${encodeURIComponent(session.id)}/prompt`,
        { text },
        200,
      )
    },
    async compact(session: GaSessionRef): Promise<void> {
      await gaNativeRequest(
        url,
        'POST',
        `/api/session/${encodeURIComponent(session.id)}/compact`,
        {},
        200,
      )
    },
    async command(
      session: GaSessionRef,
      name: string,
      text = '',
    ): Promise<void> {
      await gaNativeRequest(
        url,
        'POST',
        `/api/session/${encodeURIComponent(session.id)}/command`,
        { name, text },
        204,
        true,
      )
    },
    async wait(session: GaSessionRef): Promise<void> {
      await gaNativeRequest(
        url,
        'POST',
        `/api/experimental/session/${encodeURIComponent(session.id)}/wait`,
        undefined,
        204,
        true,
        30_000,
      )
    },
    async interrupt(session: GaSessionRef): Promise<void> {
      await gaNativeRequest(
        url,
        'POST',
        `/api/session/${encodeURIComponent(session.id)}/interrupt`,
        undefined,
        200,
      )
    },
    async get(session: GaSessionRef): Promise<Record<string, unknown>> {
      return record(
        record(
          await gaNativeRequest(
            url,
            'GET',
            `/api/session/${encodeURIComponent(session.id)}`,
            undefined,
            200,
          ),
        ).data,
      )
    },
    async plugins(directory: string): Promise<unknown[]> {
      const result = record(
        await gaNativeRequest(
          url,
          'GET',
          `/api/plugin?${new URLSearchParams({ 'location[directory]': directory })}`,
          undefined,
          200,
        ),
      )
      requireCondition(
        Array.isArray(result.data),
        'Native plugin.list returned no inventory',
      )
      return result.data
    },
    async reloadAll(): Promise<void> {
      await gaNativeRequest(
        url,
        'POST',
        '/api/location/reload',
        undefined,
        204,
        true,
      )
    },
  }
}

export function gaDriverTypeFixture(): string {
  return `import { OpenCode } from '@opencode/client/promise'
const client = OpenCode.make({ baseUrl: 'http://127.0.0.1:1' })
export async function verifyTypes(sessionID: string, directory: string) {
  await client.session.create({ location: { directory }, model: { id: 'antigravity-gemini-3.5-flash', providerID: 'google' } })
  await client.session.prompt({ sessionID, text: 'synthetic source-only prompt' })
  await client.session.compact({ sessionID })
  await client.session.command({ sessionID, name: 'antigravity', text: '' })
  await client.session.interrupt({ sessionID })
  await client.session.wait({ sessionID })
  await client.plugin.list({ location: { directory } })
  await client.location.reload()
}
`
}

export function parseGaNativeJson(stdout: string): Record<string, unknown>[] {
  return stdout
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => record(JSON.parse(line)))
}
export function gaSessionErrors(stdout: string): Record<string, unknown>[] {
  return parseGaNativeJson(stdout)
    .filter((event) => event.type === 'error')
    .map((event) => {
      requireCondition(
        typeof event.sessionID === 'string',
        'Native JSON error has no sessionID',
      )
      const error = record(event.error)
      requireCondition(
        typeof error.type === 'string' && typeof error.message === 'string',
        'Malformed native session error envelope',
      )
      return error
    })
}

export interface GaHarness {
  paths: GaPaths
  nonce: string
  accountsMigrationInput: string
  mock: GaMock
  host: GaHostSession
  native: ReturnType<typeof gaNativeControl>
  executable: GaVerifiedExecutable
  rawPeer?: GaRawPeer
  tlsFiles?: GaTlsFiles
  proxyRecorder?: GaProxyRecorder
  readWrapperEvents(): Record<string, unknown>[]
  run(
    model: string,
    prompt?: string,
    continuation?: boolean,
    session?: GaSessionRef,
  ): Promise<GaRunResult>
  startPty(session: GaSessionRef): GaChild
  dispose(): Promise<void>
}

export async function createOpenCodeGaHarness(
  caseId: GaCaseId,
  outputRoot: string,
  options: {
    accounts?: GaAccountRpcJoin
    rawSender?: boolean
    rawTls?: {
      identity: 'matching' | 'wrong-san' | 'missing-san'
      phase: 'success' | 'connecting' | 'pre-header' | 'post-header'
      missingTrust?: boolean
      proxy?: boolean
    }
    trust?: string
    proxy?: Record<string, string>
    consumerPrefix?: string
  } = {},
): Promise<GaHarness> {
  const repoRoot = resolve('.')
  const { gaConsumerPrefix, gaInstalledServer } = await import(
    './opencode-ga-host-inputs.ts'
  )
  const prefix = options.consumerPrefix ?? gaConsumerPrefix()
  const pin = readGaPin(repoRoot)
  const root = realpathSync(mkdtempSync(join(outputRoot, `${caseId}-`)))
  const paths = prepareGaRoot(root)
  const nonce = newGaNonce()
  const executable: GaVerifiedExecutable = {
    path:
      process.env.GA_CONTAINMENT_MODE === 'native-job'
        ? join(
            prefix,
            'node_modules',
            ...pin.package.split('/'),
            'bin',
            'opencode',
          )
        : join(prefix, 'opencode'),
    sha256: pin.binarySha256,
    elfMachine: 62,
  }
  const mock = await startGaMock(caseId, nonce, repoRoot)
  let rawPeer: GaRawPeer | undefined
  let proxyRecorder: GaProxyRecorder | undefined
  let tlsFiles: GaTlsFiles | undefined
  let host: GaHostSession | undefined
  let disposed = false
  const cleanup = async () => {
    const failures: unknown[] = []
    for (const close of [
      async () => {
        if (!host) return
        const result = await host.close()
        writeFileSync(
          join(paths.state, 'serve-result.json'),
          JSON.stringify(result),
          { mode: 0o600 },
        )
      },
      () => mock.close(),
      () => proxyRecorder?.close(),
      () => rawPeer?.close(),
    ]) {
      try {
        await close()
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length) {
      writeFileSync(
        join(paths.state, 'cleanup-failures.json'),
        JSON.stringify(failures.map(String)),
        { mode: 0o600 },
      )
      throw new AggregateError(failures, 'GA host and peer cleanup failed')
    }
  }
  try {
    const startup = { trust: options.trust, proxy: options.proxy }
    if (options.rawTls) {
      assertGaPinnedHostnameMappings(readFileSync('/etc/hosts', 'utf8'))
      requireCondition(
        options.rawSender === true,
        'Raw TLS cases must omit send override',
      )
      tlsFiles = createGaTlsFiles(paths, options.rawTls.identity)
      rawPeer = await startGaRawPeer(tlsFiles, options.rawTls.phase, nonce)
      startup.trust = options.rawTls.missingTrust ? undefined : tlsFiles.ca
      if (options.rawTls.proxy) {
        proxyRecorder = await startGaProxyRecorder()
        startup.proxy = {
          HTTPS_PROXY: proxyRecorder.url,
          NO_PROXY: '127.0.0.1',
        }
      }
    }
    const wrapper = writeGaWrapper({
      paths,
      consumerPrefix: prefix,
      packedServerEntry: gaInstalledServer(prefix, 'import'),
      mockUrl: mock.url,
      rawSender: options.rawSender ?? false,
      duplicateCleanup: caseId === 'cleanup-idempotent',
    })
    const accountsMigrationInput = seedGaHost(
      paths,
      wrapper,
      mock.url,
      options.accounts
        ? 0
        : /account-ineligible|validation-required|quota-429|two-location|stale-handle|pty-command-account/.test(
              caseId,
            )
          ? 2
          : 1,
    )
    if (options.accounts) {
      await options.accounts.seedCurrentStore(paths, caseId, nonce)
      await options.accounts.assertCurrentStoreInput(paths)
    }
    execFileSync('/usr/bin/git', ['init', '-q'], {
      cwd: paths.project,
      env: gaChildEnvironment(paths, process.env),
      timeout: 5000,
    })
    host = await startGaHost(executable, paths, startup)
    const runningHost = host
    const readWrapperEvents = () =>
      existsSync(join(paths.state, 'wrapper.ndjson'))
        ? readFileSync(join(paths.state, 'wrapper.ndjson'), 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((line) => record(JSON.parse(line)))
        : []
    let runSequence = 0
    return {
      paths,
      nonce,
      accountsMigrationInput,
      mock,
      host: runningHost,
      native: gaNativeControl(runningHost.url),
      executable,
      rawPeer,
      tlsFiles,
      proxyRecorder,
      readWrapperEvents,
      async run(
        model,
        prompt = `Reply with GA_OK_${nonce}. Primary nonce ${nonce}`,
        continuation = false,
        session,
      ) {
        const result = session
          ? await launchGaHost(
              executable,
              paths,
              [
                'run',
                '--server',
                runningHost.url,
                '--format',
                'json',
                '--model',
                model,
                '--session',
                session.id,
                prompt,
              ],
              startup,
            ).result
          : await runningHost.run(model, prompt, continuation)
        writeFileSync(
          join(paths.state, `cli-run-${++runSequence}.json`),
          JSON.stringify(result),
          { mode: 0o600, flag: 'wx' },
        )
        requireCondition(
          !result.timedOut && !result.outputCapExceeded,
          'Native CLI run exceeded deadline',
        )
        assertGaDatabase(paths)
        const initialized = readWrapperEvents().filter(
          (event) => event.event === 'initialized',
        )
        requireCondition(
          initialized.length > 0,
          'Actual packed factory did not initialize',
        )
        for (const event of initialized) {
          const runtime = record(event.runtime)
          requireCondition(
            runtime.name === pin.runtime.name &&
              runtime.version === pin.runtime.version &&
              runtime.revision === pin.runtime.revision,
            'Pinned CLI runtime identity mismatch',
          )
        }
        requireCondition(
          mock.requests.every((request) => request.kind !== 'direct-provider'),
          'Real native Google driver bypassed Antigravity',
        )
        return result
      },
      startPty(session) {
        return launchGaHost(
          executable,
          paths,
          [
            '--server',
            runningHost.url,
            '--session',
            session.id,
            session.directory,
          ],
          { ...startup, pty: true, deadlineMs: 60_000 },
        )
      },
      async dispose() {
        if (disposed) return
        disposed = true
        await cleanup()
      },
    }
  } catch (error) {
    try {
      await cleanup()
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'GA setup and cleanup failed',
      )
    }
    throw error
  }
}

/**
 * Removes the plugin from session A's location by the id the host registered
 * it under, exercising the host's normal per-plugin removal rather than a
 * reload of every plugin.
 */
export async function removeGaProjectPlugin(
  harness: GaHarness,
  sessionA: GaSessionRef,
  sessionB: GaSessionRef,
): Promise<void> {
  const live = (events: Record<string, unknown>[]) =>
    events
      .filter((event) => event.event === 'initialized')
      .map((event) => String(event.scope))
  const before = live(harness.readWrapperEvents())
  requireCondition(
    before.length === 2,
    'Two native locations were not initialized in the same server',
  )
  const plugins = await harness.native.plugins(sessionA.directory)
  const plugin = plugins
    .map(record)
    .find((entry) => entry.id === 'antigravity-e2e-wrapper')
  requireCondition(
    plugin && typeof plugin.id === 'string',
    'Actual registered wrapper id is missing; npm name is not a removal target',
  )
  const config = join(sessionA.directory, 'opencode.json')
  ownedPath(harness.paths.root, config)
  const existing = existsSync(config)
    ? record(JSON.parse(readFileSync(config, 'utf8')))
    : {}
  const entries = Array.isArray(existing.plugins) ? existing.plugins : []
  writeFileSync(
    config,
    JSON.stringify({ ...existing, plugins: [...entries, `-${plugin.id}`] }),
    { mode: 0o600 },
  )
  await waitForGaObservation(
    () =>
      harness
        .readWrapperEvents()
        .some((event) => event.event === 'cleanup.end'),
    'natural A project-removal Cleanup',
    5000,
  )
  const after = harness.readWrapperEvents()
  requireCondition(
    after.filter((event) => event.event === 'cleanup.end').length === 1,
    'A-only removal disposed another location',
  )
  requireCondition(
    live(after).join(',') === before.join(','),
    'Project removal reactivated B or reloaded all locations',
  )
  const beforeRequests = harness.mock.requests.length
  await harness.native.prompt(sessionB, `B remains live ${harness.nonce}`)
  await harness.native.wait(sessionB)
  requireCondition(
    harness.mock.requests
      .slice(beforeRequests)
      .some(
        (request) =>
          request.kind === 'primary' &&
          bodyHasPrimaryNonce(request.body, harness.nonce),
      ),
    'B stopped dispatching after A scope removal',
  )
}

function writeGaTuiWrapper(wrapper: string, paths: GaPaths): void {
  const logPath = join(paths.state, 'tui.ndjson')
  const actions = join(paths.state, 'tui-actions.json')
  writeFileSync(actions, '{}', { mode: 0o600 })
  writeFileSync(
    join(wrapper, 'tui.js'),
    "export { default } from './tui-observer.ts'\n",
    { mode: 0o600 },
  )
  writeFileSync(
    join(wrapper, 'tui-observer.ts'),
    `import { appendFileSync, readFileSync } from 'node:fs'
import facade from '@cortexkit/opencode-antigravity-auth/tui'
const registry = crypto.randomUUID()
const log = (event: string, fields: object) => appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ event, registry, at: Number(process.hrtime.bigint() / 1000000n), ...fields }) + '\\n')
export default { ...facade, async setup(context: Parameters<typeof facade.setup>[0]) {
  log('ui.setup', { directory: context.location?.directory, route: context.ui.router.current() })
  const cleanup = await facade.setup(context)
  context.keymap.layer(() => ({ commands: [{ id: 'ga-host-switch-session', title: 'GA fixture session switch', slash: { name: 'ga-host-switch-session' }, run() {
    const input: unknown = JSON.parse(readFileSync(${JSON.stringify(actions)}, 'utf8'))
    if (input && typeof input === 'object' && 'sessionID' in input && typeof input.sessionID === 'string') {
      context.ui.router.navigate({ type: 'session', sessionID: input.sessionID })
      log('ui.navigate', { sessionID: input.sessionID })
    }
  } }] }))
  const timer = setInterval(() => log('ui.observation', { directory: context.location?.directory, route: context.ui.router.current(), commands: context.keymap.commands().map((command) => ({ id: command.id, title: command.title, slash: command.slash, shortcuts: command.id ? context.keymap.shortcuts(command.id) : [] })) }), 100)
  return async () => { clearInterval(timer); if (typeof cleanup === 'function') await cleanup(); log('ui.cleanup', { directory: context.location?.directory }) }
} }
`,
    { mode: 0o600 },
  )
}

function readGaLines(path: string): Record<string, unknown>[] {
  return existsSync(path)
    ? readFileSync(path, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => record(JSON.parse(line)))
    : []
}
export function gaPtyScreen(child: GaChild): string {
  return stripVTControlCharacters(child.output().stdout).replaceAll('\r', '')
}
export async function gaPtyCommand(
  child: GaChild,
  command: string,
  expected: RegExp,
): Promise<void> {
  const before = child.output().stdout.length
  child.process.stdin.write(`/${command}\r`)
  await waitForGaObservation(
    () => {
      requireCondition(
        child.process.exitCode === null && child.process.signalCode === null,
        'Real PTY exited instead of mounting a dialog',
      )
      const fresh = child.output().stdout.slice(before)
      return expected.test(stripVTControlCharacters(fresh))
    },
    `real PTY dialog for ${command}`,
    5000,
  )
  requireCondition(
    !/unsupported/i.test(child.output().stdout.slice(before)),
    'Native dialog reported unsupported instead of an effect',
  )
}

/**
 * Switches the TUI to session B through the public router, triggered by a
 * test-only slash command; `gaBuiltinSessionNavigation` covers the user's own
 * keystroke navigation separately.
 */
export async function gaSingleRegistrySwitch(
  harness: GaHarness,
  pty: GaChild,
  sessionB: GaSessionRef,
): Promise<void> {
  const path = join(harness.paths.state, 'tui.ndjson')
  const before = readGaLines(path)
  requireCondition(
    before.some((event) => event.event === 'ui.setup'),
    'Actual compiled TUI never mounted',
  )
  const registries = new Set(before.map((event) => event.registry))
  requireCondition(
    registries.size === 1,
    'Multiple native UI module registries before switch',
  )
  writeFileSync(
    join(harness.paths.state, 'tui-actions.json'),
    JSON.stringify({ sessionID: sessionB.id }),
    { mode: 0o600 },
  )
  const observationOffset = before.length
  pty.process.stdin.write('/ga-host-switch-session\r')
  await waitForGaObservation(
    () =>
      readGaLines(path)
        .slice(observationOffset)
        .some((event) => {
          const route =
            event.route === undefined ? undefined : record(event.route)
          return (
            event.event === 'ui.observation' &&
            event.directory === sessionB.directory &&
            route?.type === 'session' &&
            route.sessionID === sessionB.id
          )
        }),
    'single-process native session route recovers B location',
    5000,
  )
  const after = readGaLines(path)
  requireCondition(
    after.every((event) => registries.has(event.registry)),
    'Switching location reimported the TUI or created a second registry',
  )
  requireCondition(
    after.some(
      (event) =>
        event.event === 'ui.cleanup' && event.directory !== sessionB.directory,
    ),
    'A UI callbacks remained mounted after native rebind',
  )
  await gaPtyCommand(pty, 'antigravity', /Quota/)
}

/** Test view of one state read, joined with the account diagnostics recorded for the same read. */
export interface GaAccountObservation {
  rows: Array<{
    label: string
    publicId: string
    selector: string
    metadataStatus: import('../../opencode/src/ga/server/index.ts').HarnessMetadataStatus
    accessBlock: import('../../opencode/src/ga/server/index.ts').HarnessAccessBlock
    enabled: boolean
    current: boolean
    verificationRequired?: boolean
    accountIneligible?: boolean
    reason?: string
    geminiRemaining?: number
    nonGeminiRemaining?: number
  }>
  routing: string
  logging: unknown
  dump: unknown
  killswitch: unknown
  sidebarPullMs: number
}
/**
 * One account item as the `/antigravity` menu emitted it. `itemId` is the
 * opaque id the server issued for the row's exact credential. `selector` is
 * the same account's selector from the `state` RPC: an opaque value naming
 * its current credential, identical in the state answers read just before
 * and just after the menu was opened. `actions` lists the action ids the
 * item offered, so a later apply can only name one of them. The section
 * title, item label and action labels are the texts the TUI drawer shows for
 * them, used to choose the same entries by keystroke.
 */
export interface GaCapturedMenuItem {
  readonly generation: string
  readonly sectionId: string
  readonly itemId: string
  readonly selector: string
  readonly sectionTitle: string
  readonly itemLabel: string
  readonly actions: readonly string[]
  readonly actionLabels: Readonly<Record<string, string>>
}

/** The menu's answer to one apply: `code` is set when it refused. */
export interface GaMenuApplyOutcome {
  readonly ok: boolean
  readonly code?: string
  readonly text: string
}

export interface GaAccountRpcJoin {
  /**
   * Runs the real `/antigravity` command (by default through the host's
   * command route; a PTY case passes a keystroke runner) and returns the menu
   * it queued in the session's notifications.
   */
  openMenu(
    harness: GaHarness,
    session: GaSessionRef,
    runCommand?: () => Promise<void>,
  ): Promise<GaOpenedMenu>
  /**
   * Captures the emitted item for one account from `opened`, or from a menu
   * opened by the host's command route when `opened` is absent. `publicId`
   * is the account's `acct-<n>` id from the state answer; it only chooses the
   * row and is never sent back as a target.
   */
  captureTarget(
    harness: GaHarness,
    session: GaSessionRef,
    publicId: string,
    opened?: GaOpenedMenu,
  ): Promise<GaCapturedMenuItem>
  /**
   * Captures the account item's own quota floor action (`limit`): a
   * per-account minimum remaining quota that overrides the global killswitch
   * threshold for that account. Throws when the menu offers none; the
   * harness never builds a settings key from a credential instead.
   */
  captureKillswitchOverride(
    harness: GaHarness,
    session: GaSessionRef,
    publicId: string,
  ): Promise<
    GaCapturedMenuItem & { readonly actionId: string; readonly knobId: string }
  >
  /** Applies one action the captured item offered, by its server-issued item id. */
  applyCapturedTarget(
    harness: GaHarness,
    session: GaSessionRef,
    action: string,
    target: GaCapturedMenuItem,
    values?: Readonly<Record<string, string | number | boolean>>,
  ): Promise<GaMenuApplyOutcome>
  seedCurrentStore(
    paths: GaPaths,
    scenario: GaCaseId,
    nonce: string,
  ): Promise<void>
  assertCurrentStoreInput(paths: GaPaths): Promise<void>
  snapshot(
    harness: GaHarness,
    session: GaSessionRef,
  ): Promise<GaAccountObservation>
  /**
   * Runs a section-level action of the menu the real `/antigravity` command
   * emitted, found by the section's slot and the action's emitted id. Throws
   * unless the menu reports `ok`.
   */
  applyMenuAction(
    harness: GaHarness,
    session: GaSessionRef,
    slot: GaMenuSlot,
    actionId: string,
    values?: Readonly<Record<string, string | number | boolean>>,
  ): Promise<void>
  assertNoPortOrSidebarFiles(harness: GaHarness): Promise<void>
}

function publicGaModel(
  family: 'gemini' | 'claude' | 'image' = 'gemini',
): string {
  const ids = Object.keys(getPublicModelDefinitions())
  const id = ids.find((candidate) =>
    family === 'image'
      ? candidate.includes('flash-image')
      : family === 'claude'
        ? candidate.includes('claude') && candidate.includes('sonnet')
        : candidate.includes('gemini') && candidate.endsWith('-flash'),
  )
  requireCondition(id, `Public catalog has no ${family} test model`)
  return `google/${id}`
}

function gaPrimaryRequests(harness: GaHarness): GaRecordedRequest[] {
  return harness.mock.requests.filter((request) => request.kind === 'primary')
}
function assertGaSuccess(result: GaRunResult, nonce: string): void {
  requireCondition(
    result.code === 0 &&
      !result.timedOut &&
      !result.outputCapExceeded &&
      gaSessionErrors(result.stdout).length === 0 &&
      result.stdout.includes(`GA_OK_${nonce}`),
    'Actual native completion is missing',
  )
}
function assertGaWire(
  recorded: GaRecordedRequest,
  model: string,
): Record<string, unknown> {
  const [id, variant] = model.replace(/^google\//, '').split('#')
  requireCondition(id, 'Missing requested public model')
  const resolved = resolveModelForHeaderStyle(
    `${id}${variant ? `-${variant}` : ''}`,
    'antigravity',
  )
  const envelope = record(JSON.parse(recorded.body))
  requireCondition(
    envelope.model === resolved.actualModel &&
      envelope.userAgent === 'antigravity' &&
      envelope.requestType === 'agent',
    'Resolver-derived native wire identity changed',
  )
  const request = record(envelope.request)
  const labels = record(request.labels)
  requireCondition(
    labels.model_enum === getAgyModelEnum(resolved.actualModel),
    'Resolver-derived model label changed',
  )
  requireCondition(
    typeof request.sessionId === 'string' &&
      typeof labels.trajectory_id === 'string',
    'Native session wire metadata missing',
  )
  return request
}

export async function runGaCoreScenario(
  harness: GaHarness,
  id: GaCaseId,
  accounts?: GaAccountRpcJoin,
): Promise<void> {
  const model = publicGaModel(
    id === 'claude-tools' ||
      id === 'claude-thinking' ||
      id === 'overflow-claude'
      ? 'claude'
      : id === 'image-permissions'
        ? 'image'
        : 'gemini',
  )
  if (id === 'catalog-and-titles') {
    const definitions = getPublicModelDefinitions()
    requireCondition(
      Object.keys(definitions).length === 9,
      'Public catalog inventory changed without a reviewed host case update',
    )
    for (const [publicID, definition] of Object.entries(definitions)) {
      const variants = definition.variants
        ? Object.entries(definition.variants)
            .filter(([, value]) => !record(value).disabled)
            .map(([key]) => key)
        : []
      for (const variant of ['', ...variants]) {
        const selected = `google/${publicID}${variant ? `#${variant}` : ''}`
        const result = await harness.run(selected)
        assertGaSuccess(result, harness.nonce)
        const primary = gaPrimaryRequests(harness).at(-1)
        requireCondition(primary, 'Catalog request never reached the adapter')
        assertGaWire(primary, selected)
      }
    }
    requireCondition(
      harness.mock.requests.some((request) => request.kind === 'title'),
      'Catalog run observed no real title request',
    )
    requireCondition(
      harness.mock.requests
        .filter((request) => request.kind === 'title')
        .every(
          (request) =>
            record(JSON.parse(request.body)).model ===
            'gemini-3.5-flash-extra-low',
        ),
      'Title route changed or public title fallthrough occurred',
    )
    return
  }
  if (id === 'compaction') {
    const session = await harness.native.create(
      harness.paths.project,
      model,
      'Compaction fixture',
    )
    assertGaSuccess(
      await harness.run(model, undefined, false, session),
      harness.nonce,
    )
    await harness.native.compact(session)
    await harness.native.wait(session)
    assertGaSuccess(
      await harness.run(model, undefined, false, session),
      harness.nonce,
    )
    requireCondition(
      harness.mock.requests.some((request) => request.kind === 'compaction'),
      'Native scripted compaction did not dispatch',
    )
    requireCondition(
      !harness.host.server
        .output()
        .stderr.includes('Provider context is incompatible'),
      'Compaction changed native provider route provenance',
    )
    return
  }
  if (id === 'concurrent-sessions') {
    const sessions = await Promise.all(
      ['A', 'B'].map((title) =>
        harness.native.create(
          harness.paths.project,
          model,
          `Concurrent ${title}`,
        ),
      ),
    )
    const results = await Promise.all(
      sessions.map((session) => harness.run(model, undefined, false, session)),
    )
    for (const result of results) assertGaSuccess(result, harness.nonce)
    requireCondition(
      gaPrimaryRequests(harness).length === 2,
      'Concurrent native requests were lost or replayed',
    )
    return
  }
  const prompt =
    id === 'gemini-tools' || id === 'claude-tools'
      ? `Read README.md, then return GA_OK_${harness.nonce}. ${harness.nonce}`
      : undefined
  const result = await harness.run(model, prompt)
  const primary = gaPrimaryRequests(harness)
  requireCondition(primary.length > 0, 'No actual primary scenario observation')
  if (id.startsWith('late-')) {
    requireCondition(
      primary.length === 1,
      'Late failure replayed the primary request',
    )
    const failure =
      id.startsWith('late-error') || id === 'late-immediate-first-chunk-error'
        ? `GENUINE_FAILURE_${harness.nonce}`
        : 'Antigravity stream ended before a terminal frame'
    requireCondition(
      gaSessionErrors(result.stdout).some(
        (error) =>
          error.type === 'provider.transport' &&
          error.status === 200 &&
          error.message ===
            `Connection lost while reading the response: ${failure}`,
      ),
      'Exact native late-error contract was not observed',
    )
    requireCondition(
      !parseGaNativeJson(result.stdout).some(
        (event) =>
          event.type !== 'error' && JSON.stringify(event).includes(failure),
      ),
      'Failure was synthesized as model text',
    )
    return
  }
  if (
    id.startsWith('overflow-') ||
    id === 'transport-reset' ||
    id === 'host-retryable-status'
  ) {
    requireCondition(
      gaSessionErrors(result.stdout).length > 0 && result.code !== 0,
      'Failure did not reach native JSON session error state',
    )
    requireCondition(
      primary.length ===
        (id === 'transport-reset' || id === 'host-retryable-status' ? 2 : 1),
      'Terminal failure changed v1 endpoint/attempt counts',
    )
    if (id === 'overflow-gemini' || id === 'overflow-claude') {
      const fixture = loadGaOverflowFixture(
        resolve('.'),
        id === 'overflow-gemini' ? 'gemini' : 'claude',
      )
      const observed = harness
        .readWrapperEvents()
        .filter((event) => event.event === 'native.400')
      requireCondition(
        observed.length === 1 &&
          observed[0]?.status === fixture.status &&
          observed[0]?.contentType === fixture.contentType &&
          observed[0]?.bytes === fixture.bytes.toString('base64') &&
          observed[0]?.contextErrorHeader === null,
        'Overflow was not forwarded byte-for-byte at the native response observation point',
      )
    }
    return
  }
  if (id === 'image-permissions') {
    requireCondition(
      result.code === 0 && result.stdout.includes('Antigravity image saved:'),
      'Native image completion/saved-image annotation missing',
    )
    const directory = join(harness.paths.home, '.opencode', 'generated-images')
    ownedPath(harness.paths.root, directory)
    const files = readdirSync(directory)
    requireCondition(
      files.length === 1 &&
        (statSync(directory).mode & 0o777) === 0o700 &&
        (statSync(join(directory, files[0]!)).mode & 0o777) === 0o600,
      'Image persistence permissions or file count changed',
    )
    requireCondition(
      readFileSync(join(directory, files[0]!))
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
      'Actual inline image bytes were not persisted',
    )
    const request = record(record(JSON.parse(primary[0]!.body)).request)
    requireCondition(
      request.tools === undefined &&
        request.toolConfig === undefined &&
        record(request.generationConfig).thinkingConfig === undefined,
      'Image request retained incompatible tools/thinking',
    )
    return
  }
  assertGaSuccess(result, harness.nonce)
  if (id === 'gemini-tools' || id === 'claude-tools') {
    requireCondition(
      primary.length === 2,
      'Native tool continuation did not execute exactly once',
    )
    const request = assertGaWire(primary[1]!, model)
    requireCondition(
      Array.isArray(request.contents),
      'Native tool continuation contents missing',
    )
    const contents = request.contents.map(record)
    const parts = contents.flatMap((content) =>
      Array.isArray(content.parts) ? content.parts.map(record) : [],
    )
    requireCondition(
      parts.some(
        (part) => part.functionCall && part.thoughtSignature === 's'.repeat(64),
      ),
      'Native tool signature was lost',
    )
    requireCondition(
      contents.some(
        (content) =>
          content.role === 'model' &&
          Array.isArray(content.parts) &&
          content.parts.some((part) => record(part).functionResponse),
      ),
      'Function response lost native model role',
    )
    requireCondition(
      JSON.stringify(contents.at(-1)) ===
        JSON.stringify({ role: 'user', parts: [{ text: '[Continue]' }] }),
      'Native continuation turn changed',
    )
    requireCondition(
      record(request.labels).last_step_index === String(parts.length) &&
        String(record(JSON.parse(primary[1]!.body)).requestId).endsWith(
          `/${parts.length + 1}`,
        ),
      'Tool-step labels/requestId changed',
    )
  } else if (id === 'claude-thinking') {
    const request = assertGaWire(primary[0]!, model)
    requireCondition(
      record(record(request.generationConfig).thinkingConfig).thinkingBudget ===
        1024,
      'Native Claude thinking budget changed',
    )
    requireCondition(
      record(request.generationConfig).maxOutputTokens === 64_000 &&
        request.providerOptions === undefined,
      'Native Claude output/options changed',
    )
  } else if (id === 'capacity-fallback') {
    requireCondition(
      primary.length === 3 &&
        primary[0]?.endpoint === 'https://daily-cloudcode-pa.googleapis.com' &&
        primary[1]?.endpoint === 'https://daily-cloudcode-pa.googleapis.com' &&
        primary[2]?.endpoint === 'https://cloudcode-pa.googleapis.com',
      'Capacity fallback no longer follows v1 endpoint order',
    )
  } else if (id === 'validation-required' || id === 'account-ineligible') {
    requireCondition(
      accounts,
      'Actual native account RPC schema/method join is missing',
    )
    const event = harness
      .readWrapperEvents()
      .find(
        (entry) => entry.event === 'native.request' && entry.kind === 'primary',
      )
    requireCondition(
      event && typeof event.sessionID === 'string',
      'Native account scenario session is missing',
    )
    const snapshot = await accounts.snapshot(harness, {
      id: event.sessionID,
      directory: harness.paths.project,
    })
    requireCondition(
      snapshot.rows.some(
        (row) =>
          !row.enabled &&
          (id === 'validation-required'
            ? row.verificationRequired &&
              !row.accountIneligible &&
              Boolean(row.reason)
            : row.accountIneligible && row.reason === 'account-ineligible'),
      ),
      'Actual account capability did not record the required access block',
    )
    requireCondition(
      primary.length === 2 &&
        primary[0]?.authorization !== primary[1]?.authorization,
      'Blocked account did not rotate using v1 counts',
    )
  } else {
    assertGaWire(primary[0]!, model)
    requireCondition(
      record(
        record(record(record(JSON.parse(primary[0]!.body)).request).toolConfig)
          .functionCallingConfig,
      ).mode === 'VALIDATED',
      'Native tool configuration missing',
    )
  }
}

export async function runGaUnrelatedResponse(
  harness: GaHarness,
): Promise<void> {
  const directory = join(harness.paths.root, 'foreign-project')
  ownedPath(harness.paths.root, directory)
  mkdirSync(directory, { mode: 0o700 })
  writeFileSync(
    join(directory, 'opencode.json'),
    JSON.stringify({
      providers: {
        google: {
          settings: { baseURL: `${harness.mock.url}/foreign/v1` },
          models: {
            'ga-unregistered-fixture': {
              name: 'Unrelated native Google fixture',
            },
          },
        },
      },
    }),
    { mode: 0o600 },
  )
  const session = await harness.native.create(
    directory,
    'google/ga-unregistered-fixture',
    'Unrelated fixed title',
  )
  const [owned, foreign] = await Promise.all([
    harness.run(publicGaModel()),
    harness.run(
      'google/ga-unregistered-fixture',
      `Unrelated ${harness.nonce}`,
      false,
      session,
    ),
  ])
  requireCondition(
    gaSessionErrors(owned.stdout).some(
      (error) => error.type === 'provider.transport' && error.status === 200,
    ),
    'Owned genuine failure did not reach native transport state',
  )
  requireCondition(
    foreign.code === 0 &&
      gaSessionErrors(foreign.stdout).length === 0 &&
      foreign.stdout.includes('UNRELATED_NATIVE_SUCCESS'),
    'Foreign native response or error state was changed',
  )
  requireCondition(
    harness.mock.requests.filter((request) => request.kind === 'unrelated')
      .length === 1,
    'Unrelated native request was replayed or rewritten',
  )
}

export function gaRawSignalRecords(harness: GaHarness): GaSenderSignalRecord[] {
  const records = new Map<string, GaSenderSignalRecord>()
  for (const event of harness.readWrapperEvents()) {
    if (event.event === 'raw.observer.failure')
      throw new Error(`Actual raw observer failed: ${String(event.message)}`)
    const key = `${event.scope}:${event.identity}`
    if (event.event === 'raw.signal.observed') {
      requireCondition(
        typeof event.at === 'number' &&
          typeof event.identity === 'number' &&
          typeof event.initiallyAborted === 'boolean' &&
          !records.has(key),
        'Ambiguous actual sender-signal observation',
      )
      records.set(key, {
        identity: event.identity,
        observedAt: event.at,
        initiallyAborted: event.initiallyAborted,
      })
    } else if (event.event === 'raw.signal.aborted') {
      const signal = records.get(key)
      requireCondition(
        signal && typeof event.at === 'number',
        'Abort transition has no actual sender-signal identity',
      )
      signal.abortedAt = event.at
    }
  }
  return [...records.values()]
}

export async function runGaRawCancellation(
  harness: GaHarness,
  phase: 'connecting' | 'pre-header' | 'post-header',
  detachedControl = false,
): Promise<GaRawCancelAssertion[]> {
  const peer = harness.rawPeer
  requireCondition(peer, 'Missing real 443 raw TCP/TLS fixture')
  const session = await harness.native.create(
    harness.paths.project,
    publicGaModel(),
    'Cancellation fixed title',
  )
  const pending = harness.run(
    publicGaModel(),
    `Primary cancellation nonce ${harness.nonce}`,
    false,
    session,
  )
  await waitForGaObservation(
    () => {
      const signals = gaRawSignalRecords(harness)
      requireCondition(
        signals.length <= 1,
        'Raw cancellation sender observation is ambiguous',
      )
      return (
        signals.length === 1 &&
        peer.events.some(
          (event) =>
            event.event ===
            (phase === 'connecting'
              ? 'tcp.accepted'
              : phase === 'pre-header'
                ? 'primary.parsed'
                : 'content.sent'),
        )
      )
    },
    `genuine ${phase} raw-sender barrier`,
    10_000,
  )
  const accepted = peer.events.find(
    (event) =>
      event.event ===
      (phase === 'connecting' ? 'tcp.accepted' : 'primary.parsed'),
  )
  requireCondition(accepted, 'Missing accepted primary raw peer')
  const target = accepted.peer
  const interruptedAt = gaTimestamp()
  const infrastructure: string[] = []
  const interrupt = harness.native
    .interrupt(session)
    .catch((error: unknown) => {
      infrastructure.push(String(error))
    })
  const assertions = await collectGaRawCancelAssertions({
    interruptedAt,
    signals: () => gaRawSignalRecords(harness),
    peerClosedAt: () =>
      peer.events.find(
        (event) => event.event === 'peer.close' && event.peer === target,
      )?.at,
    forcedTeardown: () => peer.forced,
  })
  writeFileSync(
    join(harness.paths.state, 'raw-cancel-assertions.json'),
    JSON.stringify({
      phase,
      interruptedAt,
      assertions,
      events: peer.events,
      senderSignals: gaRawSignalRecords(harness),
    }),
    { mode: 0o600 },
  )
  // raw-cancel-assertions.json is already written above with the sender's
  // AbortSignal records and the mock peer's close events, so a failure here
  // still leaves that evidence on disk.
  requireCondition(
    infrastructure.length === 0,
    'Unrelated interrupt failure is not a binding proof',
  )
  if (detachedControl) {
    requireCondition(
      phase === 'pre-header' &&
        assertions.every(
          (assertion) => !assertion.passed && assertion.observedAt === null,
        ),
      'Detached dispatch binding did not redden both pre-header mechanisms',
    )
    // Both independent records are already retained. Only now release the held
    // peer so the intentionally detached sender and interrupt can finish.
    await peer.close()
    await interrupt
    await pending
    return assertions
  }
  requireCondition(
    assertions.every((assertion) => assertion.passed),
    'Raw cancellation did not observe both required mechanisms before teardown',
  )
  await interrupt
  requireCondition(
    infrastructure.length === 0,
    'Native interrupt did not complete',
  )
  const result = await pending
  writeFileSync(
    join(harness.paths.state, 'interrupt-result.json'),
    JSON.stringify(result),
    { mode: 0o600 },
  )
  requireCondition(
    !peer.forced && !result.timedOut && !result.outputCapExceeded,
    'A forced fixture/supervisor close is not cancellation proof',
  )
  requireCondition(
    phase !== 'connecting' || peer.requests.length === 0,
    'Connecting cancellation emitted AGY application bytes',
  )
  requireCondition(
    phase !== 'post-header' ||
      peer.events.some(
        (event) =>
          event.event === 'content.sent' &&
          event.peer === target &&
          event.at <= interruptedAt,
      ),
    'Post-header proof lacks genuine content',
  )
  if (harness.proxyRecorder) {
    requireCondition(
      harness.proxyRecorder.records.some(
        (record) =>
          record.method === 'CONNECT' &&
          record.tunnelPeer === target &&
          GA_HOSTNAMES.some((hostname) => record.target === `${hostname}:443`),
      ),
      'Raw cancellation proxy tunnel was not tied to the accepted peer',
    )
  }
  return assertions
}

export async function runGaRawTlsCase(
  harness: GaHarness,
  negative: boolean,
): Promise<GaTlsTrace> {
  const peer = harness.rawPeer
  requireCondition(
    peer && harness.tlsFiles,
    'Missing real pinned-name/443 TLS fixture or startup trust input',
  )
  const session = await harness.native.create(
    harness.paths.project,
    publicGaModel(),
    'TLS fixed title',
  )
  const result = await harness.run(publicGaModel(), undefined, false, session)
  const primaryBodies = peer.requests
    .filter((request) => bodyHasPrimaryNonce(request.body, harness.nonce))
    .map((request) => request.body)
  const errors = gaSessionErrors(result.stdout)
  if (negative)
    requireCondition(
      result.code !== 0 && peer.requests.length === 0 && errors.length > 0,
      'TLS negative accepted/decrypted application bytes or lacked native error state',
    )
  else {
    assertGaSuccess(result, harness.nonce)
    requireCondition(
      primaryBodies.length === 1 && errors.length === 0,
      'Missing unique nonce-matched raw TLS primary positive',
    )
    for (const request of peer.requests)
      requireCondition(
        !request.rawHeaders.some(
          (header, index) =>
            index % 2 === 0 &&
            /^(x-opencode-session|x-opencode-parent-session-id|x-session-affinity|x-session-id|x-parent-session-id)$/i.test(
              header,
            ),
        ),
        'Native session headers leaked to raw AGY',
      )
    if (harness.proxyRecorder) {
      const request = peer.requests.find((request) =>
        bodyHasPrimaryNonce(request.body, harness.nonce),
      )
      requireCondition(
        request &&
          harness.proxyRecorder.records.filter(
            (record) =>
              record.method === 'CONNECT' && record.tunnelPeer === request.peer,
          ).length === 1,
        'Untied or title-only CONNECT cannot prove raw primary proxy routing',
      )
    }
  }
  return { nonce: harness.nonce, primaryBodies, nativeErrors: errors }
}

export async function runGaTitleScenario(
  harness: GaHarness,
  id: 'title-off-catalog' | 'title-primary-fallback' | 'title-overflow',
): Promise<void> {
  if (id === 'title-off-catalog') {
    const configPath = join(harness.paths.opencodeConfig, 'opencode.json')
    const config = record(JSON.parse(readFileSync(configPath, 'utf8')))
    const providers = record(config.providers)
    const google = record(providers.google)
    writeFileSync(
      configPath,
      JSON.stringify({
        ...config,
        agents: { title: { model: 'google/gemini-flash-lite-latest' } },
        providers: {
          ...providers,
          google: {
            ...google,
            models: {
              'gemini-flash-lite-latest': { name: 'Off-catalog title fixture' },
            },
          },
        },
      }),
      { mode: 0o600 },
    )
  }
  const session = await harness.native.create(
    harness.paths.project,
    publicGaModel(),
  )
  const before = await harness.native.get(session)
  assertGaSuccess(
    await harness.run(publicGaModel(), undefined, false, session),
    harness.nonce,
  )
  await harness.native.wait(session)
  const titles = harness.mock.requests.filter(
    (request) => request.kind === 'title',
  )
  const observed = harness
    .readWrapperEvents()
    .filter(
      (event) => event.event === 'native.request' && event.kind === 'title',
    )
  requireCondition(
    titles.length > 0 &&
      titles.length <= 2 &&
      titles.every(
        (request) =>
          record(JSON.parse(request.body)).model ===
          'gemini-3.5-flash-extra-low',
      ),
    'Native titles did not use the exact resolver-derived AGY title wire model',
  )
  if (id === 'title-off-catalog')
    requireCondition(
      observed.some((event) => event.model === 'gemini-flash-lite-latest'),
      'Configured off-catalog title reference was not actually dispatched',
    )
  if (id === 'title-primary-fallback')
    requireCondition(
      titles.length === 2 &&
        observed.length === 2 &&
        observed[0]?.model !== observed[1]?.model,
      'Actual title fallback did not use the differing primary reference',
    )
  if (id === 'title-overflow') {
    const after = await harness.native.get(session)
    requireCondition(
      after.title === before.title,
      'Failed native title changed the session title',
    )
    const fixture = loadGaOverflowFixture(resolve('.'), 'gemini')
    requireCondition(
      harness
        .readWrapperEvents()
        .filter((event) => event.event === 'native.400')
        .every(
          (event) =>
            event.status === 400 &&
            event.contentType === fixture.contentType &&
            event.bytes === fixture.bytes.toString('base64'),
        ),
      'Title overflow bytes were not preserved',
    )
  }
}

export function gaProxyScenarioEnvironment(
  id: GaCaseId,
  recorderA: string,
  recorderB: string,
): { env: Record<string, string>; passing: boolean } {
  switch (id) {
    case 'proxy-trigger-a':
    case 'packed-proxy-fail':
      return { env: { HTTP_PROXY: recorderA }, passing: false }
    case 'proxy-trigger-b':
      return {
        env: {
          HTTP_PROXY: recorderA,
          ALL_PROXY: recorderB,
          NO_PROXY: '127.0.0.1',
        },
        passing: false,
      }
    case 'proxy-trigger-c':
      return {
        env: { HTTP_PROXY: 'not-a-proxy-url', NO_PROXY: '127.0.0.1' },
        passing: false,
      }
    case 'proxy-trigger-d':
      return {
        env: { HTTP_PROXY: recorderA, NO_PROXY: '127.0.0.0/8' },
        passing: false,
      }
    case 'proxy-quoted-http-double':
      return { env: { HTTP_PROXY: recorderA, http_proxy: '""' }, passing: true }
    case 'proxy-quoted-http-single':
      return { env: { HTTP_PROXY: recorderA, http_proxy: "''" }, passing: true }
    case 'proxy-quoted-HTTP-double':
      return {
        env: { HTTP_PROXY: '""', http_proxy: recorderA },
        passing: false,
      }
    case 'proxy-quoted-no-double-HTTP':
      return {
        env: { HTTP_PROXY: recorderA, NO_PROXY: '127.0.0.1', no_proxy: '""' },
        passing: false,
      }
    case 'proxy-quoted-no-single-HTTP':
      return {
        env: { HTTP_PROXY: recorderA, NO_PROXY: '127.0.0.1', no_proxy: "''" },
        passing: false,
      }
    case 'proxy-quoted-no-double-http':
      return {
        env: { http_proxy: recorderA, NO_PROXY: '127.0.0.1', no_proxy: '""' },
        passing: false,
      }
    case 'proxy-quoted-no-single-http':
      return {
        env: { http_proxy: recorderA, NO_PROXY: '127.0.0.1', no_proxy: "''" },
        passing: false,
      }
    case 'proxy-raw-empty-fallthrough':
      return {
        env: {
          HTTP_PROXY: recorderA,
          http_proxy: '',
          NO_PROXY: '127.0.0.1',
          no_proxy: '',
        },
        passing: true,
      }
    case 'proxy-comma-exclusion':
    case 'packed-proxy-pass':
      return {
        env: { HTTP_PROXY: recorderA, NO_PROXY: 'example.com,127.0.0.1' },
        passing: true,
      }
    case 'proxy-wildcard':
      return { env: { HTTP_PROXY: recorderA, NO_PROXY: '*' }, passing: true }
    case 'proxy-no-proxy':
      return { env: {}, passing: true }
    default:
      throw new Error(`Unknown effective proxy scenario: ${id}`)
  }
}

export async function runGaProxyScenario(
  id: GaCaseId,
  out: string,
  accounts: GaAccountRpcJoin,
): Promise<GaHarness> {
  const a = await startGaProxyRecorder()
  const b = await startGaProxyRecorder()
  let harness: GaHarness | undefined
  try {
    const scenario = gaProxyScenarioEnvironment(id, a.url, b.url)
    const original = JSON.stringify(scenario.env)
    harness = await createOpenCodeGaHarness(id, out, {
      proxy: scenario.env,
      accounts,
    })
    const result = await harness.run(publicGaModel())
    requireCondition(
      JSON.stringify(scenario.env) === original,
      'Harness proxy environment changed during native dispatch',
    )
    requireCondition(
      a.records.length === 0 && b.records.length === 0,
      'Recorder saw a loopback dispatch/CONNECT despite guard/exclusion',
    )
    if (scenario.passing) {
      assertGaSuccess(result, harness.nonce)
      requireCondition(
        gaPrimaryRequests(harness).length === 1,
        'Passing proxy case lacks its actual primary rewrite',
      )
    } else {
      requireCondition(
        gaSessionErrors(result.stdout).some(
          (error) =>
            error.type === 'unknown' &&
            String(error.message).includes('NO_PROXY=127.0.0.1'),
        ),
        'Failing proxy case did not produce the documented native hook-stop error',
      )
      requireCondition(
        gaPrimaryRequests(harness).length === 0 &&
          !harness
            .readWrapperEvents()
            .some((event) => event.event === 'send.start'),
        'Failing guard dialed an upstream socket or rewrote the request',
      )
    }
    writeFileSync(
      join(harness.paths.state, 'proxy-evidence.json'),
      JSON.stringify({
        environment: scenario.env,
        original,
        recorderA: a.records,
        recorderB: b.records,
        result,
      }),
      { mode: 0o600 },
    )
    return harness
  } catch (error) {
    await harness?.dispose()
    throw error
  } finally {
    await a.close()
    await b.close()
  }
}

export async function runGaDetachedBindingControl(
  out: string,
  accounts: GaAccountRpcJoin,
): Promise<GaHarness> {
  const prefix = realpathSync(
    mkdtempSync(join(out, 'detached-dispatch-consumer-')),
  )
  cpSync('/opt/ga-consumer', prefix, { recursive: true, dereference: false })
  const entry = join(
    prefix,
    'node_modules',
    '@cortexkit',
    'opencode-antigravity-auth',
    'dist',
    'server.js',
  )
  ownedPath(prefix, entry)
  const original = readFileSync(entry, 'utf8')
  const mutation = gaDetachedDispatchSignalMutation(original)
  let mutated: GaHarness | undefined
  let unaffected: GaHarness | undefined
  let assertions: GaRawCancelAssertion[] = []
  try {
    writeFileSync(entry, mutation.source, { mode: 0o600 })
    requireCondition(
      sha256(Buffer.from(mutation.source)) !== sha256(Buffer.from(original)),
      'Detached binding control did not actually mutate the packed facade',
    )
    mutated = await createOpenCodeGaHarness(
      'raw-cancel-pre-header-direct',
      out,
      {
        consumerPrefix: prefix,
        accounts,
        rawSender: true,
        rawTls: { identity: 'matching', phase: 'pre-header' },
      },
    )
    assertions = await runGaRawCancellation(mutated, 'pre-header', true)
    writeFileSync(
      join(mutated.paths.state, 'binding-mutation.json'),
      JSON.stringify({
        control: mutation.control,
        line: mutation.line,
        beforeSha256: sha256(Buffer.from(original)),
        duringSha256: sha256(Buffer.from(mutation.source)),
        assertions,
      }),
      { mode: 0o600 },
    )
  } finally {
    await mutated?.dispose()
    writeFileSync(entry, original, { mode: 0o600 })
    requireCondition(
      readFileSync(entry, 'utf8') === original,
      'Packed binding mutation was not restored',
    )
  }
  try {
    unaffected = await createOpenCodeGaHarness('tls-positive-after', out, {
      consumerPrefix: prefix,
      accounts,
      rawSender: true,
      rawTls: { identity: 'matching', phase: 'success' },
    })
    const trace = await runGaRawTlsCase(unaffected, false)
    assertGaRawBindingControl(assertions, {
      name: 'ga.raw-cancel.uncancelled-request-completes',
      completed: trace.nativeErrors.length === 0,
      primaryRequests: trace.primaryBodies.length,
      infrastructureFailures: [],
    })
    writeFileSync(
      join(unaffected.paths.state, 'unaffected-control.json'),
      JSON.stringify({
        name: 'ga.raw-cancel.uncancelled-request-completes',
        trace,
        restoredSha256: sha256(Buffer.from(original)),
      }),
      { mode: 0o600 },
    )
    return unaffected
  } catch (error) {
    await unaffected?.dispose()
    throw error
  }
}

export async function runGaPtyScenario(
  harness: GaHarness,
  id: GaCaseId,
  accounts: GaAccountRpcJoin,
): Promise<void> {
  const sessionA = await harness.native.create(
    harness.paths.project,
    publicGaModel(),
    'PTY A fixed title',
  )
  assertGaSuccess(
    await harness.run(publicGaModel(), undefined, false, sessionA),
    harness.nonce,
  )
  const pty = harness.startPty(sessionA)
  const capture = join(harness.paths.state, 'pty-result.json')
  try {
    await waitForGaObservation(
      () =>
        /antigravity/i.test(gaPtyScreen(pty)) &&
        readGaLines(join(harness.paths.state, 'tui.ndjson')).some(
          (event) => event.event === 'ui.setup',
        ),
      'compiled GA sidebar mounted in real PTY',
      10_000,
    )
    const initial = await accounts.snapshot(harness, sessionA)
    requireCondition(
      initial.rows.length > 0 &&
        initial.rows.every((row) => row.publicId.length > 0) &&
        initial.sidebarPullMs > 0,
      'Native sidebar lacks real account state/pull timing',
    )
    requireCondition(
      /\b75\s*%/.test(gaPtyScreen(pty)) || /\b60\s*%/.test(gaPtyScreen(pty)),
      'Import-only TUI did not mount mock quota state',
    )
    await accounts.assertNoPortOrSidebarFiles(harness)
    if (id.startsWith('pty-two-location') || id === 'pty-stale-handle-reload') {
      const directoryB = join(harness.paths.root, 'project-b')
      ownedPath(harness.paths.root, directoryB)
      mkdirSync(directoryB, { mode: 0o700 })
      writeFileSync(join(directoryB, 'README.md'), '# B fixture\n')
      const sessionB = await harness.native.create(
        directoryB,
        publicGaModel(),
        'PTY B fixed title',
      )
      assertGaSuccess(
        await harness.run(publicGaModel(), undefined, false, sessionB),
        harness.nonce,
      )
      if (id === 'pty-two-location-dispose') {
        await removeGaProjectPlugin(harness, sessionA, sessionB)
        await gaSingleRegistrySwitch(harness, pty, sessionB)
      } else {
        const before = await accounts.snapshot(harness, sessionB)
        // The PTY is still on session A: disable the last enabled account
        // through A's drawer and expect B, which shares the account store, to
        // see it. The first account stays as it is for the stale-handle and
        // reauthorization steps below.
        const toggled = [...before.rows].reverse().find((row) => row.enabled)
        requireCondition(toggled, 'Two-location case has no enabled account')
        const openedA = await accounts.openMenu(harness, sessionA, () =>
          gaPtyCommand(pty, 'antigravity', /Accounts/),
        )
        const toggledItem = await accounts.captureTarget(
          harness,
          sessionA,
          toggled.publicId,
          openedA,
        )
        await gaPtyRunMenuAction(pty, openedA, 'accounts', 'disable', {
          itemLabel: toggledItem.itemLabel,
        })
        await waitForGaObservation(
          async () =>
            JSON.stringify(await accounts.snapshot(harness, sessionB)) !==
            JSON.stringify(before),
          'A real account dialog change reaches B within one sidebar pull',
          initial.sidebarPullMs,
        )
        pty.process.stdin.write('\x1b')
        if (id === 'pty-two-location-rebind') {
          await gaBuiltinSessionNavigation(harness, pty, sessionB)
          writeFileSync(
            join(harness.paths.state, 'tui-actions.json'),
            JSON.stringify({ sessionID: sessionA.id }),
            { mode: 0o600 },
          )
          const returnOffset = readGaLines(
            join(harness.paths.state, 'tui.ndjson'),
          ).length
          pty.process.stdin.write('/ga-host-switch-session\r')
          await waitForGaObservation(
            () =>
              readGaLines(join(harness.paths.state, 'tui.ndjson'))
                .slice(returnOffset)
                .some(
                  (event) =>
                    event.event === 'ui.observation' &&
                    record(event.route).sessionID === sessionA.id,
                ),
            'fixture returns to A before separately labelled router proof',
          )
        }
        await gaSingleRegistrySwitch(harness, pty, sessionB)
        if (id === 'pty-two-location-oauth-bearer')
          await gaPtyReauthorize(harness, pty, sessionB, accounts)
        if (id.includes('settings')) {
          const a = await accounts.snapshot(harness, sessionA)
          const openedB = await accounts.openMenu(harness, sessionB, () =>
            gaPtyCommand(pty, 'antigravity', /Routing/),
          )
          await gaPtyRunMenuAction(pty, openedB, 'routing', 'set', {
            answer: gaChangeFirstInput(),
          })
          await waitForGaObservation(
            async () =>
              (await accounts.snapshot(harness, sessionB)).routing !==
              before.routing,
            'B routing change from the drawer',
          )
          const changed = await accounts.snapshot(harness, sessionB)
          const afterA = await accounts.snapshot(harness, sessionA)
          requireCondition(
            id.includes('shared')
              ? afterA.routing === changed.routing
              : afterA.routing === a.routing,
            'Settings crossed the wrong location/controller boundary',
          )
        }
        if (id === 'pty-stale-handle-reload') {
          const target = before.rows[0]
          requireCondition(target, 'Stale-handle case has no row target')
          // Sessions A and B are in different project directories, so each
          // opens its own location's menu. B captures the account's item while
          // the account is enabled (so `disable` is one of its actions); after
          // A removes the account, B's captured item must be refused.
          const expectedTarget = await accounts.captureTarget(
            harness,
            sessionB,
            target.publicId,
          )
          const removalTarget = await accounts.captureTarget(
            harness,
            sessionA,
            target.publicId,
          )
          requireCondition(
            expectedTarget.actions.includes('disable'),
            'Stale-handle target was not an enabled account item',
          )
          const removed = await accounts.applyCapturedTarget(
            harness,
            sessionA,
            'remove',
            removalTarget,
          )
          requireCondition(
            removed.ok,
            `Account removal was refused: ${removed.code ?? removed.text}`,
          )
          const stale = await accounts.applyCapturedTarget(
            harness,
            sessionB,
            'disable',
            expectedTarget,
          )
          requireCondition(
            !stale.ok &&
              (stale.code === 'unavailable' || stale.code === 'stale-account'),
            'Removed account item was applied instead of refused as stale',
          )
          const afterRemoval = await accounts.snapshot(harness, sessionB)
          requireCondition(
            afterRemoval.rows.every(
              (row) => row.selector !== expectedTarget.selector,
            ),
            'Removed account is still listed after its stale item was refused',
          )
        }
      }
      assertGaSuccess(
        await harness.run(publicGaModel(), undefined, false, sessionB),
        harness.nonce,
      )
    } else if (id === 'pty-reauthorize-listener') {
      await gaPtyReauthorize(harness, pty, sessionA, accounts)
    } else if (id === 'pty-interrupt-recovery') {
      pty.process.stdin.write(`Hold this stream ${harness.nonce}\r`)
      await waitForGaObservation(
        () => gaPrimaryRequests(harness).length >= 2,
        'PTY primary genuinely started',
      )
      pty.process.stdin.write('\x1b')
      requireCondition(
        pty.process.exitCode === null,
        'PTY interrupt killed the process',
      )
      assertGaSuccess(
        await harness.run(publicGaModel(), undefined, false, sessionA),
        harness.nonce,
      )
    } else {
      // The six former slash commands are now sections of the one
      // /antigravity menu. Each pty-command-* case runs one real action of
      // its section through the drawer and expects a state change.
      const before = await accounts.snapshot(harness, sessionA)
      const opened = await accounts.openMenu(harness, sessionA, () =>
        gaPtyCommand(pty, 'antigravity', /Accounts/),
      )
      if (id.startsWith('pty-command-')) {
        const command = id.slice('pty-command-'.length)
        if (command === 'account') {
          const toggled = [...before.rows].reverse().find((row) => row.enabled)
          requireCondition(toggled, 'Account case has no enabled account')
          const item = await accounts.captureTarget(
            harness,
            sessionA,
            toggled.publicId,
            opened,
          )
          await gaPtyRunMenuAction(pty, opened, 'accounts', 'disable', {
            itemLabel: item.itemLabel,
          })
        } else {
          const actions: Record<string, [GaMenuSlot, string]> = {
            quota: ['quota', 'refresh'],
            routing: ['routing', 'set'],
            killswitch: ['limits', 'set'],
            logging: ['diagnostics', 'logging'],
            dump: ['diagnostics', 'dump'],
          }
          const chosen = actions[command]
          requireCondition(chosen, `No menu action is mapped for ${id}`)
          await gaPtyRunMenuAction(pty, opened, chosen[0], chosen[1], {
            answer: gaChangeFirstInput(),
          })
        }
        await waitForGaObservation(
          async () =>
            JSON.stringify(await accounts.snapshot(harness, sessionA)) !==
            JSON.stringify(before),
          'native dialog command applies a real next-request state effect',
          5000,
        )
      }
      if (id === 'pty-credential-redaction') {
        for (const secret of [
          'synthetic-A@example.invalid',
          'synthetic-ga-refresh-A',
          'synthetic-ga-project',
          'Synthetic fixture A',
        ])
          requireCondition(
            !gaPtyScreen(pty).includes(secret) &&
              !harness.host.server.output().stderr.includes(secret),
            `Private fixture field leaked into native UI/log: ${secret}`,
          )
      }
      pty.process.stdin.write('\x1b')
      assertGaSuccess(
        await harness.run(publicGaModel(), undefined, false, sessionA),
        harness.nonce,
      )
    }
    await accounts.assertNoPortOrSidebarFiles(harness)
  } finally {
    pty.signal('SIGTERM')
    const result = await pty.result
    writeFileSync(capture, JSON.stringify(result), { mode: 0o600 })
    requireCondition(
      !result.timedOut && !result.outputCapExceeded,
      'PTY fixture survived until supervisor deadline',
    )
  }
}

/**
 * Every action createAntigravityCommandMenu (packages/core) can put on an
 * account item: enable or disable, select for routing, remove, the
 * per-account quota floor (`limit`) and `reauthorize`. A test in
 * opencode-ga-inputs.test.ts fails if the real menu offers any other one, so
 * a new account action cannot go unnoticed by these cases.
 */
export const GA_KNOWN_ACCOUNT_ITEM_ACTIONS = new Set([
  'enable',
  'disable',
  'select',
  'remove',
  'limit',
  'reauthorize',
])

/**
 * The account-item action that signs the same Google account in again and
 * replaces exactly that item's saved credential. The Accounts section's
 * `add` signs in a new account instead and is never used for this.
 */
export const GA_REAUTHORIZE_ACTION = 'reauthorize'

function gaLiteral(text: string): RegExp {
  return new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
}

/**
 * Chooses one entry in the TUI drawer's current list by typing its exact
 * title into the list's filter and pressing Enter, then waits for `next` in
 * the output written after the keystrokes.
 */
async function gaPtyChoose(
  pty: GaChild,
  title: string,
  next: RegExp,
): Promise<void> {
  const before = pty.output().stdout.length
  pty.process.stdin.write(`${title}\r`)
  await waitForGaObservation(
    () => {
      requireCondition(
        pty.process.exitCode === null && pty.process.signalCode === null,
        'Real PTY exited inside the /antigravity drawer',
      )
      return next.test(
        stripVTControlCharacters(pty.output().stdout.slice(before)),
      )
    },
    `drawer entry "${title}"`,
    5000,
  )
}

type GaMenuKnob = GaMenuSection['actions'][number]['knobs'][number]

/**
 * Answers for a drawer action's choice and toggle inputs: the first one is
 * changed (the other toggle position, or the first choice that differs from
 * the current value), every later one keeps its current value. The answers
 * are the option titles the drawer lists: `On`/`Off` for a toggle and the
 * choice's label for a choice.
 */
export function gaChangeFirstInput(): (knob: GaMenuKnob) => string {
  let changed = false
  return (knob) => {
    const change = !changed
    changed = true
    if (knob.kind === 'toggle')
      return (change ? !knob.value : knob.value) ? 'On' : 'Off'
    if (knob.kind === 'choice') {
      const pick = knob.choices.find((choice) =>
        change ? choice.value !== knob.value : choice.value === knob.value,
      )
      requireCondition(pick, `Choice input ${knob.label} has no usable option`)
      return pick.label
    }
    requireCondition(false, `Input ${knob.label} is not a choice or toggle`)
  }
}

/**
 * Runs one action through the TUI drawer the real `/antigravity` command
 * opened, choosing the section, the account item (when `itemLabel` is
 * given) and the action by the titles the server put in `opened.menu`.
 * Each choice or toggle input is answered by `answer`; number and text
 * inputs keep the value the drawer pre-fills. Actions that ask for a
 * confirmation are refused here: the drawer's confirm dialog is not driven.
 */
export async function gaPtyRunMenuAction(
  pty: GaChild,
  opened: GaOpenedMenu,
  slot: GaMenuSlot,
  actionId: string,
  options: {
    itemLabel?: string
    answer?: (knob: GaMenuKnob) => string
  } = {},
): Promise<void> {
  const sections = opened.menu.sections.filter((entry) => entry.slot === slot)
  const section = sections[0]
  requireCondition(
    section && sections.length === 1,
    `The /antigravity menu has no single ${slot} section`,
  )
  const item =
    options.itemLabel === undefined
      ? undefined
      : section.items.find((entry) => entry.label === options.itemLabel)
  requireCondition(
    options.itemLabel === undefined || item,
    `The ${slot} section has no item ${options.itemLabel}`,
  )
  const action = (item ? item.actions : section.actions).find(
    (entry) => entry.id === actionId,
  )
  requireCondition(
    action,
    `Missing capability: the ${slot} section offers no ${actionId} action`,
  )
  requireCondition(
    action.confirm === undefined,
    `Action ${actionId} asks for a confirmation the PTY driver does not answer`,
  )
  await gaPtyChoose(
    pty,
    section.title,
    gaLiteral(item ? item.label : action.label),
  )
  if (item) await gaPtyChoose(pty, item.label, gaLiteral(action.label))
  const knobs = action.knobs
  if (knobs.length === 0) {
    pty.process.stdin.write(`${action.label}\r`)
    return
  }
  await gaPtyChoose(pty, action.label, gaLiteral(knobs[0]?.label ?? ''))
  for (const [index, knob] of knobs.entries()) {
    const nextLabel = knobs[index + 1]?.label
    const typed =
      knob.kind === 'choice' || knob.kind === 'toggle'
        ? options.answer?.(knob)
        : ''
    requireCondition(
      typed !== undefined,
      `No answer for the ${knob.label} input of ${actionId}`,
    )
    if (nextLabel === undefined) pty.process.stdin.write(`${typed}\r`)
    else await gaPtyChoose(pty, typed, gaLiteral(nextLabel))
  }
}

/**
 * A blocked account is one disabled because Google asked for verification
 * or reported it ineligible. The case opens the real `/antigravity` drawer
 * in the PTY and chooses that same account's Reauthorize action. It answers
 * the browser sign-in through the plugin's own callback listener, then
 * checks that the account row was replaced in place (same position, new
 * credential, block cleared, no account added) and that the next request
 * uses the new access token. When the item offers no Reauthorize action the
 * case fails as a missing capability; it never falls back to adding an
 * account.
 */
async function gaPtyReauthorize(
  harness: GaHarness,
  pty: GaChild,
  session: GaSessionRef,
  accounts: GaAccountRpcJoin,
): Promise<void> {
  const before = await accounts.snapshot(harness, session)
  const blockedIndex = before.rows.findIndex(
    (row) =>
      !row.enabled && (row.verificationRequired || row.accountIneligible),
  )
  const blocked = before.rows[blockedIndex]
  requireCondition(
    blocked,
    'Reauthorization case requires an actually blocked account',
  )
  const opened = await accounts.openMenu(harness, session, () =>
    gaPtyCommand(pty, 'antigravity', /Accounts/),
  )
  const target = await accounts.captureTarget(
    harness,
    session,
    blocked.publicId,
    opened,
  )
  const unrecognized = target.actions.filter(
    (action) => !GA_KNOWN_ACCOUNT_ITEM_ACTIONS.has(action),
  )
  writeFileSync(
    join(harness.paths.state, 'reauthorize-menu-actions.json'),
    JSON.stringify({
      sessionID: session.id,
      selector: target.selector,
      offered: target.actions,
      unrecognized,
    }),
    { mode: 0o600 },
  )
  requireCondition(
    target.actions.includes(GA_REAUTHORIZE_ACTION),
    `Missing capability: the blocked account's menu item offers no ${GA_REAUTHORIZE_ACTION} action (offered: ${target.actions.join(', ')})`,
  )
  const authorizeOffset = harness
    .readWrapperEvents()
    .filter((event) => event.event === 'oauth.authorize').length
  await gaPtyRunMenuAction(pty, opened, 'accounts', GA_REAUTHORIZE_ACTION, {
    itemLabel: target.itemLabel,
  })
  await waitForGaObservation(
    () =>
      /Waiting for the browser/.test(gaPtyScreen(pty)) &&
      harness
        .readWrapperEvents()
        .filter((event) => event.event === 'oauth.authorize').length >
        authorizeOffset,
    'Reauthorize from the drawer started a browser sign-in',
  )
  const authorization = harness
    .readWrapperEvents()
    .filter((event) => event.event === 'oauth.authorize')
    .at(-1)
  requireCondition(
    authorization && typeof authorization.state === 'string',
    'Wrapper authorize did not record the sign-in state',
  )
  const response = await fetch(
    `http://127.0.0.1:51121/oauth-callback?${new URLSearchParams({ code: 'synthetic-ga-code', state: authorization.state })}`,
    { signal: AbortSignal.timeout(2000) },
  )
  requireCondition(
    response.ok,
    'The plugin callback listener did not accept the matching state',
  )
  await waitForGaObservation(
    async () => {
      const after = await accounts.snapshot(harness, session)
      const row = after.rows[blockedIndex]
      return (
        after.rows.length === before.rows.length &&
        row !== undefined &&
        row.selector !== blocked.selector &&
        after.rows.every((entry) => entry.selector !== blocked.selector) &&
        row.enabled &&
        row.verificationRequired === false &&
        row.accountIneligible === false
      )
    },
    'reauthorization replaced the same account in place and cleared its block',
    5000,
  )
  const beforeCalls = gaPrimaryRequests(harness).length
  assertGaSuccess(
    await harness.run(publicGaModel(), undefined, false, session),
    harness.nonce,
  )
  requireCondition(
    gaPrimaryRequests(harness)
      .slice(beforeCalls)
      .some((request) =>
        request.authorization.includes('synthetic-ga-reauthorized-access'),
      ),
    'Next request did not use the reauthorized account bearer',
  )
}

export async function runGaLifecycleScenario(
  harness: GaHarness,
  id: GaCaseId,
  accounts: GaAccountRpcJoin,
  protocol?: GaPortableProtocol,
): Promise<void> {
  const a = await harness.native.create(
    harness.paths.project,
    publicGaModel(),
    'Lifecycle A',
  )
  const bDirectory = join(harness.paths.root, 'lifecycle-b')
  ownedPath(harness.paths.root, bDirectory)
  mkdirSync(bDirectory, { mode: 0o700 })
  const b = await harness.native.create(
    bDirectory,
    publicGaModel(),
    'Lifecycle B',
  )
  assertGaSuccess(
    await harness.run(publicGaModel(), undefined, false, a),
    harness.nonce,
  )
  assertGaSuccess(
    await harness.run(publicGaModel(), undefined, false, b),
    harness.nonce,
  )
  const rpc = protocol
    ? createGaProtocolClient(protocol, harness.host.url)
    : undefined
  const states = rpc
    ? await Promise.all([rpc.state(a), rpc.state(b)])
    : undefined
  if (protocol && states)
    assertGaScopedSnapshots(
      protocol,
      states[0]!.snapshot,
      states[1]!.snapshot,
      a,
      b,
    )
  const owner = harness
    .readWrapperEvents()
    .find(
      (event) =>
        event.event === 'native.request' &&
        event.sessionID === a.id &&
        event.kind === 'primary',
    )
  requireCondition(
    owner && typeof owner.url === 'string' && typeof owner.scope === 'string',
    'Actual A bridge location/job was not observed',
  )
  const before = harness
    .readWrapperEvents()
    .filter((event) => event.event === 'initialized')
    .map((event) => event.scope)
  if (id === 'cleanup-reload') {
    await harness.native.reloadAll()
    await waitForGaObservation(
      () =>
        harness
          .readWrapperEvents()
          .filter((event) => event.event === 'cleanup.end').length ===
        before.length,
      'reload-all invokes each native Promise-adapter Cleanup',
    )
  } else {
    await removeGaProjectPlugin(harness, a, b)
  }
  const cleanup = harness
    .readWrapperEvents()
    .find(
      (event) => event.event === 'cleanup.end' && event.scope === owner.scope,
    )
  requireCondition(
    cleanup && typeof cleanup.at === 'number',
    'Initialized A did not naturally invoke returned Cleanup',
  )
  let refused = false
  try {
    await fetch(new URL('/', owner.url), { signal: AbortSignal.timeout(1000) })
  } catch (error) {
    const failure = record(error)
    const cause = failure.cause ? record(failure.cause) : {}
    refused =
      [failure.code, cause.code].some(
        (code) => code === 'ECONNREFUSED' || code === 'ConnectionRefused',
      ) ||
      /ECONNREFUSED|ConnectionRefused|connection refused/i.test(
        String(failure.message),
      )
  }
  requireCondition(
    refused,
    'A owned bridge port still accepts after native scope teardown',
  )
  requireCondition(
    !harness
      .readWrapperEvents()
      .some(
        (event) =>
          event.scope === owner.scope &&
          typeof event.at === 'number' &&
          event.at > Number(cleanup.at) &&
          /send|signal|native.request/.test(String(event.event)),
      ),
    'A producer wrote/dispatched after Cleanup completion',
  )
  if (id === 'cleanup-idempotent')
    requireCondition(
      harness
        .readWrapperEvents()
        .some(
          (event) =>
            event.event === 'cleanup.duplicate' && event.scope === owner.scope,
        ),
      'Plugin boundary never received duplicate Cleanup invocation',
    )
  if (id !== 'cleanup-reload') {
    assertGaSuccess(
      await harness.run(publicGaModel(), undefined, false, b),
      harness.nonce,
    )
    if (rpc && states)
      assertGaNoGenerationChange(
        states[1]!.snapshot,
        (await rpc.state(b)).snapshot,
      )
  }
  await accounts.assertNoPortOrSidebarFiles(harness)
}

export interface GaHostIntegrationInputs {
  /** The real protocol module; a copy of its source would not prove the package's behaviour. */
  protocol: GaPortableProtocol
  accounts: GaAccountRpcJoin
  /**
   * Runs the package's own typed ownership tests for job mismatches. This
   * supplements the host run and is reported apart from native dispatch.
   */
  jobOwnershipSupplement(id: GaCaseId, harness: GaHarness): Promise<void>
  /**
   * Type-checks the wrapper and driver sources against the installed
   * package's declarations and the pinned generated OpenCode client.
   */
  verifyConsumerBindings(outputRoot: string): Promise<void>
  /**
   * Validates the committed proxy-environment matrix measured on the pinned
   * binary: complete, for the same binary digest, with provenance.
   */
  verifyNativeMatrix(repoRoot: string, pin: GaBinaryPin): Promise<void>
}

export interface GaScenarioResult {
  id: GaCaseId
  state: 'runtime-verified'
  proof: 'native-host' | 'typed-facade-supplement' | 'packed-declarations'
  root: string
  nonce: string
  elapsedMs: number
  pinSha256: string
  artifacts: Record<string, string>
}

function gaCaseArtifacts(root: string): Record<string, string> {
  const artifacts: Record<string, string> = {}
  const visit = (directory: string) => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name)
      ownedPath(root, path)
      if (lstatSync(path).isDirectory()) visit(path)
      else if (lstatSync(path).isFile())
        artifacts[relative(root, path)] = sha256(readFileSync(path))
    }
  }
  visit(root)
  return artifacts
}

/**
 * Runs every case in `GA_CASE_IDS`. A case whose observation or input is
 * missing fails the run; no case is skipped.
 */
export async function runGaFullDriver(
  out: string,
  inputs: GaHostIntegrationInputs,
): Promise<GaScenarioResult[]> {
  requireCondition(
    isAbsolute(out) && existsSync(out) && readdirSync(out).length === 0,
    'Full GA output root must exist and be fresh/empty',
  )
  requireCondition(
    inputs?.accounts &&
      typeof inputs.accounts.seedCurrentStore === 'function' &&
      typeof inputs.accounts.assertCurrentStoreInput === 'function',
    'Required approved native account RPC/current-store input boundary is missing',
  )
  requireCondition(
    typeof inputs.verifyConsumerBindings === 'function' &&
      typeof inputs.verifyNativeMatrix === 'function' &&
      typeof inputs.jobOwnershipSupplement === 'function',
    'Required owner-reviewed declaration/native-matrix/facade input is missing',
  )
  requireCondition(
    inputs.protocol &&
      inputs.protocol.ANTIGRAVITY_RPC_ID === 'antigravity-auth' &&
      inputs.protocol.ANTIGRAVITY_RPC_VERSION === 1,
    'Required real portable protocol module is missing',
  )
  const pin = readGaPin(resolve('.'))
  await inputs.verifyNativeMatrix(resolve('.'), pin)
  await inputs.verifyConsumerBindings(out)
  assertCompleteGaInventory(GA_CASE_IDS)
  const results: GaScenarioResult[] = []
  const tls: GaTlsTrace[] = []
  const core = new Set<GaCaseId>([
    'catalog-and-titles',
    'compaction',
    'gemini-tools',
    'claude-tools',
    'claude-thinking',
    'image-permissions',
    'validation-required',
    'account-ineligible',
    'refresh-401',
    'quota-429',
    'capacity-fallback',
    'transport-reset',
    'host-retryable-status',
    'terminal-frame',
    'late-eof-empty',
    'late-eof-after-content',
    'late-error-empty',
    'late-error-after-content',
    'late-immediate-first-chunk-error',
    'concurrent-sessions',
    'overflow-gemini',
    'overflow-claude',
    'overflow-changed-counts',
    'overflow-nonmatching-400',
  ])
  for (const id of GA_CASE_IDS) {
    const started = gaTimestamp()
    let harness: GaHarness | undefined
    let proof: GaScenarioResult['proof'] = 'native-host'
    try {
      if (
        (id.startsWith('proxy-') && id !== 'proxy-raw-connect') ||
        id.startsWith('packed-proxy-')
      ) {
        harness = await runGaProxyScenario(id, out, inputs.accounts)
      } else if (id === 'ga.raw-cancel.detached-dispatch-signal') {
        harness = await runGaDetachedBindingControl(out, inputs.accounts)
      } else if (
        id.startsWith('raw-cancel-') &&
        id !== 'raw-cancel-never-accepted-control'
      ) {
        const phase = id.includes('connecting')
          ? 'connecting'
          : id.includes('pre-header')
            ? 'pre-header'
            : 'post-header'
        harness = await createOpenCodeGaHarness(id, out, {
          accounts: inputs.accounts,
          rawSender: true,
          rawTls: { identity: 'matching', phase, proxy: id.endsWith('-proxy') },
        })
        await runGaRawCancellation(harness, phase)
      } else if (
        (id.startsWith('tls-') && !id.endsWith('-control')) ||
        id === 'proxy-raw-connect' ||
        id === 'ga.raw-cancel.uncancelled-request-completes'
      ) {
        const negative =
          id === 'tls-missing-trust' ||
          id === 'tls-wrong-san' ||
          id === 'tls-missing-san-wrong-cn'
        harness = await createOpenCodeGaHarness(id, out, {
          accounts: inputs.accounts,
          rawSender: true,
          rawTls: {
            identity:
              id === 'tls-wrong-san'
                ? 'wrong-san'
                : id === 'tls-missing-san-wrong-cn'
                  ? 'missing-san'
                  : 'matching',
            phase: 'success',
            missingTrust: id === 'tls-missing-trust',
            proxy: id === 'proxy-raw-connect',
          },
        })
        const trace = await runGaRawTlsCase(harness, negative)
        if (id.startsWith('tls-')) tls.push(trace)
      } else {
        harness = await createOpenCodeGaHarness(id, out, {
          accounts: inputs.accounts,
        })
        if (core.has(id)) await runGaCoreScenario(harness, id, inputs.accounts)
        else if (id === 'late-unrelated-response')
          await runGaUnrelatedResponse(harness)
        else if (
          id === 'title-off-catalog' ||
          id === 'title-primary-fallback' ||
          id === 'title-overflow'
        )
          await runGaTitleScenario(harness, id)
        else if (id.startsWith('job-mismatch-')) {
          proof = 'typed-facade-supplement'
          await inputs.jobOwnershipSupplement(id, harness)
        } else if (id === 'ga.raw-cancel.async-observer-rejected') {
          proof = 'packed-declarations'
          await inputs.verifyConsumerBindings(harness.paths.root)
        } else if (id.startsWith('cleanup-') && !id.endsWith('-control'))
          await runGaLifecycleScenario(
            harness,
            id,
            inputs.accounts,
            inputs.protocol,
          )
        else if (id.startsWith('pty-') && !id.endsWith('-control'))
          await runGaPtyScenario(harness, id, inputs.accounts)
        else await runGaRequiredControl(harness, id, inputs)
      }
      requireCondition(harness, `Scenario has no actual harness: ${id}`)
      assertGaDatabase(harness.paths)
      requireCondition(
        harness.mock.requests.every(
          (request) => request.kind !== 'direct-provider',
        ),
        `Direct-provider fallthrough in ${id}`,
      )
      writeFileSync(
        join(harness.paths.state, 'mock-requests.json'),
        JSON.stringify(harness.mock.requests),
        { mode: 0o600 },
      )
      await harness.dispose()
      const result: GaScenarioResult = {
        id,
        state: 'runtime-verified',
        proof,
        root: harness.paths.root,
        nonce: harness.nonce,
        elapsedMs: gaTimestamp() - started,
        pinSha256: sha256(readFileSync(GA_PIN_PATH)),
        artifacts: gaCaseArtifacts(harness.paths.root),
      }
      requireCondition(
        Object.keys(result.artifacts).length > 0 &&
          result.elapsedMs > 0 &&
          result.elapsedMs <= 60_000,
        `Missing/late retained observations for ${id}`,
      )
      results.push(result)
      writeFileSync(
        join(out, `${String(results.length).padStart(3, '0')}-result.json`),
        JSON.stringify(result),
        { mode: 0o600, flag: 'wx' },
      )
    } finally {
      await harness?.dispose()
    }
  }
  assertCompleteGaInventory(results.map((result) => result.id))
  assertGaTlsSequence(tls)
  writeFileSync(
    join(out, 'full-results.json'),
    JSON.stringify({ status: 'runtime-verified', results }),
    { mode: 0o600, flag: 'wx' },
  )
  return results
}

async function runGaRequiredControl(
  harness: GaHarness,
  id: GaCaseId,
  inputs: GaHostIntegrationInputs,
): Promise<void> {
  if (id.startsWith('killswitch-')) {
    const session = await harness.native.create(
      harness.paths.project,
      publicGaModel(),
      'Killswitch fixture',
    )
    const snapshot = await inputs.accounts.snapshot(harness, session)
    requireCondition(
      snapshot.rows.length > 0,
      'Killswitch has no actual account candidates',
    )
    // Quota and limits are set through the actions the real /antigravity
    // menu emits: Quota's `refresh` and Limits' `set`.
    const killswitchOn = { enabled: true, minimumRemainingPercent: 95 }
    if (id === 'killswitch-all-fresh-below') {
      await inputs.accounts.applyMenuAction(
        harness,
        session,
        'quota',
        'refresh',
      )
      await inputs.accounts.applyMenuAction(
        harness,
        session,
        'limits',
        'set',
        killswitchOn,
      )
      const before = gaPrimaryRequests(harness).length
      const result = await harness.run(
        publicGaModel(),
        undefined,
        false,
        session,
      )
      requireCondition(
        gaPrimaryRequests(harness).length === before &&
          gaSessionErrors(result.stdout).some(
            (error) =>
              error.type === 'unknown' &&
              /killswitch/i.test(String(error.message)),
          ),
        'Fresh below-threshold accounts dispatched or lacked native killswitch error',
      )
    } else {
      await inputs.accounts.applyMenuAction(
        harness,
        session,
        'limits',
        'set',
        killswitchOn,
      )
      if (id === 'killswitch-account-override') {
        const target = snapshot.rows[0]
        requireCondition(target, 'Killswitch override target missing')
        const override = await inputs.accounts.captureKillswitchOverride(
          harness,
          session,
          target.publicId,
        )
        const outcome = await inputs.accounts.applyCapturedTarget(
          harness,
          session,
          override.actionId,
          override,
          { [override.knobId]: 0 },
        )
        requireCondition(
          outcome.ok,
          `Per-account killswitch override was refused: ${outcome.code ?? outcome.text}`,
        )
      }
      const result = await harness.run(
        publicGaModel(),
        undefined,
        false,
        session,
      )
      assertGaSuccess(result, harness.nonce)
      requireCondition(
        gaPrimaryRequests(harness).length > 0,
        'Fail-open/override control did not dispatch',
      )
    }
    return
  }
  if (id === 'tls-disabled-verification-control') {
    for (const value of ['', '0', '1']) {
      let refused = false
      try {
        gaChildEnvironment(harness.paths, {
          NODE_TLS_REJECT_UNAUTHORIZED: value,
        })
      } catch (error) {
        refused = String(error).includes('presence forbids host launch')
      }
      requireCondition(refused, 'TLS-disable presence reached host launch')
    }
    assertGaSuccess(await harness.run(publicGaModel()), harness.nonce)
    return
  }
  if (id === 'tls-missing-observer-control') {
    const outcomes = await collectGaRawCancelAssertions({
      interruptedAt: gaTimestamp(),
      signals: [],
      peerClosedAt: () => undefined,
      forcedTeardown: () => false,
    })
    requireCondition(
      outcomes.every((outcome) => !outcome.passed),
      'Missing raw observation falsely certified',
    )
    assertGaSuccess(await harness.run(publicGaModel()), harness.nonce)
    return
  }
  if (
    id === 'raw-cancel-never-accepted-control' ||
    id === 'tls-missing-mapping-control'
  ) {
    let refused = false
    try {
      assertGaCancellation({
        phase: 'connecting',
        interruptedAt: gaTimestamp(),
        applicationBytes: 0,
        bytesAfterPeerClose: 0,
        forcedTeardown: false,
      })
    } catch (error) {
      refused = String(error).includes('Missing naturally accepted')
    }
    requireCondition(
      refused,
      'Never-accepted peer falsely certified connecting cancellation',
    )
    assertGaSuccess(await harness.run(publicGaModel()), harness.nonce)
    return
  }
  if (id === 'cleanup-missing-control' || id === 'cleanup-order-control') {
    await runGaLifecycleScenario(
      harness,
      'cleanup-disable',
      inputs.accounts,
      inputs.protocol,
    )
    const events = harness.readWrapperEvents()
    const ends = events.filter((event) => event.event === 'cleanup.end')
    requireCondition(
      ends.length === 1,
      'Cleanup positive did not establish a source for its missing/order control',
    )
    const end = ends[0]
    requireCondition(
      end && typeof end.at === 'number',
      'Cleanup positive has no timestamp',
    )
    const missing = events.filter((event) => event.event !== 'cleanup.end')
    requireCondition(
      !missing.some((event) => event.event === 'cleanup.end'),
      'Missing Cleanup observation control was ineffective',
    )
    const late = { event: 'send.start', scope: end.scope, at: end.at + 1 }
    requireCondition(
      [...events, late].some(
        (event) =>
          event.scope === end.scope &&
          Number(event.at) > Number(end.at) &&
          event.event === 'send.start',
      ),
      'Producer-after-drain ordering control was ineffective',
    )
    return
  }
  if (
    id === 'pty-second-instance-control' ||
    id === 'pty-raw-fallback-control'
  ) {
    const entry =
      '/opt/ga-consumer/node_modules/@cortexkit/opencode-antigravity-auth/src/tui-compiled/ga/ga/tui/host-ga.tsx'
    requireCondition(
      existsSync(entry),
      'Actual packed compiled GA arm is missing',
    )
    const source = readFileSync(entry, 'utf8')
    requireCondition(
      !/from\s*['"](?:solid-js|@opentui\/)|import\s*['"]solid-js/.test(source),
      'Actual compiled arm has a bare framework/second-instance edge',
    )
    requireCondition(
      !source.includes('src/tui-raw'),
      'Actual installed arm has a raw fallback edge',
    )
    await runGaPtyScenario(harness, 'pty-sidebar-dialogs', inputs.accounts)
    return
  }
  if (id === 'sigint-natural-close') {
    const session = await harness.native.create(
      harness.paths.project,
      publicGaModel(),
      'SIGINT fixture',
    )
    const pending = harness.run(publicGaModel(), undefined, false, session)
    await waitForGaObservation(
      () => harness.mock.events.some((event) => event.event === 'held-content'),
      'SIGINT genuinely held upstream stream',
    )
    const at = gaTimestamp()
    harness.host.server.signal('SIGINT')
    await waitForGaObservation(
      () =>
        harness.mock.events.some(
          (event) =>
            event.event === 'peer-close' &&
            event.at >= at &&
            event.at - at <= 2000,
        ),
      'SIGINT natural upstream socket close',
      2000,
    )
    const exit = await harness.host.server.result
    const result = await pending
    requireCondition(
      !result.timedOut &&
        !result.outputCapExceeded &&
        !harness.mock.events.some((event) => event.event === 'forced-close'),
      'SIGINT closure required forced teardown',
    )
    requireCondition(
      !exit.timedOut &&
        gaTimestamp() - at <= 2000 &&
        (exit.code !== null || exit.signal !== null),
      'SIGINT did not naturally close/record host exit within budget',
    )
    writeFileSync(
      join(harness.paths.state, 'sigint.json'),
      JSON.stringify({ at, exit }),
      { mode: 0o600 },
    )
    return
  }
  throw new Error(`No complete required scenario driver for ${id}`)
}

/**
 * Switches to session B with real keystrokes through OpenCode's own
 * session-selection slash command, which is looked up in the command list the
 * TUI reported rather than assumed.
 */
export async function gaBuiltinSessionNavigation(
  harness: GaHarness,
  pty: GaChild,
  sessionB: GaSessionRef,
): Promise<void> {
  const path = join(harness.paths.state, 'tui.ndjson')
  const before = readGaLines(path)
  const registry = new Set(before.map((event) => event.registry))
  requireCondition(
    registry.size === 1,
    'Built-in navigation needs one existing UI registry',
  )
  const observation = before
    .filter((event) => event.event === 'ui.observation')
    .at(-1)
  requireCondition(
    observation && Array.isArray(observation.commands),
    'Native built-in command inventory is absent',
  )
  const command = observation.commands
    .map(record)
    .find(
      (entry) =>
        entry.id !== 'ga-host-switch-session' &&
        /switch session|sessions/i.test(String(entry.title)) &&
        entry.slash &&
        typeof record(entry.slash).name === 'string',
    )
  requireCondition(
    command && typeof record(command.slash).name === 'string',
    'Pinned host exposes no observed built-in session-selection slash command',
  )
  const session = await harness.native.get(sessionB)
  requireCondition(
    typeof session.title === 'string',
    'B native title unavailable for actual menu selection',
  )
  const offset = pty.output().stdout.length
  pty.process.stdin.write(`/${record(command.slash).name}\r`)
  await waitForGaObservation(
    () =>
      stripVTControlCharacters(pty.output().stdout.slice(offset)).includes(
        String(session.title),
      ),
    'real built-in session menu lists B',
  )
  pty.process.stdin.write(`${session.title}\r`)
  await waitForGaObservation(
    () =>
      readGaLines(path)
        .slice(before.length)
        .some(
          (event) =>
            event.event === 'ui.observation' &&
            event.directory === sessionB.directory &&
            record(event.route).type === 'session' &&
            record(event.route).sessionID === sessionB.id,
        ),
    'built-in user navigation recovers B location',
    5000,
  )
  const after = readGaLines(path)
  requireCondition(
    after.every((event) => registry.has(event.registry)),
    'Built-in navigation changed module registry',
  )
  writeFileSync(
    join(harness.paths.state, 'builtin-navigation.json'),
    JSON.stringify({
      proof: 'native-built-in-user-keystrokes',
      command: command.id,
      sessionID: sessionB.id,
      registry: [...registry],
    }),
    { mode: 0o600 },
  )
}

/**
 * The protocol module itself, so every wire type, schema and validator the
 * client uses comes from it rather than from a copy.
 */
export type GaPortableProtocol =
  typeof import('../../opencode/src/ga/rpc/protocol.ts')

/** The shared menu's answer to one apply, with the refreshed menu. */
export type GaMenuResult = AntigravityAppliedOutput['result']
export type GaMenu = GaMenuResult['menu']
export type GaMenuSection = GaMenu['sections'][number]
export type GaMenuSlot = GaMenuSection['slot']

export interface GaProtocolSessionState {
  snapshot: AntigravityStateSnapshot
  request: AntigravityStateInput
}

/**
 * The menu opened by one real `/antigravity` command, with the state reads
 * taken just before the command and just after its menu arrived.
 */
export interface GaOpenedMenu {
  before: AntigravityStateSnapshot
  after: AntigravityStateSnapshot
  menu: GaMenu
}

/** The last menu notification for the shared command in one state answer. */
export function latestGaMenu(
  protocol: GaPortableProtocol,
  snapshot: AntigravityStateSnapshot,
): GaMenu | undefined {
  let menu: GaMenu | undefined
  for (const notification of snapshot.notifications) {
    const payload = notification.payload
    if (
      'menu' in payload &&
      payload.command === protocol.ANTIGRAVITY_MENU_COMMAND_NAME
    )
      menu = payload.menu
  }
  return menu
}

export function createGaProtocolClient(
  protocol: GaPortableProtocol,
  url: string,
) {
  const scopes = new Map<
    string,
    { generation: string | null; cursor: number }
  >()
  const key = (session: GaSessionRef) => `${session.directory}\0${session.id}`
  const call = async (
    session: GaSessionRef,
    method: 'state' | 'apply',
    input: AntigravityStateInput | AntigravityApplyInput,
  ): Promise<unknown> =>
    gaNativeRequest(
      url,
      'POST',
      `/api/rpc/${encodeURIComponent(protocol.ANTIGRAVITY_RPC_ID)}/${method}?${new URLSearchParams({ 'location[directory]': session.directory })}`,
      { input },
      200,
    )
  const state = async (
    session: GaSessionRef,
  ): Promise<GaProtocolSessionState> => {
    const previous = scopes.get(key(session)) ?? { generation: null, cursor: 0 }
    const request: AntigravityStateInput = {
      version: protocol.ANTIGRAVITY_RPC_VERSION,
      generation: previous.generation,
      cursor: previous.cursor,
      scope: { kind: 'session', sessionID: session.id },
    }
    const parsed = protocol.readStateCallOutput(
      await call(session, 'state', request),
    )
    requireCondition(parsed.ok, 'State RPC response failed the protocol schema')
    const output: AntigravityStateOutput = parsed.value
    requireCondition(
      output.kind === 'snapshot',
      'Native account activation is disposed',
    )
    requireCondition(
      output.scope.kind === 'session' && output.scope.sessionID === session.id,
      'Native state returned a foreign session scope',
    )
    requireCondition(
      output.generation.length > 0 && output.cursor >= 0,
      'State generation/cursor is missing',
    )
    if (previous.generation === output.generation && output.reset === null)
      requireCondition(
        output.cursor >= previous.cursor,
        'State cursor regressed within a generation',
      )
    if (
      previous.generation !== null &&
      previous.generation !== output.generation
    )
      requireCondition(
        output.reset === 'generation-changed',
        'Native generation changed without reset semantics',
      )
    scopes.set(key(session), {
      generation: output.generation,
      cursor: output.cursor,
    })
    return { snapshot: output, request }
  }
  const applyInput = (
    session: GaSessionRef,
    generation: string,
    request: Omit<AntigravityMenuRequest, 'command'>,
  ): AntigravityApplyInput => ({
    version: protocol.ANTIGRAVITY_RPC_VERSION,
    generation,
    scope: { kind: 'session', sessionID: session.id },
    request: { ...request, command: protocol.ANTIGRAVITY_MENU_COMMAND_NAME },
  })
  return {
    state,
    /**
     * Runs the real `/antigravity` command through `runCommand` and waits a
     * bounded time for the menu it queues in this session's notifications.
     * Missing menus fail; nothing is synthesized.
     */
    async openMenu(
      session: GaSessionRef,
      runCommand: () => Promise<void>,
      deadlineMs = 5000,
    ): Promise<GaOpenedMenu> {
      const before = (await state(session)).snapshot
      await runCommand()
      let menu: GaMenu | undefined
      let after: AntigravityStateSnapshot | undefined
      await waitForGaObservation(
        async () => {
          const next = (await state(session)).snapshot
          menu = latestGaMenu(protocol, next) ?? menu
          after = next
          return menu !== undefined && !next.more
        },
        'menu notification from the real /antigravity command',
        deadlineMs,
      )
      requireCondition(menu && after, 'The /antigravity command queued no menu')
      requireCondition(
        after.generation === before.generation,
        'The activation changed while the menu was opened',
      )
      return { before, after, menu }
    },
    /**
     * Sends one menu action at the scope's current generation and returns the
     * menu's answer, including refusals (`ok: false` with a code).
     */
    async apply(
      session: GaSessionRef,
      request: Omit<AntigravityMenuRequest, 'command'>,
    ): Promise<GaMenuResult> {
      const previous = scopes.get(key(session))
      requireCondition(
        previous?.generation,
        'A state generation is required before apply',
      )
      const parsed = protocol.readApplyCallOutput(
        await call(
          session,
          'apply',
          applyInput(session, previous.generation, request),
        ),
      )
      requireCondition(
        parsed.ok,
        'Apply RPC response failed the protocol schema',
      )
      const output: AntigravityApplyOutput = parsed.value
      requireCondition(
        output.kind === 'applied',
        `Native apply refused stale/disposed generation: ${output.kind}`,
      )
      requireCondition(
        output.generation === previous.generation &&
          output.scope.kind === 'session' &&
          output.scope.sessionID === session.id &&
          output.result.command === protocol.ANTIGRAVITY_MENU_COMMAND_NAME,
        'Native apply crossed generation/session/command ownership',
      )
      return output.result
    },
    async assertStaleGeneration(
      session: GaSessionRef,
      stale: string,
      request: Omit<AntigravityMenuRequest, 'command'>,
    ): Promise<void> {
      const parsed = protocol.readApplyCallOutput(
        await call(session, 'apply', applyInput(session, stale, request)),
      )
      requireCondition(
        parsed.ok && parsed.value.kind === 'stale-generation',
        'Stale generation was not rejected without applying',
      )
    },
    forget(session: GaSessionRef): void {
      scopes.delete(key(session))
    },
  }
}

/**
 * Product behaviour these cases need and only the installed package can
 * supply. Nothing here has a harness fallback: a missing piece fails its
 * case.
 */
export const GA_REQUIRED_EFFECT_JOINS = [
  {
    path: 'packages/core/src/antigravity-command-menu.ts',
    sourceSymbols: 'accountsSection, createItemIds',
    required:
      'Account actions target the opaque item id the menu issued for one exact credential. Redacted acct-<n> ids and positions are never sent as targets.',
  },
  {
    path: 'packages/opencode/src/ga/server/index.ts',
    sourceSymbols:
      'HarnessAccountsObservation, GaPluginOverrides.observeAccountSnapshot',
    required:
      'Access-block reasons and usability come from the diagnostic observation recorded for the same state read; the redacted state DTO carries neither.',
  },
  {
    path: 'packages/opencode/src/ga/rpc/protocol.ts',
    sourceSymbols: 'AntigravityStateSnapshot.settings',
    required:
      'Routing, killswitch, log level and dump settings are read from a fresh state answer, never from an earlier apply result.',
  },
  {
    path: 'packages/opencode/src/ga/tui/host-ga.tsx',
    sourceSymbols: 'GA_SIDEBAR_PULL_MS',
    required:
      'The sidebar pull interval is read from the compiled TUI in the installed package, never assumed.',
  },
  {
    path: 'packages/opencode/src/ga/server/index.ts',
    sourceSymbols:
      'createGaAntigravityPlugin, GaPluginOverrides.observeRawSenderSignal',
    required:
      'The installed package exports the production factory, and its raw sender reports its own AbortSignal synchronously. A factory built from mock services does not count.',
  },
  {
    path: 'packages/opencode/src/plugin/ga-location-services.ts',
    sourceSymbols: 'createGaMenuCommandService.open, GA /antigravity command',
    required:
      'The host registers /antigravity, and running it queues the menu in that session\'s notifications. Without it every menu-driven case fails with "The /antigravity command queued no menu".',
  },
  {
    path: 'packages/opencode/src/plugin/ga-location-services.ts',
    sourceSymbols: 'createGaLocationMenu refreshQuota',
    required:
      'The Quota section offers its refresh action, which killswitch-all-fresh-below runs before checking the killswitch.',
  },
  {
    path: 'packages/opencode/src/plugin/ga-location-services.ts',
    sourceSymbols: 'createGaReauthorize, accountsSection reauthorize',
    required:
      "A blocked account's own item offers `reauthorize`, which signs that same account in again and replaces its credential in place. Adding a new account does not count.",
  },
  {
    path: 'packages/opencode/src/tui/command-dialogs.tsx',
    sourceSymbols: 'openAntigravityMenu',
    required:
      "The installed package's OpenCode 2 TUI renders the queued menu as the drawer: one select list per level, titled with the section, item and action titles the server sent. The PTY cases choose entries by typing those titles.",
  },
] as const

export function assertGaScopedSnapshots(
  protocol: GaPortableProtocol,
  a: AntigravityStateSnapshot,
  b: AntigravityStateSnapshot,
  sessionA: GaSessionRef,
  sessionB: GaSessionRef,
): void {
  requireCondition(
    a.scope.kind === 'session' &&
      a.scope.sessionID === sessionA.id &&
      b.scope.kind === 'session' &&
      b.scope.sessionID === sessionB.id,
    'Native state RPC crossed actual session scopes',
  )
  requireCondition(
    a.generation.length > 0 &&
      b.generation.length > 0 &&
      a.generation !== b.generation,
    'Two actual locations shared an activation generation',
  )
  for (const snapshot of [a, b]) {
    requireCondition(
      snapshot.accounts.length > 0 &&
        Number.isInteger(snapshot.cursor) &&
        snapshot.cursor >= 0 &&
        Number.isInteger(snapshot.dropped) &&
        snapshot.dropped >= 0,
      'Native snapshot lacks real rows/cursor/drop accounting',
    )
    requireCondition(
      snapshot.notifications.every(
        (notification) => notification.cursor <= snapshot.cursor,
      ),
      'Snapshot acknowledges a cursor before the held notification',
    )
    for (const row of snapshot.accounts) {
      requireCondition(
        /^acct-(0|[1-9][0-9]*)$/.test(row.id) &&
          /^Account [1-9][0-9]*$/.test(row.label),
        'Portable projection exposed a private identifier/label',
      )
      requireCondition(
        new RegExp(protocol.ANTIGRAVITY_RPC_CONTRACT.selectorPattern).test(
          row.selector,
        ),
        'Account selector does not match the protocol selector pattern',
      )
      const allowed = new Set([
        'selector',
        'id',
        'label',
        'enabled',
        'health',
        'current',
        'cooldownUntil',
        'quota',
        'tier',
      ])
      requireCondition(
        Object.keys(row).every((key) => allowed.has(key)),
        'Account projection leaked undeclared/private state',
      )
    }
  }
}

export function assertGaNativeRebind(
  previous: AntigravityStateSnapshot,
  next: AntigravityStateSnapshot,
  target: GaSessionRef,
): void {
  requireCondition(
    next.scope.kind === 'session' && next.scope.sessionID === target.id,
    'Location switch retained the previous native session scope',
  )
  requireCondition(
    next.generation !== previous.generation && next.reset === 'initial',
    'New location did not begin its independent generation/cursor stream',
  )
  requireCondition(
    next.notifications.every((notice) => notice.cursor <= next.cursor),
    'Native rebind lost notification cursor accounting',
  )
}

export function assertGaNoGenerationChange(
  before: AntigravityStateSnapshot,
  after: AntigravityStateSnapshot,
): void {
  requireCondition(
    before.generation === after.generation &&
      before.scope.kind === after.scope.kind &&
      (before.scope.kind !== 'session' ||
        (after.scope.kind === 'session' &&
          before.scope.sessionID === after.scope.sessionID)),
    'Disposing A changed B generation/session ownership',
  )
  requireCondition(
    after.cursor >= before.cursor && after.reset !== 'generation-changed',
    'Disposing A reset B notification/cursor state',
  )
}

export function assertGaPinnedHostnameMappings(hosts: string): void {
  const mapped = new Set<string>()
  for (const line of hosts.split(/\r?\n/)) {
    const fields = line.split('#')[0]?.trim().split(/\s+/) ?? []
    for (const host of fields.slice(1)) {
      const canonical = host.toLowerCase()
      if (!GA_HOSTNAMES.some((hostname) => hostname === canonical)) continue
      requireCondition(
        fields[0] === '127.0.0.1' && !mapped.has(canonical),
        'Conflicting or duplicate pinned AGY hostname mapping',
      )
      mapped.add(canonical)
    }
  }
  requireCondition(
    GA_HOSTNAMES.every((hostname) => mapped.has(hostname)),
    'Missing pinned AGY hostname/443 loopback mapping; raw host launch refused',
  )
}
