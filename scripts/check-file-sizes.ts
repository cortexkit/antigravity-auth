import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const LINE_LIMIT = 5_000
const root = resolve(import.meta.dir, '..')
type Baseline = Readonly<Record<string, number>>
type Finding = {
  kind: 'error' | 'note'
  count: number
  limit: number
  message: string
}

export function isExempt(path: string): boolean {
  return (
    /\.test\.[^/]+$/.test(path) ||
    /(?:^|\/)(?:test|__fixtures__|fixtures|common-auth-embedded)\//.test(path)
  )
}

export function checkFileSize(
  path: string,
  source: string,
  baseline: Baseline,
): Finding | undefined {
  if (isExempt(path)) return undefined
  const count = (source.match(/\n/g) ?? []).length
  const allowed = Object.hasOwn(baseline, path) ? baseline[path] : undefined
  if (allowed !== undefined) {
    if (count > allowed)
      return {
        kind: 'error',
        count,
        limit: allowed,
        message: `baseline growth: ${path}: ${count} lines exceeds baseline ${allowed}`,
      }
    if (count < allowed)
      return {
        kind: 'note',
        count,
        limit: allowed,
        message: `baseline shrink: ${path}: ${count} lines, baseline ${allowed}; ${count < LINE_LIMIT ? 'remove the entry' : 'lower the baseline count'}`,
      }
    return undefined
  }
  if (count >= LINE_LIMIT)
    return {
      kind: 'error',
      count,
      limit: LINE_LIMIT,
      message: `file size limit: ${path}: ${count} lines must be below ${LINE_LIMIT}`,
    }
  return undefined
}

async function main(): Promise<void> {
  const baseline: Baseline = JSON.parse(
    await readFile(join(root, 'scripts/file-size-baseline.json'), 'utf8'),
  )
  const child = Bun.spawn(
    ['git', 'ls-files', '-z', '--', '*.ts', '*.tsx', '*.mjs', '*.js'],
    { cwd: root, stdout: 'pipe', stderr: 'inherit' },
  )
  const output = await new Response(child.stdout).text()
  if ((await child.exited) !== 0) throw new Error('git ls-files failed')
  let errors = 0
  for (const path of output.split('\0').filter(Boolean)) {
    if (isExempt(path)) continue
    const finding = checkFileSize(
      path,
      await readFile(join(root, path), 'utf8'),
      baseline,
    )
    if (finding?.kind === 'error') {
      console.error(finding.message)
      errors++
    } else if (finding) console.log(finding.message)
  }
  if (errors) process.exitCode = 1
  else console.log('File size guard passed')
}

if (import.meta.main) await main()
