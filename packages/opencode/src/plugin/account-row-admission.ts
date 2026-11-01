import type { AccountRow } from '@cortexkit/antigravity-auth-core'

export type HarnessAccessBlock =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'verification-required'
      readonly reason: 'validation-required' | 'other' | 'unrecorded'
    }
  | {
      readonly kind: 'ineligible'
      readonly reason: 'account-ineligible' | 'other' | 'unrecorded'
    }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'invalid' }

/**
 * The access block the row's metadata records. Absent or dropped metadata
 * cannot rule a block out, so it is `unknown`, never `none`.
 */
export function accessBlockOf(row: AccountRow): HarnessAccessBlock {
  if (row.metadata.status !== 'present') return { kind: 'unknown' }
  const metadata = row.metadata.metadata
  const verification = metadata.verificationRequired
  const ineligible = metadata.accountIneligible
  const flag = (value: unknown) =>
    value === undefined || value === null || typeof value === 'boolean'
  if (!flag(verification) || !flag(ineligible)) return { kind: 'invalid' }
  if (verification === true && ineligible === true) return { kind: 'invalid' }
  if (verification === true) {
    const reason = metadata.verificationRequiredReason
    return {
      kind: 'verification-required',
      reason:
        reason === undefined || reason === null
          ? 'unrecorded'
          : reason === 'validation-required'
            ? 'validation-required'
            : 'other',
    }
  }
  if (ineligible === true) {
    const reason = metadata.accountIneligibleReason
    return {
      kind: 'ineligible',
      reason:
        reason === undefined || reason === null
          ? 'unrecorded'
          : reason === 'account-ineligible'
            ? 'account-ineligible'
            : 'other',
    }
  }
  return { kind: 'none' }
}

/**
 * Authoritative predicate for whether an account row is ready to reconnect.
 * Strict conjunction matching assertExistingPool:
 * enabled && usable && credential !== undefined && !torn && !unbound &&
 * invalid === undefined && metadata.status === 'present' && accessBlockOf(row).kind === 'none'
 */
export function isReconnectReadyRow(row: AccountRow): boolean {
  return (
    row.enabled &&
    row.usable &&
    row.credential !== undefined &&
    !row.torn &&
    !row.unbound &&
    row.invalid === undefined &&
    row.metadata.status === 'present' &&
    accessBlockOf(row).kind === 'none'
  )
}
