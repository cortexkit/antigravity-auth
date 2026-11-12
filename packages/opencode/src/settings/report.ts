/**
 * Plain-language text for what the settings move and the settings file
 * report: the persisted move report, live report entries and menu-write
 * refusals. No text here carries an account key, a token-derived value or
 * an error message.
 */

import { mkdir, readFile, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { writeJsonAtomic } from '@cortexkit/antigravity-auth-core'
import type { ReportEntry } from '@cortexkit/antigravity-auth-core/common-auth/settings'

import { pluginStateDir } from '../runtime-paths'
import { RETIRED_SETTINGS } from './core-settings'
import type { LegacyUnmapped } from './legacy'

export const MOVE_REPORT_FILE_NAME = 'settings-move-report.json'

export function defaultMoveReportPath(): string {
  return join(pluginStateDir(), MOVE_REPORT_FILE_NAME)
}

export interface MoveReport {
  readonly version: 1
  readonly movedAt: string
  readonly source: string
  readonly target: string
  readonly unmapped: readonly LegacyUnmapped[]
}

/** Best-effort: the move has already happened when this runs. */
export async function writeMoveReport(
  path: string,
  report: Omit<MoveReport, 'version'>,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeJsonAtomic(path, { version: 1, ...report })
}

export async function readMoveReport(
  path: string,
): Promise<MoveReport | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as MoveReport
    if (parsed?.version !== 1 || !Array.isArray(parsed.unmapped))
      return undefined
    return parsed
  } catch {
    return undefined
  }
}

export async function dismissMoveReport(path: string): Promise<void> {
  await rm(path, { force: true })
}

/** One line for a value the move did not carry into the new file. */
export function describeUnmapped(entry: LegacyUnmapped): string {
  switch (entry.reason) {
    case 'unparseable':
      return 'antigravity.json could not be parsed, so nothing was moved from it.'
    case 'retired':
      return `${entry.key} is retired and was not moved.`
    case 'unknown-key':
    case 'unknown-setting':
      return `${entry.key} is not a known setting and was not moved.`
    case 'ignored-by-runtime':
      return `${entry.key} was not moved: antigravity.json failed validation, so it was not in effect.`
    case 'invalid-value':
      return `${entry.key} held a value the new settings file can't use and was not moved.`
    case 'account-not-found':
      return 'An account limit was set for an account that is no longer in your store; it was not moved.'
    case 'account-ambiguous':
      return 'An account limit matched more than one stored account; it was not moved.'
    case 'position-key':
      return `An account limit set by roster position (${entry.key.replace('killswitch.accounts.', '')}) was not moved; set it again from Limits.`
  }
}

/** Unmapped entries that concern per-account floors, for the Limits section. */
export function isFloorEntry(entry: LegacyUnmapped): boolean {
  return (
    entry.reason === 'account-not-found' ||
    entry.reason === 'account-ambiguous' ||
    entry.reason === 'position-key'
  )
}

const RETIRED = new Set<string>(RETIRED_SETTINGS)

function keyName(entry: ReportEntry): string {
  return entry.keyPath.join('.')
}

/** One line for a live report entry of the settings handle. */
export function describeReportEntry(entry: ReportEntry): string {
  const file =
    entry.file.kind === 'legacy-project'
      ? 'The project file .opencode/antigravity.json'
      : entry.file.kind === 'project'
        ? 'The project file .cortexkit/antigravity-auth.jsonc'
        : basename(entry.file.path)
  const key = keyName(entry)
  switch (entry.reason) {
    case 'user-only-in-project':
      return `${file} sets ${key}, which only the user settings file can set; it is ignored.`
    case 'unknown-key':
      return RETIRED.has(key)
        ? `${file} sets ${key}, which is retired; it is ignored.`
        : `${file} sets ${key}, which is not a known setting; it is ignored.`
    case 'invalid-value':
      return `${file} has an invalid value for ${key}; it is ignored.`
    case 'override-not-allowed':
      return `${file} uses an override for ${key} that this setting doesn't allow; it is ignored.`
    case 'invalid-schema-version':
      return `${file} has an invalid schema_version.`
    case 'newer-version-key-ignored':
      return `${file} is from a newer version; ${key} is ignored.`
    case 'duplicate-key':
      return `${file} sets ${key} more than once.`
    case 'unparseable':
      return `${file} could not be parsed; its last readable values stay in force.`
    case 'unreadable':
      return `${file} could not be read; its last readable values stay in force.`
  }
}

/**
 * Fixed menu text for a refused settings write. It names the file, never the
 * error, so nothing from a failure reaches the menu. Pi shows the same words.
 */
export { settingsRefusalText as refusalText } from './core-settings'
