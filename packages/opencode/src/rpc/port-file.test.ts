import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve, sep } from 'node:path'

import { discoverPortFile, writePortFile } from './port-file'
import { getRpcDir } from './rpc-dir'

const RPC_DIR_ENV = 'ANTIGRAVITY_AUTH_RPC_DIR'

function hashProject(projectDirectory: string): string {
  return createHash('sha256')
    .update(resolve(projectDirectory))
    .digest('hex')
    .slice(0, 16)
}

describe('getRpcDir', () => {
  let root: string
  let originalRpcDir: string | undefined
  let originalStateHome: string | undefined

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agy-rpc-dir-test-'))
    originalRpcDir = process.env[RPC_DIR_ENV]
    originalStateHome = process.env.XDG_STATE_HOME
    delete process.env[RPC_DIR_ENV]
  })

  afterEach(() => {
    if (originalRpcDir === undefined) delete process.env[RPC_DIR_ENV]
    else process.env[RPC_DIR_ENV] = originalRpcDir
    if (originalStateHome === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = originalStateHome
    rmSync(root, { recursive: true, force: true })
  })

  it('uses a stable hash of the resolved project directory under XDG state', () => {
    const stateHome = join(root, 'state')
    const project = join(root, 'project', '..', 'project')
    process.env.XDG_STATE_HOME = stateHome

    expect(getRpcDir(project)).toBe(
      `${join(
        stateHome,
        'cortexkit',
        'antigravity-auth',
        'rpc',
        hashProject(project),
      )}${sep}`,
    )
  })

  it('uses an absolute override as-is', () => {
    const override = join(root, 'absolute-rpc')
    process.env[RPC_DIR_ENV] = override

    expect(getRpcDir(join(root, 'project'))).toBe(override)
    expect(isAbsolute(getRpcDir(join(root, 'project')))).toBe(true)
  })

  it('resolves a relative override against the project directory', () => {
    const project = join(root, 'project')
    process.env[RPC_DIR_ENV] = '.state/rpc'

    expect(getRpcDir(project)).toBe(resolve(project, '.state/rpc'))
  })
})

describe('port-file discovery', () => {
  let dir: string

  beforeEach(() => {
    dir = join(mkdtempSync(join(tmpdir(), 'agy-port-file-test-')), 'rpc')
  })

  afterEach(() => {
    rmSync(resolve(dir, '..'), { recursive: true, force: true })
  })

  it('writes atomically with private directory and file modes', () => {
    writePortFile(dir, { pid: process.pid, port: 41_001, token: 'secret' })

    const file = join(dir, `port-${process.pid}.json`)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(readdirSync(dir)).toEqual([`port-${process.pid}.json`])
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      pid: process.pid,
      port: 41_001,
      token: 'secret',
    })
  })

  it('repairs overly broad modes on an existing directory', () => {
    writePortFile(dir, { pid: process.pid, port: 41_002, token: 'secret' })
    chmodSync(dir, 0o755)

    writePortFile(dir, { pid: process.pid, port: 41_003, token: 'new-secret' })

    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(statSync(join(dir, `port-${process.pid}.json`)).mode & 0o777).toBe(
      0o600,
    )
  })

  it('selects the exact expected PID even when a newer live entry exists', () => {
    const exactPid = process.ppid
    writePortFile(dir, { pid: exactPid, port: 42_001, token: 'parent' })
    writePortFile(dir, { pid: process.pid, port: 42_002, token: 'current' })
    const exactPath = join(dir, `port-${exactPid}.json`)
    const currentPath = join(dir, `port-${process.pid}.json`)
    const old = new Date(Date.now() - 10_000)
    utimesSync(exactPath, old, old)
    utimesSync(currentPath, new Date(), new Date())

    expect(discoverPortFile(dir, exactPid)).toEqual({
      pid: exactPid,
      port: 42_001,
      token: 'parent',
    })
  })

  it('uses the newest live entry only when no exact PID is requested', () => {
    writePortFile(dir, { pid: process.ppid, port: 43_001, token: 'older' })
    writePortFile(dir, { pid: process.pid, port: 43_002, token: 'newer' })
    const old = new Date(Date.now() - 10_000)
    utimesSync(join(dir, `port-${process.ppid}.json`), old, old)

    expect(discoverPortFile(dir)).toEqual({
      pid: process.pid,
      port: 43_002,
      token: 'newer',
    })
    expect(discoverPortFile(dir, 99_999_999)).toBeNull()
  })

  it('removes malformed and stale-process entries during discovery', () => {
    const malformed = join(dir, 'port-11111111.json')
    const stale = join(dir, 'port-99999999.json')
    writePortFile(dir, { pid: process.pid, port: 44_001, token: 'live' })
    writeFileSync(malformed, '{nope', { mode: 0o600 })
    writeFileSync(
      stale,
      JSON.stringify({ pid: 99_999_999, port: 44_002, token: 'stale' }),
      { mode: 0o600 },
    )

    expect(discoverPortFile(dir)).toEqual({
      pid: process.pid,
      port: 44_001,
      token: 'live',
    })
    expect(existsSync(malformed)).toBe(false)
    expect(existsSync(stale)).toBe(false)
  })

  it('never treats the ephemeral port as the server PID', () => {
    const port = process.pid === 50_001 ? 50_002 : 50_001
    writePortFile(dir, { pid: process.pid, port, token: 'secret' })

    expect(discoverPortFile(dir, port)).toBeNull()
    expect(discoverPortFile(dir, process.pid)?.pid).toBe(process.pid)
  })
})
