import type { testRender } from '@opentui/solid'

/** Compare drawn cells, not text-node boundaries that can change as bar segments appear. */
export function sidebarVisual(setup: Awaited<ReturnType<typeof testRender>>) {
  return {
    text: setup.captureCharFrame(),
    colors: setup.captureSpans().lines.map((line) =>
      line.spans.flatMap((span) =>
        Array.from(span.text, (text) => ({
          text,
          fg: String(span.fg),
          bg: String(span.bg),
        })),
      ),
    ),
  }
}

/** Frozen collapsed rows include the complete quota or none, with the indicator last. */
export const COLLAPSED_ROWS: Record<
  'fresh' | 'stale' | 'empty',
  Record<number, string>
> = {
  fresh: {
    20: 'Account 1          ●',
    26: 'Account 1                ●',
    27: 'Account 1                 ●',
    28: 'Account 1                  ●',
    29: 'Account 1                   ●',
    30: '… Ge 7d 62% · Ot 7d 48% left ●',
    31: 'A… Ge 7d 62% · Ot 7d 48% left ●',
    32: 'Ac… Ge 7d 62% · Ot 7d 48% left ●',
    38: 'Account 1 Ge 7d 62% · Ot 7d 48% left ●',
    48: 'Account 1           Ge 7d 62% · Ot 7d 48% left ●',
  },
  stale: {
    20: 'Account 1          ●',
    26: 'Account 1                ●',
    27: 'Account 1                 ●',
    28: '… Ge 7d 9% · Ot 7d 0% left ●',
    29: 'A… Ge 7d 9% · Ot 7d 0% left ●',
    30: 'Ac… Ge 7d 9% · Ot 7d 0% left ●',
    31: 'Acc… Ge 7d 9% · Ot 7d 0% left ●',
    32: 'Acco… Ge 7d 9% · Ot 7d 0% left ●',
    38: 'Account 1   Ge 7d 9% · Ot 7d 0% left ●',
    48: 'Account 1             Ge 7d 9% · Ot 7d 0% left ●',
  },
  empty: {
    20: 'Account 1          ●',
    26: 'Ac… no quota reading yet ●',
    27: 'Acc… no quota reading yet ●',
    28: 'Acco… no quota reading yet ●',
    29: 'Accou… no quota reading yet ●',
    30: 'Accoun… no quota reading yet ●',
    31: 'Account… no quota reading yet ●',
    32: 'Account 1 no quota reading yet ●',
    38: 'Account 1       no quota reading yet ●',
    48: 'Account 1                 no quota reading yet ●',
  },
}
