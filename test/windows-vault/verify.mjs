import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { homedir, release } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { assertPrivateTokenDacl, readTokenDacl, redactDacl } from './dacl.mjs'
import { failureDetails } from './failure.mjs'
import { installLocalReadFence } from './local-reads.mjs'

const portable = process.argv.includes('--portable-smoke')
assert.equal(process.platform === 'win32', !portable)
const root = resolve(process.argv[2])
const evidence = resolve(process.argv[3])
const parent = resolve(
  process.platform === 'win32' ? process.env.USERPROFILE : homedir(),
)
const within = (base, path) => {
  const rel = relative(base, path)
  return rel && !rel.startsWith('..') && !isAbsolute(rel)
}
assert.ok(within(parent, root), 'Profile must be below the real user profile')
assert.ok(
  evidence !== root && !within(root, evidence),
  'Do not upload the profile',
)
await mkdir(evidence, { recursive: true })

const receipt = {
  status: 'running',
  qualification: portable ? 'portable-smoke-not-Windows-proof' : 'Windows',
  runtime: process.version,
  os: { platform: process.platform, arch: process.arch, release: release() },
  revision: process.env.GITHUB_SHA ?? null,
  stages: [],
  vaultCalls: [],
  httpRequests: [],
  localReadControls: [],
  localAccountReads: [],
  hostAuthReads: 0,
  blockedExternalRequests: 0,
}
let stage = 'setup'
const save = () =>
  writeFile(
    join(evidence, 'receipt.json'),
    `${JSON.stringify(receipt, null, 2)}\n`,
  )
const finite = async (promise, ms = 30000) => {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Stage deadline exceeded')),
          ms,
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
const check = async (name, run) => {
  stage = name
  await save()
  await finite(run())
  receipt.stages.push(name)
  await save()
}

const profile = join(root, 'profile')
const config = join(profile, 'config', 'opencode')
const project = join(profile, 'project')
const accountFile = join(config, 'antigravity-accounts.json')
const accessToken = `synthetic-vault-${randomBytes(24).toString('hex')}`
const projectId = 'synthetic-vault-project'
const localBytes = JSON.stringify({
  version: 4,
  accounts: [
    {
      refreshToken: 'synthetic-dormant-local',
      projectId: 'synthetic-local-project',
      addedAt: 1,
      lastUsed: 1,
    },
  ],
  activeIndex: 0,
  activeIndexByFamily: { gemini: 0, claude: 0 },
})
let daemon
let custody
let plugin
let fence
let recorder
const realFetch = globalThis.fetch
const recordFailure = async (error) => {
  receipt.status = 'failed'
  receipt.failedStage = stage
  receipt.failureKind =
    error instanceof assert.AssertionError ? 'assertion' : 'runtime'
  Object.assign(
    receipt,
    await failureDetails(error, {
      bundleUrl: new URL(
        '../../packages/opencode/dist/windows-vault-product.mjs',
        import.meta.url,
      ),
      secrets: [
        accessToken,
        projectId,
        'synthetic-dormant-local',
        parent,
        root,
        evidence,
      ],
    }),
  )
  process.exitCode = 1
}
try {
  await check('isolated-profile', async () => {
    // A pre-existing profile could supply approval or local credentials and mask a failure.
    await mkdir(root, { mode: 0o700 })
    await mkdir(config, { recursive: true, mode: 0o700 })
    await mkdir(join(project, '.opencode'), { recursive: true, mode: 0o700 })
    await writeFile(accountFile, localBytes, { mode: 0o600 })
    await writeFile(
      join(project, '.opencode', 'antigravity.json'),
      JSON.stringify({
        quiet_mode: true,
        auto_update: false,
        background_quota_refresh: false,
        quota_refresh_interval_minutes: 0,
        proactive_token_refresh: false,
        session_recovery: false,
        cache_warmup_on_switch: false,
      }),
    )
    Object.assign(process.env, {
      HOME: profile,
      USERPROFILE: profile,
      APPDATA: join(profile, 'roaming'),
      LOCALAPPDATA: join(profile, 'local'),
      XDG_CONFIG_HOME: join(profile, 'config'),
      XDG_DATA_HOME: join(profile, 'data'),
      XDG_CACHE_HOME: join(profile, 'cache'),
      XDG_STATE_HOME: join(profile, 'state'),
      OPENCODE_CONFIG_DIR: config,
      ANTIGRAVITY_ACCOUNTS_PATH: accountFile,
      ANTIGRAVITY_AUTH_RPC_DIR: join(profile, 'rpc'),
      ANTIGRAVITY_AUTH_SIDEBAR_STATE_FILE: join(profile, 'sidebar.json'),
    })
    let native
    if (!portable) {
      const coreUrl = pathToFileURL(resolve('packages/core/dist/index.js')).href
      const backendUrl = import.meta.resolve(
        '@cortexkit/private-files',
        coreUrl,
      )
      const loaderUrl = new URL('loader.js', backendUrl)
      const require = createRequire(loaderUrl)
      const binary = fileURLToPath(
        new URL(
          `../prebuilds/private-files-win32-${process.arch}.node`,
          loaderUrl,
        ),
      )
      const addon = require(binary)
      // N-API exports may be non-writable. A cache facade preserves the real native
      // operations while making the read boundary observable before consumers load.
      native = Object.fromEntries(
        Object.getOwnPropertyNames(addon).map((name) => [name, addon[name]]),
      )
      require.cache[require.resolve(binary)].exports = native
    }
    fence = installLocalReadFence(accountFile, native)
    assert.throws(() => fs.readFileSync(accountFile), {
      code: 'LOCAL_ACCOUNT_READ',
    })
    receipt.localReadControls.push('node:fs readFileSync refused')
    if (native) {
      assert.throws(() => native.read(accountFile), {
        code: 'LOCAL_ACCOUNT_READ',
      })
      receipt.localReadControls.push('private-files native read refused')
    }
    fence.reset()
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.hostname === '127.0.0.1') return realFetch(input, init)
      receipt.blockedExternalRequests++
      return new Response('External network disabled', { status: 404 })
    }
  })

  stage = 'load-built-product'
  await save()
  const product = await import(
    '../../packages/opencode/dist/windows-vault-product.mjs'
  )
  const core = await import('../../packages/core/dist/index.js')
  await check('propose-enrollment', async () => {
    daemon = await product.startMenuVaultFixture(profile, {
      accessToken,
      projectId,
    })
    process.env.SUBC_CONNECTION_FILE = daemon.connectionFile
    // Enrolled where a version before the move kept the vault files, beside
    // the account file; the plugin started below moves them to the state
    // home and serves from there.
    custody = product.createOpenCodeVaultCustody({
      vaultDir: join(config, 'antigravity-auth-vault'),
      accountFile,
      reporterSource: 'direct',
      readHostSlot: async () => {
        receipt.hostAuthReads++
        throw new Error('Host Google sign-in is not a vault credential')
      },
    })
    const pending = await custody.requestAccess()
    assert.equal(pending.state, 'pending')
    assert.equal(pending.proposedName, 'antigravity-auth-opencode')
    assert.ok(daemon.calls.includes('auth.enroll_propose'))
  })
  await check('operator-approval-and-consumer-poll', async () => {
    daemon.approve()
    const approved = await custody.requestAccess()
    assert.equal(approved.state, 'approved')
    assert.equal(approved.approvedName, 'antigravity-auth-opencode')
    assert.ok(daemon.calls.includes('auth.enroll_poll'))
    await custody.useVault()
  })
  await check('persisted-token-and-owner-only-DACL', async () => {
    const claustrum = await core.loadCommonAuthClaustrum()
    const { tokenPath } = claustrum.hostEnrollmentPaths({
      stateDir: custody.paths.dir,
      host: 'opencode',
    })
    assert.equal(fs.statSync(tokenPath).isFile(), true)
    if (!portable) {
      const descriptor = readTokenDacl(tokenPath)
      receipt.tokenDacl = redactDacl(descriptor)
      await save()
      assertPrivateTokenDacl(descriptor)
    } else {
      receipt.tokenDacl = {
        skipped: 'Portable smoke cannot qualify Windows DACLs',
      }
    }
    const token = await claustrum.readClaustrumEnrollmentToken(tokenPath)
    assert.equal(token.token_generation, 1)
    receipt.tokenWritten = true
  })

  await check('shared-executor-loopback-request', async () => {
    recorder = createServer(async (request, response) => {
      try {
        const chunks = []
        for await (const chunk of request) chunks.push(chunk)
        const body = JSON.parse(Buffer.concat(chunks).toString())
        receipt.httpRequests.push({
          method: request.method,
          path: request.url,
          bearerMatchesVault:
            request.headers.authorization === `Bearer ${accessToken}`,
          projectMatchesVault: body.project === projectId,
        })
        const envelope = {
          response: {
            candidates: [
              {
                content: {
                  role: 'model',
                  parts: [{ text: 'windows-vault-complete' }],
                },
                finishReason: 'STOP',
                index: 0,
              },
            ],
            usageMetadata: {
              promptTokenCount: 1,
              candidatesTokenCount: 1,
              totalTokenCount: 2,
            },
          },
        }
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end(`data: ${JSON.stringify(envelope)}\n\n`)
      } catch {
        response.writeHead(400)
        response.end('Invalid loopback request')
      }
    })
    await new Promise((accept, reject) => {
      recorder.once('error', reject)
      recorder.listen(0, '127.0.0.1', accept)
    })
    const address = recorder.address()
    assert.ok(address && typeof address !== 'string')
    const base = `http://127.0.0.1:${address.port}`
    const client = {
      app: { log: async () => {} },
      auth: {
        set: async () => {
          throw new Error('Must not write host credentials')
        },
      },
      session: {
        abort: async () => {},
        messages: async () => ({ data: [] }),
        prompt: async () => {},
      },
      tui: { showToast: async () => {} },
    }
    plugin = await product.createAntigravityPlugin('google', {
      dependencies: {
        agyTransport: async (url, init) => {
          const upstream = new URL(url)
          assert.match(upstream.pathname, /\/v1internal:streamGenerateContent$/)
          // Redirect only the destination. The shared executor supplies the bearer,
          // project and transformed body, which the independent HTTP server records.
          return realFetch(
            `${base}${upstream.pathname}${upstream.search}`,
            init,
          )
        },
      },
    })({
      client,
      project: {},
      directory: project,
      worktree: project,
      serverUrl: new URL(base),
      $: () => {},
    })
    const loaded = await plugin.auth.loader(
      async () => {
        receipt.hostAuthReads++
        throw new Error('Must not read the local host login')
      },
      {
        id: 'google',
        name: 'Google',
        source: 'custom',
        env: [],
        options: {},
        models: {},
      },
    )
    assert.equal(typeof loaded.fetch, 'function')
    const response = await loaded.fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/antigravity-gemini-3.8-flash:streamGenerateContent?alt=sse',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts: [{ text: 'Reply with the fixture completion text.' }],
            },
          ],
        }),
      },
    )
    assert.equal(response.status, 200)
    assert.ok((await response.text()).includes('windows-vault-complete'))
    assert.ok(daemon.calls.includes('credential.get_scoped'))
    assert.equal(receipt.httpRequests.length, 1)
    assert.equal(receipt.httpRequests[0].method, 'POST')
    assert.equal(receipt.httpRequests[0].bearerMatchesVault, true)
    assert.equal(receipt.httpRequests[0].projectMatchesVault, true)
    assert.equal(receipt.hostAuthReads, 0)
  })
  await check('dispose-without-local-account-reads', async () => {
    await plugin.dispose()
    plugin = undefined
    await custody.dispose()
    custody = undefined
    assert.deepEqual(daemon.errors, [])
    assert.deepEqual(fence.events, [])
  })
  receipt.status = 'passed'
} catch (error) {
  await recordFailure(error)
} finally {
  stage = 'cleanup'
  const cleanup = async (run) => {
    try {
      await finite(run())
    } catch (error) {
      if (!receipt.failureError) await recordFailure(error)
      receipt.cleanupFailed = true
      process.exitCode = 1
    }
  }
  await cleanup(async () => {
    await plugin?.dispose()
  })
  await cleanup(async () => {
    await custody?.dispose()
  })
  await cleanup(async () => {
    if (daemon) {
      receipt.vaultCalls = [...daemon.calls]
      receipt.daemonErrorCount = daemon.errors.length
      await daemon.close()
    }
  })
  await cleanup(async () => {
    if (recorder) {
      recorder.closeAllConnections()
      await new Promise((accept, reject) =>
        recorder.close((error) => (error ? reject(error) : accept())),
      )
    }
  })
  await cleanup(async () => {
    if (fence) {
      receipt.localAccountReads = [...fence.events]
      fence.restore()
      assert.deepEqual(receipt.localAccountReads, [])
      assert.equal(await readFile(accountFile, 'utf8'), localBytes)
      receipt.dormantLocalFileUnchanged = true
    }
  })
  globalThis.fetch = realFetch
  await save()
}
console.log(
  `${portable ? 'Portable vault smoke (not Windows proof)' : 'Windows vault check'}: ${receipt.status}; ${receipt.stages.length} stages; ${receipt.httpRequests.length} served requests; ${receipt.localAccountReads.length} local reads. Runtime ${process.version}`,
)
if (receipt.status !== 'passed') {
  console.error(`Failed stage: ${receipt.failedStage ?? 'cleanup'}`)
  process.exit(1)
}
