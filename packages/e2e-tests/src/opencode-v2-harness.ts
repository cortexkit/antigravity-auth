import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { createRequire } from 'node:module'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runCommand } from '../../../test/support/run-command.ts'

export interface OpenCodeV2RecordedRequest {
  kind: 'adapter' | 'direct-provider'
  method: string
  path: string
  body: unknown
  authorization?: string
  endpoint?: string
}

export interface OpenCodeV2RunResult {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  timedOut: boolean
}

export type OpenCodeV2Scenario =
  | 'success'
  | 'clean-eof'
  | 'embedded-error'
  | 'account-ineligible'
  | 'capacity-fallback'
  | 'transport-reset'
  | 'tool-roundtrip'
  | 'image'

export interface OpenCodeV2Harness {
  readonly accountsFile: string
  readonly databaseFile: string
  readonly imageDirectory: string
  readonly logFile: string
  readonly requests: OpenCodeV2RecordedRequest[]
  run(model: string, prompt: string): Promise<OpenCodeV2RunResult>
  dispose(): Promise<void>
}

const MOCK_PROJECT_ID = 'opencode-v2-e2e-project'

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {}
}

function listen(server: Server): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('OpenCode 2 mock server did not publish a port'))
        return
      }
      resolvePromise(address.port)
    })
  })
}

function close(server: Server): Promise<void> {
  server.closeAllConnections?.()
  return new Promise((resolvePromise) => {
    server.close(() => resolvePromise())
  })
}

function readBody(
  request: import('node:http').IncomingMessage,
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    })
    request.once('end', () =>
      resolvePromise(Buffer.concat(chunks).toString('utf8')),
    )
    request.once('error', reject)
  })
}

function parseJson(text: string): unknown {
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function successSse(): string {
  return [
    `data: ${JSON.stringify({
      response: {
        candidates: [
          {
            index: 0,
            content: {
              role: 'model',
              parts: [{ text: 'E2E_OK' }],
            },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: {
          promptTokenCount: 7,
          candidatesTokenCount: 2,
          totalTokenCount: 9,
        },
      },
    })}`,
    '',
    '',
  ].join('\r\n')
}

function toolCallSse(): string {
  return [
    `data: ${JSON.stringify({
      response: {
        candidates: [
          {
            index: 0,
            content: {
              role: 'model',
              parts: [
                {
                  functionCall: {
                    name: 'read',
                    args: { path: 'README.md', offset: 1, limit: 20 },
                  },
                  thoughtSignature: 's'.repeat(64),
                },
              ],
            },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: {
          promptTokenCount: 7,
          candidatesTokenCount: 2,
          totalTokenCount: 9,
        },
      },
    })}`,
    '',
    '',
  ].join('\r\n')
}

function imageSse(): string {
  return [
    `data: ${JSON.stringify({
      response: {
        candidates: [
          {
            index: 0,
            content: {
              role: 'model',
              parts: [
                {
                  inlineData: {
                    mimeType: 'image/png',
                    data: Buffer.from('opencode-v2-image-e2e').toString(
                      'base64',
                    ),
                  },
                },
              ],
            },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 1,
          totalTokenCount: 11,
        },
      },
    })}`,
    '',
    '',
  ].join('\r\n')
}

function writeAccountStorage(path: string, accountCount: 1 | 2): void {
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        version: 4,
        accounts: [
          {
            refreshToken: 'opencode-v2-e2e-refresh',
            projectId: MOCK_PROJECT_ID,
            addedAt: 1,
            lastUsed: 0,
            enabled: true,
            rateLimitResetTimes: {},
          },
          ...(accountCount === 2
            ? [
                {
                  refreshToken: 'opencode-v2-e2e-refresh-two',
                  projectId: MOCK_PROJECT_ID,
                  addedAt: 2,
                  lastUsed: 0,
                  enabled: true,
                  rateLimitResetTimes: {},
                },
              ]
            : []),
        ],
        activeIndex: 0,
        activeIndexByFamily: { claude: 0, gemini: 0 },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  )
}

function writeWrapper(
  path: string,
  pluginEntry: string,
  mockBaseUrl: string,
): void {
  mkdirSync(path, { recursive: true })
  writeFileSync(
    join(path, 'package.json'),
    `${JSON.stringify({ name: 'antigravity-opencode-v2-e2e-wrapper', private: true, type: 'module' })}\n`,
  )
  writeFileSync(
    join(path, 'index.mjs'),
    `import { createOpenCodeV2AntigravityPlugin } from ${JSON.stringify(pluginEntry)}\n` +
      `const plugin = createOpenCodeV2AntigravityPlugin({\n` +
      `  refreshAntigravityToken: async (refresh) => ({ refresh, access: refresh + '-access', expires: Date.now() + 3_600_000 }),\n` +
      `  ensureProjectContext: async () => ({ effectiveProjectId: ${JSON.stringify(MOCK_PROJECT_ID)} }),\n` +
      `  send: ({ envelope, auth, endpoint, signal, kind }) => fetch(${JSON.stringify(`${mockBaseUrl}/agy`)} + '/' + kind, { method: 'POST', headers: { 'authorization': 'Bearer ' + auth.access, 'content-type': 'application/json', 'x-agy-endpoint': endpoint }, body: JSON.stringify(envelope), signal }),\n` +
      `})\n` +
      `const setup = plugin.setup\n` +
      `export default { ...plugin, setup: async (context) => {\n` +
      `  const cleanup = await setup(context)\n` +
      `  await context.session.hook('retry', async (event) => { event.decision = { retry: false } })\n` +
      `  return cleanup\n` +
      `} }\n`,
  )
}

export async function createOpenCodeV2Harness(
  scenario: OpenCodeV2Scenario = 'success',
): Promise<OpenCodeV2Harness> {
  const testRoot = process.env.ANTIGRAVITY_TEST_ROOT
  if (!testRoot) throw new Error('ANTIGRAVITY_TEST_ROOT is not set')

  const root = join(testRoot, 'opencode-v2')
  const paths = {
    home: join(root, 'home'),
    config: join(root, 'config'),
    data: join(root, 'data'),
    state: join(root, 'state'),
    cache: join(root, 'cache'),
    temp: join(root, 'tmp'),
    project: join(root, 'project'),
  }
  for (const directory of Object.values(paths))
    mkdirSync(directory, { recursive: true })
  const init = await runCommand(['git', 'init', '-q'], {
    cwd: paths.project,
    deadlineMs: 10_000,
  })
  if (init.exitCode !== 0)
    throw new Error(`Command failed: git init -q\n${init.stderr}`)
  writeFileSync(
    join(paths.project, 'README.md'),
    '# OpenCode 2 E2E\n\nTool round-trip fixture.\n',
  )

  const requests: OpenCodeV2RecordedRequest[] = []
  let rejectedIneligibleAuthorization: string | undefined
  let toolRoundtripCalls = 0
  const server = createServer(async (request, response) => {
    const text = await readBody(request)
    const kind = request.url?.startsWith('/agy/')
      ? 'adapter'
      : 'direct-provider'
    const body = parseJson(text)
    requests.push({
      kind,
      method: request.method ?? 'GET',
      path: request.url ?? '/',
      body,
      ...(request.headers.authorization
        ? { authorization: request.headers.authorization }
        : {}),
      ...(request.headers['x-agy-endpoint']
        ? { endpoint: String(request.headers['x-agy-endpoint']) }
        : {}),
    })

    if (kind === 'direct-provider') {
      response.writeHead(418, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({ error: { message: 'adapter was bypassed' } }),
      )
      return
    }

    if (scenario === 'transport-reset' && request.url === '/agy/primary') {
      request.socket.destroy()
      return
    }

    if (scenario === 'capacity-fallback') {
      const endpoint = String(request.headers['x-agy-endpoint'] ?? '')
      if (endpoint.includes('daily-cloudcode-pa.googleapis.com')) {
        response.writeHead(503, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify({
            error: {
              code: 503,
              status: 'UNAVAILABLE',
              message: 'Model capacity exhausted',
            },
          }),
        )
        return
      }
    }

    if (
      scenario === 'account-ineligible' &&
      request.url === '/agy/primary' &&
      !rejectedIneligibleAuthorization
    ) {
      rejectedIneligibleAuthorization = request.headers.authorization
      response.writeHead(403, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          error: {
            code: 403,
            status: 'PERMISSION_DENIED',
            message: 'Account is not eligible for Antigravity',
            details: [{ reason: 'ACCOUNT_INELIGIBLE' }],
          },
        }),
      )
      return
    }

    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
    })
    if (scenario === 'clean-eof') {
      response.end()
      return
    }
    if (scenario === 'embedded-error') {
      response.end(
        `data: ${JSON.stringify({
          error: {
            code: 503,
            message: 'OpenCode 2 embedded E2E failure',
            status: 'UNAVAILABLE',
          },
        })}\r\n\r\n`,
      )
      return
    }
    const envelope = asRecord(body)
    if (
      scenario === 'tool-roundtrip' &&
      (envelope.model === 'gemini-3.8-flash-medium' ||
        envelope.model === 'claude-sonnet-4-6')
    ) {
      toolRoundtripCalls += 1
      response.end(toolRoundtripCalls === 1 ? toolCallSse() : successSse())
      return
    }
    response.end(
      scenario === 'image' && envelope.model === 'gemini-3.1-flash-image'
        ? imageSse()
        : successSse(),
    )
  })
  const port = await listen(server)
  const mockBaseUrl = `http://127.0.0.1:${port}`

  const packageRoot = resolve('packages/opencode-v2')
  const pluginEntry = pathToFileURL(join(packageRoot, 'dist', 'plugin.js')).href
  const wrapper = join(paths.config, 'antigravity-opencode-v2-wrapper')
  writeWrapper(wrapper, pluginEntry, mockBaseUrl)

  const opencodeConfigDir = join(paths.config, 'opencode')
  mkdirSync(opencodeConfigDir, { recursive: true, mode: 0o700 })
  const accountsFile = join(opencodeConfigDir, 'antigravity-accounts.json')
  writeAccountStorage(accountsFile, scenario === 'account-ineligible' ? 2 : 1)
  writeFileSync(
    join(opencodeConfigDir, 'opencode.json'),
    `${JSON.stringify(
      {
        $schema: 'https://opencode.ai/config.json',
        plugins: [pathToFileURL(wrapper).href],
        providers: {
          google: {
            name: 'Google',
            package: '@opencode-ai/ai/providers/google',
            settings: {
              apiKey: '{env:GOOGLE_GENERATIVE_AI_API_KEY}',
              baseURL: `${mockBaseUrl}/direct/v1`,
            },
            models: {
              'gemini-3.8-flash': {
                name: 'Gemini 3.8 Flash E2E',
                variants: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }],
              },
              'claude-sonnet-4-6-thinking': {
                name: 'Claude Sonnet 4.6 Thinking E2E',
                variants: [],
              },
            },
          },
        },
      },
      null,
      2,
    )}\n`,
  )

  const require = createRequire(import.meta.url)
  const cliPackage = require.resolve('@opencode-ai/cli/package.json')
  const platformPackage = `@opencode-ai/cli-${process.platform}-${process.arch}`
  const platformPackageJson = createRequire(cliPackage).resolve(
    `${platformPackage}/package.json`,
  )
  const executable = join(
    resolve(platformPackageJson, '..'),
    'bin',
    process.platform === 'win32' ? 'opencode2.exe' : 'opencode2',
  )
  const databaseFile = join(paths.data, 'opencode-v2-e2e.db')
  const imageDirectory = join(paths.home, '.opencode', 'generated-images')
  const logFile = join(paths.state, 'opencode', 'antigravity-v2.log')
  const databaseRelative = relative(paths.data, databaseFile)
  if (databaseRelative.startsWith('..') || isAbsolute(databaseRelative)) {
    throw new Error(
      `OpenCode 2 E2E database escaped isolation: ${databaseFile}`,
    )
  }
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: paths.home,
    USERPROFILE: paths.home,
    XDG_CONFIG_HOME: paths.config,
    XDG_DATA_HOME: paths.data,
    XDG_STATE_HOME: paths.state,
    XDG_CACHE_HOME: paths.cache,
    TMPDIR: paths.temp,
    PWD: paths.project,
    INIT_CWD: paths.project,
    OPENCODE_CONFIG_DIR: opencodeConfigDir,
    OPENCODE_DB: databaseFile,
    ANTIGRAVITY_ACCOUNTS_FILE: accountsFile,
    GOOGLE_GENERATIVE_AI_API_KEY: 'opencode-v2-e2e-key',
    OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
  }
  delete environment.OPENCODE_CONFIG_CONTENT
  delete environment.OPENCODE_SERVER
  delete environment.OPENCODE_SERVER_PASSWORD

  return {
    accountsFile,
    databaseFile,
    imageDirectory,
    logFile,
    requests,
    run(model, prompt) {
      return new Promise((resolvePromise, reject) => {
        const child = spawn(
          executable,
          [
            'run',
            '--standalone',
            '--print-logs',
            '--log-level',
            'debug',
            '--format',
            'json',
            '--model',
            model,
            prompt,
          ],
          {
            cwd: paths.project,
            env: environment,
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        )
        let stdout = ''
        let stderr = ''
        let timedOut = false
        child.stdout.on('data', (chunk: Buffer | string) => {
          stdout += String(chunk)
        })
        child.stderr.on('data', (chunk: Buffer | string) => {
          stderr += String(chunk)
        })
        child.once('error', reject)
        const timer = setTimeout(() => {
          timedOut = true
          child.kill('SIGKILL')
        }, 30_000)
        timer.unref()
        child.once('exit', (code, signal) => {
          clearTimeout(timer)
          resolvePromise({ code, signal, stdout, stderr, timedOut })
        })
      })
    },
    dispose: () => close(server),
  }
}
