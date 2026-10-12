export * from './notifications.js';
export * from './port-file.js';
export * from './rpc-client.js';
export * from './rpc-server.js';
export * from './server-registry.js';
/** Pass methods bound to the caller’s logger channel; RPC uses no-op methods when no logger is supplied. */
export interface RpcLogChannel {
    warn(message: string, data?: unknown): void;
    debug(message: string, data?: unknown): void;
}
