import { randomBytes } from 'node:crypto'
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'

export interface PortFileEntry {
  port: number
  token: string
  pid: number
  startedAt: number
}

const PORT_FILE_PATTERN = /^port-(\d+)\.json$/
const DIR_MODE = 0o700
const FILE_MODE = 0o600

export async function writePortFile(
  dir: string,
  entry: { port: number; token: string; pid: number },
): Promise<string> {
  assertPortFileEntry({ ...entry, startedAt: 0 }, entry.pid)

  // mkdir recursive with the private mode on first creation; on a re-run the
  // directory already exists with the right mode. We still re-apply chmod so
  // an operator who widened the directory accidentally gets it repaired
  // back to 0o700 before we drop a token-bearing file inside.
  await mkdir(dir, { recursive: true, mode: DIR_MODE })
  await chmod(dir, DIR_MODE)

  const full: PortFileEntry = { ...entry, startedAt: Date.now() }
  const target = join(dir, `port-${entry.pid}.json`)
  const temporary = `${target}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`

  try {
    await writeFile(temporary, JSON.stringify(full), {
      encoding: 'utf8',
      mode: FILE_MODE,
    })
    await chmod(temporary, FILE_MODE)
    await rename(temporary, target)
  } catch (error) {
    try {
      await unlink(temporary)
    } catch {}
    throw error
  }
  return target
}

export async function discoverPortFile(
  dir: string,
  expectedPid?: number,
): Promise<PortFileEntry | null> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return null
    throw error
  }

  const live: PortFileEntry[] = []
  for (const name of names) {
    const match = PORT_FILE_PATTERN.exec(name)
    if (!match) continue
    const path = join(dir, name)
    const filenamePid = Number(match[1])

    let parsed: PortFileEntry
    try {
      const text = await readFile(path, 'utf8')
      const raw = JSON.parse(text) as unknown
      assertPortFileEntry(raw, filenamePid)
      parsed = raw
    } catch {
      // Malformed or stale — keep the directory clean so future discovers
      // don't trip over the same debris.
      await unlink(path).catch(() => {})
      continue
    }

    if (!isProcessAlive(parsed.pid)) {
      await unlink(path).catch(() => {})
      continue
    }

    live.push(parsed)
  }

  if (expectedPid !== undefined) {
    // antigravity exact-PID safety: a missing expected PID must surface as
    // null so a stale but live entry can't impersonate the requester.
    return live.find(({ pid }) => pid === expectedPid) ?? null
  }

  if (live.length === 0) return null
  live.sort((left, right) => right.startedAt - left.startedAt)
  return live[0] ?? null
}

function assertPortFileEntry(
  value: unknown,
  filenamePid: number,
): asserts value is PortFileEntry {
  if (
    typeof value !== 'object' ||
    value === null ||
    !Number.isSafeInteger((value as PortFileEntry).pid) ||
    (value as PortFileEntry).pid <= 0 ||
    (value as PortFileEntry).pid !== filenamePid ||
    !Number.isSafeInteger((value as PortFileEntry).port) ||
    (value as PortFileEntry).port <= 0 ||
    (value as PortFileEntry).port > 65_535 ||
    typeof (value as PortFileEntry).token !== 'string' ||
    (value as PortFileEntry).token.length === 0
  ) {
    throw new Error('Invalid RPC port file')
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return isNodeError(error, 'EPERM')
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === code
  )
}
