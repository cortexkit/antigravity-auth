import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { promisify } from 'node:util'

import {
  type AccountMetadataV3,
  type AccountMigrationOutcome,
  type AccountQuotaResult,
  type AccountRow,
  type AccountStorageV4,
  createAccountMigrationFactory,
  createAccountRepositoryFactory,
  createAccountRollbackFactory,
  initializeFreshAccountStore,
  loadCommonAuthStoreModules,
  readAccountStoreBinding,
  refreshAntigravityToken,
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
import { getStoragePath, loadAccounts } from './plugin/storage'

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
  /** Offline operations on the account store; see `AccountStoreOperations`. */
  accountStore: AccountStoreOperations
}

/**
 * The offline account-store operations, each bound to the canonical
 * migration module. `migrate` and `rollback` run only after the operator
 * confirmed that every Antigravity process and timer has stopped; `init`
 * creates an empty store only where no account file exists.
 */
export interface AccountStoreOperations {
  /** The absolute path of the pre-store account file the store is derived from. */
  legacyPath(): string
  migrate(legacyPath: string): Promise<AccountMigrationOutcome>
  rollback(legacyPath: string): Promise<AccountMigrationOutcome>
  initialize(legacyPath: string): Promise<AccountMigrationOutcome>
  /** Reads the accounts list and quota show, without writing. */
  read(legacyPath: string): Promise<CliAccountsRead>
}

/**
 * Where `list` and `quota` read accounts from. Once the account store is
 * active the pre-store file is retired, so the store is the only source;
 * before migration (or after a rollback) the pre-store file still is.
 */
export type CliAccountsRead =
  | { kind: 'store'; accounts: AccountMetadataV3[] }
  | { kind: 'legacy' }
  | { kind: 'uninitialized' }
  | { kind: 'unavailable'; reason: string }

const HELP = `Usage: antigravity-auth <command> [options]

Commands:
  login [--project <id>] [--no-browser]
  list [--json]
  quota [--json] [--refresh]
  init
  migrate --offline [--yes]
  rollback --offline [--yes]

migrate moves the account file into the account store; rollback restores
it. Both require --offline: stop every OpenCode and Antigravity process
first. Without --yes you are asked to confirm.

Options:
  --help  Show help
`

type ParsedCommand =
  | { command: 'help' }
  | { command: 'login'; projectId?: string; noBrowser: boolean }
  | { command: 'list'; json: boolean }
  | { command: 'quota'; json: boolean; refresh: boolean }
  | { command: 'init' }
  | { command: 'migrate'; confirmed: boolean }
  | { command: 'rollback'; confirmed: boolean }

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

  if (command === 'init') {
    if (args.length > 0)
      return { ok: false, error: `Unknown option for init: ${args[0]}` }
    return { ok: true, value: { command } }
  }

  if (command === 'migrate' || command === 'rollback') {
    let offline = false
    let confirmed = false
    for (const arg of args) {
      if (arg === '--offline') offline = true
      else if (arg === '--yes') confirmed = true
      else return { ok: false, error: `Unknown option for ${command}: ${arg}` }
    }
    if (!offline) {
      return {
        ok: false,
        error: `${command} runs only offline: stop every OpenCode and Antigravity process, then pass --offline`,
      }
    }
    return { ok: true, value: { command, confirmed } }
  }

  return { ok: false, error: `Unknown command: ${command}` }
}

function describeOutcome(
  operation: string,
  outcome: AccountMigrationOutcome,
): { code: number; text: string } {
  if (outcome.status === 'pending') {
    return {
      code: 1,
      text: `${operation} did not finish (${outcome.reason}); another process holds the account store. Stop it and run the command again.\n`,
    }
  }
  const receipt = outcome.receipt
  const lines = [
    `${operation} completed: generation ${receipt.id} is ${receipt.status}.`,
    `Account store: ${receipt.storeDir}`,
    ...(receipt.restartRequired
      ? ['Restart OpenCode before using Antigravity accounts.']
      : []),
  ]
  return { code: 0, text: `${lines.join('\n')}\n` }
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
    if (parsed.value.command === 'init') {
      const legacyPath = deps.accountStore.legacyPath()
      const outcome = await deps.accountStore.initialize(legacyPath)
      const result = describeOutcome('Initialization', outcome)
      ;(result.code === 0 ? deps.stdout : deps.stderr).write(result.text)
      return result.code
    }

    if (
      parsed.value.command === 'migrate' ||
      parsed.value.command === 'rollback'
    ) {
      const operation = parsed.value.command
      if (!parsed.value.confirmed) {
        const answer = await deps.prompt(
          `${operation === 'migrate' ? 'Migrate' : 'Roll back'} the Antigravity account store? Every OpenCode and Antigravity process must be stopped. Type "yes" to continue: `,
        )
        if (answer.trim().toLowerCase() !== 'yes') {
          deps.stderr.write(`${operation} cancelled; nothing was changed.\n`)
          return 1
        }
      }
      const legacyPath = deps.accountStore.legacyPath()
      const outcome =
        operation === 'migrate'
          ? await deps.accountStore.migrate(legacyPath)
          : await deps.accountStore.rollback(legacyPath)
      const result = describeOutcome(
        operation === 'migrate' ? 'Migration' : 'Rollback',
        outcome,
      )
      ;(result.code === 0 ? deps.stdout : deps.stderr).write(result.text)
      return result.code
    }

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

    const source = await deps.accountStore.read(deps.accountStore.legacyPath())
    if (source.kind === 'unavailable') {
      deps.stderr.write(`Accounts are unavailable: ${source.reason}\n`)
      return 1
    }
    const storage: AccountStorageV4 | null =
      source.kind === 'legacy'
        ? await deps.loadAccounts()
        : source.kind === 'store'
          ? { version: 4, accounts: source.accounts, activeIndex: 0 }
          : null
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
    accountStore: createDefaultAccountStoreOperations(),
  }
}

function present<T>(value: T | null | undefined): T | undefined {
  return value === null ? undefined : value
}

/**
 * One store row in the account shape `list` and `quota` print. Only display
 * fields and what a quota check needs; nothing is written back.
 */
export function cliAccountOf(row: AccountRow): AccountMetadataV3 {
  const metadata =
    row.metadata.status === 'present' ? row.metadata.metadata : undefined
  const groups =
    row.quota.status === 'present' ? row.quota.quota.cachedQuota : undefined
  const cachedQuota: NonNullable<AccountMetadataV3['cachedQuota']> = {}
  for (const [name, group] of Object.entries(groups ?? {})) {
    cachedQuota[name] = {
      modelCount: group.modelCount,
      ...(typeof group.remainingFraction === 'number'
        ? { remainingFraction: group.remainingFraction }
        : {}),
      ...(typeof group.resetTime === 'string'
        ? { resetTime: group.resetTime }
        : {}),
    }
  }
  const email = present(metadata?.email)
  const projectId = present(metadata?.projectId)
  const managedProjectId = present(metadata?.managedProjectId)
  return {
    refreshToken: row.credential?.refreshToken ?? '',
    addedAt: metadata?.addedAt ?? row.storeAddedAt ?? 0,
    lastUsed: metadata?.lastUsed ?? 0,
    enabled: row.enabled,
    ...(email !== undefined ? { email } : {}),
    ...(projectId !== undefined ? { projectId } : {}),
    ...(managedProjectId !== undefined ? { managedProjectId } : {}),
    ...(metadata?.verificationRequired === true
      ? { verificationRequired: true }
      : {}),
    ...(metadata?.accountIneligible === true
      ? { accountIneligible: true }
      : {}),
    ...(Object.keys(cachedQuota).length > 0 ? { cachedQuota } : {}),
  }
}

/**
 * Reads the bound account store's rows; the repository is closed after.
 * Binding opens a completed generation; a store whose own clear or replace
 * work is still pending reads as not ready, which is reported, not shown.
 */
async function readAccountStore(legacyPath: string): Promise<CliAccountsRead> {
  const modules = await loadCommonAuthStoreModules()
  const admission = await readAccountStoreBinding(legacyPath, modules, Date.now)
  switch (admission.status) {
    case 'initialization-required':
      return { kind: 'uninitialized' }
    case 'inactive':
      return { kind: 'legacy' }
    case 'pending':
      return admission.operation === undefined
        ? { kind: 'legacy' }
        : {
            kind: 'unavailable',
            reason: `an account-store ${admission.operation} is unfinished; run \`antigravity-auth ${admission.operation} --offline\` again`,
          }
    case 'error':
      return { kind: 'unavailable', reason: admission.reason }
    case 'bound':
      break
  }
  const repository = createAccountRepositoryFactory(modules)({
    paths: admission.paths,
    now: Date.now,
    exchange: async ({ refreshToken }) => {
      const result = await refreshAntigravityToken(refreshToken)
      return {
        accessToken: result.access,
        refreshToken: result.refresh,
        expiresAt: result.expires,
      }
    },
  })
  try {
    const read = await repository.read()
    if (read.status !== 'ready') {
      return {
        kind: 'unavailable',
        reason: `the account store is ${read.status}`,
      }
    }
    return { kind: 'store', accounts: read.rows.map(cliAccountOf) }
  } finally {
    await repository.dispose()
  }
}

/**
 * The account-store operations over the embedded common-auth `./store` and
 * `./fs` modules. The operator's `--offline` flag and confirmation are what
 * `processesStopped` records; the migration module itself verifies the
 * pointer, journal and retired-writer state before it writes.
 */
export function createDefaultAccountStoreOperations(): AccountStoreOperations {
  const offline = { processesStopped: true } as const
  return {
    legacyPath: () => resolve(getStoragePath()),
    migrate: async (legacyPath) =>
      createAccountMigrationFactory(await loadCommonAuthStoreModules())({
        legacyPath,
        offline,
        now: Date.now,
      }),
    rollback: async (legacyPath) =>
      createAccountRollbackFactory(await loadCommonAuthStoreModules())({
        legacyPath,
        offline,
        now: Date.now,
      }),
    initialize: async (legacyPath) =>
      initializeFreshAccountStore(await loadCommonAuthStoreModules(), {
        legacyPath,
        now: Date.now,
      }),
    read: readAccountStore,
  }
}

if (import.meta.main) {
  process.exitCode = await runCli(
    process.argv.slice(2),
    createDefaultCliDependencies(),
  )
}

export { performOAuthLogin }
