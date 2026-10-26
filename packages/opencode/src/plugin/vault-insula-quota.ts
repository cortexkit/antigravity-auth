import type {
  QuotaGroup,
  QuotaSummary,
  QuotaWindow,
  QuotaWindowEntry,
  VaultConsumerOptions,
} from '@cortexkit/antigravity-auth-core'

type InsulaOptions = NonNullable<VaultConsumerOptions['insula']>

const windows: readonly [string, QuotaGroup, QuotaWindow][] = [
  ['gemini-5h', 'gemini', '5h'],
  ['gemini-weekly', 'gemini', 'weekly'],
  ['3p-5h', 'non-gemini', '5h'],
  ['3p-weekly', 'non-gemini', 'weekly'],
  // Paid Pro accounts report a separate Argon weekly allowance under this
  // exact bucket ID. No Argon 5-hour bucket has been seen, so only this
  // weekly ID is mapped; any other Argon-shaped ID stays ignored.
  ['gemini-argon-wtu-weekly', 'gemini-argon', 'weekly'],
]

/** OAuth-sourced entries can echo our sidebar; only vault-sourced quota is independent. */
export const normalizeVaultInsulaQuota: InsulaOptions['normalize'] = (
  entry,
  context,
) => {
  if (entry.source !== 'vault') return undefined
  if (
    entry.provider !== 'antigravity' ||
    !entry.account?.trim() ||
    !Number.isFinite(context.fetchedAt)
  )
    return undefined
  const groups: QuotaSummary['groups'] = {}
  // The consumer contract keys named extras by id, not mutable display titles.
  // A missing window is unreported; do not manufacture a full or empty limit.
  for (const [id, group, window] of windows) {
    const reading = entry.usage?.extraRateWindows?.find(
      (extra) => extra.id === id,
    )?.window
    if (
      !reading ||
      !Number.isFinite(reading.usedPercent) ||
      reading.usedPercent < 0 ||
      reading.usedPercent > 100
    )
      continue
    const normalized: QuotaWindowEntry = {
      window,
      remainingFraction: 1 - reading.usedPercent / 100,
      resetTime: reading.resetsAt ?? '',
    }
    let summary = groups[group]
    if (summary === undefined) {
      summary = { modelCount: 0, windows: [] }
      groups[group] = summary
    }
    summary.windows?.push(normalized)
    if (
      summary.remainingFraction === undefined ||
      normalized.remainingFraction < summary.remainingFraction
    ) {
      summary.remainingFraction = normalized.remainingFraction
      summary.resetTime = normalized.resetTime
    }
  }
  if (Object.keys(groups).length === 0) return undefined
  return {
    quota: { groups, modelCount: 0 },
    accountIdentity: entry.account.trim(),
    observedAt: context.fetchedAt,
  }
}
