import assert from 'node:assert/strict'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const source = join(root, 'packages/opencode/src')
const suffix = process.versions.bun ? 'ts' : 'js'
let nodeRuntime
async function load(path) {
  if (process.versions.bun)
    return import(pathToFileURL(join(source, path)).href)
  // Handwritten tsc output uses Bundler resolution (extensionless relatives).
  // Exercise the real adapters in one Node bundle, just like the product build,
  // without editing emitted files or installing a compatibility resolver.
  nodeRuntime ??= (async () => {
    const { build } = await import(
      pathToFileURL(
        join(root, 'packages/opencode/node_modules/esbuild/lib/main.js'),
      ).href
    )
    const nodeRuntimeDir = mkdtempSync(
      join(dirname(fileURLToPath(import.meta.url)), '.node-runtime-'),
    )
    const outfile = join(nodeRuntimeDir, 'logger.mjs')
    try {
      await build({
        stdin: {
          contents: [
            `export * as provider from ${JSON.stringify(join(source, 'plugin/logger.ts'))};`,
            `export * as debug from ${JSON.stringify(join(source, 'plugin/debug.ts'))};`,
            `export * as config from ${JSON.stringify(join(source, 'plugin/config/index.ts'))};`,
            `export * as tui from ${JSON.stringify(join(source, 'tui/file-logger.ts'))};`,
          ].join('\n'),
          resolveDir: root,
          sourcefile: 'logger-runtime-witness.ts',
        },
        bundle: true,
        platform: 'node',
        format: 'esm',
        target: 'node20',
        outfile,
        plugins: [
          {
            name: 'canonical-core-identity',
            setup(builder) {
              builder.onResolve(
                { filter: /^@cortexkit\/antigravity-auth-core$/ },
                () => ({
                  path: pathToFileURL(join(root, 'packages/core/dist/index.js'))
                    .href,
                  external: true,
                }),
              )
            },
          },
        ],
      })
      return await import(pathToFileURL(outfile).href)
    } finally {
      rmSync(nodeRuntimeDir, { recursive: true, force: true })
    }
  })()
  const bundle = await nodeRuntime
  return {
    'plugin/logger.js': bundle.provider,
    'plugin/debug.js': bundle.debug,
    'plugin/config/index.js': bundle.config,
    'tui/file-logger.js': bundle.tui,
  }[path]
}
const mask = '***REDACTED***'
const prefix = '[opencode-antigravity-auth/tui] '

function records(path) {
  return readFileSync(path, 'utf8')
    .trimEnd()
    .split('\n')
    .map((line) => {
      assert.ok(line.startsWith(prefix), 'immediate host prefix retained')
      return JSON.parse(line.slice(prefix.length))
    })
}

async function fixture(run) {
  const dir = mkdtempSync(join(tmpdir(), 'agy-logger-contract-'))
  const environment = {
    HOME: join(dir, 'home'),
    USERPROFILE: join(dir, 'home'),
    XDG_STATE_HOME: join(dir, 'state'),
    XDG_CONFIG_HOME: join(dir, 'config'),
    XDG_CACHE_HOME: join(dir, 'cache'),
    XDG_DATA_HOME: join(dir, 'data'),
    OPENCODE_CONFIG_DIR: join(dir, 'config/opencode'),
    ANTIGRAVITY_AUTH_TUI_LOG_FILE: join(dir, 'logs/tui.log'),
    OPENCODE_ANTIGRAVITY_DEBUG: '0',
    OPENCODE_ANTIGRAVITY_DEBUG_TUI: '0',
    OPENCODE_ANTIGRAVITY_CONSOLE_LOG: '0',
    ANTIGRAVITY_CORE_CONSOLE_LOG: '0',
  }
  const saved = Object.fromEntries(
    Object.keys(environment).map((key) => [key, process.env[key]]),
  )
  Object.assign(process.env, environment)
  for (const path of ['home', 'state', 'config', 'cache', 'data']) {
    mkdirSync(join(dir, path), { recursive: true })
  }
  let debug
  let config
  try {
    const provider = await load(`plugin/logger.${suffix}`)
    debug = await load(`plugin/debug.${suffix}`)
    config = await load(`plugin/config/index.${suffix}`)
    const tui = await load(`tui/file-logger.${suffix}`)
    const core = await import(
      pathToFileURL(join(root, 'packages/core/dist/index.js')).href
    )
    const received = []
    const early = provider.createLogger('early-channel')
    const client = {
      app: {
        log: (record) => {
          received.push(record.body)
          return Promise.resolve()
        },
      },
    }
    debug.initializeDebug({ ...config.DEFAULT_CONFIG, debug_tui: true })
    provider.initLogger(client)
    await run({
      dir,
      provider,
      debug,
      config,
      tui,
      core,
      received,
      client,
      early,
    })
  } finally {
    if (debug && config) debug.initializeDebug(config.DEFAULT_CONFIG)
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(dir, { recursive: true, force: true })
  }
}

function captureTerminal(run) {
  const writes = []
  const savedConsole = {}
  for (const name of ['debug', 'info', 'warn', 'error', 'log']) {
    savedConsole[name] = console[name]
    console[name] = (...args) => writes.push([name, ...args])
  }
  const stdout = process.stdout.write
  const stderr = process.stderr.write
  process.stdout.write = (...args) => {
    writes.push(['stdout', ...args])
    return true
  }
  process.stderr.write = (...args) => {
    writes.push(['stderr', ...args])
    return true
  }
  try {
    run(writes)
  } finally {
    Object.assign(console, savedConsole)
    process.stdout.write = stdout
    process.stderr.write = stderr
  }
}

function instanceConfiguration(relative) {
  const path = join(source, relative)
  const ast = ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  )
  const calls = []
  const imports = []
  function walk(node) {
    if (ts.isImportDeclaration(node)) imports.push(node)
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'createLoggerInstance'
    ) {
      calls.push(node)
    }
    ts.forEachChild(node, walk)
  }
  walk(ast)
  const imported = imports.find(
    (node) =>
      node.moduleSpecifier.text === '../common-auth-embedded/logger/index.js',
  )
  assert.ok(imported, `${relative} uses the canonical public logger root`)
  const bindings = imported.importClause.namedBindings.elements
  assert.deepEqual(
    bindings
      .filter((binding) => !binding.isTypeOnly)
      .map((binding) => (binding.propertyName ?? binding.name).text),
    ['createLoggerInstance'],
    `${relative} does not use the shared default engine`,
  )
  assert.equal(calls.length, 1, `${relative} creates its own instance`)
  const options = calls[0].arguments[0]
  assert.ok(ts.isObjectLiteralExpression(options))
  assert.ok(
    options.properties.some(
      (node) => node.name?.getText(ast) === 'captureSink',
    ),
  )
  assert.ok(
    !options.properties.some((node) => node.name?.getText(ast) === 'file'),
  )
  assert.ok(
    !/\b(flushLogs|setLogLevel|configure|beforeExit)\b/.test(ast.getText()),
  )
}

const cases = {
  'logger.explicit_debug': async () =>
    fixture(({ early, tui, received }) => {
      // No level setter precedes this observation: the initial provider floor
      // must be debug, even for a channel created before the client is known.
      early.debug('provider-initial-debug', { count: 1 })
      early.info('provider-info-control', { count: 2 })
      assert.deepEqual(
        received.map((entry) => entry.message),
        ['provider-initial-debug', 'provider-info-control'],
      )
      const logger = tui.createTuiFileLogger()
      logger.debug('tui-explicit-debug', { status: 200 })
      logger.info('tui-info-control')
      assert.deepEqual(
        records(logger.getLogPath()).map((entry) => entry.message),
        ['tui-explicit-debug', 'tui-info-control'],
      )
    }),

  'logger.sinks_levels': async () =>
    fixture(({ dir, provider, debug, config, received, client }) => {
      const early = provider.createLogger('precreated')
      for (const [floor, expected] of [
        ['error', ['error']],
        ['warn', ['warn', 'error']],
        ['info', ['info', 'warn', 'error']],
        ['debug', ['debug', 'info', 'warn', 'error']],
        ['trace', ['debug', 'info', 'warn', 'error']],
      ]) {
        provider.setRuntimeLogLevel(floor)
        received.length = 0
        for (const level of ['debug', 'info', 'warn', 'error'])
          early[level](level)
        assert.deepEqual(
          received.map((entry) => entry.level),
          expected,
          floor,
        )
      }
      provider.setRuntimeLogLevel('info')
      captureTerminal((terminal) => {
        for (const debugTui of [false, true]) {
          for (const consoleEnabled of [false, true]) {
            debug.initializeDebug({
              ...config.DEFAULT_CONFIG,
              debug: false,
              debug_tui: debugTui,
            })
            process.env.OPENCODE_ANTIGRAVITY_CONSOLE_LOG = consoleEnabled
              ? '1'
              : '0'
            received.length = 0
            terminal.length = 0
            early.info('independent-destinations', { count: 3 })
            assert.equal(received.length, Number(debugTui))
            assert.equal(terminal.length, Number(consoleEnabled))
          }
        }
        debug.initializeDebug({
          ...config.DEFAULT_CONFIG,
          debug: true,
          debug_tui: false,
          log_dir: join(dir, 'debug'),
        })
        process.env.OPENCODE_ANTIGRAVITY_CONSOLE_LOG = '0'
        received.length = 0
        terminal.length = 0
        early.info('debug-file-is-not-a-provider-sink')
        assert.equal(received.length, 0)
        assert.equal(terminal.length, 0)

        debug.initializeDebug({ ...config.DEFAULT_CONFIG, debug_tui: true })
        process.env.OPENCODE_ANTIGRAVITY_CONSOLE_LOG = 'true'
        provider.initLogger({
          app: {
            log: () => {
              throw new Error('host failure')
            },
          },
        })
        terminal.length = 0
        assert.doesNotThrow(() => early.error('sync-failure'))
        assert.equal(
          terminal.length,
          1,
          'a failing panel does not suppress console',
        )
        provider.initLogger({
          app: { log: () => Promise.reject(new Error('rejected')) },
        })
        assert.doesNotThrow(() => early.error('async-failure'))
        provider.initLogger(client)
      })
    }),

  'logger.instances': async () =>
    fixture(({ dir, provider, tui, received, client }) => {
      const before = provider.createLogger('before-tui')
      provider.setRuntimeLogLevel('error')
      const listeners = ['exit', 'beforeExit', 'SIGINT', 'SIGTERM'].map(
        (name) => process.listenerCount(name),
      )
      let timers = 0
      const timeout = globalThis.setTimeout
      globalThis.setTimeout = (...args) => {
        timers += 1
        return timeout(...args)
      }
      try {
        const first = tui.createTuiFileLogger({
          filePath: join(dir, 'first.log'),
        })
        const second = tui.createTuiFileLogger({
          filePath: join(dir, 'second.log'),
        })
        first.info('first')
        second.info('second')
        before.info('provider-filtered')
        before.error('provider-retained')
        assert.equal(received.length, 1)
        assert.equal(received[0].message, 'provider-retained')
        assert.deepEqual(
          records(first.getLogPath()).map((entry) => entry.message),
          ['first'],
        )
        assert.deepEqual(
          records(second.getLogPath()).map((entry) => entry.message),
          ['second'],
        )
        const latest = []
        provider.initLogger({
          app: {
            log: ({ body }) => {
              latest.push(body)
              return Promise.resolve()
            },
          },
        })
        before.error('last-init')
        assert.equal(latest.length, 1)
        assert.equal(received.length, 1)
        provider.initLogger(client)
        assert.equal(timers, 0, 'sink-only writes schedule no flush resource')
        assert.deepEqual(
          ['exit', 'beforeExit', 'SIGINT', 'SIGTERM'].map((name) =>
            process.listenerCount(name),
          ),
          listeners,
          'sink-only adapters register no lifecycle resource',
        )
        instanceConfiguration('plugin/logger.ts')
        instanceConfiguration('tui/file-logger.ts')
      } finally {
        globalThis.setTimeout = timeout
      }
    }),

  'logger.shared_key_policy': async () =>
    fixture(({ provider, tui, received }) => {
      const policy = readFileSync(
        join(source, 'logging/provider-key-policy.ts'),
        'utf8',
      )
      const ast = ts.createSourceFile(
        'policy.ts',
        policy,
        ts.ScriptTarget.Latest,
        true,
      )
      assert.equal(
        ast.statements.filter(ts.isImportDeclaration).length,
        0,
        'pure key policy',
      )
      assert.ok(
        !/\b(require|import)\s*\(/.test(policy),
        'no dynamic dependency',
      )
      const secrets = {
        session_id: 'fake-session-identifier',
        project: { nested: 'fake-project-identifier' },
        tokenCount: 7,
        managedProjectId: 'fake-managed-project',
        refreshCredentials: ['fake-refresh'],
        'device-id': 'fake-device',
        accessContext: 'fake-access',
        fingerprint: 'fake-fingerprint',
        sessionToken: 'fake-session-token',
        api_key: 'fake-api',
        client_secret: 'fake-client',
        password: 'fake-password',
      }
      const input = {
        ...secrets,
        eventId: 17,
        notificationId: 18,
        command: 'refresh',
        count: 4,
        status: 429,
        code: 'E_RATE',
      }
      const original = JSON.stringify(input)
      provider.setRuntimeLogLevel('info')
      provider.createLogger('key-policy').info('diagnostic', input)
      const logger = tui.createTuiFileLogger()
      logger.info('diagnostic', input)
      for (const extra of [
        received[0].extra,
        records(logger.getLogPath())[0].extra,
      ]) {
        for (const key of Object.keys(secrets))
          assert.equal(extra[key], mask, key)
        assert.deepEqual(
          Object.fromEntries(
            [
              'eventId',
              'notificationId',
              'command',
              'count',
              'status',
              'code',
            ].map((key) => [key, extra[key]]),
          ),
          {
            eventId: 17,
            notificationId: 18,
            command: 'refresh',
            count: 4,
            status: 429,
            code: 'E_RATE',
          },
          'useful diagnostic fields survive',
        )
      }
      assert.equal(JSON.stringify(input), original, 'input is unchanged')
    }),

  'logger.error_redaction': async () =>
    fixture(({ provider, tui, received }) => {
      const values = [
        'Bearer fake-bearer',
        'eyJfake.header.signature',
        'sk-fake-secret',
        `ckh_${'a'.repeat(24)}`,
      ]
      const text = `request failed ${values.join(' ')} useful-detail`
      const cause = Object.assign(new Error(text), {
        code: 'E_CAUSE',
        status: 503,
        detail: text,
      })
      const error = Object.assign(new TypeError(text, { cause }), {
        code: 'E_RATE',
        status: 429,
        retryCount: 3,
        detail: text,
      })
      const foreign = runInNewContext('new RangeError("foreign failure")')
      foreign.message = text
      foreign.stack = `RangeError: ${text}\n at foreign-frame`
      foreign.code = 'E_FOREIGN'
      foreign.cause = cause
      const chain = Array.from(
        { length: 12 },
        (_, index) => new Error(`cause-${index}`),
      )
      for (let i = 0; i < chain.length - 1; i += 1)
        chain[i].cause = chain[i + 1]
      const cycle = { count: 9 }
      cycle.self = cycle
      cause.cause = error
      class Diagnostic {
        count = 8
        detail = text
      }
      const input = {
        error,
        nested: [foreign],
        cycle,
        chain: chain[0],
        nonplain: new Diagnostic(),
        date: new Date(0),
        count: 5,
      }
      const originalStack = error.stack
      provider.setRuntimeLogLevel('info')
      const logger = tui.createTuiFileLogger()
      captureTerminal((terminal) => {
        process.env.OPENCODE_ANTIGRAVITY_CONSOLE_LOG = '1'
        provider.createLogger('errors').error(text, input)
        logger.error(text, input)
        const file = records(logger.getLogPath())[0]
        for (const record of [received[0], file]) {
          const serialized = JSON.stringify(record)
          for (const secret of values)
            assert.ok(!serialized.includes(secret), secret)
          assert.ok(record.message.includes('request failed'))
          assert.ok(record.message.includes('useful-detail'))
          assert.equal(record.extra.count, 5)
          assert.equal(record.extra.error.name, 'TypeError')
          assert.ok(record.extra.error.message.includes('useful-detail'))
          assert.ok(record.extra.error.stack.includes('TypeError'))
          assert.equal(record.extra.error.code, 'E_RATE')
          assert.equal(record.extra.error.status, 429)
          assert.equal(record.extra.error.retryCount, 3)
          assert.ok(record.extra.error.detail.includes('useful-detail'))
          assert.equal(record.extra.error.cause.code, 'E_CAUSE')
          assert.equal(record.extra.error.cause.status, 503)
          assert.equal(record.extra.error.cause.cause, '[Circular]')
          assert.equal(record.extra.nested[0].name, 'RangeError')
          assert.equal(record.extra.nested[0].code, 'E_FOREIGN')
          assert.ok(record.extra.nested[0].stack.includes('foreign-frame'))
          assert.equal(record.extra.cycle.self, '[Circular]')
          let tail = record.extra.chain
          for (let i = 0; i < 8; i += 1) {
            assert.equal(tail.message, `cause-${i}`)
            tail = tail.cause
          }
          assert.equal(tail, '[Truncated]')
          assert.equal(record.extra.nonplain.count, 8)
          assert.ok(record.extra.nonplain.detail.includes('useful-detail'))
        }
        assert.equal(terminal.length, 1)
        for (const secret of values)
          assert.ok(!JSON.stringify(terminal).includes(secret))
        assert.ok(
          JSON.stringify(terminal).includes('E_RATE'),
          'console retains diagnostics too',
        )
      })
      assert.equal(error.message, text)
      assert.equal(error.stack, originalStack)
      assert.equal(error.cause, cause)
      assert.equal(cause.cause, error)
      assert.equal(cycle.self, cycle)
      assert.equal(foreign.message, text)
      assert.equal(input.nonplain.detail, text)
      assert.equal(chain[8].message, 'cause-8')
    }),

  'logger.file_contract': async () =>
    fixture(({ dir, tui }) => {
      assert.equal(
        tui.resolveTuiLogPath(),
        process.env.ANTIGRAVITY_AUTH_TUI_LOG_FILE,
      )
      delete process.env.ANTIGRAVITY_AUTH_TUI_LOG_FILE
      assert.equal(
        tui.resolveTuiLogPath(),
        join(dir, 'state/cortexkit/antigravity-auth/tui.log'),
      )
      const path = join(dir, 'logs/contract.log')
      const logger = tui.createTuiFileLogger({ filePath: path })
      assert.equal(logger.getLogPath(), path)
      const start = Date.now()
      logger.info('immediate', { count: 2 })
      const first = records(path)[0]
      assert.deepEqual(Object.keys(first), ['ts', 'level', 'message', 'extra'])
      assert.ok(first.ts >= start && first.ts <= Date.now())
      assert.equal(first.level, 'info')
      assert.equal(first.message, 'immediate')
      assert.deepEqual(first.extra, { count: 2 })
      if (process.platform !== 'win32') {
        assert.equal(statSync(dirname(path)).mode & 0o777, 0o700)
        assert.equal(statSync(path).mode & 0o777, 0o600)
        chmodSync(dirname(path), 0o755)
        chmodSync(path, 0o644)
        logger.warn('repair')
        assert.equal(statSync(dirname(path)).mode & 0o777, 0o700)
        assert.equal(statSync(path).mode & 0o777, 0o600)
      }
      const head = 'h'.repeat(970_000)
      const tail = Array.from(
        { length: 250 },
        (_, i) => `tail-${i}-${'x'.repeat(100)}`,
      )
      const below = `${head}\n${tail.join('\n')}\n`
      assert.ok(Buffer.byteLength(below) < 1_000_000)
      writeFileSync(path, below)
      logger.info('below-limit')
      assert.ok(
        readFileSync(path, 'utf8').startsWith(head),
        'not the 5MiB or binary MiB threshold',
      )
      const over = `${'h'.repeat(1_000_000)}\n${tail.join('\n')}\n`
      writeFileSync(path, over)
      chmodSync(path, 0o644)
      logger.error('after-truncation', { code: 'E_TEST' })
      const lines = readFileSync(path, 'utf8').split('\n')
      // The retained writer counts the final empty split entry among tail200.
      assert.equal(lines.length, 201)
      assert.equal(lines[0], tail[51])
      assert.ok(lines[199].startsWith(prefix))
      assert.equal(
        JSON.parse(lines[199].slice(prefix.length)).message,
        'after-truncation',
      )
      assert.deepEqual(
        readdirSync(dirname(path)),
        ['contract.log'],
        'no public file backups',
      )
      if (process.platform !== 'win32')
        assert.equal(statSync(path).mode & 0o777, 0o600)
      captureTerminal((terminal) => {
        const impossible = tui.createTuiFileLogger({
          filePath: '\u0000/no-file',
        })
        assert.doesNotThrow(() => impossible.error('silently-dropped'))
        assert.equal(terminal.length, 0)
        assert.equal(existsSync('\u0000/no-file'), false)
      })
    }),

  'logger.core_bridge': async () =>
    fixture(({ provider, core, received, client }) => {
      const logger = core.createLogger('core-control')
      provider.setRuntimeLogLevel('info')
      captureTerminal((terminal) => {
        for (const [pluginFlag, coreFlag] of [
          ['0', '0'],
          ['1', '0'],
          ['0', 'true'],
          ['true', '1'],
        ]) {
          process.env.OPENCODE_ANTIGRAVITY_CONSOLE_LOG = pluginFlag
          process.env.ANTIGRAVITY_CORE_CONSOLE_LOG = coreFlag
          received.length = 0
          terminal.length = 0
          logger.info('core-bridged', { projectId: 'fake-project', eventId: 7 })
          assert.equal(received.length, 1)
          assert.equal(received[0].service, 'antigravity.core-control')
          assert.equal(received[0].extra.projectId, mask)
          assert.equal(received[0].extra.eventId, 7)
          assert.equal(
            terminal.length,
            Number(pluginFlag !== '0') + Number(coreFlag !== '0'),
          )
        }
        process.env.OPENCODE_ANTIGRAVITY_CONSOLE_LOG = '0'
        process.env.ANTIGRAVITY_CORE_CONSOLE_LOG = '0'
        const another = []
        core.setLogSink((record) => another.push(record))
        received.length = 0
        logger.info('last-registration-wins')
        assert.equal(another.length, 1)
        assert.equal(received.length, 0)
        provider.initLogger(client)
        logger.info('opencode-last')
        assert.equal(another.length, 1)
        assert.equal(received.length, 1)
        core.setLogSink(() => {
          throw new Error('sink failure')
        })
        assert.doesNotThrow(() => logger.error('contained'))
        provider.initLogger(client)
      })
    }),
}

export const caseNames = Object.keys(cases)
export async function runCase(name) {
  assert.ok(Object.hasOwn(cases, name), `unknown logger case ${name}`)
  await cases[name]()
}

// The same assertions run against source on Bun and real bundled adapters on Node.
// Node does not pretend to render TSX; the separate Bun host-render test does.
if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) ===
    fileURLToPath(pathToFileURL(process.argv[1]))
) {
  if (process.versions.bun) {
    let failures = 0
    console.log(
      `Bun ${process.versions.bun}: ${caseNames.length} logger contracts`,
    )
    for (const name of caseNames) {
      try {
        await runCase(name)
        console.log(`PASS ${name}`)
      } catch (error) {
        failures += 1
        console.error(`FAIL ${name}`, error)
      }
    }
    console.log(`${caseNames.length - failures} passed, ${failures} failed`)
    process.exitCode = failures === 0 ? 0 : 1
  } else {
    const { test } = await import('node:test')
    for (const name of caseNames) test(name, () => runCase(name))
  }
}
