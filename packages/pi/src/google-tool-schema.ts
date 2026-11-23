type Schema =
  | boolean
  | {
      type?: string | string[]
      description?: string
      required?: string[]
      format?: string
      const?: unknown
      enum?: unknown[]
      properties?: Record<string, Schema>
      additionalProperties?: unknown
      items?: Schema | Schema[]
      allOf?: Schema[]
      anyOf?: Schema[]
      oneOf?: Schema[]
      minLength?: number
    }

// Match the ordered OpenAPI subset emitted by @ai-sdk/google 3.0.73's
// convert-json-schema-to-openapi-schema.ts. Claude hardening runs after this.
export function googleToolParameters(input: unknown, root = true): unknown {
  const schema = input as Schema | undefined
  if (schema == null) return undefined
  if (typeof schema === 'boolean') return { type: 'boolean', properties: {} }
  const {
    type,
    description,
    required,
    format,
    properties,
    items,
    allOf,
    anyOf,
    oneOf,
  } = schema
  if (
    type === 'object' &&
    !Object.keys(properties ?? {}).length &&
    !schema.additionalProperties
  )
    return root
      ? undefined
      : { type: 'object', ...(description && { description }) }
  const result: Record<string, unknown> = {}
  if (description) result.description = description
  if (required) result.required = required
  if (format) result.format = format
  if (schema.const !== undefined) result.enum = [schema.const]
  if (Array.isArray(type)) {
    const nonNull = type.filter((t) => t !== 'null')
    if (!nonNull.length) result.type = 'null'
    else {
      result.anyOf = nonNull.map((type) => ({ type }))
      if (type.includes('null')) result.nullable = true
    }
  } else if (type) result.type = type
  if (schema.enum !== undefined) result.enum = schema.enum
  const child = (source: Schema) => googleToolParameters(source, false)
  if (properties)
    result.properties = Object.fromEntries(
      Object.entries(properties).map(([name, value]) => [name, child(value)]),
    )
  if (items)
    result.items = Array.isArray(items) ? items.map(child) : child(items)
  if (allOf) result.allOf = allOf.map(child)
  if (anyOf) {
    const nonNull = anyOf.filter(
      (value) => typeof value !== 'object' || value.type !== 'null',
    )
    if (nonNull.length === anyOf.length) result.anyOf = anyOf.map(child)
    else if (nonNull.length === 1) {
      const converted = child(nonNull[0]!)
      if (converted && typeof converted === 'object') {
        result.nullable = true
        Object.assign(result, converted)
      }
    } else {
      result.anyOf = nonNull.map(child)
      result.nullable = true
    }
  }
  if (oneOf) result.oneOf = oneOf.map(child)
  if (schema.minLength !== undefined) result.minLength = schema.minLength
  return result
}
