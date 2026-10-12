import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The genuine public commands module. The server receives its
// `parseApplyRequest` and the menu is built with its `createCommandMenu`, the
// same pairing the plugin makes, so these cases cover the real request
// parser and the real menu payloads end to end over the loopback RPC.
import * as commands from '../common-auth-embedded/commands/index.js'
import {
  drainNotifications,
  pushNotification,
  resetNotificationsForTest,
} from './notifications'
import type { CommandApplyRequest } from './protocol'
import { createRpcClient } from './rpc-client'
import { type RpcServerHandle, startRpcServer } from './rpc-server'

const COMMAND = 'antigravity'

interface Run {
  actionId: string
  values: unknown
  sessionId: string | undefined
}

function createMenu(runs: Run[]) {
  const section = (title: string): commands.PluginSection => ({
    title,
    build: () => ({ lines: [`${title} line`] }),
  })
  return commands.createCommandMenu({
    command: COMMAND,
    title: 'Antigravity',
    replace: {
      accounts: section('Accounts'),
      quota: section('Quota'),
      limits: section('Limits'),
      routing: {
        title: 'Routing',
        build: () => ({
          actions: [
            {
              id: 'set-cli-first',
              label: 'Prefer the CLI quota',
              knobs: [
                {
                  kind: 'toggle',
                  id: 'cliFirst',
                  label: 'CLI first',
                  value: false,
                },
              ],
              run: async ({ values, invocation }) => {
                runs.push({
                  actionId: 'set-cli-first',
                  values,
                  sessionId: invocation.sessionId,
                })
                invocation.notify('routing saved', 'info')
                return 'Routing updated.'
              },
            },
            {
              id: 'reset',
              label: 'Reset routing',
              irreversible: true,
              confirm: 'Reset routing to the defaults?',
              run: async ({ values, invocation }) => {
                runs.push({
                  actionId: 'reset',
                  values,
                  sessionId: invocation.sessionId,
                })
                return 'Routing reset.'
              },
            },
          ],
        }),
      },
    },
  })
}

describe('RPC bridge to the shared command menu', () => {
  let dir: string
  let handle: RpcServerHandle | undefined
  let runs: Run[]
  let menu: commands.CommandMenu

  const invocation = (sessionId?: string): commands.CommandInvocation => ({
    ...(sessionId === undefined ? {} : { sessionId }),
    notify: (message, kind = 'info') =>
      pushNotification(
        { command: COMMAND, notify: { message, kind } },
        sessionId,
      ),
  })

  beforeEach(async () => {
    resetNotificationsForTest()
    const parent = await mkdtemp(join(tmpdir(), 'agy-rpc-menu-test-'))
    dir = join(parent, 'rpc')
    runs = []
    menu = createMenu(runs)
    handle = await startRpcServer({
      dir,
      parseApplyRequest: commands.parseApplyRequest,
      apply: (request) => menu.apply(request, invocation(request.sessionId)),
      drain: drainNotifications,
    })
  })

  afterEach(async () => {
    await handle?.stop()
    await rm(join(dir, '..'), { recursive: true, force: true })
  })

  it('delivers the opened menu only to its own session', async () => {
    const opened = await menu.open(invocation('session-a'))
    pushNotification(opened, 'session-a')
    const client = createRpcClient(dir, process.pid)

    expect(opened.menu.sections.map((entry) => entry.slot)).toEqual([
      'accounts',
      'quota',
      'routing',
      'limits',
    ])
    await expect(client.pendingNotifications(0, 'session-b')).resolves.toEqual(
      [],
    )
    await expect(client.pendingNotifications(0, 'session-a')).resolves.toEqual([
      { id: 1, payload: opened, sessionId: 'session-a' },
    ])
    // Acknowledging the cursor removes the session's notification.
    await expect(client.pendingNotifications(1, 'session-a')).resolves.toEqual(
      [],
    )
    await expect(client.pendingNotifications(0, 'session-a')).resolves.toEqual(
      [],
    )
  })

  it('runs the chosen action with coerced values and returns the refreshed menu', async () => {
    const client = createRpcClient(dir, process.pid)
    const request: CommandApplyRequest = {
      command: COMMAND,
      sectionId: 'routing',
      actionId: 'set-cli-first',
      values: { cliFirst: true },
      sessionId: 'session-a',
    }

    const answer = await client.apply(request)

    expect(answer).toEqual({
      command: COMMAND,
      ok: true,
      text: 'Routing updated.',
      menu: (await menu.open(invocation('session-a'))).menu,
    })
    expect(runs).toEqual([
      {
        actionId: 'set-cli-first',
        values: { cliFirst: true },
        sessionId: 'session-a',
      },
    ])
    // The action's notification reaches only the session that applied it.
    await expect(client.pendingNotifications(0, 'session-b')).resolves.toEqual(
      [],
    )
    await expect(client.pendingNotifications(0, 'session-a')).resolves.toEqual([
      {
        id: 1,
        payload: {
          command: COMMAND,
          notify: { message: 'routing saved', kind: 'info' },
        },
        sessionId: 'session-a',
      },
    ])
  })

  it('asks for confirmation before an irreversible action runs', async () => {
    const client = createRpcClient(dir, process.pid)
    const request: CommandApplyRequest = {
      command: COMMAND,
      sectionId: 'routing',
      actionId: 'reset',
      sessionId: 'session-a',
    }

    const unconfirmed = await client.apply(request)
    expect(unconfirmed).toMatchObject({
      ok: false,
      code: 'needs-confirmation',
      needsConfirmation: true,
    })
    expect(runs).toEqual([])

    const confirmed = await client.apply({ ...request, confirmed: true })
    expect(confirmed).toMatchObject({ ok: true, text: 'Routing reset.' })
    expect(runs.map((run) => run.actionId)).toEqual(['reset'])
  })

  it('answers an unknown action as unavailable without running anything', async () => {
    const client = createRpcClient(dir, process.pid)

    for (const request of [
      { command: COMMAND, sectionId: 'routing', actionId: 'missing' },
      { command: COMMAND, sectionId: 'nowhere', actionId: 'set-cli-first' },
      { command: 'other', sectionId: 'routing', actionId: 'set-cli-first' },
    ]) {
      expect(await client.apply(request)).toMatchObject({
        ok: false,
        code: 'unavailable',
      })
    }
    expect(runs).toEqual([])
  })

  it('refuses a malformed body before the menu sees it', async () => {
    const response = await fetch(`http://127.0.0.1:${handle?.port}/rpc/apply`, {
      method: 'POST',
      headers: { authorization: `Bearer ${handle?.token}` },
      body: JSON.stringify({
        command: COMMAND,
        sectionId: 'routing',
        actionId: 'set-cli-first',
        values: { cliFirst: { nested: true } },
      }),
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: 'Invalid apply request',
    })
    expect(runs).toEqual([])
  })
})
