export interface LoadTuiOptions {
    rawEntry: string;
    runtimeEntry: string;
    importModule?: (specifier: string) => Promise<{
        default?: unknown;
    }>;
}
export declare function loadTui({ rawEntry, runtimeEntry, importModule, }: LoadTuiOptions): Promise<unknown>;
