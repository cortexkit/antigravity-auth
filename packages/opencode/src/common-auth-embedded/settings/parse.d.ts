import { type Node, type ParseError } from 'jsonc-parser';
interface ParsedText {
    /** Text without the optional leading BOM; tree offsets refer to this text. */
    text: string;
    hasBom: boolean;
    tree: Node | undefined;
}
export interface ParsedSettings extends ParsedText {
    parseable: true;
    value: Record<string, unknown>;
    duplicateKeyPaths: string[][];
    hasDuplicates: boolean;
}
export interface UnparseableSettings extends ParsedText {
    parseable: false;
    errors: ParseError[];
}
export type SettingsParseResult = ParsedSettings | UnparseableSettings;
/** Define own data properties so JSON keys never invoke prototype setters. */
export declare function defineSettingsKey(target: Record<string, unknown>, key: string, value: unknown): void;
/** Convert in document order, retaining the last occurrence of a repeated key. */
export declare function settingsValueFromTree(node: Node, onDuplicate?: (keyPath: string[]) => void, keyPath?: string[]): unknown;
export declare function parseSettings(source: string): SettingsParseResult;
export {};
