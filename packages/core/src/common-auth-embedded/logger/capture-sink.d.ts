import type { Level } from './engine.js';
export interface LogTestRecord {
    channel: string;
    level: Level;
    message: string;
    data?: unknown;
}
/** The engine delivers scrubbed records only; this sink never sees raw credentials. */
export type CaptureSink = (record: LogTestRecord) => void;
export declare function createCaptureSink(): {
    records: LogTestRecord[];
    sink: CaptureSink;
    clear: () => void;
};
