import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  chmod,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
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

async function statMode(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777
}

describe('getRpcDir', () => {
  let root: string
  let originalRpcDir: string | undefined
  let originalStateHome: string | undefined

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'agy-rpc-dir-test-'))
    originalRpcDir = process.env[RPC_DIR_ENV]
    originalStateHome = process.env.XDG_STATE_HOME
    delete process.env[RPC_DIR_ENV]
  })

  afterEach(async () => {
    if (originalRpcDir === undefined) delete process.env[RPC_DIR_ENV]
    else process.env[RPC_DIR_ENV] = originalRpcDir
    if (originalStateHome === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = originalStateHome
    await rm(root, { recursive: true, force: true })
  })

  it('uses a stable hash of the resolved project directory under XDG state', () => {
    const stateHome = join(root, 'state')
    const project = join(root, 'project', '..', 'project')
    process.env.XDG_STATE_HOME = stateHome

    expect(getRpcDir(project)).toBe(
      join(
        stateHome,
        'cortexkit',
        'antigravity-auth',
        'rpc',
        hashProject(project),
      ),
    )
  })

  it('uses an absolute override as-is (no trailing separator)', () => {
    const override = join(root, 'absolute-rpc')
    process.env[RPC_DIR_ENV] = override

    const resolved = getRpcDir(join(root, 'project'))
    expect(resolved).toBe(override)
    expect(resolved.endsWith(sep)).toBe(false)
    expect(isAbsolute(resolved)).toBe(true)
  })

  it('trims surrounding whitespace from the override', () => {
    const project = join(root, 'project')
    const override = join(root, 'trimmed-rpc')
    process.env[RPC_DIR_ENV] = `  ${override}  `

    expect(getRpcDir(project)).toBe(override)
  })

  it('resolves a relative override against the project directory', () => {
    const project = join(root, 'project')
    process.env[RPC_DIR_ENV] = '.state/rpc'

    expect(getRpcDir(project)).toBe(resolve(project, '.state/rpc'))
  })
})

describe('port-file discovery', () => {
  let dir: string

  beforeEach(async () => {
    const parent = await mkdtemp(join(tmpdir(), 'agy-port-file-test-'))
    dir = join(parent, 'rpc')
  })

  afterEach(async () => {
    await rm(resolve(dir, '..'), { recursive: true, force: true })
  })

  it('writes atomically with private directory and file modes', async () => {
    await writePortFile(dir, {
      pid: process.pid,
      port: 41_001,
      token: 'secret',
    })

    const file = join(dir, `port-${process.pid}.json`)
    expect(await statMode(dir)).toBe(0o700)
    expect(await statMode(file)).toBe(0o600)
    expect((await readdir(dir)).sort()).toEqual([`port-${process.pid}.json`])
    const parsed = JSON.parse(await readFile(file, 'utf8')) as Record<
      string,
      unknown
    >
    expect(parsed.pid).toBe(process.pid)
    expect(parsed.port).toBe(41_001)
    expect(parsed.token).toBe('secret')
    expect(typeof parsed.startedAt).toBe('number')
  })

  it('repairs overly broad modes on an existing directory', async () => {
    await writePortFile(dir, {
      pid: process.pid,
      port: 41_002,
      token: 'secret',
    })
    await chmod(dir, 0o755)

    await writePortFile(dir, {
      pid: process.pid,
      port: 41_003,
      token: 'new-secret',
    })

    expect(await statMode(dir)).toBe(0o700)
    expect(await statMode(join(dir, `port-${process.pid}.json`))).toBe(0o600)
  })

  it('selects the exact expected PID even when a newer live entry exists', async () => {
    const exactPid = process.ppid
    // Sequence matters: write the older entry first so its startedAt is
    // smaller than the newer one. The exact-PID lookup must still beat
    // the newer candidate.
    await writePortFile(dir, { pid: exactPid, port: 42_001, token: 'parent' })
    // Tiny delay so startedAt is strictly increasing without sleeping.
    await new Promise((resolve) => setTimeout(resolve, 2))
    await writePortFile(dir, {
      pid: process.pid,
      port: 42_002,
      token: 'current',
    })

    const discovered = await discoverPortFile(dir, exactPid)
    expect(discovered).not.toBeNull()
    expect(discovered?.pid).toBe(exactPid)
    expect(discovered?.port).toBe(42_001)
    expect(discovered?.token).toBe('parent')
  })

  it('uses the newest live startedAt only when no exact PID is requested', async () => {
    await writePortFile(dir, {
      pid: process.ppid,
      port: 43_001,
      token: 'older',
    })
    await new Promise((resolve) => setTimeout(resolve, 2))
    await writePortFile(dir, { pid: process.pid, port: 43_002, token: 'newer' })

    const discovered = await discoverPortFile(dir)
    expect(discovered).not.toBeNull()
    expect(discovered?.pid).toBe(process.pid)
    expect(discovered?.port).toBe(43_002)
    expect(discovered?.token).toBe('newer')

    expect(await discoverPortFile(dir, 99_999_999)).toBeNull()
  })

  it('removes malformed and stale-process entries during discovery', async () => {
    const malformed = join(dir, 'port-11111111.json')
    const stale = join(dir, 'port-99999999.json')
    await writePortFile(dir, { pid: process.pid, port: 44_001, token: 'live' })
    // `port-99999999.json` is a parseable file but the PID is not alive
    // (no process with that PID exists on a test machine). It must be
    // evicted by discovery.
    await writeFile(
      stale,
      JSON.stringify({ pid: 99_999_999, port: 44_002, token: 'stale' }),
      { mode: 0o600 },
    )
    // `port-11111111.json` is malformed JSON — must be evicted.
    await writeFile(malformed, '{nope', { mode: 0o600 })

    const discovered = await discoverPortFile(dir)
    expect(discovered).not.toBeNull()
    expect(discovered?.pid).toBe(process.pid)
    expect(discovered?.port).toBe(44_001)
    expect(discovered?.token).toBe('live')

    const remaining = (await readdir(dir)).sort()
    expect(remaining).toEqual([`port-${process.pid}.json`])
  })

  it('never treats the ephemeral port as the server PID', async () => {
    const port = process.pid === 50_001 ? 50_002 : 50_001
    await writePortFile(dir, { pid: process.pid, port, token: 'secret' })

    expect(await discoverPortFile(dir, port)).toBeNull()
    const discovered = await discoverPortFile(dir, process.pid)
    expect(discovered).not.toBeNull()
    expect(discovered?.pid).toBe(process.pid)
    expect(discovered?.port).toBe(port)
    expect(discovered?.token).toBe('secret')
  })

  it('returns null when the directory is missing', async () => {
    const emptyParent = await mkdtemp(join(tmpdir(), 'agy-port-file-missing-'))
    const missing = join(emptyParent, 'does-not-exist')
    expect(await discoverPortFile(missing)).toBeNull()
    await rm(emptyParent, { recursive: true, force: true })
  })
})
