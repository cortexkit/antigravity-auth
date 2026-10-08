/**
 * Argument parsers for the dialog commands' apply strings.
 *
 * The OpenCode 1 `/rpc/apply` endpoint and the OpenCode 2 `apply` RPC accept
 * the same argument format, so both hosts parse it here. The module has no
 * host SDK or runtime imports: it only turns text into typed requests.
 */

import type { OperatorSettings } from './operator-settings.ts'

export function parseToggleArguments(input: string): {
  cli_first?: boolean
  quota_style_fallback?: boolean
} {
  const result: { cli_first?: boolean; quota_style_fallback?: boolean } = {}
  for (const part of input.split(/\s+/).filter(Boolean)) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    const key = part.slice(0, eq).trim().toLowerCase()
    const value = part
      .slice(eq + 1)
      .trim()
      .toLowerCase()
    if (key === 'cli_first' || key === 'cli-first') {
      result.cli_first = value === 'true' || value === '1' || value === 'on'
    } else if (
      key === 'quota_style_fallback' ||
      key === 'quota-style-fallback'
    ) {
      result.quota_style_fallback =
        value === 'true' || value === '1' || value === 'on'
    }
  }
  return result
}

export function parseKillswitchArguments(input: string): {
  enabled?: boolean
  minimum_remaining_percent?: number
} {
  const result: {
    enabled?: boolean
    minimum_remaining_percent?: number
  } = {}
  for (const part of input.split(/\s+/).filter(Boolean)) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    const key = part.slice(0, eq).trim().toLowerCase()
    const value = part
      .slice(eq + 1)
      .trim()
      .toLowerCase()
    if (key === 'enabled') {
      result.enabled = value === 'true' || value === '1' || value === 'on'
    } else if (
      key === 'minimum_remaining_percent' ||
      key === 'minimum-remaining-percent'
    ) {
      const n = Number.parseFloat(value)
      if (!Number.isNaN(n) && n >= 0 && n <= 100) {
        result.minimum_remaining_percent = n
      }
    }
  }
  return result
}

export function parseLoggingLevel(
  input: string,
): OperatorSettings['log_level'] {
  const trimmed = input.trim().toLowerCase()
  if (
    trimmed === 'error' ||
    trimmed === 'warn' ||
    trimmed === 'info' ||
    trimmed === 'debug' ||
    trimmed === 'trace'
  ) {
    return trimmed
  }
  return 'info'
}

export type AccountAction =
  | { kind: 'add' }
  | { kind: 'add-oauth-start' }
  | { kind: 'add-oauth-finish'; code: string; label?: string }
  | { kind: 'refresh' }
  | { kind: 'current'; index: number }
  | { kind: 'toggle'; index: number }
  | { kind: 'remove'; index: number }

/**
 * Parse the slash-command apply argument for `/antigravity-account`.
 *
 * Recognized forms:
 *   `<empty>`        → `{ kind: 'refresh' }` (keeps the original
 *                      "manage → refresh" placeholder semantics)
 *   `add`            → `{ kind: 'add' }`
 *   `refresh`        → `{ kind: 'refresh' }`
 *   `current <n>`    → `{ kind: 'current', index: n }`
 *   `toggle <n>`     → `{ kind: 'toggle', index: n }`
 *   `remove <n>`     → `{ kind: 'remove', index: n }`
 *
 * `n` is the transient `acct-<index>` position the dialog renders.
 * Negative or non-integer values are rejected; out-of-range indices
 * are accepted here and rejected by the data service so the dialog
 * can surface the error text.
 */
export function parseAccountAction(input: string): AccountAction | undefined {
  const trimmed = input.trim()
  if (!trimmed) return { kind: 'refresh' }
  const parts = trimmed.split(/\s+/).filter(Boolean)
  const head = parts[0]?.toLowerCase()
  if (head === 'add') return { kind: 'add' }
  if (head === 'add-oauth-start' && parts.length === 1) {
    return { kind: 'add-oauth-start' }
  }
  if (head === 'add-oauth-finish') {
    const code = parts[1]
    if (!code) return undefined
    const labelAt = parts.indexOf('--label')
    const label =
      labelAt === -1
        ? undefined
        : parts
            .slice(labelAt + 1)
            .join(' ')
            .trim()
    return { kind: 'add-oauth-finish', code, label: label || undefined }
  }
  if (head === 'refresh') return { kind: 'refresh' }
  if (head === 'current' || head === 'toggle' || head === 'remove') {
    const raw = parts[1]
    if (raw === undefined) return undefined
    const index = Number.parseInt(raw, 10)
    if (!Number.isInteger(index) || index < 0) return undefined
    return { kind: head, index }
  }
  return undefined
}
