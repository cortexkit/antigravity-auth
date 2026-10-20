import { createSocket } from 'node:dgram'
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:https'
import type { Socket } from 'node:net'
import { networkInterfaces } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gzipSync } from 'node:zlib'
import { createPublicCommandInspector } from '../../core/src/__fixtures__/public-command-processes.test.ts'
import { measureNativeJob } from './fixtures/opencode-ga-host/native-job.ts'
import {
  createGaTlsFiles,
  type GaRawPeer,
  newGaNonce,
  ownedPath,
  prepareGaRoot,
  sha256,
  verifiedArchiveFiles,
  verifyExecutable,
} from './opencode-ga-harness.ts'
import {
  assertGaFixturePins,
  gaInstalledServer,
  installNativeGaPacks,
} from './opencode-ga-host-inputs.ts'
import {
  finite,
  startChild,
  withSyntheticVault,
} from './v1-vault-activation-harness.ts'

const ROOT = resolve(import.meta.dir, '../../..')
const EVIDENCE = join(ROOT, 'research/v1-unmigrated-upgrade')
const PACKAGE = '@cortexkit/opencode-antigravity-auth'
const CORE = '@cortexkit/antigravity-auth-core'
const HOST_SHA =
  '04a172f44c3449e1251f6f4b4dc9c391166a078c5aba04c9c1717411b4e84331'
const HOST_SRI =
  'sha512-6naffcRwMLUM0kYuwJ3tRWt1/NXPybt9u8ZqTvSZwATM54+GhQmoiz8Qb9GYFTiwSJmB1rq8VoEmwh1VPzBcFw=='
const ELF_SHA =
  'ae98d78e8b9a4f3ef4fd16920bfb3dedeab731c0586badff501f75b53ece3b6d'
export const UPGRADE_REFUSAL =
  'Antigravity accounts require offline migration. Stop OpenCode, then run `npx @cortexkit/opencode-antigravity-auth@3.0.0 migrate --offline`.'

interface BoundaryCall {
  phase: string
  kind: 'generation' | 'oauth' | 'project' | 'quota' | 'unknown'
  method: string
  url: string
  host: string
  body: string
  headers: string[]
}

async function startUpgradePeer(
  files: { ca: string; certificate: string; key: string },
  nonce: string,
) {
  let phase = 'negative'
  const calls: BoundaryCall[] = []
  const requests: GaRawPeer['requests'] = []
  const events: GaRawPeer['events'] = []
  const sockets = new Set<Socket>()
  const server = createServer(
    { cert: readFileSync(files.certificate), key: readFileSync(files.key) },
    async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = Buffer.concat(chunks).toString()
      const url = request.url ?? ''
      const host = String(request.headers.host)
      const kind =
        host === 'oauth2.googleapis.com' && url === '/token'
          ? 'oauth'
          : url.startsWith('/v1internal:streamGenerateContent')
            ? 'generation'
            : url.includes('loadCodeAssist') || url.includes('onboardUser')
              ? 'project'
              : /retrieveUserQuota|fetchAvailableModels/.test(url)
                ? 'quota'
                : 'unknown'
      calls.push({
        phase,
        kind,
        method: request.method ?? '',
        url,
        host,
        body,
        headers: request.rawHeaders,
      })
      if (kind === 'generation') {
        requests.push({
          method: request.method ?? '',
          url,
          body,
          rawHeaders: request.rawHeaders,
          receivedAt: Date.now(),
          peer: request.socket.remotePort ?? 0,
        })
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end(
          `data: ${JSON.stringify({ response: { candidates: [{ index: 0, content: { role: 'model', parts: [{ text: `GA_OK_${nonce}` }] } }] } })}\r\n\r\ndata: ${JSON.stringify({ response: { candidates: [{ index: 0, finishReason: 'STOP' }] } })}\r\n\r\n`,
        )
      } else if (kind === 'oauth' && phase === 'positive') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify({
            access_token: 'synthetic-renewed-access',
            expires_in: 3600,
            token_type: 'Bearer',
          }),
        )
      } else if (kind === 'quota' && phase === 'positive') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify({ models: [], buckets: [], quotaGroups: [] }),
        )
      } else {
        response.writeHead(412, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify({
            error: {
              code: 412,
              status: 'FAILED_PRECONDITION',
              message: 'Unexpected synthetic boundary call',
            },
          }),
        )
      }
    },
  )
  server.on('connection', (socket: Socket) => {
    sockets.add(socket)
    events.push({
      event: `tcp.accepted:${phase}`,
      at: Date.now(),
      peer: socket.remotePort ?? 0,
    })
    socket.on('close', () => sockets.delete(socket))
  })
  server.on('tlsClientError', (error, socket) =>
    events.push({
      event: `tls.error:${phase}:${error.message}`,
      at: Date.now(),
      peer: socket.remotePort ?? 0,
    }),
  )
  await new Promise<void>((done, reject) => {
    server.once('error', reject)
    server.listen(443, '127.0.0.1', done)
  })
  return {
    requests,
    events,
    calls,
    forced: false,
    setPhase(value: string) {
      phase = value
    },
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((done) => server.close(() => done()))
    },
  }
}

async function startUpgradeDns() {
  const queries: {
    name: string
    type: number
    peer: string
    family: string
    hex: string
  }[] = []
  const socket = createSocket('udp4')
  socket.on('message', (packet, peer) => {
    if (packet.length < 17 || packet.length > 512) return
    let cursor = 12
    const labels: string[] = []
    while (cursor < packet.length && packet[cursor]) {
      const length = packet[cursor++]!
      if (length > 63 || cursor + length >= packet.length) return
      labels.push(packet.subarray(cursor, cursor + length).toString())
      cursor += length
    }
    cursor++
    if (cursor + 4 > packet.length) return
    const name = labels.join('.')
    const type = packet.readUInt16BE(cursor)
    const question = packet.subarray(12, cursor + 4)
    queries.push({
      name,
      type,
      peer: peer.address,
      family: peer.family,
      hex: packet.toString('hex'),
    })
    const allowed = name === 'oauth2.googleapis.com'
    const header = Buffer.from(packet.subarray(0, 12))
    header.writeUInt16BE(allowed ? 0x8180 : 0x8183, 2)
    header.writeUInt16BE(1, 4)
    header.writeUInt16BE(allowed && type === 1 ? 1 : 0, 6)
    header.writeUInt32BE(0, 8)
    const answer =
      allowed && type === 1
        ? Buffer.from('c00c000100010000000000047f000001', 'hex')
        : Buffer.alloc(0)
    socket.send(
      Buffer.concat([header, question, answer]),
      peer.port,
      peer.address,
    )
  })
  await new Promise<void>((done, reject) => {
    socket.once('error', reject)
    socket.bind(53, '127.0.0.1', done)
  })
  return {
    queries,
    binding: socket.address(),
    async close() {
      await new Promise<void>((done) => socket.close(done))
    },
  }
}

export function isAccountPath(path: string): boolean {
  return /antigravity-accounts|(?:^|\/)auth\.json|credential|sidebar-state|statefile/.test(
    path,
  )
}

export function accountWriteLines(trace: string): string[] {
  return trace.split('\n').filter((line) => {
    const descriptor = line.match(
      /\b(?:write|pwrite64|fchmod|ftruncate)\([^<]*<([^>]*)>/,
    )
    if (descriptor) return isAccountPath(descriptor[1]!)
    return (
      isAccountPath(line) &&
      /\b(?:chmod|truncate|rename|renameat|renameat2|unlink|unlinkat|mkdir|mkdirat)\(|\bopenat?\(.*O_(?:WRONLY|RDWR|CREAT|TRUNC)/.test(
        line,
      )
    )
  })
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}
function json(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}

interface FileWitness {
  bytes: number
  sha256: string
  mode: number
  inode: number
  mtime: number
}
function file(path: string): FileWitness {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(fd)
    check(stat.isFile(), `Not a regular file: ${path}`)
    const bytes = readFileSync(fd)
    return {
      bytes: bytes.length,
      sha256: sha256(bytes),
      mode: stat.mode,
      inode: stat.ino,
      mtime: stat.mtimeMs,
    }
  } finally {
    closeSync(fd)
  }
}

function inventory(
  root: string,
): Record<string, FileWitness | { symlink: true }> {
  const files: Record<string, FileWitness | { symlink: true }> = {}
  const walk = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name)
      const stat = lstatSync(path)
      const key = path.slice(root.length + 1)
      if (stat.isSymbolicLink()) files[key] = { symlink: true }
      else if (stat.isDirectory()) walk(path)
      else if (stat.isFile()) files[key] = file(path)
    }
  }
  walk(root)
  return files
}

function stageDependency(
  name: string,
  from: string,
  destination: string,
  range: string,
  records: unknown[],
) {
  const entry = realpathSync(Bun.resolveSync(name, from))
  let source = dirname(entry)
  while (!existsSync(join(source, 'package.json'))) {
    check(source !== dirname(source), `No manifest for ${name}`)
    source = dirname(source)
  }
  const manifest = JSON.parse(
    readFileSync(join(source, 'package.json'), 'utf8'),
  )
  check(
    manifest.name === name && Bun.semver.satisfies(manifest.version, range),
    `Dependency ${name}@${manifest.version} does not satisfy ${range}`,
  )
  const target = join(destination, 'node_modules', name)
  if (!existsSync(target)) {
    const copy = (directory: string) => {
      for (const child of readdirSync(directory)) {
        if (child === 'node_modules') continue
        const path = join(directory, child)
        check(!lstatSync(path).isSymbolicLink(), `Dependency symlink: ${path}`)
        const output = join(target, path.slice(source.length + 1))
        if (lstatSync(path).isDirectory()) copy(path)
        else {
          const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
          try {
            check(fstatSync(fd).isFile(), `Dependency is not regular: ${path}`)
            mkdirSync(dirname(output), { recursive: true, mode: 0o700 })
            writeFileSync(output, readFileSync(fd), { mode: 0o600, flag: 'wx' })
          } finally {
            closeSync(fd)
          }
        }
      }
    }
    copy(source)
  }
  records.push({
    name,
    version: manifest.version,
    range,
    source,
    entry,
    sourceEntry: file(entry),
    inventory: inventory(target),
  })
  const runtimeDependencies =
    name === '@opencode-ai/plugin'
      ? Object.fromEntries(
          Object.entries(manifest.dependencies).filter(
            ([dependency]) =>
              dependency === 'zod' || dependency === '@opencode-ai/sdk',
          ),
        )
      : (manifest.dependencies ?? {})
  for (const [dependency, declaredRange] of Object.entries(
    runtimeDependencies,
  )) {
    stageDependency(dependency, source, target, String(declaredRange), records)
  }
}

export interface UpgradeReceipt {
  [key: string]: unknown
  error?: string
  profile: string
  requests: {
    index: number
    status: number
    body: string
    liveness: unknown
    snapshot: unknown
    wire: number
  }[]
  processes: ReturnType<typeof startChild>['receipt'][]
  snapshots: {
    name: string
    files: ReturnType<typeof inventory>
    accountBytes: string | null
  }[]
  tlsRequests: GaRawPeer['requests']
  tlsEvents: GaRawPeer['events']
  traces: Record<string, string>
}

export async function runUnmigratedUpgrade(): Promise<UpgradeReceipt> {
  check(
    process.platform === 'linux' && process.arch === 'x64',
    'Native Linux x64 is mandatory',
  )
  check(
    Object.keys(networkInterfaces()).every((name) => name === 'lo'),
    'Native job must expose only lo',
  )
  const profile = realpathSync(mkdtempSync('/tmp/unmigrated-v1-'))
  chmodSync(profile, 0o700)
  mkdirSync(join(profile, 'host'), { mode: 0o700 })
  mkdirSync(join(profile, 'runtime'), { mode: 0o700 })
  const paths = prepareGaRoot(join(profile, 'host'))
  const config = paths.opencodeConfig
  const pool = join(config, 'antigravity-accounts.json')
  const auth = join(paths.data, 'opencode/auth.json')
  const consumer = join(profile, 'consumer')
  const receipt: UpgradeReceipt = {
    profile,
    requests: [],
    processes: [],
    snapshots: [],
    tlsRequests: [],
    tlsEvents: [],
    traces: {},
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
    OPENCODE_CONFIG_DIR: config,
    ANTIGRAVITY_ACCOUNTS_PATH: pool,
    ANTIGRAVITY_AUTH_RPC_DIR: paths.rpc,
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
  }
  const inspector = await createPublicCommandInspector()
  const children: ReturnType<typeof startChild>[] = []
  let peer: Awaited<ReturnType<typeof startUpgradePeer>> | undefined
  let dns: Awaited<ReturnType<typeof startUpgradeDns>> | undefined
  const start = (name: string, argv: string[], deadline: number) => {
    const child = startChild(
      name,
      argv,
      paths.project,
      env,
      deadline,
      inspector,
    )
    children.push(child)
    receipt.processes.push(child.receipt)
    return child
  }
  const command = async (name: string, argv: string[], deadline = 15000) => {
    const child = start(name, argv, deadline)
    const result = await finite(
      child.result,
      deadline + 5000,
      `${name} did not exit`,
    )
    await child.stop()
    check(
      !result.timedOut && result.exitCode === 0,
      `${name} failed: ${JSON.stringify(result)}`,
    )
    return result
  }
  const snapshot = (name: string) => {
    const witness = {
      name,
      files: inventory(paths.root),
      accountBytes: existsSync(pool) ? readFileSync(pool, 'utf8') : null,
    }
    receipt.snapshots.push(witness)
    return witness
  }
  try {
    receipt.runtime = {
      bun: Bun.version,
      platform: process.platform,
      arch: process.arch,
      interfaces: Object.keys(networkInterfaces()),
      sysctl: readFileSync(
        '/proc/sys/net/ipv4/ip_unprivileged_port_start',
        'utf8',
      ).trim(),
    }
    check(
      (receipt.runtime as { sysctl: string }).sysctl === '0',
      'Owned loopback443 not admitted',
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
    receipt.hostAliases = file(join(ROOT, '.motor/hosts'))
    const archive = readFileSync(
      join(
        ROOT,
        '.cortexkit/parent-inputs/v1-packed-floor-r1/opencode-linux-x64-1.17.13.tgz',
      ),
    )
    check(
      archive.length === 54631676 && sha256(archive) === HOST_SHA,
      'Official archive size/SHA256 mismatch',
    )
    const hostFiles = verifiedArchiveFiles(archive, HOST_SRI)
    const binary = hostFiles.get('package/bin/opencode')
    check(binary, 'Official executable absent')
    const executable = join(profile, 'opencode')
    writeFileSync(executable, binary, { mode: 0o700, flag: 'wx' })
    verifyExecutable(executable, ELF_SHA, 62)
    const version = (
      await command('version', [executable, '--version'])
    ).stdout.trim()
    check(version === '1.17.13', 'Wrong executed official version')
    receipt.binary = {
      version,
      archiveBytes: archive.length,
      archiveSha256: sha256(archive),
      sri: HOST_SRI,
      elf: file(executable),
    }
    try {
      assertGaFixturePins(ROOT)
    } catch (error) {
      receipt.unrelatedFixtureFailure = {
        error: String(error),
        definition: 'packages/e2e-tests/src/opencode-ga-host-inputs.ts:39-81',
        priorCall: 'packages/e2e-tests/src/v1-packed-vault-harness.ts:409',
        expected: [
          '@opencode/cli-linux-x64',
          '@cortexkit/claustrum-client',
          '@cortexkit/subc-client',
          'jsonc-parser',
          'xdg-basedir',
          'zod',
        ].sort(),
        actual: Object.keys(
          JSON.parse(
            readFileSync(
              join(
                ROOT,
                'packages/e2e-tests/src/fixtures/opencode-ga-host/bun.lock',
              ),
              'utf8',
            ),
          ).packages,
        ).sort(),
      }
    }
    mkdirSync(join(consumer, 'node_modules'), { recursive: true, mode: 0o700 })
    const dependencies: unknown[] = []
    for (const owner of ['packages/core', 'packages/opencode']) {
      const manifest = JSON.parse(
        readFileSync(join(ROOT, owner, 'package.json'), 'utf8'),
      )
      for (const [name, range] of Object.entries(manifest.dependencies)) {
        if (name !== CORE)
          stageDependency(
            name,
            join(ROOT, owner),
            consumer,
            String(range),
            dependencies,
          )
      }
    }
    stageDependency(
      '@opencode-ai/plugin',
      ROOT,
      consumer,
      '1.17.13',
      dependencies,
    )
    receipt.dependencies = dependencies
    await installNativeGaPacks(ROOT, consumer)
    const packageDirectory = join(consumer, 'node_modules', PACKAGE)
    const installedEntry = gaInstalledServer(consumer, 'import')
    const coreEntry = Bun.resolveSync(CORE, packageDirectory)
    check(
      coreEntry.startsWith(`${consumer}/node_modules/${CORE}/`),
      'New core escaped consumer',
    )
    const pluginManifest = JSON.parse(
      readFileSync(join(packageDirectory, 'package.json'), 'utf8'),
    )
    const coreManifest = JSON.parse(
      readFileSync(
        join(consumer, 'node_modules', CORE, 'package.json'),
        'utf8',
      ),
    )
    check(
      pluginManifest.version === '3.0.0' &&
        coreManifest.version === '3.0.0' &&
        pluginManifest.dependencies[CORE] === '3.0.0',
      'Fresh pack version/corepin mismatch',
    )
    receipt.packs = {
      plugin: file(join(consumer, 'plugin.tgz')),
      core: file(join(consumer, 'core.tgz')),
      pluginManifest,
      coreManifest,
      installedEntry: file(installedEntry),
      coreEntry: file(coreEntry),
    }
    receipt.preparation = Object.fromEntries(
      ['build', 'core.tgz', 'plugin.tgz'].map((name) => [
        name,
        JSON.parse(readFileSync(join(consumer, `${name}.json`), 'utf8')),
      ]),
    )
    receipt.loading = {
      packageDirectory,
      configured: pathToFileURL(packageDirectory).href,
      installedEntry,
      resolvedEntry: Bun.resolveSync(`${PACKAGE}/server`, consumer),
    }
    const oldMetadata = JSON.parse(
      readFileSync(join(EVIDENCE, 'acquisition/metadata.json'), 'utf8'),
    )
    const oldArchive = readFileSync(
      join(EVIDENCE, 'acquisition/antigravity-auth-core-2.2.1.tgz'),
    )
    check(
      new Bun.CryptoHasher('sha1').update(oldArchive).digest('hex') ===
        oldMetadata.dist.shasum,
      'Old archive SHA1 mismatch',
    )
    const oldFiles = verifiedArchiveFiles(
      oldArchive,
      oldMetadata.dist.integrity,
    )
    const oldPackage = join(profile, 'old-writer/node_modules', CORE)
    const oldInventory: Record<string, { bytes: number; sha256: string }> = {}
    for (const [name, bytes] of oldFiles) {
      check(name.startsWith('package/'), 'Old member outside package root')
      const target = ownedPath(profile, join(oldPackage, name.slice(8)))
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
      writeFileSync(target, bytes, { mode: 0o600, flag: 'wx' })
      oldInventory[name] = { bytes: bytes.length, sha256: sha256(bytes) }
    }
    const oldManifest = JSON.parse(
      readFileSync(join(oldPackage, 'package.json'), 'utf8'),
    )
    check(
      oldManifest.name === CORE && oldManifest.version === '2.2.1',
      'Old writer package identity mismatch',
    )
    const oldDependencies: unknown[] = []
    for (const [name, range] of Object.entries(oldManifest.dependencies)) {
      stageDependency(
        name,
        join(ROOT, 'packages/core'),
        oldPackage,
        String(range),
        oldDependencies,
      )
    }
    receipt.oldWriter = {
      gitHead: oldMetadata.gitHead,
      archiveSha256: sha256(oldArchive),
      sha1: oldMetadata.dist.shasum,
      sri: oldMetadata.dist.integrity,
      manifest: oldManifest,
      inventory: oldInventory,
      dependencies: oldDependencies,
    }
    for (const directory of [config, join(paths.project, '.opencode')]) {
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
    receipt.pluginSettings =
      'No antigravity.json overrides; production defaults remain enabled'
    json(join(config, 'opencode.json'), {
      plugin: [pathToFileURL(packageDirectory).href],
      enabled_providers: ['google'],
      permission: { '*': 'deny' },
      agent: { title: { disable: true }, summary: { disable: true } },
    })
    json(auth, {
      google: {
        type: 'oauth',
        access: 'synthetic-upgrade-access',
        refresh:
          'synthetic-upgrade-refresh|synthetic-upgrade-project|synthetic-upgrade-project',
        expires: Date.now() + 3600000,
      },
    })
    const ack = join(profile, 'writer-ack.json')
    const writer = start(
      'old-writer',
      [
        realpathSync(process.execPath),
        join(EVIDENCE, 'old-writer.mjs'),
        oldPackage,
        pool,
        ack,
      ],
      15000,
    )
    await finite(
      (async () => {
        while (!existsSync(ack)) {
          check(
            writer.receipt.exitCode === null,
            'Old writer exited before acknowledging its write',
          )
          await new Promise((done) => setTimeout(done, 20))
        }
      })(),
      10000,
      'Old writer acknowledgement deadline',
    )
    snapshot('before-old-writer-shutdown')
    await writer.stop()
    check(
      writer.receipt.reaped &&
        writer.receipt.exitCode === 0 &&
        !writer.receipt.timedOut,
      'Old writer did not terminate cleanly before host startup',
    )
    receipt.writerAck = JSON.parse(readFileSync(ack, 'utf8'))
    snapshot('before-new-host-startup')
    process.env.ANTIGRAVITY_GA_HOST_EXECUTION = '1'
    const tls = await createGaTlsFiles(paths, 'matching')
    const extension = join(dirname(tls.certificate), 'upgrade.ext')
    writeFileSync(
      extension,
      'basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:daily-cloudcode-pa.googleapis.com,DNS:cloudcode-pa.googleapis.com,DNS:oauth2.googleapis.com\n',
    )
    await command(
      'oauth-leaf-sign',
      [
        '/usr/bin/openssl',
        'x509',
        '-req',
        '-in',
        join(dirname(tls.certificate), 'leaf.csr'),
        '-CA',
        tls.ca,
        '-CAkey',
        join(dirname(tls.certificate), 'ca.key'),
        '-CAserial',
        join(dirname(tls.certificate), 'ca.srl'),
        '-days',
        '2',
        '-extfile',
        extension,
        '-out',
        tls.certificate,
      ],
      10000,
    )
    receipt.tlsFixture = inventory(dirname(tls.certificate))
    env.NODE_EXTRA_CA_CERTS = tls.ca
    const nonce = newGaNonce()
    peer = await startUpgradePeer(tls, nonce)
    receipt.resolver = existsSync('/etc/resolv.conf')
      ? readFileSync('/etc/resolv.conf', 'utf8')
      : null
    dns = await startUpgradeDns()
    receipt.dnsBinding = dns.binding
    receipt.dnsControl = await command(
      'dns-control',
      [
        '/usr/bin/python3',
        '-c',
        'import socket,json; print(json.dumps(socket.getaddrinfo("oauth2.googleapis.com",443,socket.AF_UNSPEC,socket.SOCK_STREAM)))',
      ],
      15000,
    )
    check(
      String((receipt.dnsControl as { stdout: string }).stdout).includes(
        '127.0.0.1',
      ),
      'Native namespace resolver did not reach the owned OAuth DNS responder',
    )
    receipt.dnsControlQueries = [...dns.queries]
    const controlQueryCount = dns.queries.length
    receipt.tlsRequests = peer.requests
    receipt.tlsEvents = peer.events
    const server = start(
      'running-server',
      [
        '/usr/bin/strace',
        '-f',
        '-e',
        'trace=%file,%network,write,pwrite64,fchmod,ftruncate',
        '-yy',
        '-s',
        '512',
        '-o',
        join(profile, 'running-server.syscalls'),
        executable,
        'serve',
        '--hostname',
        '127.0.0.1',
        '--port',
        '0',
        '--print-logs',
        '--log-level',
        'DEBUG',
      ],
      30000,
    )
    const url = await finite(
      (async () => {
        for (;;) {
          const match = server.receipt.stdout.match(/http:\/\/127\.0\.0\.1:\d+/)
          if (match) return match[0]
          check(
            server.receipt.exitCode === null,
            `Server startup failed: ${server.receipt.stderr}`,
          )
          await new Promise((done) => setTimeout(done, 20))
        }
      })(),
      15000,
      'Running server readiness deadline',
    )
    const live = () => {
      const members = inspector.session(server.scope.leader.sid)
      const hosts = members.filter((member) => {
        try {
          return readlinkSync(`/proc/${member.pid}/exe`) === executable
        } catch {
          return false
        }
      })
      check(
        hosts.length === 1 && !hosts[0]!.zombie,
        'Exactly one running native server must remain alive',
      )
      return {
        ...hosts[0],
        start: hosts[0]!.start.toString(),
        measuredAt: Date.now(),
        leaderExit: server.receipt.exitCode,
      }
    }
    receipt.startupLiveness = live()
    const api = async (path: string, body?: unknown) => {
      const response = await fetch(`${url}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          'content-type': 'application/json',
          'x-opencode-directory': paths.project,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      })
      return { status: response.status, body: await response.text() }
    }
    receipt.catalog = await api('/provider')
    check(
      JSON.stringify(receipt.catalog).includes('antigravity-gemini-3.8-flash'),
      'Real host did not admit plugin model catalog',
    )
    for (const index of [1, 2]) {
      const session = await api('/session', {})
      check(
        session.status === 200,
        `Native session create failed: ${session.body}`,
      )
      const id = JSON.parse(session.body).id
      const response = await api(`/session/${id}/message`, {
        model: {
          providerID: 'google',
          modelID: 'antigravity-gemini-3.8-flash',
        },
        parts: [
          {
            type: 'text',
            text: `Reply with GA_OK_${nonce}. Primary request nonce: ${nonce}`,
          },
        ],
      })
      receipt.requests.push({
        index,
        ...response,
        liveness: live(),
        snapshot: snapshot(`after-request-${index}`),
        wire: peer.requests.length,
      })
    }
    receipt.preCleanupLiveness = live()
    receipt.negativeInstanceDisposal = await api('/instance/dispose', {})
    check(
      (receipt.negativeInstanceDisposal as { status: number }).status === 200,
      'Native instance disposal failed',
    )
    await server.stop()
    snapshot('after-negative-host-cleanup')
    receipt.negativeCalls = [...peer.calls]
    receipt.negativeTlsEvents = [...peer.events]
    receipt.negativeDnsQueries = dns.queries.slice(controlQueryCount)
    receipt.traces.negative = readFileSync(
      join(profile, 'running-server.syscalls'),
      'utf8',
    )
    check(
      server.receipt.reaped && !server.receipt.timedOut,
      'Native host must stop before offline migration',
    )
    const vaultCalls: {
      method: string
      params: Record<string, unknown>
      at: number
    }[] = []
    await withSyntheticVault(
      profile,
      { vaultCalls },
      env,
      async () => {
        const originalAuth = readFileSync(auth, 'utf8')
        const originalPool = readFileSync(pool, 'utf8')
        await command(
          'synthetic-vault-approval',
          [
            realpathSync(process.execPath),
            join(ROOT, 'packages/e2e-tests/src/v1-vault-activation-harness.ts'),
            '--seed',
          ],
          15000,
        )
        peer!.setPhase('vault')
        const vaultServer = start(
          'vault-server',
          [
            executable,
            'serve',
            '--hostname',
            '127.0.0.1',
            '--port',
            '0',
            '--print-logs',
            '--log-level',
            'DEBUG',
          ],
          30000,
        )
        const vaultUrl = await finite(
          (async () => {
            for (;;) {
              const match = vaultServer.receipt.stdout.match(
                /http:\/\/127\.0\.0\.1:\d+/,
              )
              if (match) return match[0]
              check(
                vaultServer.receipt.exitCode === null,
                `Vault startup failed: ${vaultServer.receipt.stderr}`,
              )
              await new Promise((done) => setTimeout(done, 20))
            }
          })(),
          15000,
          'Vault server readiness deadline',
        )
        const activation = start(
          'occupied-slot-activation',
          [
            executable,
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
          15000,
        )
        await finite(
          activation.result,
          20000,
          'Occupied-slot activation deadline',
        )
        await activation.stop()
        const vaultApi = async (path: string, body: unknown) => {
          const response = await fetch(`${vaultUrl}${path}`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-opencode-directory': paths.project,
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(15000),
          })
          return { status: response.status, body: await response.text() }
        }
        const session = await vaultApi('/session', {})
        check(
          session.status === 200,
          `Vault session creation failed: ${session.body}`,
        )
        const served = await vaultApi(
          `/session/${JSON.parse(session.body).id}/message`,
          {
            model: {
              providerID: 'google',
              modelID: 'antigravity-gemini-3.8-flash',
            },
            parts: [
              {
                type: 'text',
                text: `Reply with GA_OK_${nonce}. Primary request nonce: ${nonce}`,
              },
            ],
          },
        )
        receipt.vault = {
          ...served,
          nonce,
          calls: peer!.calls.filter((call) => call.phase === 'vault'),
          vaultCalls,
          activation: activation.receipt,
          authBefore: originalAuth,
          authAfter: readFileSync(auth, 'utf8'),
          poolBefore: originalPool,
          poolAfter: readFileSync(pool, 'utf8'),
        }
        receipt.vaultInstanceDisposal = await vaultApi('/instance/dispose', {})
        check(
          (receipt.vaultInstanceDisposal as { status: number }).status === 200,
          'Vault instance disposal failed',
        )
        await vaultServer.stop()
        await command(
          'synthetic-vault-disconnect',
          [
            realpathSync(process.execPath),
            join(EVIDENCE, 'disconnect-owned-vault.ts'),
          ],
          15000,
        )
      },
      consumer,
    )
    receipt.migration = await command(
      'offline-migration',
      [
        realpathSync(process.execPath),
        join(packageDirectory, 'dist/cli.js'),
        'migrate',
        '--offline',
        '--yes',
      ],
      15000,
    )
    const inspectStore = async (name: string) =>
      JSON.parse(
        (
          await command(
            name,
            [
              realpathSync(process.execPath),
              join(EVIDENCE, 'inspect-packed-store.mjs'),
              join(consumer, 'node_modules', CORE),
              pool,
            ],
            15000,
          )
        ).stdout,
      )
    receipt.migratedRows = await inspectStore('inspect-migrated-rows')
    snapshot('after-offline-migration')
    peer.setPhase('positive')
    const successor = start(
      'migrated-server',
      [
        '/usr/bin/strace',
        '-f',
        '-e',
        'trace=%file,%network',
        '-s',
        '512',
        '-o',
        join(profile, 'migrated-server.syscalls'),
        executable,
        'serve',
        '--hostname',
        '127.0.0.1',
        '--port',
        '0',
        '--print-logs',
        '--log-level',
        'DEBUG',
      ],
      30000,
    )
    const successorUrl = await finite(
      (async () => {
        for (;;) {
          const match = successor.receipt.stdout.match(
            /http:\/\/127\.0\.0\.1:\d+/,
          )
          if (match) return match[0]
          check(
            successor.receipt.exitCode === null,
            `Migrated startup failed: ${successor.receipt.stderr}`,
          )
          await new Promise((done) => setTimeout(done, 20))
        }
      })(),
      15000,
      'Migrated server readiness deadline',
    )
    const positiveApi = async (path: string, body: unknown) => {
      const response = await fetch(`${successorUrl}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-opencode-directory': paths.project,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      })
      return { status: response.status, body: await response.text() }
    }
    const positiveSession = await positiveApi('/session', {})
    check(
      positiveSession.status === 200,
      `Migrated session creation failed: ${positiveSession.body}`,
    )
    const positiveResponse = await positiveApi(
      `/session/${JSON.parse(positiveSession.body).id}/message`,
      {
        model: {
          providerID: 'google',
          modelID: 'antigravity-gemini-3.8-flash',
        },
        parts: [
          {
            type: 'text',
            text: `Reply with GA_OK_${nonce}. Primary request nonce: ${nonce}`,
          },
        ],
      },
    )
    receipt.positive = {
      ...positiveResponse,
      nonce,
      calls: peer.calls.filter((call) => call.phase === 'positive'),
      binary: file(executable),
      installedEntry: file(installedEntry),
      coreEntry: file(coreEntry),
      nativePids: inspector
        .session(successor.scope.leader.sid)
        .map((member) => ({ ...member, start: member.start.toString() })),
    }
    receipt.positiveInstanceDisposal = await positiveApi(
      '/instance/dispose',
      {},
    )
    check(
      (receipt.positiveInstanceDisposal as { status: number }).status === 200,
      'Migrated instance disposal failed',
    )
    await successor.stop()
    receipt.refreshedRows = await inspectStore('inspect-refreshed-rows')
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
    snapshot('after-final-host-cleanup')
    const tracePath = join(profile, 'running-server.syscalls')
    if (existsSync(tracePath))
      receipt.traces.server = readFileSync(tracePath, 'utf8')
    inspector.close()
    if (peer) {
      try {
        await finite(peer.close(), 5000, 'TLS cleanup deadline')
      } catch (error) {
        receipt.error = `${receipt.error ?? ''}\nTLS cleanup: ${String(error)}`
      }
    }
    if (dns) {
      receipt.dnsQueries = dns.queries
      try {
        await finite(dns.close(), 5000, 'DNS cleanup deadline')
      } catch (error) {
        receipt.error = `${receipt.error ?? ''}\nDNS cleanup: ${String(error)}`
      }
    }
    try {
      await measureNativeJob(
        ROOT,
        paths.temp,
        env,
        join(profile, 'boundary-after.json'),
      )
      receipt.boundaryAfter = JSON.parse(
        readFileSync(join(profile, 'boundary-after.json'), 'utf8'),
      )
    } catch (error) {
      receipt.error = `${receipt.error ?? ''}\nBoundary after cleanup: ${String(error)}`
    }
    const sources = [
      'packages/e2e-tests/src/v1-unmigrated-upgrade-harness.ts',
      'packages/e2e-tests/src/v1-unmigrated-upgrade.e2e.test.ts',
      'packages/e2e-tests/src/opencode-ga-harness.ts',
      'packages/e2e-tests/src/opencode-ga-host-inputs.ts',
      'packages/e2e-tests/src/v1-vault-activation-harness.ts',
      'packages/e2e-tests/src/fixtures/opencode-ga-host/native-job.ts',
      'packages/core/src/__fixtures__/public-command-processes.test.ts',
      'packages/opencode/src/server.ts',
      'packages/opencode/src/plugin/storage.ts',
      'packages/opencode/src/plugin/auth-loader.ts',
      'packages/opencode/src/plugin/index.ts',
      'packages/core/src/account-storage.ts',
      'packages/core/src/account-migration.ts',
      '.motor/hosts',
    ]
    receipt.sourceHashes = Object.fromEntries(
      sources.map((path) => [path, file(join(ROOT, path))]),
    )
    receipt.scope = {
      account: [
        'antigravity-accounts.json and all sidecars/store descendants',
        'credentials and auth.json',
        'account state/generation/pointer/backup/journal/migration files',
      ],
      normalRuntime: [
        'isolated OpenCode session database and WAL/SHM/storage',
        'host logs/cache/session runtime',
        'plugin RPC runtime and connection files',
      ],
      ordering:
        'Real old writer fully reaped before new host startup; negative host fully reaped before genuine packed CLI migrate --offline --yes; same binary/profile/packs restarted only after CLI exit0; no rollback or enrollment',
    }
    json(join(profile, 'receipt.json'), receipt)
  }
  return receipt
}

export function emitUpgradeReceipt(receipt: UpgradeReceipt) {
  console.log('UNMIGRATED_UPGRADE_RECEIPT_GZIP_BASE64_BEGIN')
  console.log(gzipSync(Buffer.from(JSON.stringify(receipt))).toString('base64'))
  console.log('UNMIGRATED_UPGRADE_RECEIPT_GZIP_BASE64_END')
}
