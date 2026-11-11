import { type ValueDescriptor, type ValueOf, type ValueValidationOptions } from './descriptors.js';
export interface SettingDeclaration<D extends ValueDescriptor = ValueDescriptor> {
    readonly value: D;
    readonly default: ValueDescriptor extends D ? unknown : ValueOf<D>;
    readonly hosts: 'both' | 'opencode' | 'pi' | string;
    readonly overrides?: {
        readonly host?: true;
        readonly model?: true;
    };
    readonly project?: 'user-only' | 'allowed';
    readonly legacy?: readonly {
        readonly source: string;
        readonly path: readonly string[];
    }[];
}
type Declarations = Readonly<Record<string, SettingDeclaration>>;
export interface SettingsDefinition<S extends Declarations = Declarations> {
    readonly plugin: string;
    readonly settings: {
        readonly [K in keyof S]: S[K] & {
            readonly project: S[K] extends {
                readonly project: infer P;
            } ? P : 'project' extends keyof S[K] ? Exclude<S[K]['project'], undefined> | 'user-only' : 'user-only';
        };
    };
}
export declare function defineSettings<const S extends Declarations>(definition: {
    readonly plugin: string;
    readonly settings: S;
}): SettingsDefinition<S>;
/** Internal helper: host names are reserved and never count as model ids. */
export declare function isOverrideKeyAllowed(overrides: NonNullable<SettingDeclaration['overrides']>, key: string): boolean;
/** Validate a file, update or map value, including any permitted override object. */
export declare function validateSettingValue(declaration: Pick<SettingDeclaration, 'value' | 'overrides'>, value: unknown, options?: ValueValidationOptions): boolean;
export {};
