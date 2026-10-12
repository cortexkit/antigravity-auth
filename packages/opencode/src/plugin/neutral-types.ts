/**
 * Host-SDK-free types shared by both host adapters.
 *
 * Modules that a server location reaches (configuration, logging, debug,
 * dump, signature cache, operator settings and the request services that use
 * them) must not depend on the OpenCode plugin SDK, not even through
 * `import type`. `./types` re-exports SDK shapes, so code that only needs
 * credential records or the capability shapes below imports them from here.
 * The `@cortexkit/antigravity-auth-core` package is an external boundary and
 * may be referenced directly.
 */

export type {
  ApiKeyAuthDetails,
  AuthDetails,
  GetAuth,
  NonOAuthAuthDetails,
  OAuthAuthDetails,
  ProjectContextResult,
  RefreshParts,
} from '@cortexkit/antigravity-auth-core'

/** Wall-clock source in epoch milliseconds; tests inject a fixed clock. */
export type Clock = () => number

/** Severity of a structured plugin log record. */
export type LocationLogLevel = 'debug' | 'info' | 'warn' | 'error'

/** One scrubbed structured log record delivered to a location's log sink. */
export interface LocationLogRecord {
  service: string
  level: LocationLogLevel
  message: string
  extra?: Record<string, unknown>
}

/**
 * Host destination for one location's log records. OpenCode 1 adapts its
 * host's `app.log`; the GA adapter uses the host logger it is handed. A sink
 * may be asynchronous; rejections are swallowed by the caller.
 */
export type LocationLogSink = (record: LocationLogRecord) => unknown

/**
 * Structural shape of a host client that exposes `app.log`, which is all the
 * OpenCode 1 log adapter needs. Declared here so logging code never imports
 * the host SDK's client type.
 */
export interface AppLogClient {
  app?: {
    log?(input: { body: LocationLogRecord }): unknown
  }
}
