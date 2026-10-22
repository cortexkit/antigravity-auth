import { afterEach, expect, mock, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, win32 } from 'node:path'
import {
  runSetup,
  type SetupCallbackContext,
  type SetupHost,
  type SetupIO,
  type SetupPlugin,
} from '../../packages/opencode/src/common-auth-embedded/setup/index.js'
import { cliEnvironment, runSetupWithEnvironment } from './harness.mjs'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function fixture(pathKey: 'Path' | 'PATH') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pi-probe-path-')))
  roots.push(root)
  const windowsRoot = win32.join('C:\\owned-fixture', basename(root))
  const bin = win32.join(windowsRoot, 'bin')
  const files = new Map<string, string>()
  const admitDirectory = (name: string) => {
    const disk = join(root, name)
    mkdirSync(disk, { recursive: true, mode: 0o700 })
    const windows = win32.join(windowsRoot, name)
    files.set(windows, disk)
    return windows
  }
  admitDirectory('bin')
  const home = admitDirectory('home')
  const config = admitDirectory('opencode')
  const native = admitDirectory('pi-native')
  for (const name of ['opencode', 'pi', 'ck']) {
    const disk = join(root, 'bin', `${name}.cmd`)
    writeFileSync(disk, '@echo off\r\necho 1.0.0\r\n', { mode: 0o700 })
    files.set(win32.join(bin, `${name}.cmd`), disk)
  }
  const connection = win32.join(windowsRoot, 'connection.json')
  writeFileSync(join(root, 'connection.json'), '{}', { mode: 0o600 })
  files.set(connection, join(root, 'connection.json'))
  const env = {
    [pathKey]: 'C:\\inherited-tools',
    HOME: home,
    USERPROFILE: home,
    LOCALAPPDATA: win32.join(windowsRoot, 'localappdata'),
    OPENCODE_CONFIG_DIR: config,
    PI_CODING_AGENT_DIR: native,
  }
  const before = { ...env }
  const admitted = cliEnvironment(env, bin)
  const metadata = (path: string) => {
    const disk = files.get(win32.normalize(path))
    return disk && existsSync(disk) ? statSync(disk) : undefined
  }
  const selected: Array<readonly SetupHost[]> = []
  const signIn = mock(async () => {})
  const migrate = mock(async () => {})
  const register = mock(async () => {})
  const beforeSignIn = mock(
    async (_host: SetupHost, context: SetupCallbackContext) => {
      selected.push([...context.hosts])
      throw new Error('selection captured before callbacks')
    },
  )
  const propose = mock(async () => {
    throw new Error('must not enroll')
  })
  let output = ''
  const plugin: SetupPlugin = {
    packages: {
      opencode: '@cortexkit/opencode-antigravity-auth',
      pi: '@cortexkit/pi-antigravity-auth',
    },
    version: '1.0.0',
    displayName: 'Fixture',
    slashCommand: '/fixture',
    vault: {
      connectionFile: connection,
      hosts: {
        opencode: {
          name: 'fixture-opencode',
          paths: {
            stateDir: win32.join(windowsRoot, 'state-opencode'),
            host: 'opencode',
          },
        },
        pi: {
          name: 'fixture-pi',
          paths: { stateDir: win32.join(windowsRoot, 'state-pi'), host: 'pi' },
        },
      },
    },
    beforeSignIn,
    signInLocal: signIn,
    migrate,
    beforeRegister: register,
  }
  // Windows names map only to files in this temporary directory. Commands are
  // simulated; the shared setup detector and host-selection code are not.
  const io: SetupIO = {
    env,
    platform: 'win32',
    home,
    cwd: windowsRoot,
    fs: {
      exists: (path) => Boolean(metadata(path)),
      isDirectory: (path) => metadata(path)?.isDirectory() ?? false,
      isFile: (path) => metadata(path)?.isFile() ?? false,
      isExecutable: (path) => metadata(path)?.isFile() ?? false,
      readText: (path) => {
        const disk = files.get(win32.normalize(path))
        if (!disk) throw new Error('Read outside admitted fixture files')
        return readFileSync(disk, 'utf8')
      },
      realpath: (path) => {
        const disk = files.get(win32.normalize(path))
        if (!disk) throw new Error('Resolve outside admitted fixture files')
        expect(realpathSync(disk).startsWith(root)).toBe(true)
        return win32.normalize(path)
      },
    },
    runner: {
      run: async (file) => {
        if (file === 'tasklist.exe')
          return { exitCode: 0, stdout: '"System","0"\r\n', stderr: '' }
        if (file === 'powershell.exe')
          return {
            exitCode: 0,
            stdout: JSON.stringify({ complete: true, processes: [] }),
            stderr: '',
          }
        if (file === 'cmd.exe')
          return { exitCode: 0, stdout: '1.0.0\r\n', stderr: '' }
        throw new Error(`Unexpected command outside the fixture: ${file}`)
      },
    },
    connect: async () => ({
      close() {},
      enrollPropose: propose,
      enrollPoll: async () => ({ status: 'pending' as const }),
    }),
    terminal: {
      input: {
        isTTY: false,
        setRawMode() {},
        resume() {},
        pause() {},
        on() {},
        removeListener() {},
      },
      output: {
        write: (value) => {
          output += value
        },
      },
    },
  }
  return {
    root,
    env,
    before,
    admitted,
    bin,
    io,
    plugin,
    selected,
    signIn,
    migrate,
    register,
    beforeSignIn,
    propose,
    output: () => output,
  }
}

test('fixture preview environment admits owned launchers and actually selects Pi for both Windows PATH spellings', async () => {
  for (const key of ['Path', 'PATH'] as const) {
    const f = fixture(key)
    const result = await runSetup(
      f.plugin,
      ['--yes', '--dry-run', '--no-claustrum', '--opencode=2'],
      { ...f.io, env: f.admitted },
    )
    expect(result.hosts).toEqual(['opencode', 'pi'])
    expect(result.detection.opencode.executable).toBe(
      win32.join(f.bin, 'opencode.cmd'),
    )
    expect(result.detection.pi.executable).toBe(win32.join(f.bin, 'pi.cmd'))
    expect(result.detection.claustrum.executable).toBe(
      win32.join(f.bin, 'ck.cmd'),
    )
    expect(f.output()).not.toContain('Pi: skipped')
    expect(f.beforeSignIn).not.toHaveBeenCalled()
    expect(f.signIn).not.toHaveBeenCalled()
    expect(f.migrate).not.toHaveBeenCalled()
    expect(f.register).not.toHaveBeenCalled()
    expect(f.propose).not.toHaveBeenCalled()
    expect(f.env).toEqual(f.before)
  }
})

test('fixture direct setup uses the admitted PATH and selects Pi before callbacks', async () => {
  for (const key of ['Path', 'PATH'] as const) {
    const f = fixture(key)
    await expect(
      runSetupWithEnvironment(
        runSetup,
        f.plugin,
        ['--yes', '--no-claustrum', '--opencode=2'],
        f.admitted,
        f.io,
      ),
    ).rejects.toThrow('selection captured before callbacks')
    expect(f.selected).toEqual([['opencode', 'pi']])
    expect(f.beforeSignIn).toHaveBeenCalledTimes(1)
    expect(f.signIn).not.toHaveBeenCalled()
    expect(f.register).not.toHaveBeenCalled()
    expect(f.migrate).not.toHaveBeenCalled()
    expect(f.propose).not.toHaveBeenCalled()
    expect(f.output()).not.toContain('Pi: skipped')
    expect(f.env).toEqual(f.before)
  }
})
