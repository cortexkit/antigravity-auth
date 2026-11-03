/** Compact durations keep every numeric component below the hosts' retry codes. */
export declare function formatDuration(ms: number): string;
export interface ResetFormatInput {
    readonly resetAt: number;
    readonly now: number;
}
export type ResetFormatter = (input: ResetFormatInput) => string;
export declare const formatReset: ResetFormatter;
