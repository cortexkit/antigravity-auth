type GhResult = {
  exitCode: number
  stdout: string
  stderr: string
}

type GhRunner = (args: string[]) => GhResult

type WorkflowRun = {
  headSha?: unknown
  status?: unknown
  conclusion?: unknown
}

const workflows = ['ci.yml', 'windows-migration.yml'] as const

function runGh(args: string[]): GhResult {
  const result = Bun.spawnSync(['gh', ...args])
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }
}

function fullSha(value: string): boolean {
  return /^[0-9a-f]{40}$/i.test(value)
}

function isSuccessfulRun(run: WorkflowRun, headSha: string): boolean {
  return (
    typeof run.headSha === 'string' &&
    run.headSha.toLowerCase() === headSha.toLowerCase() &&
    run.status === 'completed' &&
    run.conclusion === 'success'
  )
}

function describeRuns(runs: WorkflowRun[]): string {
  if (runs.length === 0) return 'no runs were returned'
  return runs
    .map((run) => {
      const sha =
        typeof run.headSha === 'string' ? run.headSha : 'unknown commit'
      const status =
        typeof run.status === 'string' ? run.status : 'unknown status'
      const conclusion =
        typeof run.conclusion === 'string' ? ` (${run.conclusion})` : ''
      return `${sha}: ${status}${conclusion}`
    })
    .join('; ')
}

function errorText(result: GhResult): string {
  return result.stderr.trim() || result.stdout.trim() || 'no details provided'
}

export function checkReleaseCi(
  headSha: string,
  runner: GhRunner = runGh,
): string | null {
  if (!fullSha(headSha)) {
    return 'Error: release CI verification requires the full 40-character HEAD SHA.'
  }

  let auth: GhResult
  try {
    auth = runner(['auth', 'status'])
  } catch (error) {
    return `Error: GitHub CLI is unavailable or not authenticated: ${String(error)}`
  }
  if (auth.exitCode !== 0) {
    return `Error: GitHub CLI is unavailable or not authenticated: ${errorText(auth)}`
  }

  for (const workflow of workflows) {
    let result: GhResult
    try {
      result = runner([
        'run',
        'list',
        '--workflow',
        workflow,
        '--commit',
        headSha,
        '--json',
        'headSha,status,conclusion',
      ])
    } catch (error) {
      return `Error: could not verify ${workflow}: GitHub CLI failed: ${String(error)}`
    }
    if (result.exitCode !== 0) {
      return `Error: could not verify ${workflow}: gh run list failed: ${errorText(result)}`
    }

    let runs: WorkflowRun[]
    try {
      const parsed: unknown = JSON.parse(result.stdout)
      if (!Array.isArray(parsed)) throw new Error('expected a JSON array')
      runs = parsed.filter(
        (value): value is WorkflowRun =>
          typeof value === 'object' && value !== null,
      )
    } catch (error) {
      return `Error: could not verify ${workflow}: gh returned invalid run data: ${String(error)}`
    }

    const matchingRuns = runs.filter(
      (run) =>
        typeof run.headSha === 'string' &&
        run.headSha.toLowerCase() === headSha.toLowerCase(),
    )
    if (matchingRuns.some((run) => isSuccessfulRun(run, headSha))) continue

    return `Error: ${workflow} has no successful completed run for HEAD ${headSha}; found ${describeRuns(matchingRuns.length ? matchingRuns : runs)}.`
  }

  return null
}

function main(): number {
  const head = Bun.spawnSync(['git', 'rev-parse', 'HEAD'])
  if (head.exitCode !== 0) {
    console.error(
      `Error: could not read HEAD: ${head.stderr.toString().trim() || 'git rev-parse failed'}`,
    )
    return 1
  }
  const headSha = head.stdout.toString().trim()
  console.log(`Checking GitHub Actions results for HEAD ${headSha}...`)
  const error = checkReleaseCi(headSha)
  if (error) {
    console.error(error)
    return 1
  }
  console.log('✓ CI and Windows account migration workflows succeeded on HEAD.')
  return 0
}

if (import.meta.main) process.exitCode = main()
