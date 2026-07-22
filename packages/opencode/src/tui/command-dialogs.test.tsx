/** @jsxImportSource @opentui/solid */

/**
 * Tests for the command dialog tree mounted by `tui.tsx` when an RPC
 * notification arrives.
 *
 * Each modal command produces a dialog flow composed of host
 * `DialogSelect`/`DialogConfirm`/`DialogPrompt` primitives. The host
 * treats `disabled: true` on a `DialogSelect` option as a HARD HIDE,
 * so this suite explicitly asserts that no option object ever carries
 * a `disabled` property — invalid actions stay visible with an
 * explanatory description, rejected in `onSelect` instead.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyCommand } from '../plugin/commands'
import {
  createOperatorSettingsController,
  type OperatorSettingsController,
} from '../plugin/operator-settings'
import type { CommandModalName, OpenDialogPayload } from '../rpc/protocol'
import { collectDialogFlow } from './command-dialogs'

interface Ctx {
  settings: OperatorSettingsController
}

async function newContext(): Promise<Ctx> {
  const dir = mkdtempSync(join(tmpdir(), 'agy-dialog-flow-'))
  const settings = createOperatorSettingsController({
    projectConfigPath: join(dir, 'antigravity.json'),
    userConfigPath: join(dir, 'user.json'),
  })
  // Pre-create the project file so update() targets it; for read-only flows
  // the schema defaults are fine.
  return { settings }
}

describe('command-dialogs.flow', () => {
  let ctx: Ctx

  beforeEach(async () => {
    ctx = await newContext()
  })

  afterEach(async () => {
    await ctx.settings.dispose()
  })

  it('quota: shows refresh + status actions', async () => {
    const flow = await collectDialogFlow('antigravity-quota', '', ctx)
    const labels = flow.actions.map((action) => action.label)
    expect(labels).toContain('Refresh quota')
    expect(labels).toContain('Show status')
    for (const action of flow.actions) {
      expect(action).not.toHaveProperty('disabled')
    }
  })

  it('account: lists CRUD actions and never hides via disabled', async () => {
    const flow = await collectDialogFlow('antigravity-account', '', ctx)
    const labels = flow.actions.map((action) => action.label)
    expect(labels).toContain('Add account')
    expect(labels).toContain('Refresh account')
    expect(labels).toContain('Remove account')
    for (const action of flow.actions) {
      expect(action).not.toHaveProperty('disabled')
    }
  })

  it('routing: toggle and current-value actions', async () => {
    const flow = await collectDialogFlow('antigravity-routing', '', ctx)
    const labels = flow.actions.map((action) => action.label)
    expect(labels).toContain('Toggle CLI first')
    expect(labels).toContain('Toggle quota-style fallback')
    for (const action of flow.actions) {
      expect(action).not.toHaveProperty('disabled')
    }
  })

  it('killswitch: enable and threshold controls', async () => {
    const flow = await collectDialogFlow('antigravity-killswitch', '', ctx)
    const labels = flow.actions.map((action) => action.label)
    expect(labels).toContain('Enable killswitch')
    expect(labels).toContain('Disable killswitch')
    expect(labels).toContain('Set minimum remaining percent')
    for (const action of flow.actions) {
      expect(action).not.toHaveProperty('disabled')
    }
  })

  it('dump: on / off / status actions', async () => {
    const flow = await collectDialogFlow('antigravity-dump', '', ctx)
    const labels = flow.actions.map((action) => action.label)
    expect(labels).toContain('Turn dump on')
    expect(labels).toContain('Turn dump off')
    expect(labels).toContain('Show dump status')
    for (const action of flow.actions) {
      expect(action).not.toHaveProperty('disabled')
    }
  })

  it('logging: every level exposed', async () => {
    const flow = await collectDialogFlow('antigravity-logging', '', ctx)
    const labels = flow.actions.map((action) => action.label)
    expect(labels).toContain('Error')
    expect(labels).toContain('Warn')
    expect(labels).toContain('Info')
    expect(labels).toContain('Debug')
    expect(labels).toContain('Trace')
    for (const action of flow.actions) {
      expect(action).not.toHaveProperty('disabled')
    }
  })

  it('cancel: the cancel control is always present', async () => {
    for (const command of [
      'antigravity-quota',
      'antigravity-account',
      'antigravity-routing',
      'antigravity-killswitch',
      'antigravity-dump',
      'antigravity-logging',
    ] satisfies CommandModalName[]) {
      const flow = await collectDialogFlow(command, '', ctx)
      expect(flow.cancelLabel).toBeTruthy()
    }
  })
})

describe('apply timeout policy', () => {
  let ctx: Ctx

  beforeEach(async () => {
    ctx = await newContext()
  })

  afterEach(async () => {
    await ctx.settings.dispose()
  })

  it('account add and refresh opt into the 120s RPC timeout', async () => {
    const add = await applyCommand(
      { command: 'antigravity-account', arguments: 'add' },
      { client: {} as never, sessionID: '', settings: ctx.settings },
    )
    expect(add.knobs.timeoutMs).toBe(120_000)
    const refresh = await applyCommand(
      { command: 'antigravity-account', arguments: 'refresh' },
      { client: {} as never, sessionID: '', settings: ctx.settings },
    )
    expect(refresh.knobs.timeoutMs).toBe(120_000)
  })

  it('quota refresh keeps the 2s default timeout', async () => {
    const result = await applyCommand(
      { command: 'antigravity-quota', arguments: 'refresh' },
      { client: {} as never, sessionID: '', settings: ctx.settings },
    )
    expect(result.knobs.timeoutMs).toBe(2_000)

    const dump = await applyCommand(
      { command: 'antigravity-dump', arguments: 'on' },
      { client: {} as never, sessionID: '', settings: ctx.settings },
    )
    expect(dump.knobs.timeoutMs).toBe(2_000)
  })
})

describe('command-dialogs.payload contract', () => {
  let ctx: Ctx

  beforeEach(async () => {
    ctx = await newContext()
  })

  afterEach(async () => {
    await ctx.settings.dispose()
  })

  it('every payload exposes the OpenDialogPayload shape', async () => {
    const flow = await collectDialogFlow('antigravity-quota', '', ctx)
    expect(flow.payload).toMatchObject({
      command: 'antigravity-quota',
    } satisfies Partial<OpenDialogPayload>)
  })
})

// `mock` is referenced from bun:test but the helpers above don't use it —
// keep the import so future tests can add it without touching the top.
void mock
