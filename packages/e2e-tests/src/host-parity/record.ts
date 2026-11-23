import {
  type Custody,
  custodies,
  hostPackages,
  nativeOptions,
  requestCases,
  type Subject,
  subjects,
  unrepresentable,
} from './cases.ts'
import { type Observation, runConversation } from './runner.ts'
import { responseScenarios } from './scenarios.ts'

export const baseCommit = 'b845e1a9bdf76a94f9c8869eaa43376032ba8e21'
export const key = (id: string, subject: Subject, custody: Custody) =>
  JSON.stringify([id, subject, custody])

export async function recordCorpus(
  sourceCommit: string,
  mode: 'baseline' | 'observe',
) {
  const requests: Record<string, unknown> = {}
  const responses: Record<string, Observation> = {}
  const captureHosts =
    mode === 'baseline' ? (['opencode1', 'opencode2'] as const) : subjects
  for (const input of requestCases) {
    for (const subject of captureHosts) {
      const host = subject === 'pi-transcript' ? 'pi' : subject
      const spelling = nativeOptions(input, host)
      requests[key(input.id, subject, 'local')] = {
        sourceCommit,
        host: hostPackages[host],
        ...('thinking' in spelling && spelling.thinking === unrepresentable
          ? { unrepresentable: true }
          : {
              ...(await runConversation({
                subject,
                custody: 'local',
                input,
                timed: true,
              })),
            }),
      }
    }
  }
  if (mode === 'observe') {
    for (const scenario of responseScenarios) {
      for (const subject of subjects) {
        for (const custody of custodies) {
          const reply = (_wire: unknown, n: number) =>
            scenario.replies[Math.min(n, scenario.replies.length - 1)]!
          responses[key(scenario.input.id, subject, custody)] =
            await runConversation({
              subject,
              custody,
              input: scenario.input,
              reply,
              timed: true,
            })
        }
      }
    }
  }
  return { requests, responses }
}
