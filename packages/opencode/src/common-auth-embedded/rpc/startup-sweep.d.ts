import type { RpcLogChannel } from './index.js';
/** Internal clock seam; reset the process-wide budget between tests. */
export declare function resetRpcSweepForTest(clock?: () => number): void;
export declare function sweepRpcStateOnStart(root: string, activeDir: string, isManagedDir: (name: string) => boolean, log: RpcLogChannel): Promise<void>;
