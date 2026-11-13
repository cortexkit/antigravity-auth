import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'

async function main() {
  const require = createRequire(import.meta.url)
  const processes =
    require('node:child_process') as typeof import('node:child_process')
  const originalSpawn = processes.spawn
  const [workspace, mode, reportFile] = process.argv.slice(2) as [
    string,
    string,
    string,
  ]
  const children: {
    child: ChildProcess
    command: string
    service: boolean
    closed: boolean
    done: Promise<void>
  }[] = []

  // Observe the real API/CLI native children without replacing their compilation.
  processes.spawn = ((
    command: string,
    args: string[],
    options: SpawnOptions,
  ) => {
    if (
      mode === 'failure' &&
      command === 'bun' &&
      args[0] === 'scripts/build-tui.ts'
    ) {
      command = process.execPath
      args = ['-e', 'process.exit(23)']
    }
    const native = /[/\\]esbuild(?:\.exe)?$/.test(command)
    if (native) {
      // An inherited diagnostic pipe must not make the outer harness wait for a
      // leaked service instead of observing the builder's own exit.
      const stdio = Array.isArray(options.stdio) ? [...options.stdio] : []
      stdio[2] = 'ignore'
      options = { ...options, stdio }
    }
    const child = originalSpawn(command, args, options)
    if (native) {
      const record = {
        child,
        command,
        service: args.some((arg) => arg.startsWith('--service=')),
        closed: false,
        done: Promise.resolve(),
      }
      record.done = new Promise<void>((resolve) =>
        child.once('close', () => {
          record.closed = true
          resolve()
        }),
      )
      children.push(record)
    }
    return child
  }) as typeof processes.spawn
  syncBuiltinESMExports()

  function report(error?: unknown, comparisons?: number) {
    writeFileSync(
      reportFile,
      JSON.stringify({
        builder: process.pid,
        failed: error !== undefined,
        error: error === undefined ? null : String(error),
        comparisons,
        children: children.map(({ child, command, service, closed }) => ({
          pid: child.pid,
          command,
          service,
          closed,
        })),
      }),
    )
  }

  if (mode === 'compare') {
    const { build, stop } = await import('esbuild')
    const { esbuildBinary, esbuildBundleArgs } = await import('../esbuild-cli')
    const { BUNDLE_EXTERNALS } = await import('../build-tui')
    const { runCommand } = await import('../run-command')
    const packageRoot = join(workspace, 'baseline/packages/opencode')
    let comparisons = 0
    try {
      for (const library of [false, true]) {
        for (const [entry, name] of [
          ['index.ts', 'index'],
          ['src/cli.ts', 'cli'],
        ]) {
          const outfile = `dist/${name}.js`
          const external = library ? BUNDLE_EXTERNALS : ['zod']
          const banner = name === 'cli' ? '#!/usr/bin/env node' : undefined
          const result = await runCommand(
            esbuildBinary(),
            esbuildBundleArgs({
              entry: entry!,
              outfile,
              external,
              banner,
              sourcemap: library,
              metafile: library ? `dist/${name}.meta.json` : undefined,
            }),
            { cwd: packageRoot, deadlineMs: 180_000 },
          )
          if (result.status !== 0)
            throw new Error(`CLI comparison failed: ${result.stderr}`)
          const api = await build({
            absWorkingDir: packageRoot,
            entryPoints: [entry!],
            outfile,
            bundle: true,
            platform: 'node',
            format: 'esm',
            external,
            banner: banner === undefined ? undefined : { js: banner },
            sourcemap: library,
            metafile: library,
            write: false,
          })
          for (const output of api.outputFiles!) {
            if (!readFileSync(output.path).equals(Buffer.from(output.contents)))
              throw new Error(`API/CLI bytes differ: ${output.path}`)
            comparisons++
          }
          if (
            library &&
            JSON.stringify(
              JSON.parse(
                readFileSync(
                  join(packageRoot, `dist/${name}.meta.json`),
                  'utf8',
                ),
              ),
            ) !== JSON.stringify(api.metafile)
          )
            throw new Error(`API/CLI metafile differs: ${name}`)
        }
      }
      const services = children.filter(({ service }) => service)
      if (
        services.length !== 1 ||
        services.some(
          ({ command }) =>
            realpathSync(command) !== realpathSync(esbuildBinary()),
        )
      )
        throw new Error(
          'API and CLI did not use the same native esbuild binary',
        )
      report(undefined, comparisons)
    } finally {
      for (const { child, closed } of children) if (!closed) child.ref()
      await stop()
      await Promise.all(children.map(({ done }) => done))
    }
  } else {
    let failure: unknown
    try {
      const { baseline } = await import('../smoke-tui-pack-install')
      await baseline(workspace)
    } catch (error) {
      failure = error
    }
    // Freeze only services the builder left alive. This makes the EOF/exit race
    // deterministic: the owner can exit, but a leaked child cannot race our check.
    for (const { child, service, closed } of children)
      if (service && !closed) child.kill('SIGSTOP')
    report(failure)
    process.exit(0)
  }
}

if (import.meta.main) await main()
