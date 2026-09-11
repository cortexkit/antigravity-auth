import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadAccountStorage } from '@cortexkit/antigravity-auth-core'
import {
  discoverAndLoadExtensions,
  ExtensionRunner,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
} from '@earendil-works/pi-coding-agent'

let directory: string
let previousAccountPath: string | undefined
let previousAgentDir: string | undefined

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'pi-extension-load-'))
  previousAccountPath = process.env.PI_ANTIGRAVITY_AUTH_FILE
  previousAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_ANTIGRAVITY_AUTH_FILE = join(directory, 'accounts.json')
  process.env.PI_CODING_AGENT_DIR = join(directory, 'agent')
})

afterEach(async () => {
  if (previousAccountPath === undefined)
    delete process.env.PI_ANTIGRAVITY_AUTH_FILE
  else process.env.PI_ANTIGRAVITY_AUTH_FILE = previousAccountPath
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir
  await rm(directory, { recursive: true, force: true })
})

async function writeHostCredential(credential: object): Promise<void> {
  const agentDir = process.env.PI_CODING_AGENT_DIR!
  await mkdir(agentDir, { recursive: true })
  await writeFile(
    join(agentDir, 'auth.json'),
    JSON.stringify({ 'google-antigravity': credential }),
  )
}

describe('Pi 0.85 extension loading', () => {
  it('loads through the real extension runner and migrates only stored OAuth credentials at session_start', async () => {
    const loaded = await discoverAndLoadExtensions(
      [join(import.meta.dir, 'index.ts')],
      directory,
      process.env.PI_CODING_AGENT_DIR,
    )
    expect(loaded.errors).toEqual([])
    expect(loaded.extensions).toHaveLength(1)
    expect(loaded.extensions[0]?.commands.has('agy-accounts')).toBe(true)
    expect(
      loaded.runtime.pendingProviderRegistrations.map(({ name }) => name),
    ).toEqual(['google-antigravity'])

    const modelRuntime = await ModelRuntime.create({
      authPath: join(process.env.PI_CODING_AGENT_DIR!, 'auth.json'),
      modelsPath: null,
      refreshOnCreate: false,
    })
    const runner = new ExtensionRunner(
      loaded.extensions,
      loaded.runtime,
      directory,
      SessionManager.inMemory(directory),
      new ModelRegistry(modelRuntime),
    )
    const errors: string[] = []
    runner.onError(({ error }) => errors.push(error))

    await runner.emit({ type: 'session_start', reason: 'startup' })
    expect(
      await loadAccountStorage(process.env.PI_ANTIGRAVITY_AUTH_FILE!),
    ).toBeNull()

    await writeFile(
      join(process.env.PI_CODING_AGENT_DIR!, 'auth.json'),
      '{malformed',
    )
    await runner.emit({ type: 'session_start', reason: 'reload' })
    expect(
      await loadAccountStorage(process.env.PI_ANTIGRAVITY_AUTH_FILE!),
    ).toBeNull()

    await writeHostCredential({ type: 'api_key', key: 'ignored-api-key' })
    await runner.emit({ type: 'session_start', reason: 'reload' })
    expect(
      await loadAccountStorage(process.env.PI_ANTIGRAVITY_AUTH_FILE!),
    ).toBeNull()

    await writeHostCredential({
      type: 'oauth',
      refresh: 'stored-refresh|project|managed',
      access: 'stored-access',
      expires: Date.now() + 3_600_000,
      email: 'stored@example.com',
    })
    await runner.emit({ type: 'session_start', reason: 'reload' })

    const storage = await loadAccountStorage(
      process.env.PI_ANTIGRAVITY_AUTH_FILE!,
    )
    expect(storage?.accounts).toHaveLength(1)
    expect(storage?.accounts[0]?.email).toBe('stored@example.com')
    expect(errors).toEqual([])

    await runner.emit({ type: 'session_shutdown', reason: 'quit' })
  })
})
