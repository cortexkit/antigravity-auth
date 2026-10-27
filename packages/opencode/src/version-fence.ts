// Decides whether the one-time move of the plugin's vault files out of
// OpenCode's config folder may run: only while no other live antigravity-auth
// process on this machine could still read or write the old files.
//
// A process is found through either of two files it leaves on disk:
//
// - a heartbeat, `<state>/cortexkit/antigravity-auth/processes/<pid>.json`
//   holding `{ "pid", "version", "startedAt", "layouts" }`
//   (`process-heartbeat.ts`), which versions from 3.0.13 on write;
// - an RPC port file,
//   `<state>/cortexkit/antigravity-auth/rpc/<16 hex>/port-<pid>.json`, which
//   OpenCode 1 plugin instances write. Versions before the move wrote it
//   without a `version`, so such a file blocks.
//
// A process counts as running while its pid is alive. Each record must carry
// its own current-or-newer version: a heartbeat left by a crashed process
// cannot vouch for a port file written by an older process reusing that pid.
// The fence fails closed on unreadable records and missing or invalid
// versions.
//
// With `layoutMove`, a heartbeat must also name, under `layouts`, which file
// layout the process uses for each config folder. A live process on the
// legacy layout for any config folder keeps the fence shut, and so does a
// heartbeat with no `layouts` at all. Any folder, not just the one moving: a
// key written by another version may be spelled differently for the same
// folder, and blocking too widely only delays a move.
//
// What this cannot see: an OpenCode 2 location or a CLI run of a version
// before 3.0.13 writes neither file. Port files written under a custom
// ANTIGRAVITY_AUTH_RPC_DIR, or under an empty XDG_STATE_HOME (which the RPC
// writer treats as a relative path), are outside the folders read here.

import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** One live process that keeps the fence shut. */
export interface VersionFenceBlocker {
  /** `'unknown'` when a whole directory could not be read. */
  pid: number | 'unknown'
  /** The version its heartbeat or port file names, or `'unknown'`. */
  version: string
  /** The file or directory that showed it. */
  detail: string
}

export type VersionFenceResult =
  | { open: true }
  | { open: false; blockers: VersionFenceBlocker[] }

export interface VersionFenceOptions {
  /** The XDG state base; defaults to `$XDG_STATE_HOME` or `~/.local/state`. */
  stateHome?: string
  /** Root holding the per-project RPC directories; defaults under the base. */
  rpcDir?: string
  /** The version that wants to act. */
  currentVersion: string
  isAlive?: (pid: number) => boolean
  /** This process, which never blocks itself. Defaults to `process.pid`. */
  selfPid?: number
  /**
   * Set when the vault files are about to move: a live process that uses the
   * legacy layout for any config folder, or that writes no layouts at all,
   * also keeps the fence shut.
   */
  layoutMove?: boolean
}

/**
 * The XDG state base every state-home file of the plugin lives under:
 * `$XDG_STATE_HOME`, else `~/.local/state`, on every OS. An empty
 * XDG_STATE_HOME counts as unset, as it does for the heartbeat.
 */
export function defaultStateHome(): string {
  return process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state')
}

/** Where a plugin process writes its heartbeat, `<pid>.json`. */
export function processHeartbeatDir(stateHome = defaultStateHome()): string {
  return join(stateHome, 'cortexkit', 'antigravity-auth', 'processes')
}

/** The root of the plugin's per-project RPC directories. */
export function rpcStateRoot(stateHome = defaultStateHome()): string {
  return join(stateHome, 'cortexkit', 'antigravity-auth', 'rpc')
}

/** The plugin names each project's RPC directory by 16 hex digits. */
function isRpcProjectDir(name: string): boolean {
  return /^[0-9a-f]{16}$/.test(name)
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

type Semver = { core: [number, number, number]; pre: string[] }

function parseSemver(value: string): Semver | undefined {
  const match =
    /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
      value.trim(),
    )
  if (!match) return undefined
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] ? match[4].split('.') : [],
  }
}

/**
 * Semver precedence of `a` against `b` (negative, zero, positive), or
 * undefined when either is not a version. A pre-release sorts below its
 * release; build metadata is ignored.
 */
export function compareVersions(a: string, b: string): number | undefined {
  const left = parseSemver(a)
  const right = parseSemver(b)
  if (!left || !right) return undefined
  for (let i = 0; i < 3; i++) {
    const diff = (left.core[i] as number) - (right.core[i] as number)
    if (diff !== 0) return Math.sign(diff)
  }
  if (left.pre.length === 0 || right.pre.length === 0)
    return Math.sign(right.pre.length - left.pre.length)
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    const x = left.pre[i]
    const y = right.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xNumeric = /^\d+$/.test(x)
    const yNumeric = /^\d+$/.test(y)
    if (xNumeric && yNumeric) {
      const diff = Number(x) - Number(y)
      if (diff !== 0) return Math.sign(diff)
    } else if (xNumeric !== yNumeric) {
      return xNumeric ? -1 : 1
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}

type Listing =
  | { ok: true; names: string[] }
  | { ok: false; code: string | undefined; error: string }

/** A missing directory lists as empty; any other failure is reported. */
async function list(dir: string): Promise<Listing> {
  try {
    return { ok: true, names: await readdir(dir) }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { ok: true, names: [] }
    return { ok: false, code, error: `${dir}: ${String(error)}` }
  }
}

type ProcessRecord =
  | { kind: 'gone' }
  | { kind: 'unreadable' }
  | { kind: 'ok'; version: string; layouts?: Record<string, unknown> }

async function readProcessRecord(
  path: string,
  pid: number,
): Promise<ProcessRecord> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    // Removed between the listing and the read: that process has exited.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { kind: 'gone' }
    return { kind: 'unreadable' }
  }
  try {
    const value: unknown = JSON.parse(text)
    if (
      value !== null &&
      typeof value === 'object' &&
      (value as { pid?: unknown }).pid === pid &&
      typeof (value as { version?: unknown }).version === 'string'
    ) {
      const layouts = (value as { layouts?: unknown }).layouts
      return {
        kind: 'ok',
        version: (value as { version: string }).version,
        ...(layouts !== null &&
        typeof layouts === 'object' &&
        !Array.isArray(layouts)
          ? { layouts: layouts as Record<string, unknown> }
          : {}),
      }
    }
  } catch {}
  return { kind: 'unreadable' }
}

/**
 * Whether no other live process keeps the fence shut. Never throws: anything
 * it cannot establish counts as a blocker.
 */
export async function versionFenceOpen(
  options: VersionFenceOptions,
): Promise<VersionFenceResult> {
  const isAlive = options.isAlive ?? pidAlive
  const self = options.selfPid ?? process.pid
  const blockers = new Map<number | string, VersionFenceBlocker>()
  const block = (entry: VersionFenceBlocker) => {
    const key = entry.pid === 'unknown' ? `dir:${entry.detail}` : entry.pid
    if (!blockers.has(key)) blockers.set(key, entry)
  }
  const alive = (pid: number) => {
    try {
      return isAlive(pid)
    } catch {
      return true
    }
  }
  const pidFrom = (name: string, pattern: RegExp): number | undefined => {
    const match = pattern.exec(name)
    const pid = match ? Number(match[1]) : Number.NaN
    return Number.isSafeInteger(pid) && pid >= 1 ? pid : undefined
  }

  // Heartbeats: the version a live process says it runs.
  const heartbeatDir = processHeartbeatDir(options.stateHome)
  const heartbeats = await list(heartbeatDir)
  if (!heartbeats.ok)
    block({ pid: 'unknown', version: 'unknown', detail: heartbeats.error })
  for (const name of heartbeats.ok ? heartbeats.names : []) {
    const pid = pidFrom(name, /^(\d+)\.json$/)
    if (pid === undefined || pid === self) continue
    const path = join(heartbeatDir, name)
    const heartbeat = await readProcessRecord(path, pid)
    if (heartbeat.kind === 'gone') continue
    if (!alive(pid)) continue
    if (heartbeat.kind === 'unreadable') {
      block({ pid, version: 'unknown', detail: path })
      continue
    }
    const order = compareVersions(heartbeat.version, options.currentVersion)
    if (order === undefined || order < 0) {
      block({ pid, version: heartbeat.version, detail: path })
      continue
    }
    if (
      options.layoutMove === true &&
      (heartbeat.layouts === undefined ||
        Object.values(heartbeat.layouts).includes('legacy'))
    )
      block({ pid, version: heartbeat.version, detail: path })
  }

  // Port files prove their version independently of heartbeats. Even an
  // unreadable body still names a pid through `port-<pid>.json`.
  const rpcRoot = options.rpcDir ?? rpcStateRoot(options.stateHome)
  const projects = await list(rpcRoot)
  if (!projects.ok)
    block({ pid: 'unknown', version: 'unknown', detail: projects.error })
  for (const project of projects.ok ? projects.names : []) {
    if (!isRpcProjectDir(project)) continue
    const dir = join(rpcRoot, project)
    const ports = await list(dir)
    if (!ports.ok) {
      // A plain file with a directory's name is not a project directory.
      if (ports.code === 'ENOTDIR') continue
      block({ pid: 'unknown', version: 'unknown', detail: ports.error })
      continue
    }
    for (const name of ports.names) {
      const pid = pidFrom(name, /^port-(\d+)\.json$/)
      if (pid === undefined || pid === self || !alive(pid)) continue
      const path = join(dir, name)
      const port = await readProcessRecord(path, pid)
      if (port.kind === 'gone') continue
      const version = port.kind === 'ok' ? port.version : 'unknown'
      const order = compareVersions(version, options.currentVersion)
      if (order === undefined || order < 0)
        block({ pid, version, detail: path })
    }
  }

  // Directory listings come in no fixed order; report blockers by pid.
  const rank = (b: VersionFenceBlocker) =>
    b.pid === 'unknown' ? Number.POSITIVE_INFINITY : b.pid
  return blockers.size === 0
    ? { open: true }
    : {
        open: false,
        blockers: [...blockers.values()].sort((a, b) => rank(a) - rank(b)),
      }
}
