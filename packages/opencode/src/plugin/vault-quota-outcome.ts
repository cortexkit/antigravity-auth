/** Closed diagnostic vocabulary: never copy an error message or remote identifier into a tick record. */
export type VaultQuotaReason =
  | 'recorded'
  | 'fresh'
  | 'lock-busy'
  | 'lock-lost'
  | 'authority'
  | 'no-rows'
  | 'fetch-failed'
  | 'insula-cold'
  | 'insula-upstream-failed'
  | 'insula-skipped'
  | 'deadline'
  | 'unattributed'
  | 'binding-stale'
  | 'version-changed'
  | 'state-lock'
  | 'state-invalid'
  | 'write-uncertain'
  | 'publish-failed'
  | 'aborted'
  | 'admission-refused'
  | 'roster-unavailable'
  | 'commit-unchanged'

export type VaultQuotaStage =
  | 'authority'
  | 'lock'
  | 'roster'
  | 'state'
  | 'fetch'
  | 'commit'
  | 'publish'

export interface VaultQuotaOutcome {
  tick: string
  reason: VaultQuotaReason
  stage: VaultQuotaStage
  elapsedMs: number
  rows: number
  checked: number
  notChecked: number
  reasons: Partial<Record<VaultQuotaReason, number>>
  endpoint?: 'summary' | 'models'
  status?: number
  errorKind?: string
}

export function vaultQuotaErrorReason(
  error: unknown,
  fallback: VaultQuotaReason,
): VaultQuotaReason {
  if (typeof error !== 'object' || error === null) return fallback
  const typed = error as {
    kind?: unknown
    reason?: unknown
    name?: unknown
    code?: unknown
  }
  if (typed.reason === 'version-changed') return 'version-changed'
  if (
    typed.kind === 'binding-stale' ||
    typed.kind === 'route-unavailable' ||
    typed.kind === 'identity-contradicted'
  )
    return 'binding-stale'
  if (typed.kind === 'not-active' || typed.kind === 'closed') return 'authority'
  if (
    typed.name === 'LockContentionError' ||
    typed.kind === 'lock-unavailable' ||
    typed.code === 'ELOCKED'
  )
    return 'state-lock'
  if (typed.name === 'LockOwnershipError') return 'lock-lost'
  if (
    typed.kind === 'malformed' ||
    typed.kind === 'newer-schema' ||
    typed.kind === 'credential-material' ||
    typed.kind === 'project-field' ||
    typed.kind === 'invalid-state' ||
    typed.kind === 'invalid-update' ||
    typed.kind === 'invalid-attribution'
  )
    return 'state-invalid'
  if (typed.name === 'AbortError') return 'aborted'
  return fallback
}

export function vaultQuotaErrorKind(error: unknown): string {
  if (typeof error !== 'object' || error === null) return 'unknown'
  const name = (error as { name?: unknown }).name
  if (name === 'TimeoutError') return 'timeout'
  if (name === 'AbortError') return 'abort'
  if (name === 'TypeError') return 'transport'
  if (name === 'SyntaxError') return 'payload'
  return vaultQuotaErrorReason(error, 'fetch-failed') === 'fetch-failed'
    ? 'unknown'
    : vaultQuotaErrorReason(error, 'fetch-failed')
}
