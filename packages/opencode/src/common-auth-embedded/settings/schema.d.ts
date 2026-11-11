import type { SettingsDefinition } from './define.js';
interface JsonSchema {
    type?: 'boolean' | 'integer' | 'number' | 'string' | 'array' | 'object';
    minimum?: number;
    maximum?: number;
    enum?: string[];
    items?: JsonSchema;
    properties?: Record<string, JsonSchema>;
    additionalProperties?: boolean | JsonSchema;
    required?: string[];
    anyOf?: JsonSchema[];
    propertyNames?: {
        not: {
            enum: string[];
        };
    };
}
/**
 * Generate the plugin's JSON Schema deterministically from its settings definition.
 * Plugins ship the generated schema and check their parsed shipped file with:
 * `expect(shippedSchema).toEqual(settingsJsonSchema(definition))`.
 */
export declare function settingsJsonSchema(definition: SettingsDefinition): {
    $schema: string;
    type: 'object';
    properties: Record<string, JsonSchema>;
    additionalProperties: false;
};
export {};
