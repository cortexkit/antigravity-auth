/**
 * How the account repository names one credential of one row.
 *
 * A `RowRef` is the id of a row, the credential epoch the store gave its
 * credential, and the identity recorded for it. Work started for one
 * credential (a refresh, a quota pull, a status verdict) must only land on
 * that credential: never on its replacement, never on a row re-added under
 * the same id, and never on a row that merely shares a position. Comparing
 * refs exactly, with an absent identity matching only an absent identity,
 * is what makes that check meaningful; treating absence as "any identity"
 * would let a lookup about one account land on another.
 */

import type { RowRef } from './account-repository-types.ts'

/** What a pool-store row carries about its own credential. */
export interface RowAttributionSource {
  readonly id: string
  /** Undefined for a row with no per-row entry yet, which counts as epoch 1. */
  readonly credentialEpoch?: number
  readonly identity?: string
}

/**
 * The credential fence the store takes for attributed writes. Same shape as
 * `Attribution` in common-auth `dist/store/attribution.d.ts`.
 */
export interface CredentialFence {
  credentialEpoch: number
  identity?: string
}

/**
 * The ref of a row as the store loaded it. A row without a per-row entry is
 * at epoch 1, as the store itself counts it.
 */
export function rowRefOf(row: RowAttributionSource): RowRef {
  const credentialEpoch = row.credentialEpoch ?? 1
  return row.identity === undefined
    ? { id: row.id, credentialEpoch }
    : { id: row.id, credentialEpoch, identity: row.identity }
}

/** Exact equality: id, epoch, and identity including its absence. */
export function sameRowRef(a: RowRef, b: RowRef): boolean {
  return (
    a.id === b.id &&
    a.credentialEpoch === b.credentialEpoch &&
    a.identity === b.identity
  )
}

/** Whether a loaded row still holds exactly the credential `ref` names. */
export function rowHoldsRef(row: RowAttributionSource, ref: RowRef): boolean {
  return sameRowRef(rowRefOf(row), ref)
}

/** The store's attribution argument for the credential in `ref`. */
export function credentialFenceOf(ref: RowRef): CredentialFence {
  return ref.identity === undefined
    ? { credentialEpoch: ref.credentialEpoch }
    : { credentialEpoch: ref.credentialEpoch, identity: ref.identity }
}

/**
 * A string key for in-memory maps (single-flight refreshes, pending writes)
 * that keeps every part of the ref, so two credentials of one row, or a row
 * with and without a recorded identity, never share an entry. JSON keeps the
 * parts apart whatever characters an id or identity holds.
 */
export function rowRefKey(ref: RowRef): string {
  return JSON.stringify(
    ref.identity === undefined
      ? [ref.id, ref.credentialEpoch]
      : [ref.id, ref.credentialEpoch, ref.identity],
  )
}

/**
 * Describes why a row no longer matches a ref, without naming the identity
 * itself (identities are account ids and stay out of messages).
 */
export function refMismatchReason(
  row: RowAttributionSource | undefined,
  ref: RowRef,
): string | undefined {
  if (row === undefined) return `row ${ref.id} is no longer in the pool`
  const current = rowRefOf(row)
  if (current.credentialEpoch !== ref.credentialEpoch) {
    return `row ${ref.id} now holds credential epoch ${current.credentialEpoch}, not ${ref.credentialEpoch}`
  }
  if (current.identity !== ref.identity) {
    return `row ${ref.id} now records a different account identity`
  }
  return undefined
}
