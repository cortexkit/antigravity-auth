import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  buildGeminiDumpStatusSummary,
  createGeminiDumpResponseTransform,
  dumpGeminiRequest,
  executeGeminiDumpCommand,
  getGeminiDumpDirectory,
  parseGeminiDumpCommandAction,
  resetGeminiDumpState,
  setGeminiDumpEnabled,
} from './gemini-dump'

const originalDumpDir = process.env.OPENCODE_ANTIGRAVITY_GEMINI_DUMP_DIR
const originalDumpEnabled = process.env.OPENCODE_ANTIGRAVITY_GEMINI_DUMP

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'gemini-dump-test-'))
}

afterEach(() => {
  if (originalDumpDir === undefined) {
    delete process.env.OPENCODE_ANTIGRAVITY_GEMINI_DUMP_DIR
  } else {
    process.env.OPENCODE_ANTIGRAVITY_GEMINI_DUMP_DIR = originalDumpDir
  }
  if (originalDumpEnabled === undefined) {
    delete process.env.OPENCODE_ANTIGRAVITY_GEMINI_DUMP
  } else {
    process.env.OPENCODE_ANTIGRAVITY_GEMINI_DUMP = originalDumpEnabled
  }
  resetGeminiDumpState()
})

describe('gemini dump command', () => {
  it('parses status/on/off/usage actions', () => {
    expect(parseGeminiDumpCommandAction('')).toEqual({ type: 'status' })
    expect(parseGeminiDumpCommandAction('on')).toEqual({ type: 'enable' })
    expect(parseGeminiDumpCommandAction('off')).toEqual({ type: 'disable' })
    expect(parseGeminiDumpCommandAction('wat')).toEqual({ type: 'usage' })
  })

  it('renders status and toggle replies', () => {
    const dir = tempDir()
    process.env.OPENCODE_ANTIGRAVITY_GEMINI_DUMP_DIR = dir
    setGeminiDumpEnabled(false)

    expect(getGeminiDumpDirectory()).toBe(dir)
    expect(buildGeminiDumpStatusSummary()).toContain('Enabled: disabled')
    expect(executeGeminiDumpCommand({ argumentsText: 'on' })).toContain(
      'Gemini Dump Enabled',
    )
    expect(executeGeminiDumpCommand({ argumentsText: 'off' })).toContain(
      'Gemini Dump Disabled',
    )
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('gemini wire dump', () => {
  it('dumps request metadata and raw response chunks when enabled', async () => {
    const dir = tempDir()
    process.env.OPENCODE_ANTIGRAVITY_GEMINI_DUMP_DIR = dir
    setGeminiDumpEnabled(true)

    const body = JSON.stringify({
      requestId: 'agent/test/1',
      model: 'gemini-3-flash-agent',
      requestType: 'DEFAULT',
      request: {
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        tools: [
          { functionDeclarations: [{ name: 'read' }, { name: 'write' }] },
        ],
      },
    })

    const context = dumpGeminiRequest({
      originalUrl:
        'https://generativelanguage.googleapis.com/v1beta/models/x:streamGenerateContent',
      resolvedUrl:
        'https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse',
      method: 'POST',
      headers: {
        Authorization: 'Bearer secret',
        'Content-Type': 'application/json',
      },
      body,
      streaming: true,
      requestedModel: 'antigravity-gemini-3.5-flash',
      effectiveModel: 'gemini-3-flash-agent',
      sessionId: 'ses_test',
      projectId: 'project',
    })

    expect(context).not.toBeNull()
    const transformer = createGeminiDumpResponseTransform(context)
    expect(transformer).not.toBeNull()

    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: one\n'))
        controller.close()
      },
    })
    const reader = source.pipeThrough(transformer!).getReader()
    while (!(await reader.read()).done) {
      // drain stream
    }

    const request = JSON.parse(readFileSync(context!.files.request, 'utf8'))
    const response = readFileSync(context!.files.response, 'utf8')
    const metadata = JSON.parse(readFileSync(context!.files.metadata, 'utf8'))

    expect(request.model).toBe('gemini-3-flash-agent')
    expect(response).toBe('data: one\n')
    expect(metadata.headers.Authorization).toBe('[redacted]')
    expect(metadata.request.toolsCount).toBe(2)
    expect(metadata.request.toolsFirst).toEqual(['read', 'write'])

    rmSync(dir, { recursive: true, force: true })
  })

  it('redacts project IDs from the dumped request body', () => {
    const dir = tempDir()
    process.env.OPENCODE_ANTIGRAVITY_GEMINI_DUMP_DIR = dir
    setGeminiDumpEnabled(true)

    const body = JSON.stringify({
      projectId: 'secret-proj-1234567890',
      managedProjectId: 'managed-secret-1234567890',
      model: 'gemini-3-pro',
    })

    const context = dumpGeminiRequest({
      originalUrl:
        'https://generativelanguage.googleapis.com/v1beta/models/x:generateContent',
      resolvedUrl:
        'https://generativelanguage.googleapis.com/v1beta/models/x:generateContent',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      streaming: false,
    })

    expect(context).not.toBeNull()
    const dumped = readFileSync(context!.files.request, 'utf8')
    expect(dumped).not.toContain('secret-proj-1234567890')
    expect(dumped).not.toContain('managed-secret-1234567890')
    const parsed = JSON.parse(dumped)
    expect(parsed.model).toBe('gemini-3-pro')
    expect(parsed.projectId).toBe('secr****7890')
    expect(parsed.managedProjectId).toBe('mana****7890')

    rmSync(dir, { recursive: true, force: true })
  })

  it('does not dump when disabled', () => {
    setGeminiDumpEnabled(false)
    const context = dumpGeminiRequest({
      originalUrl: 'original',
      resolvedUrl: 'resolved',
      body: '{}',
      streaming: true,
    })
    expect(context).toBeNull()
  })
})
