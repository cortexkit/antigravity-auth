import { createHash } from 'node:crypto'
import { closeSync, constants, opendirSync, openSync, readSync } from 'node:fs'
import { join } from 'node:path'

export interface PublicCommandIdentity {
  pid: number
  ppid: number
  pgid: number
  sid: number
  start: bigint
  zombie: boolean
}

export interface PublicCommandInspector {
  read(pid: number): PublicCommandIdentity | undefined
  session(sid: number): PublicCommandIdentity[]
  close(): void
  readonly counts?: {
    generation: number
    tableRows: number
    sessionMembers: number
  }
}

export interface PublicCommandScope {
  leader: PublicCommandIdentity
  observed: Map<number, PublicCommandIdentity>
  signals: {
    pid: number
    start: string
    pgid: number
    sid: number
    signal: string
  }[]
}

const MAX_PROCESSES = 16_384

function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function linuxIdentity(pid: number): PublicCommandIdentity | undefined {
  // Linux v6.19 fs/proc/array.c emits fields 3-6 and 22 after the unescaped comm.
  // https://github.com/torvalds/linux/blob/v6.19/fs/proc/array.c#L582-L605
  if (!Number.isSafeInteger(pid) || pid <= 0)
    throw new Error('invalid process identity PID')
  let fd: number
  try {
    fd = openSync(
      `/proc/${pid}/stat`,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    )
  } catch (error) {
    if (missing(error)) return undefined
    throw error
  }
  let text: string
  try {
    const buffer = Buffer.alloc(4096)
    const bytes = readSync(fd, buffer, 0, buffer.length, 0)
    if (bytes === buffer.length)
      throw new Error('process stat read exceeded bound')
    text = buffer.subarray(0, bytes).toString()
  } catch (error) {
    if (
      missing(error) ||
      (error instanceof Error && 'code' in error && error.code === 'ESRCH')
    )
      return undefined
    throw error
  } finally {
    closeSync(fd)
  }
  if (!text.startsWith(`${pid} (`)) throw new Error('process stat PID differs')
  const fields = text
    .slice(text.lastIndexOf(')') + 2)
    .trim()
    .split(/\s+/)
  if (fields.length < 20 || !/^\d+$/.test(fields[19] ?? ''))
    throw new Error('process stat identity missing')
  const ppid = Number(fields[1]),
    pgid = Number(fields[2]),
    sid = Number(fields[3])
  if (![ppid, pgid, sid].every((n) => Number.isSafeInteger(n) && n >= 0))
    throw new Error('process stat scope missing')
  return {
    pid,
    ppid,
    pgid,
    sid,
    start: BigInt(fields[19] ?? ''),
    zombie: fields[0] === 'Z' || fields[0] === 'X',
  }
}

export async function createPublicCommandInspector(): Promise<PublicCommandInspector> {
  const counts = { generation: 0, tableRows: 0, sessionMembers: 0 }
  if (process.platform === 'linux')
    return {
      read: linuxIdentity,
      session(sid) {
        const directory = opendirSync('/proc')
        const rows: PublicCommandIdentity[] = []
        let count = 0
        try {
          for (
            let entry = directory.readSync();
            entry;
            entry = directory.readSync()
          ) {
            if (!/^\d+$/.test(entry.name)) continue
            if (++count > MAX_PROCESSES)
              throw new Error('process table exceeded inspection bound')
            const row = linuxIdentity(Number(entry.name))
            if (row?.sid === sid) rows.push(row)
          }
        } finally {
          directory.closeSync()
        }
        counts.generation++
        counts.tableRows = count
        counts.sessionMembers = rows.length
        return rows
      },
      close() {},
      get counts() {
        return { ...counts }
      },
    }
  if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch))
    throw new Error(
      `unsupported owned process inspection platform: ${process.platform}/${process.arch}`,
    )
  // public-command-darwin-layout.c computes sizes, offsets and SDK constants.
  // Its JSON records compiler provenance and header hashes (provenance.headers).
  // The hash below prevents substitution of those supplied bytes; it is not an
  // independent proof of the SDK layout. Runtime uses only system libproc.
  const fd = openSync(
    join(import.meta.dir, 'public-command-darwin-layout.json'),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  )
  let layoutBytes: Buffer
  try {
    const buffer = Buffer.alloc(16 * 1024 + 1)
    const bytes = readSync(fd, buffer, 0, buffer.length, 0)
    if (bytes > 16 * 1024)
      throw new Error('Darwin ABI provenance exceeded read bound')
    layoutBytes = buffer.subarray(0, bytes)
  } finally {
    closeSync(fd)
  }
  if (
    layoutBytes.length > 16 * 1024 ||
    createHash('sha256').update(layoutBytes).digest('hex') !==
      '1e9e8de302d2d4dc3efe0b8d8ddd9c334fa426e3747bfc675017a563c3791d4d'
  )
    throw new Error('verified Darwin ABI provenance differs')
  const abi: {
    size: number
    pidSize: number
    allPids: number
    bsdInfo: number
    zombie: number
    missingError: number
    offsets: {
      pid: number
      ppid: number
      pgid: number
      status: number
      seconds: number
      microseconds: number
    }
  } = JSON.parse(layoutBytes.toString())
  const { dlopen, ptr, FFIType, toArrayBuffer } = await import('bun:ffi')
  const native = dlopen('/usr/lib/libproc.dylib', {
    proc_pidinfo: {
      args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32],
      returns: FFIType.i32,
    },
    proc_listpids: {
      args: [FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.i32],
      returns: FFIType.i32,
    },
  })
  const posix = dlopen('/usr/lib/libSystem.B.dylib', {
    getsid: { args: [FFIType.i32], returns: FFIType.i32 },
    getpgid: { args: [FFIType.i32], returns: FFIType.i32 },
    __error: { args: [], returns: FFIType.ptr },
  })
  const errno = () => {
    const pointer = posix.symbols.__error()
    if (pointer === null) throw new Error('Darwin errno identity unavailable')
    return new DataView(toArrayBuffer(pointer, 0, 4)).getInt32(0, true)
  }
  const sessionId = (pid: number) => {
    const sid = posix.symbols.getsid(pid)
    if (sid < 0 && errno() !== abi.missingError)
      throw new Error(`Darwin session unavailable: ${pid}, errno=${errno()}`)
    return sid
  }
  const read = (pid: number): PublicCommandIdentity | undefined => {
    if (!Number.isSafeInteger(pid) || pid <= 0)
      throw new Error('invalid process identity PID')
    const sid = sessionId(pid)
    if (sid < 0) return undefined
    const buffer = Buffer.alloc(abi.size)
    const first = native.symbols.proc_pidinfo(
      pid,
      abi.bsdInfo,
      0,
      ptr(buffer),
      buffer.length,
    )
    if (first !== abi.size) {
      if (sessionId(pid) < 0) return undefined
      throw new Error(
        `Darwin process identity unavailable: ${pid}, bytes=${first}`,
      )
    }
    const start =
      buffer.readBigUInt64LE(abi.offsets.seconds) * 1_000_000n +
      buffer.readBigUInt64LE(abi.offsets.microseconds)
    const group = posix.symbols.getpgid(pid)
    const second = native.symbols.proc_pidinfo(
      pid,
      abi.bsdInfo,
      0,
      ptr(buffer),
      buffer.length,
    )
    if (second !== abi.size) {
      if (sessionId(pid) < 0) return undefined
      throw new Error('Darwin process identity became unavailable')
    }
    const currentStart =
      buffer.readBigUInt64LE(abi.offsets.seconds) * 1_000_000n +
      buffer.readBigUInt64LE(abi.offsets.microseconds)
    if (
      start !== currentStart ||
      buffer.readUInt32LE(abi.offsets.pid) !== pid ||
      buffer.readUInt32LE(abi.offsets.pgid) !== group ||
      sessionId(pid) !== sid
    )
      throw new Error('Darwin process identity changed during inspection')
    return {
      pid,
      ppid: buffer.readUInt32LE(abi.offsets.ppid),
      pgid: group,
      sid,
      start,
      zombie: buffer.readUInt32LE(abi.offsets.status) === abi.zombie,
    }
  }
  return {
    read,
    session(sid) {
      const needed = native.symbols.proc_listpids(abi.allPids, 0, null, 0)
      const buffer = Buffer.alloc(MAX_PROCESSES * abi.pidSize)
      if (needed <= 0 || needed > buffer.length)
        throw new Error(
          'Darwin process table inspection unavailable or oversized',
        )
      const bytes = native.symbols.proc_listpids(
        abi.allPids,
        0,
        ptr(buffer),
        buffer.length,
      )
      if (bytes <= 0 || bytes >= buffer.length || bytes % abi.pidSize !== 0)
        throw new Error('Darwin process table inspection incomplete')
      const rows: PublicCommandIdentity[] = []
      let tableRows = 0
      for (let index = 0; index < bytes; index += abi.pidSize) {
        const pid = buffer.readInt32LE(index)
        if (pid <= 0) continue
        tableRows++
        if (sessionId(pid) !== sid) continue
        const row = read(pid)
        if (row) rows.push(row)
      }
      counts.generation++
      counts.tableRows = tableRows
      counts.sessionMembers = rows.length
      return rows
    },
    close() {
      native.close()
      posix.close()
    },
    get counts() {
      return { ...counts }
    },
  }
}

export function assertPublicCommandIdentity(
  expected: PublicCommandIdentity,
  current: PublicCommandIdentity,
  leader: PublicCommandIdentity,
): void {
  if (current.pid !== expected.pid || current.start !== expected.start)
    throw new Error('owned process PID birth identity changed')
  if (
    current.sid !== leader.sid ||
    current.pgid !== leader.pgid ||
    current.start < leader.start
  )
    throw new Error('owned process left captured session/group scope')
}

export function inspectPublicCommandScope(
  scope: PublicCommandScope,
  inspector: PublicCommandInspector,
): PublicCommandIdentity[] {
  // Check current session members and identities already observed by this job.
  // A child that leaves the session before observation is outside this check.
  const currentLeader = inspector.read(scope.leader.pid)
  if (currentLeader)
    assertPublicCommandIdentity(scope.leader, currentLeader, scope.leader)
  for (const expected of scope.observed.values()) {
    const current = inspector.read(expected.pid)
    if (current) assertPublicCommandIdentity(expected, current, scope.leader)
    if (!current || current.zombie) scope.observed.delete(expected.pid)
  }
  const members = inspector.session(scope.leader.sid)
  for (const member of members) {
    assertPublicCommandIdentity(
      scope.observed.get(member.pid) ?? member,
      member,
      scope.leader,
    )
    scope.observed.set(member.pid, member)
  }
  return members.filter((member) => !member.zombie)
}

export function signalPublicCommandMember(
  scope: PublicCommandScope,
  expected: PublicCommandIdentity,
  inspector: PublicCommandInspector,
  signal: NodeJS.Signals,
  dispatch: (pid: number, signal: NodeJS.Signals) => void = process.kill,
): void {
  const leader = inspector.read(scope.leader.pid)
  if (leader) assertPublicCommandIdentity(scope.leader, leader, scope.leader)
  const current = inspector.read(expected.pid)
  if (!current) return
  assertPublicCommandIdentity(expected, current, scope.leader)
  if (current.zombie) return
  // The native birth/session/group check is fresh, but is not atomic with kill.
  // A UID or a numeric PID alone is never accepted as ownership evidence.
  try {
    dispatch(current.pid, signal)
    scope.signals.push({
      pid: current.pid,
      start: current.start.toString(),
      pgid: current.pgid,
      sid: current.sid,
      signal,
    })
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH'))
      throw error
  }
}

export async function reapPublicCommandScope(
  scope: PublicCommandScope,
  inspector: PublicCommandInspector,
  deadline: number,
  termGraceMs: number,
): Promise<void> {
  const started = performance.now()
  const sent = new Set<string>()
  while (performance.now() < deadline) {
    const members = inspectPublicCommandScope(scope, inspector)
    if (
      members.length === 0 &&
      inspectPublicCommandScope(scope, inspector).length === 0
    )
      return
    const signal =
      performance.now() - started < termGraceMs ? 'SIGTERM' : 'SIGKILL'
    for (const member of members) {
      const key = `${member.pid}:${member.start}:${signal}`
      if (sent.has(key)) continue
      signalPublicCommandMember(scope, member, inspector, signal)
      sent.add(key)
    }
    await new Promise((resolve) =>
      setTimeout(
        resolve,
        Math.min(20, Math.max(1, deadline - performance.now())),
      ),
    )
  }
  throw new Error('owned session/group cleanup deadline exceeded')
}
