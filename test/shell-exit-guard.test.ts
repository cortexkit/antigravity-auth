import { expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { runCommand } from './support/run-command.ts'

/**
 * macOS /bin/bash 3.2 runs an EXIT trap with status 0 when `set -u` stops a
 * script under `set -e`, so a script that never reached its end exits 0 and
 * reports success. Linux CI runs bash 5, which exits nonzero, so only a
 * local run on a Mac shows the problem.
 *
 * Every tracked shell script that combines errexit with an EXIT trap must
 * therefore use the fail-closed form: the trap keeps a failing status and
 * turns a 0 into 1 unless the script set `finished=1` just before its
 * intended successful end. This guard refuses a script that lacks it.
 */
const root = resolve(import.meta.dir, '..')

const ERREXIT = /^\s*set\s+(?:-[a-zA-Z]*e[a-zA-Z]*\b|-o\s+errexit\b)/m
const EXIT_TRAP = /^\s*trap\s+.*\bEXIT\b/m
// The success marker and a trap that reads it.
const FINISHED_SET = /^\s*finished=1\s*$/m
const FINISHED_READ = /"\$finished"\s+-ne\s+1/

function failsOpen(source: string): boolean {
  if (!ERREXIT.test(source) || !EXIT_TRAP.test(source)) return false
  return !(FINISHED_SET.test(source) && FINISHED_READ.test(source))
}

function isShellScript(path: string, source: string): boolean {
  return (
    path.endsWith('.sh') ||
    /^#!\s*(?:\/usr\/bin\/env\s+bash|\/bin\/bash)\b/.test(source)
  )
}

test('no tracked shell script combines errexit and an EXIT trap without the fail-closed guard', async () => {
  const listed = await runCommand(['git', 'ls-files', '-z'], {
    cwd: root,
    env: {
      ...process.env,
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'safe.directory',
      GIT_CONFIG_VALUE_0: root,
    },
    deadlineMs: 10_000,
  })
  expect(listed.exitCode, listed.stderr).toBe(0)
  const candidates = listed.stdout
    .split('\0')
    .filter((path) => path && !path.includes('/common-auth-embedded/'))
    .filter((path) => /\.(?:sh|bash)$/.test(path) || !/\.[^/]+$/.test(path))
  const scripts: string[] = []
  const offenders: string[] = []
  for (const path of candidates) {
    let source: string
    try {
      source = await readFile(join(root, path), 'utf8')
    } catch {
      continue
    }
    if (!isShellScript(path, source)) continue
    scripts.push(path)
    if (failsOpen(source)) offenders.push(path)
  }
  // A broken file listing must not pass as "no offenders".
  expect(scripts).toContain('scripts/prepush.sh')
  expect(scripts).toContain('packages/e2e-tests/docker/run-opencode-ga-test.sh')
  expect(offenders).toEqual([])
}, 20_000)

test('the guard refuses the fail-open shapes and accepts the guarded one', () => {
  const unsafe = [
    'set -euo pipefail\ntrap \'rm -rf "$D"\' EXIT\nrun\n',
    'set -e\ntrap cleanup EXIT\nrun\n',
    'set -o errexit\nset -u\ntrap cleanup EXIT\n',
    // The marker without a trap that reads it still fails open.
    'set -euo pipefail\ntrap \'rm -rf "$D"\' EXIT\nrun\nfinished=1\n',
  ]
  for (const source of unsafe) expect(failsOpen(source)).toBe(true)

  const guarded = [
    'set -euo pipefail',
    'finished=0',
    'cleanup() {',
    '  local status=$?',
    '  if [[ "$status" -eq 0 && "$finished" -ne 1 ]]; then status=1; fi',
    '  exit "$status"',
    '}',
    'trap cleanup EXIT',
    'run',
    'finished=1',
    '',
  ].join('\n')
  expect(failsOpen(guarded)).toBe(false)
  // No trap, or no errexit: bash 3.2 exits nonzero, so nothing to guard.
  expect(failsOpen('set -euo pipefail\nrun\n')).toBe(false)
  expect(failsOpen('set -u\ntrap cleanup EXIT\nrun\n')).toBe(false)
})
