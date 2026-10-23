#!/usr/bin/env bun
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
} from 'node:http'
import { createRequire } from 'node:module'
import { connect } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { GA_LOOPBACK_REQUEST_CONTRACT } from './ga-loopback-request-contract.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '../../..')
const FIXTURE = '../src/fixtures/opencode-ga-host'
const NATIVE_SOURCES = [
  `${FIXTURE}/native-job.ts`,
  `${FIXTURE}/native-boundary.py`,
  `${FIXTURE}/owned-command.ts`,
  `${FIXTURE}/package.json`,
  `${FIXTURE}/bun.lock`,
] as const
// Docker copies only its original four inputs. Load the native-only fixture lazily.
const require = createRequire(import.meta.url)
function nativeJobFixture(): typeof import('../src/fixtures/opencode-ga-host/native-job.ts') {
  return require(join(HERE, FIXTURE, 'native-job.ts'))
}
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

function absoluteRoot(value: unknown): string {
  const root = string(value, /^\//)
  if (
    root === '/' ||
    resolve(root) !== root ||
    [...root].some((char) => char.charCodeAt(0) < 32)
  )
    throw new Error('native layout requires a canonical absolute root')
  return root
}
function nativeLayout(root: string) {
  return {
    binary: join(root, 'inputs/ga-verified-opencode'),
    plugin: join(root, 'inputs/ga-measure-plugin.ts'),
  }
}
function positiveInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw new Error('expected positive integer')
  return value
}

// The MOTOR isolated-job service supplies this supervisor policy. These values
// describe its configuration, not a fresh unit-property read or signed attestation.
// Observed kernel/filesystem facts are recorded separately.
const MOTOR_PROCESS_POLICY = {
  source: 'MOTOR owner-qualified supervisor contract',
  privatePids: true,
  killMode: 'control-group',
  jobEndBackstop: 'systemd teardown',
  unitPropertiesObserved: false,
  signedAttestation: false,
} as const

function protection(value: unknown) {
  const p = object(value, ['uid', 'gid', 'mode', 'jobWritable'])
  const mode = positiveInteger(p.mode)
  if (mode > 0o777 || (mode & 0o022) !== 0)
    throw new Error('job-writable protection mode')
  return {
    uid: oneOf(p.uid, [0] as const),
    gid: nonnegativeInteger(p.gid),
    mode,
    jobWritable: oneOf(p.jobWritable, [false] as const),
  }
}
function pressureObservation(value: unknown, jobUid: number) {
  const p = object(value, [
    'name',
    'fileType',
    'uid',
    'gid',
    'mode',
    'jobWritable',
    'mount',
  ])
  const mount = object(p.mount, [
    'point',
    'root',
    'type',
    'source',
    'options',
    'superOptions',
  ])
  const options = list(mount.options, (value) =>
    string(value, /^[a-zA-Z0-9_=.-]+$/),
  )
  if (
    new Set(options).size !== options.length ||
    options.includes('ro') === options.includes('rw')
  )
    throw new Error('ambiguous cgroup mount access')
  const uid = oneOf(p.uid, [0, jobUid])
  // PSI watch files grant stall notifications, not process or resource control.
  // Only this exact regular file may be job-owned, behind a read-only mount.
  if (uid === jobUid && !options.includes('ro'))
    throw new Error('job-owned PSI observation requires a read-only mount')
  const mode = positiveInteger(p.mode)
  if (mode > 0o777 || (mode & 0o022) !== 0)
    throw new Error('unsafe PSI observation mode')
  return {
    name: oneOf(p.name, ['memory.pressure'] as const),
    fileType: oneOf(p.fileType, ['regular'] as const),
    uid,
    gid: nonnegativeInteger(p.gid),
    mode,
    jobWritable: oneOf(p.jobWritable, [false] as const),
    mount: {
      point: oneOf(mount.point, ['/sys/fs/cgroup'] as const),
      root: oneOf(mount.root, ['/'] as const),
      type: oneOf(mount.type, ['cgroup2'] as const),
      source: string(mount.source, /./),
      options,
      superOptions: list(mount.superOptions, (value) =>
        string(value, /^[a-zA-Z0-9_=.-]+$/),
      ),
    },
  }
}
function nonnegativeInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new Error('expected nonnegative integer')
  return value
}
function privilegedStatus(value: unknown) {
  const keys = [
    'NoNewPrivs',
    'Seccomp',
    'CapInh',
    'CapPrm',
    'CapEff',
    'CapBnd',
    'CapAmb',
  ]
  const s = object(value, keys)
  return Object.fromEntries(
    keys.map((key) => [
      key,
      oneOf(s[key], [
        key === 'NoNewPrivs'
          ? '1'
          : key === 'Seccomp'
            ? '2'
            : '0000000000000000',
      ]),
    ]),
  )
}
function parseProcessBoundary(value: unknown) {
  const b = object(value, [
    'policy',
    'namespace',
    'cgroup',
    'pid1',
    'controller',
  ])
  const policy = object(b.policy, Object.keys(MOTOR_PROCESS_POLICY))
  for (const [key, expected] of Object.entries(MOTOR_PROCESS_POLICY))
    if (policy[key] !== expected)
      throw new Error('unqualified supervisor policy')
  const namespace = object(b.namespace, ['self', 'pid1'])
  const self = string(namespace.self, /^pid:\[\d+\]$/)
  if (self !== namespace.pid1)
    throw new Error('PID namespace differs from PID1')
  const c = object(b.cgroup, [
    'self',
    'pid1',
    'directory',
    'parents',
    'controls',
    'pressureObservation',
  ])
  const cgroup = string(
    c.self,
    /^\/system\.slice\/motor-job-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.service$/,
  )
  if (cgroup !== c.pid1) throw new Error('cgroup differs from PID1')
  // One job user owns both PID 1 and the controller; it is never root.
  const controller = object(b.controller, ['uid', 'kernel'])
  const jobUid = positiveInteger(controller.uid)
  const controls = record(c.controls)
  if ('memory.pressure' in controls)
    throw new Error('PSI observation must have its own named role')
  for (const key of [
    'cgroup.procs',
    'cgroup.threads',
    'cgroup.kill',
    'cgroup.events',
    'cgroup.subtree_control',
    'memory.max',
    'pids.max',
  ])
    if (!(key in controls)) throw new Error('missing protected cgroup control')
  const checkedControls = Object.fromEntries(
    Object.entries(controls).map(([key, value]) => [
      string(key, /^[a-z][a-z0-9_.]+$/),
      protection(value),
    ]),
  )
  const p = object(b.pid1, [
    'uid',
    'kernel',
    'comm',
    'argvPrefix',
    'executable',
    'canonicalExecutable',
    'executableSha256',
    'digestProvenance',
    'protection',
    'parents',
  ])
  const argvPrefix = list(p.argvPrefix, (value) => string(value))
  if (JSON.stringify(argvPrefix) !== '["/bin/bash","-c"]')
    throw new Error('unqualified PID1 wrapper argv')
  const canonicalExecutable = oneOf(p.canonicalExecutable, [
    '/bin/bash',
    '/usr/bin/bash',
  ] as const)
  const parents = (value: unknown, paths: string[]) =>
    Object.fromEntries(
      Object.entries(object(value, paths)).map(([path, value]) => [
        path,
        protection(value),
      ]),
    )
  return {
    policy: { ...MOTOR_PROCESS_POLICY },
    namespace: { self, pid1: self },
    cgroup: {
      self: cgroup,
      pid1: cgroup,
      directory: protection(c.directory),
      parents: parents(c.parents, [
        '/sys/fs/cgroup',
        '/sys/fs/cgroup/system.slice',
      ]),
      controls: checkedControls,
      pressureObservation: pressureObservation(c.pressureObservation, jobUid),
    },
    pid1: {
      uid: oneOf(p.uid, [jobUid]),
      kernel: privilegedStatus(p.kernel),
      comm: oneOf(p.comm, ['bash'] as const),
      argvPrefix,
      executable: oneOf(p.executable, ['/bin/bash'] as const),
      canonicalExecutable,
      executableSha256: digest(p.executableSha256),
      digestProvenance: oneOf(p.digestProvenance, [
        'observed, not an approved artifact pin',
      ] as const),
      protection: protection(p.protection),
      parents: parents(
        p.parents,
        canonicalExecutable === '/bin/bash'
          ? ['/', '/bin']
          : ['/', '/usr', '/usr/bin'],
      ),
    },
    controller: {
      uid: jobUid,
      kernel: privilegedStatus(controller.kernel),
    },
  }
}

function assertNativeJob(value: unknown) {
  const n = object(value, [
    'root',
    'executable',
    'runtime',
    'runner',
    'boundary',
    'processBoundary',
    'cleanup',
  ])
  const root = absoluteRoot(n.root)
  const e = object(n.executable, [
    'path',
    'sha256',
    'bytes',
    'elfMachine',
    'reportedVersion',
  ])
  const r = object(n.runner, [
    'path',
    'sha256',
    'bytes',
    'elfMachine',
    'version',
    'revision',
    'device',
    'inode',
  ])
  const boundary = object(n.boundary, [
    'architecture',
    'interfaces',
    'namespace',
    'status',
    'controls',
  ])
  object(boundary.status, [
    'NoNewPrivs',
    'Seccomp',
    'CapInh',
    'CapPrm',
    'CapEff',
    'CapBnd',
    'CapAmb',
  ])
  list(boundary.controls, (value) => {
    const control = record(value)
    const name = oneOf(control.control, [
      'external_tcp',
      'external_udp',
      'external_dns',
      'loopback_tcp',
      'unix_round_trip',
      'child_inheritance',
      'namespace_escape',
    ] as const)
    const keys =
      name === 'external_tcp' || name === 'external_udp'
        ? ['family', 'errno']
        : name === 'external_dns'
          ? ['errno']
          : name === 'loopback_tcp'
            ? ['family', 'roundTrip']
            : name === 'unix_round_trip'
              ? ['roundTrip']
              : name === 'child_inheritance'
                ? ['namespace', 'errno']
                : ['exit', 'stderr']
    return object(control, ['control', ...keys])
  })
  nativeJobFixture().assertNativeBoundary(boundary)
  if (e.path !== nativeLayout(root).binary)
    throw new Error('native executable path differs from owned layout')
  const runnerRuntime = runtime({
    name: 'Bun',
    version: r.version,
    revision: r.revision,
  })
  return {
    root,
    executable: {
      path: string(e.path),
      sha256: digest(e.sha256),
      bytes: positiveInteger(e.bytes),
      elfMachine: oneOf(e.elfMachine, [62] as const),
      reportedVersion: oneOf(e.reportedVersion, ['opencode v2.0.22'] as const),
    },
    runtime: runtime(n.runtime),
    runner: {
      path: absoluteRoot(r.path),
      sha256: digest(r.sha256),
      bytes: positiveInteger(r.bytes),
      elfMachine: oneOf(r.elfMachine, [62] as const),
      version: runnerRuntime.version,
      revision: runnerRuntime.revision,
      device: string(r.device, /^\d+$/),
      inode: string(r.inode, /^[1-9]\d*$/),
    },
    boundary,
    processBoundary: parseProcessBoundary(n.processBoundary),
    cleanup: list(n.cleanup, (value) => {
      const c = object(value, ['id', 'outcome', 'signaled'])
      return {
        id: string(c.id),
        outcome: oneOf(c.outcome, ['clean', 'failed'] as const),
        signaled: nonnegativeInteger(c.signaled),
      }
    }),
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
    'profile',
    'full',
    'binarySha256',
    'native',
    'sources',
    'rows',
  ])
  const profile = oneOf(m.profile, ['docker', 'native-job'] as const)
  const s = object(m.sources, [
    'ga-measure-plugin.ts',
    'ga-loopback-request-contract.ts',
    'measure-ga-proxy-matrix.ts',
    'ga-binary-pin.json',
    ...(profile === 'native-job' ? NATIVE_SOURCES : []),
  ])
  const rows = list(m.rows, parseRow)
  if (!rows.length) throw new Error('zero rows')
  const common = {
    schema: oneOf(m.schema, [1] as const),
    full: oneOf(m.full, [true, false] as const),
    binarySha256: digest(m.binarySha256),
    sources: {
      'ga-measure-plugin.ts': digest(s['ga-measure-plugin.ts']),
      'ga-loopback-request-contract.ts': digest(
        s['ga-loopback-request-contract.ts'],
      ),
      'measure-ga-proxy-matrix.ts': digest(s['measure-ga-proxy-matrix.ts']),
      'ga-binary-pin.json': digest(s['ga-binary-pin.json']),
      ...(profile === 'native-job'
        ? Object.fromEntries(NATIVE_SOURCES.map((key) => [key, digest(s[key])]))
        : {}),
    },
    rows,
  }
  return profile === 'docker'
    ? { ...common, profile, native: assertNative(m.native) }
    : { ...common, profile, native: assertNativeJob(m.native) }
}
export const MatrixSchema = { parse: parseMatrix }
export type Matrix = ReturnType<typeof parseMatrix>
export function sourceDigests(
  profile: 'docker' | 'native-job' = 'docker',
): Record<string, string> &
  Record<
    | 'ga-measure-plugin.ts'
    | 'ga-loopback-request-contract.ts'
    | 'measure-ga-proxy-matrix.ts'
    | 'ga-binary-pin.json',
    string
  > {
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
    ...(profile === 'native-job'
      ? Object.fromEntries(
          NATIVE_SOURCES.map((path) => [
            path,
            sha256(readFileSync(join(HERE, path))),
          ]),
        )
      : {}),
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
  if (
    matrix.profile === 'native-job' &&
    (matrix.native.executable.sha256 !== pin.binarySha256 ||
      matrix.native.executable.bytes !== pin.binaryBytes)
  )
    throw new Error('native executable identity differs from pin')
  if (
    JSON.stringify(matrix.sources) !==
    JSON.stringify(sourceDigests(matrix.profile))
  )
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
      row.pluginPath !==
        (matrix.profile === 'docker'
          ? '/input/ga-measure-plugin.ts'
          : nativeLayout(matrix.native.root).plugin) ||
      JSON.stringify(row.command) !==
        JSON.stringify(
          matrix.profile === 'docker'
            ? commandForCase(spec.id)
            : [
                nativeLayout(matrix.native.root).binary,
                ...commandForCase(spec.id).slice(1),
              ],
        )
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
  if (matrix.profile === 'native-job') {
    const expected = [
      'boundary-probe',
      'version',
      ...matrix.rows.flatMap((row) =>
        row.outcome === 'excluded' ? [] : [`git:${row.id}`, row.id],
      ),
    ]
    if (
      JSON.stringify(matrix.native.cleanup.map((entry) => entry.id)) !==
        JSON.stringify(expected) ||
      matrix.native.cleanup.some(
        (entry) => entry.outcome !== 'clean' || entry.signaled !== 0,
      )
    )
      throw new Error(
        'missing/duplicate/failed native command cleanup evidence',
      )
  }
  return matrix
}

export function normalizedMatrix(matrix: Matrix) {
  return {
    ...matrix,
    // assertConformance validates both raw matrices before comparing them. Mask
    // only job-specific roots, network/PID namespaces, cgroup IDs and runner
    // device/inode here. Raw evidence, executable content/runtime comparisons
    // and descriptor/path checks before each command are unchanged.
    ...(matrix.profile === 'native-job'
      ? {
          native: {
            ...matrix.native,
            root: '<owned-root>',
            runner: {
              ...matrix.native.runner,
              device: '<runner-device>',
              inode: '<runner-inode>',
            },
            executable: {
              ...matrix.native.executable,
              path: '<owned-root>/inputs/ga-verified-opencode',
            },
            boundary: {
              ...matrix.native.boundary,
              namespace: '<network-namespace>',
              controls: list(matrix.native.boundary.controls, (value) => {
                const control = record(value)
                return control.control === 'child_inheritance'
                  ? { ...control, namespace: '<network-namespace>' }
                  : control
              }),
            },
            processBoundary: {
              ...matrix.native.processBoundary,
              namespace: {
                self: '<private-pid-namespace>',
                pid1: '<private-pid-namespace>',
              },
              cgroup: {
                ...matrix.native.processBoundary.cgroup,
                self: '/system.slice/motor-job-<launch-uuid>.service',
                pid1: '/system.slice/motor-job-<launch-uuid>.service',
              },
            },
          },
        }
      : {}),
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
    '--profile',
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
  const profile = oneOf(values.get('--profile') ?? 'docker', [
    'docker',
    'native-job',
  ] as const)
  if (profile === 'native-job') {
    if (inside || image || !tarball)
      throw new Error('native-job requires --tarball and forbids Docker flags')
    absoluteRoot(out)
    absoluteRoot(tarball)
    if (values.has('--compare')) absoluteRoot(values.get('--compare'))
  } else {
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
  }
  return {
    profile,
    out: resolve(out),
    image,
    tarball: tarball && resolve(tarball),
    cases,
    inside,
    compare: values.get('--compare'),
  }
}

export function assertNativeJobAdmission(
  options: ReturnType<typeof parseArgs>,
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
  architecture: string = process.arch,
): void {
  if (
    options.profile !== 'native-job' ||
    env.ANTIGRAVITY_GA_HOST_EXECUTION !== '1'
  )
    throw new Error(
      'native-job requires explicit ANTIGRAVITY_GA_HOST_EXECUTION=1',
    )
  if ('NODE_TLS_REJECT_UNAUTHORIZED' in env)
    throw new Error('TLS bypass variable refuses launch')
  if (platform !== 'linux' || architecture !== 'x64')
    throw new Error('native-job requires Linux x64')
  absoluteRoot(options.out)
  const parent = dirname(options.out)
  const stat = lstatSync(parent)
  if (
    realpathSync(parent) !== parent ||
    !stat.isDirectory() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o022) !== 0 ||
    existsSync(options.out)
  )
    throw new Error(
      'native output requires a fresh root under an owned non-writable canonical parent',
    )
  if (
    !options.tarball ||
    !lstatSync(options.tarball).isFile() ||
    realpathSync(options.tarball) !== options.tarball
  )
    throw new Error('native tarball requires a canonical regular input file')
}

export function nativeHostEnv(
  root: string,
  variables: Record<string, string>,
): Record<string, string> {
  for (const key of Object.keys(variables))
    oneOf(key, [
      ...PROXY_VARIABLES,
      'NO_PROXY',
      'no_proxy',
      'GA_MEASURE_LOG',
      'GA_MOCK_PORT',
    ])
  return {
    ...isolatedEnv(root, variables),
    PATH: '/usr/bin:/bin',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: join(root, 'git-hooks'),
    GIT_CONFIG_KEY_1: 'init.templateDir',
    GIT_CONFIG_VALUE_1: join(root, 'git-template'),
    GIT_TEMPLATE_DIR: join(root, 'git-template'),
  }
}

export async function prepareNativeGit(
  root: string,
  scope = qualifyNativeProcessScope(),
): Promise<NativeCommandResult> {
  recheckNativeScope(scope)
  const template = join(root, 'git-template')
  const hooks = join(root, 'git-hooks')
  mkdirSync(template, { mode: 0o700 })
  mkdirSync(hooks, { mode: 0o700 })
  const binary = '/usr/bin/git'
  const args = [
    '-c',
    `core.hooksPath=${hooks}`,
    '-c',
    `init.templateDir=${template}`,
    '-C',
    join(root, 'project'),
    'init',
    `--template=${template}`,
  ]
  const env = nativeHostEnv(root, {})
  jsonFile(join(root, 'git.command.json'), { binary, args, cwd: root, env })
  const result = await runNativeCommand(scope, binary, args, {
    cwd: root,
    env,
    timeoutMs: 15_000,
  })
  writeFileSync(join(root, 'git.stdout.log'), result.stdout ?? '', {
    flag: 'wx',
  })
  writeFileSync(join(root, 'git.stderr.log'), result.stderr ?? '', {
    flag: 'wx',
  })
  jsonFile(join(root, 'git.exit.json'), result)
  if (
    result.spawnError ||
    result.signal ||
    result.code !== 0 ||
    result.timedOut ||
    result.outputCapExceeded ||
    result.cleanup.outcome !== 'clean' ||
    result.cleanup.signaled !== 0 ||
    !result.stdout.trim()
  )
    throw new Error(
      `native Git preparation failed: ${result.spawnError ?? result.stderr}; cleanup=${result.cleanup.outcome}`,
    )
  return result
}

export function snapshotNativeComparison(
  options: ReturnType<typeof parseArgs>,
  pin: Pin,
) {
  const path = options.compare
  if (!path) return undefined
  if (options.profile !== 'native-job')
    throw new Error('native comparison requires native-job profile')
  absoluteRoot(path)
  const out = absoluteRoot(options.out)
  if (path === out || path.startsWith(`${out}/`))
    throw new Error('native comparison input must be outside fresh output tree')
  const before = lstatSync(path, { bigint: true })
  if (!before.isFile() || realpathSync(path) !== path)
    throw new Error(
      'native comparison requires a canonical regular non-symlink input',
    )
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  )
  let bytes: Buffer
  try {
    const opened = fstatSync(descriptor, { bigint: true })
    const current = lstatSync(path, { bigint: true })
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      current.dev !== opened.dev ||
      current.ino !== opened.ino ||
      realpathSync(path) !== path
    )
      throw new Error('native comparison input changed during open')
    bytes = readFileSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
  const retained = validateMatrix(JSON.parse(bytes.toString('utf8')), pin)
  if (retained.profile !== 'native-job' || !retained.full)
    throw new Error('native comparison requires a full native-job matrix')
  return {
    path,
    sha256: sha256(bytes),
    compare(fresh: unknown) {
      assertConformance(fresh, retained, pin)
    },
  }
}

export interface NativeProcessIdentity {
  pid: number
  start: string
  state: string
  uid: number
  namespace: string
  cgroup: string
  comm: string
  parent: number
  pgid: number
  sid: number
}
export interface NativeProcessScope {
  summary: ReturnType<typeof parseProcessBoundary>
}
interface NativeScopeBinding {
  summary: string
  controller: NativeProcessIdentity
  pid1: NativeProcessIdentity
  directoryIdentity: string
  executableIdentity: string
  pressureIdentity: string
}
const nativeScopes = new WeakMap<NativeProcessScope, NativeScopeBinding>()

interface NativeCleanupBudget {
  readonly deadline: number
}
function checkCleanupBudget(budget?: NativeCleanupBudget): void {
  if (budget && performance.now() >= budget.deadline)
    throw new Error('native cleanup budget exhausted')
}
function withinCleanupBudget<T>(
  budget: NativeCleanupBudget | undefined,
  operation: () => T,
): T {
  checkCleanupBudget(budget)
  const value = operation()
  checkCleanupBudget(budget)
  return value
}

function processCgroup(
  pid: number | 'self',
  budget?: NativeCleanupBudget,
): string {
  const text = withinCleanupBudget(budget, () =>
    readFileSync(`/proc/${pid}/cgroup`, 'utf8'),
  )
  const match = /^0::([^\n]+)\n$/.exec(text)
  if (!match?.[1]) throw new Error('not a unified protected cgroup membership')
  return match[1]
}
class NativeIdentityUnavailable extends Error {
  constructor(
    readonly pid: number,
    error: unknown,
  ) {
    super(`UNKNOWN partial identity for thread group ${pid}: ${String(error)}`)
  }
}
function nativeProcess(
  pid: number,
  budget?: NativeCleanupBudget,
): NativeProcessIdentity | undefined {
  try {
    const text = withinCleanupBudget(budget, () =>
      readFileSync(`/proc/${pid}/stat`, 'utf8'),
    )
    const fields = text.slice(text.lastIndexOf(')') + 2).split(' ')
    const start = string(fields[19], /^\d+$/)
    const status = nativeJobFixture().parseKernelStatus(
      withinCleanupBudget(budget, () =>
        readFileSync(`/proc/${pid}/status`, 'utf8'),
      ),
    )
    const uids = (status.Uid ?? '').split(/\s+/).map(Number)
    if (uids.length !== 4 || new Set(uids).size !== 1)
      throw new Error('process has mixed user identities')
    return {
      pid,
      start,
      state: string(fields[0], /^[A-Z]$/),
      uid: nonnegativeInteger(uids[0]),
      namespace: withinCleanupBudget(budget, () =>
        readlinkSync(`/proc/${pid}/ns/pid`),
      ),
      cgroup: processCgroup(pid, budget),
      comm: text.slice(text.indexOf('(') + 1, text.lastIndexOf(')')),
      parent: nonnegativeInteger(Number(fields[1])),
      pgid: nonnegativeInteger(Number(fields[2])),
      sid: nonnegativeInteger(Number(fields[3])),
    }
  } catch (error) {
    if (
      ['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')
    )
      throw new NativeIdentityUnavailable(pid, error)
    throw error
  }
}

function cgroupThreadMembers(
  summary: ReturnType<typeof parseProcessBoundary>,
  budget?: NativeCleanupBudget,
): number[] {
  const members = withinCleanupBudget(budget, () =>
    readFileSync(`/sys/fs/cgroup${summary.cgroup.self}/cgroup.threads`, 'utf8'),
  )
    .split(/\s+/)
    .filter(Boolean)
    .map((value) => {
      checkCleanupBudget(budget)
      return positiveInteger(Number(value))
    })
  if (new Set(members).size !== members.length)
    throw new Error('UNKNOWN ambiguous cgroup task inventory')
  return members
}
export interface NativeTaskDiagnostic {
  runnerPid: number
  actorPids: () => number[]
  emit: (line: string) => void
}
let nativeTaskDiagnostic: NativeTaskDiagnostic | undefined

// Tests can log task-list changes, but logging must not permit a command to start
// or decide which processes command cleanup may signal.
export function enableNativeTaskDiagnostic(
  diagnostic: NativeTaskDiagnostic,
): () => void {
  const previous = nativeTaskDiagnostic
  nativeTaskDiagnostic = diagnostic
  return () => {
    nativeTaskDiagnostic = previous
  }
}

interface NativeTaskFact {
  tid: number
  tgid: number | null
  start: string | null
  state: string | null
}
function emitNativeTaskDifference(
  before: number[],
  after: number[],
  first: Map<number, NativeTaskFact>,
): void {
  const diagnostic = nativeTaskDiagnostic
  if (!diagnostic) return
  try {
    const facts = [...new Set([...before, ...after])].map((tid) => {
      let fact = first.get(tid)
      if (!fact) {
        fact = { tid, tgid: null, start: null, state: null }
        // Capture newly appearing TIDs as soon as the second inventory exposes them.
        // Missing fields stay explicit; later scans cannot reconstruct a vanished TID.
        try {
          const status = nativeJobFixture().parseKernelStatus(
            readFileSync(`/proc/${tid}/status`, 'utf8'),
          )
          fact.tgid = positiveInteger(Number(status.Tgid))
        } catch {
          /* Diagnostic observation is best-effort, never a new refusal. */
        }
        try {
          const stat = readFileSync(`/proc/${tid}/stat`, 'utf8')
          const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
          fact.start = fields[19] ?? null
          fact.state = fields[0] ?? null
        } catch {
          /* Diagnostic observation is best-effort, never a new refusal. */
        }
        first.set(tid, fact)
      }
      return fact
    })
    let actors = new Set<number>()
    try {
      actors = new Set(diagnostic.actorPids())
    } catch {
      // If known test-process IDs cannot be read, still log both task lists and
      // identify only the runner; other thread groups remain unknown.
    }
    const tasks = facts.map((fact) => ({
      ...fact,
      group:
        fact.tgid === diagnostic.runnerPid
          ? 'runner'
          : fact.tgid !== null && actors.has(fact.tgid)
            ? 'actor'
            : 'unknown',
    }))
    diagnostic.emit(
      `NATIVE_ADMISSION_TASK_DIFFERENCE=${JSON.stringify({ before, after, tasks })}`,
    )
  } catch {
    /* A diagnostic sink must not replace the original admission refusal. */
  }
}

function observedNativeTasks(
  summary: ReturnType<typeof parseProcessBoundary>,
  budget?: NativeCleanupBudget,
): { tid: number; tgid: number; state: string }[] {
  let members = cgroupThreadMembers(summary, budget)
  const first = new Map<number, NativeTaskFact>()
  let admissionGroups: Map<number, string> | undefined
  let admissionMembers: number[] = []
  for (;;) {
    checkCleanupBudget(budget)
    const observations: { tid: number; tgid: number; state: string }[] = []
    const missing: number[] = []
    for (const tid of members) {
      checkCleanupBudget(budget)
      try {
        // Direct TID entries survive main-thread exit. They only discover groups;
        // signaling still requires a separately revalidated full TGID identity.
        const status = nativeJobFixture().parseKernelStatus(
          withinCleanupBudget(budget, () =>
            readFileSync(`/proc/${tid}/status`, 'utf8'),
          ),
        )
        if (positiveInteger(Number(status.Pid)) !== tid)
          throw new Error('UNKNOWN cgroup task identity changed')
        const tgid = positiveInteger(Number(status.Tgid))
        const fact: NativeTaskFact = { tid, tgid, start: null, state: null }
        if (nativeTaskDiagnostic && !first.has(tid)) first.set(tid, fact)
        const stat = withinCleanupBudget(budget, () =>
          readFileSync(`/proc/${tid}/stat`, 'utf8'),
        )
        const state = string(
          stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0],
          /^[A-Z]$/,
        )
        fact.state = state
        fact.start =
          stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null
        observations.push({ tid, tgid, state })
      } catch (error) {
        if (
          ['ENOENT', 'ESRCH'].includes(
            (error as NodeJS.ErrnoException).code ?? '',
          )
        ) {
          missing.push(tid)
          continue
        }
        throw new Error(
          `UNKNOWN extant or unqualifiable cgroup task ${tid}: ${String(error)}`,
        )
      }
    }
    if (!budget && missing.length === 0) {
      const groups = new Map<number, string>()
      for (const { tgid } of observations) {
        if (groups.has(tgid)) continue
        let identity: NativeProcessIdentity | undefined
        try {
          identity = nativeProcess(tgid)
        } catch (error) {
          if (!(error instanceof NativeIdentityUnavailable)) throw error
          throw new Error(
            `UNKNOWN extant thread group ${tgid} has a dead or unqualifiable leader: ${String(error)}`,
          )
        }
        if (
          !identity ||
          identity.namespace !== summary.namespace.self ||
          identity.cgroup !== summary.cgroup.self
        )
          throw new Error('UNKNOWN foreign thread group identity')
        groups.set(tgid, identity.start)
      }
      if (admissionGroups) {
        const inspectedGroups = admissionGroups
        // Threads may come and go inside an inspected process. A new group,
        // departed group or reused leader must still refuse admission.
        const changed =
          [...inspectedGroups].some(
            ([tgid, start]) => groups.get(tgid) !== start,
          ) || [...groups.keys()].some((tgid) => !inspectedGroups.has(tgid))
        if (changed) {
          emitNativeTaskDifference(admissionMembers, members, first)
          throw new Error(
            'UNKNOWN cgroup task inventory changed during admission',
          )
        }
        return observations
      }
      admissionGroups = groups
    }
    if (!budget && admissionGroups && missing.length > 0) {
      emitNativeTaskDifference(admissionMembers, members, first)
      throw new Error('UNKNOWN listed cgroup task has unavailable identity')
    }
    const next = cgroupThreadMembers(summary, budget)
    if (missing.some((tid) => next.includes(tid)))
      throw new Error('UNKNOWN listed cgroup task has unavailable identity')
    if (
      budget &&
      next.length === members.length &&
      next.every((tid) => members.includes(tid))
    ) {
      checkCleanupBudget(budget)
      return observations
    }
    if (!budget) {
      if (missing.length > 0) {
        emitNativeTaskDifference(members, next, first)
        throw new Error(
          'UNKNOWN cgroup task inventory changed during admission',
        )
      }
      // Admission takes exactly two snapshots, including every newly listed TID.
      // Cleanup instead retries replacements within its original budget.
      admissionMembers = members
    }
    members = next
  }
}
export function threadGroupHasLiveTasks(
  pid: number,
  summary: ReturnType<typeof parseProcessBoundary>,
  budget?: NativeCleanupBudget,
): boolean {
  return observedNativeTasks(summary, budget).some(
    (task) => task.tgid === pid && !['Z', 'X'].includes(task.state),
  )
}
function resolvedNativeProcess(
  pid: number,
  summary: ReturnType<typeof parseProcessBoundary>,
  budget?: NativeCleanupBudget,
): NativeProcessIdentity | undefined {
  let identity: NativeProcessIdentity | undefined
  let unavailable: unknown
  try {
    identity = nativeProcess(pid, budget)
  } catch (error) {
    if (!(error instanceof NativeIdentityUnavailable)) throw error
    unavailable = error
  }
  if (
    identity &&
    (identity.namespace !== summary.namespace.self ||
      identity.cgroup !== summary.cgroup.self)
  )
    throw new Error('UNKNOWN foreign thread group identity')
  if (identity && !['Z', 'X'].includes(identity.state)) return identity
  if (threadGroupHasLiveTasks(pid, summary, budget))
    throw new Error(
      `UNKNOWN extant thread group ${pid} has a dead or unqualifiable leader${unavailable ? `: ${String(unavailable)}` : ''}`,
    )
  try {
    const stat = withinCleanupBudget(budget, () =>
      readFileSync(`/proc/${pid}/stat`, 'utf8'),
    )
    const state = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]
    if (!['Z', 'X'].includes(state ?? ''))
      throw new Error(
        `UNKNOWN extant thread group ${pid} has incomplete identity`,
      )
  } catch (error) {
    if (
      !['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')
    )
      throw error
  }
  return undefined
}
function observedMetadata(
  path: string,
  kind: 'file' | 'directory',
  budget?: NativeCleanupBudget,
) {
  const stat = withinCleanupBudget(budget, () => lstatSync(path))
  if (kind === 'file' ? !stat.isFile() : !stat.isDirectory())
    throw new Error(`unprotected ${kind}: ${path}`)
  let jobWritable = true
  try {
    withinCleanupBudget(budget, () => accessSync(path, constants.W_OK))
  } catch (error) {
    if (
      !['EACCES', 'EROFS'].includes((error as NodeJS.ErrnoException).code ?? '')
    )
      throw error
    jobWritable = false
  }
  return { uid: stat.uid, gid: stat.gid, mode: stat.mode & 0o7777, jobWritable }
}
function observedProtection(
  path: string,
  kind: 'file' | 'directory',
  budget?: NativeCleanupBudget,
) {
  try {
    return protection(observedMetadata(path, kind, budget))
  } catch (error) {
    throw new Error(`unprotected ${kind} ${path}: ${String(error)}`)
  }
}
function cgroupMount(path: string, budget?: NativeCleanupBudget) {
  const lines = withinCleanupBudget(budget, () =>
    readFileSync('/proc/self/mountinfo', 'utf8'),
  )
    .trim()
    .split('\n')
  const decode = (value: unknown) =>
    string(value).replace(/\\([0-7]{3})/g, (_, octal: string) =>
      String.fromCharCode(Number.parseInt(octal, 8)),
    )
  // Read-only access to /sys/fs/cgroup does not prove that a separately mounted
  // pressure file is read-only. Use the most specific mount containing the file.
  const applicable = lines
    .map((line) => line.split(' - '))
    .filter((parts) => {
      checkCleanupBudget(budget)
      const point = decode(parts[0]?.split(' ')[4])
      return point === '/' || path === point || path.startsWith(`${point}/`)
    })
  const longest = Math.max(
    ...applicable.map((parts) => {
      checkCleanupBudget(budget)
      return decode(parts[0]?.split(' ')[4]).length
    }),
  )
  const matches = applicable.filter((parts) => {
    checkCleanupBudget(budget)
    return decode(parts[0]?.split(' ')[4]).length === longest
  })
  const entry = matches[0]
  if (matches.length !== 1 || !entry) throw new Error('ambiguous cgroup mount')
  const left = entry[0]?.split(' ') ?? []
  const right = entry[1]?.split(' ') ?? []
  return {
    point: decode(left[4]),
    root: decode(left[3]),
    type: right[0],
    source: right[1],
    options: left[5]?.split(','),
    superOptions: right[2]?.split(','),
  }
}
// The initial (host) PID namespace always has this inode number
// (PROC_PID_INIT_INO in the Linux kernel). A process that reports it shares the
// host's process table, whatever PID 1 happens to be called.
const HOST_PID_NAMESPACE = 'pid:[4026531836]'
// MOTOR runner unit name, documented in MOTOR docs/job-isolation.md section
// 4.4.2 (cortexkit/motor, main e49541a7): each job runs in its own
// motor-job-<UUID>.service directly under system.slice. The UUID names the
// runner's unit, not the job id a caller sees, so only its shape is checked.
const MOTOR_JOB_CGROUP =
  /^\/system\.slice\/motor-job-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.service$/

// Raw facts about where this process runs. Each is undefined when it could not
// be read; an unreadable fact refuses, it is never assumed.
export interface NativePlacementFacts {
  platform: string
  arch: string
  uid: number | undefined
  euid: number | undefined
  pidNamespace: string | undefined
  pid1Namespace: string | undefined
  pid1Comm: string | undefined
  // Full contents of /proc/self/cgroup.
  cgroup: string | undefined
  cgroupDirectoryUid: number | undefined
}
export interface NativePlacement {
  jobUid: number
  cgroup: string
}
function placementRefusal(fact: string): never {
  throw new Error(
    `native cleanup requires the unprivileged Linux x64 MOTOR job (${fact})`,
  )
}
// The job must have its own PID namespace whose PID 1 is the MOTOR job wrapper.
// Sharing PID 1 with this process is not enough on its own: on an ordinary host
// both report the host namespace, so the host inode and a host init refuse too.
function privatePidNamespaceRefusal(
  facts: NativePlacementFacts,
): string | undefined {
  if (facts.pid1Namespace === undefined || facts.pid1Comm === undefined)
    return '/proc/1 unreadable'
  if (facts.pidNamespace === undefined) return 'own PID namespace unreadable'
  if (facts.pidNamespace !== facts.pid1Namespace)
    return 'PID namespace differs from PID1'
  if (facts.pidNamespace === HOST_PID_NAMESPACE) return 'host PID namespace'
  if (facts.pid1Comm !== 'bash')
    return `PID 1 is ${facts.pid1Comm}, not the job wrapper`
  return undefined
}
function motorJobCgroupRefusal(cgroup: string | undefined): string | undefined {
  if (cgroup === undefined) return 'cgroup unreadable'
  const unit = /^0::([^\n]+)\n$/.exec(cgroup)?.[1]
  if (!unit) return 'not a single unified cgroup membership'
  if (!MOTOR_JOB_CGROUP.test(unit))
    return `cgroup ${unit} is not a MOTOR job unit`
  return undefined
}
// Qualification rests on properties, not on a particular uid: an unprivileged
// user, a private PID namespace whose PID 1 is the job wrapper, and a
// root-owned MOTOR job cgroup. An ordinary unprivileged host user fails the
// namespace and cgroup requirements whatever its uid is.
export function qualifyNativePlacement(
  facts: NativePlacementFacts,
): NativePlacement {
  if (facts.platform !== 'linux') placementRefusal(`platform ${facts.platform}`)
  if (facts.arch !== 'x64') placementRefusal(`arch ${facts.arch}`)
  const uid = facts.uid
  if (uid === undefined || !Number.isSafeInteger(uid) || uid < 0)
    placementRefusal('uid unreadable')
  if (uid === 0) placementRefusal('uid 0')
  if (facts.euid !== uid)
    placementRefusal(`euid ${facts.euid} differs from uid ${uid}`)
  const namespace = privatePidNamespaceRefusal(facts)
  if (namespace) placementRefusal(namespace)
  const cgroup = motorJobCgroupRefusal(facts.cgroup)
  if (cgroup) placementRefusal(cgroup)
  // MOTOR does not delegate the unit, so its directory is always root-owned.
  if (facts.cgroupDirectoryUid !== 0)
    placementRefusal(
      facts.cgroupDirectoryUid === undefined
        ? 'cgroup directory unreadable'
        : `cgroup directory owner ${facts.cgroupDirectoryUid}`,
    )
  return {
    jobUid: uid,
    cgroup: (facts.cgroup ?? '').slice('0::'.length, -1),
  }
}
function observedPlacement(budget?: NativeCleanupBudget): NativePlacement {
  const fact = <T>(operation: () => T): T | undefined => {
    checkCleanupBudget(budget)
    let value: T | undefined
    try {
      value = operation()
    } catch {
      value = undefined
    }
    checkCleanupBudget(budget)
    return value
  }
  const cgroup = fact(() => readFileSync('/proc/self/cgroup', 'utf8'))
  const facts: NativePlacementFacts = {
    platform: process.platform,
    arch: process.arch,
    uid: fact(() => process.getuid?.()),
    euid: fact(() => process.geteuid?.()),
    pidNamespace: fact(() => readlinkSync('/proc/self/ns/pid')),
    pid1Namespace: fact(() => readlinkSync('/proc/1/ns/pid')),
    pid1Comm: fact(() => readFileSync('/proc/1/comm', 'utf8').trim()),
    cgroup,
    // Only a MOTOR-shaped unit path is ever stat'ed.
    cgroupDirectoryUid: motorJobCgroupRefusal(cgroup)
      ? undefined
      : fact(
          () => lstatSync(`/sys/fs/cgroup${(cgroup ?? '').slice(3, -1)}`).uid,
        ),
  }
  return qualifyNativePlacement(facts)
}
// PID 1 and this controller must both run as the one job user. Any other owner,
// a non-wrapper PID 1, or a controller that is PID 1 itself refuses.
export function qualifyNativeJobIdentities(
  jobUid: number,
  controller: NativeProcessIdentity | undefined,
  pid1: NativeProcessIdentity | undefined,
  currentPid: number,
): { controller: NativeProcessIdentity; pid1: NativeProcessIdentity } {
  if (
    !controller ||
    !pid1 ||
    !Number.isSafeInteger(jobUid) ||
    jobUid < 1 ||
    pid1.uid !== jobUid ||
    controller.uid !== jobUid ||
    pid1.comm !== 'bash' ||
    controller.pid === 1
  )
    throw new Error(
      `missing protected PID1/controller identities: ${JSON.stringify({ controller, pid1, currentPid, jobUid })}`,
    )
  return { controller, pid1 }
}
// Cleanup may signal only processes owned by the qualified job user. A uid-0 or
// foreign-user process is never this job's to kill.
export function nativeSignalOwned(uid: number, jobUid: number): boolean {
  return uid !== 0 && uid === jobUid
}
function observedProcessBoundary(budget?: NativeCleanupBudget) {
  checkCleanupBudget(budget)
  const placement = observedPlacement(budget)
  const { controller, pid1 } = qualifyNativeJobIdentities(
    placement.jobUid,
    nativeProcess(process.pid, budget),
    nativeProcess(1, budget),
    process.pid,
  )
  if (controller.cgroup !== placement.cgroup)
    throw new Error('not a MOTOR job cgroup')
  const directory = `/sys/fs/cgroup${controller.cgroup}`
  if (withinCleanupBudget(budget, () => realpathSync(directory)) !== directory)
    throw new Error('aliased cgroup directory')
  const inventory = withinCleanupBudget(budget, () =>
    readdirSync(directory),
  ).sort()
  const controls = Object.fromEntries(
    inventory
      .filter((name) => name !== 'memory.pressure')
      .map((name) => [
        name,
        observedProtection(join(directory, name), 'file', budget),
      ]),
  )
  const pressurePath = join(directory, 'memory.pressure')
  if (
    withinCleanupBudget(budget, () => realpathSync(pressurePath)) !==
    pressurePath
  )
    throw new Error('aliased PSI observation path')
  const psi = pressureObservation(
    {
      name: 'memory.pressure',
      fileType: 'regular',
      ...observedMetadata(pressurePath, 'file', budget),
      mount: cgroupMount(pressurePath, budget),
    },
    placement.jobUid,
  )
  const executable = withinCleanupBudget(budget, () =>
    readlinkSync('/proc/1/exe'),
  )
  if (executable !== '/bin/bash')
    throw new Error('PID1 is not the protected job wrapper')
  const canonicalExecutable = withinCleanupBudget(budget, () =>
    realpathSync(executable),
  )
  const executableStat = withinCleanupBudget(budget, () =>
    statSync('/proc/1/exe', { bigint: true }),
  )
  const diskStat = withinCleanupBudget(budget, () =>
    lstatSync(canonicalExecutable, { bigint: true }),
  )
  if (
    executableStat.dev !== diskStat.dev ||
    executableStat.ino !== diskStat.ino
  )
    throw new Error('PID1 executable differs from protected file')
  const kernel = nativeJobFixture().parseKernelStatus(
    withinCleanupBudget(budget, () =>
      readFileSync('/proc/self/status', 'utf8'),
    ),
  )
  const pid1Kernel = nativeJobFixture().parseKernelStatus(
    withinCleanupBudget(budget, () => readFileSync('/proc/1/status', 'utf8')),
  )
  const kernelFields = (status: Record<string, string>) =>
    Object.fromEntries(
      [
        'NoNewPrivs',
        'Seccomp',
        'CapInh',
        'CapPrm',
        'CapEff',
        'CapBnd',
        'CapAmb',
      ].map((key) => [key, status[key]]),
    )
  const summary = parseProcessBoundary({
    policy: MOTOR_PROCESS_POLICY,
    namespace: { self: controller.namespace, pid1: pid1.namespace },
    cgroup: {
      self: controller.cgroup,
      pid1: pid1.cgroup,
      directory: observedProtection(directory, 'directory', budget),
      parents: Object.fromEntries(
        ['/sys/fs/cgroup', '/sys/fs/cgroup/system.slice'].map((path) => [
          path,
          observedProtection(path, 'directory', budget),
        ]),
      ),
      controls,
      pressureObservation: psi,
    },
    pid1: {
      uid: pid1.uid,
      kernel: kernelFields(pid1Kernel),
      comm: pid1.comm,
      argvPrefix: withinCleanupBudget(budget, () =>
        readFileSync('/proc/1/cmdline'),
      )
        .toString()
        .split('\0')
        .slice(0, 2),
      executable,
      canonicalExecutable,
      executableSha256: withinCleanupBudget(budget, () =>
        sha256(readFileSync('/proc/1/exe')),
      ),
      digestProvenance: 'observed, not an approved artifact pin',
      protection: observedProtection(canonicalExecutable, 'file', budget),
      parents: Object.fromEntries(
        (canonicalExecutable === '/bin/bash'
          ? ['/', '/bin']
          : ['/', '/usr', '/usr/bin']
        ).map((path) => [path, observedProtection(path, 'directory', budget)]),
      ),
    },
    controller: { uid: controller.uid, kernel: kernelFields(kernel) },
  })
  checkCleanupBudget(budget)
  const stat = withinCleanupBudget(budget, () =>
    lstatSync(directory, { bigint: true }),
  )
  const pressureStat = withinCleanupBudget(budget, () =>
    lstatSync(pressurePath, { bigint: true }),
  )
  return {
    summary,
    controller,
    pid1,
    directoryIdentity: `${stat.dev}:${stat.ino}`,
    executableIdentity: `${executableStat.dev}:${executableStat.ino}`,
    pressureIdentity: `${pressureStat.dev}:${pressureStat.ino}`,
  }
}
export function scopedProcesses(
  summary: ReturnType<typeof parseProcessBoundary>,
  binding = false,
  budget?: NativeCleanupBudget,
): NativeProcessIdentity[] {
  const members = withinCleanupBudget(budget, () =>
    readFileSync(`/sys/fs/cgroup${summary.cgroup.self}/cgroup.procs`, 'utf8'),
  )
    .trim()
    .split('\n')
    .map((value) => {
      checkCleanupBudget(budget)
      return positiveInteger(Number(value))
    })
  if (new Set(members).size !== members.length)
    throw new Error('ambiguous cgroup membership')
  const visible = withinCleanupBudget(budget, () => readdirSync('/proc'))
    .filter((value) => {
      checkCleanupBudget(budget)
      return /^\d+$/.test(value)
    })
    .map(Number)
  const taskGroups = observedNativeTasks(summary, budget).map(
    (task) => task.tgid,
  )
  const identities = new Map<number, NativeProcessIdentity>()
  for (const pid of new Set([...members, ...visible, ...taskGroups])) {
    checkCleanupBudget(budget)
    const identity = resolvedNativeProcess(pid, summary, budget)
    if (!identity) continue
    if (
      identity.namespace !== summary.namespace.self ||
      identity.cgroup !== summary.cgroup.self
    )
      throw new Error('foreign process in qualified namespace/cgroup')
    // Initial inventories must agree. During reaping, births/exits can occur
    // between reads, so every extant member's own kernel membership is checked.
    if (
      binding &&
      (!visible.includes(pid) ||
        (!members.includes(pid) &&
          identity.state !== 'Z' &&
          identity.state !== 'X'))
    )
      throw new Error(
        'visible process and protected cgroup membership disagree',
      )
    identities.set(pid, identity)
  }
  return [...identities.values()]
}
export function qualifyNativeProcessScope(): NativeProcessScope {
  const observed = observedProcessBoundary()
  const scope = { summary: observed.summary }
  scopedProcesses(scope.summary, true)
  nativeScopes.set(scope, {
    summary: JSON.stringify(observed.summary),
    controller: observed.controller,
    pid1: observed.pid1,
    directoryIdentity: observed.directoryIdentity,
    executableIdentity: observed.executableIdentity,
    pressureIdentity: observed.pressureIdentity,
  })
  return scope
}
function recheckNativeScope(
  scope: NativeProcessScope,
  budget?: NativeCleanupBudget,
): NativeScopeBinding {
  checkCleanupBudget(budget)
  const binding = nativeScopes.get(scope)
  if (!binding || JSON.stringify(scope.summary) !== binding.summary)
    throw new Error('unqualified native process scope')
  const actual = observedProcessBoundary(budget)
  if (
    JSON.stringify(actual.summary) !== binding.summary ||
    actual.controller.pid !== binding.controller.pid ||
    actual.controller.start !== binding.controller.start ||
    actual.pid1.start !== binding.pid1.start ||
    actual.directoryIdentity !== binding.directoryIdentity ||
    actual.executableIdentity !== binding.executableIdentity ||
    actual.pressureIdentity !== binding.pressureIdentity
  )
    throw new Error('qualified job boundary changed')
  checkCleanupBudget(budget)
  return binding
}
export interface NativeCommandResult {
  code: number | null
  signal: string | null
  stdout: string
  stderr: string
  timedOut: boolean
  outputCapExceeded: boolean
  spawnError: string | null
  cleanup: {
    outcome: 'clean' | 'failed'
    signaled: number
    signals: { identity: NativeProcessIdentity; signal: 'SIGKILL' }[]
    preexisting: NativeProcessIdentity[]
    survivors: NativeProcessIdentity[] | null
    failures: string[]
  }
}
export interface NativeCommandTimers {
  setTimer: (
    callback: () => void,
    delay: number,
  ) => ReturnType<typeof setTimeout>
  clearTimer: (timer: ReturnType<typeof setTimeout>) => void
}
export function armNativeCommandTimer(
  callback: () => void,
  delay: number,
  timers: NativeCommandTimers = {
    setTimer: setTimeout,
    clearTimer: clearTimeout,
  },
): () => void {
  const timer = timers.setTimer(callback, delay)
  return () => timers.clearTimer(timer)
}

export async function runNativeCommand(
  scope: NativeProcessScope,
  binary: string,
  args: string[],
  options: {
    cwd: string
    env: Record<string, string>
    timeoutMs: number
    outputCapBytes?: number
    // Fixture controls may hold dispatch until readiness; normal runs use real timers.
    testTimers?: NativeCommandTimers
    // Tests retain direct-child handles independently of command cleanup results.
    testChild?: (child: ChildProcess) => void
  },
): Promise<NativeCommandResult> {
  // The job user observed at qualification; cleanup signals nobody else.
  const jobUid = recheckNativeScope(scope).controller.uid
  absoluteRoot(binary)
  if (
    !Number.isInteger(options.timeoutMs) ||
    options.timeoutMs < 1 ||
    options.timeoutMs > 120_000
  )
    throw new Error('invalid native command deadline')
  const cap = options.outputCapBytes ?? 8 * 1024 * 1024
  if (!Number.isInteger(cap) || cap < 1 || cap > 8 * 1024 * 1024)
    throw new Error('invalid native command output cap')
  const preexisting = scopedProcesses(scope.summary, true)
  const protectedBirths = new Map(
    preexisting.map((identity) => [identity.pid, identity.start]),
  )
  const birthFloor = preexisting.reduce(
    (floor, identity) =>
      BigInt(identity.start) > floor ? BigInt(identity.start) : floor,
    0n,
  )
  const signals: NativeCommandResult['cleanup']['signals'] = []
  const failures: string[] = []
  const sent = new Set<string>()
  let stdout = ''
  let stderr = ''
  let bytes = 0
  let timedOut = false
  let outputCapExceeded = false
  let spawnError: string | null = null
  let code: number | null = null
  let signal: string | null = null
  let child: ChildProcess | undefined
  let closed = false
  let completing = false
  const hardDeadline = performance.now() + options.timeoutMs + 3000
  return new Promise((resolveResult) => {
    const complete = async () => {
      if (completing) return
      completing = true
      clearTimer()
      let survivors: NativeProcessIdentity[] | null = null
      const cleanupDeadline = Math.min(hardDeadline, performance.now() + 3000)
      const budget: NativeCleanupBudget = { deadline: cleanupDeadline }
      try {
        while (performance.now() < cleanupDeadline) {
          recheckNativeScope(scope, budget)
          // Combine cgroup.procs, /proc leaders and cgroup.threads observations;
          // parent/session changes do not exclude a group. Unreadable or changing
          // task lists make cleanup fail with unknown survivors, never known absence.
          survivors = scopedProcesses(scope.summary, false, budget).filter(
            (identity) =>
              identity.pid !== 1 &&
              identity.pid !== process.pid &&
              protectedBirths.get(identity.pid) !== identity.start &&
              !['Z', 'X'].includes(identity.state),
          )
          if (!survivors.length && closed) break
          for (const expected of survivors) {
            checkCleanupBudget(budget)
            if (
              !nativeSignalOwned(expected.uid, jobUid) ||
              BigInt(expected.start) < birthFloor
            )
              throw new Error('new process has unqualified ownership/birth')
            recheckNativeScope(scope, budget)
            const current = resolvedNativeProcess(
              expected.pid,
              scope.summary,
              budget,
            )
            if (!current || ['Z', 'X'].includes(current.state)) continue
            if (
              current.start !== expected.start ||
              current.namespace !== scope.summary.namespace.self ||
              current.cgroup !== scope.summary.cgroup.self ||
              !nativeSignalOwned(current.uid, jobUid) ||
              protectedBirths.get(current.pid) === current.start ||
              current.pid === 1 ||
              current.pid === process.pid
            ) {
              failures.push(
                `identity changed before signal: ${expected.pid}:${expected.start}`,
              )
              continue
            }
            const key = `${current.pid}:${current.start}`
            if (sent.has(key)) continue
            // Revalidation is immediately before kill, but is not atomic with it.
            // Keep the namespace/cgroup exclusive to this job. Processes captured
            // before this command started are not its children to kill: exclude
            // their PID/start-time pairs even if a PID is reused between reads.
            try {
              checkCleanupBudget(budget)
              process.kill(current.pid, 'SIGKILL')
              signals.push({ identity: current, signal: 'SIGKILL' })
              sent.add(key)
              checkCleanupBudget(budget)
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
            }
          }
          await new Promise<void>((resolve) => setImmediate(resolve))
        }
        checkCleanupBudget(budget)
        recheckNativeScope(scope, budget)
        survivors = scopedProcesses(scope.summary, false, budget).filter(
          (identity) =>
            identity.pid !== 1 &&
            identity.pid !== process.pid &&
            protectedBirths.get(identity.pid) !== identity.start &&
            !['Z', 'X'].includes(identity.state),
        )
        if (survivors.length || !closed)
          failures.push('native command cleanup deadline exceeded')
      } catch (error) {
        survivors = null
        failures.push(String(error))
      } finally {
        child?.stdout?.destroy()
        child?.stderr?.destroy()
        if (!closed) child?.unref()
        resolveResult({
          code,
          signal,
          stdout,
          stderr,
          timedOut,
          outputCapExceeded,
          spawnError,
          cleanup: {
            outcome:
              failures.length || survivors === null || survivors.length
                ? 'failed'
                : 'clean',
            signaled: signals.length,
            signals,
            preexisting,
            survivors,
            failures,
          },
        })
      }
    }
    const retain = (chunk: Buffer, stream: 'stdout' | 'stderr') => {
      const value = chunk.subarray(0, Math.max(0, cap - bytes)).toString()
      if (stream === 'stdout') stdout += value
      else stderr += value
      bytes += chunk.length
      if (bytes > cap && !outputCapExceeded) {
        outputCapExceeded = true
        void complete()
      }
    }
    const clearTimer = armNativeCommandTimer(
      () => {
        timedOut = true
        void complete()
      },
      options.timeoutMs,
      options.testTimers,
    )
    try {
      recheckNativeScope(scope)
      child = spawn(binary, args, {
        cwd: options.cwd,
        env: options.env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      child.stdout?.on('data', (chunk: Buffer) => retain(chunk, 'stdout'))
      child.stderr?.on('data', (chunk: Buffer) => retain(chunk, 'stderr'))
      child.once('exit', (exitCode, exitSignal) => {
        code = exitCode
        signal = exitSignal
        void complete()
      })
      child.once('error', (error) => {
        spawnError = String(error)
        void complete()
      })
      child.once('close', (exitCode, exitSignal) => {
        code = exitCode
        signal = exitSignal
        closed = true
        void complete()
      })
      options.testChild?.(child)
    } catch (error) {
      spawnError = String(error)
      closed = true
      void complete()
    }
  })
}

type NativePrepared = {
  scope: NativeProcessScope
  native: Omit<ReturnType<typeof assertNativeJob>, 'runtime'> & {
    runtime: ReturnType<typeof runtime> | null
  }
  invoke: typeof invoke
}

export function observeNativeRunner() {
  const path = realpathSync(process.execPath)
  const descriptor = openSync('/proc/self/exe', constants.O_RDONLY)
  try {
    const running = fstatSync(descriptor, { bigint: true })
    const named = statSync(path, { bigint: true })
    if (
      !running.isFile() ||
      running.dev !== named.dev ||
      running.ino !== named.ino
    )
      throw new Error('native runner running executable inode mismatch')
    // The digest observes the executable actually bound by the kernel, not a
    // replaceable pathname. It is still an observation, not a new artifact pin.
    const bytes = readFileSync(descriptor)
    const current = statSync('/proc/self/exe', { bigint: true })
    const after = statSync(path, { bigint: true })
    if (
      running.dev !== current.dev ||
      running.ino !== current.ino ||
      running.dev !== after.dev ||
      running.ino !== after.ino
    )
      throw new Error('native runner running executable inode mismatch')
    if (
      bytes.subarray(0, 6).toString('hex') !== '7f454c460201' ||
      bytes.readUInt16LE(18) !== 62
    )
      throw new Error('native runner is not ELF x86-64')
    const reported = runtime({
      name: 'Bun',
      version: Bun.version,
      revision: Bun.revision,
    })
    return {
      path,
      sha256: sha256(bytes),
      bytes: bytes.length,
      elfMachine: bytes.readUInt16LE(18),
      version: reported.version,
      revision: reported.revision,
      device: running.dev.toString(),
      inode: running.ino.toString(),
    }
  } finally {
    closeSync(descriptor)
  }
}
export function assertNativeRunnerUnchanged(
  binding: ReturnType<typeof observeNativeRunner>,
): void {
  if (JSON.stringify(observeNativeRunner()) !== JSON.stringify(binding))
    throw new Error('native running executable changed before dispatch')
}

async function nativeJobRun(
  options: ReturnType<typeof parseArgs>,
): Promise<void> {
  assertNativeJobAdmission(options)
  const pin = PinSchema.parse(
    JSON.parse(readFileSync(join(HERE, 'ga-binary-pin.json'), 'utf8')),
  )
  const comparison = snapshotNativeComparison(options, pin)
  const processScope = qualifyNativeProcessScope()
  // The offline fixture must match the version, SRI and platform in
  // ga-binary-pin.json before any host executable can run.
  const manifest = record(
    JSON.parse(readFileSync(join(HERE, FIXTURE, 'package.json'), 'utf8')),
  )
  const ts: typeof import('typescript') = require('typescript')
  const lockFile = join(HERE, FIXTURE, 'bun.lock')
  const parsed = ts.parseConfigFileTextToJson(
    lockFile,
    readFileSync(lockFile, 'utf8'),
  )
  const lock = record(parsed.config)
  const cli = record(lock.packages)[pin.package]
  if (
    parsed.error ||
    manifest.private !== true ||
    manifest.scripts ||
    manifest.workspaces ||
    record(manifest.dependencies)[pin.package] !== pin.version ||
    JSON.stringify(manifest.dependencies) !==
      JSON.stringify(
        record(record(record(lock.workspaces)['']).dependencies),
      ) ||
    !Array.isArray(cli) ||
    cli[0] !== `${pin.package}@${pin.version}` ||
    cli[3] !== pin.sri ||
    record(cli[2]).os !== 'linux' ||
    record(cli[2]).cpu !== 'x64'
  )
    throw new Error('native fixture differs from approved platform pin')
  if (!options.tarball) throw new Error('missing native tarball')
  const archive = readFileSync(options.tarball)
  const binaryBytes = verifiedBinary(archive, pin)
  const runner = observeNativeRunner()
  const { out } = options
  mkdirSync(out, { mode: 0o700 })
  jsonFile(join(out, 'process-boundary.json'), {
    summary: processScope.summary,
    binding: nativeScopes.get(processScope),
    preexisting: scopedProcesses(processScope.summary, true),
  })
  const inputs = join(out, 'inputs')
  mkdirSync(inputs, { mode: 0o700 })
  const sources = sourceDigests('native-job')
  for (const [name, hash] of Object.entries(sources)) {
    // Preserve support modules' relative paths so their copied imports resolve.
    const target = join(inputs, 'sources', name)
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
    const bytes = readFileSync(join(HERE, name))
    if (sha256(bytes) !== hash) throw new Error(`native input changed: ${name}`)
    writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 })
  }
  const layout = nativeLayout(out)
  writeFileSync(layout.binary, binaryBytes, { flag: 'wx', mode: 0o700 })
  writeFileSync(
    layout.plugin,
    readFileSync(join(HERE, 'ga-measure-plugin.ts')),
    { flag: 'wx', mode: 0o600 },
  )
  if (sha256(readFileSync(layout.plugin)) !== sources['ga-measure-plugin.ts'])
    throw new Error('native plugin copy differs')
  const contractPath = join(inputs, 'ga-loopback-request-contract.ts')
  writeFileSync(
    contractPath,
    readFileSync(join(HERE, 'ga-loopback-request-contract.ts')),
    { flag: 'wx', mode: 0o600 },
  )
  const scratch = join(out, 'boundary')
  mkdirSync(scratch, { mode: 0o700 })
  const evidence = join(out, 'native-boundary.json')
  const probeCleanup: ReturnType<typeof assertNativeJob>['cleanup'] = []
  recheckNativeScope(processScope)
  await nativeJobFixture().measureNativeJob(
    REPO,
    scratch,
    nativeHostEnv(scratch, {}),
    evidence,
    async (binary, args, commandOptions) => {
      const result = await runNativeCommand(
        processScope,
        binary,
        args,
        commandOptions,
      )
      probeCleanup.push({
        id: 'boundary-probe',
        outcome: result.cleanup.outcome,
        signaled: result.cleanup.signaled,
      })
      return result
    },
  )
  const proof = record(JSON.parse(readFileSync(evidence, 'utf8')))
  const result = record(proof.result)
  if (proof.probeSha256 !== sources[`${FIXTURE}/native-boundary.py`])
    throw new Error('native probe source changed')
  const identity = assertNativeJob({
    root: out,
    executable: {
      path: layout.binary,
      sha256: sha256(binaryBytes),
      bytes: binaryBytes.length,
      elfMachine: binaryBytes.readUInt16LE(18),
      reportedVersion: pin.reportedVersion,
    },
    runtime: pin.runtime,
    runner,
    boundary: JSON.parse(string(result.stdout)),
    processBoundary: processScope.summary,
    cleanup: probeCleanup,
  })
  // ga-measure-plugin.ts reports Bun's version and revision in its 'setup' event.
  // Until that event is observed, partial runs report an unknown runtime, not the pin.
  const native: NativePrepared['native'] = { ...identity, runtime: null }
  const nativeInvoke: typeof invoke = async (
    binary,
    args,
    root,
    env,
    output,
    timeoutMs,
  ) => {
    nativeJobFixture().assertMeasuredNativeJob()
    assertNativeRunnerUnchanged(runner)
    const bytes = readFileSync(binary)
    if (
      binary !== layout.binary ||
      sha256(bytes) !== pin.binarySha256 ||
      bytes.length !== pin.binaryBytes ||
      bytes.readUInt16LE(18) !== pin.elfMachine ||
      sha256(readFileSync(layout.plugin)) !== sources['ga-measure-plugin.ts'] ||
      sha256(readFileSync(contractPath)) !==
        sources['ga-loopback-request-contract.ts'] ||
      JSON.stringify(sourceDigests('native-job')) !== JSON.stringify(sources)
    )
      throw new Error('native executable/plugin changed before invocation')
    const id =
      args.length === 1 && args[0] === '--version'
        ? 'version'
        : inventory().find(
            (spec) =>
              JSON.stringify(commandForCase(spec.id).slice(1)) ===
              JSON.stringify(args),
          )?.id
    if (!id) throw new Error('unmatched native command cleanup record')
    jsonFile(join(output, 'command.json'), {
      binary,
      args,
      cwd: root,
      env,
      timeoutMs,
    })
    const result = await runNativeCommand(processScope, binary, args, {
      cwd: root,
      env,
      timeoutMs,
    })
    writeFileSync(join(output, 'stdout.jsonl'), result.stdout, { flag: 'wx' })
    writeFileSync(join(output, 'stderr.log'), result.stderr, { flag: 'wx' })
    jsonFile(join(output, 'exit.json'), result)
    native.cleanup.push({
      id,
      outcome: result.cleanup.outcome,
      signaled: result.cleanup.signaled,
    })
    // A CLI leaving a live descendant is still an infrastructure failure,
    // even after job-local cleanup reaps that descendant.
    if (
      result.spawnError ||
      result.signal ||
      result.code !== 0 ||
      result.timedOut ||
      result.outputCapExceeded ||
      result.cleanup.outcome !== 'clean' ||
      result.cleanup.signaled !== 0
    )
      throw new Error(`native command failed: ${JSON.stringify(result)}`)
    return result.stdout
  }
  await insideRun(options, {
    native,
    invoke: nativeInvoke,
    scope: processScope,
  })
  for (const [name, hash] of Object.entries(sources))
    if (
      sha256(readFileSync(join(inputs, 'sources', name))) !== hash ||
      sha256(readFileSync(join(HERE, name))) !== hash
    )
      throw new Error(`native source changed: ${name}`)
  const matrix = validateMatrix(
    JSON.parse(readFileSync(join(out, 'matrix.json'), 'utf8')),
    pin,
    selectCases(options.cases),
    options.cases,
  )
  jsonFile(join(out, 'provenance.json'), {
    profile: 'native-job',
    command: [process.execPath, ...process.argv.slice(1)],
    sources,
    native: matrix.native,
    tarball: { path: options.tarball, sha256: sha256(archive), sri: pin.sri },
    selection: options.cases ?? 'full',
    comparison: comparison
      ? { path: comparison.path, sha256: comparison.sha256 }
      : null,
  })
  comparison?.compare(matrix)
}

async function insideRun(
  options: ReturnType<typeof parseArgs>,
  job?: NativePrepared,
): Promise<void> {
  const out = options.out
  const selected = selectCases(options.cases)
  const pin = PinSchema.parse(
    JSON.parse(readFileSync(join(HERE, 'ga-binary-pin.json'), 'utf8')),
  )
  let native: ReturnType<typeof assertNative> | undefined
  let binary: string
  const run = job?.invoke ?? invoke
  if (job) {
    binary = job.native.executable.path
  } else {
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
    native = assertNative({
      hostUname: outside.hostUname,
      daemonArchitecture: outside.daemonArchitecture,
      image: outside.image,
      containerUname: checkedCommand('uname', ['-m']),
      elfMachine: pin.elfMachine,
      runtime: pin.runtime,
      network: 'none',
      interfaces: readdirSync('/sys/class/net').sort(),
    })
    const binaryBytes = verifiedBinary(
      readFileSync(join(HERE, 'host.tgz')),
      pin,
    )
    binary = '/tmp/ga-verified-opencode'
    writeFileSync(binary, binaryBytes, { flag: 'wx' })
    chmodSync(binary, 0o700)
  }
  const versionRoot = join(out, 'version')
  mkdirSync(versionRoot)
  const envForRow = job ? nativeHostEnv : isolatedEnv
  const versionEnv = envForRow(versionRoot, {})
  for (const path of Object.values(versionEnv).filter((value) =>
    value.startsWith(versionRoot),
  ))
    mkdirSync(path.endsWith('.db') ? dirname(path) : path, { recursive: true })
  const reported = await run(
    binary,
    ['--version'],
    versionRoot,
    versionEnv,
    versionRoot,
    15_000,
  )
  if (reported.trim() !== pin.reportedVersion)
    throw new Error('reported host version mismatch')
  if (job)
    job.native.executable.reportedVersion = oneOf(reported.trim(), [
      pin.reportedVersion,
    ])
  const sources = sourceDigests(job ? 'native-job' : 'docker')
  const matrix = {
    schema: 1,
    full: options.cases === undefined,
    binarySha256: pin.binarySha256,
    ...(job
      ? { profile: 'native-job' as const, native: job.native }
      : { profile: 'docker' as const, native: assertNative(native) }),
    sources,
    rows: [] as ReturnType<typeof parseRow>[],
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
    if (job) command[0] = binary
    const nonce = /GA-NONCE-[0-9a-f-]{36}/.exec(command.at(-1) ?? '')?.[0]
    if (!nonce) throw new Error('missing case nonce')
    const pluginPath = job
      ? nativeLayout(out).plugin
      : join(HERE, 'ga-measure-plugin.ts')
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
    const env = envForRow(root, {
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
    if (job) {
      const git = await prepareNativeGit(root, job.scope)
      job.native.cleanup.push({
        id: `git:${spec.id}`,
        outcome: git.cleanup.outcome,
        signaled: git.cleanup.signaled,
      })
    } else checkedCommand('git', ['-C', join(root, 'project'), 'init'])
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
      const stdout = await run(
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
      if (job) {
        const setup = events
          .map(parsePluginEvent)
          .find((event) => event.type === 'setup')
        if (setup?.type !== 'setup')
          throw new Error('missing measured native runtime')
        job.native.runtime = setup.runtime
      }
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
    await (options.profile === 'native-job'
      ? nativeJobRun(options)
      : options.inside
        ? insideRun(options)
        : outsideRun(options))
    console.log(
      'GA native proxy measurement completed; promotion remains a separate review step',
    )
  } catch (error) {
    console.error(String(error))
    process.exitCode = 1
  }
}
