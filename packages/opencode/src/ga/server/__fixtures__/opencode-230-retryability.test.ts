type HttpDetails = { http?: { headers: Record<string, string> } }
type Reason = HttpDetails &
  (
    | {
        _tag:
          | 'RateLimit'
          | 'ProviderInternal'
          | 'UnknownProvider'
          | 'Authentication'
          | 'QuotaExceeded'
          | 'ContentPolicy'
          | 'InvalidRequest'
          | 'UnsupportedOperation'
          | 'Timeout'
      }
    | {
        _tag: 'Transport'
        delivery: 'rejected' | 'accepted' | 'unknown'
        operation: 'read' | 'write'
      }
    | { _tag: 'InvalidProviderOutput'; classification: string }
  )

// The getter below is copied from OpenCode v2.3.0 (formatting only changed):
// https://github.com/anomalyco/opencode/blob/a6b15d33daf6ab7d35569f6d711fdb630b9f04e7/packages/ai/src/schema/errors.ts#L197-L230
// The stand-in reason types avoid importing OpenCode's Effect/schema runtime.
export class OpenCode230Retryability {
  constructor(readonly reason: Reason) {}

  get isRetryable(): boolean {
    const override = this.reason.http?.headers['x-should-retry']
    if (override === 'true') return true
    if (override === 'false') return false
    switch (this.reason._tag) {
      case 'RateLimit':
      case 'ProviderInternal':
        return true
      // A WebSocket acknowledgment marks delivery accepted before model output may exist.
      // Read failures can still recover; the caller chooses retry versus continuation from durable output.
      case 'Transport':
        return (
          this.reason.delivery !== 'rejected' &&
          (this.reason.delivery !== 'accepted' ||
            this.reason.operation === 'read')
        )
      case 'InvalidProviderOutput':
        return this.reason.classification === 'incomplete-stream'
      // Unrecognized failures retry: classification records affirmative
      // deterministic evidence, and transient failures are exactly the ones
      // that arrive in shapes no classifier anticipates.
      case 'UnknownProvider':
        return true
      case 'Authentication':
      case 'QuotaExceeded':
      case 'ContentPolicy':
      case 'InvalidRequest':
      case 'UnsupportedOperation':
      case 'Timeout':
        return false
      default: {
        const exhaustive: never = this.reason
        return exhaustive
      }
    }
  }
}
