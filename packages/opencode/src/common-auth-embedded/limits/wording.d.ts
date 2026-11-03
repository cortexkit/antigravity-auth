import type { ResetFormatter } from './duration.js';
export declare function hasUnsafeWording(text: string): boolean;
export interface MessageParameters {
    readonly labels: readonly string[];
    readonly retryIn?: string;
    readonly reset?: string;
}
/** Templates return text only; they cannot replace a family's wire envelope. */
export type MessageTemplate = (parameters: MessageParameters) => string;
export declare class UnsafeWordingError extends Error {
    readonly messageKey: string;
    readonly code = "unsafe-wording";
    constructor(messageKey: string);
}
export interface LimitMessageOptions {
    readonly refusals?: Readonly<Record<string, MessageTemplate>>;
    readonly retryable?: Readonly<Record<string, MessageTemplate>>;
    readonly formatReset?: ResetFormatter;
}
export interface LimitMessages {
    readonly formatReset?: ResetFormatter;
    readonly render: (messageKey: string, parameters: MessageParameters, nonRetryable: boolean) => string | undefined;
}
/** Registration rejects unsafe fixed text; actual substitutions are checked again. */
export declare function registerLimitMessages(options: LimitMessageOptions): LimitMessages;
