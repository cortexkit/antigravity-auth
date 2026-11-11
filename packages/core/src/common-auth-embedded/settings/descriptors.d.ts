export type ValueDescriptor = {
    readonly kind: 'boolean';
} | {
    readonly kind: 'integer';
    readonly min?: number;
    readonly max?: number;
} | {
    readonly kind: 'number';
    readonly min?: number;
    readonly max?: number;
} | {
    readonly kind: 'string';
} | {
    readonly kind: 'oneOf';
    readonly values: readonly string[];
} | {
    readonly kind: 'list';
    readonly item: ValueDescriptor;
} | {
    readonly kind: 'object';
    readonly fields: Readonly<Record<string, ValueDescriptor>>;
} | {
    readonly kind: 'record';
    readonly value: ValueDescriptor;
};
type SettingsValue = boolean | number | string | SettingsValue[] | {
    [key: string]: SettingsValue;
};
export type ValueOf<D extends ValueDescriptor> = ValueDescriptor extends D ? SettingsValue : D extends {
    kind: 'boolean';
} ? boolean : D extends {
    kind: 'integer' | 'number';
} ? number : D extends {
    kind: 'string';
} ? string : D extends {
    kind: 'oneOf';
    values: infer V extends readonly string[];
} ? V[number] : D extends {
    kind: 'list';
    item: infer I extends ValueDescriptor;
} ? ValueOf<I>[] : D extends {
    kind: 'object';
    fields: infer F extends Readonly<Record<string, ValueDescriptor>>;
} ? {
    -readonly [K in keyof F]: ValueOf<F[K]>;
} : D extends {
    kind: 'record';
    value: infer V extends ValueDescriptor;
} ? Record<string, ValueOf<V>> : never;
type Bounds = {
    readonly min?: number;
    readonly max?: number;
};
export declare function boolean(): Readonly<{
    readonly kind: 'boolean';
}>;
export declare function integer({ min, max }?: Bounds): Readonly<{
    readonly kind: 'integer';
    readonly min: number | undefined;
    readonly max: number | undefined;
}>;
export declare function number({ min, max }?: Bounds): Readonly<{
    readonly kind: 'number';
    readonly min: number | undefined;
    readonly max: number | undefined;
}>;
export declare function string(): Readonly<{
    readonly kind: 'string';
}>;
export declare function oneOf<const V extends readonly string[]>(values: V): Readonly<{
    readonly kind: 'oneOf';
    readonly values: Readonly<V>;
}>;
export declare function list<const D extends ValueDescriptor>(item: D): {
    readonly kind: 'list';
    readonly item: D;
};
export declare function object<const F extends Readonly<Record<string, ValueDescriptor>>>(fields: F): {
    readonly kind: 'object';
    readonly fields: F;
};
export declare function record<const D extends ValueDescriptor>(value: D): {
    readonly kind: 'record';
    readonly value: D;
};
/** Internal validation policy shared by file readers, updates and migration maps. */
export interface ValueValidationOptions {
    readonly completeObjects?: boolean;
    readonly allowUnknownFields?: boolean;
}
/** JSON objects exclude arrays and objects such as Date that serialize differently. */
export declare function isJsonObject(value: unknown): value is Record<string, unknown>;
/** Missing fields can be filled from lower levels, but list and record objects must be complete. */
export declare function validateValue(descriptor: ValueDescriptor, value: unknown, options?: ValueValidationOptions): boolean;
/** Internal helper; definitions and descriptor payloads are immutable at runtime. */
export declare function deepFreeze<T>(value: T): T;
export {};
