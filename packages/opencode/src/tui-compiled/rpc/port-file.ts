import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

export interface PortFileEntry {
  pid: number
  port: number
  token: string
}

interface LivePortFile {
  entry: PortFileEntry
  mtimeMs: number
}

const PORT_FILE_PATTERN = /^port-(\d+)\.json$/

export function writePortFile(dir: string, entry: PortFileEntry): void {
  assertPortFileEntry(entry, entry.pid)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)

  const destination = join(dir, `port-${entry.pid}.json`)
  const temporary = join(
    dir,
    `.port-${entry.pid}-${randomBytes(8).toString('hex')}.tmp`,
  )

  try {
    writeFileSync(temporary, JSON.stringify(entry), {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    })
    chmodSync(temporary, 0o600)
    renameSync(temporary, destination)
  } catch (error) {
    try {
      unlinkSync(temporary)
    } catch {}
    throw error
  }
}

export function discoverPortFile(
  dir: string,
  expectedPid?: number,
): PortFileEntry | null {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return null
    throw error
  }

  const live: LivePortFile[] = []
  for (const name of names) {
    const match = PORT_FILE_PATTERN.exec(name)
    if (!match) continue
    const path = join(dir, name)
    const filenamePid = Number(match[1])

    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
      assertPortFileEntry(parsed, filenamePid)
      if (!isProcessAlive(parsed.pid)) {
        removePortFile(path)
        continue
      }
      live.push({ entry: parsed, mtimeMs: statSync(path).mtimeMs })
    } catch {
      removePortFile(path)
    }
  }

  if (expectedPid !== undefined) {
    return live.find(({ entry }) => entry.pid === expectedPid)?.entry ?? null
  }

  live.sort((left, right) => right.mtimeMs - left.mtimeMs)
  return live[0]?.entry ?? null
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
    return !isNodeError(error, 'ESRCH')
  }
}

function removePortFile(path: string): void {
  try {
    unlinkSync(path)
  } catch {}
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === code
  )
}
