export declare const QUOTA_COMMIT_INTERVAL_MS = 30000;
export interface QuotaCommitTimer {
    now(): number;
    schedule(delayMs: number, run: () => Promise<void>): {
        cancel(): void;
        unref?(): void;
    };
}
export declare const quotaCommitTimer: QuotaCommitTimer;
