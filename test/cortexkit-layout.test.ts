import { afterEach, expect, test } from 'bun:test'
import {
  appendFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runCommand } from './support/run-command.ts'

const sourceRoot = resolve(import.meta.dir, '..')
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

async function command(root: string, ...argv: string[]) {
  return runCommand(argv, { cwd: root, deadlineMs: 10_000 })
}

async function git(root: string, ...args: string[]) {
  const result = await command(root, 'git', ...args)
  expect(result.exitCode, result.stderr).toBe(0)
  return result.stdout
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cortexkit-layout-'))
  roots.push(root)
  mkdirSync(join(root, 'scripts'))
  cpSync(join(sourceRoot, '.gitignore'), join(root, '.gitignore'))
  cpSync(
    join(sourceRoot, 'scripts/check-cortexkit-layout.sh'),
    join(root, 'scripts/check-cortexkit-layout.sh'),
  )
  await git(root, 'init')
  return root
}

async function check(root: string) {
  return command(root, 'bash', 'scripts/check-cortexkit-layout.sh')
}

test('rejects a tracked private path even when a stray rule un-ignores it', async () => {
  const root = await fixture()
  mkdirSync(join(root, '.cortexkit/internal-docs'), { recursive: true })
  writeFileSync(join(root, '.cortexkit/internal-docs/x.md'), 'private\n')
  appendFileSync(
    join(root, '.gitignore'),
    '\n!.cortexkit/internal-docs/\n.cortexkit/internal-docs/*\n!.cortexkit/internal-docs/x.md\n',
  )
  await git(root, 'add', '.cortexkit/internal-docs/x.md')

  const old = await command(
    root,
    'git',
    'ls-files',
    '-ci',
    '--exclude-standard',
    '--',
    '.cortexkit',
  )
  expect(old.exitCode, old.stderr).toBe(0)
  expect(old.stdout).toBe('')
  const result = await check(root)
  expect(result.exitCode).toBe(1)
  expect(result.stderr).toContain('.cortexkit/internal-docs/x.md')
})

test('allows tracked public folders, WORKER.md and top-level settings', async () => {
  const root = await fixture()
  for (const path of [
    'WORKER.md',
    'antigravity-auth.jsonc',
    'release-notes/note.md',
    'skills/example/skill.md',
    'rules/example.md',
  ]) {
    const file = join(root, '.cortexkit', path)
    mkdirSync(resolve(file, '..'), { recursive: true })
    writeFileSync(file, 'fixture\n')
    await git(root, 'add', file)
  }
  const result = await check(root)
  expect(result.exitCode, result.stderr).toBe(0)
})

test('ignores machine-specific settings but not other top-level settings', async () => {
  const root = await fixture()
  const machine = await command(
    root,
    'git',
    'check-ignore',
    '-q',
    '--no-index',
    '.cortexkit/prefrontal.jsonc',
  )
  expect(machine.exitCode, machine.stderr).toBe(0)
  const project = await command(
    root,
    'git',
    'check-ignore',
    '-q',
    '--no-index',
    '.cortexkit/antigravity-auth.jsonc',
  )
  expect(project.exitCode, project.stderr).toBe(1)
})

test('reports BLIND when either ignore control is broken', async () => {
  const root = await fixture()
  writeFileSync(join(root, '.gitignore'), '')
  let result = await check(root)
  expect(result.exitCode).toBe(2)
  expect(result.stderr).toContain('BLIND:')
  writeFileSync(join(root, '.gitignore'), '.cortexkit/*\n')
  result = await check(root)
  expect(result.exitCode).toBe(2)
  expect(result.stderr).toContain('BLIND:')
})

test('reports BLIND when git cannot list tracked files', async () => {
  const root = await fixture()
  writeFileSync(join(root, '.git/index'), 'corrupt index')
  const result = await check(root)
  expect(result.exitCode).toBe(2)
  expect(result.stderr).toContain('BLIND: git ls-files failed')
})
