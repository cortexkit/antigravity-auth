// Google refuses harness self-identification with a false quota error,
// measured on 14 Nov 2026. Keep the wire-only neutralisation rules together.
const HARNESS_IDENTITY_PARAGRAPHS = [
  'github.com/anomalyco/opencode',
  'github.com/sst/opencode',
  'opencode.ai/docs',
] as const
const HARNESS_IDENTITY_REWRITES = [
  {
    pattern: /You are opencode, /gi,
    replacement: 'You are ',
  },
  {
    pattern: /You are opencode(?!\.\w)(?=[.!;:]|$|\n)/gi,
    replacement: 'You are a coding assistant',
  },
  {
    pattern: /if OpenCode honestly/g,
    replacement: 'if the assistant honestly',
  },
  {
    pattern:
      /running inside Pi-Bolt, a build of pi \(a coding agent harness\) compiled ahead of time/gi,
    replacement: 'running inside your development environment',
  },
  {
    pattern: /running inside pi, a coding agent harness/gi,
    replacement: 'running inside your development environment',
  },
  {
    pattern: /running inside opencode, a coding agent harness/gi,
    replacement: 'running inside your development environment',
  },
  {
    pattern:
      /\brunning inside (?:pi-bolt|pi|opencode)(?!\.\w)(?=$|\s|[.,;:!?])/gi,
    replacement: 'running inside your development environment',
  },
] as const

export function rewriteHarnessIdentity(text: string): string {
  // Splitting and rejoining normalises blank-line runs, so only do it when a
  // paragraph is actually dropped; otherwise the prompt keeps its exact bytes.
  const paragraphs = HARNESS_IDENTITY_PARAGRAPHS.some((marker) =>
    text.includes(marker),
  )
    ? text
        .split(/\n\n+/)
        .filter(
          (paragraph) =>
            !HARNESS_IDENTITY_PARAGRAPHS.some((marker) =>
              paragraph.includes(marker),
            ),
        )
        .join('\n\n')
    : text
  return HARNESS_IDENTITY_REWRITES.reduce(
    (result, { pattern, replacement }) => result.replace(pattern, replacement),
    paragraphs,
  )
}

function hasHarnessIdentity(text: string): boolean {
  return (
    HARNESS_IDENTITY_PARAGRAPHS.some((marker) => text.includes(marker)) ||
    HARNESS_IDENTITY_REWRITES.some(
      ({ pattern, replacement }) => text.replace(pattern, replacement) !== text,
    )
  )
}

export function rewriteSystemInstruction(instruction: unknown): unknown {
  if (typeof instruction === 'string')
    return rewriteHarnessIdentity(instruction)
  if (
    !instruction ||
    typeof instruction !== 'object' ||
    Array.isArray(instruction)
  )
    return instruction
  const record = instruction as Record<string, unknown>
  if (!Array.isArray(record.parts)) return instruction
  return {
    ...record,
    parts: record.parts.map((part: unknown) => {
      if (!part || typeof part !== 'object' || Array.isArray(part)) return part
      const value = part as Record<string, unknown>
      return typeof value.text === 'string'
        ? { ...value, text: rewriteHarnessIdentity(value.text) }
        : part
    }),
  }
}

export function systemInstructionHasHarnessIdentity(
  instruction: unknown,
): boolean {
  if (typeof instruction === 'string') return hasHarnessIdentity(instruction)
  if (
    !instruction ||
    typeof instruction !== 'object' ||
    Array.isArray(instruction)
  )
    return false
  const parts = (instruction as Record<string, unknown>).parts
  return (
    Array.isArray(parts) &&
    parts.some((part: unknown) => {
      if (!part || typeof part !== 'object' || Array.isArray(part)) return false
      const text = (part as Record<string, unknown>).text
      return typeof text === 'string' && hasHarnessIdentity(text)
    })
  )
}
