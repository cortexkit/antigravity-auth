import { hasVaultHost } from '../common-auth-embedded/claustrum/host.js'
import type { RequestRouting, RequestRoutingReport } from './routing-port.ts'

const accessor = () => Reflect.get(globalThis, Symbol.for('cortexkit.routing'))

// Translate the engine's closed report types to the routing accessor's wire
// fields. A bound account never asks the accessor to choose another route.
function reportFields(report: RequestRoutingReport) {
  if (!('kind' in report)) {
    const identity = {
      account_id: report.accountId,
      credential_id: report.credentialId,
    }
    return report.outcome === 'served'
      ? { ...identity, outcome: 'served', headers: report.headers }
      : {
          ...identity,
          outcome: 'exhausted',
          window: report.window,
          pool: report.pool,
          resets_at: report.resetsAt,
        }
  }
  switch (report.kind) {
    case 'transient_backoff':
      return {
        kind: report.kind,
        account_id: report.accountId,
        credential_id: report.credentialId,
        retry_at_ms: report.retryAtMs,
      }
    case 'wait':
      return {
        kind: report.kind,
        phase: report.phase,
        wait_id: report.waitId,
        reason: report.reason,
        next_ms: report.nextMs,
        attempt: report.attempt,
        message: report.message,
        outcome: report.outcome,
      }
    case 'billing':
      return {
        kind: report.kind,
        attempt_id: report.attemptId,
        request_kind: report.requestKind,
        credential_id: report.credentialId,
        account_id: report.accountId,
        provider: report.provider,
        model: report.model,
        outcome: report.outcome,
        status: report.status,
        attempt: report.attempt,
        charge_basis: report.chargeBasis,
        cache: report.cache,
        ...(report.usage && {
          usage: {
            input: report.usage.input,
            output: report.usage.output,
            cache_read: report.usage.cacheRead,
            reasoning: report.usage.reasoning,
            reasoning_included_in_output:
              report.usage.reasoningIncludedInOutput,
          },
        }),
      }
  }
}

export const boundRequestRouting: RequestRouting = {
  hasAccessor: () => typeof accessor() === 'function',
  hasVaultHost,
  ask: async () => undefined,
  askUntilCapacity: async () => undefined,
  report(report) {
    try {
      const route = accessor()
      if (typeof route !== 'function') return
      const handle = route(report.sessionId)
      if (typeof handle?.report !== 'function') return
      void Promise.resolve(handle.report(reportFields(report))).catch(() => {})
    } catch {
      // The caller's request never depends on advisory report publication.
    }
  },
}
