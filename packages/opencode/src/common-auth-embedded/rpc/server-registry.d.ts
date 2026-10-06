import type { RpcServerHandle } from './rpc-server.js';
export interface RpcServerAdoption {
    server: RpcServerHandle;
    release: () => Promise<void>;
}
/**
 * Serializes same-directory replacement. Release checks the adopted server
 * identity so an older holder cannot stop or remove its successor.
 * Distinct project directories remain independent.
 */
export declare function adoptRpcServer(registryKey: string, rpcDir: string, create: () => Promise<RpcServerHandle>): Promise<RpcServerAdoption>;
