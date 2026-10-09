import { createHash } from 'node:crypto'
import {
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  assertOwnedCommandSucceeded,
  startOwnedCommand,
} from './owned-command.ts'

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}
function object(value: unknown): Record<string, unknown> {
  check(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    'Missing native boundary object',
  )
  return value as Record<string, unknown>
}
export function parseKernelStatus(text: string): Record<string, string> {
  return Object.fromEntries(
    text
      .split('\n')
      .filter((line) => line.includes(':'))
      .map((line) => {
        const separator = line.indexOf(':')
        return [line.slice(0, separator), line.slice(separator + 1).trim()]
      }),
  )
}
export function assertNativeKernel(
  status: Record<string, unknown>,
  interfaces: unknown,
  architecture: string,
): void {
  check(
    architecture === 'x64' && JSON.stringify(interfaces) === '["lo"]',
    'Native job must be Linux x64 with only lo',
  )
  check(
    status.NoNewPrivs === '1' && status.Seccomp === '2',
    'Native job needs NoNewPrivs and namespace syscall filtering',
  )
  for (const field of ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb'])
    check(
      typeof status[field] === 'string' && /^0{16}$/.test(status[field]),
      `Native job has nonzero/missing ${field}`,
    )
}

export function assertNativeBoundary(input: unknown): string {
  const proof = object(input)
  assertNativeKernel(
    object(proof.status),
    proof.interfaces,
    proof.architecture === 'x86_64' ? 'x64' : '',
  )
  check(
    typeof proof.namespace === 'string' &&
      /^net:\[\d+\]$/.test(proof.namespace),
    'Missing native network namespace',
  )
  check(Array.isArray(proof.controls), 'Missing native boundary controls')
  const controls = proof.controls.map(object)
  const exactly = (name: string, family?: number) => {
    const found = controls.filter(
      (control) =>
        control.control === name &&
        (family === undefined || control.family === family),
    )
    check(
      found.length === 1,
      `Missing/ambiguous native control: ${name}/${family ?? ''}`,
    )
    return found[0]!
  }
  for (const family of [2, 10]) {
    for (const name of ['external_tcp', 'external_udp'])
      check(
        exactly(name, family).errno === 101,
        `External ${name}/${family} was not unreachable`,
      )
    check(
      exactly('loopback_tcp', family).roundTrip === true,
      `Loopback ${family} round trip failed`,
    )
  }
  check(
    exactly('external_dns').errno === 101,
    'External DNS socket was not unreachable',
  )
  check(exactly('unix_round_trip').roundTrip === true, 'UNIX round trip failed')
  const child = exactly('child_inheritance')
  check(
    child.namespace === proof.namespace && child.errno === 101,
    'Child escaped the blocked network namespace',
  )
  const namespaceAttempt = exactly('namespace_escape')
  check(
    namespaceAttempt.exit === 1 &&
      typeof namespaceAttempt.stderr === 'string' &&
      namespaceAttempt.stderr.includes('Operation not permitted'),
    'Namespace creation was not denied',
  )
  check(controls.length === 10, 'Unexpected native boundary control inventory')
  return proof.namespace
}

let measuredNamespace: string | undefined

/** Recheck kernel facts at each launch; an environment flag cannot manufacture a measured boundary. */
export function assertMeasuredNativeJob(): void {
  check(
    process.platform === 'linux' && measuredNamespace,
    'Native boundary has not been measured in this process',
  )
  assertNativeKernel(
    parseKernelStatus(readFileSync('/proc/self/status', 'utf8')),
    readdirSync('/sys/class/net').sort(),
    process.arch,
  )
  check(
    readlinkSync('/proc/self/ns/net') === measuredNamespace,
    'Native job network namespace changed after measurement',
  )
}

export async function measureNativeJob(
  repo: string,
  scratch: string,
  env: NodeJS.ProcessEnv,
  evidence: string,
): Promise<void> {
  check(process.platform === 'linux', 'Native job requires Linux')
  assertNativeKernel(
    parseKernelStatus(readFileSync('/proc/self/status', 'utf8')),
    readdirSync('/sys/class/net').sort(),
    process.arch,
  )
  const probe = realpathSync(
    join(
      repo,
      'packages/e2e-tests/src/fixtures/opencode-ga-host/native-boundary.py',
    ),
  )
  check(
    probe.startsWith(`${realpathSync(repo)}/`),
    'Native probe escaped the selected checkout',
  )
  const result = await startOwnedCommand('/usr/bin/python3', [probe, scratch], {
    cwd: scratch,
    env,
    deadlineMs: 15_000,
    outputCapBytes: 64 * 1024,
  }).result
  // Preserve probe stdout/stderr/exit and owned-child cleanup errors even when validation fails.
  writeFileSync(
    evidence,
    JSON.stringify(
      {
        probeSha256: createHash('sha256')
          .update(readFileSync(probe))
          .digest('hex'),
        result,
      },
      null,
      2,
    ),
    { mode: 0o600, flag: 'wx' },
  )
  assertOwnedCommandSucceeded(result)
  const namespace = assertNativeBoundary(JSON.parse(result.stdout))
  check(
    readlinkSync('/proc/self/ns/net') === namespace,
    'Boundary child did not inherit the parent namespace',
  )
  measuredNamespace = namespace
  assertMeasuredNativeJob()
}
