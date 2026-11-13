import { expect } from 'bun:test'
import projection from './identity-projection.json'

export const captures = projection.runs.r2
export const toolNames = captures[0]!.tool_names
export const signature = 's'.repeat(64)

export function assertIdentity(
  envelope: any,
  capture: (typeof captures)[number],
  requestIndex: number,
  previous?: any,
): void {
  const request = envelope.request
  const labels = request.labels
  const id = envelope.requestId.split('/')
  expect(id).toEqual([
    'agent', expect.any(String), expect.stringMatching(/^\d+$/),
    expect.any(String), String(request.contents.length),
  ])
  expect(id[1]).toMatch(/^[\da-f-]{36}$/)
  expect(id[3]).toMatch(/^[\da-f-]{36}$/)
  if (previous) {
    const previousId = previous.requestId.split('/')
    expect([id[1], id[3]]).toEqual([previousId[1], previousId[3]])
  }
  const expectedLabels = {
    cascade_id: id[1],
    ...(requestIndex >= 2 ? { last_execution_id: expect.stringMatching(/^[\da-f-]{36}$/) } : {}),
    last_step_index: String(request.contents.length - 1),
    model_enum: capture.labels.model_enum,
    request_id: `${id[3]}-${requestIndex}`,
    root_cascade_id: id[1],
    trajectory_id: id[3],
    used_claude: capture.labels.used_claude,
    used_claude_conservative: capture.labels.used_claude_conservative,
    used_non_gemini_model: capture.labels.used_non_gemini_model,
  }
  expect(labels).toEqual(expectedLabels)
  expect(Object.keys(labels)).toEqual(Object.keys(expectedLabels))
  expect(Object.keys(envelope)).toEqual(capture.envelope_keys)
  expect(Object.keys(request)).toEqual(capture.request_keys)
  expect(envelope.userAgent).toBe(capture.envelope_user_agent)
  expect(envelope.requestType).toBe(capture.request_type)
  expect(request.sessionId).toBe('-3750763034362895579')
  expect(request).not.toHaveProperty('toolConfig')
  expect(Object.keys(request.systemInstruction)).toEqual(capture.system_instruction_keys)
  expect(request.tools.map((tool: any) => ({
    keys: Object.keys(tool),
    declarations: tool.functionDeclarations.length,
    declaration_keys: tool.functionDeclarations.map((declaration: any) => Object.keys(declaration)),
  }))).toEqual(capture.tools_shape)
  expect(request.tools.flatMap((tool: any) => tool.functionDeclarations.map((declaration: any) => declaration.name))).toEqual(capture.tool_names)
  if (requestIndex < 2) {
    expect(request.contents.map((content: any) => ({
      role: content.role,
      parts_keys: content.parts.map((part: any) => Object.keys(part)),
    }))).toEqual(capture.contents_shape)
  }
}
