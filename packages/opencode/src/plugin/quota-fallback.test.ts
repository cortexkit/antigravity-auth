import { beforeAll, describe, expect, it, mock } from 'bun:test'
import type { HeaderStyle, ModelFamily } from './accounts'

type ResolveQuotaFallbackHeaderStyle = (input: {
  family: ModelFamily
  headerStyle: HeaderStyle
  alternateStyle: HeaderStyle | null
}) => HeaderStyle | null

type GetHeaderStyleFromUrl = (
  urlString: string,
  family: ModelFamily,
  cliFirst?: boolean,
) => HeaderStyle

type ResolveHeaderRoutingDecision = (
  urlString: string,
  family: ModelFamily,
  config: unknown,
) => {
  cliFirst: boolean
  preferredHeaderStyle: HeaderStyle
  explicitQuota: boolean
  allowQuotaFallback: boolean
}

let resolveQuotaFallbackHeaderStyle: ResolveQuotaFallbackHeaderStyle | undefined
let getHeaderStyleFromUrl: GetHeaderStyleFromUrl | undefined
let resolveHeaderRoutingDecision: ResolveHeaderRoutingDecision | undefined
let isCapacityRetryBudgetExhausted:
  | ((totalCapacityRetries: number) => boolean)
  | undefined

beforeAll(async () => {
  mock.module('@opencode-ai/plugin', () => ({
    tool: mock(),
  }))

  const { __testExports } = await import('../plugin')
  resolveQuotaFallbackHeaderStyle = (
    __testExports as {
      resolveQuotaFallbackHeaderStyle?: ResolveQuotaFallbackHeaderStyle
    }
  ).resolveQuotaFallbackHeaderStyle
  getHeaderStyleFromUrl = (
    __testExports as {
      getHeaderStyleFromUrl?: GetHeaderStyleFromUrl
    }
  ).getHeaderStyleFromUrl
  resolveHeaderRoutingDecision = (
    __testExports as {
      resolveHeaderRoutingDecision?: ResolveHeaderRoutingDecision
    }
  ).resolveHeaderRoutingDecision
  isCapacityRetryBudgetExhausted = (
    __testExports as {
      isCapacityRetryBudgetExhausted?: (totalCapacityRetries: number) => boolean
    }
  ).isCapacityRetryBudgetExhausted
})

describe('quota fallback direction', () => {
  it('falls back from gemini-cli to antigravity when alternate quota is available', () => {
    const result = resolveQuotaFallbackHeaderStyle?.({
      family: 'gemini',
      headerStyle: 'gemini-cli',
      alternateStyle: 'antigravity',
    })

    expect(result).toBe('antigravity')
  })

  it('falls back from antigravity to gemini-cli when alternate quota is available', () => {
    const result = resolveQuotaFallbackHeaderStyle?.({
      family: 'gemini',
      headerStyle: 'antigravity',
      alternateStyle: 'gemini-cli',
    })

    expect(result).toBe('gemini-cli')
  })

  it('returns null when no alternate quota is available', () => {
    const result = resolveQuotaFallbackHeaderStyle?.({
      family: 'gemini',
      headerStyle: 'antigravity',
      alternateStyle: null,
    })

    expect(result).toBeNull()
  })
})

describe('header style resolution', () => {
  it('uses gemini-cli for unsuffixed Gemini models when cli_first is enabled', () => {
    const headerStyle = getHeaderStyleFromUrl?.(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash:streamGenerateContent',
      'gemini',
      true,
    )

    expect(headerStyle).toBe('gemini-cli')
  })

  it('keeps antigravity for unsuffixed Gemini models when cli_first is disabled', () => {
    const headerStyle = getHeaderStyleFromUrl?.(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash:streamGenerateContent',
      'gemini',
      false,
    )

    expect(headerStyle).toBe('antigravity')
  })

  it('keeps antigravity for explicit antigravity prefix when cli_first is enabled', () => {
    const headerStyle = getHeaderStyleFromUrl?.(
      'https://generativelanguage.googleapis.com/v1beta/models/antigravity-gemini-3-flash:streamGenerateContent',
      'gemini',
      true,
    )

    expect(headerStyle).toBe('antigravity')
  })

  it('keeps antigravity for Claude when cli_first is enabled', () => {
    const headerStyle = getHeaderStyleFromUrl?.(
      'https://generativelanguage.googleapis.com/v1beta/models/claude-opus-4-6-thinking:streamGenerateContent',
      'claude',
      true,
    )

    expect(headerStyle).toBe('antigravity')
  })
})

describe('header routing decision', () => {
  it('defaults to antigravity-first for unsuffixed Gemini when cli_first is disabled', () => {
    const decision = resolveHeaderRoutingDecision?.(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash:streamGenerateContent',
      'gemini',
      {
        cli_first: false,
      },
    )

    expect(decision).toMatchObject({
      cliFirst: false,
      preferredHeaderStyle: 'antigravity',
      explicitQuota: false,
      allowQuotaFallback: false,
    })
  })
  it('uses gemini-cli-first for unsuffixed Gemini when cli_first is enabled', () => {
    const decision = resolveHeaderRoutingDecision?.(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash:streamGenerateContent',
      'gemini',
      {
        cli_first: true,
      },
    )

    expect(decision).toMatchObject({
      cliFirst: true,
      preferredHeaderStyle: 'gemini-cli',
      explicitQuota: false,
      allowQuotaFallback: false,
    })
  })
  it('keeps explicit antigravity prefix as primary route while fallback available when quota_style_fallback enabled', () => {
    const decision = resolveHeaderRoutingDecision?.(
      'https://generativelanguage.googleapis.com/v1beta/models/antigravity-gemini-3-flash:streamGenerateContent',
      'gemini',
      {
        cli_first: true,
        quota_style_fallback: true,
      },
    )

    expect(decision).toMatchObject({
      cliFirst: true,
      preferredHeaderStyle: 'antigravity',
      explicitQuota: true,
      allowQuotaFallback: true,
    })
  })
  it('ignores legacy quota_fallback when deciding Gemini fallback availability', () => {
    const decision = resolveHeaderRoutingDecision?.(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash:streamGenerateContent',
      'gemini',
      {
        cli_first: false,
        quota_fallback: false,
      },
    )

    expect(decision).toMatchObject({
      cliFirst: false,
      preferredHeaderStyle: 'antigravity',
      explicitQuota: false,
      allowQuotaFallback: false,
    })
  })

  it('enables quota style fallback when quota_style_fallback is true', () => {
    const decision = resolveHeaderRoutingDecision?.(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash:streamGenerateContent',
      'gemini',
      {
        cli_first: false,
        quota_style_fallback: true,
      },
    )

    expect(decision).toMatchObject({
      cliFirst: false,
      preferredHeaderStyle: 'antigravity',
      explicitQuota: false,
      allowQuotaFallback: true,
    })
  })

  it('never allows quota fallback for Claude regardless of config', () => {
    const decision = resolveHeaderRoutingDecision?.(
      'https://generativelanguage.googleapis.com/v1beta/models/claude-sonnet-4-6:streamGenerateContent',
      'claude',
      {
        cli_first: false,
        quota_style_fallback: true,
      },
    )

    expect(decision).toMatchObject({
      allowQuotaFallback: false,
    })
  })
})

describe('capacity retry guard', () => {
  it('keeps capacity retries below the total budget', () => {
    expect(isCapacityRetryBudgetExhausted?.(0)).toBe(false)
    expect(isCapacityRetryBudgetExhausted?.(3)).toBe(false)
  })

  it('exhausts capacity retries at the bounded total budget', () => {
    expect(isCapacityRetryBudgetExhausted?.(4)).toBe(true)
    expect(isCapacityRetryBudgetExhausted?.(5)).toBe(true)
  })
})
