import { type LimitMessages } from './wording.js';
export type OpenCode1Family = 'openai-429' | 'claude-429' | 'json-412' | 'claustrum-429' | 'claustrum-402' | 'claude-econnreset';
export type RefusalFamily = OpenCode1Family | 'pi-final';
export type HostRetry = 'leave' | 'veto';
export interface RefusalInput {
    readonly family: RefusalFamily;
    /** Local responses formatted for OpenCode 2 must not be replayed by the host. */
    readonly host?: 'opencode1' | 'opencode2' | 'pi';
    readonly messageKey: string;
    readonly messages?: LimitMessages;
    readonly parameters?: {
        readonly labels?: readonly string[];
    };
    /**
     * Set only for re-login guidance, where the user needs to know which account to sign in again.
     * Ordinary refusals omit labels, even when the caller supplies them.
     */
    readonly labelPolicy?: 'relogin';
    readonly now: number;
    /** A retained reset, already filtered for freshness by the decision layer. */
    readonly resetAt?: number;
    readonly retryAfterMs?: number;
    /** Time already spent presenting a notice, not an instruction to sleep. */
    readonly noticeDelayMs?: number;
    /** Additional provider headers are preserved by the JSON 412 family only. */
    readonly extraHeaders?: ConstructorParameters<typeof Headers>[0];
}
interface RefusalAttributes {
    readonly family: RefusalFamily;
    readonly disposition: 'refuse';
    readonly retryable: boolean;
    readonly hostRetry: HostRetry;
}
export interface HttpRefusal extends RefusalAttributes {
    readonly kind: 'http';
    readonly status: 402 | 412 | 429;
    readonly headers: Headers;
    readonly body: string;
}
export interface TextRefusal extends RefusalAttributes {
    readonly kind: 'text';
    readonly body: string;
}
export declare class ClaudeIncompleteError extends Error {
    readonly code = "ECONNRESET";
    readonly syscall = "sticky-routing";
    readonly isRetryable = true;
    constructor(message: string);
}
export interface ThrownRefusal extends RefusalAttributes {
    readonly kind: 'throw';
    readonly error: ClaudeIncompleteError;
}
export type BuiltRefusal = HttpRefusal | TextRefusal | ThrownRefusal;
/** Compute metadata at delivery time, after time spent showing a notice. */
export declare function retryAfterSeconds(retryAfterMs: number | undefined, noticeDelayMs?: number): number | undefined;
/** Pure wire construction: the caller sends the response, emits text, or throws the error. */
export declare function buildRefusal(input: RefusalInput): BuiltRefusal;
export {};
