#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
} from 'node:http'
import { connect } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { GA_LOOPBACK_REQUEST_CONTRACT } from './ga-loopback-request-contract.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
export const PORTS = Object.freeze({
  mock: 38191,
  other: 38192,
  A: 38193,
  B: 38194,
  provider: 38195,
})
export const PROXY_VARIABLES = [
  'HTTP_PROXY',
  'http_proxy',
  'HTTPS_PROXY',
  'https_proxy',
  'ALL_PROXY',
  'all_proxy',
] as const
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('expected object')
  return Object.fromEntries(Object.entries(value))
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
  const result = record(value)
  if (
    Object.keys(result).length !== keys.length ||
    keys.some((key) => !(key in result))
  )
    throw new Error(`unexpected/missing object keys; expected ${keys}`)
  return result
}
function string(value: unknown, pattern?: RegExp): string {
  if (typeof value !== 'string' || (pattern && !pattern.test(value)))
    throw new Error('malformed string')
  return value
}
function oneOf<T extends string | number | boolean>(
  value: unknown,
  allowed: readonly T[],
): T {
  const found = allowed.find((item) => item === value)
  if (found === undefined)
    throw new Error(`unexpected value ${String(value)}; expected ${allowed}`)
  return found
}
function list<T>(value: unknown, parse: (item: unknown) => T): T[] {
  if (!Array.isArray(value)) throw new Error('expected array')
  return value.map(parse)
}
const digest = (value: unknown) => string(value, /^[0-9a-f]{64}$/)
const uuid = (value: unknown) =>
  string(
    value,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  )
function environment(value: unknown): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record(value)).map(([key, item]) => [
      oneOf(key, [...PROXY_VARIABLES, 'NO_PROXY', 'no_proxy']),
      string(item),
    ]),
  )
}
function runtime(value: unknown) {
  const r = object(value, ['name', 'version', 'revision'])
  return {
    name: oneOf(r.name, ['Bun'] as const),
    version: oneOf(r.version, ['1.4.2'] as const),
    revision: oneOf(r.revision, [
      '744846f844374847c902b5e7fd59b4342a51ef99',
    ] as const),
  }
}
function parsePin(value: unknown) {
  const p = object(value, [
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
  const s = object(p.source, ['repository', 'tag', 'commit'])
  const v = object(p.provenance, [
    'artifact',
    'artifactRecordSha256',
    'runtime',
    'runtimeRecordSha256',
    'limits',
  ])
  return {
    schema: oneOf(p.schema, [1] as const),
    package: oneOf(p.package, ['@opencode/cli-linux-x64'] as const),
    version: oneOf(p.version, ['2.0.22'] as const),
    tarballURL: oneOf(p.tarballURL, [
      'https://registry.npmjs.org/@opencode/cli-linux-x64/-/cli-linux-x64-2.0.22.tgz',
    ] as const),
    sri: string(p.sri, /^sha512-[A-Za-z0-9+/]{86}==$/),
    binaryPath: oneOf(p.binaryPath, ['package/bin/opencode'] as const),
    binarySha256: digest(p.binarySha256),
    binaryBytes: oneOf(p.binaryBytes, [204482016] as const),
    elfMachine: oneOf(p.elfMachine, [62] as const),
    platform: oneOf(p.platform, ['linux/amd64'] as const),
    reportedVersion: oneOf(p.reportedVersion, ['opencode v2.0.22'] as const),
    runtime: runtime(p.runtime),
    source: {
      repository: string(s.repository),
      tag: oneOf(s.tag, ['v2.0.22'] as const),
      commit: oneOf(s.commit, [
        '527f0b931d1f9b3ebd34e106c51b31ce5db5b075',
      ] as const),
    },
    provenance: {
      artifact: string(v.artifact),
      artifactRecordSha256: digest(v.artifactRecordSha256),
      runtime: string(v.runtime),
      runtimeRecordSha256: digest(v.runtimeRecordSha256),
      limits: string(v.limits),
    },
  }
}
export const PinSchema = { parse: parsePin }
export type Pin = ReturnType<typeof parsePin>

export function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

// Parse only the verified member, never extract archive paths onto a filesystem.
export function verifiedBinary(
  tarball: Buffer,
  pin: {
    sri: string
    binaryPath: string
    binaryBytes: number
    binarySha256: string
    elfMachine: number
  },
): Buffer {
  const sri = `sha512-${createHash('sha512').update(tarball).digest('base64')}`
  if (sri !== pin.sri) throw new Error('tarball SRI mismatch before extraction')
  const tar = gunzipSync(tarball, { maxOutputLength: 256 * 1024 * 1024 })
  let binary: Buffer | undefined
  for (let at = 0; at + 512 <= tar.length; ) {
    const header = tar.subarray(at, at + 512)
    if (header.every((byte) => byte === 0)) break
    const text = (start: number, size: number) =>
      header
        .subarray(start, start + size)
        .toString()
        .split('\0')[0] ?? ''
    const sizeText = text(124, 12).trim()
    if (!/^[0-7]+$/.test(sizeText)) throw new Error('invalid tar member size')
    const size = Number.parseInt(sizeText, 8)
    const name = [text(345, 155), text(0, 100)].filter(Boolean).join('/')
    const expectedChecksum = Number.parseInt(text(148, 8).trim(), 8)
    const checksum = header.reduce(
      (sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte),
      0,
    )
    if (checksum !== expectedChecksum || at + 512 + size > tar.length)
      throw new Error('malformed tar header')
    if (name === pin.binaryPath) {
      if (binary || !['0', ''].includes(text(156, 1)))
        throw new Error('duplicate or non-file executable member')
      binary = tar.subarray(at + 512, at + 512 + size)
    }
    at += 512 + Math.ceil(size / 512) * 512
  }
  if (
    !binary ||
    binary.length !== pin.binaryBytes ||
    sha256(binary) !== pin.binarySha256
  )
    throw new Error('executable digest/length mismatch before execution')
  if (
    binary.subarray(0, 6).toString('hex') !== '7f454c460201' ||
    binary.readUInt16LE(18) !== pin.elfMachine
  )
    throw new Error('not pinned ELF x86-64')
  return binary
}

export interface CaseSpec {
  id: string
  group: 'control' | 'single' | 'exclusion' | 'precedence'
  env: Record<string, string>
  prerequisite: string | null
}

export function inventory(): CaseSpec[] {
  const cases: CaseSpec[] = [
    { id: 'control-no-proxy', group: 'control', env: {}, prerequisite: null },
  ]
  const add = (
    id: string,
    env: Record<string, string>,
    group: CaseSpec['group'] = 'precedence',
    prerequisite: string | null = null,
  ) => cases.push({ id, group, env, prerequisite })
  for (const variable of PROXY_VARIABLES) {
    add(`single-${variable}`, { [variable]: '{A}' }, 'single')
    const forms = [
      ['literal', '127.0.0.1'],
      ['port', '127.0.0.1:{mock}'],
      ['localhost', 'localhost'],
      ['ipv6', '::1'],
      ['cidr', '127.0.0.0/8'],
      ['wildcard', '*'],
      ['empty', ''],
      ['padded', ' 127.0.0.1 '],
      ['uppercase', 'LOCALHOST'],
      ['wrong-port', '127.0.0.1:{other}'],
      ['unrelated', 'example.com'],
      ['suffix-label', '0.0.1'],
      ['suffix-dot', '.0.0.1'],
      ['suffix-partial', '27.0.0.1'],
      ['other-ip', '127.0.0.2'],
      ['space-list', 'example.com 127.0.0.1'],
    ] as const
    for (const [slug, value] of forms) {
      add(
        `exclusion-${variable}-${slug}`,
        { [variable]: '{A}', NO_PROXY: value },
        'exclusion',
        `single-${variable}`,
      )
      add(
        `exclusion-${variable}-list-${slug}`,
        { [variable]: '{A}', NO_PROXY: `example.com,${value}` },
        'exclusion',
        `single-${variable}`,
      )
    }
    const conflicts: Record<string, Record<string, string>> = {
      'lower-match': { no_proxy: '127.0.0.1' },
      'upper-wins': { NO_PROXY: '127.0.0.1', no_proxy: 'example.com' },
      'lower-wins': { NO_PROXY: 'example.com', no_proxy: '127.0.0.1' },
      'lower-empty': { NO_PROXY: '127.0.0.1', no_proxy: '' },
      'upper-empty': { NO_PROXY: '', no_proxy: '127.0.0.1' },
    }
    for (const [slug, env] of Object.entries(conflicts))
      add(
        `exclusion-${variable}-${slug}`,
        { [variable]: '{A}', ...env },
        'exclusion',
        `single-${variable}`,
      )
  }
  for (let i = 0; i < PROXY_VARIABLES.length; i++)
    for (const second of PROXY_VARIABLES.slice(i + 1)) {
      const first = PROXY_VARIABLES[i]
      if (first)
        add(`precedence-${first}-${second}`, {
          [first]: '{A}',
          [second]: '{B}',
        })
    }
  add('raw-empty-http_proxy', { HTTP_PROXY: '{A}', http_proxy: '' })
  add('raw-empty-HTTP_PROXY', { HTTP_PROXY: '', http_proxy: '{A}' })
  add('quoted-http_proxy-dq', { HTTP_PROXY: '{A}', http_proxy: '""' })
  add('quoted-http_proxy-sq', { HTTP_PROXY: '{A}', http_proxy: "''" })
  add('quoted-HTTP_PROXY-dq', { HTTP_PROXY: '""', http_proxy: '{A}' })
  for (const variable of ['HTTP_PROXY', 'http_proxy'])
    for (const [slug, value] of [
      ['dq', '""'],
      ['sq', "''"],
    ]) {
      if (slug && value)
        add(`quoted-no_proxy-${variable}-${slug}`, {
          [variable]: '{A}',
          NO_PROXY: '127.0.0.1',
          no_proxy: value,
        })
    }
  if (new Set(cases.map((item) => item.id)).size !== cases.length)
    throw new Error('duplicate inventory')
  return cases
}

export function selectCases(ids?: string[]): CaseSpec[] {
  const all = inventory()
  if (ids === undefined) return all
  if (!ids.length || new Set(ids).size !== ids.length)
    throw new Error('zero or duplicate selection')
  const known = new Map(all.map((item) => [item.id, item]))
  if (ids.some((id) => !known.has(id))) throw new Error('unknown selector')
  const wanted = new Set(['control-no-proxy', ...ids])
  for (const id of ids) {
    const dependency = known.get(id)?.prerequisite
    if (dependency) wanted.add(dependency)
  }
  return all.filter((item) => wanted.has(item.id))
}

export function materialize(
  env: Record<string, string>,
): Record<string, string> {
  environment(env)
  return Object.fromEntries(
    Object.entries(env).map(([key, value]) => [
      key,
      value.replace(/\{([^}]+)\}/g, (_, token: string) => {
        if (token === 'A' || token === 'B')
          return `http://127.0.0.1:${PORTS[token]}`
        if (token === 'mock' || token === 'other') return String(PORTS[token])
        throw new Error(`unknown placeholder ${token}`)
      }),
    ]),
  )
}

function parseDispatch(value: unknown) {
  const d = object(value, ['hook', 'method', 'urlPattern', 'headers', 'body'])
  const headers = object(d.headers, ['content-type'])
  return {
    hook: oneOf(d.hook, ['http.request'] as const),
    method: oneOf(d.method, ['POST'] as const),
    urlPattern: oneOf(d.urlPattern, [
      'http://127.0.0.1:<port>/agy/<job>',
    ] as const),
    headers: {
      'content-type': oneOf(headers['content-type'], [
        'application/json',
      ] as const),
    },
    body: oneOf(d.body, ['{}'] as const),
  }
}
function parseRewrite(value: unknown) {
  const r = object(value, [
    'type',
    'job',
    'kind',
    'sessionID',
    'nonce',
    'originalURL',
    'originalBodySha256',
    'dispatch',
  ])
  const originalURL = string(r.originalURL)
  new URL(originalURL)
  return {
    type: oneOf(r.type, ['rewrite'] as const),
    job: uuid(r.job),
    kind: oneOf(r.kind, [
      'primary',
      'title',
      'compaction',
      'generate',
    ] as const),
    sessionID: string(r.sessionID, /./),
    nonce: r.nonce === null ? null : string(r.nonce),
    originalURL,
    originalBodySha256: digest(r.originalBodySha256),
    dispatch: parseDispatch(r.dispatch),
  }
}
function parsePluginEvent(value: unknown) {
  if (record(value).type !== 'setup') return parseRewrite(value)
  const s = object(value, ['type', 'runtime'])
  return {
    type: oneOf(s.type, ['setup'] as const),
    runtime: runtime(s.runtime),
  }
}
function parseWire(value: unknown) {
  const w = object(value, ['channel', 'method', 'target', 'body', 'connection'])
  return {
    channel: oneOf(w.channel, ['mock', 'provider', 'A', 'B'] as const),
    method: string(w.method, /./),
    target: string(w.target, /./),
    body: string(w.body),
    connection: w.connection === null ? null : uuid(w.connection),
  }
}
export const WireSchema = { parse: parseWire }
export type Wire = ReturnType<typeof parseWire>
export function parseLines(text: string): unknown[] {
  return text
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line))
}

export function assertCliCompletion(text: string): void {
  let reply = false
  let finished = false
  const events = parseLines(text)
  if (!events.length) throw new Error('zero CLI records')
  for (const value of events) {
    const e = record(value)
    const type = oneOf(e.type, [
      'error',
      'text',
      'step_start',
      'step_finish',
    ] as const)
    object(e, [
      'type',
      'timestamp',
      'sessionID',
      type === 'error' ? 'error' : 'part',
    ])
    if (typeof e.timestamp !== 'number' || !Number.isFinite(e.timestamp))
      throw new Error('invalid CLI timestamp')
    string(e.sessionID, /./)
    if (type === 'error')
      throw new Error(`native session error: ${JSON.stringify(e.error)}`)
    const p = record(e.part)
    for (const key of ['id', 'sessionID', 'messageID', 'type'])
      string(p[key], /./)
    if (p.sessionID !== e.sessionID) throw new Error('CLI session mismatch')
    if (type === 'text') {
      object(p, ['id', 'sessionID', 'messageID', 'type', 'text', 'time'])
      oneOf(p.type, ['text'])
      const time = object(p.time, ['start', 'end'])
      if (typeof time.start !== 'number' || typeof time.end !== 'number')
        throw new Error('invalid text timing')
      if (string(p.text) === 'GA-MEASURE-OK') reply = true
    } else if (type === 'step_start') {
      object(p, ['id', 'sessionID', 'messageID', 'type', 'snapshot'])
      oneOf(p.type, ['step-start'])
      string(p.snapshot)
    } else {
      object(p, [
        'id',
        'sessionID',
        'messageID',
        'type',
        'reason',
        'snapshot',
        'cost',
        'tokens',
      ])
      oneOf(p.type, ['step-finish'])
      oneOf(p.reason, ['stop'])
      string(p.snapshot)
      if (typeof p.cost !== 'number' || !Number.isFinite(p.cost))
        throw new Error('invalid CLI cost')
      const tokens = object(p.tokens, ['input', 'output', 'reasoning', 'cache'])
      const cache = object(tokens.cache, ['read', 'write'])
      for (const count of [
        tokens.input,
        tokens.output,
        tokens.reasoning,
        cache.read,
        cache.write,
      ])
        if (typeof count !== 'number' || !Number.isFinite(count) || count < 0)
          throw new Error('invalid CLI tokens')
      finished = true
    }
  }
  if (!reply || !finished)
    throw new Error('native session did not complete with mock text')
}

export function classify(
  nonce: string,
  rawEvents: unknown[],
  rawWire: unknown[],
  pin: Pin,
): { outcome: 'direct' | 'proxied'; recorder: 'A' | 'B' | null } {
  const events = rawEvents.map(parsePluginEvent)
  const setups = events.filter((item) => item.type === 'setup')
  if (
    setups.length !== 1 ||
    JSON.stringify(setups[0]?.runtime) !== JSON.stringify(pin.runtime)
  )
    throw new Error('missing/duplicate setup or runtime mismatch')
  const rewrites = events.filter((item) => item.type === 'rewrite')
  if (new Set(rewrites.map((item) => item.job)).size !== rewrites.length)
    throw new Error('duplicate job')
  const primary = rewrites.filter(
    (item) => item.kind === 'primary' && item.nonce === nonce,
  )
  if (primary.length !== 1)
    throw new Error('missing/duplicate nonce-matched primary rewrite')
  const owner = primary[0]
  if (!owner) throw new Error('zero primary')
  const wire = rawWire.map((item) => WireSchema.parse(item))
  if (wire.some((item) => item.channel === 'provider'))
    throw new Error('direct-provider fallthrough')
  for (const item of wire) {
    if (
      item.channel === 'mock' &&
      (item.method !== 'POST' ||
        item.body !== '{}' ||
        !rewrites.some(
          (rewrite) =>
            item.target === `/agy/${rewrite.job}` ||
            item.target === `http://127.0.0.1:${PORTS.mock}/agy/${rewrite.job}`,
        ))
    )
      throw new Error('unknown/malformed mock job observation')
  }
  const tied = (item: Wire) => {
    try {
      const target = new URL(item.target, `http://127.0.0.1:${PORTS.mock}`)
      return (
        target.hostname === '127.0.0.1' &&
        target.port === String(PORTS.mock) &&
        target.pathname === `/agy/${owner.job}`
      )
    } catch {
      return false
    }
  }
  const hits = wire.filter(
    (item) => item.channel === 'mock' && item.method === 'POST' && tied(item),
  )
  if (hits.length !== 1 || hits[0]?.body !== '{}')
    throw new Error('missing/duplicate/malformed primary mock request')
  const proxyHits = wire.filter(
    (item) =>
      (item.channel === 'A' || item.channel === 'B') &&
      item.method === 'POST' &&
      tied(item),
  )
  const connects = wire.filter(
    (item) =>
      (item.channel === 'A' || item.channel === 'B') &&
      item.method === 'CONNECT' &&
      item.target === `127.0.0.1:${PORTS.mock}`,
  )
  for (const connection of connects) {
    // A tunnel's destination authority identifies only a host and port, not a
    // job or request kind. An observed inner HTTP request on that same tunnel
    // must bind the connection to the primary job.
    if (
      !wire.some(
        (item) =>
          item.channel === connection.channel &&
          item.connection === connection.connection &&
          item.method === 'POST' &&
          tied(item),
      )
    ) {
      const titleJobs = rewrites
        .filter((item) => item.kind === 'title')
        .map((item) => `/agy/${item.job}`)
      const titleOnly = wire.some(
        (item) =>
          item.channel === connection.channel &&
          item.connection === connection.connection &&
          titleJobs.some((path) => item.target.endsWith(path)),
      )
      if (!titleOnly) throw new Error('untied CONNECT anomaly')
    }
  }
  if (proxyHits.length > 1 || proxyHits.some((item) => item.body !== '{}'))
    throw new Error('duplicate/malformed primary proxy request')
  const recorder = proxyHits[0]?.channel
  return recorder === 'A' || recorder === 'B'
    ? { outcome: 'proxied', recorder }
    : { outcome: 'direct', recorder: null }
}

export function assertNative(value: unknown) {
  try {
    const n = object(value, [
      'hostUname',
      'daemonArchitecture',
      'containerUname',
      'elfMachine',
      'runtime',
      'network',
      'interfaces',
      'image',
    ])
    const interfaces = list(n.interfaces, (item) =>
      oneOf(item, ['lo'] as const),
    )
    if (interfaces.length !== 1) throw new Error('non-loopback interfaces')
    return {
      hostUname: oneOf(n.hostUname, ['x86_64'] as const),
      daemonArchitecture: oneOf(n.daemonArchitecture, [
        'amd64',
        'x86_64',
      ] as const),
      containerUname: oneOf(n.containerUname, ['x86_64'] as const),
      elfMachine: oneOf(n.elfMachine, [62] as const),
      runtime: runtime(n.runtime),
      network: oneOf(n.network, ['none'] as const),
      interfaces,
      image: string(n.image, /^sha256:[0-9a-f]{64}$/),
    }
  } catch (error) {
    throw new Error(
      `not native x86_64 or invalid isolation/runtime provenance: ${String(error)}`,
    )
  }
}
function parseRow(value: unknown) {
  const r = object(value, [
    'id',
    'variables',
    'conflicts',
    'outcome',
    'recorder',
    'reason',
    'binarySha256',
    'pluginPath',
    'command',
  ])
  const command = list(r.command, (item) => string(item, /./))
  if (!command.length) throw new Error('empty command')
  return {
    id: string(r.id),
    variables: environment(r.variables),
    conflicts: list(r.conflicts, (item) => string(item)),
    outcome: oneOf(r.outcome, [
      'direct',
      'proxied',
      'error',
      'excluded',
    ] as const),
    recorder:
      r.recorder === null ? null : oneOf(r.recorder, ['A', 'B'] as const),
    reason: r.reason === null ? null : string(r.reason),
    binarySha256: digest(r.binarySha256),
    pluginPath: string(r.pluginPath, /./),
    command,
  }
}
function parseMatrix(value: unknown) {
  const m = object(value, [
    'schema',
    'full',
    'binarySha256',
    'native',
    'sources',
    'rows',
  ])
  const s = object(m.sources, [
    'ga-measure-plugin.ts',
    'ga-loopback-request-contract.ts',
    'measure-ga-proxy-matrix.ts',
    'ga-binary-pin.json',
  ])
  const rows = list(m.rows, parseRow)
  if (!rows.length) throw new Error('zero rows')
  return {
    schema: oneOf(m.schema, [1] as const),
    full: oneOf(m.full, [true, false] as const),
    binarySha256: digest(m.binarySha256),
    native: assertNative(m.native),
    sources: {
      'ga-measure-plugin.ts': digest(s['ga-measure-plugin.ts']),
      'ga-loopback-request-contract.ts': digest(
        s['ga-loopback-request-contract.ts'],
      ),
      'measure-ga-proxy-matrix.ts': digest(s['measure-ga-proxy-matrix.ts']),
      'ga-binary-pin.json': digest(s['ga-binary-pin.json']),
    },
    rows,
  }
}
export const MatrixSchema = { parse: parseMatrix }
export type Matrix = ReturnType<typeof parseMatrix>
export function sourceDigests() {
  return {
    'ga-measure-plugin.ts': sha256(
      readFileSync(join(HERE, 'ga-measure-plugin.ts')),
    ),
    'ga-loopback-request-contract.ts': sha256(
      readFileSync(join(HERE, 'ga-loopback-request-contract.ts')),
    ),
    'measure-ga-proxy-matrix.ts': sha256(
      readFileSync(join(HERE, 'measure-ga-proxy-matrix.ts')),
    ),
    'ga-binary-pin.json': sha256(
      readFileSync(join(HERE, 'ga-binary-pin.json')),
    ),
  }
}

export function commandForCase(id: string): string[] {
  const hex = sha256(id).slice(0, 32)
  const nonce = `GA-NONCE-${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`
  return [
    '/tmp/ga-verified-opencode',
    'run',
    '--standalone',
    '--print-logs',
    '--log-level',
    'info',
    '--format',
    'json',
    '--model',
    'google/probe-model',
    `Reply with one word. ${nonce}`,
  ]
}

export function validateMatrix(
  value: unknown,
  pin: Pin,
  selected = inventory(),
  requested?: string[],
): Matrix {
  const matrix = MatrixSchema.parse(value)
  if (matrix.binarySha256 !== pin.binarySha256)
    throw new Error('matrix binary digest mismatch')
  if (JSON.stringify(matrix.sources) !== JSON.stringify(sourceDigests()))
    throw new Error('measured source digest mismatch')
  if (
    matrix.rows.length !== selected.length ||
    new Set(matrix.rows.map((row) => row.id)).size !== matrix.rows.length
  )
    throw new Error('absent/duplicate row')
  const rows = new Map(matrix.rows.map((row) => [row.id, row]))
  let effective = 0
  for (const spec of selected) {
    const row = rows.get(spec.id)
    const variables = materialize(spec.env)
    const conflicts =
      Object.keys(variables).length > 1 ? Object.keys(variables) : []
    if (
      !row ||
      JSON.stringify(row.variables) !== JSON.stringify(variables) ||
      row.binarySha256 !== pin.binarySha256 ||
      JSON.stringify(row.conflicts) !== JSON.stringify(conflicts) ||
      row.pluginPath !== '/input/ga-measure-plugin.ts' ||
      JSON.stringify(row.command) !== JSON.stringify(commandForCase(spec.id))
    )
      throw new Error(`unknown/malformed row ${spec.id}`)
    if (row.outcome === 'error')
      throw new Error(`unresolved failure ${spec.id}: ${row.reason}`)
    if (row.outcome === 'excluded') {
      const prerequisite = spec.prerequisite && rows.get(spec.prerequisite)
      if (
        !prerequisite ||
        prerequisite.outcome !== 'direct' ||
        row.reason !== `unhonoured:${spec.prerequisite}` ||
        row.recorder !== null
      )
        throw new Error(`invalid exclusion ${spec.id}`)
    } else {
      effective++
      if (
        row.reason !== null ||
        (row.outcome === 'direct') !== (row.recorder === null)
      )
        throw new Error(`invalid outcome ${spec.id}`)
    }
  }
  if (!effective || rows.get('control-no-proxy')?.outcome !== 'direct')
    throw new Error('zero-effective selection or failed positive control')
  if (
    requested &&
    !matrix.rows.some(
      (row) => requested.includes(row.id) && row.outcome !== 'excluded',
    )
  )
    throw new Error('zero-effective requested selector')
  return matrix
}

export function normalizedMatrix(matrix: Matrix) {
  return {
    ...matrix,
    rows: matrix.rows.map((row) => ({
      ...row,
      variables: Object.fromEntries(
        Object.entries(row.variables).map(([key, value]) => [
          key,
          value.replace(/:(38191|38192|38193|38194)\b/g, ':<port>'),
        ]),
      ),
      pluginPath: '<absolute-path>/ga-measure-plugin.ts',
      command: row.command.map((arg) =>
        arg.startsWith('/') ? `<absolute-path>/${arg.split('/').at(-1)}` : arg,
      ),
    })),
  }
}
export function assertConformance(
  fresh: unknown,
  retained: unknown,
  pin: Pin,
): void {
  const left = validateMatrix(fresh, pin)
  const right = validateMatrix(retained, pin)
  if (
    !left.full ||
    !right.full ||
    JSON.stringify(normalizedMatrix(left)) !==
      JSON.stringify(normalizedMatrix(right))
  )
    throw new Error(
      'absent retained matrix or normalized native matrix difference',
    )
}

function jsonFile(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' })
}

export function isolatedEnv(
  root: string,
  variables: Record<string, string>,
): Record<string, string> {
  return {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: join(root, 'home'),
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_CACHE_HOME: join(root, 'cache'),
    XDG_DATA_HOME: join(root, 'data'),
    XDG_STATE_HOME: join(root, 'state'),
    OPENCODE_DB: join(root, 'db', 'opencode.db'),
    OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
    OPENCODE_DISABLE_UPDATE_CHECK: '1',
    GOOGLE_GENERATIVE_AI_API_KEY: 'GA-FAKE-NOT-A-CREDENTIAL',
    ...variables,
  }
}

// A CLI can spawn a server in a different process group. This container owns
// all processes except its init; account for descendants instead of trusting
// only the CLI's exit or inherited stdout handles.
function processes(): Set<number> {
  const alive = new Set<number>()
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, 'utf8')
      if (
        !['Z', 'X'].includes(
          stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] ?? '',
        )
      )
        alive.add(Number(entry))
    } catch {
      /* A process exiting between directory and stat reads is already gone. */
    }
  }
  return alive
}

async function invoke(
  binary: string,
  args: string[],
  root: string,
  env: Record<string, string>,
  output: string,
  timeoutMs: number,
): Promise<string> {
  jsonFile(join(output, 'command.json'), {
    binary,
    args,
    cwd: root,
    env,
    timeoutMs,
  })
  const before = processes()
  const pin = PinSchema.parse(
    JSON.parse(readFileSync(join(HERE, 'ga-binary-pin.json'), 'utf8')),
  )
  const executable = readFileSync(binary)
  if (
    executable.length !== pin.binaryBytes ||
    sha256(executable) !== pin.binarySha256 ||
    executable.readUInt16LE(18) !== pin.elfMachine
  )
    throw new Error('executable changed before invocation')
  const descendants = () => [...processes()].filter((pid) => !before.has(pid))
  return new Promise((resolvePromise, reject) => {
    const child = spawn(binary, args, {
      cwd: root,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let finished = false
    const kill = () => {
      for (const pid of descendants()) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          /* Exited before the signal; checked again at finish. */
        }
      }
    }
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    const timer = setTimeout(() => {
      timedOut = true
      kill()
    }, timeoutMs)
    const finish = (
      code: number | null,
      signal: string | null,
      error?: Error,
    ) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      const survivors = descendants()
      kill()
      child.stdout.destroy()
      child.stderr.destroy()
      writeFileSync(join(output, 'stdout.jsonl'), stdout, { flag: 'wx' })
      writeFileSync(join(output, 'stderr.log'), stderr, { flag: 'wx' })
      jsonFile(join(output, 'exit.json'), {
        code,
        signal,
        timedOut,
        survivors,
        spawnError: error?.message ?? null,
      })
      if (error || timedOut || signal || code !== 0 || survivors.length)
        reject(
          new Error(
            `host infrastructure failure: ${error?.message ?? signal ?? code}; timeout=${timedOut}; survivors=${survivors}`,
          ),
        )
      else resolvePromise(stdout)
    }
    child.once('error', (error) => finish(null, null, error))
    child.once('close', (code, signal) => finish(code, signal))
    // Even a descendant holding a pipe cannot extend the deadline indefinitely.
    const hardTimer = setTimeout(
      () => finish(null, 'deadline'),
      timeoutMs + 3000,
    )
    child.once('close', () => clearTimeout(hardTimer))
  })
}

async function bodyOf(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let length = 0
  req.setTimeout(10_000, () => req.destroy(new Error('body deadline')))
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    length += bytes.length
    if (length > 8 * 1024 * 1024) throw new Error('oversized request')
    chunks.push(bytes)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function localTarget(raw: string): URL {
  const url = new URL(raw)
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    !url.port ||
    url.username ||
    url.password
  )
    throw new Error('recorder refuses non-loopback target')
  return url
}

export function parseTunnelRequests(bytes: Buffer, authority: string) {
  const requests: Array<{ method: string; target: string; body: string }> = []
  let at = 0
  while (at < bytes.length) {
    const split = bytes.indexOf('\r\n\r\n', at)
    if (split < 0) break
    const headers = bytes.subarray(at, split).toString()
    const [method, path, version] = (headers.split('\r\n')[0] ?? '').split(' ')
    if (!method || !/^[A-Z]+$/.test(method) || !path || version !== 'HTTP/1.1')
      throw new Error('malformed tunnel request line')
    const rawLength = /\r\ncontent-length:\s*([^\r\n]+)/i.exec(headers)?.[1]
    const transfer = /\r\ntransfer-encoding:\s*([^\r\n]+)/i.exec(headers)?.[1]
    let end = split + 4
    let body: Buffer
    if (transfer) {
      if (transfer.toLowerCase() !== 'chunked' || rawLength !== undefined)
        throw new Error('ambiguous tunnel framing')
      const chunks: Buffer[] = []
      let complete = false
      while (end < bytes.length) {
        const line = bytes.indexOf('\r\n', end)
        if (line < 0) break
        const sizeText =
          bytes.subarray(end, line).toString().split(';')[0] ?? ''
        if (!/^[0-9a-f]+$/i.test(sizeText))
          throw new Error('invalid tunnel chunk size')
        const size = Number.parseInt(sizeText, 16)
        if (size > 8 * 1024 * 1024) throw new Error('oversized tunnel chunk')
        if (size === 0) {
          if (bytes.subarray(line + 2, line + 4).toString() === '\r\n') {
            end = line + 4
            complete = true
            break
          }
          const trailers = bytes.indexOf('\r\n\r\n', line + 2)
          if (trailers < 0) break
          end = trailers + 4
          complete = true
          break
        }
        if (bytes.length < line + 2 + size + 2) break
        if (
          bytes.subarray(line + 2 + size, line + 4 + size).toString() !== '\r\n'
        )
          throw new Error('malformed chunk terminator')
        chunks.push(bytes.subarray(line + 2, line + 2 + size))
        end = line + 4 + size
      }
      if (!complete) break
      body = Buffer.concat(chunks)
    } else {
      if (rawLength !== undefined && !/^\d+$/.test(rawLength))
        throw new Error('invalid tunnel content-length')
      const size = Number(rawLength ?? '0')
      if (!Number.isSafeInteger(size) || size > 8 * 1024 * 1024)
        throw new Error('oversized tunnel body')
      end += size
      if (bytes.length < end) break
      body = bytes.subarray(split + 4, end)
    }
    requests.push({
      method,
      target: new URL(path, localTarget(`http://${authority}`)).href,
      body: body.toString(),
    })
    at = end
  }
  return { requests, remainder: bytes.subarray(at) }
}

interface ManagedServer {
  server: Server
  sockets: Set<import('node:net').Socket>
}

async function closeServers(servers: ManagedServer[]): Promise<void> {
  for (const { server, sockets } of servers) {
    for (const socket of sockets) socket.destroy()
    server.closeAllConnections()
    await new Promise<void>((done, reject) => {
      const timer = setTimeout(
        () => reject(new Error('server cleanup deadline')),
        2000,
      )
      server.close(() => {
        clearTimeout(timer)
        done()
      })
    })
  }
}

async function startServers(
  wire: Wire[],
  failures: string[],
  output: string,
): Promise<ManagedServer[]> {
  const servers: ManagedServer[] = []
  const record = (event: Wire) => {
    WireSchema.parse(event)
    wire.push(event)
    writeFileSync(join(output, 'wire.jsonl'), `${JSON.stringify(event)}\n`, {
      flag: 'a',
    })
  }
  try {
    for (const channel of ['mock', 'provider', 'A', 'B'] as const) {
      const server = createServer((req, res) => {
        void (async () => {
          const body = await bodyOf(req)
          const target = req.url ?? ''
          record({
            channel,
            method: req.method ?? '',
            target,
            body,
            connection: null,
          })
          if (channel === 'mock' || channel === 'provider') {
            if (channel === 'provider') {
              res.writeHead(502)
              res.end('direct-provider')
              return
            }
            if (
              req.method !== 'POST' ||
              !/^\/agy\/[0-9a-f-]{36}$/.test(target) ||
              body !== '{}'
            )
              throw new Error('invalid mock dispatch')
            const frame = {
              candidates: [
                {
                  index: 0,
                  content: {
                    role: 'model',
                    parts: [{ text: 'GA-MEASURE-OK' }],
                  },
                  finishReason: 'STOP',
                },
              ],
              usageMetadata: {
                promptTokenCount: 5,
                candidatesTokenCount: 2,
                totalTokenCount: 7,
              },
            }
            res.writeHead(200, { 'content-type': 'text/event-stream' })
            res.end(`data: ${JSON.stringify(frame)}\r\n\r\n`)
            return
          }
          const url = localTarget(target)
          const forwarded = httpRequest(
            url,
            {
              method: req.method,
              headers: { ...req.headers, host: url.host },
              timeout: 10_000,
            },
            (upstream) => {
              res.writeHead(upstream.statusCode ?? 502, upstream.headers)
              upstream.pipe(res)
            },
          )
          forwarded.once('timeout', () =>
            forwarded.destroy(new Error('forward deadline')),
          )
          forwarded.once('error', (error) => {
            failures.push(String(error))
            res.destroy(error)
          })
          forwarded.end(body)
        })().catch((error: unknown) => {
          failures.push(String(error))
          res.destroy(error instanceof Error ? error : new Error(String(error)))
        })
      })
      const sockets = new Set<import('node:net').Socket>()
      server.on('connection', (socket) => {
        sockets.add(socket)
        socket.once('close', () => sockets.delete(socket))
      })
      server.requestTimeout = 15_000
      server.headersTimeout = 10_000
      server.on('clientError', (error, socket) => {
        failures.push(String(error))
        socket.destroy()
      })
      if (channel === 'A' || channel === 'B')
        server.on('connect', (req, socket, head) => {
          const connection = randomUUID()
          const authority = req.url ?? ''
          record({
            channel,
            method: 'CONNECT',
            target: authority,
            body: '',
            connection,
          })
          let url: URL
          try {
            url = localTarget(`http://${authority}`)
          } catch (error) {
            failures.push(String(error))
            socket.destroy()
            return
          }
          const upstream = connect(Number(url.port), '127.0.0.1')
          upstream.setTimeout(10_000, () =>
            upstream.destroy(new Error('tunnel deadline')),
          )
          const reportError = (error: Error) => {
            failures.push(String(error))
            socket.destroy()
            upstream.destroy()
          }
          upstream.on('error', reportError)
          socket.on('error', reportError)
          let observed = Buffer.alloc(0)
          const observe = (chunk: Buffer) => {
            observed = Buffer.concat([observed, chunk])
            if (observed.length > 8 * 1024 * 1024) {
              reportError(new Error('oversized tunnel'))
              return
            }
            try {
              const parsed = parseTunnelRequests(observed, authority)
              for (const item of parsed.requests)
                record({ channel, ...item, connection })
              observed = Buffer.from(parsed.remainder)
            } catch (error) {
              reportError(
                error instanceof Error ? error : new Error(String(error)),
              )
            }
          }
          socket.on('data', observe)
          if (head.length) observe(head)
          upstream.once('connect', () => {
            socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
            if (head.length) upstream.write(head)
            socket.pipe(upstream)
            upstream.pipe(socket)
          })
          socket.once('close', () => upstream.destroy())
          upstream.once('close', () => socket.destroy())
        })
      await new Promise<void>((done, reject) => {
        server.once('error', reject)
        server.listen(PORTS[channel], '127.0.0.1', () => {
          server.off('error', reject)
          done()
        })
      })
      server.on('error', (error) => failures.push(String(error)))
      servers.push({ server, sockets })
    }
    return servers
  } catch (error) {
    await closeServers(servers)
    throw error
  }
}

function checkedCommand(binary: string, args: string[]): string {
  const result = spawnSync(binary, args, {
    encoding: 'utf8',
    timeout: 15_000,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    maxBuffer: 8 * 1024 * 1024,
  })
  if (
    result.error ||
    result.signal ||
    result.status !== 0 ||
    !result.stdout.trim()
  )
    throw new Error(
      `prerequisite failed ${binary} ${args.join(' ')}: ${result.error ?? result.stderr}`,
    )
  return result.stdout.trim()
}

export function parseArgs(args: string[]) {
  const allowed = new Set([
    '--out',
    '--image',
    '--tarball',
    '--cases',
    '--compare',
    '--inside',
  ])
  const values = new Map<string, string>()
  if (args.length % 2) throw new Error('flags require values')
  for (let at = 0; at < args.length; at += 2) {
    const key = args[at]
    const value = args[at + 1]
    if (
      !key ||
      !allowed.has(key) ||
      values.has(key) ||
      !value ||
      value.startsWith('--')
    )
      throw new Error('unknown, duplicate or empty argument')
    values.set(key, value)
  }
  const out = values.get('--out')
  if (!out) throw new Error('--out requires one fresh output root')
  const cases = values.has('--cases')
    ? values.get('--cases')?.split(',')
    : undefined
  selectCases(cases)
  const inside = values.get('--inside')
  const image = values.get('--image')
  const tarball = values.get('--tarball')
  if (inside) {
    if (
      inside !== 'native-container' ||
      image ||
      tarball ||
      values.has('--compare')
    )
      throw new Error('invalid inside invocation')
  } else if (!image || !/^sha256:[0-9a-f]{64}$/.test(image) || !tarball)
    throw new Error(
      'require local immutable --image sha256:<digest> and --tarball',
    )
  return {
    out: resolve(out),
    image,
    tarball: tarball && resolve(tarball),
    cases,
    inside,
    compare: values.get('--compare'),
  }
}

async function insideRun(options: ReturnType<typeof parseArgs>): Promise<void> {
  const out = options.out
  const selected = selectCases(options.cases)
  const pin = PinSchema.parse(
    JSON.parse(readFileSync(join(HERE, 'ga-binary-pin.json'), 'utf8')),
  )
  if (
    process.platform !== 'linux' ||
    process.arch !== 'x64' ||
    !existsSync('/.dockerenv')
  )
    throw new Error('not native x86_64 Docker container')
  const outside = object(
    JSON.parse(readFileSync(join(HERE, 'outside.json'), 'utf8')),
    [
      'hostUname',
      'daemonArchitecture',
      'image',
      'command',
      'rawHostUname',
      'rawDaemonArchitecture',
      'imageInspection',
    ],
  )
  const native = assertNative({
    hostUname: outside.hostUname,
    daemonArchitecture: outside.daemonArchitecture,
    image: outside.image,
    containerUname: checkedCommand('uname', ['-m']),
    elfMachine: pin.elfMachine,
    runtime: pin.runtime,
    network: 'none',
    interfaces: readdirSync('/sys/class/net').sort(),
  })
  const binaryBytes = verifiedBinary(readFileSync(join(HERE, 'host.tgz')), pin)
  const binary = '/tmp/ga-verified-opencode'
  writeFileSync(binary, binaryBytes, { flag: 'wx' })
  chmodSync(binary, 0o700)
  const versionRoot = join(out, 'version')
  mkdirSync(versionRoot)
  const versionEnv = isolatedEnv(versionRoot, {})
  for (const path of Object.values(versionEnv).filter((value) =>
    value.startsWith(versionRoot),
  ))
    mkdirSync(path.endsWith('.db') ? dirname(path) : path, { recursive: true })
  const reported = await invoke(
    binary,
    ['--version'],
    versionRoot,
    versionEnv,
    versionRoot,
    15_000,
  )
  if (reported.trim() !== pin.reportedVersion)
    throw new Error('reported host version mismatch')
  const sources = sourceDigests()
  const matrix: Matrix = {
    schema: 1,
    full: options.cases === undefined,
    binarySha256: pin.binarySha256,
    native,
    sources,
    rows: [],
  }
  jsonFile(join(out, 'inventory.json'), {
    all: inventory(),
    selected,
    selection: options.cases ?? 'full',
    contract: GA_LOOPBACK_REQUEST_CONTRACT,
  })
  for (const [index, spec] of selected.entries()) {
    const root = join(out, `${String(index + 1).padStart(3, '0')}-${spec.id}`)
    mkdirSync(root)
    const command = commandForCase(spec.id)
    const nonce = /GA-NONCE-[0-9a-f-]{36}/.exec(command.at(-1) ?? '')?.[0]
    if (!nonce) throw new Error('missing case nonce')
    const pluginPath = join(HERE, 'ga-measure-plugin.ts')
    const variables = materialize(spec.env)
    const row: ReturnType<typeof parseRow> = {
      id: spec.id,
      variables,
      conflicts:
        Object.keys(variables).length > 1 ? Object.keys(variables) : [],
      outcome: 'error',
      recorder: null,
      reason: 'not measured',
      binarySha256: pin.binarySha256,
      pluginPath,
      command,
    }
    if (spec.prerequisite) {
      const prerequisite = matrix.rows.find(
        (item) => item.id === spec.prerequisite,
      )
      if (
        !prerequisite ||
        !['direct', 'proxied'].includes(prerequisite.outcome)
      )
        throw new Error(`missing prerequisite ${spec.prerequisite}`)
      if (prerequisite.outcome === 'direct') {
        row.outcome = 'excluded'
        row.reason = `unhonoured:${spec.prerequisite}`
        matrix.rows.push(row)
        jsonFile(join(root, 'row.json'), row)
        continue
      }
    }
    const env = isolatedEnv(root, {
      ...variables,
      GA_MEASURE_LOG: join(root, 'plugin.jsonl'),
      GA_MOCK_PORT: String(PORTS.mock),
    })
    for (const key of [
      'HOME',
      'XDG_CONFIG_HOME',
      'XDG_CACHE_HOME',
      'XDG_DATA_HOME',
      'XDG_STATE_HOME',
    ]) {
      const path = env[key]
      if (!path) throw new Error(`missing isolation ${key}`)
      mkdirSync(path)
    }
    mkdirSync(join(root, 'db'))
    mkdirSync(join(root, 'project'))
    checkedCommand('git', ['-C', join(root, 'project'), 'init'])
    const configDir = join(root, 'config', 'opencode')
    mkdirSync(configDir)
    jsonFile(join(configDir, 'opencode.json'), {
      plugins: [pluginPath],
      providers: {
        google: {
          settings: {
            baseURL: `http://127.0.0.1:${PORTS.provider}/v1beta`,
            apiKey: 'GA-FAKE-NOT-A-CREDENTIAL',
          },
          models: { 'probe-model': { name: 'Probe model' } },
        },
      },
    })
    writeFileSync(join(root, 'plugin.jsonl'), '', { flag: 'wx' })
    writeFileSync(join(root, 'wire.jsonl'), '', { flag: 'wx' })
    const wire: Wire[] = []
    const failures: string[] = []
    const servers = await startServers(wire, failures, root)
    try {
      const stdout = await invoke(
        binary,
        command.slice(1),
        join(root, 'project'),
        env,
        root,
        50_000,
      )
      if (failures.length)
        throw new Error(`recorder infrastructure: ${failures.join('; ')}`)
      const events = parseLines(
        readFileSync(join(root, 'plugin.jsonl'), 'utf8'),
      )
      if (
        spec.id === 'control-no-proxy' &&
        !events.some((value) => {
          const event = parsePluginEvent(value)
          return event.type === 'rewrite' && event.kind === 'title'
        })
      )
        throw new Error(
          'positive control did not observe the title request kind',
        )
      const result = classify(nonce, events, wire, pin)
      assertCliCompletion(stdout)
      if (!existsSync(env.OPENCODE_DB ?? ''))
        throw new Error('explicit isolated OPENCODE_DB was not created')
      Object.assign(row, result, { reason: null })
    } catch (error) {
      row.reason = String(error)
      throw error
    } finally {
      await closeServers(servers)
      matrix.rows.push(row)
      jsonFile(join(root, 'row.json'), row)
      // A failed partial result remains diagnostic evidence, never a promoted matrix.
      writeFileSync(
        join(out, 'partial.json'),
        `${JSON.stringify(matrix, null, 2)}\n`,
      )
    }
  }
  validateMatrix(matrix, pin, selected, options.cases)
  jsonFile(join(out, 'matrix.json'), matrix)
}

async function outsideRun(
  options: ReturnType<typeof parseArgs>,
): Promise<void> {
  const { out, image, tarball } = options
  if (!image || !tarball) throw new Error('missing prerequisites')
  if (existsSync(out)) throw new Error('output root must not exist')
  // The root contains only fresh runner-owned data. No host HOME, repository,
  // registry cache, tokens or operator configuration is mounted into Docker.
  mkdirSync(out)
  const inputs = join(out, 'inputs')
  mkdirSync(inputs)
  const pin = PinSchema.parse(
    JSON.parse(readFileSync(join(HERE, 'ga-binary-pin.json'), 'utf8')),
  )
  const archive = readFileSync(tarball)
  verifiedBinary(archive, pin)
  const hostUname = checkedCommand('uname', ['-m'])
  const daemonArchitecture = checkedCommand('docker', [
    'info',
    '--format',
    '{{.Architecture}}',
  ])
  jsonFile(join(out, 'measuring-host.json'), {
    hostUname,
    daemonArchitecture,
    commands: [
      ['uname', '-m'],
      ['docker', 'info', '--format', '{{.Architecture}}'],
    ],
  })
  if (
    hostUname !== 'x86_64' ||
    !['amd64', 'x86_64'].includes(daemonArchitecture)
  )
    throw new Error('not native x86_64 measuring host/daemon')
  const imageInspection = checkedCommand('docker', [
    'image',
    'inspect',
    image,
    '--format',
    '{{.Id}} {{.Os}} {{.Architecture}}',
  ])
  if (imageInspection !== `${image} linux amd64`)
    throw new Error('image is not the admitted immutable Linux amd64 image')
  for (const name of [
    'ga-binary-pin.json',
    'ga-measure-plugin.ts',
    'ga-loopback-request-contract.ts',
    'measure-ga-proxy-matrix.ts',
  ])
    writeFileSync(join(inputs, name), readFileSync(join(HERE, name)), {
      flag: 'wx',
    })
  writeFileSync(join(inputs, 'host.tgz'), archive, { flag: 'wx' })
  const containerName = `ga-proxy-measure-${randomUUID()}`
  const command = [
    'run',
    '--name',
    containerName,
    '--rm',
    '--init',
    '--pull=never',
    '--network',
    'none',
    '--platform',
    'linux/amd64',
    '--read-only',
    '--cap-drop=ALL',
    '--security-opt',
    'no-new-privileges',
    '--tmpfs',
    '/tmp:rw,exec,nosuid,size=2g',
    '--mount',
    `type=bind,src=${inputs},dst=/input,readonly`,
    '--mount',
    `type=bind,src=${out},dst=/output`,
    '--entrypoint',
    'bun',
    image,
    'run',
    '/input/measure-ga-proxy-matrix.ts',
    '--inside',
    'native-container',
    '--out',
    '/output',
    ...(options.cases ? ['--cases', options.cases.join(',')] : []),
  ]
  jsonFile(join(inputs, 'outside.json'), {
    hostUname,
    daemonArchitecture,
    image,
    command: ['docker', ...command],
    rawHostUname: hostUname,
    rawDaemonArchitecture: daemonArchitecture,
    imageInspection,
  })
  const result = spawnSync('docker', command, {
    encoding: 'utf8',
    timeout: selectCases(options.cases).length * 65_000 + 60_000,
    maxBuffer: 16 * 1024 * 1024,
    killSignal: 'SIGKILL',
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
  })
  if (result.error || result.signal || result.status !== 0) {
    const cleanup = spawnSync('docker', ['rm', '--force', containerName], {
      encoding: 'utf8',
      timeout: 15_000,
      killSignal: 'SIGKILL',
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    })
    jsonFile(join(out, 'docker.cleanup.json'), {
      status: cleanup.status,
      signal: cleanup.signal,
      error: cleanup.error?.message ?? null,
      stdout: cleanup.stdout,
      stderr: cleanup.stderr,
    })
  }
  writeFileSync(join(out, 'docker.stdout.log'), result.stdout ?? '', {
    flag: 'wx',
  })
  writeFileSync(join(out, 'docker.stderr.log'), result.stderr ?? '', {
    flag: 'wx',
  })
  jsonFile(join(out, 'docker.exit.json'), {
    status: result.status,
    signal: result.signal,
    error: result.error?.message ?? null,
  })
  if (result.error || result.signal || result.status !== 0)
    throw new Error(
      `native measurement failed: ${result.error ?? result.stderr}`,
    )
  const matrix = validateMatrix(
    JSON.parse(readFileSync(join(out, 'matrix.json'), 'utf8')),
    pin,
    selectCases(options.cases),
    options.cases,
  )
  for (const [name, hash] of Object.entries(matrix.sources))
    if (sha256(readFileSync(join(inputs, name))) !== hash)
      throw new Error(`measured source digest changed: ${name}`)
  if (options.compare)
    assertConformance(
      matrix,
      JSON.parse(readFileSync(resolve(options.compare), 'utf8')),
      pin,
    )
}

if (import.meta.main) {
  try {
    if ('NODE_TLS_REJECT_UNAUTHORIZED' in process.env)
      throw new Error('TLS bypass variable refuses launch')
    const options = parseArgs(process.argv.slice(2))
    await (options.inside ? insideRun(options) : outsideRun(options))
    console.log(
      'GA native proxy measurement completed; promotion remains a separate review step',
    )
  } catch (error) {
    console.error(String(error))
    process.exitCode = 1
  }
}
