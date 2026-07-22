import { spawn } from 'node:child_process'
import {
  lstatSync,
  mkdirSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BUN_COMMAND = process.platform === 'win32' ? 'bun.exe' : 'bun'
const OPENCODE_EXTERNALS = [
  '--external:@openauthjs/*',
  '--external:zod',
] as const

export interface DevPaths {
  root: string
  pluginDirectory: string
  pluginPath: string
  relativeTarget: string
  targetPath: string
}

export function resolveDevPaths(root = PROJECT_ROOT): DevPaths {
  const projectRoot = resolve(root)
  const pluginDirectory = join(projectRoot, '.opencode', 'plugins')
  const pluginPath = join(pluginDirectory, 'antigravity-auth.js')
  const targetPath = join(
    projectRoot,
    'packages',
    'opencode',
    'dist',
    'index.js',
  )
  const relativeTarget = relative(pluginDirectory, targetPath)
    .split(sep)
    .join('/')

  return {
    root: projectRoot,
    pluginDirectory,
    pluginPath,
    relativeTarget,
    targetPath,
  }
}

function pointsToTarget(paths: DevPaths): boolean {
  try {
    return (
      resolve(dirname(paths.pluginPath), readlinkSync(paths.pluginPath)) ===
      paths.targetPath
    )
  } catch {
    return false
  }
}

export function createDevSymlink(paths = resolveDevPaths()): void {
  mkdirSync(paths.pluginDirectory, { recursive: true })

  try {
    const existing = lstatSync(paths.pluginPath)
    if (existing.isDirectory()) {
      throw new Error(`[dev] cannot replace directory at ${paths.pluginPath}`)
    }
    if (existing.isSymbolicLink() && !pointsToTarget(paths)) {
      throw new Error(
        `[dev] refusing to replace an unrelated symlink at ${paths.pluginPath}`,
      )
    }
    unlinkSync(paths.pluginPath)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      // The known plugin path is optional until the first development build.
    } else if (error instanceof Error && error.message.startsWith('[dev]')) {
      throw error
    } else {
      throw error
    }
  }

  symlinkSync(paths.relativeTarget, paths.pluginPath, 'file')
}

export function removeDevSymlink(paths = resolveDevPaths()): boolean {
  try {
    const existing = lstatSync(paths.pluginPath)
    if (!existing.isSymbolicLink() || !pointsToTarget(paths)) {
      return false
    }
    unlinkSync(paths.pluginPath)
    return true
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return false
    }
    throw error
  }
}

function runCommand(
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<void> {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: 'inherit',
    })

    child.once('error', rejectCommand)
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolveCommand()
        return
      }
      rejectCommand(
        new Error(
          `[dev] ${command} ${args.join(' ')} exited with ${
            signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`
          }`,
        ),
      )
    })
  })
}

function spawnWatchers(paths: DevPaths): Promise<void> {
  const coreWatcher = spawn(
    BUN_COMMAND,
    ['x', 'tsc', '--watch', '-p', 'tsconfig.build.json'],
    {
      cwd: join(paths.root, 'packages', 'core'),
      env: process.env,
      stdio: 'inherit',
    },
  )
  const opencodeWatcher = spawn(
    BUN_COMMAND,
    [
      'x',
      'esbuild',
      'index.ts',
      '--bundle',
      '--platform=node',
      '--format=esm',
      ...OPENCODE_EXTERNALS,
      '--outfile=dist/index.js',
      '--sourcemap',
      '--watch',
    ],
    {
      cwd: join(paths.root, 'packages', 'opencode'),
      env: process.env,
      stdio: 'inherit',
    },
  )
  const children = [coreWatcher, opencodeWatcher]

  return new Promise((resolveWatchers, rejectWatchers) => {
    let settled = false

    const cleanup = () => {
      for (const child of children) {
        if (child.exitCode === null && !child.killed) {
          child.kill('SIGTERM')
        }
      }
      removeDevSymlink(paths)
    }

    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      cleanup()
      process.off('SIGINT', onSignal)
      process.off('SIGTERM', onSignal)
      if (error) {
        rejectWatchers(error)
      } else {
        resolveWatchers()
      }
    }

    const onSignal = () => finish()
    const onExit = (
      name: string,
      code: number | null,
      signal: NodeJS.Signals | null,
    ) => {
      if (code === 0 && signal === null) {
        finish()
        return
      }
      finish(
        new Error(
          `[dev] ${name} watcher exited with ${signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`}`,
        ),
      )
    }
    const onError = (name: string, error: Error) =>
      finish(new Error(`[dev] ${name} watcher failed: ${error.message}`))

    process.once('SIGINT', onSignal)
    process.once('SIGTERM', onSignal)
    coreWatcher.once('exit', (code, signal) => onExit('core', code, signal))
    opencodeWatcher.once('exit', (code, signal) =>
      onExit('opencode', code, signal),
    )
    coreWatcher.once('error', (error) => onError('core', error))
    opencodeWatcher.once('error', (error) => onError('opencode', error))
  })
}

async function main(argv = process.argv.slice(2)): Promise<void> {
  const check = argv.includes('--check')
  const unknownArgs = argv.filter((arg) => arg !== '--check')
  if (unknownArgs.length > 0) {
    throw new Error(`[dev] unknown argument: ${unknownArgs[0]}`)
  }

  const paths = resolveDevPaths()
  console.log('[dev] building core')
  await runCommand(
    BUN_COMMAND,
    ['run', '--cwd', 'packages/core', 'build'],
    paths.root,
  )
  console.log('[dev] building opencode')
  await runCommand(
    BUN_COMMAND,
    ['run', '--cwd', 'packages/opencode', 'build'],
    paths.root,
  )

  createDevSymlink(paths)
  if (check) {
    if (!pointsToTarget(paths)) {
      throw new Error(`[dev] symlink target mismatch at ${paths.pluginPath}`)
    }
    removeDevSymlink(paths)
    console.log('[dev] check passed')
    return
  }

  await spawnWatchers(paths)
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
