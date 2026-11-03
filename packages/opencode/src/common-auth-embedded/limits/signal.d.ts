import type { Scope } from './scope.js';
/** Refreshing credentials preserves this key; replacing an identity does not. */
export interface AccountKey {
    readonly namespace: string;
    readonly accountId: string;
    readonly incarnation: string;
}
export type LimitKind = 'quota-exhausted' | 'rate-limit' | 'capacity' | 'payment-balance' | 'payment-cap' | 'auth' | 'account-access' | 'model-unavailable';
export interface LimitWindow {
    readonly window: string;
    readonly confirmed: boolean;
    readonly confirmedByReading: boolean;
    readonly resetAt?: number;
    readonly resetSource?: string;
    readonly observedAt: number;
    readonly provenance: string;
}
/** A retry hint does not by itself confirm any exhausted window. */
export interface LimitSignal {
    readonly account: AccountKey;
    readonly kind: LimitKind;
    readonly reason: string;
    readonly status?: number;
    readonly scope: Scope;
    readonly windows: readonly LimitWindow[];
    readonly observedAt: number;
    readonly retryAfterMs?: number;
    readonly retryAfterSource?: string;
}
export interface ClassifierInput {
    readonly account: AccountKey;
    readonly status: number;
    readonly headers: Headers;
    readonly body?: unknown;
    readonly firstEvent?: unknown;
    readonly effectiveModel: string;
    readonly readings: readonly LimitWindow[];
    readonly now: number;
}
/** Returning nothing must not manufacture an exhaustion mark. */
export type LimitClassifier = (input: ClassifierInput) => LimitSignal | undefined;
