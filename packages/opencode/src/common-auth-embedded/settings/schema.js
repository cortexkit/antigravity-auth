function descriptorSchema(descriptor, completeObjects = false) {
    switch (descriptor.kind) {
        case 'boolean':
        case 'string':
            return { type: descriptor.kind };
        case 'integer':
        case 'number':
            return {
                type: descriptor.kind,
                ...(descriptor.min !== undefined ? { minimum: descriptor.min } : {}),
                ...(descriptor.max !== undefined ? { maximum: descriptor.max } : {}),
            };
        case 'oneOf':
            return { enum: [...descriptor.values] };
        case 'list':
            return { type: 'array', items: descriptorSchema(descriptor.item, true) };
        case 'object':
            return {
                type: 'object',
                properties: Object.fromEntries(Object.entries(descriptor.fields).map(([name, field]) => [
                    name,
                    descriptorSchema(field, completeObjects),
                ])),
                additionalProperties: false,
                // Objects merge field by field, except in lists and records, which replace whole values.
                ...(completeObjects
                    ? { required: Object.keys(descriptor.fields) }
                    : {}),
            };
        case 'record':
            return {
                type: 'object',
                additionalProperties: descriptorSchema(descriptor.value, true),
            };
    }
}
function settingSchema(declaration) {
    const value = descriptorSchema(declaration.value);
    if (declaration.overrides === undefined)
        return value;
    const { host, model } = declaration.overrides;
    const properties = { default: value };
    if (host) {
        properties.opencode = value;
        properties.pi = value;
    }
    return {
        anyOf: [
            value,
            {
                type: 'object',
                properties,
                additionalProperties: model ? value : false,
                ...(model && !host
                    ? { propertyNames: { not: { enum: ['opencode', 'pi'] } } }
                    : {}),
            },
        ],
    };
}
/**
 * Generate the plugin's JSON Schema deterministically from its settings definition.
 * Plugins ship the generated schema and check their parsed shipped file with:
 * `expect(shippedSchema).toEqual(settingsJsonSchema(definition))`.
 */
export function settingsJsonSchema(definition) {
    const properties = {
        schema_version: { type: 'integer', minimum: 1 },
        $schema: { type: 'string' },
        ...Object.fromEntries(Object.entries(definition.settings).map(([name, declaration]) => [
            name,
            settingSchema(declaration),
        ])),
    };
    return {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties,
        additionalProperties: false,
    };
}
