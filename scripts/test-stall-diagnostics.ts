import { closeSync, constants, openSync, readSync } from 'node:fs'
import { basename } from 'node:path'
import {
  assertPublicCommandIdentity,
  inspectPublicCommandScope,
  type PublicCommandIdentity,
  type PublicCommandInspector,
  type PublicCommandScope,
} from '../packages/core/src/__fixtures__/public-command-processes.test.ts'
import { runCommand } from '../test/support/run-command.ts'
import { pendingTestChildLifecycles } from './test-child-lifecycle.ts'

export const STALL_SNAPSHOT_BYTES = 24 * 1024
export const FILE_BOUNDARY_RECORDS = 64
const MAX_PIDS = 8

/** Limit inspectPublicCommandScope's discovery refusal log to basename and argument count. */
export function safeDiagnosticInspector(
  inspector: PublicCommandInspector,
): PublicCommandInspector {
  return {
    read: (pid) => inspector.read(pid),
    session: (sid) => inspector.session(sid),
    close: () => inspector.close(),
    get counts() {
      return inspector.counts
    },
    observeArgv(identity) {
      const observed = inspector.observeArgv?.(identity)
      if (!observed || observed.status === 'unavailable')
        return { status: 'unavailable', reason: 'command summary unavailable' }
      return {
        status: observed.status,
        argv: [
          basename(observed.argv[0] ?? '')
            .replace(/[^\w.+-]/g, '_')
            .slice(0, 64),
          `argc=${observed.argv.length}`,
        ],
      }
    },
  }
}

function boundedRead(path: string, limit: number): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const buffer = Buffer.alloc(limit)
    return buffer
      .subarray(0, readSync(fd, buffer, 0, limit, 0))
      .toString('utf8')
  } finally {
    closeSync(fd)
  }
}

export function ownedLiveTestChildren(
  scope: PublicCommandScope,
  inspector: PublicCommandInspector,
): number {
  const safe = safeDiagnosticInspector(inspector)
  const members = new Map(
    inspectPublicCommandScope(scope, safe).map((row) => [row.pid, row]),
  )
  if (process.platform === 'linux') {
    const pids = boundedRead(
      `/proc/${scope.leader.pid}/task/${scope.leader.pid}/children`,
      1024,
    )
      .trim()
      .split(/\s+/)
      .filter((pid) => /^\d+$/.test(pid))
    if (pids.length > MAX_PIDS)
      throw new Error('owned child count exceeds diagnostic bound')
    // Separately-sessioned builders are still children of the runner, not foreign session peers.
    for (const pid of pids) {
      if (members.has(Number(pid))) continue
      const child = inspector.read(Number(pid))
      const parent = inspector.read(scope.leader.pid)
      if (
        !child ||
        !parent ||
        child.ppid !== parent.pid ||
        child.start < parent.start
      )
        continue
      assertPublicCommandIdentity(scope.leader, parent, scope.leader)
      const childScope = {
        leader: child,
        observed: new Map([[child.pid, child]]),
        signals: [],
      }
      for (const member of inspectPublicCommandScope(childScope, safe))
        members.set(member.pid, member)
    }
  }
  return [...members.values()].filter(
    (row) => row.pid !== scope.leader.pid && !row.zombie,
  ).length
}

/** Bound for one ps row; a slower ps is reported as unavailable. */
const PS_DEADLINE_MS = 1_000

/** Read one ps row without a synchronous spawn, which can wedge Bun (oven-sh/bun#34069). */
async function psRow(pid: number): Promise<string> {
  try {
    const ps = await runCommand(
      [
        '/bin/ps',
        '-p',
        String(pid),
        '-o',
        'pid=,ppid=,pgid=,sid=,stat=,etimes=,pcpu=,rss=,wchan=',
      ],
      {
        env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
        deadlineMs: PS_DEADLINE_MS,
      },
    )
    return ps.exitCode === 0 ? ps.stdout.trim().slice(0, 1024) : 'unavailable'
  } catch {
    return 'unavailable'
  }
}

/** Never serialize argv, environment, proc comm/Name, or inspection errors. */
export async function captureTestStall(
  reason: 'deadline' | 'slow-file' | 'failure' | 'bun-spawnsync-wedge',
  scope: PublicCommandScope,
  inspector: PublicCommandInspector,
  lifecycleRoot?: string,
): Promise<string | undefined> {
  if (process.platform !== 'linux') return undefined
  const processes: Record<string, unknown>[] = []
  let omitted = 0
  let available = true
  const host: Record<string, string> = {}
  for (const name of ['cpu', 'io', 'memory', 'loadavg']) {
    try {
      host[name] = boundedRead(
        name === 'loadavg' ? '/proc/loadavg' : `/proc/pressure/${name}`,
        512,
      ).trim()
    } catch {
      host[name] = 'unavailable'
    }
  }
  try {
    // Preserve previously captured identities even if they became zombies.
    const captured = new Map([
      [scope.leader.pid, scope.leader],
      ...scope.observed,
    ])
    inspectPublicCommandScope(scope, safeDiagnosticInspector(inspector))
    for (const [pid, identity] of scope.observed) captured.set(pid, identity)
    const owned: PublicCommandIdentity[] = []
    for (const identity of captured.values()) {
      const current = inspector.read(identity.pid)
      if (!current) continue
      assertPublicCommandIdentity(identity, current, scope.leader)
      owned.push(current)
    }
    // A builder owns a separate session. Admit it only through a fresh parent/birth edge,
    // never by command name, UID, or an unrelated matching process-group number.
    for (let index = 0; index < Math.min(owned.length, MAX_PIDS); index++) {
      const parent = owned[index]
      if (!parent || owned.length >= MAX_PIDS) break
      try {
        const children = boundedRead(
          `/proc/${parent.pid}/task/${parent.pid}/children`,
          1024,
        )
          .trim()
          .split(/\s+/)
          .filter((pid) => /^\d+$/.test(pid))
        for (const pid of children.slice(0, MAX_PIDS)) {
          if (captured.has(Number(pid))) continue
          const child = inspector.read(Number(pid))
          const currentParent = inspector.read(parent.pid)
          if (
            !child ||
            !currentParent ||
            child.ppid !== parent.pid ||
            child.start < parent.start
          )
            continue
          assertPublicCommandIdentity(parent, currentParent, parent)
          captured.set(child.pid, child)
          owned.push(child)
        }
        omitted += Math.max(0, children.length - MAX_PIDS)
      } catch {
        /* A vanished parent cannot authorize another descendant. */
      }
    }
    omitted += Math.max(0, owned.length - MAX_PIDS)
    for (const identity of owned.slice(0, MAX_PIDS)) {
      try {
        const pid = identity.pid
        const stat = boundedRead(`/proc/${pid}/stat`, 2048)
        const status = boundedRead(`/proc/${pid}/status`, 4096)
          .split('\n')
          .filter((line) =>
            /^(State|Tgid|Pid|PPid|TracerPid|Uid|Gid|Threads|VmPeak|VmSize|VmRSS|RssAnon|RssFile|RssShmem|voluntary_ctxt_switches|nonvoluntary_ctxt_switches):/.test(
              line,
            ),
          )
          .join('\n')
          .slice(0, 1024)
        const argv = inspector.observeArgv?.(identity)
        const command =
          argv && argv.status !== 'unavailable'
            ? {
                basename: basename(argv.argv[0] ?? '')
                  .replace(/[^\w.+-]/g, '_')
                  .slice(0, 64),
                argc: argv.argv.length,
                truncated: argv.status === 'truncated',
              }
            : { basename: 'unavailable', argc: null }
        const ps = await psRow(pid)
        const current = inspector.read(pid)
        if (!current) continue
        assertPublicCommandIdentity(identity, current, identity)
        // The unescaped comm field can contain arbitrary text; retain only stat's numeric tail.
        const numericStat = `${pid} (<redacted>) ${stat.slice(stat.lastIndexOf(')') + 2)}`
        if (!/^\d+ \(<redacted>\) [A-Z] [\d\s-]+$/.test(numericStat)) continue
        processes.push({
          pid,
          ppid: current.ppid,
          pgid: current.pgid,
          sid: current.sid,
          birth: current.start.toString(),
          command,
          ps,
          stat: numericStat.slice(0, 2048),
          status,
        })
      } catch {
        omitted++
      }
    }
  } catch {
    available = false
  }
  const children = lifecycleRoot
    ? [
        ...new Set([
          scope.leader.pid,
          ...processes.map((row) => Number(row.pid)),
        ]),
      ].flatMap((pid) => pendingTestChildLifecycles(lifecycleRoot, pid))
    : []
  const encode = () =>
    `[test-stall-snapshot] ${JSON.stringify({ reason, wall: new Date().toISOString(), observerPid: process.pid, available, omitted, psColumns: 'pid ppid pgid sid state elapsed_s cpu_percent rss_kib wchan', processes, host, children })}`
  let line = encode()
  while (Buffer.byteLength(line) > STALL_SNAPSHOT_BYTES && processes.length) {
    processes.pop()
    omitted++
    line = encode()
  }
  while (Buffer.byteLength(line) > STALL_SNAPSHOT_BYTES && children.length) {
    children.pop()
    omitted++
    line = encode()
  }
  return line
}

/** Bun has no preload file-boundary callback; observe its discovered-file headers externally. */
export function createTestFileObserver(
  runnerPid: number,
  liveChildren: () => number | null,
  emit: (line: string) => void,
) {
  const started = performance.now()
  let pending = ''
  let path: string | undefined
  let fileStarted = started
  let sampled = false
  let bytes = 0
  // Keep recent context without adding output to successful test runs.
  const recent: string[] = []
  const boundary = (event: 'start' | 'end') => {
    const line = `[test-file-boundary] ${JSON.stringify({ event, wall: new Date().toISOString(), elapsedMs: Math.round(performance.now() - started), path, runnerPid, ownedLiveChildren: liveChildren(), observed: 'bun-header-or-close' })}\n`
    bytes += Buffer.byteLength(line)
    recent.push(line)
    if (recent.length > FILE_BOUNDARY_RECORDS) recent.shift()
  }
  return {
    feed(chunk: Buffer) {
      // Bound partial lines even when a child prints an unterminated output stream.
      pending += chunk.toString('utf8')
      for (const line of pending.split('\n').slice(0, -1)) {
        // biome-ignore lint/suspicious/noControlCharactersInRegex: Bun may color file headers with ANSI escape sequences.
        const clean = line.replace(/\x1b\[[0-9;]*m/g, '').trim()
        if (clean.length > 512) continue
        if (
          !/^(?:\.\/)?(?:test|packages)\/[\w./-]+\.test\.[cm]?[jt]sx?:$/.test(
            clean,
          )
        )
          continue
        if (path) boundary('end')
        path = clean.slice(0, -1)
        fileStarted = performance.now()
        sampled = false
        boundary('start')
      }
      pending = pending.slice(pending.lastIndexOf('\n') + 1).slice(-2048)
    },
    /** Whether a test file header has been seen and its file is still running. */
    open() {
      return path !== undefined
    },
    slow() {
      if (!path || sampled || performance.now() - fileStarted < 30_000)
        return false
      sampled = true
      return true
    },
    close() {
      if (path) boundary('end')
      path = undefined
      return bytes
    },
    flush() {
      // Consume records so snapshot and exit handling cannot print the same context twice.
      const pending = recent.splice(0)
      for (const line of pending) emit(line)
      return Buffer.byteLength(pending.join(''))
    },
  }
}

/** One process as ps reports it for the spawnSync wedge check. */
export interface WedgeProcessRow {
  pid: number
  ppid: number
  /** ps STAT, such as `Rsl` or `Z`; the first letter is the scheduler state. */
  state: string
  elapsedS: number
  cpuPercent: number
}

/** The test runner and its direct children at one moment. */
export interface WedgeSnapshot {
  runner: WedgeProcessRow
  children: WedgeProcessRow[]
}

export interface BunSpawnSyncWedge {
  runnerPid: number
  cpuPercent: number
  zombiePid: number
  zombieElapsedS: number
}

/**
 * Bun's synchronous spawn can lose a child's exit on Linux (oven-sh/bun#34069):
 * the child stays a zombie that is never reaped while the runner busy-spins in
 * its wait loop. Only that exact picture counts: a runnable runner at high CPU
 * beside a direct zombie child at least 60 seconds old.
 */
export const BUN_SPAWNSYNC_WEDGE = {
  runnerCpuPercent: 90,
  zombieElapsedS: 60,
  checkIntervalMs: 15_000,
} as const

/** Match the wedge signature; anything less, or no snapshot, is not a match. */
export function matchBunSpawnSyncWedge(
  snapshot: WedgeSnapshot | undefined,
  platform: NodeJS.Platform = process.platform,
): BunSpawnSyncWedge | undefined {
  if (platform !== 'linux' || !snapshot) return undefined
  const { runner } = snapshot
  if (!runner.state.startsWith('R')) return undefined
  if (!(runner.cpuPercent >= BUN_SPAWNSYNC_WEDGE.runnerCpuPercent))
    return undefined
  const zombie = snapshot.children.find(
    (child) =>
      child.ppid === runner.pid &&
      child.state.startsWith('Z') &&
      child.elapsedS >= BUN_SPAWNSYNC_WEDGE.zombieElapsedS,
  )
  if (!zombie) return undefined
  return {
    runnerPid: runner.pid,
    cpuPercent: runner.cpuPercent,
    zombiePid: zombie.pid,
    zombieElapsedS: zombie.elapsedS,
  }
}

export function bunSpawnSyncWedgeMessage(wedge: BunSpawnSyncWedge): string {
  return `Bun spawnSync child-exit loss (oven-sh/bun#34069): test runner pid ${wedge.runnerPid} is spinning at ${wedge.cpuPercent}% CPU with zombie child pid ${wedge.zombiePid} for ${wedge.zombieElapsedS}s`
}

/** Parse `ps -o pid=,ppid=,stat=,etimes=,pcpu=` rows into the runner and its direct children. */
export function parseWedgePs(
  text: string,
  runnerPid: number,
): WedgeSnapshot | undefined {
  const rows: WedgeProcessRow[] = []
  for (const line of text.split('\n')) {
    const fields = line.trim().split(/\s+/)
    if (fields.length !== 5) continue
    const [pid, ppid, state, elapsedS, cpuPercent] = fields as [
      string,
      string,
      string,
      string,
      string,
    ]
    const row = {
      pid: Number(pid),
      ppid: Number(ppid),
      state,
      elapsedS: Number(elapsedS),
      cpuPercent: Number(cpuPercent),
    }
    if (
      ![row.pid, row.ppid, row.elapsedS, row.cpuPercent].every(Number.isFinite)
    )
      continue
    rows.push(row)
  }
  const runner = rows.find((row) => row.pid === runnerPid)
  if (!runner) return undefined
  return {
    runner,
    children: rows.filter((row) => row.ppid === runnerPid),
  }
}

/** Read the runner and its direct children; undefined off Linux or when ps fails. */
export async function readWedgeSnapshot(
  runnerPid: number,
): Promise<WedgeSnapshot | undefined> {
  if (process.platform !== 'linux') return undefined
  try {
    const ps = await runCommand(
      [
        '/bin/ps',
        '-o',
        'pid=,ppid=,stat=,etimes=,pcpu=',
        '-p',
        String(runnerPid),
        '--ppid',
        String(runnerPid),
      ],
      {
        env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
        deadlineMs: PS_DEADLINE_MS,
      },
    )
    return ps.exitCode === 0 ? parseWedgePs(ps.stdout, runnerPid) : undefined
  } catch {
    return undefined
  }
}
