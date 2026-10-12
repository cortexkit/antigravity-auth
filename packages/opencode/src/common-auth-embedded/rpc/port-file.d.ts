import type { RpcLogChannel } from './index.js';
export interface PortFileEntry {
    port: number;
    token: string;
    pid: number;
    startedAt: number;
}
export declare function createManagedRpcStateDirPredicate(directoryPrefix: string): (name: string) => boolean;
export declare function isManagedRpcStateDir(name: string, directoryPrefix: string): boolean;
export declare function getRpcDir(rpcRoot: string, directoryPrefix: string, projectDirectory: string): string;
export declare function writePortFile(dir: string, entry: {
    port: number;
    token: string;
    pid: number;
}, options?: {
    secureDir?: boolean;
    beforeWrite?: () => void | Promise<void>;
    /** Test seam for forcing staging-name collisions; defaults to randomUUID. */
    stageName?: () => string;
}): Promise<string>;
export declare function sweepRpcState(root: string, activeDir: string, isManagedDir: (name: string) => boolean, log?: RpcLogChannel): Promise<void>;
export interface DiscoverPortFileOptions {
    /**
     * Return only the expected PID's entry, or null; never fall back to
     * another live server. Without an expected PID nothing matches, so the
     * result is null. Off by default, when a missing or unmatched expected PID
     * falls back to the newest live entry.
     */
    exactPid?: boolean;
}
/** Internal cache validation: probe only the selected file and its PID. */
export declare function portFileIdentity(dir: string, entry: PortFileEntry): Promise<string | null>;
export declare function discoverPortFile(dir: string, expectedPid?: number, options?: DiscoverPortFileOptions): Promise<PortFileEntry | null>;
