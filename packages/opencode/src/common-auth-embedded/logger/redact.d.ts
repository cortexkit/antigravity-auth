export interface RedactionOptions {
    extraSecretKeys?: (normalizedKey: string) => boolean;
    extraValuePatterns?: RegExp[];
}
export declare function createRedactor(options?: RedactionOptions): {
    redact: (value: unknown) => unknown;
    redactStrings: (value: unknown) => unknown;
};
export type Redactor = ReturnType<typeof createRedactor>;
export declare const redact: (value: unknown) => unknown;
export declare const redactStrings: (value: unknown) => unknown;
