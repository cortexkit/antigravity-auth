import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import { parseConfigFileTextToJson } from 'typescript'
import { getAgyModelEnum } from '../../core/src/agy-request-metadata.ts'
import { getPublicModelDefinitions } from '../../core/src/model-registry.ts'
import { resolveAntigravityModel } from '../../core/src/transform/model-resolver.ts'
import {
  assertMeasuredNativeJob,
  assertNativeBoundary,
  assertNativeKernel,
  parseKernelStatus,
} from './fixtures/opencode-ga-host/native-job.ts'
import {
  assertOwnedCommandSucceeded,
  ownsProcess,
  procIdentity,
  startOwnedCommand,
} from './fixtures/opencode-ga-host/owned-command.ts'
import {
  assertGaActivePlaceholder,
  assertGaImagePreparationPlatform,
  assertGaNoDirectProvider,
  assertGaPassthroughEvidence,
  assertGaPinnedHostnameMappings,
  assertGaSuccess,
  awaitGaHostReadiness,
  captureGaPlaceholder,
  collectGaCompletion,
  connectGaNativeKey,
  createGaProtocolClient,
  GA_CASE_IDS,
  GA_SMOKE_CASE_IDS,
  type GaAccountObservation,
  type GaHarness,
  type GaHostIntegrationInputs,
  type GaPortableProtocol,
  type GaRecordedRequest,
  type GaRunResult,
  gaAllowsDirectProvider,
  gaChildEnvironment,
  gaFreshLoginCase,
  gaInstalledCompiledTui,
  gaNativeControl,
  gaNativeRequest,
  gaPlaceholderImportPolicy,
  gaRetryRequestsMatch,
  gaTimestamp,
  importGaPlaceholder,
  loadGaOverflowFixture,
  loginGaPool,
  prepareGaRoot,
  record,
  refreshGaFixtureCredentials,
  runGaCoreScenario,
  runGaPtyScenario,
  runGaSmoke,
  runGaTitleScenario,
  seedGaHost,
  verifiedArchiveFiles,
  verifiedArchiveMember,
  verifyGaOwnershipConfig,
  writeGaWrapper,
} from './opencode-ga-harness.ts'
import {
  assertGaFixturePins,
  GA_OFFLINE_FIXTURE,
  gaInstalledServer,
  gaSdkDeclarationPaths,
} from './opencode-ga-host-inputs.ts'

const roots: string[] = []

function parseLockForEquality(path: string, source: string): unknown {
  const result = parseConfigFileTextToJson(path, source)
  if (result.error) throw new Error('Malformed Bun lock syntax')
  return result.config
}

function completedRun() {
  const assistant = {
    id: 'msg-fresh',
    type: 'assistant' as const,
    agent: 'build',
    model: { providerID: 'google', id: 'fixture' },
    time: { created: 3, completed: 4 },
    finish: 'stop' as const,
    content: [{ type: 'text' as const, text: 'GA_OK_fixture' }],
  }
  const idle = {
    id: 'idle-fresh',
    type: 'idle' as const,
    time: { created: 5 },
    outcome: 'succeeded' as const,
  }
  return {
    code: 0,
    signal: null,
    stderr: '',
    timedOut: false,
    outputCapExceeded: false,
    stdout: [
      JSON.stringify({ type: 'step_start', sessionID: 'ses-exercised' }),
      JSON.stringify({
        type: 'text',
        sessionID: 'ses-exercised',
        part: {
          type: 'text',
          sessionID: 'ses-exercised',
          messageID: assistant.id,
          text: 'GA_OK_fixture',
          time: { start: 3, end: 4 },
        },
      }),
    ].join('\n'),
    completion: {
      sessionID: 'ses-exercised',
      prompt: 'Reply with GA_OK_fixture. Primary nonce fixture',
      beforeMessageIDs: ['msg-old', 'idle-old'],
      messageID: assistant.id,
      assistant,
      messages: [assistant, idle],
    },
  }
}

function nativeMessageServer(
  pages: Array<{
    data: unknown[]
    cursor: { next?: string; previous?: string }
  }>,
  assistant: unknown,
) {
  const calls: Array<{
    order: string | null
    cursor: string | null
    limit: string | null
  }> = []
  let pageIndex = 0
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      if (url.pathname.endsWith('/wait'))
        return new Response(null, { status: 204 })
      if (url.pathname.endsWith('/message')) {
        calls.push({
          order: url.searchParams.get('order'),
          cursor: url.searchParams.get('cursor'),
          limit: url.searchParams.get('limit'),
        })
        const page = pages[pageIndex++]
        return Response.json(page ?? { data: [], cursor: {} })
      }
      return Response.json({ data: assistant })
    },
  })
  return { server, calls }
}

describe('GA pinned CLI assistant and persisted terminal completion oracle', () => {
  it('accepts attributed text plus a fresh completed assistant and succeeded idle, without inventing a terminal stdout event', () => {
    const run = completedRun()
    expect(run.stdout.split('\n').map((line) => JSON.parse(line).type)).toEqual(
      ['step_start', 'text'],
    )
    expect(() =>
      assertGaSuccess(run as unknown as GaRunResult, 'fixture'),
    ).not.toThrow()
  })
  it('GA native completion collects cursor pages and trusts host finish without CLI step_finish', async () => {
    const run = completedRun()
    const earlierAssistant = {
      ...run.completion.assistant,
      id: 'msg-earlier-fresh',
      time: { created: 1, completed: 2 },
      content: [{ type: 'text' as const, text: 'earlier assistant' }],
    }
    const messages = [earlierAssistant, ...run.completion.messages]
    const { server, calls } = nativeMessageServer(
      [
        { data: [], cursor: {} },
        {
          data: messages,
          cursor: { previous: 'cursor-before', next: 'cursor-after' },
        },
        { data: [], cursor: {} },
      ],
      run.completion.assistant,
    )
    try {
      const native = gaNativeControl(`http://127.0.0.1:${server.port}`)
      const session = { id: 'ses-exercised', directory: '/owned/project' }
      const before = await native.messages(session)
      const completion = await collectGaCompletion(
        native,
        session,
        run.completion.prompt,
        before,
        run.stdout,
      )

      expect(before).toEqual([])
      expect(completion.messages).toEqual(messages)
      expect(() =>
        assertGaSuccess(
          { ...run, completion } as unknown as GaRunResult,
          'fixture',
        ),
      ).not.toThrow()
      expect(calls).toEqual([
        { order: 'asc', cursor: null, limit: '100' },
        { order: 'asc', cursor: null, limit: '100' },
        { order: null, cursor: 'cursor-after', limit: '100' },
      ])
    } finally {
      await server.stop(true)
    }
  })
  it('rejects a non-empty message page without a next cursor', async () => {
    const run = completedRun()
    const { server } = nativeMessageServer(
      [
        {
          data: [run.completion.assistant],
          cursor: { previous: 'cursor-before' },
        },
      ],
      run.completion.assistant,
    )
    try {
      const native = gaNativeControl(`http://127.0.0.1:${server.port}`)
      await expect(
        native.messages({ id: 'ses-exercised', directory: '/owned/project' }),
      ).rejects.toThrow('has no next cursor')
    } finally {
      await server.stop(true)
    }
  })
  it('rejects a message inventory cursor that repeats instead of advancing', async () => {
    const run = completedRun()
    const { server } = nativeMessageServer(
      [
        { data: [run.completion.assistant], cursor: { next: 'cursor-repeat' } },
        { data: [run.completion.assistant], cursor: { next: 'cursor-repeat' } },
      ],
      run.completion.assistant,
    )
    try {
      const native = gaNativeControl(`http://127.0.0.1:${server.port}`)
      await expect(
        native.messages({ id: 'ses-exercised', directory: '/owned/project' }),
      ).rejects.toThrow('cursor repeated or failed to advance')
    } finally {
      await server.stop(true)
    }
  })
  it('rejects duplicate message IDs across inventory pages', async () => {
    const run = completedRun()
    const { server } = nativeMessageServer(
      [
        { data: [run.completion.assistant], cursor: { next: 'cursor-one' } },
        { data: [run.completion.assistant], cursor: { next: 'cursor-two' } },
      ],
      run.completion.assistant,
    )
    try {
      const native = gaNativeControl(`http://127.0.0.1:${server.port}`)
      await expect(
        native.messages({ id: 'ses-exercised', directory: '/owned/project' }),
      ).rejects.toThrow('duplicate ID msg-fresh')
    } finally {
      await server.stop(true)
    }
  })
  it('rejects an inventory that does not exhaust within the page budget', async () => {
    const run = completedRun()
    const pages = Array.from({ length: 10 }, (_, index) => ({
      data: [
        {
          ...run.completion.assistant,
          id: `msg-page-${index}`,
        },
      ],
      cursor: { next: `cursor-page-${index}` },
    }))
    const { server, calls } = nativeMessageServer(
      pages,
      run.completion.assistant,
    )
    try {
      const native = gaNativeControl(`http://127.0.0.1:${server.port}`)
      await expect(
        native.messages({ id: 'ses-exercised', directory: '/owned/project' }),
      ).rejects.toThrow('did not reach an empty page within 10 pages')
      expect(calls).toHaveLength(10)
    } finally {
      await server.stop(true)
    }
  })
  const faults: Record<string, (run: ReturnType<typeof completedRun>) => void> =
    {
      'missing SDK receipt': (run) => {
        Reflect.deleteProperty(run, 'completion')
      },
      'prompt echo': (run) => {
        run.stdout = JSON.stringify({
          type: 'user',
          sessionID: 'ses-exercised',
          text: run.completion.prompt,
        })
      },
      'arbitrary stdout token': (run) => {
        run.stdout = JSON.stringify({ debug: 'GA_OK_fixture' })
      },
      'wrong session': (run) => {
        run.stdout = run.stdout.replaceAll('ses-exercised', 'ses-other')
      },
      'wrong message': (run) => {
        run.stdout = run.stdout.replaceAll('msg-fresh', 'msg-other')
      },
      'missing assistant text': (run) => {
        run.completion.assistant.content = []
      },
      'prompt as assistant': (run) => {
        run.completion.assistant.content[0]!.text = run.completion.prompt
        run.stdout = run.stdout.replace('GA_OK_fixture', run.completion.prompt)
      },
      'missing completed time': (run) => {
        Reflect.deleteProperty(run.completion.assistant.time, 'completed')
      },
      'missing finish': (run) => {
        Reflect.deleteProperty(run.completion.assistant, 'finish')
      },
      'missing terminal result': (run) => {
        run.completion.messages.pop()
      },
      'failed terminal state': (run) => {
        Reflect.set(run.completion.messages[1]!, 'outcome', 'failed')
      },
      'interrupted terminal state': (run) => {
        Reflect.set(run.completion.messages[1]!, 'outcome', 'interrupted')
      },
      'stale earlier assistant': (run) => {
        run.completion.beforeMessageIDs.push('msg-fresh')
      },
      'stale idle': (run) => {
        run.completion.beforeMessageIDs.push('idle-fresh')
      },
      'assistant error': (run) => {
        Reflect.set(run.completion.assistant, 'error', {
          type: 'provider.transport',
          message: 'primary failed',
        })
      },
      'wrong returned message': (run) => {
        run.completion.assistant.id = 'msg-other'
      },
      'synthetic success beside failing primary': (run) => {
        run.completion.messages.splice(
          1,
          0,
          Object.assign({}, run.completion.assistant, {
            id: 'msg-failing',
            finish: 'error',
            error: { type: 'provider.transport', message: 'primary failed' },
          }),
        )
      },
    }
  for (const [fault, mutate] of Object.entries(faults))
    it(`rejects completion with ${fault}`, () => {
      const run = completedRun()
      mutate(run)
      expect(() =>
        assertGaSuccess(run as unknown as GaRunResult, 'fixture'),
      ).toThrow()
    })
  it('uses the pinned singular message.list and session.message.get shapes for the requested session', async () => {
    const run = completedRun()
    const paths: string[] = []
    let messagePage = 0
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        const url = new URL(request.url)
        expect(request.headers.get('authorization')).toBe(
          `Basic ${Buffer.from('opencode:synthetic-ga-server-password').toString('base64')}`,
        )
        paths.push(`${request.method} ${url.pathname}`)
        if (url.pathname.endsWith('/wait'))
          return new Response(null, { status: 204 })
        if (url.pathname.endsWith('/message')) {
          expect(url.searchParams.get('limit')).toBe('100')
          const cursor = url.searchParams.get('cursor')
          if (cursor === null) expect(url.searchParams.get('order')).toBe('asc')
          else expect(url.searchParams.get('order')).toBeNull()
          const page = messagePage++
          if (page === 0) return Response.json({ data: [], cursor: {} })
          if (page === 1)
            return Response.json({
              data: run.completion.messages,
              cursor: { previous: 'cursor-before', next: 'cursor-after' },
            })
          return Response.json({ data: [], cursor: {} })
        }
        return Response.json({ data: run.completion.assistant })
      },
    })
    try {
      const native = gaNativeControl(`http://127.0.0.1:${server.port}`)
      const session = { id: 'ses-exercised', directory: '/owned/project' }
      const before = await native.messages(session)
      const completion = await collectGaCompletion(
        native,
        session,
        run.completion.prompt,
        before,
        run.stdout,
      )
      expect(completion.assistant).toEqual(run.completion.assistant)
      expect(() =>
        assertGaSuccess({ ...run, completion }, 'fixture'),
      ).not.toThrow()
      expect(paths).toEqual([
        'GET /api/session/ses-exercised/message',
        'POST /api/experimental/session/ses-exercised/wait',
        'GET /api/session/ses-exercised/message',
        'GET /api/session/ses-exercised/message',
        'GET /api/session/ses-exercised/message/msg-fresh',
      ])
      await expect(
        collectGaCompletion(
          native,
          { ...session, id: 'ses-other' },
          run.completion.prompt,
          before,
          run.stdout,
        ),
      ).rejects.toThrow('requested session')
      await expect(
        collectGaCompletion(
          native,
          session,
          run.completion.prompt,
          [completion.assistant],
          run.stdout,
        ),
      ).rejects.toThrow('stale earlier assistant')
    } finally {
      await server.stop(true)
    }
  })
})
const root = () => {
  const value = realpathSync(mkdtempSync(join(tmpdir(), 'ga-native-source-')))
  roots.push(value)
  return value
}
afterEach(() => {
  for (const path of roots.splice(0))
    rmSync(path, { recursive: true, force: true })
})
const kernel = () => ({
  NoNewPrivs: '1',
  Seccomp: '2',
  CapInh: '0000000000000000',
  CapPrm: '0000000000000000',
  CapEff: '0000000000000000',
  CapBnd: '0000000000000000',
  CapAmb: '0000000000000000',
})
// Synthetic parser inputs are not receipts from a runner or an official OpenCode execution.
function proof() {
  return {
    architecture: 'x86_64',
    interfaces: ['lo'],
    namespace: 'net:[1234]',
    status: kernel(),
    controls: [
      ...[2, 10].flatMap((family) =>
        ['external_tcp', 'external_udp'].map((control) => ({
          control,
          family,
          errno: 101,
        })),
      ),
      { control: 'external_dns', errno: 101 },
      ...[2, 10].map((family) => ({
        control: 'loopback_tcp',
        family,
        roundTrip: true,
      })),
      { control: 'unix_round_trip', roundTrip: true },
      { control: 'child_inheritance', namespace: 'net:[1234]', errno: 101 },
      {
        control: 'namespace_escape',
        exit: 1,
        stderr: 'unshare: Operation not permitted',
      },
    ],
  }
}

describe('native-job source/parser controls, not official-host certification', () => {
  it('requires all ten measured controls including DNS and UNIX evidence', () => {
    expect(assertNativeBoundary(proof())).toBe('net:[1234]')
    for (const index of proof().controls.keys()) {
      const input = proof()
      input.controls.splice(index, 1)
      expect(() => assertNativeBoundary(input)).toThrow('Missing/ambiguous')
    }
    const repeated = proof()
    repeated.controls.push(repeated.controls[0]!)
    expect(() => assertNativeBoundary(repeated)).toThrow('Missing/ambiguous')
  })
  it('rejects any external socket success or failed local round trip', () => {
    for (const index of [0, 1, 2, 3, 4, 5, 6, 7]) {
      const input = proof()
      Object.assign(input.controls[index]!, { errno: 0, roundTrip: false })
      expect(() => assertNativeBoundary(input)).toThrow()
    }
  })
  it('rejects a child in another namespace or allowed outbound connection', () => {
    for (const change of [{ namespace: 'net:[5678]' }, { errno: 0 }]) {
      const input = proof()
      Object.assign(input.controls[8]!, change)
      expect(() => assertNativeBoundary(input)).toThrow('Child escaped')
    }
  })
  it('rejects namespace creation success or unrelated unshare failures', () => {
    for (const change of [{ exit: 0 }, { stderr: 'missing executable' }]) {
      const input = proof()
      Object.assign(input.controls[9]!, change)
      expect(() => assertNativeBoundary(input)).toThrow('Namespace creation')
    }
  })
  it('rejects jobs with privileges, missing syscall filtering, extra interfaces or emulation', () => {
    expect(() => assertNativeKernel(kernel(), ['lo'], 'x64')).not.toThrow()
    for (const field of [
      'NoNewPrivs',
      'Seccomp',
      'CapInh',
      'CapPrm',
      'CapEff',
      'CapBnd',
      'CapAmb',
    ])
      expect(() =>
        assertNativeKernel(
          { ...kernel(), [field]: '0000000000000001' },
          ['lo'],
          'x64',
        ),
      ).toThrow()
    expect(() => assertNativeKernel(kernel(), ['lo', 'eth0'], 'x64')).toThrow()
    expect(() => assertNativeKernel(kernel(), ['lo'], 'arm64')).toThrow()
  })
  it('cannot manufacture measured admission from a native-job environment flag', () => {
    const before = process.env.GA_CONTAINMENT_MODE
    process.env.GA_CONTAINMENT_MODE = 'native-job'
    try {
      expect(() => assertMeasuredNativeJob()).toThrow('not been measured')
    } finally {
      if (before === undefined) delete process.env.GA_CONTAINMENT_MODE
      else process.env.GA_CONTAINMENT_MODE = before
    }
  })
  it('parses actual Linux status field spelling without assuming values', () => {
    expect(
      parseKernelStatus(
        'Name:\tbun\nNoNewPrivs:\t1\nCapBnd:\t0000000000000000\n',
      ),
    ).toEqual({ Name: 'bun', NoNewPrivs: '1', CapBnd: '0000000000000000' })
  })
  it('requires both real loopback host aliases; missing aliases never skip TLS cases', () => {
    expect(() =>
      assertGaPinnedHostnameMappings(
        '127.0.0.1 daily-cloudcode-pa.googleapis.com cloudcode-pa.googleapis.com\n',
      ),
    ).not.toThrow()
    for (const hosts of [
      '',
      '127.0.0.1 daily-cloudcode-pa.googleapis.com\n',
      '192.0.2.1 daily-cloudcode-pa.googleapis.com cloudcode-pa.googleapis.com\n',
      '127.0.0.1 daily-cloudcode-pa.googleapis.com cloudcode-pa.googleapis.com\n192.0.2.1 cloudcode-pa.googleapis.com\n',
    ])
      expect(() => assertGaPinnedHostnameMappings(hosts)).toThrow()
  })
  it('pins the actual 2.0.22 platform package to the tracked SRI without .bin stubs', () => {
    expect(() => assertGaFixturePins(resolve('.'))).not.toThrow()
    const fixture = record(
      parseLockForEquality(
        join(GA_OFFLINE_FIXTURE, 'bun.lock'),
        readFileSync(join(GA_OFFLINE_FIXTURE, 'bun.lock'), 'utf8'),
      ),
    )
    const tracked = record(
      parseLockForEquality('bun.lock', readFileSync('bun.lock', 'utf8')),
    )
    const fixturePackages = record(fixture.packages)
    const trackedPackages = record(tracked.packages)
    for (const [name, entry] of Object.entries(fixturePackages)) {
      if (name === '@opencode/cli-linux-x64') continue
      expect(entry).toEqual(trackedPackages[name])
    }
  })
  it('rejects malformed lock syntax even when JSONC parsing recovers matching package rows', () => {
    const valid = '{"packages":{"kept":["package@1",],},}'
    expect(record(parseLockForEquality('bun.lock', valid)).packages).toEqual({
      kept: ['package@1'],
    })
    const malformed = '{"packages":{"kept":["package@1",],},"broken":}'
    const recovered = parseConfigFileTextToJson('bun.lock', malformed)
    expect(recovered.error).toBeDefined()
    expect(record(recovered.config).packages).toEqual({ kept: ['package@1'] })
    expect(() => parseLockForEquality('bun.lock', malformed)).toThrow(
      'Malformed Bun lock syntax',
    )
  })
  it('uses genuine SDK declaration exports from its isolated dependency layout', () => {
    const paths = gaSdkDeclarationPaths(resolve('.'))
    expect(paths['@opencode/plugin']?.[0]).toEndWith('/dist/promise/index.d.ts')
    expect(paths['@opencode/client/promise']?.[0]).toEndWith(
      '/dist/promise/index.d.ts',
    )
    for (const targets of Object.values(paths)) expect(targets).toHaveLength(1)
  })
  it('keeps the exact independent live-case inventory and the Docker network-none path', () => {
    const expected = [
      'ga-ownership-pool-login',
      'ga-ownership-passthrough',
      'ga-ownership-empty-pool',
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
      'pty-second-instance-control',
      'tls-disabled-verification-control',
      'ga.raw-cancel.detached-dispatch-signal',
      'ga.raw-cancel.uncancelled-request-completes',
      'ga.raw-cancel.async-observer-rejected',
    ]
    expect(new Set(GA_CASE_IDS).size).toBe(expected.length)
    const actual: string[] = [...GA_CASE_IDS]
    expect(actual.sort()).toEqual(expected.sort())
    expect(GA_CASE_IDS[0]).toBe('ga-ownership-pool-login')
    const runner = readFileSync(
      'packages/e2e-tests/docker/run-opencode-ga-test.sh',
      'utf8',
    )
    expect(runner).toContain('--network none --platform linux/amd64')
    expect(runner).toContain(
      '--add-host daily-cloudcode-pa.googleapis.com:127.0.0.1',
    )
  })
  it('resolves packed public server entries rather than assuming a dist filename', () => {
    const prefix = root()
    const packageRoot = join(
      prefix,
      'node_modules/@cortexkit/opencode-antigravity-auth',
    )
    mkdirSync(join(packageRoot, 'custom'), { recursive: true })
    writeFileSync(join(prefix, 'package.json'), '{"type":"module"}')
    writeFileSync(
      join(packageRoot, 'package.json'),
      JSON.stringify({
        name: '@cortexkit/opencode-antigravity-auth',
        exports: {
          './server': {
            import: './custom/server.js',
            types: './custom/server.d.ts',
          },
        },
      }),
    )
    writeFileSync(join(packageRoot, 'custom/server.js'), 'export {}')
    writeFileSync(join(packageRoot, 'custom/server.d.ts'), 'export {}')
    expect(gaInstalledServer(prefix, 'import')).toBe(
      join(packageRoot, 'custom/server.js'),
    )
    expect(gaInstalledServer(prefix, 'types')).toBe(
      join(packageRoot, 'custom/server.d.ts'),
    )
    writeFileSync(
      join(packageRoot, 'package.json'),
      JSON.stringify({
        exports: { './server': { types: '../../../outside.d.ts' } },
      }),
    )
    expect(() => gaInstalledServer(prefix, 'types')).toThrow()
  })
  it('accepts the actual Bun environment when the TLS override is absent', () => {
    const key = 'NODE_TLS_REJECT_UNAUTHORIZED'
    const present = Object.keys(process.env).includes(key)
    const previous = process.env[key]
    try {
      delete process.env[key]
      expect(Object.keys(process.env).includes(key)).toBe(false)
      const env = gaChildEnvironment(prepareGaRoot(root()), process.env)
      expect(Reflect.ownKeys(env).includes(key)).toBe(false)
    } finally {
      if (present && previous !== undefined) process.env[key] = previous
      else delete process.env[key]
    }
  })
  it('rejects every explicit TLS override, including empty and non-enumerable keys', () => {
    const paths = prepareGaRoot(root())
    for (const value of ['0', '1', '']) {
      expect(() =>
        gaChildEnvironment(paths, { NODE_TLS_REJECT_UNAUTHORIZED: value }),
      ).toThrow('presence forbids host launch')
    }
    const inherited: NodeJS.ProcessEnv = {}
    Object.defineProperty(inherited, 'NODE_TLS_REJECT_UNAUTHORIZED', {
      value: undefined,
    })
    expect(() => gaChildEnvironment(paths, inherited)).toThrow(
      'presence forbids host launch',
    )
  })
  it('constructs owned profiles including PI directories and every OpenCode database', () => {
    const paths = prepareGaRoot(root())
    const env = gaChildEnvironment(paths, {
      HOME: '/operator',
      GOOGLE_APPLICATION_CREDENTIALS: '/secret',
      PI_AGENT_DIR: '/operator-pi',
      LD_PRELOAD: '/shim',
    })
    expect(env.HOME).toBe(paths.home)
    expect(env.OPENCODE_DB).toBe(paths.database)
    expect(env.OPENCODE_SERVER_PASSWORD).toBe('synthetic-ga-server-password')
    expect(env.OPENCODE_PASSWORD).toBe(env.OPENCODE_SERVER_PASSWORD)
    expect(env.PI_AGENT_DIR).toBe(join(paths.config, 'pi-agent'))
    expect(env.PI_CODING_AGENT_DIR).toBe(join(paths.config, 'pi-coding-agent'))
    expect(env.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined()
    expect(env.LD_PRELOAD).toBeUndefined()
  })
})

function archive(members: { name: string; type?: number; body: string }[]) {
  const blocks: Buffer[] = []
  for (const member of members) {
    const header = Buffer.alloc(512)
    header.write(member.name, 0, 100)
    header.write('0000644\0', 100, 8)
    header.write(
      `${Buffer.byteLength(member.body).toString(8).padStart(11, '0')}\0`,
      124,
      12,
    )
    header.fill(32, 148, 156)
    header[156] = member.type ?? 48
    const checksum = header.reduce((sum, byte) => sum + byte, 0)
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8)
    const contents = Buffer.alloc(
      Math.ceil(Buffer.byteLength(member.body) / 512) * 512,
    )
    contents.write(member.body)
    blocks.push(header, contents)
  }
  const bytes = gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]))
  return {
    bytes,
    sri: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
  }
}

describe('shared bounded archive and owned command controls', () => {
  it('installs multiple verified ordinary pack members and preserves single-member extraction', () => {
    const tar = archive([
      { name: 'package/package.json', body: '{"name":"pack"}' },
      { name: 'package/dist/server.js', body: 'export {}' },
    ])
    expect(verifiedArchiveFiles(tar.bytes, tar.sri).size).toBe(2)
    expect(
      verifiedArchiveMember(
        tar.bytes,
        tar.sri,
        'package/dist/server.js',
      ).toString(),
    ).toBe('export {}')
    expect(() =>
      verifiedArchiveFiles(tar.bytes, `sha512-${'A'.repeat(86)}==`),
    ).toThrow('SRI mismatch')
  })
  it('rejects pack traversal, symlinks and duplicate files before materialization', () => {
    for (const members of [
      [{ name: 'package/../outside', body: 'bad' }],
      [{ name: 'package/link', body: 'bad', type: 50 }],
      [
        { name: 'package/a', body: 'one' },
        { name: 'package/a', body: 'two' },
      ],
    ]) {
      const tar = archive(members)
      expect(() => verifiedArchiveFiles(tar.bytes, tar.sri)).toThrow()
    }
  })
  it('checks parent, process group and start time before sending any signal', () => {
    const fields = [
      'S',
      '50',
      '99',
      ...Array.from({ length: 16 }, () => '0'),
      '12345',
    ]
    const identity = procIdentity(
      `99 (name with (parentheses)) ${fields.join(' ')}`,
    )
    expect(identity).toEqual({ parent: 50, group: 99, start: '12345' })
    expect(ownsProcess(identity, identity, 50, 99)).toBe(true)
    for (const current of [
      { ...identity, parent: 51 },
      { ...identity, group: 100 },
      { ...identity, start: '12346' },
    ])
      expect(ownsProcess(identity, current, 50, 99)).toBe(false)
  })
  it('retains primary and cleanup failures instead of treating bounded termination as success', () => {
    const result = {
      code: 0,
      signal: null,
      stdout: 'raw-primary',
      stderr: 'raw-cleanup',
      timedOut: false,
      outputCapExceeded: false,
      cleanupFailures: ['ownership changed'],
    }
    expect(() => assertOwnedCommandSucceeded(result)).toThrow('raw-primary')
    expect(() => assertOwnedCommandSucceeded(result)).toThrow('raw-cleanup')
  })
  it('runs only an owned inert child, retaining both output streams', async () => {
    const paths = prepareGaRoot(root())
    const result = await startOwnedCommand(
      process.execPath,
      ['-e', "console.log('inert-out'); console.error('inert-err')"],
      {
        cwd: paths.project,
        env: gaChildEnvironment(paths, {}),
        deadlineMs: 2_000,
      },
    ).result
    expect(result.stdout).toContain('inert-out')
    expect(result.stderr).toContain('inert-err')
    expect(() => assertOwnedCommandSucceeded(result)).not.toThrow()
  })
  it('caps an inert child output and refuses to report synthetic success', async () => {
    const paths = prepareGaRoot(root())
    const result = await startOwnedCommand(
      process.execPath,
      ['-e', "console.log('x'.repeat(10000)); setInterval(()=>{},1000)"],
      {
        cwd: paths.project,
        env: gaChildEnvironment(paths, {}),
        deadlineMs: 2_000,
        outputCapBytes: 128,
      },
    ).result
    expect(result.outputCapExceeded).toBe(true)
    expect(
      Buffer.byteLength(result.stdout + result.stderr),
    ).toBeLessThanOrEqual(128)
    expect(() => assertOwnedCommandSucceeded(result)).toThrow()
  })
  it('bounds an inert child deadline and reaps the owned process', async () => {
    const paths = prepareGaRoot(root())
    const result = await startOwnedCommand(
      process.execPath,
      ['-e', 'setInterval(()=>{},1000)'],
      {
        cwd: paths.project,
        env: gaChildEnvironment(paths, {}),
        deadlineMs: 100,
      },
    ).result
    expect(result.timedOut).toBe(true)
    expect(result.signal).toBe('SIGKILL')
    expect(result.cleanupFailures).toEqual([])
    expect(() => assertOwnedCommandSucceeded(result)).toThrow()
  })
})

it('waits for authenticated GET /api/info when the UI root returns 200', async () => {
  const authorization = `Basic ${Buffer.from('opencode:synthetic-ga-server-password').toString('base64')}`
  const observedAuthorization: (string | null)[] = []
  let rootRequests = 0
  let infoRequests = 0
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname
      if (path === '/') {
        rootRequests++
        return new Response('UI assets', { status: 200 })
      }
      if (path === '/api/info') {
        infoRequests++
        observedAuthorization.push(request.headers.get('authorization'))
        if (request.headers.get('authorization') !== authorization)
          return Response.json({ code: 'wrong_auth' }, { status: 401 })
        if (infoRequests <= 3)
          return Response.json({ code: 'service_starting' }, { status: 503 })
        return Response.json({ ready: true }, { status: 200 })
      }
      return new Response('Not found', { status: 404 })
    },
  })
  const log = spyOn(console, 'error').mockImplementation(() => {})
  try {
    await awaitGaHostReadiness(`http://127.0.0.1:${server.port}`, () => {})
    expect(rootRequests).toBe(0)
    expect(infoRequests).toBe(4)
    expect(observedAuthorization).toEqual(Array(4).fill(authorization))
    const diagnostics = log.mock.calls.map(([message]) => String(message))
    expect(diagnostics).toContainEqual(
      expect.stringMatching(
        /readiness probe=1 path=\/api\/info status=503 elapsedMs=\d+/,
      ),
    )
    expect(diagnostics).toContainEqual(
      expect.stringMatching(
        /readiness probe=4 path=\/api\/info status=200 elapsedMs=\d+/,
      ),
    )
  } finally {
    log.mockRestore()
    await server.stop(true)
  }
})

it('fails readiness closed with the last API status and body code after the startup budget', async () => {
  let infoRequests = 0
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === '/api/info') {
        infoRequests++
        return Response.json({ code: 'service_starting' }, { status: 503 })
      }
      return new Response('UI assets', { status: 200 })
    },
  })
  const log = spyOn(console, 'error').mockImplementation(() => {})
  try {
    await expect(
      awaitGaHostReadiness(`http://127.0.0.1:${server.port}`, () => {}),
    ).rejects.toThrow(/last status=503 body code=service_starting/)
    expect(infoRequests).toBeGreaterThan(1)
  } finally {
    log.mockRestore()
    await server.stop(true)
  }
}, 20_000)

it('treats an unauthorized API info response as a hard readiness failure', async () => {
  let infoRequests = 0
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === '/api/info') {
        infoRequests++
        return Response.json({ code: 'wrong_auth' }, { status: 401 })
      }
      return new Response('UI assets', { status: 200 })
    },
  })
  const log = spyOn(console, 'error').mockImplementation(() => {})
  try {
    await expect(
      awaitGaHostReadiness(`http://127.0.0.1:${server.port}`, () => {}),
    ).rejects.toThrow(/GET \/api\/info returned 401.*body code=wrong_auth/)
    expect(infoRequests).toBe(1)
  } finally {
    log.mockRestore()
    await server.stop(true)
  }
})

it('authenticates native controls only to their owned loopback origin', async () => {
  const seen: { authorization: string | null; body: string }[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const authorization = request.headers.get('authorization')
      seen.push({ authorization, body: await request.text() })
      if (
        authorization !==
        `Basic ${Buffer.from('opencode:synthetic-ga-server-password').toString('base64')}`
      )
        return new Response('Unauthorized', { status: 401 })
      return Response.json({ accepted: true })
    },
  })
  try {
    const url = `http://127.0.0.1:${server.port}`
    expect(
      await gaNativeRequest(url, 'POST', '/api/control', { value: 1 }, 200),
    ).toEqual({ accepted: true })
    expect(seen).toHaveLength(1)
    expect(seen[0]?.body).toBe('{"value":1}')
    await expect(
      gaNativeRequest(
        url,
        'GET',
        'http://example.invalid/api/control',
        undefined,
        200,
      ),
    ).rejects.toThrow('Native control path escaped its owned server')
    expect(seen).toHaveLength(1)
  } finally {
    await server.stop(true)
  }
})

it('refreshes the generated host fixture from the actual bare-token contract', async () => {
  const token = 'synthetic-ga-refresh-A'
  const before = Date.now()
  const result = await refreshGaFixtureCredentials(token)
  expect(result.refresh).toBe(token)
  expect(result.access).toBe(`${token}-access`)
  expect(result.expires).toBeGreaterThanOrEqual(before + 3_600_000)
})

it('keeps the canonical Google request URL for production raw-TLS routing', () => {
  const paths = prepareGaRoot(root())
  const configPath = join(paths.opencodeConfig, 'opencode.json')
  seedGaHost(paths, '/owned/wrapper', 'http://127.0.0.1:1234', 0, true)
  expect(
    JSON.parse(readFileSync(configPath, 'utf8')).providers.google.settings
      .baseURL,
  ).toBe('https://generativelanguage.googleapis.com/v1beta')
  seedGaHost(paths, '/owned/wrapper', 'http://127.0.0.1:1234', 0, false)
  expect(
    JSON.parse(readFileSync(configPath, 'utf8')).providers.google.settings
      .baseURL,
  ).toBe('http://127.0.0.1:1234/direct/v1')
})

it('keeps canonical Google URLs for owned mock-sender smoke jobs and mock URLs for native passthrough', () => {
  for (const [caseId, baseURL] of [
    [
      'ga-ownership-pool-login',
      'https://generativelanguage.googleapis.com/v1beta',
    ],
    ['ga-ownership-passthrough', 'http://127.0.0.1:1234/direct/v1'],
  ] as const) {
    const paths = prepareGaRoot(root())
    seedGaHost(
      paths,
      '/owned/wrapper',
      'http://127.0.0.1:1234',
      0,
      false,
      caseId,
    )
    expect(
      JSON.parse(
        readFileSync(join(paths.opencodeConfig, 'opencode.json'), 'utf8'),
      ).providers.google.settings.baseURL,
    ).toBe(baseURL)
  }
})

it('admits Linux x64 artifact preparation without asserting runtime container membership', () => {
  expect(() => assertGaImagePreparationPlatform('linux', 'x64')).not.toThrow()
  for (const [platform, arch] of [
    ['darwin', 'x64'],
    ['linux', 'arm64'],
    ['win32', 'x64'],
  ] as const) {
    expect(() => assertGaImagePreparationPlatform(platform, arch)).toThrow(
      'Image preparation requires Linux amd64',
    )
  }
})

describe('GA ownership harness preparation (source controls, not native proof)', () => {
  it('labels an inventory timeout and retains observations before failed smoke disposal', async () => {
    const out = root()
    const paths = prepareGaRoot(root())
    writeFileSync(join(paths.opencodeConfig, 'opencode.json'), '{}')
    const wrapperEvents = [{ event: 'setup' }]
    const requests = [
      { kind: 'direct-provider', body: 'synthetic-observation' },
    ]
    const timeout = new DOMException('The operation timed out.', 'TimeoutError')
    const stderr: string[] = []
    const log = spyOn(console, 'error').mockImplementation((value) => {
      stderr.push(String(value))
    })
    const fetchMock = spyOn(globalThis, 'fetch').mockRejectedValue(timeout)
    let disposed = 0
    let persistedBeforeDispose = false
    const harness = {
      caseId: 'ga-ownership-pool-login',
      paths,
      host: { url: 'http://127.0.0.1:1234' },
      mock: { requests, events: [] },
      readWrapperEvents: () => wrapperEvents,
      async dispose() {
        disposed++
        persistedBeforeDispose = existsSync(
          join(paths.state, 'failure-observations.json'),
        )
      },
    } as unknown as GaHarness
    const inputs = {
      accounts: { assertCurrentStoreInput: async () => {} },
    } as unknown as GaHostIntegrationInputs
    try {
      const error = await runGaSmoke(out, inputs, async () => harness).catch(
        (error: unknown) => error,
      )
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).cause).toBe(timeout)
      const diagnostics = stderr.join('\n')
      expect(diagnostics).toContain('case=ga-ownership-pool-login')
      expect(diagnostics).toContain('step=connect.integration-inventory')
      expect(diagnostics).toMatch(
        /GET \/api\/integration deadlineMs=15000 elapsedMs=\d+ cause=TimeoutError/,
      )
      expect(diagnostics).not.toContain('step=connect.key-post')
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(disposed).toBe(1)
      expect(persistedBeforeDispose).toBe(true)
      expect(
        JSON.parse(
          readFileSync(join(paths.state, 'wrapper-events.json'), 'utf8'),
        ),
      ).toEqual(wrapperEvents)
      expect(
        JSON.parse(
          readFileSync(join(paths.state, 'mock-requests.json'), 'utf8'),
        ),
      ).toEqual(requests)
      expect(
        JSON.parse(
          readFileSync(join(paths.state, 'failure-observations.json'), 'utf8'),
        ),
      ).toEqual({
        hostLogPath: join(paths.data, 'opencode', 'log', 'opencode.log'),
        mockEvents: [],
      })
      expect(existsSync(join(out, 'smoke-results.json'))).toBe(false)
    } finally {
      fetchMock.mockRestore()
      log.mockRestore()
    }
  })

  it('uses the startup budget only for integration inventory and keeps the state RPC default', async () => {
    const paths = prepareGaRoot(root())
    const deadlines: number[] = []
    const timeout = spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      deadlines.push(ms)
      return new AbortController().signal
    })
    const fetchMock = spyOn(globalThis, 'fetch').mockRejectedValue(
      new DOMException('The operation timed out.', 'TimeoutError'),
    )
    const log = spyOn(console, 'error').mockImplementation(() => {})
    try {
      await connectGaNativeKey({
        paths,
        host: { url: 'http://127.0.0.1:1234' },
      }).catch(() => {})
      const client = createGaProtocolClient(
        {
          ANTIGRAVITY_RPC_ID: 'antigravity-auth',
          ANTIGRAVITY_RPC_VERSION: 1,
        } as GaPortableProtocol,
        'http://127.0.0.1:1234',
      )
      await client
        .state({ id: 'session', directory: paths.project })
        .catch(() => {})
      expect(
        fetchMock.mock.calls.map(
          ([url, init]) => `${init?.method} ${new URL(String(url)).pathname}`,
        ),
      ).toEqual([
        'GET /api/integration',
        'POST /api/rpc/antigravity-auth/state',
      ])
      expect(deadlines).toEqual([15000, 5000])
    } finally {
      timeout.mockRestore()
      fetchMock.mockRestore()
      log.mockRestore()
    }
  })

  it('prints a failed readiness probe followed by success and total elapsed time', async () => {
    const stderr: string[] = []
    const log = spyOn(console, 'error').mockImplementation((value) => {
      stderr.push(String(value))
    })
    const fetchMock = spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new TypeError('connection refused'))
      .mockResolvedValueOnce(new Response('ready', { status: 200 }))
    try {
      await awaitGaHostReadiness('http://127.0.0.1:1234', () => {})
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(stderr[0]).toMatch(
        /readiness probe=1 path=\/api\/info error=TypeError elapsedMs=\d+/,
      )
      expect(stderr[1]).toMatch(
        /readiness probe=2 path=\/api\/info status=200 elapsedMs=\d+/,
      )
      expect(stderr[2]).toMatch(/readiness result=ready elapsedMs=\d+/)
    } finally {
      fetchMock.mockRestore()
      log.mockRestore()
    }
  })

  it('prints readiness give-up when the host exits', async () => {
    const stderr: string[] = []
    const log = spyOn(console, 'error').mockImplementation((value) => {
      stderr.push(String(value))
    })
    const exit = new Error('Host exited during startup')
    try {
      await expect(
        awaitGaHostReadiness('http://127.0.0.1:1234', () => {
          throw exit
        }),
      ).rejects.toBe(exit)
      expect(stderr.join('\n')).toMatch(
        /readiness result=give-up elapsedMs=\d+ cause=Error/,
      )
    } finally {
      log.mockRestore()
    }
  })

  for (const phase of ['fetch', 'body'] as const) {
    it(`wraps ${phase} failures with a secret-free route, timing and original cause`, async () => {
      const cause = new TypeError('private-token key=password-secret')
      const response = new Response()
      response.text = async () => {
        throw cause
      }
      const fetchMock = spyOn(globalThis, 'fetch')
      if (phase === 'fetch') fetchMock.mockRejectedValue(cause)
      else fetchMock.mockResolvedValue(response)
      const log = spyOn(console, 'error').mockImplementation(() => {})
      try {
        const error = await gaNativeRequest(
          'http://127.0.0.1:1234',
          'POST',
          '/api/credential/private-token/activate?key=password-secret',
          { password: 'body-secret' },
          204,
          true,
        ).catch((error: unknown) => error)
        expect(error).toBeInstanceOf(Error)
        expect((error as Error).cause).toBe(cause)
        expect((error as Error).message).toMatch(
          /POST \/api\/credential\/:id\/activate deadlineMs=5000 elapsedMs=\d+ cause=TypeError/,
        )
        for (const secret of [
          'private-token',
          'password-secret',
          'body-secret',
        ])
          expect((error as Error).message).not.toContain(secret)
      } finally {
        fetchMock.mockRestore()
        log.mockRestore()
      }
    })
  }

  function activationFixture(fault = '') {
    const paths = prepareGaRoot(root())
    const barrier = Promise.withResolvers<void>()
    const firstRequest = Promise.withResolvers<string>()
    const calls: string[] = []
    const premature: string[] = []
    const entries: Record<string, unknown>[] = []
    let ready = false
    const google = {
      id: 'google',
      name: 'Google',
      methods: fault === 'missing-key' ? [] : [{ type: 'key' }],
      connections: [],
    }
    let inventory: unknown = [google]
    if (fault === 'missing-google') inventory = []
    if (fault === 'duplicate-google') inventory = [google, google]
    if (fault === 'not-array') inventory = { google }
    if (fault === 'missing-name')
      inventory = [{ id: 'google', methods: [], connections: [] }]
    if (fault === 'bad-method')
      inventory = [{ ...google, methods: [{ type: 'invented' }] }]
    if (fault === 'bad-connection')
      inventory = [{ ...google, connections: [{}] }]
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)
        const call = `${request.method} ${url.pathname}`
        calls.push(call)
        firstRequest.resolve(call)
        if (url.pathname.startsWith('/api/integration')) {
          expect(url.searchParams.get('location[directory]')).toBe(
            paths.project,
          )
          expect(request.headers.get('authorization')).toBe(
            `Basic ${Buffer.from('opencode:synthetic-ga-server-password').toString('base64')}`,
          )
        }
        if (call === 'GET /api/integration') {
          await barrier.promise
          ready = true
          calls.push('activation settled')
          return Response.json({
            location: {
              directory:
                fault === 'wrong-location'
                  ? '/different-project'
                  : paths.project,
            },
            data: inventory,
          })
        }
        if (!ready && url.pathname.startsWith('/api/integration')) {
          premature.push(call)
          return Response.json(
            {
              _tag: 'IntegrationNotFoundError',
              integrationID: 'google',
              message: 'Integration not found: google',
            },
            { status: 404 },
          )
        }
        if (call === 'POST /api/integration/google/connect/key') {
          expect(await request.json()).toEqual({
            key: 'synthetic-ga-key',
            label: 'native-control',
          })
          entries.push({
            id: 'native-id',
            integrationID: 'google',
            label: 'native-control',
            active: false,
            value: { type: 'key', key: 'synthetic-ga-key' },
          })
          return new Response(null, { status: 204 })
        }
        if (call === 'POST /api/credential/native-id/activate') {
          entries[0]!.active = true
          return new Response(null, { status: 204 })
        }
        if (call === 'GET /api/credential')
          return Response.json({ data: entries })
        if (call === 'GET /api/integration/google')
          return Response.json({ data: google })
        throw new Error(`Unexpected integration action: ${call}`)
      },
    })
    const harness = {
      paths,
      host: { url: `http://127.0.0.1:${server.port}` },
      mock: { url: `http://127.0.0.1:${server.port}` },
    }
    return { paths, harness, barrier, firstRequest, calls, premature, server }
  }

  it('awaits completed list activation before native key creation', async () => {
    const f = activationFixture()
    const pending = connectGaNativeKey(f.harness).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    )
    try {
      expect(await f.firstRequest.promise).toBe('GET /api/integration')
      expect(f.calls).toEqual(['GET /api/integration'])
      f.barrier.resolve()
      const result = await pending
      if ('error' in result) throw result.error
      expect(result.value.id).toBe('native-id')
      expect(f.calls.slice(0, 3)).toEqual([
        'GET /api/integration',
        'activation settled',
        'POST /api/integration/google/connect/key',
      ])
      expect(f.premature).toEqual([])
    } finally {
      f.barrier.resolve()
      await pending
      await f.server.stop(true)
    }
  })

  it('awaits completed list activation before pool browser method lookup', async () => {
    const f = activationFixture()
    const pending = loginGaPool(f.harness).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    )
    try {
      expect(await f.firstRequest.promise).toBe('GET /api/integration')
      expect(f.calls).toEqual(['GET /api/integration'])
      f.barrier.resolve()
      const result = await pending
      // Stop at the missing browser method so this control measures lookup
      // ordering without starting an OAuth attempt; the full login has its own test.
      expect('error' in result && String(result.error)).toContain(
        'GA_POOL_BROWSER_METHOD_MISSING',
      )
      expect(f.calls).toEqual([
        'GET /api/integration',
        'activation settled',
        'GET /api/integration/google',
      ])
      expect(f.premature).toEqual([])
    } finally {
      f.barrier.resolve()
      await pending
      await f.server.stop(true)
    }
  })

  it('exposes the original structured 404 for calls that bypass activation', async () => {
    const f = activationFixture()
    try {
      for (const [method, suffix, body, status] of [
        [
          'POST',
          '/connect/key',
          { key: 'synthetic-ga-key', label: 'native-control' },
          204,
        ],
        ['GET', '', undefined, 200],
      ] as const) {
        await expect(
          gaNativeRequest(
            f.harness.host.url,
            method,
            `/api/integration/google${suffix}?${new URLSearchParams({ 'location[directory]': f.paths.project })}`,
            body,
            status,
          ),
        ).rejects.toThrow(
          `returned 404, expected ${status}: {"_tag":"IntegrationNotFoundError"`,
        )
      }
      expect(f.premature).toEqual([
        'POST /api/integration/google/connect/key',
        'GET /api/integration/google',
      ])
    } finally {
      f.barrier.resolve()
      await f.server.stop(true)
    }
  })

  for (const entry of ['key', 'pool'] as const) {
    for (const fault of [
      'missing-google',
      'duplicate-google',
      'not-array',
      'missing-name',
      'bad-method',
      'bad-connection',
      'wrong-location',
    ]) {
      it(`refuses ${fault} after ${entry} activation without a key or OAuth action`, async () => {
        const f = activationFixture(fault)
        f.barrier.resolve()
        try {
          await expect(
            entry === 'key'
              ? connectGaNativeKey(f.harness)
              : loginGaPool(f.harness),
          ).rejects.toThrow(
            fault === 'missing-google' || fault === 'duplicate-google'
              ? 'GA_GOOGLE_INTEGRATION_MISSING_AFTER_ACTIVATION'
              : 'GA_INTEGRATION_INVENTORY_MALFORMED',
          )
          expect(f.calls).toEqual([
            'GET /api/integration',
            'activation settled',
          ])
          expect(f.premature).toEqual([])
        } finally {
          await f.server.stop(true)
        }
      })
    }
  }

  it('requires the native key method after activation before key creation', async () => {
    const f = activationFixture('missing-key')
    f.barrier.resolve()
    try {
      await expect(connectGaNativeKey(f.harness)).rejects.toThrow(
        'GA_NATIVE_KEY_METHOD_MISSING_AFTER_ACTIVATION',
      )
      expect(f.calls).toEqual(['GET /api/integration', 'activation settled'])
    } finally {
      await f.server.stop(true)
    }
  })

  it('dispatches the three ownership cases separately and retains the four-case smoke order', () => {
    expect(GA_SMOKE_CASE_IDS).toEqual([
      'ga-ownership-pool-login',
      'terminal-frame',
      'ga-ownership-passthrough',
      'ga-ownership-empty-pool',
    ])
    const source = readFileSync(
      'packages/e2e-tests/src/opencode-ga-harness.ts',
      'utf8',
    )
    const driver = source.slice(
      source.indexOf('export async function runGaFullDriver'),
    )
    const core = driver.slice(
      driver.indexOf('const core ='),
      driver.indexOf('for (const id of GA_CASE_IDS)'),
    )
    for (const [id, runner] of [
      ['ga-ownership-pool-login', 'runGaOwnershipPoolLogin'],
      ['ga-ownership-passthrough', 'runGaOwnershipPassthrough'],
      ['ga-ownership-empty-pool', 'runGaOwnershipEmptyPool'],
    ]) {
      expect(core).not.toContain(id!)
      expect(driver).toMatch(
        new RegExp(
          `if \\(id === '${id}'\\)\\s+await ${runner}\\(harness, inputs.accounts\\)`,
        ),
      )
    }
    expect(
      source.match(/await retainGaScenario\(harness, started,/g),
    ).toHaveLength(2)
    expect(source).toContain(
      'await runGaSmoke(root, inputs as GaHostIntegrationInputs)',
    )
  })

  it('uses location-scoped public login endpoints, callback state and the returned credential', async () => {
    const paths = prepareGaRoot(root())
    const value = {
      type: 'oauth',
      methodID: 'antigravity-auth-pool-browser',
      access: 'synthetic-host-placeholder',
      refresh: '',
      expires: 0,
    }
    const entries: Record<string, unknown>[] = []
    const calls: string[] = []
    let callback = false
    const listener = Bun.serve({
      hostname: '127.0.0.1',
      port: 51121,
      fetch(request) {
        const url = new URL(request.url)
        expect(url.pathname).toBe('/oauth-callback')
        expect(url.searchParams.get('state')).toBe('fixture-real-state')
        expect(url.searchParams.get('code')).toBe('synthetic-ga-code')
        callback = true
        return new Response('Accepted')
      },
    })
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request): Promise<Response> {
        const url = new URL(request.url)
        calls.push(`${request.method} ${url.pathname}`)
        if (
          url.pathname === '/api/integration' ||
          url.pathname.startsWith('/api/integration/')
        )
          expect(url.searchParams.get('location[directory]')).toBe(
            paths.project,
          )
        else expect(url.search).toBe('')
        if (url.pathname === '/api/integration') {
          return Response.json({
            location: { directory: paths.project },
            data: [
              {
                id: 'google',
                name: 'Google',
                methods: [
                  { type: 'key' },
                  {
                    type: 'oauth',
                    id: 'antigravity-auth-pool-browser',
                    label: 'Google (antigravity-auth pool, browser)',
                  },
                ],
                connections: [],
              },
            ],
          })
        }
        if (url.pathname.endsWith('/connect/key')) {
          expect(await request.json()).toEqual({
            key: 'synthetic-ga-key',
            label: 'native-control',
          })
          entries.push({
            id: 'native-id',
            integrationID: 'google',
            label: 'native-control',
            active: false,
            value: { type: 'key', key: 'synthetic-ga-key' },
          })
          return new Response(null, { status: 204 })
        }
        if (url.pathname.endsWith('/activate')) {
          for (const entry of entries)
            entry.active =
              url.pathname === `/api/credential/${entry.id}/activate`
          return new Response(null, { status: 204 })
        }
        if (url.pathname === '/api/credential')
          return Response.json({ data: entries })
        if (url.pathname.endsWith('/connect/oauth')) {
          expect(await request.json()).toEqual({
            methodID: 'antigravity-auth-pool-browser',
          })
          return Response.json({
            data: {
              attemptID: 'attempt-real',
              url: `http://127.0.0.1:${server.port}/authorize?state=fixture-real-state`,
            },
          })
        }
        if (url.pathname.endsWith('/connect/oauth/attempt-real')) {
          expect(callback).toBe(true)
          entries.push({
            id: 'pool-id',
            integrationID: 'google',
            label: 'Antigravity',
            active: false,
            value,
          })
          return Response.json({ data: { status: 'complete' } })
        }
        expect(url.pathname).toBe('/api/integration/google')
        return Response.json({
          data: { methods: [{ id: 'antigravity-auth-pool-browser' }] },
        })
      },
    })
    try {
      const harness = {
        paths,
        host: { url: `http://127.0.0.1:${server.port}` },
        mock: { url: `http://127.0.0.1:${server.port}` },
      }
      const key = await connectGaNativeKey(harness)
      expect(key.id).toBe('native-id')
      const before = JSON.stringify(key.value)
      expect(await loginGaPool(harness)).toEqual({ id: 'pool-id', value })
      expect(JSON.stringify(entries[0]?.value)).toBe(before)
      expect(calls).toContain(
        'GET /api/integration/google/connect/oauth/attempt-real',
      )
      expect(calls.some((call) => call.startsWith('DELETE'))).toBe(false)
    } finally {
      await server.stop(true)
      await listener.stop(true)
    }
  })

  function passthroughEvidence() {
    const session = { id: 'foreign-session', directory: '/owned/project' }
    const retryBody = JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: 'retry-nonce' }] }],
    })
    const retryHeaders: GaRecordedRequest['headers'][] = [
      {
        accept: '*/*',
        'accept-encoding': 'gzip, deflate, br, zstd',
        b3: '00ee93b0428118e3672341659ef5780c-cf6160d36757d758-1-bcf40005db959c65',
        connection: 'keep-alive',
        'content-length': String(
          new TextEncoder().encode(retryBody).byteLength,
        ),
        'content-type': 'application/json',
        host: '127.0.0.1:33905',
        traceparent: '00-00ee93b0428118e3672341659ef5780c-cf6160d36757d758-01',
        'user-agent': 'opencode/latest/2.0.22/cli',
        'x-goog-api-key': 'synthetic-ga-key',
        'x-opencode-client': 'cli',
        'x-opencode-project': 'global',
        'x-opencode-session': session.id,
        'x-opencode-session-id': session.id,
        'x-session-affinity': session.id,
        'x-session-id': session.id,
      },
      {
        accept: '*/*',
        'accept-encoding': 'gzip, deflate, br, zstd',
        b3: '00ee93b0428118e3672341659ef5780c-66835b38259e4bf0-1-a28c8db3ca155839',
        connection: 'keep-alive',
        'content-length': String(
          new TextEncoder().encode(retryBody).byteLength,
        ),
        'content-type': 'application/json',
        host: '127.0.0.1:33905',
        traceparent: '00-00ee93b0428118e3672341659ef5780c-66835b38259e4bf0-01',
        'user-agent': 'opencode/latest/2.0.22/cli',
        'x-goog-api-key': 'synthetic-ga-key',
        'x-opencode-client': 'cli',
        'x-opencode-project': 'global',
        'x-opencode-session': session.id,
        'x-opencode-session-id': session.id,
        'x-session-affinity': session.id,
        'x-session-id': session.id,
      },
    ]
    const requests: GaRecordedRequest[] = [200, 500, 200].map(
      (responseStatus, index) => ({
        kind: 'direct-provider',
        path: '/direct/v1/models/fixture:streamGenerateContent',
        body:
          index === 0
            ? JSON.stringify({
                contents: [{ role: 'user', parts: [{ text: 'first' }] }],
              })
            : retryBody,
        headers:
          index === 0
            ? {
                'x-goog-api-key': 'synthetic-ga-key',
                'x-opencode-session-id': session.id,
              }
            : retryHeaders[index - 1]!,
        rawHeaders: [],
        authorization: '',
        endpoint: '',
        responseStatus,
      }),
    )
    const events: Record<string, unknown>[] = requests.flatMap((request) =>
      ['native.foreign.prepared', 'native.foreign.dispatched'].map((event) => ({
        event,
        sessionID: session.id,
        kind: 'primary',
        url: `http://127.0.0.1:1234${request.path}`,
        headers: request.headers,
        body: request.body,
      })),
    )
    const snapshot: GaAccountObservation = {
      rows: [
        {
          label: 'Synthetic A',
          publicId: 'acct-1',
          selector: 'row-1',
          metadataStatus: 'present',
          accessBlock: { kind: 'none' },
          enabled: true,
          current: false,
        },
      ],
      routing: 'sticky',
      logging: false,
      dump: false,
      killswitch: 0,
      sidebarPullMs: 1000,
    }
    const harness = {
      nonce: 'fixture',
      mock: { requests },
      readWrapperEvents: () => events,
    }
    const results: GaRunResult[] = [1, 2].map(() => ({
      code: 0,
      stdout: JSON.stringify({
        type: 'text',
        sessionID: session.id,
        part: { text: 'GA_DIRECT_OK_fixture' },
      }),
      stderr: '',
      timedOut: false,
      outputCapExceeded: false,
      elapsedMs: 1,
      signal: null,
    }))
    return { session, requests, events, snapshot, harness, results }
  }

  it('accepts a 500→200 retry when only valid per-attempt trace headers differ', () => {
    const f = passthroughEvidence()
    expect(() =>
      assertGaPassthroughEvidence(
        f.harness,
        f.session,
        0,
        0,
        f.snapshot,
        f.snapshot,
        f.results,
      ),
    ).not.toThrow()
  })

  const retryMismatches: [string, (requests: GaRecordedRequest[]) => void][] = [
    [
      'a changed body byte',
      (requests) => {
        requests[2]!.body = `${requests[2]!.body} `
      },
    ],
    [
      'a changed API key',
      (requests) => {
        requests[2]!.headers['x-goog-api-key'] = 'another-api-key'
      },
    ],
    [
      'a changed host session header',
      (requests) => {
        requests[2]!.headers['x-opencode-session-id'] = 'another-session'
      },
    ],
    [
      'a changed content length',
      (requests) => {
        requests[2]!.headers['content-length'] = '1'
      },
    ],
    [
      'an added non-trace header',
      (requests) => {
        requests[2]!.headers['x-added-header'] = 'value'
      },
    ],
    [
      'a removed non-trace header',
      (requests) => {
        delete requests[2]!.headers['user-agent']
      },
    ],
    [
      'different trace IDs across attempts',
      (requests) => {
        requests[2]!.headers.b3 =
          '11ee93b0428118e3672341659ef5780c-66835b38259e4bf0-1-a28c8db3ca155839'
        requests[2]!.headers.traceparent =
          '00-11ee93b0428118e3672341659ef5780c-66835b38259e4bf0-01'
      },
    ],
    [
      'different B3 and W3C trace IDs within an attempt',
      (requests) => {
        requests[2]!.headers.traceparent =
          '00-11ee93b0428118e3672341659ef5780c-66835b38259e4bf0-01'
      },
    ],
    [
      'different B3 and W3C client span IDs within an attempt',
      (requests) => {
        requests[2]!.headers.traceparent =
          '00-00ee93b0428118e3672341659ef5780c-76835b38259e4bf0-01'
      },
    ],
    [
      'a malformed B3 trace header',
      (requests) => {
        requests[2]!.headers.b3 = 'not-a-valid-b3-header'
      },
    ],
    [
      'a malformed W3C trace header',
      (requests) => {
        requests[2]!.headers.traceparent = 'not-a-valid-traceparent'
      },
    ],
  ]

  for (const [mismatch, mutate] of retryMismatches) {
    it(`rejects a retry with ${mismatch}`, () => {
      const f = passthroughEvidence()
      mutate(f.requests)
      expect(gaRetryRequestsMatch(f.requests[1], f.requests[2])).toBe(false)
    })
  }

  it('rejects a send.start in the passthrough measured interval', () => {
    const f = passthroughEvidence()
    f.events.push({ event: 'send.start' })
    expect(() =>
      assertGaPassthroughEvidence(
        f.harness,
        f.session,
        0,
        0,
        f.snapshot,
        f.snapshot,
        f.results,
      ),
    ).toThrow('GA_PASSTHROUGH_ACCOUNT_ACQUISITION')
  })

  it('rejects refresh, bridge rewrites, marker headers, missing observations and stdout-only failures', () => {
    for (const fault of [
      'refresh',
      'bridge',
      'key',
      'plugin-header',
      'missing',
      'exit',
      'output',
      'roster',
      'status',
      'session',
      'retry-body',
    ]) {
      const f = passthroughEvidence()
      const after = structuredClone(f.snapshot)
      if (fault === 'refresh') f.events.push({ event: 'refreshAccessToken' })
      if (fault === 'bridge') f.events[1]!.url = 'http://127.0.0.1:4567/bridge'
      if (fault === 'key')
        f.requests[0]!.headers['x-goog-api-key'] =
          'common-auth-placeholder.google'
      if (fault === 'plugin-header')
        f.requests[0]!.headers['x-agy-test'] = 'added'
      if (fault === 'missing') f.events.splice(0, 1)
      if (fault === 'exit') f.results[0]!.code = 1
      if (fault === 'output') f.results[0]!.stdout = ''
      if (fault === 'roster') after.rows = []
      if (fault === 'status') f.requests[1]!.responseStatus = 200
      if (fault === 'session')
        f.requests[1]!.headers['x-opencode-session-id'] = 'another-session'
      if (fault === 'retry-body') f.requests[1]!.body = '{}'
      expect(() =>
        assertGaPassthroughEvidence(
          f.harness,
          f.session,
          0,
          0,
          f.snapshot,
          after,
          f.results,
        ),
      ).toThrow()
    }
  })

  it('enforces direct-provider refusal for every case except passthrough at all three sites', () => {
    for (const id of GA_CASE_IDS) {
      if (id === 'ga-ownership-passthrough') continue
      expect(gaAllowsDirectProvider(id)).toBe(false)
      expect(() => assertGaNoDirectProvider(id, 0)).not.toThrow()
      expect(() => assertGaNoDirectProvider(id, 1)).toThrow(
        `Public provider fallthrough: ${id}`,
      )
    }
    expect(gaAllowsDirectProvider('ga-ownership-passthrough')).toBe(true)
    expect(() =>
      assertGaNoDirectProvider('ga-ownership-passthrough', 3),
    ).not.toThrow()
    for (const count of [-1, 0.5, Number.NaN]) {
      expect(() =>
        assertGaNoDirectProvider('ga-ownership-passthrough', count),
      ).toThrow()
    }
    const source = readFileSync(
      'packages/e2e-tests/src/opencode-ga-harness.ts',
      'utf8',
    )
    const observations = readFileSync(
      'packages/e2e-tests/src/support/ga-observations.ts',
      'utf8',
    )
    expect(observations).toMatch(
      /assertGaNoDirectProvider\(\s*observation\.id\s*,/,
    )
    for (const argument of ['caseId', 'id']) {
      expect(source).toMatch(
        new RegExp(
          `assertGaNoDirectProvider\\(\\s*${argument.replace('.', '\\.')}\\s*,`,
        ),
      )
    }
  })

  it('leaves only pool-login and empty-pool fresh in the host seeding hook', () => {
    for (const id of GA_CASE_IDS) {
      expect(gaFreshLoginCase(id)).toBe(
        id === 'ga-ownership-pool-login' || id === 'ga-ownership-empty-pool',
      )
    }
    for (const id of [
      'ga-ownership-pool-login',
      'ga-ownership-empty-pool',
      'ga-ownership-passthrough',
    ] as const) {
      const paths = prepareGaRoot(root())
      const accountFile = seedGaHost(
        paths,
        '/owned/wrapper',
        'http://127.0.0.1:1234',
        1,
        false,
        id,
      )
      expect(existsSync(accountFile)).toBe(id === 'ga-ownership-passthrough')
      if (existsSync(accountFile))
        expect(
          JSON.parse(readFileSync(accountFile, 'utf8')).accounts,
        ).toHaveLength(1)
    }
  })

  it('uses the public loader in bounded case environments with both refresh timers disabled', async () => {
    const before = { ...process.env }
    for (const id of [
      'ga-ownership-pool-login',
      'ga-ownership-passthrough',
      'ga-ownership-empty-pool',
    ] as const) {
      const paths = prepareGaRoot(root())
      seedGaHost(paths, '/owned/wrapper', 'http://127.0.0.1:1234', 0, false, id)
      await verifyGaOwnershipConfig(paths)
      const receipt = JSON.parse(
        readFileSync(join(paths.state, 'ownership-config-loader.json'), 'utf8'),
      )
      expect(receipt.background_quota_refresh).toBe(false)
      expect(receipt.proactive_token_refresh).toBe(false)
      expect(receipt.environment.HOME).toBe(paths.home)
      expect(receipt.environment.OPENCODE_DB).toBe(paths.database)
      expect(receipt.environment.OPENCODE_CONFIG_DIR).toBe(paths.opencodeConfig)
      expect(receipt.limitation).toContain('not production timer behavior')
    }
    expect({ ...process.env }).toEqual(before)
  })

  it('rejects loader defaults instead of mistaking a written fixture for loaded false values', async () => {
    const paths = prepareGaRoot(root())
    seedGaHost(
      paths,
      '/owned/wrapper',
      'http://127.0.0.1:1234',
      0,
      false,
      'terminal-frame',
    )
    expect(existsSync(join(paths.opencodeConfig, 'antigravity.json'))).toBe(
      false,
    )
    await expect(verifyGaOwnershipConfig(paths)).rejects.toThrow(
      'GA_CONFIG_NOT_ISOLATED',
    )
  })

  it('pins the single import policy for primary and nested harness creation', () => {
    for (const id of GA_CASE_IDS) {
      const policy = gaPlaceholderImportPolicy(id)
      if (
        id === 'ga-ownership-pool-login' ||
        id === 'ga-ownership-empty-pool' ||
        id === 'ga-ownership-passthrough'
      )
        expect(policy).toBe('never')
      else if (id === 'late-unrelated-response')
        expect(policy).toBe('after-foreign-held')
      else expect(policy).toBe('before-prompt')
    }
    const source = readFileSync(
      'packages/e2e-tests/src/opencode-ga-harness.ts',
      'utf8',
    )
    expect(source).toMatch(
      /host = await startGaHost[\s\S]*?gaPlaceholderImportPolicy\(caseId\) === 'before-prompt'[\s\S]*?await importGaPlaceholder/,
    )
  })

  it('captures and imports the exact host-returned value object with provenance and verifies activation', async () => {
    const paths = prepareGaRoot(root())
    const placeholderFixture = join(paths.root, 'pool-login-placeholder.json')
    // Synthetic HTTP contract server only; no real login or native-host result is claimed here.
    const value = {
      type: 'oauth',
      methodID: 'antigravity-auth-pool-browser',
      access: 'synthetic-host-value',
      refresh: '',
      expires: 0,
      metadata: { source: 'synthetic-host' },
    }
    let selected = {
      id: 'credential-original',
      integrationID: 'google',
      label: 'Antigravity',
      active: true,
      value,
    }
    let activateImports = true
    const imports: unknown[] = []
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        expect(new URL(request.url).pathname).toBe('/api/credential')
        if (request.method === 'POST') {
          const body = await request.json()
          imports.push(body)
          const entry = {
            ...selected,
            id: 'credential-imported',
            value: body.value,
          }
          if (activateImports) selected = entry
          return Response.json({ data: entry })
        }
        return Response.json({ data: [selected] })
      },
    })
    const url = `http://127.0.0.1:${server.port}`
    try {
      await captureGaPlaceholder(
        {
          caseId: 'ga-ownership-pool-login',
          host: { url },
          paths,
          placeholderFixture,
          readWrapperEvents: () => [
            { event: 'oauth.exchange', codePresent: true },
          ],
        },
        selected.id,
      )
      const fixture = JSON.parse(readFileSync(placeholderFixture, 'utf8'))
      expect(fixture.caseId).toBe('ga-ownership-pool-login')
      expect(fixture.credentialId).toBe('credential-original')
      expect(fixture.value).toEqual(value)
      expect(fixture.valueSha256).toBe(
        createHash('sha256').update(JSON.stringify(value)).digest('hex'),
      )
      expect(fixture.provenance.api).toBe('GET /api/credential')
      expect(fixture.provenance.databaseFile).toBe(paths.database)
      await importGaPlaceholder(url, placeholderFixture, paths)
      expect(imports).toEqual([
        {
          integrationID: 'google',
          label: 'Antigravity',
          value,
          activate: true,
        },
      ])
      expect(selected.id).toBe('credential-imported')
      selected = { ...selected, id: 'other-active-credential' }
      activateImports = false
      await expect(
        importGaPlaceholder(url, placeholderFixture, paths),
      ).rejects.toThrow('GA_ACTIVE_PLACEHOLDER_MISSING')
      fixture.value.access = 'altered'
      writeFileSync(placeholderFixture, JSON.stringify(fixture))
      await expect(
        importGaPlaceholder(url, placeholderFixture, paths),
      ).rejects.toThrow('GA_PLACEHOLDER_PROVENANCE_INVALID')
      expect(imports).toHaveLength(2)
      await expect(
        importGaPlaceholder(url, join(paths.root, 'missing.json'), paths),
      ).rejects.toThrow('GA_PLACEHOLDER_FIXTURE_MISSING')
      selected.active = false
      await expect(assertGaActivePlaceholder(url)).rejects.toThrow(
        'GA_ACTIVE_PLACEHOLDER_MISSING',
      )
    } finally {
      await server.stop(true)
    }
  })
})

describe('GA native oracle fixtures (synthetic records, not native proof)', () => {
  function fixture() {
    const paths = prepareGaRoot(root())
    seedGaHost(paths, '/owned/wrapper', 'http://127.0.0.1:1234')
    const requests: Array<{ kind: string; body: string }> = []
    const events: Record<string, unknown>[] = []
    const selected: string[] = []
    const session = { id: 'oracle-session', directory: paths.project }
    const success = completedRun()
    success.completion.sessionID = 'oracle-session'
    success.stdout = success.stdout.replaceAll(
      'ses-exercised',
      'oracle-session',
    )
    const harness = {
      paths,
      nonce: 'fixture',
      mock: { requests },
      readWrapperEvents: () => events,
      native: {
        create: async (_directory: string, model: string) => {
          selected.push(model)
          return session
        },
        get: async () => ({ title: 'Unchanged initial title' }),
        wait: async () => {},
      },
      run: async (model: string) => {
        selected.push(model)
        return success
      },
    } as unknown as GaHarness
    return { paths, requests, events, selected, harness, success }
  }
  function wire(model: string, cap = 128_000) {
    const [id, variant] = model.replace('google/', '').split('#')
    const actual = resolveAntigravityModel(
      `${id}${variant ? `-${variant}` : ''}`,
    ).actualModel
    return {
      model: actual,
      userAgent: 'antigravity',
      requestType: 'agent',
      request: {
        sessionId: 'oracle-session',
        labels: {
          model_enum: getAgyModelEnum(actual),
          trajectory_id: 'oracle-trajectory',
        },
        generationConfig: {
          maxOutputTokens: cap,
          thinkingConfig: {
            includeThoughts: true,
            thinkingBudget: 0,
            thinkingLevel: 'LOW',
          },
        },
      },
    }
  }
  function capRun(
    f: ReturnType<typeof fixture>,
    preparedCap: number | null,
    expected: number,
    fault = '',
  ) {
    const envelope = {
      ...wire('google/antigravity-claude-sonnet-5-5#low', expected),
      requestId: 'synthetic-wire-request',
    }
    f.harness.run = async (model, prompt, _continuation, session) => {
      f.selected.push(model)
      const caller = /GA_CAP_CALLER_[a-f0-9]{32}/.exec(prompt ?? '')?.[0]
      Object.assign(envelope.request, {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
      })
      const prepared = {
        event: 'native.prepared-output-cap',
        kind: 'primary',
        model: 'antigravity-claude-sonnet-5-5',
        sessionID: session?.id,
        caller,
        owned: true,
        bodySha256: 'a'.repeat(64),
        maxOutputTokens: preparedCap,
      }
      const body = JSON.stringify(envelope)
      const physical = { kind: 'primary', body }
      const native = {
        event: 'native.request',
        kind: 'primary',
        model: 'antigravity-claude-sonnet-5-5',
        sessionID: session?.id,
      }
      const observedWire = {
        event: 'native.primary-wire',
        kind: 'primary',
        caller,
        requestId: envelope.requestId,
        bodySha256: createHash('sha256').update(body).digest('hex'),
      }
      if (fault === 'session') prepared.sessionID = 'foreign-session'
      if (fault === 'ownership') prepared.owned = false
      if (fault === 'swapped')
        prepared.caller = `GA_CAP_CALLER_${'b'.repeat(32)}`
      if (fault === 'wire-hash') observedWire.bodySha256 = 'f'.repeat(64)
      if (fault === 'wire-request')
        observedWire.requestId = 'unrelated-wire-request'
      if (fault === 'native-session') native.sessionID = 'foreign-session'
      if (fault !== 'missing') f.events.push(prepared)
      if (fault !== 'missing-native') f.events.push(native)
      f.events.push(observedWire)
      f.requests.push(physical)
      if (fault === 'extra-primary') f.requests.push({ ...physical })
      if (fault === 'extra-prepared') f.events.push({ ...prepared })
      if (fault === 'extra-wire') f.events.push({ ...observedWire })
      return f.success as Awaited<ReturnType<GaHarness['run']>>
    }
    return envelope
  }
  for (const close of ['missing', 'wrong-peer', 'forced', 'natural'] as const) {
    it(`requires the PTY held peer natural-close before cleanup: ${close}`, async () => {
      const f = fixture()
      const events: Array<Record<string, unknown>> = []
      Object.assign(f.harness.mock, { events })
      writeFileSync(join(f.paths.state, 'tui.ndjson'), '{"event":"ui.setup"}\n')
      let stopped = false
      f.harness.startPty = () =>
        ({
          process: {
            exitCode: null,
            stdin: {
              write: (text: string) => {
                if (text.startsWith('Hold')) {
                  f.requests.push({
                    kind: 'primary',
                    body: JSON.stringify({
                      model: 'gemini-3.5-flash',
                      request: {
                        contents: [
                          {
                            role: 'user',
                            parts: [
                              { text: `Hold this stream ${f.harness.nonce}` },
                            ],
                          },
                        ],
                      },
                    }),
                    peer: 41,
                  } as (typeof f.requests)[number])
                  events.push({
                    event: 'held-content',
                    peer: 41,
                    requestIndex: 1,
                    at: gaTimestamp(),
                  })
                }
                if (text === '\x1b' && close !== 'missing')
                  events.push({
                    event: close === 'forced' ? 'forced-close' : 'peer-close',
                    peer: close === 'wrong-peer' ? 42 : 41,
                    requestIndex: 1,
                    at: gaTimestamp(),
                  })
              },
            },
          },
          output: () => ({ stdout: 'Antigravity 75%', stderr: '' }),
          signal: () => {
            stopped = true
          },
          result: Promise.resolve(f.success),
        }) as unknown as ReturnType<GaHarness['startPty']>
      f.harness.run = async () => {
        f.requests.push({ kind: 'primary', body: '{}' })
        return f.success as Awaited<ReturnType<GaHarness['run']>>
      }
      const accounts = {
        snapshot: async () => ({
          rows: [{ publicId: 'owned-row' }],
          sidebarPullMs: 1000,
        }),
        assertNoPortOrSidebarFiles: async () => {},
      } as unknown as Parameters<typeof runGaPtyScenario>[2]
      if (close === 'natural')
        await runGaPtyScenario(f.harness, 'pty-interrupt-recovery', accounts)
      else
        await expect(
          runGaPtyScenario(f.harness, 'pty-interrupt-recovery', accounts),
        ).rejects.toThrow(
          close === 'forced'
            ? 'held peer required forced cleanup'
            : 'held peer natural-close',
        )
      expect(stopped).toBe(true)
    })
  }
  it('keeps all seven public IDs and every enabled catalog variant with deliberate off-catalog titles', async () => {
    const f = fixture()
    f.harness.run = async (model) => {
      const config = JSON.parse(
        readFileSync(join(f.paths.opencodeConfig, 'opencode.json'), 'utf8'),
      )
      expect(config.agents.title.model).toBe('google/gemini-flash-lite-latest')
      expect(
        config.providers.google.models['gemini-flash-lite-latest'],
      ).toBeDefined()
      f.selected.push(model)
      f.requests.push(
        { kind: 'primary', body: JSON.stringify(wire(model)) },
        { kind: 'title', body: '{"model":"gemini-3.5-flash-extra-low"}' },
      )
      return f.success as Awaited<ReturnType<GaHarness['run']>>
    }
    await runGaCoreScenario(f.harness, 'catalog-and-titles')
    expect(
      [...new Set(f.selected.map((model) => model.split('#')[0]))].sort(),
    ).toEqual(
      [
        'google/antigravity-gemini-4-argon',
        'google/antigravity-gemini-3.5-flash',
        'google/antigravity-gemini-3.1-flash-image',
        'google/antigravity-gemini-3.8-flash',
        'google/antigravity-claude-sonnet-5-5',
        'google/antigravity-claude-opus-5-5',
        'google/antigravity-gpt-oss-120b-medium',
      ].sort(),
    )
    for (const [id, definition] of Object.entries(
      getPublicModelDefinitions(),
    )) {
      expect(f.selected).toContain(`google/${id}`)
      for (const [variant, settings] of Object.entries(
        definition.variants ?? {},
      ))
        if (!settings.disabled)
          expect(f.selected).toContain(`google/${id}#${variant}`)
    }
  })
  for (const id of ['title-primary-fallback', 'title-overflow'] as const) {
    it(`${id} requires two ordered physical attempts and real 400 observations`, async () => {
      const f = fixture()
      f.requests.push(
        ...['gemini-3.5-flash-extra-low', 'gemini-3.8-flash-medium'].map(
          (model) => ({ kind: 'title', body: JSON.stringify({ model }) }),
        ),
      )
      f.events.push(
        ...['gemini-flash-lite-latest', 'antigravity-gemini-3.8-flash'].map(
          (model) => ({
            event: 'native.request',
            kind: 'title',
            model,
            sessionID: 'oracle-session',
          }),
        ),
      )
      f.events.push(
        ...[400, id === 'title-overflow' ? 400 : 200].map((status, index) => ({
          event: 'native.title.response',
          status,
          kind: 'title',
          sessionID: 'oracle-session',
          model:
            index === 0
              ? 'gemini-flash-lite-latest'
              : 'antigravity-gemini-3.8-flash',
        })),
      )
      const overflow = loadGaOverflowFixture(resolve('.'), 'gemini')
      const error = {
        event: 'native.400',
        status: 400,
        contentType: overflow.contentType,
        bytes: overflow.bytes.toString('base64'),
        kind: 'title',
        sessionID: 'oracle-session',
        model: 'gemini-flash-lite-latest',
        contextErrorHeader: null,
      }
      f.events.push(error)
      if (id === 'title-overflow')
        f.events.push({ ...error, model: 'antigravity-gemini-3.8-flash' })
      await runGaTitleScenario(f.harness, id)
      expect(f.selected).toEqual(
        Array(2).fill('google/antigravity-gemini-3.8-flash#medium'),
      )
      for (const bad of [
        { ...error, bytes: '' },
        { ...error, bytes: Buffer.from('wrong body').toString('base64') },
        { ...error, contentType: 'text/plain' },
        { ...error, kind: 'primary' },
        { ...error, sessionID: 'other-session' },
        { ...error, model: 'other-model' },
        { ...error, contextErrorHeader: 'invented' },
      ]) {
        f.events[4] = bad
        await expect(runGaTitleScenario(f.harness, id)).rejects.toThrow(
          'Title refusal bytes or attribution',
        )
      }
      f.events[4] = error
      const config = JSON.parse(
        readFileSync(join(f.paths.opencodeConfig, 'opencode.json'), 'utf8'),
      )
      expect(config.agents.title.model).toBe('google/gemini-flash-lite-latest')
      f.requests.reverse()
      await expect(runGaTitleScenario(f.harness, id)).rejects.toThrow(
        'exact expected AGY title wire models',
      )
      f.requests.reverse()
      f.events.splice(4)
      await expect(runGaTitleScenario(f.harness, id)).rejects.toThrow(
        'Title refusal bytes or attribution',
      )
      if (id === 'title-overflow') {
        f.events.push(error, {
          ...error,
          model: 'antigravity-gemini-3.8-flash',
          contentType: 'text/plain',
        })
        await expect(runGaTitleScenario(f.harness, id)).rejects.toThrow(
          'Title refusal bytes or attribution',
        )
        f.events[5] = {
          ...error,
          model: 'antigravity-gemini-3.8-flash',
          bytes: Buffer.from('invented title').toString('base64'),
        }
        await expect(runGaTitleScenario(f.harness, id)).rejects.toThrow(
          'Title refusal bytes or attribution',
        )
        f.events[5] = { ...error, model: 'antigravity-gemini-3.8-flash' }
        f.events[3]!.status = 200
        await expect(runGaTitleScenario(f.harness, id)).rejects.toThrow(
          'invented a successful response',
        )
        f.events[3]!.status = 400
        // Return a different title only on the second read of this invocation.
        let reads = 0
        f.harness.native.get = async () =>
          ({ title: ++reads === 1 ? 'Original' : 'Invented title' }) as Awaited<
            ReturnType<GaHarness['native']['get']>
          >
        await expect(runGaTitleScenario(f.harness, id)).rejects.toThrow(
          'changed the session title',
        )
      }
    })
  }
  it('Sonnet 5.5 low compares the physical cap to an independent prepared cap and native limit', async () => {
    for (const [prepared, expected] of [
      [8192, 8192],
      [200_000, 128_000],
      [null, 128_000],
    ] as const) {
      const f = fixture()
      const envelope = capRun(f, prepared, expected)
      await runGaCoreScenario(f.harness, 'claude-thinking')
      expect(f.selected).toEqual(
        Array(2).fill('google/antigravity-claude-sonnet-5-5#low'),
      )
      envelope.request.generationConfig.maxOutputTokens = expected - 1
      await expect(
        runGaCoreScenario(f.harness, 'claude-thinking'),
      ).rejects.toThrow('prepared caller cap')
      envelope.request.generationConfig.maxOutputTokens = expected
      envelope.request.generationConfig.thinkingConfig.thinkingBudget = 1024
      await expect(
        runGaCoreScenario(f.harness, 'claude-thinking'),
      ).rejects.toThrow('Sonnet 5.5 low')
    }
  })
  it('rejects missing, swapped, unowned and duplicate Claude cap attribution', async () => {
    for (const fault of [
      'session',
      'ownership',
      'missing',
      'swapped',
      'extra-primary',
      'extra-prepared',
      'native-session',
      'missing-native',
      'extra-wire',
      'wire-request',
      'wire-hash',
    ]) {
      const f = fixture()
      capRun(f, 8192, 8192, fault)
      await expect(
        runGaCoreScenario(f.harness, 'claude-thinking'),
      ).rejects.toThrow('Claude cap attribution')
    }
  })
})

describe('GA installed consumer controls at a non-default prefix', () => {
  function consumer() {
    // writeGaWrapper requires an installed package outside the checkout so
    // tests cannot accidentally exercise workspace source. The test preload
    // redirects TMPDIR into node_modules, so use the system temp root here.
    const prefix = realpathSync(
      mkdtempSync(join(realpathSync('/tmp'), 'ga-installed-consumer-')),
    )
    roots.push(prefix)
    const packageRoot = join(
      prefix,
      'node_modules/@cortexkit/opencode-antigravity-auth',
    )
    mkdirSync(join(packageRoot, 'src/tui-ga-compiled'), { recursive: true })
    mkdirSync(join(packageRoot, 'src/tui'), { recursive: true })
    writeFileSync(join(prefix, 'package.json'), '{"type":"module"}')
    writeFileSync(
      join(packageRoot, 'package.json'),
      JSON.stringify({
        name: '@cortexkit/opencode-antigravity-auth',
        type: 'module',
        exports: {
          './server': { import: './server.js' },
          './tui': { import: './src/tui/entry.mjs' },
        },
      }),
    )
    const loader = join(packageRoot, 'src/tui/entry.mjs')
    const target = join(packageRoot, 'src/tui-ga-compiled/host-ga.js')
    writeFileSync(target, 'export const GA_SIDEBAR_PULL_MS = 1000')
    const source = `import { loadTui } from '../common-auth-embedded/tui/index.js'
let gaRoot
function loadGa() {
  gaRoot ??= loadTui({ rawEntry: new URL('../tui-ga-raw/host-ga.tsx', import.meta.url).href,
    runtimeEntry: new URL('../tui-ga-compiled/host-ga.js', import.meta.url).href })
  return gaRoot
}
export default { async setup(context) { return (await loadGa()).setup(context) } }
`
    writeFileSync(loader, source)
    return { prefix, packageRoot, loader, target, source }
  }
  it('binds the packed compiled GA target to the public ./tui setup arm', () => {
    const c = consumer()
    expect(c.prefix).not.toContain('/opt/ga-consumer')
    expect(gaInstalledCompiledTui(c.prefix)).toBe(c.target)
    writeFileSync(
      c.loader,
      c.source.replace(
        "'../tui-ga-compiled/host-ga.js'",
        "'../tui-compiled/tui.js'",
      ),
    )
    expect(() => gaInstalledCompiledTui(c.prefix)).toThrow(
      'public ./tui setup runtime selection',
    )
    writeFileSync(
      c.loader,
      c.source.replace('(await loadGa())', '(await loadV1())'),
    )
    expect(() => gaInstalledCompiledTui(c.prefix)).toThrow(
      'public ./tui setup runtime selection',
    )
    writeFileSync(c.loader, c.source)
    rmSync(c.target)
    expect(() => gaInstalledCompiledTui(c.prefix)).toThrow(
      'compiled GA arm is missing',
    )
  })
  it('refuses a decoy loadGa call when setup returns another renderer', () => {
    const c = consumer()
    writeFileSync(
      c.loader,
      c.source.replace(
        'return (await loadGa()).setup(context)',
        'await loadGa(); return (await loadV1()).setup(context)',
      ),
    )
    expect(() => gaInstalledCompiledTui(c.prefix)).toThrow(
      'public ./tui setup runtime selection',
    )
  })
  it('records the host-prepared cap before plugin transformation, without consuming the request', async () => {
    const c = consumer()
    writeFileSync(
      join(c.packageRoot, 'server.js'),
      `export function createGaAntigravityPlugin() {
      return { async setup(context) {
        await context.session.hook('http.request', async event => {
          event.request = new Request(event.request.url, { method: 'POST', body: JSON.stringify({ generationConfig: { maxOutputTokens: 128000 } }) })
        })
        return async () => {}
      } }
    }`,
    )
    const paths = prepareGaRoot(root())
    const placeholderFixture = join(paths.state, 'captured-placeholder.json')
    const value = {
      type: 'oauth',
      methodID: 'antigravity-auth-pool-browser',
      access: 'synthetic-captured-placeholder',
    }
    writeFileSync(
      placeholderFixture,
      JSON.stringify({
        value,
        valueSha256: createHash('sha256')
          .update(JSON.stringify(value))
          .digest('hex'),
      }),
    )
    const wrapper = writeGaWrapper({
      paths,
      consumerPrefix: c.prefix,
      packedServerEntry: gaInstalledServer(c.prefix, 'import'),
      mockUrl: 'http://127.0.0.1:1234',
      rawSender: false,
      recordPreparedOutputCap: true,
      placeholderFixture,
    })
    const hooks: Array<
      (event: {
        kind: string
        model: { id: string }
        request: Request
        sessionID: string
      }) => Promise<void>
    > = []
    let disposed = 0
    const cleanup = await (
      await import(join(wrapper, 'index.ts'))
    ).default.setup({
      location: { directory: paths.project },
      session: {
        hook: async (name: string, handler: (typeof hooks)[number]) => {
          if (name === 'http.request') hooks.push(handler)
          return {
            dispose: async () => {
              disposed++
            },
          }
        },
      },
    })
    const request = new Request(
      'https://generativelanguage.googleapis.com/v1beta/models/claude:streamGenerateContent',
      {
        method: 'POST',
        headers: { 'x-goog-api-key': value.access },
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts: [{ text: `GA_CAP_CALLER_${'a'.repeat(32)}` }],
            },
          ],
          generationConfig: { maxOutputTokens: 8192 },
        }),
      },
    )
    const event = {
      request,
      kind: 'primary',
      model: { id: 'antigravity-claude-sonnet-5-5' },
      sessionID: 'prepared-session',
    }
    for (const hook of hooks) await hook(event)
    expect(request.bodyUsed).toBe(false)
    expect((await event.request.json()).generationConfig.maxOutputTokens).toBe(
      128000,
    )
    const events = readFileSync(join(paths.state, 'wrapper.ndjson'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(
      events.find((entry) => entry.event === 'native.prepared-output-cap'),
    ).toMatchObject({
      maxOutputTokens: 8192,
      sessionID: 'prepared-session',
      owned: true,
      caller: `GA_CAP_CALLER_${'a'.repeat(32)}`,
    })
    await expect(
      hooks[0]!({
        ...event,
        request: new Request('http://127.0.0.1:1234/rewritten', {
          method: 'POST',
          body: '{"request":{}}',
        }),
      }),
    ).rejects.toThrow('expected the host-prepared Google body before rewrite')
    await cleanup()
    expect(disposed).toBe(3)
  })
})
