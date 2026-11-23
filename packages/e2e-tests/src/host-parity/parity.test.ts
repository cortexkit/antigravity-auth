import { expect, test } from 'bun:test'
import { requestCases, subjects } from './cases.ts'
import { baseCommit, recordCorpus } from './record.ts'
import { runConversation } from './runner.ts'

const capturePath = process.env.HOST_PARITY_RECORD
if (capturePath) {
  test('record the stock host transport observations', async () => {
    const mode =
      process.env.HOST_PARITY_BASELINE === '1' ? 'baseline' : 'observe'
    const child = Bun.spawn(['git', 'rev-parse', 'HEAD'], { stdout: 'pipe' })
    const revision = (await new Response(child.stdout).text()).trim()
    if (
      (await child.exited) !== 0 ||
      (mode === 'baseline' && revision !== baseCommit)
    )
      throw new Error(
        'The capture checkout does not match the frozen source commit',
      )
    const result = await recordCorpus(revision, mode)
    await Bun.write(capturePath, `${JSON.stringify(result, null, 2)}\n`)
  }, 180_000)
}

test.each([
  ...subjects,
])('%s enters the stock public request and response paths', async (subject) => {
  const input = requestCases[0]!
  const result = await runConversation({
    input,
    subject,
    custody: 'local',
    timed: true,
  })
  expect(result).toMatchObject({
    wire: [{ target: expect.stringContaining(':streamGenerateContent') }],
    turns: [{ text: 'Four.', terminal: ['stop'], errors: [] }],
  })
})
