import { describe, expect, it } from 'bun:test'
import stock from '../../../test-fixtures/pi-1.5.2-system-prompt.json'
import {
  rewriteSystemInstruction,
  systemInstructionHasHarnessIdentity,
} from './harness-identity'

function docsBlock(lines: string[]): string {
  return lines
    .slice(lines.indexOf('<docs>'), lines.indexOf('</docs>') + 1)
    .join('\n')
}

const docs = docsBlock(stock.input)
const servedDocs = docsBlock(stock.output)
const prompt = stock.input.join('\n')
const servedPrompt = stock.output.join('\n')
const entry = stock.input.find((line) =>
  line.startsWith('- When asked about:'),
)!
// Pi-Bolt adds its own installation advice after the shared Pi docs entries.
const boltAdvice =
  "- This is Pi-Bolt: its command is `pi-bolt`, and it is updated with `pi-bolt update` (https://github.com/opensec-git/Pi-Bolt). The install and update commands in pi's README install pi itself, not Pi-Bolt: do not suggest them."
const boltPrompt = prompt
  .replace(
    'You are a coding assistant running inside pi, a coding agent harness.',
    'You are a coding assistant running inside Pi-Bolt, a build of pi (a coding agent harness) compiled ahead of time.',
  )
  .replace('</docs>', `${boltAdvice}\n</docs>`)
const servedBoltPrompt = servedPrompt.replace(
  '</docs>',
  `${boltAdvice}\n</docs>`,
)

describe('Pi codemode docs rewrite', () => {
  it('removes only the codemode clause from the stock Pi 1.5.2 docs bullet', () => {
    expect(rewriteSystemInstruction(docs)).toBe(servedDocs)
  })

  it('rewrites both the opener and docs clause in the full stock Pi 1.5.2 prompt', () => {
    expect(rewriteSystemInstruction(prompt)).toBe(servedPrompt)
  })

  it('rewrites the full Pi-Bolt prompt while preserving its installation advice', () => {
    expect(rewriteSystemInstruction(boltPrompt)).toBe(servedBoltPrompt)
  })

  it('is deterministic and idempotent without normalising surrounding blank lines', () => {
    for (const [input, output] of [
      [docs, servedDocs],
      [prompt, servedPrompt],
      [boltPrompt, servedBoltPrompt],
      [`\n\n\n${docs}\n\n\n`, `\n\n\n${servedDocs}\n\n\n`],
    ]) {
      expect(rewriteSystemInstruction(input)).toBe(output)
      expect(rewriteSystemInstruction(input)).toBe(output)
      expect(rewriteSystemInstruction(output)).toBe(output)
    }
  })

  it('preserves the shortened bullet and its LF on subsequent rewrites', () => {
    const shortenedEntry = stock.output.find((line) =>
      line.startsWith('- When asked about:'),
    )!
    expect(shortenedEntry.endsWith('MCP servers (docs/mcp.md)')).toBe(true)
    expect(rewriteSystemInstruction(`${shortenedEntry}\n`)).toBe(
      `${shortenedEntry}\n`,
    )
  })

  it('preserves other codemode docs entries and exact-line near misses', () => {
    const otherEntry = '- Codemode reference: docs/codemode.md'
    expect(
      rewriteSystemInstruction(
        docs.replace('</docs>', `${otherEntry}\n</docs>`),
      ),
    ).toBe(servedDocs.replace('</docs>', `${otherEntry}\n</docs>`))
    for (const line of [
      otherEntry,
      '- Codemode scripts and non-LLM models such as classifiers and image models (docs/codemode.md)',
      entry.replace(
        'codemode scripts and non-LLM',
        'codemode scripts or non-LLM',
      ),
      entry.replace('docs/codemode.md', '/opt/pi/docs/codemode.md'),
      entry.replace('- When asked about:', '- When asked about'),
      entry.replace('- When asked about:', '- when asked about:'),
      ` ${entry}`,
      `Quoted: ${entry}`,
      `${entry} Read it first.`,
      `${entry}\r`,
    ]) {
      const input = `<docs>\n${line}\n</docs>`
      expect(rewriteSystemInstruction(input)).toBe(input)
    }
    expect(rewriteSystemInstruction(entry)).toBe(entry)
  })

  it('rewrites only text instruction parts without mutating them', () => {
    const input = {
      role: 'system',
      parts: [
        { text: docs, cache_control: { type: 'ephemeral' } },
        { inlineData: { data: docs } },
      ],
    }
    expect(rewriteSystemInstruction(input)).toEqual({
      ...input,
      parts: [{ ...input.parts[0], text: servedDocs }, input.parts[1]],
    })
    expect(input.parts[0]!.text).toBe(docs)
    expect(systemInstructionHasHarnessIdentity(input)).toBe(true)
    expect(
      systemInstructionHasHarnessIdentity({ parts: [{ text: servedDocs }] }),
    ).toBe(false)
  })
})
