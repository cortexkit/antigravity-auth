import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import {
  ModuleKind,
  ModuleResolutionKind,
  ScriptTarget,
  createCompilerHost,
  createProgram,
  createSourceFile,
  flattenDiagnosticMessageText,
  getPreEmitDiagnostics,
  version as typescriptVersion,
} from 'typescript'
import {
  assertRewriteConformance,
  GA_LOOPBACK_REQUEST_CONTRACT,
  matchesGoogleContentPath,
} from './ga-loopback-request-contract.ts'
import {
  assertCliCompletion,
  assertConformance,
  assertNative,
  classify,
  commandForCase,
  inventory,
  isolatedEnv,
  materialize,
  parseArgs,
  parseLines,
  parseTunnelRequests,
  PinSchema,
  PORTS,
  selectCases,
  sha256,
  sourceDigests,
  validateMatrix,
  verifiedBinary,
  type Matrix,
  type Wire,
} from './measure-ga-proxy-matrix.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const pin = PinSchema.parse(
  JSON.parse(readFileSync(join(HERE, 'ga-binary-pin.json'), 'utf8')),
)
const native = {
  hostUname: 'x86_64',
  daemonArchitecture: 'amd64',
  containerUname: 'x86_64',
  elfMachine: 62,
  runtime: pin.runtime,
  network: 'none',
  interfaces: ['lo'],
  image: `sha256:${'a'.repeat(64)}`,
}
const nonce = 'GA-NONCE-01234567-0123-4123-a123-0123456789ab'
const primaryJob = '01234567-0123-4123-a123-0123456789ab'
const titleJob = '01234567-0123-4123-a123-0123456789ac'
const dispatch = {
  hook: 'http.request',
  method: 'POST',
  urlPattern: 'http://127.0.0.1:<port>/agy/<job>',
  headers: { 'content-type': 'application/json' },
  body: '{}',
}
const rewrite = (kind = 'primary', job = primaryJob) => ({
  type: 'rewrite',
  kind,
  job,
  sessionID: 'ses_fake',
  nonce,
  originalURL:
    'http://127.0.0.1:38195/v1beta/models/probe-model:streamGenerateContent?alt=sse',
  originalBodySha256: 'b'.repeat(64),
  dispatch,
})
const events = () => [{ type: 'setup', runtime: pin.runtime }, rewrite()]
const wire = (
  channel: Wire['channel'] = 'mock',
  job = primaryJob,
  connection: string | null = null,
): Wire => ({
  channel,
  method: 'POST',
  target: `http://127.0.0.1:${PORTS.mock}/agy/${job}`,
  body: '{}',
  connection,
})
function matrix(): Matrix {
  return {
    schema: 1,
    full: true,
    binarySha256: pin.binarySha256,
    native: assertNative(native),
    sources: sourceDigests(),
    rows: inventory().map((spec) => {
      const variables = materialize(spec.env)
      return {
        id: spec.id,
        variables,
        conflicts:
          Object.keys(variables).length > 1 ? Object.keys(variables) : [],
        outcome: 'direct',
        recorder: null,
        reason: null,
        binarySha256: pin.binarySha256,
        pluginPath: '/input/ga-measure-plugin.ts',
        command: commandForCase(spec.id),
      }
    }),
  }
}

// This is a parser fixture only. A tiny synthetic ELF must never be executed.
function syntheticArchive() {
  const bytes = Buffer.alloc(32)
  bytes.set(Buffer.from('7f454c460201', 'hex'))
  bytes.writeUInt16LE(62, 18)
  const header = Buffer.alloc(512)
  header.write('package/bin/opencode', 0)
  header.write('00000000040\0', 124)
  header.write('0', 156)
  header.fill(32, 148, 156)
  const checksum = header.reduce((sum, byte) => sum + byte, 0)
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148)
  const tarball = gzipSync(
    Buffer.concat([
      header,
      bytes,
      Buffer.alloc(512 - bytes.length),
      Buffer.alloc(1024),
    ]),
  )
  return {
    bytes,
    tarball,
    syntheticPin: {
      ...pin,
      binaryBytes: bytes.length,
      binarySha256: sha256(bytes),
      sri: `sha512-${createHash('sha512').update(tarball).digest('base64')}`,
    },
  }
}

function checkObserverFixture(name: string, source: string) {
  const filename = join(HERE, `${name}.fixture.ts`)
  const options = {
    strict: true,
    noEmit: true,
    target: ScriptTarget.ES2023,
    module: ModuleKind.Preserve,
    moduleResolution: ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
    lib: ['lib.es2023.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
    types: [],
  }
  const host = createCompilerHost(options)
  const originalGetSourceFile = host.getSourceFile
  // Only the fixture is virtual. The diagnostic type and its source closure
  // are read from the real contract file by the ordinary compiler host.
  host.getSourceFile = (
    path,
    languageVersion,
    onError,
    shouldCreateNewSourceFile,
  ) =>
    path === filename
      ? createSourceFile(path, source, languageVersion, true)
      : originalGetSourceFile(
          path,
          languageVersion,
          onError,
          shouldCreateNewSourceFile,
        )
  const program = createProgram([filename], options, host)
  return getPreEmitDiagnostics(program).map((diagnostic) => ({
    code: diagnostic.code,
    file: diagnostic.file?.fileName,
    message: flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
  }))
}

describe('actual raw-sender observer type contract', () => {
  test('ga.raw-cancel.async-observer-rejected', () => {
    const preamble =
      "import type { ObserveRawSenderSignal } from './ga-loopback-request-contract.ts'\n"
    const positive = `${preamble}
export const observeRawSenderSignal: ObserveRawSenderSignal = (signal) => {
  signal.addEventListener('abort', () => {})
  return undefined
}
`
    const negative = `${preamble}
export const observeRawSenderSignal: ObserveRawSenderSignal = async (signal) => {
  signal.addEventListener('abort', () => {})
  return undefined
}
`
    expect(
      checkObserverFixture('ga.raw-cancel.sync-observer-accepted', positive),
    ).toEqual([])
    const diagnostics = checkObserverFixture(
      'ga.raw-cancel.async-observer-rejected',
      negative,
    )
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]?.code).toBe(2322)
    expect(diagnostics[0]?.file).toBe(
      join(HERE, 'ga.raw-cancel.async-observer-rejected.fixture.ts'),
    )
    expect(diagnostics[0]?.message).toContain('Promise<undefined>')
    expect(diagnostics[0]?.message).toContain(
      "not assignable to type 'undefined'",
    )
    console.info(
      `TypeScript ${typescriptVersion}: synchronous observer accepted; async observer rejected with TS2322`,
    )
  }, 30_000)
})

describe('GA materialized inputs', () => {
  test('GA pin is the independently verified released x64 artifact, not a source attestation', () => {
    expect(pin.binarySha256).toBe(
      '32cf5aa0a69a650e36277e3315d189835ddc79fb9aa1d0aef5025be5af5ad122',
    )
    expect(pin.sri).toBe(
      'sha512-DlV1qgEDDnVqpTWMPqv7tCHCcXodzZBFaMcxjsiYdY6E5gHH2Q68JfasVksyQ1nu6m1887WQKGhOsepE+oKyYw==',
    )
    expect(pin.provenance.limits).toContain(
      'do not attest binary-to-source equivalence',
    )
    expect(() => PinSchema.parse({ ...pin, version: '2.0.20' })).toThrow()
    expect(() => PinSchema.parse({ ...pin, unknown: true })).toThrow()
  })
  test('V1 pins retain both independently verified 1.17.13 artifacts byte-exactly', () => {
    const bytes = readFileSync(join(HERE, 'opencode1-binary-pins.json'))
    expect(sha256(bytes)).toBe(
      '75a8b919bca7a36dae5f55ff85f3e4edfbf9e808fb7a75b41bbdc37579047b9a',
    )
    const value = JSON.parse(bytes.toString())
    expect(
      value.artifacts.map(
        (item: { package: string; elfMachine: number; version: string }) => [
          item.package,
          item.elfMachine,
          item.version,
        ],
      ),
    ).toEqual([
      ['opencode-linux-x64', 62, '1.17.13'],
      ['opencode-linux-arm64', 183, '1.17.13'],
    ])
  })
  test('overflow fixtures retain exact canned Google envelopes and provenance', () => {
    for (const [name, hash, bodyHash, length] of [
      [
        'gemini',
        '96945d1aa2e76e502993c9c5a0a0366af88e70df298b31ae61d327614724d61d',
        '8f7c248c6ea08caa5db181b1e4f27290a5cc508e259ef00bc2281035c42e982a',
        148,
      ],
      [
        'claude',
        '81575e79d0b0e88f3b5ff7cec9f65391c8844f813fcd945d5ace2e80b74ff43e',
        '773dfc1934b7d6b429f728b5842f5338ef69451b5513f4bf6b1ac48edbbec01f',
        113,
      ],
    ] as const) {
      const bytes = readFileSync(
        join(
          HERE,
          '../../opencode/src/plugin/shared/__fixtures__',
          `overflow-${name}.json`,
        ),
      )
      expect(sha256(bytes)).toBe(hash)
      const value = JSON.parse(bytes.toString())
      expect(value.status).toBe(400)
      expect(value.contentType).toBe('application/json')
      expect(value.bodySha256).toBe(bodyHash)
      expect(sha256(Buffer.from(value.body))).toBe(bodyHash)
      expect(Buffer.from(value.bodyBase64, 'base64')).toEqual(
        Buffer.from(value.body),
      )
      expect(Buffer.byteLength(value.body)).toBe(length)
      expect(JSON.parse(value.body).error.status).toBe('INVALID_ARGUMENT')
      expect(value.provenance.kind).toBe(
        'retained canned mock response, not a live backend capture',
      )
      expect(value.provenance.observedMagicContextRevision).toBe(
        'cda6851df61b3d53b900174e285cedcfecedb213',
      )
    }
  })
  test('measurement plugin is independent of proxies, retained matrices and the adapter', () => {
    const source = readFileSync(join(HERE, 'ga-measure-plugin.ts'), 'utf8')
    expect(source).not.toMatch(
      /(?:process\.env|Bun\.env)(?:\.[A-Za-z_]*[Pp][Rr][Oo][Xx][Yy]|\[['"][^'"]*[Pp][Rr][Oo][Xx][Yy])/,
    )
    expect(source).not.toMatch(
      /Object\.(?:entries|keys|values)\((?:process|Bun)\.env\)/,
    )
    expect(source).not.toMatch(
      /(?:opencode\/src|ga-proxy-env-matrix|antigravity)/i,
    )
    expect(source).toContain("import type { Plugin } from '@opencode/plugin'")
    expect(source).toMatch(/context\.session\.hook\(\s*['"]http\.request['"]/)
    expect(source).toContain("{ providerID: 'google' }")
  })
  test('runner has no ignored evidence or promoted output dependency', () => {
    const source = readFileSync(
      join(HERE, 'measure-ga-proxy-matrix.ts'),
      'utf8',
    )
    expect(source).not.toContain('.cortexkit')
    expect(source).not.toContain('ga-proxy-env-matrix.json')
    expect(source).not.toContain('ga-proxy-env-matrix.provenance.json')
  })
})

describe('released HTTP request contract', () => {
  test('pathname matching is exact, never origin-only', () => {
    expect(
      matchesGoogleContentPath('/v1beta/models/example:generateContent'),
    ).toBe(true)
    expect(
      matchesGoogleContentPath('/v1beta/models/example:streamGenerateContent'),
    ).toBe(true)
    for (const path of [
      '/v1beta/models/example:generateContent/extra',
      '/v1beta/models/example:streamGenerateContentFake',
      '/unrelated',
      '/agy/123',
      '/v1beta/models/:generateContent',
    ])
      expect(matchesGoogleContentPath(path)).toBe(false)
  })
  test('normalized dispatch freezes POST, job URL, only JSON content-type and exact empty object', async () => {
    expect(GA_LOOPBACK_REQUEST_CONTRACT.headers.copied).toEqual([])
    await assertRewriteConformance(
      new Request(`http://127.0.0.1:38191/agy/${primaryJob}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
    )
    for (const [url, init] of [
      [
        `http://localhost:38191/agy/${primaryJob}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        },
      ],
      [
        `http://127.0.0.1:38191/agy/${primaryJob}`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        },
      ],
      [
        `http://127.0.0.1:38191/agy/${primaryJob}`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: 'fake',
          },
          body: '{}',
        },
      ],
      [
        `http://127.0.0.1:38191/agy/${primaryJob}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '',
        },
      ],
    ] as const)
      await expect(
        assertRewriteConformance(new Request(url, init)),
      ).rejects.toThrow()
  })
})

describe('fail-closed measurement inputs and inventory', () => {
  test('inventory includes six singles, all exclusion forms, conflicts and exact seven quoted rows', () => {
    const all = inventory()
    expect(all).toHaveLength(253)
    expect(new Set(all.map((item) => item.id)).size).toBe(253)
    expect(all.filter((item) => item.id.startsWith('single-'))).toHaveLength(6)
    expect(all.filter((item) => item.id.startsWith('quoted-'))).toHaveLength(7)
    for (const variable of [
      'HTTP_PROXY',
      'http_proxy',
      'HTTPS_PROXY',
      'https_proxy',
      'ALL_PROXY',
      'all_proxy',
    ]) {
      for (const slug of [
        'literal',
        'port',
        'localhost',
        'ipv6',
        'cidr',
        'wildcard',
        'empty',
        'padded',
        'uppercase',
        'wrong-port',
        'unrelated',
      ]) {
        expect(
          all.some((item) => item.id === `exclusion-${variable}-${slug}`),
        ).toBe(true)
        expect(
          all.some((item) => item.id === `exclusion-${variable}-list-${slug}`),
        ).toBe(true)
      }
    }
    expect(
      all.find((item) => item.id === 'quoted-http_proxy-dq')?.env.http_proxy,
    ).toBe('""')
    expect(
      all.find((item) => item.id === 'quoted-http_proxy-sq')?.env.http_proxy,
    ).toBe("''")
    expect(
      all.find((item) => item.id === 'raw-empty-http_proxy')?.env.http_proxy,
    ).toBe('')
    expect(
      new Set(all.map((item) => commandForCase(item.id).at(-1))).size,
    ).toBe(253)
  })
  test('selection refuses empty, duplicate and unknown cases and explicitly adds prerequisites', () => {
    for (const ids of [
      [],
      ['missing'],
      ['single-HTTP_PROXY', 'single-HTTP_PROXY'],
    ])
      expect(() => selectCases(ids)).toThrow()
    expect(
      selectCases(['exclusion-http_proxy-port']).map((item) => item.id),
    ).toEqual([
      'control-no-proxy',
      'single-http_proxy',
      'exclusion-http_proxy-port',
    ])
    expect(() => materialize({ HTTP_PROXY: '{unknown}' })).toThrow()
    expect(() => materialize({ UNKNOWN_PROXY: 'http://127.0.0.1' })).toThrow()
  })
  test('argv rejects zero selectors, unknown flags, mutable images and missing prerequisites', () => {
    for (const args of [
      [],
      ['--out', '/tmp/fresh'],
      [
        '--out',
        '/tmp/fresh',
        '--image',
        'ubuntu:latest',
        '--tarball',
        '/tmp/host.tgz',
      ],
      ['--out', '/tmp/fresh', '--inside', 'native-container', '--cases', ''],
      ['--out', '/tmp/fresh', '--inside', 'native-container', '--typo', '1'],
      ['--out', '/tmp/fresh', '--out', '/tmp/other'],
    ])
      expect(() => parseArgs(args)).toThrow()
    expect(
      parseArgs(['--out', '/tmp/fresh', '--inside', 'native-container']).inside,
    ).toBe('native-container')
  })
  test('isolation builds credentials, database and HOME/XDG from the row root, not the caller', () => {
    const env = isolatedEnv('/tmp/row-root', {
      HTTP_PROXY: 'http://127.0.0.1:38193',
    })
    expect(env.OPENCODE_DB).toBe('/tmp/row-root/db/opencode.db')
    for (const key of [
      'HOME',
      'XDG_CONFIG_HOME',
      'XDG_CACHE_HOME',
      'XDG_DATA_HOME',
      'XDG_STATE_HOME',
    ])
      expect(env[key]).toStartWith('/tmp/row-root/')
    expect(env.GOOGLE_GENERATIVE_AI_API_KEY).toBe('GA-FAKE-NOT-A-CREDENTIAL')
    expect(env.HTTPS_PROXY).toBeUndefined()
    const previous = process.env.GA_PRIVATE_ENV_CONTROL
    process.env.GA_PRIVATE_ENV_CONTROL = 'FAKE-ONLY'
    try {
      expect(
        isolatedEnv('/tmp/row-root', {}).GA_PRIVATE_ENV_CONTROL,
      ).toBeUndefined()
    } finally {
      if (previous === undefined) delete process.env.GA_PRIVATE_ENV_CONTROL
      else process.env.GA_PRIVATE_ENV_CONTROL = previous
    }
    expect(env.no_proxy).toBeUndefined()
  })
  test('SRI is checked before archive parsing and executable digest before execution', () => {
    const { tarball, bytes, syntheticPin } = syntheticArchive()
    expect(verifiedBinary(tarball, syntheticPin)).toEqual(bytes)
    expect(() => verifiedBinary(Buffer.from('not gzip'), syntheticPin)).toThrow(
      'SRI mismatch before extraction',
    )
    expect(() =>
      verifiedBinary(tarball, {
        ...syntheticPin,
        binarySha256: '0'.repeat(64),
      }),
    ).toThrow('digest/length mismatch before execution')
    expect(() =>
      verifiedBinary(tarball, { ...syntheticPin, elfMachine: 183 }),
    ).toThrow('ELF x86-64')
    expect(() => PinSchema.parse(syntheticPin)).toThrow()
  })
})

describe('primary-request attribution and native result validation', () => {
  test('tunnel parser retains split requests, chunked bodies and multiple jobs on one connection', () => {
    const head = `POST /agy/${titleJob} HTTP/1.1\r\nHost: 127.0.0.1:${PORTS.mock}\r\nContent-Length: 2\r\n\r\n`
    const next = `POST /agy/${primaryJob} HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n2\r\n{}\r\n0\r\n\r\n`
    const parsed = parseTunnelRequests(
      Buffer.from(`${head}{}${next}`),
      `127.0.0.1:${PORTS.mock}`,
    )
    expect(parsed.requests).toEqual([
      {
        method: 'POST',
        target: `http://127.0.0.1:${PORTS.mock}/agy/${titleJob}`,
        body: '{}',
      },
      {
        method: 'POST',
        target: `http://127.0.0.1:${PORTS.mock}/agy/${primaryJob}`,
        body: '{}',
      },
    ])
    expect(parsed.remainder.length).toBe(0)
    expect(
      parseTunnelRequests(Buffer.from(`${head}{`), `127.0.0.1:${PORTS.mock}`)
        .requests,
    ).toHaveLength(0)
    const partial = Buffer.from(next.slice(0, -3))
    expect(
      parseTunnelRequests(partial, `127.0.0.1:${PORTS.mock}`).remainder,
    ).toEqual(partial)
    for (const bad of [
      'bad\r\n\r\n',
      'POST / HTTP/1.1\r\nContent-Length: fake\r\n\r\n',
      'POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\nContent-Length: 2\r\n\r\n{}',
      'POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\nbad-size\r\n',
    ])
      expect(() =>
        parseTunnelRequests(Buffer.from(bad), `127.0.0.1:${PORTS.mock}`),
      ).toThrow()
  })
  test('native CLI completion refuses error, zero, unknown, malformed and unterminated records', () => {
    const text = {
      type: 'text',
      timestamp: 1,
      sessionID: 'ses_fake',
      part: {
        id: 'p',
        sessionID: 'ses_fake',
        messageID: 'm',
        type: 'text',
        text: 'GA-MEASURE-OK',
        time: { start: 1, end: 2 },
      },
    }
    const finish = {
      type: 'step_finish',
      timestamp: 2,
      sessionID: 'ses_fake',
      part: {
        id: 'q',
        sessionID: 'ses_fake',
        messageID: 'm',
        type: 'step-finish',
        reason: 'stop',
        snapshot: 'fake',
        cost: 0,
        tokens: {
          input: 5,
          output: 2,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      },
    }
    const lines = (...values: unknown[]) =>
      values.map((value) => JSON.stringify(value)).join('\n')
    expect(() => assertCliCompletion(lines(text, finish))).not.toThrow()
    for (const value of [
      '',
      'not-json',
      lines(text),
      lines(finish),
      lines({ ...text, type: 'unknown' }),
      lines({ ...text, unknown: true }),
      lines({ ...text, sessionID: 'foreign' }, finish),
      lines({
        type: 'error',
        timestamp: 3,
        sessionID: 'ses_fake',
        error: {
          type: 'provider.transport',
          message: 'fake reset',
          status: 200,
        },
      }),
    ])
      expect(() => assertCliCompletion(value)).toThrow()
  })
  test('only a nonce-matched primary plus mock request proves direct', () => {
    expect(classify(nonce, events(), [wire()], pin)).toEqual({
      outcome: 'direct',
      recorder: null,
    })
    expect(() => classify('GA-NONCE-other', events(), [wire()], pin)).toThrow()
    expect(() => classify(nonce, [rewrite()], [wire()], pin)).toThrow()
    expect(() =>
      classify(nonce, [...events(), rewrite()], [wire()], pin),
    ).toThrow()
    expect(() => classify(nonce, events(), [], pin)).toThrow()
    expect(() => classify(nonce, events(), [wire(), wire()], pin)).toThrow()
    expect(() =>
      classify(nonce, events(), [{ ...wire(), body: 'not-json' }], pin),
    ).toThrow()
    expect(() =>
      classify(nonce, events(), [{ ...wire(), unknown: true }], pin),
    ).toThrow()
    expect(() => parseLines('{"valid":true}\nnot-json\n')).toThrow()
  })
  test('tied recorder HTTP and CONNECT prove proxied; untied CONNECT is refused', () => {
    const connection = 'abcdef01-0123-4123-a123-0123456789ab'
    const tunnel: Wire = {
      channel: 'A',
      method: 'CONNECT',
      target: `127.0.0.1:${PORTS.mock}`,
      body: '',
      connection,
    }
    expect(classify(nonce, events(), [wire(), wire('A')], pin)).toEqual({
      outcome: 'proxied',
      recorder: 'A',
    })
    expect(
      classify(
        nonce,
        events(),
        [wire(), tunnel, wire('A', primaryJob, connection)],
        pin,
      ),
    ).toEqual({ outcome: 'proxied', recorder: 'A' })
    expect(() => classify(nonce, events(), [wire(), tunnel], pin)).toThrow(
      'untied CONNECT',
    )
  })
  test('title-only CONNECT never counts as primary proxied', () => {
    const connection = 'abcdef01-0123-4123-a123-0123456789ab'
    expect(
      classify(
        nonce,
        [...events(), rewrite('title', titleJob)],
        [
          wire(),
          {
            channel: 'A',
            method: 'CONNECT',
            target: `127.0.0.1:${PORTS.mock}`,
            body: '',
            connection,
          },
          wire('A', titleJob, connection),
        ],
        pin,
      ),
    ).toEqual({ outcome: 'direct', recorder: null })
  })
  test('public fallthrough and runtime mismatches are infrastructure failures', () => {
    expect(() =>
      classify(nonce, events(), [wire(), wire('provider')], pin),
    ).toThrow('direct-provider')
    expect(() =>
      classify(
        nonce,
        [
          { type: 'setup', runtime: { ...pin.runtime, revision: 'bad' } },
          rewrite(),
        ],
        [wire()],
        pin,
      ),
    ).toThrow()
  })
  test('container x86_64 cannot certify an arm64 host or daemon', () => {
    expect(assertNative(native).containerUname).toBe('x86_64')
    for (const patch of [
      { hostUname: 'arm64' },
      { daemonArchitecture: 'aarch64' },
      { containerUname: 'aarch64' },
      { elfMachine: 183 },
      { interfaces: ['lo', 'eth0'] },
      { network: 'bridge' },
    ])
      expect(() => assertNative({ ...native, ...patch })).toThrow(
        'not native x86_64',
      )
  })
  test('matrix requires exact unique inventory, digest, schemas and positive control', () => {
    const good = matrix()
    expect(validateMatrix(good, pin).rows).toHaveLength(253)
    for (const mutate of [
      (m: Matrix) => {
        m.rows.pop()
      },
      (m: Matrix) => {
        m.rows.push(m.rows[0]!)
      },
      (m: Matrix) => {
        m.rows[0]!.id = 'unknown'
      },
      (m: Matrix) => {
        m.binarySha256 = `0${m.binarySha256.slice(1)}`
      },
      (m: Matrix) => {
        m.sources['ga-measure-plugin.ts'] = '0'.repeat(64)
      },
      (m: Matrix) => {
        m.rows[0]!.outcome = 'error'
        m.rows[0]!.reason = 'timeout'
      },
      (m: Matrix) => {
        m.rows[0]!.outcome = 'proxied'
        m.rows[0]!.recorder = 'A'
      },
      (m: Matrix) => {
        m.rows[0]!.command = ['not opencode']
      },
    ]) {
      const copy = structuredClone(good)
      mutate(copy)
      expect(() => validateMatrix(copy, pin)).toThrow()
    }
    expect(() => validateMatrix({ ...good, unknown: true }, pin)).toThrow()
    expect(() => validateMatrix({ ...good, rows: [] }, pin)).toThrow()
  })
  test('excluded rows require an observed unhonoured single, never a silent skip', () => {
    const good = matrix()
    const excluded = good.rows.find(
      (row) => row.id === 'exclusion-HTTPS_PROXY-literal',
    )!
    excluded.outcome = 'excluded'
    excluded.reason = 'unhonoured:single-HTTPS_PROXY'
    expect(validateMatrix(good, pin).rows).toHaveLength(253)
    expect(() =>
      validateMatrix(good, pin, inventory(), ['exclusion-HTTPS_PROXY-literal']),
    ).toThrow('zero-effective requested selector')
    excluded.reason = 'not run'
    expect(() => validateMatrix(good, pin)).toThrow('invalid exclusion')
    excluded.reason = 'unhonoured:single-HTTPS_PROXY'
    const prerequisite = good.rows.find(
      (row) => row.id === 'single-HTTPS_PROXY',
    )!
    prerequisite.outcome = 'proxied'
    prerequisite.recorder = 'A'
    expect(() => validateMatrix(good, pin)).toThrow('invalid exclusion')
  })
  test('conformance refuses absent retained output, focused results and normalized differences', () => {
    const good = matrix()
    expect(() =>
      assertConformance(good, structuredClone(good), pin),
    ).not.toThrow()
    expect(() => assertConformance(good, undefined, pin)).toThrow()
    const changed = structuredClone(good)
    changed.rows[1]!.outcome = 'proxied'
    changed.rows[1]!.recorder = 'A'
    expect(() => assertConformance(good, changed, pin)).toThrow('difference')
    const differentImage = structuredClone(good)
    differentImage.native.image = `sha256:${'b'.repeat(64)}`
    expect(() => assertConformance(good, differentImage, pin)).toThrow(
      'difference',
    )
    expect(() =>
      assertConformance({ ...good, full: false }, good, pin),
    ).toThrow()
  })
})
