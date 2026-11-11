interface ConfigDirOptions {
    env: Readonly<Record<string, string | undefined>>;
    platform: NodeJS.Platform;
    homedir: string;
}
export declare function isAbsoluteForPlatform(path: string, platform: NodeJS.Platform): boolean;
export declare function cortexkitConfigDir({ env, platform, homedir, }: ConfigDirOptions): string;
export declare function settingsFilePath({ plugin, override, ...options }: ConfigDirOptions & {
    plugin: string;
    override?: string;
}): string;
export {};
