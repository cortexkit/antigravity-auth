import { expect, it } from 'bun:test'
import { AntigravityApplyInputSchema } from '../rpc/protocol'
import { createGaLocationClient, gaApplyBody } from './host-ga'

const selector = `sel-${'a'.repeat(32)}`
const scope = { kind: 'sessionless' } as const
const cases = [
  ['accounts', 'add', {}],
  ['accounts', 'enable', {}],
  ['accounts', 'disable', {}],
  ['accounts', 'select-active', {}],
  ['accounts', 'select-claude', {}],
  ['accounts', 'select-gemini', {}],
  ['accounts', 'remove', {}],
  ['quota', 'refresh', {}],
  ['limits', 'killswitch-on', {}],
  ['limits', 'killswitch-off', {}],
  ['limits', 'killswitch-minimum', { percent: 30 }],
  ['diagnostics', 'log-level', { level: 'debug' }],
  ['diagnostics', 'dump-on', {}],
  ['diagnostics', 'dump-off', {}],
] as const

for (const [sectionId, actionId, values] of cases) {
  it(`legacy drawer strict-parser reproduction: ${sectionId}/${actionId}`, async () => {
    let issueText = ''
    const client = createGaLocationClient({
      location: undefined,
      call: async ({ method, input }) => {
        if (method === 'state')
          return {
            output: {
              version: 1,
              kind: 'snapshot',
              generation: 'g-proof',
              scope,
              reset: 'initial',
              cursor: 0,
              dropped: 0,
              more: false,
              notifications: [],
              readSeq: 1,
              accountsStatus: { kind: 'complete' },
              accounts: [],
              route: null,
              status: {
                checkedAt: null,
                quotaBackoffUntil: null,
                routingAuthoritative: true,
              },
              settings: {
                selectionStrategy: 'hybrid',
                killswitch: { enabled: false, minimumRemainingPercent: 5 },
                logLevel: 'info',
                dump: { enabled: false },
              },
            },
          }
        const parsed = AntigravityApplyInputSchema.parse(input)
        expect(parsed.ok).toBe(false)
        if (!parsed.ok) issueText = JSON.stringify(parsed.issues)
        throw new Error(issueText)
      },
    })
    await client.pull(scope)
    const request = {
      command: 'antigravity',
      sectionId,
      actionId,
      values,
      ...(sectionId === 'accounts' && actionId !== 'add'
        ? { itemId: `account:${selector}` }
        : {}),
      ...(actionId === 'remove' ? { confirmed: true as const } : {}),
    }
    await expect(client.apply(scope, gaApplyBody(request))).rejects.toThrow(
      'missing required key',
    )
    console.log(`REFUSED ${sectionId}/${actionId} ${issueText}`)
    client.dispose()
  })
}
