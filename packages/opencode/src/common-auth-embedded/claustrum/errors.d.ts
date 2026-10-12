/**
 * Every refusal the `/claustrum` code raises itself. Refusals sent by the
 * vault keep arriving as the client's own `ClaustrumCredentialError` (a
 * `code`, a `class` and an `action`), so callers can tell the vault's verdict
 * apart from a check made on this side.
 */
export type ClaustrumConsumerFailureKind = 'closed' | 'not-enrolled' | 'invalid-token' | 'unavailable' | 'identity-changed' | 'identity-unasserted' | 'insufficient-validity' | 'invalid-material' | 'not-active' | 'route-unavailable' | 'route-declined' | 'no-receipt' | 'unsafe-file' | 'invalid-state' | 'wrong-consumer' | 'roster-busy' | 'host-slot-login' | 'host-slot-placeholder' | 'placeholder-refresh';
export declare class ClaustrumConsumerError extends Error {
    readonly kind: ClaustrumConsumerFailureKind;
    constructor(kind: ClaustrumConsumerFailureKind, message: string);
}
/** The structural logger every class here accepts; `/logger`'s `createLogger` satisfies it. */
export interface ClaustrumLogger {
    warn(message: string, data?: unknown): void;
    debug(message: string, data?: unknown): void;
}
