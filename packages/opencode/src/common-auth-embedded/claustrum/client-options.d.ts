import { type ClaustrumClientOptions } from '@cortexkit/claustrum-client';
export type CompatibleClaustrumClientOptions = ClaustrumClientOptions & {
    /** Project root for claustrum-client versions before 0.22 only. */
    projectRoot?: string;
};
export declare function defaultStoreIdentity(options: CompatibleClaustrumClientOptions): import("@cortexkit/subc-client").BindIdentity;
export declare function claustrumWireOptions(options: CompatibleClaustrumClientOptions): ClaustrumClientOptions;
