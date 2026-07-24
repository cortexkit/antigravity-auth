import { execFile } from 'node:child_process'
import { createInterface } from 'node:readline/promises'
import { promisify } from 'node:util'

import type {
  AccountMetadataV3,
  AccountQuotaResult,
  AccountStorageV4,
} from '@cortexkit/antigravity-auth-core'
import { authorizeAntigravity, exchangeAntigravity } from './antigravity/oauth'
import {
  type AntigravityTokenExchangeSuccess,
  type OAuthLoginRequest,
  performOAuthLogin,
} from './plugin/oauth-login'
import { persistAccountPool } from './plugin/persist-account-pool'
import { checkAccountsQuotaStandalone } from './plugin/quota'
import { startOAuthListener } from './plugin/server'
import { loadAccounts } from './plugin/storage'

interface WritableOutput {
  write(value: string): unknown
}

export interface CliDependencies {
  stdout: WritableOutput
  stderr: WritableOutput
  prompt(message: string): Promise<string>
  openBrowser(url: string): Promise<void>
  isHeadless?(): boolean
  performLogin(
    request: OAuthLoginRequest,
    openBrowser: (url: string) => Promise<void>,
  ): Promise<AntigravityTokenExchangeSuccess>
  loadAccounts(): Promise<AccountStorageV4 | null>
  getQuota(
    accounts: AccountMetadataV3[],
    options: { refresh: boolean },
  ): Promise<AccountQuotaResult[]>
}

const HELP = `Usage: antigravity-auth <command> [options]

Commands:
  login [--project <id>] [--no-browser]
  list [--json]
  quota [--json] [--refresh]

Options:
  --help  Show help
`

type ParsedCommand =
  | { command: 'help' }
  | { command: 'login'; projectId?: string; noBrowser: boolean }
  | { command: 'list'; json: boolean }
  | { command: 'quota'; json: boolean; refresh: boolean }

type ParseResult =
  | { ok: true; value: ParsedCommand }
  | { ok: false; error: string }

function parseArgs(argv: string[]): ParseResult {
  const [command, ...args] = argv
  if (command === '--help') {
    return args.length === 0
      ? { ok: true, value: { command: 'help' } }
      : { ok: false, error: `Unknown argument: ${args[0]}` }
  }
  if (!command) return { ok: false, error: 'Missing command' }

  if (command === 'login') {
    let projectId: string | undefined
    let noBrowser = false
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index]
      if (arg === '--no-browser') {
        noBrowser = true
        continue
      }
      if (arg === '--project') {
        const value = args[index + 1]
        if (!value || value.startsWith('--')) {
          return { ok: false, error: 'Missing value for --project' }
        }
        projectId = value
        index += 1
        continue
      }
      return { ok: false, error: `Unknown option for login: ${arg}` }
    }
    return { ok: true, value: { command, projectId, noBrowser } }
  }

  if (command === 'list') {
    let json = false
    for (const arg of args) {
      if (arg === '--json') json = true
      else return { ok: false, error: `Unknown option for list: ${arg}` }
    }
    return { ok: true, value: { command, json } }
  }

  if (command === 'quota') {
    let json = false
    let refresh = false
    for (const arg of args) {
      if (arg === '--json') json = true
      else if (arg === '--refresh') refresh = true
      else return { ok: false, error: `Unknown option for quota: ${arg}` }
    }
    return { ok: true, value: { command, json, refresh } }
  }

  return { ok: false, error: `Unknown command: ${command}` }
}

function accountStatus(account: AccountMetadataV3): string {
  if (account.enabled === false) return 'disabled'
  if (account.accountIneligible) return 'ineligible'
  if (account.verificationRequired) return 'verification-required'
  return 'active'
}

function accountSummary(storage: AccountStorageV4 | null) {
  return {
    accounts: (storage?.accounts ?? []).map((account, index) => ({
      index: index + 1,
      email: account.email ?? `Account ${index + 1}`,
      status: accountStatus(account),
    })),
  }
}

function formatTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => row[column]?.length ?? 0)),
  )
  const formatRow = (row: string[]) =>
    row
      .map((value, column) =>
        column === row.length - 1
          ? value
          : value.padEnd((widths[column] ?? value.length) + 2),
      )
      .join('')
  return `${[formatRow(headers), ...rows.map(formatRow)].join('\n')}\n`
}

function quotaSummary(results: AccountQuotaResult[]) {
  return {
    accounts: results.map((result) => ({
      index: result.index + 1,
      email: result.email ?? `Account ${result.index + 1}`,
      status: result.status,
      ...(result.error ? { error: result.error } : {}),
      groups: Object.entries(result.quota?.groups ?? {}).map(
        ([name, group]) => ({
          name,
          ...(typeof group.remainingFraction === 'number'
            ? { remainingPercent: group.remainingFraction * 100 }
            : {}),
          ...(group.resetTime ? { resetTime: group.resetTime } : {}),
        }),
      ),
    })),
  }
}

function formatQuotaTable(results: AccountQuotaResult[]): string {
  const rows: string[][] = []
  for (const account of quotaSummary(results).accounts) {
    if (account.groups.length === 0) {
      rows.push([account.email, account.status, '-', '-', account.error ?? '-'])
      continue
    }
    for (const group of account.groups) {
      rows.push([
        account.email,
        account.status,
        group.name,
        group.remainingPercent === undefined
          ? '-'
          : `${group.remainingPercent}%`,
        group.resetTime ?? '-',
      ])
    }
  }
  return formatTable(['ACCOUNT', 'STATUS', 'GROUP', 'REMAINING', 'RESET'], rows)
}

export async function runCli(
  argv: string[],
  deps: CliDependencies,
): Promise<number> {
  const parsed = parseArgs(argv)
  if (!parsed.ok) {
    deps.stderr.write(`${parsed.error}\n`)
    return 2
  }

  if (parsed.value.command === 'help') {
    deps.stdout.write(HELP)
    return 0
  }

  try {
    if (parsed.value.command === 'login') {
      const result = await deps.performLogin(
        {
          projectId: parsed.value.projectId,
          noBrowser: parsed.value.noBrowser,
          isHeadless: deps.isHeadless?.() ?? false,
          refreshAccountIndex: undefined,
          accounts: [],
          startFresh: true,
        },
        deps.openBrowser,
      )
      deps.stdout.write(
        `Authenticated ${result.email ?? 'Antigravity account'}\n`,
      )
      return 0
    }

    const storage = await deps.loadAccounts()
    if (parsed.value.command === 'list') {
      const summary = accountSummary(storage)
      deps.stdout.write(
        parsed.value.json
          ? `${JSON.stringify(summary)}\n`
          : formatTable(
              ['INDEX', 'EMAIL', 'STATUS'],
              summary.accounts.map((account) => [
                String(account.index),
                account.email,
                account.status,
              ]),
            ),
      )
      return 0
    }

    const results = await deps.getQuota(storage?.accounts ?? [], {
      refresh: parsed.value.refresh,
    })
    deps.stdout.write(
      parsed.value.json
        ? `${JSON.stringify(quotaSummary(results))}\n`
        : formatQuotaTable(results),
    )
    return 0
  } catch (error) {
    deps.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    )
    return 1
  }
}

const execFileAsync = promisify(execFile)

async function openBrowserDefault(url: string): Promise<void> {
  if (process.platform === 'win32') {
    await execFileAsync('cmd', ['/c', 'start', '', url])
    return
  }
  await execFileAsync(process.platform === 'darwin' ? 'open' : 'xdg-open', [
    url,
  ])
}

export function createDefaultCliDependencies(): CliDependencies {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    prompt: async (message) => {
      const readline = createInterface({
        input: process.stdin,
        output: process.stdout,
      })
      try {
        return (await readline.question(message)).trim()
      } finally {
        readline.close()
      }
    },
    openBrowser: openBrowserDefault,
    isHeadless: () =>
      Boolean(
        process.env.SSH_CONNECTION ||
          process.env.SSH_CLIENT ||
          process.env.SSH_TTY ||
          process.env.OPENCODE_HEADLESS,
      ),
    performLogin: async (request, openBrowser) =>
      performOAuthLogin(request, {
        authorize: authorizeAntigravity,
        exchange: exchangeAntigravity,
        startListener: startOAuthListener,
        openBrowser,
        upsert: async (result) => {
          await persistAccountPool(
            [result],
            request.startFresh && request.accounts.length === 0,
          )
        },
      }),
    loadAccounts,
    getQuota: (accounts, options) =>
      checkAccountsQuotaStandalone(accounts, options),
  }
}

if (import.meta.main) {
  process.exitCode = await runCli(
    process.argv.slice(2),
    createDefaultCliDependencies(),
  )
}

export { performOAuthLogin }
