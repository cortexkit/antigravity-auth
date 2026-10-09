#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  PUBLIC_CONSUMER_ENV,
  provisionPublicConsumer,
  publicFixtureBytes,
} from '../packages/core/src/__fixtures__/common-auth-public-consumer.test.ts'
import { prepareLegacyWriter } from '../packages/core/src/__fixtures__/legacy-writer.test.ts'

const DEADLINE_MS = 20 * 60_000
const REAP_MS = 5_000
const OUTPUT_CAP_BYTES = 8 * 1024 * 1024

// Usage: bun scripts/prepare-common-auth-public-consumer.ts <command> [args...]
// Both fixture variables name the same process-created directory. Every package
// member is checked against the fixed published archive before tests can use it.
async function main(): Promise<number> {
  const [command, ...args] = process.argv.slice(2)
  if (!command) throw new Error('explicit test command required')
  const fixture = await provisionPublicConsumer()
  let reaped = true
  try {
    const oldDistRoot = await prepareLegacyWriter(fixture.root)
    for (const directory of [
      'home',
      'tmp',
      'config',
      'cache',
      'state',
      'data',
      'pi',
      'opencode',
    ])
      await mkdir(join(fixture.root, directory), { mode: 0o700 })
    console.log(
      JSON.stringify({ publicConsumer: fixture.root, ...fixture.receipt }),
    )
    console.log(
      (
        await publicFixtureBytes(
          join(oldDistRoot, 'legacy-writer-receipt.json'),
        )
      ).toString(),
    )
    const child = spawn(command === 'bun' ? process.execPath : command, args, {
      cwd: process.cwd(),
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH,
        HOME: join(fixture.root, 'home'),
        USERPROFILE: join(fixture.root, 'home'),
        TMPDIR: join(fixture.root, 'tmp'),
        TMP: join(fixture.root, 'tmp'),
        TEMP: join(fixture.root, 'tmp'),
        XDG_CONFIG_HOME: join(fixture.root, 'config'),
        XDG_CACHE_HOME: join(fixture.root, 'cache'),
        XDG_STATE_HOME: join(fixture.root, 'state'),
        XDG_DATA_HOME: join(fixture.root, 'data'),
        PI_AGENT_DIR: join(fixture.root, 'pi'),
        OPENCODE_CONFIG_DIR: join(fixture.root, 'opencode'),
        OPENCODE_DB: join(fixture.root, 'opencode.db'),
        [PUBLIC_CONSUMER_ENV]: fixture.root,
        ACCOUNT_MIGRATION_PUBLIC_INPUT_ROOT: fixture.root,
        ACCOUNT_MIGRATION_OLD_DIST_ROOT: oldDistRoot,
        LANG: 'C',
        LC_ALL: 'C',
        TZ: 'UTC',
        NO_COLOR: '1',
      },
    })
    const ownedPid = child.pid
    reaped = ownedPid === undefined
    let failed: string | undefined
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const signal = (kind: NodeJS.Signals) => {
      if (reaped || ownedPid === undefined || child.pid !== ownedPid) return
      try {
        process.kill(-ownedPid, kind)
      } catch (error) {
        if (
          !(error instanceof Error && 'code' in error && error.code === 'ESRCH')
        )
          throw error
      }
    }
    const stop = (reason: string) => {
      if (failed) return
      failed = reason
      signal('SIGTERM')
      killTimer = setTimeout(() => signal('SIGKILL'), 1_000)
    }
    for (const [input, output] of [
      [child.stdout, process.stdout],
      [child.stderr, process.stderr],
    ] as const) {
      let bytes = 0
      input.on('data', (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes <= OUTPUT_CAP_BYTES) output.write(chunk)
        else stop('test command output cap exceeded')
      })
      input.on('error', () => stop('test command output pipe failed'))
    }
    const deadline = setTimeout(
      () => stop('test command execution deadline exceeded'),
      DEADLINE_MS,
    )
    let reapDeadline: ReturnType<typeof setTimeout> | undefined
    try {
      const status = await new Promise<number>((resolve, reject) => {
        child.once('exit', () => {
          reaped = true
        })
        child.once('error', reject)
        child.once('close', (code) => resolve(code ?? 1))
        // A pipe held open by a descendant must not keep the wrapper waiting forever.
        reapDeadline = setTimeout(() => {
          child.stdout.destroy()
          child.stderr.destroy()
          reject(new Error('test command reap/pipe deadline exceeded'))
        }, DEADLINE_MS + REAP_MS)
      })
      if (failed) throw new Error(failed)
      return status
    } finally {
      clearTimeout(deadline)
      clearTimeout(killTimer)
      clearTimeout(reapDeadline)
    }
  } finally {
    if (reaped) await fixture.remove()
    else
      console.error(
        `Unconfirmed test child exit; retained owned fixture ${fixture.root}`,
      )
  }
}

if (import.meta.main) {
  try {
    process.exitCode = await main()
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  }
}
