import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { checkReleaseCi } from '../scripts/check-release-ci.ts'

const headSha = 'a'.repeat(40)
const otherSha = 'b'.repeat(40)
const workflowFiles = ['ci.yml', 'windows-migration.yml']

type Run = {
  headSha: string
  status: string
  conclusion: string | null
}

function checkWithRuns(
  runsByWorkflow: Record<string, Run[]>,
  options: { authExitCode?: number; listExitCode?: number } = {},
) {
  const calls: string[][] = []
  const error = checkReleaseCi(headSha, (args) => {
    calls.push(args)
    if (args[0] === 'auth') {
      return {
        exitCode: options.authExitCode ?? 0,
        stdout: '',
        stderr: 'authentication required',
      }
    }
    const workflow = args[args.indexOf('--workflow') + 1] ?? ''
    return {
      exitCode: options.listExitCode ?? 0,
      stdout: JSON.stringify(runsByWorkflow[workflow] ?? []),
      stderr: 'workflow query failed',
    }
  })
  return { error, calls }
}

const success: Run = {
  headSha,
  status: 'completed',
  conclusion: 'success',
}

function allSuccessful(): Record<string, Run[]> {
  return Object.fromEntries(workflowFiles.map((file) => [file, [success]]))
}

test('release CI check accepts both workflows successful on the exact full SHA', () => {
  const { error, calls } = checkWithRuns(allSuccessful())
  expect(error).toBeNull()
  expect(calls).toHaveLength(3)
  for (const file of workflowFiles) {
    expect(calls.some((args) => args.includes(file))).toBe(true)
    const query = calls.find((args) => args.includes(file))
    expect(query).toContain(headSha)
    expect(query).toContain('headSha,status,conclusion')
  }
})

test('release CI check refuses a missing workflow run', () => {
  const { error } = checkWithRuns({
    'ci.yml': [success],
    'windows-migration.yml': [],
  })
  expect(error).toContain('windows-migration.yml')
  expect(error).toContain('no runs were returned')
})

test('release CI check refuses an in-progress workflow run', () => {
  const pending: Run = {
    headSha,
    status: 'in_progress',
    conclusion: null,
  }
  const { error } = checkWithRuns({
    'ci.yml': [pending],
    'windows-migration.yml': [success],
  })
  expect(error).not.toBeNull()
  expect(error).toContain('ci.yml')
  expect(error).toContain('in_progress')
})

test('release CI check refuses a failed workflow run', () => {
  const failed: Run = {
    headSha,
    status: 'completed',
    conclusion: 'failure',
  }
  const { error } = checkWithRuns({
    'ci.yml': [failed],
    'windows-migration.yml': [success],
  })
  expect(error).toContain('ci.yml')
  expect(error).toContain('completed (failure)')
})

test('release CI check refuses a successful run for a different SHA', () => {
  const { error } = checkWithRuns({
    'ci.yml': [{ ...success, headSha: otherSha }],
    'windows-migration.yml': [success],
  })
  expect(error).toContain('ci.yml')
  expect(error).toContain(otherSha)
  expect(error).toContain(headSha)
})

test('release CI check never accepts a short SHA', () => {
  let called = false
  const error = checkReleaseCi(headSha.slice(0, 7), () => {
    called = true
    return { exitCode: 0, stdout: '[]', stderr: '' }
  })
  expect(called).toBe(false)
  expect(error).toContain('full 40-character HEAD SHA')
})

test('release CI check refuses GitHub CLI errors', () => {
  const unauthenticated = checkWithRuns(allSuccessful(), { authExitCode: 1 })
  expect(unauthenticated.error).toContain('not authenticated')
  expect(unauthenticated.calls).toHaveLength(1)

  const queryFailure = checkWithRuns(allSuccessful(), { listExitCode: 1 })
  expect(queryFailure.error).toContain('ci.yml')
  expect(queryFailure.error).toContain('gh run list failed')

  const missingCli = checkReleaseCi(headSha, () => {
    throw new Error('spawn gh ENOENT')
  })
  expect(missingCli).toContain('GitHub CLI is unavailable or not authenticated')
  expect(missingCli).toContain('ENOENT')
})

test('release.sh tag path checks CI without running local build or test commands', () => {
  const source = readFileSync(
    resolve(import.meta.dir, '../scripts/release.sh'),
    'utf8',
  )
  const prepareMessage = 'echo "Prepared $TAG. No gate, tag or push was run."'
  const prepareMessageIndex = source.indexOf(prepareMessage)
  expect(prepareMessageIndex).toBeGreaterThanOrEqual(0)
  const prepareEnd = source.indexOf('\nfi\n', prepareMessageIndex)
  expect(prepareEnd).toBeGreaterThanOrEqual(0)
  const tagPath = source.slice(prepareEnd + '\nfi\n'.length)

  expect(tagPath).not.toMatch(/\bbun\s+(?:run\s+)?(?:test|build|typecheck)\b/)
  expect(tagPath).not.toMatch(/\bbun\s+install\b/)
  const ciCheck = tagPath.indexOf('bun scripts/check-release-ci.ts')
  const tag = tagPath.indexOf('git tag -a')
  expect(ciCheck).toBeGreaterThanOrEqual(0)
  expect(ciCheck).toBeLessThan(tag)
})
