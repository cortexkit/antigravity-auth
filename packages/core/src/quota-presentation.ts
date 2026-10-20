import type { QuotaState } from './account-repository-types.ts'
import {
  formatQuota,
  type ProjectedLimit,
  type ProjectedQuota,
  type QuotaGroup,
  type QuotaTextOptions,
  quotaTextParts,
} from './common-auth-embedded/quota/index.js'

export type AntigravityQuotaReading = Partial<
  Pick<QuotaState, 'schemaVersion' | 'cachedQuotaUpdatedAt'>
> & {
  cachedQuota?: Record<
    string,
    Pick<
      NonNullable<QuotaState['cachedQuota']>[string],
      'remainingFraction' | 'resetTime' | 'windows'
    >
  > | null
}

const MODEL_LABELS: Readonly<Record<string, string>> = {
  gemini: 'Gemini',
  'non-gemini': 'Claude / GPT-OSS',
  claude: 'Claude',
  'gemini-pro': 'Gemini Pro',
  'gemini-flash': 'Gemini Flash',
  'gpt-oss': 'GPT-OSS',
}

/** Convert stored Antigravity readings without assigning an age to undated data. */
export function projectAntigravityQuota(
  quota: AntigravityQuotaReading | undefined,
): ProjectedQuota | undefined {
  const checkedAt = quota?.cachedQuotaUpdatedAt
  if (
    typeof checkedAt !== 'number' ||
    !Number.isFinite(checkedAt) ||
    checkedAt < 0 ||
    !quota?.cachedQuota
  )
    return undefined
  const limits: ProjectedLimit[] = []
  for (const [scope, group] of Object.entries(quota.cachedQuota)) {
    const model = MODEL_LABELS[scope]
    if (!model) continue
    const windows = group.windows ?? []
    if (windows.length) {
      for (const window of windows) {
        if (!Number.isFinite(window.remainingFraction)) continue
        const duration = window.window === 'weekly' ? '7d' : '5h'
        limits.push({
          scope,
          label: `${model} ${duration}`,
          kind: 'reading',
          checkedAt,
          windowMinutes: window.window === 'weekly' ? 7 * 24 * 60 : 5 * 60,
          remainingPercent: window.remainingFraction * 100,
          resetsAt: window.resetTime,
        })
      }
    } else if (
      typeof group.remainingFraction === 'number' &&
      Number.isFinite(group.remainingFraction)
    ) {
      limits.push({
        scope,
        label: model,
        kind: 'reading',
        checkedAt,
        remainingPercent: group.remainingFraction * 100,
        ...(group.resetTime ? { resetsAt: group.resetTime } : {}),
      })
    }
  }
  return {
    scope: 'all',
    limits,
    checkedAt,
    groups: [
      { scope: 'gemini', label: 'Gemini' },
      { scope: 'non-gemini', label: 'Other models' },
    ] satisfies readonly QuotaGroup[],
  }
}

export function formatAntigravityQuota(
  quota: AntigravityQuotaReading | undefined,
  options: QuotaTextOptions,
): string {
  return formatQuota(projectAntigravityQuota(quota), options)
}

export function antigravityQuotaTextParts(
  quota: AntigravityQuotaReading | undefined,
  options: QuotaTextOptions,
): string[] {
  return quotaTextParts(projectAntigravityQuota(quota), options)
}
