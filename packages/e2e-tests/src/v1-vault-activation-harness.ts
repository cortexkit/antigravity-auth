import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  writeFile,
} from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { networkInterfaces } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gzipSync } from 'node:zlib'

import {
  createPublicCommandInspector,
  inspectPublicCommandScope,
  type PublicCommandInspector,
  type PublicCommandScope,
  reapPublicCommandScope,
  signalPublicCommandMember,
} from '../../core/src/__fixtures__/public-command-processes.test.ts'

const BINARY_SHA256 =
  'ae98d78e8b9a4f3ef4fd16920bfb3dedeab731c0586badff501f75b53ece3b6d'
const ACTIVATION_LABEL = 'Activate approved Antigravity vault'
export const SYNTHETIC_TOKEN = 'synthetic-native-v1-vault-access'
export const SYNTHETIC_PROJECT = 'synthetic-native-v1-project'
export const TERMINAL_TEXT = 'Native V1 vault first request completed.'
const ROOT = resolve(import.meta.dir, '../../..')

interface ChildReceipt {
  name: string
  argv: string[]
  pid: number
  exitCode: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  reaped: boolean
  ownership: {
    pid: number
    ppid: number
    pgid: number
    sid: number
    start: string
  }
  signals: PublicCommandScope['signals']
  signalFailures: string[]
  stdout: string
  stderr: string
}

export interface ActivationReceipt {
  snapshot: Record<string, string>
  runtime: {
    bun: string
    platform: string
    arch: string
    interfaces: string[]
    topology: string
    sdkVersion: string
  }
  binary: { sha256: string; version: string; path: string }
  profile: string
  authAbsentBefore: boolean
  localArtifactsAbsentBefore: boolean
  marker?: unknown
  processes: ChildReceipt[]
  requests: { path: string; authorization: string | null; body: unknown }[]
  observations: Record<string, unknown>[]
  vaultCalls: Record<string, unknown>[]
  localFileSyscalls: string[]
  syscallRecords: { child: string; sha256: string; lines: number }[]
  streamBytes?: string
  storedMessages?: unknown
  error?: string
}

export async function finite<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function sha256(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex')
}

export function signalOwnedChildren(
  scope: PublicCommandScope,
  inspector: PublicCommandInspector,
  signal: NodeJS.Signals,
  dispatch: (pid: number, signal: NodeJS.Signals) => void = process.kill,
): void {
  for (const member of inspectPublicCommandScope(scope, inspector))
    signalPublicCommandMember(scope, member, inspector, signal, dispatch)
}

export function startChild(
  name: string,
  argv: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  deadline: number,
  inspector: PublicCommandInspector,
) {
  const child = spawn(argv[0]!, argv.slice(1), {
    cwd,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const leader = child.pid ? inspector.read(child.pid) : undefined
  if (
    !leader ||
    leader.ppid !== process.pid ||
    leader.pgid !== child.pid ||
    leader.sid !== child.pid
  )
    throw new Error(`${name} did not establish an owned detached session`)
  const scope: PublicCommandScope = {
    leader,
    observed: new Map([[leader.pid, leader]]),
    signals: [],
  }
  const receipt: ChildReceipt = {
    name,
    argv,
    pid: child.pid ?? -1,
    exitCode: null,
    signal: null,
    timedOut: false,
    reaped: false,
    ownership: {
      pid: leader.pid,
      ppid: leader.ppid,
      pgid: leader.pgid,
      sid: leader.sid,
      start: leader.start.toString(),
    },
    signals: scope.signals,
    signalFailures: [],
    stdout: '',
    stderr: '',
  }
  child.stdout.on('data', (data: Buffer) => {
    receipt.stdout += data.toString()
  })
  child.stderr.on('data', (data: Buffer) => {
    receipt.stderr += data.toString()
  })
  const exited = new Promise<void>((accept) =>
    child.once('exit', () => accept()),
  )
  const finished = new Promise<ChildReceipt>((accept, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => {
      receipt.exitCode = code
      receipt.signal = signal
      accept(receipt)
    })
  })
  const signalGroup = (signal: NodeJS.Signals) => {
    try {
      signalOwnedChildren(scope, inspector, signal)
    } catch (error) {
      receipt.signalFailures.push(String(error))
    }
  }
  let killTimer: ReturnType<typeof setTimeout> | undefined
  const timer = setTimeout(() => {
    receipt.timedOut = true
    signalGroup('SIGTERM')
    killTimer = setTimeout(() => signalGroup('SIGKILL'), 1500)
  }, deadline)
  const result = finished.finally(() => {
    clearTimeout(timer)
    clearTimeout(killTimer)
  })
  return {
    scope,
    exited,
    receipt,
    result,
    async stop() {
      const deadline = performance.now() + 5000
      await reapPublicCommandScope(scope, inspector, deadline, 1500)
      await finite(
        result,
        Math.max(1, deadline - performance.now()),
        `${name} cleanup did not finish`,
      )
      receipt.reaped = inspectPublicCommandScope(scope, inspector).length === 0
      if (!receipt.reaped || receipt.signalFailures.length)
        throw new Error(
          `${name} owned cleanup failed: ${receipt.signalFailures.join('; ')}`,
        )
    },
  }
}

async function writeJson(path: string, value: unknown) {
  await mkdir(resolve(path, '..'), { recursive: true, mode: 0o700 })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}

async function seedEnrollment() {
  const { createOpenCodeVaultCustody } = await import(
    '../../opencode/src/plugin/vault-custody.ts'
  )
  // Seeded where a version before the move to the state home kept it,
  // beside the account file; the plugin moves it when it starts.
  const accountFile = process.env.ANTIGRAVITY_ACCOUNTS_PATH!
  const custody = createOpenCodeVaultCustody({
    vaultDir: join(dirname(accountFile), 'antigravity-auth-vault'),
    accountFile,
    readHostSlot: async () => undefined,
    reporterSource: 'direct',
    connectEnrollment: async () => ({
      enrollPropose: async () => ({
        requestId: 'synthetic-approved-enrollment',
      }),
      enrollPoll: async () => ({
        status: 'approved' as const,
        name: 'antigravity-auth-opencode',
        token: 'ab'.repeat(32),
        tokenGeneration: 1,
      }),
      close() {},
    }),
  })
  try {
    const proposed = await custody.requestAccess()
    const approved = await custody.requestAccess()
    if (approved.state !== 'approved')
      throw new Error(`Enrollment refused: ${JSON.stringify(approved)}`)
    await custody.useVault()
    console.log(
      JSON.stringify({ proposed, approved, mode: await custody.readMode() }),
    )
  } finally {
    await custody.dispose()
  }
}

function pluginSource(recorder: string, observations: string): string {
  return `import { appendFileSync } from 'node:fs'
import { createAntigravityPlugin } from ${JSON.stringify(join(ROOT, 'packages/opencode/src/plugin/index.ts'))}
const observe = (event) => appendFileSync(${JSON.stringify(observations)}, JSON.stringify({pid: process.pid, ...event}) + '\\n')
const nativeFetch = globalThis.fetch
const loopback = (input) => { const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url); return url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]' }
globalThis.fetch = Object.assign(async (input, init) => {
  if (!loopback(input)) { const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url; const metadata = url === 'https://antigravity-auto-updater-974169037036.us-central1.run.app' || url === 'https://antigravity.google/changelog' || url === 'https://models.dev/api.json'; observe({kind: metadata ? 'metadata-network-denied' : 'forbidden-network', url}); throw new Error('Only owned loopback is admitted') }
  return nativeFetch(input, init)
}, {preconnect: nativeFetch.preconnect})
export const NativeVaultProbe = async (input) => {
  observe({kind: 'composition', directory: input.directory})
  const plugin = await createAntigravityPlugin('google', {dependencies: {
    agyTransport: async (url, init) => { observe({kind: 'agy-transport', url}); return nativeFetch(${JSON.stringify(recorder)} + new URL(url).pathname + new URL(url).search, init) },
    fetchImpl: globalThis.fetch,
    oauth: {
      authorize: async () => { observe({kind: 'forbidden-oauth'}); throw new Error('Local OAuth is forbidden') },
      exchange: async () => { observe({kind: 'forbidden-oauth'}); throw new Error('Local OAuth is forbidden') },
    },
  }})(input)
  observe({kind: 'methods', labels: plugin.auth.methods.map(method => method.label)})
  const loader = plugin.auth.loader
  plugin.auth.loader = async (...args) => { observe({kind: 'native-loader'}); const loaded = await loader(...args); observe({kind: 'native-loader-result', hasFetch: typeof loaded.fetch === 'function'}); return loaded }
  return plugin
}
`
}

export async function runNativeActivation(
  attach = false,
): Promise<ActivationReceipt> {
  if (process.platform !== 'linux' || process.arch !== 'x64')
    throw new Error('This gate requires isolated Linux x64')
  if (Object.keys(networkInterfaces()).some((name) => name !== 'lo'))
    throw new Error('Runtime namespace must expose only loopback')
  const binary = join(
    ROOT,
    'research/native-v1-vault-activation/oc-fixture/node_modules/opencode-linux-x64/bin/opencode',
  )
  const digest = sha256(await readFile(binary))
  if (digest !== BINARY_SHA256)
    throw new Error(`Official binary hash mismatch: ${digest}`)
  const profile = await realpath(await mkdtemp('/tmp/native-v1-vault-'))
  await chmod(profile, 0o700)
  const project = join(profile, 'project')
  const config = join(profile, 'config/opencode')
  const accountFile = join(config, 'antigravity-accounts.json')
  const authFile = join(profile, 'data/opencode/auth.json')
  const observationFile = join(profile, 'observations.jsonl')
  const sdk = JSON.parse(
    await readFile(
      join(ROOT, 'node_modules/@opencode-ai/plugin/package.json'),
      'utf8',
    ),
  ) as { version: string }
  if (sdk.version !== '1.17.13')
    throw new Error('Prepared plugin SDK does not match the official floor')
  const snapshot: Record<string, string> = {}
  for (const path of [
    'packages/e2e-tests/src/v1-vault-activation-harness.ts',
    'packages/e2e-tests/src/v1-vault-activation.e2e.test.ts',
    'packages/opencode/src/plugin/index.ts',
    'packages/core/src/common-auth-embedded/source-output.json',
  ])
    snapshot[path] = sha256(await readFile(join(ROOT, path)))
  const receipt: ActivationReceipt = {
    snapshot,
    runtime: {
      bun: Bun.version,
      platform: process.platform,
      arch: process.arch,
      interfaces: Object.keys(networkInterfaces()),
      topology: attach
        ? 'serve + run --attach'
        : 'run (native internal server)',
      sdkVersion: sdk.version,
    },
    binary: { sha256: digest, version: '', path: binary },
    profile,
    authAbsentBefore: false,
    localArtifactsAbsentBefore: false,
    processes: [],
    requests: [],
    observations: [],
    vaultCalls: [],
    localFileSyscalls: [],
    syscallRecords: [],
  }
  const children: ReturnType<typeof startChild>[] = []
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: join(profile, 'home'),
    XDG_CONFIG_HOME: join(profile, 'config'),
    XDG_DATA_HOME: join(profile, 'data'),
    XDG_CACHE_HOME: join(profile, 'cache'),
    XDG_STATE_HOME: join(profile, 'state'),
    XDG_RUNTIME_DIR: join(profile, 'runtime'),
    TMPDIR: join(profile, 'tmp'),
    OPENCODE_DB: join(profile, 'data/opencode.db'),
    ANTIGRAVITY_ACCOUNTS_PATH: accountFile,
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
    OPENCODE_CONFIG_DIR: config,
  }
  for (const path of [
    project,
    config,
    env.HOME!,
    env.TMPDIR!,
    env.XDG_DATA_HOME!,
    env.XDG_CACHE_HOME!,
    env.XDG_STATE_HOME!,
    env.XDG_RUNTIME_DIR!,
  ])
    await mkdir(path, { recursive: true, mode: 0o700 })
  const inspector = await createPublicCommandInspector()
  const traced = (name: string, args: string[], deadline: number) => {
    const child = startChild(
      name,
      [
        '/usr/bin/strace',
        '-f',
        '-e',
        'trace=%file',
        '-o',
        join(profile, `${name}.syscalls`),
        binary,
        ...args,
      ],
      project,
      env,
      deadline,
      inspector,
    )
    children.push(child)
    receipt.processes.push(child.receipt)
    return child
  }
  const command = async (name: string, args: string[], deadline = 15000) => {
    const child = traced(name, args, deadline)
    const result = await finite(
      child.result,
      deadline + 5000,
      `${name} failed to exit after its deadline`,
    )
    await child.stop()
    if (result.exitCode !== 0 || result.timedOut)
      throw new Error(
        `${name} failed: ${result.exitCode} ${result.signal}: ${result.stderr}`,
      )
    return result
  }
  const recorder = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname
      const body = (await request.json()) as Record<string, unknown>
      const requestBody = body.request as Record<string, unknown> | undefined
      const recordedBody =
        requestBody === undefined
          ? body
          : {
              ...body,
              request: {
                sha256: sha256(JSON.stringify(requestBody)),
                bytes: Buffer.byteLength(JSON.stringify(requestBody)),
              },
            }
      receipt.requests.push({
        path,
        authorization: request.headers.get('authorization'),
        body: recordedBody,
      })
      if (!path.endsWith('/v1internal:streamGenerateContent'))
        return Response.json(
          { error: 'Unexpected AGY request' },
          { status: 400 },
        )
      const envelope = {
        response: {
          candidates: [
            {
              content: { role: 'model', parts: [{ text: TERMINAL_TEXT }] },
              finishReason: 'STOP',
              index: 0,
            },
          ],
          usageMetadata: {
            promptTokenCount: 1,
            candidatesTokenCount: 7,
            totalTokenCount: 8,
          },
          modelVersion: 'gemini-3.8-flash',
        },
      }
      receipt.streamBytes = `data: ${JSON.stringify(envelope)}\n\n`
      return new Response(receipt.streamBytes, {
        headers: { 'content-type': 'text/event-stream' },
      })
    },
  })
  try {
    const version = await command('version', ['--version'])
    receipt.binary.version = version.stdout.trim()
    if (receipt.binary.version !== '1.17.13')
      throw new Error('Official floor version mismatch')
    await command('auth-help', ['auth', 'login', '--help'])
    await command('serve-help', ['serve', '--help'])
    await command('run-help', ['run', '--help'])
    // OpenCode installs its SDK unless config directories have node_modules and locked declarations.
    // Reuse the preparer's installed SDK so native plugin loading stays offline.
    for (const dir of [config, join(project, '.opencode')]) {
      await mkdir(dir, { recursive: true, mode: 0o700 })
      const { symlink } = await import('node:fs/promises')
      await symlink(join(ROOT, 'node_modules'), join(dir, 'node_modules'))
      await writeJson(join(dir, 'package.json'), {
        private: true,
        dependencies: { '@opencode-ai/plugin': '1.17.13' },
      })
      await writeJson(join(dir, 'package-lock.json'), {
        lockfileVersion: 3,
        packages: {
          '': { dependencies: { '@opencode-ai/plugin': '1.17.13' } },
          'node_modules/@opencode-ai/plugin': { version: '1.17.13' },
        },
      })
    }
    await writeJson(join(project, '.opencode/antigravity.json'), {
      quiet_mode: true,
      auto_update: false,
      background_quota_refresh: false,
      quota_refresh_interval_minutes: 0,
      proactive_token_refresh: false,
      session_recovery: false,
      cache_warmup_on_switch: false,
    })
    const pluginFile = join(profile, 'native-plugin.ts')
    await writeFile(
      pluginFile,
      pluginSource(`http://127.0.0.1:${recorder.port}`, observationFile),
    )
    await writeJson(join(config, 'opencode.json'), {
      plugin: [pathToFileURL(pluginFile).href],
      enabled_providers: ['google'],
      permission: { '*': 'deny' },
      agent: { title: { disable: true }, summary: { disable: true } },
    })
    // Approve this profile's vault enrollment before native sign-in; creating auth.json here would mask absent-slot activation.
    await withSyntheticVault(profile, receipt, env, async () => {
      const seed = startChild(
        'enrollment',
        [process.execPath, import.meta.path, '--seed'],
        project,
        env,
        15000,
        inspector,
      )
      children.push(seed)
      receipt.processes.push(seed.receipt)
      const seeded = await finite(
        seed.result,
        20000,
        'Enrollment child did not exit',
      )
      await seed.stop()
      if (seeded.exitCode !== 0 || seeded.timedOut)
        throw new Error(`Enrollment preparation failed: ${seeded.stderr}`)
      receipt.authAbsentBefore = !existsSync(authFile)
      receipt.localArtifactsAbsentBefore =
        !existsSync(accountFile) && !existsSync(`${accountFile}.store`)
      if (!receipt.authAbsentBefore || !receipt.localArtifactsAbsentBefore)
        throw new Error(
          'Fresh profile was not absent-auth and absent-local-store',
        )
      await command(
        'login',
        [
          'auth',
          'login',
          '--provider',
          'google',
          '--method',
          ACTIVATION_LABEL,
          '--print-logs',
          '--log-level',
          'INFO',
        ],
        30000,
      )
      receipt.marker = JSON.parse(await readFile(authFile, 'utf8'))
      if (!attach) {
        await command(
          'first-request',
          [
            'run',
            '--dir',
            project,
            '--format',
            'json',
            '--model',
            'google/antigravity-gemini-3.8-flash',
            'Reply with the fixture completion text.',
          ],
          30000,
        )
        return
      }
      const server = traced(
        'serve',
        [
          'serve',
          '--hostname',
          '127.0.0.1',
          '--port',
          '0',
          '--print-logs',
          '--log-level',
          'INFO',
        ],
        60000,
      )
      const serverURL = await new Promise<string>((accept, reject) => {
        const timer = setTimeout(() => {
          clearInterval(poll)
          reject(new Error('Native server did not announce a loopback URL'))
        }, 15000)
        const poll = setInterval(() => {
          const match = server.receipt.stdout.match(/http:\/\/127\.0\.0\.1:\d+/)
          if (match) {
            clearTimeout(timer)
            clearInterval(poll)
            accept(match[0])
          }
        }, 25)
        server.result.then(() => {
          clearTimeout(timer)
          clearInterval(poll)
          reject(
            new Error(`Native server exited early: ${server.receipt.stderr}`),
          )
        }, reject)
      })
      await command(
        'first-request',
        [
          'run',
          '--attach',
          serverURL,
          '--dir',
          project,
          '--format',
          'json',
          '--model',
          'google/antigravity-gemini-3.8-flash',
          'Reply with the fixture completion text.',
        ],
        30000,
      )
      const session = server.receipt.stderr.match(
        /message=created id=(ses_[^ ]+)/,
      )?.[1]
      if (session) {
        const stored = await fetch(
          `${serverURL}/session/${session}/message?directory=${encodeURIComponent(project)}`,
          { signal: AbortSignal.timeout(5000) },
        )
        receipt.storedMessages = await stored.json()
      }
      await server.stop()
    })
  } catch (error) {
    receipt.error = error instanceof Error ? error.stack : String(error)
  } finally {
    for (const child of children) {
      try {
        await child.stop()
      } catch (error) {
        receipt.error = `${receipt.error ?? ''}\nCleanup: ${String(error)}`
      }
    }
    inspector.close()
    recorder.stop(true)
    if (existsSync(observationFile))
      receipt.observations = (await readFile(observationFile, 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    for (const child of children) {
      const trace = join(profile, `${child.receipt.name}.syscalls`)
      if (!existsSync(trace)) continue
      const raw = await readFile(trace, 'utf8')
      receipt.syscallRecords.push({
        child: child.receipt.name,
        sha256: sha256(raw),
        lines: raw.split('\n').length - 1,
      })
      receipt.localFileSyscalls.push(
        ...raw.split('\n').filter((line) => line.includes(accountFile)),
      )
    }
    if (existsSync(accountFile) || existsSync(`${accountFile}.store`))
      receipt.error = `${receipt.error ?? ''}\nA local account artifact was created`
    await writeJson(join(profile, 'receipt.json'), receipt)
  }
  return receipt
}

type SubcWire = typeof import('@cortexkit/subc-client')

export async function withSyntheticVault(
  profile: string,
  receipt: Pick<ActivationReceipt, 'vaultCalls'>,
  env: NodeJS.ProcessEnv,
  run: () => Promise<void>,
  clientBase = join(ROOT, 'packages/opencode/src'),
): Promise<void> {
  // Use the production client's own framing and proof implementation rather than a replacement client.
  const clientEntry = Bun.resolveSync('@cortexkit/claustrum-client', clientBase)
  const subc: SubcWire = await import(
    Bun.resolveSync('@cortexkit/subc-client', dirname(clientEntry))
  )
  const key = Uint8Array.from({ length: 32 }, (_, index) => index + 1)
  const daemonId = Uint8Array.from({ length: 16 }, (_, index) => 200 + index)
  const sockets = new Set<Socket>()
  const respond = (
    socket: Socket,
    header: ReturnType<SubcWire['decodeHeader']>,
    body: unknown,
    type = subc.FrameType.Response,
  ) => {
    socket.write(
      Buffer.from(
        subc.encodeFrame(
          subc.buildFrame(
            type,
            subc.buildFlags(false, subc.Priority.Interactive, false),
            header.channel,
            header.epoch,
            header.corr,
            new TextEncoder().encode(JSON.stringify(body)),
          ),
        ),
      ),
    )
  }
  const handle = (
    method: string | undefined,
    params: Record<string, unknown>,
  ) => {
    receipt.vaultCalls.push({ method, params })
    if (params.enrollment_token !== 'ab'.repeat(32))
      return { error: { code: 'invalid_enrollment', class: 'auth_required' } }
    if (method === 'credential.list_scoped')
      return {
        result: {
          view: 'synthetic-antigravity-view',
          credentials: [
            {
              id: 'synthetic-credential',
              type: 'oauth',
              state: 'active',
              record_version: 1,
              categories: ['antigravity-native'],
              serves: ['google'],
              provider_ids: ['google'],
              operations: ['read'],
              refresh_adapter: 'antigravity',
              account_id: 'synthetic-account',
            },
          ],
        },
      }
    if (
      method === 'credential.get_scoped' &&
      params.credential_id === 'synthetic-credential'
    )
      return {
        result: {
          payload: Array.from(new TextEncoder().encode(SYNTHETIC_TOKEN)),
          credential_id: 'synthetic-credential',
          project_id: SYNTHETIC_PROJECT,
          account_id: 'synthetic-account',
          record_version: 1,
          expires_at_ms: Date.now() + 3600000,
        },
      }
    return { error: { code: 'unexpected_method', class: 'permanent' } }
  }
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    socket.on('error', (error) =>
      receipt.vaultCalls.push({ socketError: error.message }),
    )
    let buffer = Buffer.alloc(0)
    let phase: 'hello' | 'auth' | 'frames' = 'hello'
    let routeChannel: number | undefined
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      try {
        for (;;) {
          if (phase !== 'frames') {
            if (buffer.length < 4) return
            const length = buffer.readUInt32LE(0)
            if (length > 1048576)
              throw new Error('Oversized synthetic vault handshake')
            if (buffer.length < 4 + length) return
            const body = JSON.parse(
              buffer.subarray(4, 4 + length).toString(),
            ) as { client_nonce: number[] }
            buffer = buffer.subarray(4 + length)
            if (phase === 'hello') {
              const serverNonce = Uint8Array.from(
                { length: 32 },
                (_, index) => 100 + index,
              )
              const reply = Buffer.from(
                JSON.stringify({
                  daemon_id: Array.from(daemonId),
                  server_nonce: Array.from(serverNonce),
                  daemon_ver: 'owned-synthetic-vault',
                  server_proof: Array.from(
                    subc.computeProof(
                      key,
                      subc.SERVER_PROOF_DOMAIN,
                      Uint8Array.from(body.client_nonce),
                      serverNonce,
                      daemonId,
                    ),
                  ),
                }),
              )
              const prefix = Buffer.alloc(4)
              prefix.writeUInt32LE(reply.length)
              socket.write(Buffer.concat([prefix, reply]))
              phase = 'auth'
            } else {
              phase = 'frames'
            }
            continue
          }
          if (buffer.length < subc.HEADER_LEN) return
          const header = subc.decodeHeader(buffer.subarray(0, subc.HEADER_LEN))
          if (header.len > 1048576)
            throw new Error('Oversized synthetic vault frame')
          if (buffer.length < subc.HEADER_LEN + header.len) return
          const body = buffer.subarray(
            subc.HEADER_LEN,
            subc.HEADER_LEN + header.len,
          )
          buffer = buffer.subarray(subc.HEADER_LEN + header.len)
          if (header.ty !== subc.FrameType.Request) continue
          const request = JSON.parse(body.toString()) as {
            op?: string
            method?: string
            params?: Record<string, unknown>
          }
          if (header.channel === 0) {
            if (request.op === 'route.open') routeChannel = 7
            respond(socket, header, { route_channel: 7, route_epoch: 1 })
            continue
          }
          if (header.channel !== routeChannel) {
            respond(
              socket,
              header,
              { code: 'unknown_channel' },
              subc.FrameType.Error,
            )
            continue
          }
          respond(socket, header, handle(request.method, request.params ?? {}))
        }
      } catch (error) {
        receipt.vaultCalls.push({ protocolError: String(error) })
        socket.destroy()
      }
    })
  })
  await new Promise<void>((accept, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', accept)
  })
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('Synthetic vault has no owned TCP address')
  env.SUBC_CONNECTION_FILE = join(profile, 'claustrum-connection.json')
  await writeJson(env.SUBC_CONNECTION_FILE, {
    schema: 1,
    wire_version: subc.PROTOCOL_VERSION,
    endpoints: [{ host: '127.0.0.1', port: address.port }],
    key: Array.from(key),
    daemon_id: Array.from(daemonId),
    pid: process.pid,
    daemon_ver: 'owned-synthetic-vault',
  })
  try {
    await run()
  } finally {
    for (const socket of sockets) socket.destroy()
    await finite(
      new Promise<void>((accept, reject) =>
        server.close((error) => (error ? reject(error) : accept())),
      ),
      5000,
      'Synthetic vault listener cleanup did not finish',
    )
  }
}

if (import.meta.main && process.argv.includes('--seed')) await seedEnrollment()
if (import.meta.main && process.argv.includes('--run')) {
  const receipt = await runNativeActivation(process.argv.includes('--attach'))
  console.log(
    `NATIVE_V1_STORED_MESSAGES ${JSON.stringify(receipt.storedMessages)}`,
  )
  console.log(
    `NATIVE_V1_RECEIPT_GZIP_BASE64 ${gzipSync(JSON.stringify(receipt)).toString('base64')}`,
  )
}
