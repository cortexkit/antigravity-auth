import type { Conversation, Custody, Subject } from './cases.ts'
import { Environment } from './environment.ts'
import { candidate, type Reply, sse, type Wire } from './fixtures.ts'
import { openCode1, openCode2 } from './open-code.ts'
import { piAdapter } from './pi-surface.ts'
import { signature } from './scenarios.ts'

export async function runConversation({
  subject,
  custody,
  input,
  reply,
  timed = false,
}: {
  subject: Subject
  custody: Custody
  input: Conversation
  reply?: (wire: Wire, attempt: number) => Reply
  timed?: boolean
}) {
  const environment = new Environment(
    reply ??
      (input.replayText
        ? () => ({
            body: sse(
              candidate(
                [{ text: 'Four.' }, { text: '', thoughtSignature: signature }],
                'STOP',
              ),
            ),
          })
        : undefined),
  )
  const scope = `${encodeURIComponent(input.id)}:${subject}:${custody}:`
  const accessor = Symbol.for('cortexkit.routing')
  const prior = Reflect.getOwnPropertyDescriptor(globalThis, accessor)
  if (custody !== 'local') {
    Reflect.defineProperty(globalThis, accessor, {
      configurable: true,
      value: (sessionId: string) => ({
        report: (report: unknown) => {
          environment.reports.push({
            sessionId: sessionId.replace(scope, ''),
            report,
          })
        },
      }),
    })
  }
  try {
    const host = await (subject === 'opencode1'
      ? openCode1(environment, custody, input)
      : subject === 'opencode2'
        ? openCode2(environment, custody, input)
        : piAdapter(environment, custody, subject === 'pi-transcript'))
    try {
      const operation = async () => {
        const turns = []
        for (const [index, session] of input.sessions.entries()) {
          const step = { ...input, ...input.steps?.[index] }
          const previous = turns.at(-1)
          if (input.replayText && previous?.text) {
            // Replay exactly what the host exposed, including the absence of
            // a signature if its public decoder dropped the signature delta.
            step.messages = [
              step.messages[0]!,
              {
                role: 'assistant',
                parts: [
                  {
                    type: 'text',
                    text: previous.text,
                    signature: previous.signatures.find(
                      ({ channel }) => channel === 'text',
                    )?.value,
                  },
                ],
              },
              ...step.messages.slice(1),
            ]
          }
          turns.push(
            await host.run(
              step,
              session === undefined ? undefined : `${scope}${session}`,
            ),
          )
        }
        return turns
      }
      const turns = await (timed ? environment.timed(operation) : operation())
      return {
        wire: environment.wires,
        physicalSends: environment.physicalSends,
        delays: environment.delays,
        aborts: environment.aborts,
        cancellations: environment.cancellations,
        reports: environment.reports,
        hooks: environment.hooks,
        notices: environment.notices,
        turns,
      }
    } finally {
      await host.dispose()
    }
  } finally {
    if (prior) Reflect.defineProperty(globalThis, accessor, prior)
    else Reflect.deleteProperty(globalThis, accessor)
    environment.dispose()
  }
}

export type Observation = Awaited<ReturnType<typeof runConversation>>
