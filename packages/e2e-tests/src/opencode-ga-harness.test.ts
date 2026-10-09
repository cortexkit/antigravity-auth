import { afterEach, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import {
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
  assertGaPinnedHostnameMappings,
  GA_CASE_IDS,
  gaChildEnvironment,
  prepareGaRoot,
  verifiedArchiveFiles,
  verifiedArchiveMember,
} from './opencode-ga-harness.ts'
import {
  assertGaFixturePins,
  GA_OFFLINE_FIXTURE,
  gaInstalledServer,
  gaSdkDeclarationPaths,
} from './opencode-ga-host-inputs.ts'

const roots: string[] = []
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
    const fixture = JSON.parse(
      readFileSync(join(GA_OFFLINE_FIXTURE, 'bun.lock'), 'utf8'),
    )
    const tracked = parseConfigFileTextToJson(
      'bun.lock',
      readFileSync('bun.lock', 'utf8'),
    ).config
    for (const [name, entry] of Object.entries(fixture.packages)) {
      if (name === '@opencode/cli-linux-x64') continue
      expect(entry).toEqual(tracked.packages[name])
    }
  })
  it('uses genuine SDK declaration exports from its isolated dependency layout', () => {
    const paths = gaSdkDeclarationPaths(resolve('.'))
    expect(paths['@opencode/plugin']?.[0]).toEndWith('/dist/promise/index.d.ts')
    expect(paths['@opencode/client/promise']?.[0]).toEndWith(
      '/dist/promise/index.d.ts',
    )
    for (const targets of Object.values(paths)) expect(targets).toHaveLength(1)
  })
  it('keeps the complete 102-case inventory and the Docker network-none path', () => {
    expect(GA_CASE_IDS).toHaveLength(102)
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
