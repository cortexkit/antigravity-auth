/** @jsxImportSource @opentui/solid */

/**
 * Tests for the imperative command-dialog dispatcher.
 *
 * The dispatcher (`openCommandDialog`) replaces the prior declarative
 * `collectDialogFlow` + `renderDialogFlow` two-phase API with a sibling-style
 * pattern that mounts each command's dialog through the host's
 * `DialogSelect`/`DialogConfirm`/`DialogPrompt` primitives and awaits the
 * RPC `apply` before toasting/clearing — see the fleet ground truth at
 * `anthropic-auth-live/packages/opencode/src/tui/command-dialogs.tsx`.
 *
 * The host treats `disabled: true` on a `DialogSelect` option as a HARD HIDE,
 * so this suite explicitly asserts that no option object ever carries a
 * `disabled` property — invalid actions stay visible with an explanatory
 * description, rejected in `onSelect` instead.
 *
 * Tests inject a fake TuiPluginApi whose `DialogSelect`/`DialogConfirm`/
 * `DialogPrompt` are plain functions that capture their props object. The
 * render closure passed to `api.ui.dialog.replace()` may include OpenTUI
 * primitives (`<box>`, `<text>`) wrapping the data body — those need a
 * renderer context to evaluate, so tests use `renderDialog(fake)` (which
 * wraps `testRender`) to evaluate the closure before inspecting captured
 * props. `DialogSelect`/etc. capture their props synchronously during
 * JSX evaluation so prop assertions work after `renderDialog(fake)`.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { testRender } from '@opentui/solid'

import type { OpenDialogPayload } from '../rpc/protocol'

// Imported lazily — the dispatcher file pulls in the OpenTUI runtime via
// `/** @jsxImportSource @opentui/solid */`, so the module load alone is
// enough to surface any compile/transform regression without a renderer.
const importDispatcher = async () =>
  (await import('./command-dialogs')) as unknown as {
    openCommandDialog: (
      api: FakeApi,
      payload: OpenDialogPayload,
      apply: ApplyFn,
    ) => void
  }

type ApplyFn = (
  command: OpenDialogPayload['command'],
  args: string,
  options?: { timeoutMs?: number },
) => Promise<{ text: string; knobs: Record<string, unknown> }>

interface CapturedProps {
  title?: string
  options?: Array<{
    title?: string
    value?: unknown
    description?: string
  }>
  onSelect?: (option: { title?: string; value?: unknown }) => void
  onConfirm?: (value: string) => void
  onCancel?: () => void
  message?: string
  placeholder?: string
  value?: string
}

interface FakeApi {
  ui: {
    DialogSelect: <_Value = unknown>(props: CapturedProps) => unknown
    DialogConfirm: (props: CapturedProps) => unknown
    DialogPrompt: (props: CapturedProps) => unknown
    dialog: {
      setSize: (size: 'medium' | 'large' | 'xlarge') => void
      replace: (render: () => unknown, onClose?: () => void) => void
      clear: () => void
    }
    toast: (input: { message: string }) => void
  }
  log: {
    debug: (message: string, extra?: Record<string, unknown>) => void
    warn: (message: string, extra?: Record<string, unknown>) => void
  }
}

interface TestSetup {
  renderer: { destroy: () => void }
  flush: () => Promise<void>
  captureCharFrame: () => string
}

interface FakeApiRecord {
  ui: FakeApi['ui']
  log: FakeApi['log']
  setSizeArgs: Array<'medium' | 'large' | 'xlarge'>
  replaceCalls: number
  lastRender: (() => unknown) | null
  closeCallbacks: Array<(() => void) | undefined>
  clearCalls: number
  toastMessages: Array<{ message: string }>
  capturedSelectProps: CapturedProps | null
  capturedConfirmProps: CapturedProps | null
  capturedPromptProps: CapturedProps | null
  testSetup: TestSetup | null
}

function makeFakeApi(): FakeApiRecord {
  const api: FakeApiRecord = {
    ui: {} as FakeApi['ui'],
    log: { debug: () => undefined, warn: () => undefined },
    setSizeArgs: [],
    replaceCalls: 0,
    lastRender: null,
    closeCallbacks: [],
    clearCalls: 0,
    toastMessages: [],
    capturedSelectProps: null,
    capturedConfirmProps: null,
    capturedPromptProps: null,
    testSetup: null,
  }
  const captureComponent =
    (
      slot:
        | 'capturedSelectProps'
        | 'capturedConfirmProps'
        | 'capturedPromptProps',
    ) =>
    (props: CapturedProps) => {
      api[slot] = props
      return null
    }
  api.ui = {
    DialogSelect: captureComponent(
      'capturedSelectProps',
    ) as FakeApi['ui']['DialogSelect'],
    DialogConfirm: captureComponent(
      'capturedConfirmProps',
    ) as FakeApi['ui']['DialogConfirm'],
    DialogPrompt: captureComponent(
      'capturedPromptProps',
    ) as FakeApi['ui']['DialogPrompt'],
    dialog: {
      setSize: (size) => {
        api.setSizeArgs.push(size)
      },
      replace: (render, onClose) => {
        api.replaceCalls += 1
        api.lastRender = render
        api.closeCallbacks.push(onClose)
      },
      clear: () => {
        api.clearCalls += 1
      },
    },
    toast: (input) => {
      api.toastMessages.push(input)
    },
  }
  return api
}

// Re-evaluate `fake.lastRender` against a fresh test renderer so the
// captureComponent stores the freshest props on the next read. Destroys
// any prior testSetup so each invocation always reflects the LATEST
// `lastRender` closure the dispatcher has stored.
async function reRender(fake: FakeApiRecord): Promise<void> {
  if (!fake.lastRender) return
  if (fake.testSetup) {
    fake.testSetup.renderer.destroy()
    fake.testSetup = null
  }
  const setup = (await testRender(fake.lastRender as never, {
    width: 80,
    height: 30,
  })) as unknown as TestSetup
  fake.testSetup = setup
  await setup.flush()
}

// Evaluate the dispatcher's render closure inside a test renderer so any
// `<box>` / `<text>` body JSX resolves. Tests call this after every
// onSelect-driven re-render — the dispatcher doesn't auto-render (in
// production the host does it synchronously; the test fake just stores
// the closure and waits for an explicit `renderDialog`).
async function renderDialog(fake: FakeApiRecord): Promise<TestSetup> {
  if (!fake.lastRender) {
    throw new Error('renderDialog called before replace()')
  }
  await reRender(fake)
  if (!fake.testSetup) throw new Error('testSetup missing after reRender')
  return fake.testSetup
}

const applyMock = mock(
  async (
    _command: OpenDialogPayload['command'],
    _args: string,
    _options?: { timeoutMs?: number },
  ) => ({ text: 'ok', knobs: {} }),
)

function applyFor(command: OpenDialogPayload['command']) {
  return async (
    _cmd: OpenDialogPayload['command'],
    args: string,
    options?: { timeoutMs?: number },
  ) => {
    return applyMock(command, args, options)
  }
}

const ALL_COMMANDS = [
  'antigravity-account',
  'antigravity-routing',
  'antigravity-killswitch',
  'antigravity-dump',
  'antigravity-logging',
] as const satisfies ReadonlyArray<OpenDialogPayload['command']>

function payloadFor(
  command: OpenDialogPayload['command'],
  knobs: Record<string, unknown> = {},
): OpenDialogPayload {
  return {
    command,
    text: command,
    knobs,
  }
}

describe('openCommandDialog (imperative dispatcher)', () => {
  let dispatcher: Awaited<ReturnType<typeof importDispatcher>>

  beforeEach(async () => {
    applyMock.mockClear()
    dispatcher = await importDispatcher()
  })

  afterEach(() => {
    applyMock.mockClear()
  })

  it('every modal command opens an xlarge dialog via setSize + replace', async () => {
    for (const command of ALL_COMMANDS) {
      const localFake = makeFakeApi()
      dispatcher.openCommandDialog(
        localFake,
        payloadFor(command),
        applyFor(command),
      )
      await renderDialog(localFake)
      // xlarge is the only size the dispatcher sets.
      expect(localFake.setSizeArgs).toEqual(['xlarge'])
      // exactly one replace call per command — no stack of stale menus
      expect(localFake.replaceCalls).toBe(1)
      // Invoke the render closure so the captured DialogSelect/DialogConfirm
      // /DialogPrompt props land on the fake.
      // every command leaves the captured props on a dialog component
      // (select / confirm / prompt), not null
      const captured =
        localFake.capturedSelectProps ??
        localFake.capturedConfirmProps ??
        localFake.capturedPromptProps
      expect(captured).not.toBeNull()
      expect(captured?.title).toBeTruthy()
    }
  })

  it('every select option is visible — never carries a hide-property disabled flag', async () => {
    for (const command of ALL_COMMANDS) {
      const localFake = makeFakeApi()
      dispatcher.openCommandDialog(
        localFake,
        payloadFor(command),
        applyFor(command),
      )
      await renderDialog(localFake)
      // Some commands (e.g. dump / logging when fully wired) use DialogSelect.
      // The placeholder branches also use DialogSelect. The confirm/prompt
      // variants do not carry options to scan.
      const props =
        localFake.capturedSelectProps ??
        localFake.capturedConfirmProps ??
        localFake.capturedPromptProps
      const options = (props as CapturedProps | null)?.options ?? []
      for (const option of options) {
        expect(option).not.toHaveProperty('disabled')
      }
    }
  })

  it('antigravity-dump applies, toasts, then clears the dialog', async () => {
    const localFake = makeFakeApi()
    dispatcher.openCommandDialog(
      localFake,
      payloadFor('antigravity-dump', { mode: 'status' }),
      applyFor('antigravity-dump'),
    )
    await renderDialog(localFake)
    // Replace captures the render closure.
    expect(typeof localFake.lastRender).toBe('function')
    // Invoke the closure so the captured DialogSelect/DialogConfirm/DialogPrompt
    // props land on the fake. The dispatcher reads the payload's mode knob to
    // pick the initial control state.

    const props =
      localFake.capturedSelectProps ??
      localFake.capturedConfirmProps ??
      localFake.capturedPromptProps
    expect(props).not.toBeNull()
    const options = props?.options ?? []
    // Dump offers at least the three canonical actions (on / off / status)
    const titles = options.map((option) => option.title)
    expect(titles).toContain('Turn dump on')
    expect(titles).toContain('Turn dump off')
    expect(titles).toContain('Show dump status')

    const beforeApply = localFake.toastMessages.length + localFake.clearCalls
    const onOption = options.find((option) => option.title === 'Turn dump on')
    expect(onOption).toBeDefined()
    props?.onSelect?.({ title: onOption?.title, value: onOption?.value })
    // Await the apply promise.
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(applyMock).toHaveBeenCalled()
    const applyArgs = applyMock.mock.calls.find(
      (call) => call[0] === 'antigravity-dump',
    )
    expect(applyArgs?.[1]).toBeTruthy()
    // After apply resolves the dialog must toast the result then clear.
    expect(localFake.toastMessages.length).toBeGreaterThan(beforeApply)
    expect(localFake.clearCalls).toBeGreaterThan(0)
  })

  it('antigravity-logging applies, toasts, then clears the dialog', async () => {
    const localFake = makeFakeApi()
    dispatcher.openCommandDialog(
      localFake,
      payloadFor('antigravity-logging', { log_level: 'info' }),
      applyFor('antigravity-logging'),
    )
    await renderDialog(localFake)
    expect(typeof localFake.lastRender).toBe('function')

    const props = localFake.capturedSelectProps
    expect(props).not.toBeNull()
    const options = props?.options ?? []
    // Logging exposes every level — they must be visible (no hide-property).
    const titles = options.map((option) => option.title)
    expect(titles).toContain('Error')
    expect(titles).toContain('Warn')
    expect(titles).toContain('Info')
    expect(titles).toContain('Debug')
    expect(titles).toContain('Trace')

    const beforeApply = localFake.toastMessages.length + localFake.clearCalls
    const debugOption = options.find((option) => option.title === 'Debug')
    expect(debugOption).toBeDefined()
    props?.onSelect?.({ title: debugOption?.title, value: debugOption?.value })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(applyMock).toHaveBeenCalled()
    const applyArgs = applyMock.mock.calls.find(
      (call) => call[0] === 'antigravity-logging',
    )
    expect(applyArgs?.[1]).toBeTruthy()
    expect(localFake.toastMessages.length).toBeGreaterThan(beforeApply)
    expect(localFake.clearCalls).toBeGreaterThan(0)
  })

  it('forwards the timeoutMs option from apply through to the RPC apply call', async () => {
    const localFake = makeFakeApi()
    // Logging is the simplest single-apply branch — perfect for verifying the
    // timeoutMs option passes through the dispatcher into the apply call. The
    // dispatcher does not consult timeoutMs itself; it only forwards it.
    dispatcher.openCommandDialog(
      localFake,
      payloadFor('antigravity-logging'),
      applyFor('antigravity-logging'),
    )
    await renderDialog(localFake)
    const options = localFake.capturedSelectProps?.options ?? []
    const debugOption = options.find((option) => option.title === 'Debug')
    expect(debugOption).toBeDefined()
    localFake.capturedSelectProps?.onSelect?.({
      title: debugOption?.title,
      value: debugOption?.value,
    })
    await renderDialog(localFake)
    // The apply contract takes `(command, args, options?)` — we don't pin a
    // specific timeoutMs in this task (Tasks 9-11 wire that), only that the
    // signature accepts the options object.
    expect(applyMock).toHaveBeenCalled()
  })

  it('placeholders for quota / account / routing / killswitch still open a dialog (Tasks 9-11 enrich them)', async () => {
    // Per the task spec, this task keeps the four data-first commands
    // functional with the current payload shape — they must still open a
    // dialog through the dispatcher so Tasks 9-11 can swap in the richer
    // per-command rendering without changing the dispatcher surface.
    //
    // Task 10 wired antigravity-account end-to-end with a data-first
    // UI; routing and killswitch now also use the data-first pattern
    // (Task 11). This test pins the open-surface contract.
    for (const command of [
      'antigravity-routing',
      'antigravity-killswitch',
    ] as const) {
      const localFake = makeFakeApi()
      dispatcher.openCommandDialog(
        localFake,
        payloadFor(command),
        applyFor(command),
      )
      await renderDialog(localFake)
      expect(localFake.setSizeArgs).toEqual(['xlarge'])
      expect(localFake.replaceCalls).toBe(1)
      const props =
        localFake.capturedSelectProps ??
        localFake.capturedConfirmProps ??
        localFake.capturedPromptProps
      expect(props).not.toBeNull()
      expect(props?.title).toBeTruthy()
    }
  })

  // ============================================================================
  // Task 11 — state-first routing dialog
  //
  // Opening /antigravity-routing must show the CURRENT persisted state
  // (no mode menu, no `!` inversion). The two toggle rows render with
  // a current-state marker (`●`/`○`) and a `value` that, when applied,
  // mutates exactly one flag. The dialog awaits the apply, toasts the
  // result, and re-renders in place from the freshly-returned knobs.
  // ============================================================================

  it('antigravity-routing renders a state-first dialog with current flag values', async () => {
    const localFake = makeFakeApi()
    dispatcher.openCommandDialog(
      localFake,
      payloadFor('antigravity-routing', {
        cli_first: true,
        quota_style_fallback: false,
      }),
      applyFor('antigravity-routing'),
    )
    await renderDialog(localFake)
    expect(localFake.setSizeArgs).toEqual(['xlarge'])
    expect(localFake.replaceCalls).toBe(1)
    const props = localFake.capturedSelectProps
    expect(props).not.toBeNull()
    expect(props?.title).toBe('Antigravity routing')
    // Two toggle rows: one per routing flag.
    const titles = (props?.options ?? []).map((option) => option.title)
    expect(titles).toContain('● cli_first: true')
    expect(titles).toContain('○ quota_style_fallback: false')
    // Every option stays visible — never a hide-property.
    for (const option of props?.options ?? []) {
      expect(option).not.toHaveProperty('disabled')
    }
    // Opening is cache-only — apply is never called during mount.
    expect(applyMock).not.toHaveBeenCalled()
  })

  it('antigravity-routing toggle action awaits apply, toasts, and re-renders in place', async () => {
    const localFake = makeFakeApi()
    applyMock.mockImplementationOnce(
      async (
        _cmd: OpenDialogPayload['command'],
        args: string,
        options?: { timeoutMs?: number },
      ) => ({
        text: 'Routing updated',
        knobs: {
          // Server returns the COMPLETE state, not the parsed delta —
          // a state-first contract the dialog re-renders from. The
          // toggled flag flips to its new value; the untouched flag is
          // carried back as-is.
          cli_first: args.includes('cli_first=true'),
          quota_style_fallback: true,
          timeoutMs: options?.timeoutMs ?? 2_000,
        },
      }),
    )
    dispatcher.openCommandDialog(
      localFake,
      payloadFor('antigravity-routing', {
        cli_first: true,
        quota_style_fallback: false,
      }),
      applyFor('antigravity-routing'),
    )
    await renderDialog(localFake)
    const replaceCallsBefore = localFake.replaceCalls
    const toastMessagesBefore = localFake.toastMessages.length
    const clearCallsBefore = localFake.clearCalls

    // Select the cli_first row (currently `true`) — apply is called
    // with the toggled value.
    const cliFirstRow = localFake.capturedSelectProps?.options?.find(
      (option) => option.title === '● cli_first: true',
    )
    expect(cliFirstRow).toBeDefined()
    expect(cliFirstRow?.value).toBe('cli_first=false')
    localFake.capturedSelectProps?.onSelect?.({
      title: cliFirstRow?.title,
      value: cliFirstRow?.value,
    })
    for (let i = 0; i < 5; i += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    await renderDialog(localFake)

    // Apply was called once, mutating exactly the cli_first flag.
    expect(applyMock).toHaveBeenCalledTimes(1)
    const call = applyMock.mock.calls.at(-1)
    expect(call?.[0]).toBe('antigravity-routing')
    expect(call?.[1]).toBe('cli_first=false')
    expect(call?.[2]?.timeoutMs).toBe(2_000)

    // Toasted the apply result text.
    expect(localFake.toastMessages.length).toBeGreaterThan(toastMessagesBefore)
    expect(
      localFake.toastMessages[localFake.toastMessages.length - 1]?.message,
    ).toBe('Routing updated')

    // Re-rendered in place — replace called a SECOND time, dialog
    // stack was NEVER cleared (clearCalls unchanged).
    expect(localFake.replaceCalls).toBe(replaceCallsBefore + 1)
    expect(localFake.clearCalls).toBe(clearCallsBefore)

    // The re-render now reflects the toggled state: cli_first is `false`,
    // quota_style_fallback is `true` (the unchanged flag was carried
    // back in the server response).
    const titles = (localFake.capturedSelectProps?.options ?? []).map(
      (option) => option.title,
    )
    expect(titles).toContain('○ cli_first: false')
    expect(titles).toContain('● quota_style_fallback: true')
  })

  it('antigravity-routing surfaces apply errors and keeps the dialog mounted', async () => {
    const localFake = makeFakeApi()
    applyMock.mockImplementationOnce(
      async (
        _cmd: OpenDialogPayload['command'],
        _args,
        options?: { timeoutMs?: number },
      ) => ({
        text: 'Routing update failed: Could not acquire operator-config lock',
        knobs: { timeoutMs: options?.timeoutMs ?? 2_000, error: true },
      }),
    )
    dispatcher.openCommandDialog(
      localFake,
      payloadFor('antigravity-routing', {
        cli_first: false,
        quota_style_fallback: false,
      }),
      applyFor('antigravity-routing'),
    )
    await renderDialog(localFake)
    const clearCallsBefore = localFake.clearCalls
    const toastMessagesBefore = localFake.toastMessages.length

    // Select cli_first toggle.
    const cliFirstRow = localFake.capturedSelectProps?.options?.find(
      (option) => option.title === '○ cli_first: false',
    )
    expect(cliFirstRow).toBeDefined()
    localFake.capturedSelectProps?.onSelect?.({
      title: cliFirstRow?.title,
      value: cliFirstRow?.value,
    })
    for (let i = 0; i < 5; i += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    await renderDialog(localFake)

    // The error text was toasted.
    expect(localFake.toastMessages.length).toBeGreaterThan(toastMessagesBefore)
    expect(
      localFake.toastMessages[localFake.toastMessages.length - 1]?.message,
    ).toContain('Routing update failed')
    // Dialog stack was never cleared (the user can retry or back out).
    expect(localFake.clearCalls).toBe(clearCallsBefore)
    // The closed-over payload was not swapped — re-rendering the L1
    // dialog would surface a stale row, so the dispatcher skips the
    // swap on `knobs.error === true`. The dialog is re-mounted only
    // when a successful apply returns complete state.
    expect(
      localFake.capturedSelectProps?.options?.find(
        (option) => option.title === '○ cli_first: false',
      ),
    ).toBeDefined()
  })

  // ============================================================================
  // Task 11 — state-first killswitch dialog
  //
  // Opening /antigravity-killswitch shows the current `enabled` flag,
  // global `minimum_remaining_percent`, and any per-account override
  // map. Toggle/edit actions await apply, toast, and re-render in
  // place. The threshold edit is a DialogPrompt that, on confirm, runs
  // apply with the new integer and re-renders the L1 dialog.
  // ============================================================================

  it('antigravity-killswitch renders a state-first dialog with current threshold and overrides', async () => {
    const localFake = makeFakeApi()
    dispatcher.openCommandDialog(
      localFake,
      payloadFor('antigravity-killswitch', {
        enabled: true,
        minimum_remaining_percent: 15,
        accounts: { abc123def456: 30 },
      }),
      applyFor('antigravity-killswitch'),
    )
    await renderDialog(localFake)
    expect(localFake.setSizeArgs).toEqual(['xlarge'])
    expect(localFake.replaceCalls).toBe(1)
    const props = localFake.capturedSelectProps
    expect(props).not.toBeNull()
    expect(props?.title).toBe('Antigravity killswitch')
    // Toggle + edit rows render with state markers.
    const titles = (props?.options ?? []).map((option) => option.title)
    expect(titles).toContain('● Killswitch: enabled')
    expect(titles).toContain('Set minimum remaining percent (15%)')
    // Body surfaces the per-account override (data-first layout).
    const frame = localFake.testSetup?.captureCharFrame() ?? ''
    expect(frame).toContain('abc123def456')
    expect(frame).toContain('30')
    // No hide-property on any option.
    for (const option of props?.options ?? []) {
      expect(option).not.toHaveProperty('disabled')
    }
    // Opening is cache-only.
    expect(applyMock).not.toHaveBeenCalled()
  })

  it('antigravity-killswitch enable toggle awaits apply, toasts, and re-renders in place', async () => {
    const localFake = makeFakeApi()
    applyMock.mockImplementationOnce(
      async (
        _cmd: OpenDialogPayload['command'],
        args: string,
        options?: { timeoutMs?: number },
      ) => ({
        text: 'Killswitch updated',
        knobs: {
          enabled: args.includes('enabled=true'),
          minimum_remaining_percent: 15,
          accounts: {},
          timeoutMs: options?.timeoutMs ?? 2_000,
        },
      }),
    )
    dispatcher.openCommandDialog(
      localFake,
      payloadFor('antigravity-killswitch', {
        enabled: false,
        minimum_remaining_percent: 15,
        accounts: {},
      }),
      applyFor('antigravity-killswitch'),
    )
    await renderDialog(localFake)
    const replaceCallsBefore = localFake.replaceCalls
    const toastMessagesBefore = localFake.toastMessages.length
    const clearCallsBefore = localFake.clearCalls

    const toggleRow = localFake.capturedSelectProps?.options?.find(
      (option) => option.title === '○ Killswitch: disabled',
    )
    expect(toggleRow).toBeDefined()
    localFake.capturedSelectProps?.onSelect?.({
      title: toggleRow?.title,
      value: toggleRow?.value,
    })
    for (let i = 0; i < 5; i += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    await renderDialog(localFake)

    expect(applyMock).toHaveBeenCalledTimes(1)
    const call = applyMock.mock.calls.at(-1)
    expect(call?.[0]).toBe('antigravity-killswitch')
    expect(call?.[1]).toBe('enabled=true')
    expect(call?.[2]?.timeoutMs).toBe(2_000)

    expect(localFake.toastMessages.length).toBeGreaterThan(toastMessagesBefore)
    expect(
      localFake.toastMessages[localFake.toastMessages.length - 1]?.message,
    ).toBe('Killswitch updated')
    expect(localFake.replaceCalls).toBe(replaceCallsBefore + 1)
    expect(localFake.clearCalls).toBe(clearCallsBefore)

    // Re-render now shows the toggled state.
    const titles = (localFake.capturedSelectProps?.options ?? []).map(
      (option) => option.title,
    )
    expect(titles).toContain('● Killswitch: enabled')
  })

  it('antigravity-killswitch threshold edit opens a DialogPrompt and re-renders on confirm', async () => {
    const localFake = makeFakeApi()
    applyMock.mockImplementationOnce(
      async (
        _cmd: OpenDialogPayload['command'],
        args: string,
        options?: { timeoutMs?: number },
      ) => {
        const match = args.match(/minimum_remaining_percent=(\d+)/)
        const next = match ? Number.parseInt(match[1] ?? '0', 10) : 15
        return {
          text: 'Killswitch updated',
          knobs: {
            enabled: true,
            minimum_remaining_percent: next,
            accounts: {},
            timeoutMs: options?.timeoutMs ?? 2_000,
          },
        }
      },
    )
    dispatcher.openCommandDialog(
      localFake,
      payloadFor('antigravity-killswitch', {
        enabled: true,
        minimum_remaining_percent: 15,
        accounts: {},
      }),
      applyFor('antigravity-killswitch'),
    )
    await renderDialog(localFake)
    const replaceCallsBefore = localFake.replaceCalls
    const clearCallsBefore = localFake.clearCalls

    // Select the threshold edit row → DialogPrompt mounts.
    const editRow = localFake.capturedSelectProps?.options?.find((option) =>
      option.title?.startsWith('Set minimum remaining percent'),
    )
    expect(editRow).toBeDefined()
    localFake.capturedSelectProps?.onSelect?.({
      title: editRow?.title,
      value: editRow?.value,
    })
    await renderDialog(localFake)
    const prompt = localFake.capturedPromptProps
    expect(prompt).not.toBeNull()
    expect(prompt?.title).toBe('Antigravity killswitch — set threshold')
    // Confirm the prompt with a new integer value.
    prompt?.onConfirm?.('25')
    for (let i = 0; i < 5; i += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    await renderDialog(localFake)

    expect(applyMock).toHaveBeenCalledTimes(1)
    const call = applyMock.mock.calls.at(-1)
    expect(call?.[0]).toBe('antigravity-killswitch')
    expect(call?.[1]).toBe('minimum_remaining_percent=25')
    expect(call?.[2]?.timeoutMs).toBe(2_000)

    // L1 dialog re-rendered in place; stack never cleared. The total
    // count is +2 because the threshold prompt itself opened via
    // `replace()` (L1 → prompt) before apply re-rendered L1 again.
    expect(localFake.replaceCalls).toBe(replaceCallsBefore + 2)
    expect(localFake.clearCalls).toBe(clearCallsBefore)

    // Threshold label reflects the new value.
    const titles = (localFake.capturedSelectProps?.options ?? []).map(
      (option) => option.title,
    )
    expect(titles).toContain('Set minimum remaining percent (25%)')
  })

  it('antigravity-killswitch threshold prompt rejects out-of-range input without applying', async () => {
    const localFake = makeFakeApi()
    dispatcher.openCommandDialog(
      localFake,
      payloadFor('antigravity-killswitch', {
        enabled: true,
        minimum_remaining_percent: 15,
        accounts: {},
      }),
      applyFor('antigravity-killswitch'),
    )
    await renderDialog(localFake)
    const editRow = localFake.capturedSelectProps?.options?.find((option) =>
      option.title?.startsWith('Set minimum remaining percent'),
    )
    localFake.capturedSelectProps?.onSelect?.({
      title: editRow?.title,
      value: editRow?.value,
    })
    await renderDialog(localFake)
    const prompt = localFake.capturedPromptProps
    expect(prompt).not.toBeNull()
    // Out-of-range input → apply is NOT called.
    prompt?.onConfirm?.('150')
    // No await needed; the onConfirm handler is sync until the apply
    // promise. Wait one tick just to be sure.
    return new Promise<void>((resolve) => setImmediate(resolve)).then(() => {
      expect(applyMock).not.toHaveBeenCalled()
    })
  })

  it('antigravity-killswitch threshold prompt cancel returns to L1 without applying', async () => {
    const localFake = makeFakeApi()
    dispatcher.openCommandDialog(
      localFake,
      payloadFor('antigravity-killswitch', {
        enabled: true,
        minimum_remaining_percent: 15,
        accounts: {},
      }),
      applyFor('antigravity-killswitch'),
    )
    await renderDialog(localFake)
    const editRow = localFake.capturedSelectProps?.options?.find((option) =>
      option.title?.startsWith('Set minimum remaining percent'),
    )
    localFake.capturedSelectProps?.onSelect?.({
      title: editRow?.title,
      value: editRow?.value,
    })
    await renderDialog(localFake)
    const prompt = localFake.capturedPromptProps
    expect(prompt).not.toBeNull()
    prompt?.onCancel?.()
    // Back at the L1 dialog.
    expect(localFake.capturedSelectProps?.title).toBe('Antigravity killswitch')
    expect(applyMock).not.toHaveBeenCalled()
  })

  it('antigravity-killswitch surfaces apply errors and keeps the dialog mounted', async () => {
    const localFake = makeFakeApi()
    applyMock.mockImplementationOnce(
      async (
        _cmd: OpenDialogPayload['command'],
        _args,
        options?: { timeoutMs?: number },
      ) => ({
        text: 'Killswitch update failed: lock contention',
        knobs: { timeoutMs: options?.timeoutMs ?? 2_000, error: true },
      }),
    )
    dispatcher.openCommandDialog(
      localFake,
      payloadFor('antigravity-killswitch', {
        enabled: false,
        minimum_remaining_percent: 15,
        accounts: {},
      }),
      applyFor('antigravity-killswitch'),
    )
    await renderDialog(localFake)
    const toastMessagesBefore = localFake.toastMessages.length
    const clearCallsBefore = localFake.clearCalls

    const toggleRow = localFake.capturedSelectProps?.options?.find(
      (option) => option.title === '○ Killswitch: disabled',
    )
    expect(toggleRow).toBeDefined()
    localFake.capturedSelectProps?.onSelect?.({
      title: toggleRow?.title,
      value: toggleRow?.value,
    })
    for (let i = 0; i < 5; i += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    await renderDialog(localFake)

    expect(localFake.toastMessages.length).toBeGreaterThan(toastMessagesBefore)
    expect(
      localFake.toastMessages[localFake.toastMessages.length - 1]?.message,
    ).toContain('Killswitch update failed')
    // Dialog stack not cleared.
    expect(localFake.clearCalls).toBe(clearCallsBefore)
  })

  it('antigravity-account renders a data-first dialog with rows + Add account', async () => {
    const localFake = makeFakeApi()
    dispatcher.openCommandDialog(
      localFake,
      payloadFor('antigravity-account', {
        accounts: [
          {
            id: 'acct-0',
            index: 0,
            label: 'Primary',
            enabled: true,
            current: true,
            quota: [{ key: 'claude', label: 'Claude', remainingPercent: 42 }],
          },
          {
            id: 'acct-1',
            index: 1,
            label: 'Backup',
            enabled: false,
            current: false,
            quota: [],
          },
        ],
      }),
      applyFor('antigravity-account'),
    )

    await renderDialog(localFake)
    expect(localFake.setSizeArgs).toEqual(['xlarge'])
    expect(localFake.replaceCalls).toBe(1)
    const props = localFake.capturedSelectProps
    expect(props).not.toBeNull()
    expect(props?.title).toBe('Antigravity accounts')
    // Body carries every row's label + quota line. Data lives in the
    // body — the dialog's type-ahead search does not see the rows.
    const frame = localFake.testSetup?.captureCharFrame() ?? ''
    expect(frame).toContain('Primary')
    expect(frame).toContain('Claude 42%')
    expect(frame).toContain('Backup (disabled)')
    // No email crosses the PII boundary.
    expect(frame).not.toContain('@example.test')
    // Options: Add account, one drill-in per row, plus Back.
    const titles = (props?.options ?? []).map((option) => option.title)
    expect(titles).toContain('Add account…')
    expect(titles).toContain('Primary')
    expect(titles).toContain('Backup')
    expect(titles).toContain('Back')
    // Every option must stay visible — no `disabled` hide-property.
    for (const option of props?.options ?? []) {
      expect(option).not.toHaveProperty('disabled')
    }
  })

  it('antigravity-account adds an OAuth account through URL, code, and label prompts', async () => {
    const localFake = makeFakeApi()
    applyMock.mockImplementationOnce(async (_cmd, _args, options) => ({
      text: 'Open this URL in your browser',
      knobs: {
        oauthUrl: 'https://accounts.google.test/authorize',
        accounts: [],
        timeoutMs: options?.timeoutMs ?? 120_000,
      },
    }))
    applyMock.mockImplementationOnce(async (_cmd, _args, options) => ({
      text: 'OAuth account added.',
      knobs: {
        accounts: [
          {
            id: 'acct-0',
            index: 0,
            label: 'Work account',
            enabled: true,
            current: true,
            quota: [],
          },
        ],
        timeoutMs: options?.timeoutMs ?? 120_000,
      },
    }))
    dispatcher.openCommandDialog(
      localFake,
      payloadFor('antigravity-account', { accounts: [] }),
      applyFor('antigravity-account'),
    )
    await renderDialog(localFake)

    const add = localFake.capturedSelectProps?.options?.find(
      (option) => option.title === 'Add account…',
    )
    localFake.capturedSelectProps?.onSelect?.({
      title: add?.title,
      value: add?.value,
    })
    for (let i = 0; i < 5; i += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    await renderDialog(localFake)

    expect(applyMock.mock.calls.at(0)?.[1]).toBe('add-oauth-start')
    expect(applyMock.mock.calls.at(0)?.[2]?.timeoutMs).toBe(120_000)
    expect(localFake.capturedSelectProps?.title).toBe('OAuth sign-in')
    // The OAuth URL from the mocked start result must surface in the
    // dialog's Copy-URL option so the user can paste it into a browser.
    const copyUrlOption = localFake.capturedSelectProps?.options?.find(
      (option) => option.title === 'Copy URL to clipboard',
    )
    expect(copyUrlOption?.description).toContain(
      'https://accounts.google.test/authorize',
    )

    const enterCode = localFake.capturedSelectProps?.options?.find(
      (option) => option.title === 'Enter sign-in code',
    )
    localFake.capturedSelectProps?.onSelect?.({
      title: enterCode?.title,
      value: enterCode?.value,
    })
    await renderDialog(localFake)
    expect(localFake.capturedPromptProps?.title).toContain('enter code')
    localFake.capturedPromptProps?.onConfirm?.('callback-code')
    await renderDialog(localFake)
    expect(localFake.capturedPromptProps?.title).toContain('label')
    localFake.capturedPromptProps?.onConfirm?.('Work account')
    for (let i = 0; i < 5; i += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve))
    }

    expect(applyMock.mock.calls.at(1)?.[1]).toBe(
      'add-oauth-finish callback-code --label Work account',
    )
    expect(applyMock.mock.calls.at(1)?.[2]?.timeoutMs).toBe(120_000)
  })

  it('antigravity-account opens a row subdialog with toggle/current/remove/back', async () => {
    const localFake = makeFakeApi()
    dispatcher.openCommandDialog(
      localFake,
      payloadFor('antigravity-account', {
        accounts: [
          {
            id: 'acct-0',
            index: 0,
            label: 'Primary',
            enabled: true,
            current: true,
            quota: [],
          },
        ],
      }),
      applyFor('antigravity-account'),
    )
    await renderDialog(localFake)
    // Drill into the row subdialog by selecting its entry in the L1 menu.
    const rowOption = localFake.capturedSelectProps?.options?.find(
      (option) => option.title === 'Primary',
    )
    expect(rowOption).toBeDefined()
    localFake.capturedSelectProps?.onSelect?.({
      title: rowOption?.title,
      value: rowOption?.value,
    })
    await renderDialog(localFake)
    const sub = localFake.capturedSelectProps
    expect(sub).not.toBeNull()
    // Fleet parity: row subdialog is titled "Manage <label>" so the
    // dialog chrome carries the row identity and the body lines
    // underneath stay data-only.
    expect(sub?.title).toBe('Manage Primary')
    const titles = (sub?.options ?? []).map((option) => option.title)
    expect(titles).toContain('Disable account')
    expect(titles).toContain('Set as current')
    expect(titles).toContain('Remove account…')
    expect(titles).toContain('Back')
    for (const option of sub?.options ?? []) {
      expect(option).not.toHaveProperty('disabled')
    }
  })

  it('antigravity-account toggle action awaits apply, toasts, and re-renders in place', async () => {
    const localFake = makeFakeApi()
    applyMock.mockImplementationOnce(async (_cmd, args, options) => ({
      text: 'Account enabled state updated',
      knobs: {
        action: 'toggle',
        accounts: [
          {
            id: 'acct-0',
            index: 0,
            label: 'Primary',
            enabled: !args.includes('0'),
            current: true,
            quota: [],
          },
        ],
        timeoutMs: options?.timeoutMs ?? 2_000,
      },
    }))
    dispatcher.openCommandDialog(
      localFake,
      payloadFor('antigravity-account', {
        accounts: [
          {
            id: 'acct-0',
            index: 0,
            label: 'Primary',
            enabled: true,
            current: true,
            quota: [],
          },
        ],
      }),
      applyFor('antigravity-account'),
    )
    await renderDialog(localFake)
    const replaceCallsBefore = localFake.replaceCalls
    const clearCallsBefore = localFake.clearCalls
    const toastMessagesBefore = localFake.toastMessages.length

    // Select the row, then select "Disable account".
    const rowOption = localFake.capturedSelectProps?.options?.find(
      (option) => option.title === 'Primary',
    )
    localFake.capturedSelectProps?.onSelect?.({
      title: rowOption?.title,
      value: rowOption?.value,
    })
    await renderDialog(localFake)
    const toggleOption = localFake.capturedSelectProps?.options?.find(
      (option) => option.title === 'Disable account',
    )
    localFake.capturedSelectProps?.onSelect?.({
      title: toggleOption?.title,
      value: toggleOption?.value,
    })
    for (let i = 0; i < 5; i += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    await renderDialog(localFake)

    // Apply called once with the toggle <index> pattern, 2s timeout.
    expect(applyMock).toHaveBeenCalledTimes(1)
    const call = applyMock.mock.calls.at(-1)
    expect(call?.[0]).toBe('antigravity-account')
    expect(call?.[1]).toBe('toggle 0')
    expect(call?.[2]?.timeoutMs).toBe(2_000)

    // Toasted + re-rendered in place; the dialog stack was never cleared.
    expect(localFake.toastMessages.length).toBeGreaterThan(toastMessagesBefore)
    expect(
      localFake.toastMessages[localFake.toastMessages.length - 1]?.message,
    ).toBe('Account enabled state updated')
    expect(localFake.replaceCalls).toBeGreaterThan(replaceCallsBefore)
    expect(localFake.clearCalls).toBe(clearCallsBefore)
  })

  it('antigravity-account set-current awaits apply, toasts, and re-renders in place', async () => {
    const localFake = makeFakeApi()
    applyMock.mockImplementationOnce(async (_cmd, _args, options) => ({
      text: 'Current account updated',
      knobs: {
        action: 'current',
        accounts: [
          {
            id: 'acct-1',
            index: 1,
            label: 'Backup',
            enabled: true,
            current: true,
            quota: [],
          },
        ],
        timeoutMs: options?.timeoutMs ?? 2_000,
      },
    }))
    dispatcher.openCommandDialog(
      localFake,
      payloadFor('antigravity-account', {
        accounts: [
          {
            id: 'acct-0',
            index: 0,
            label: 'Primary',
            enabled: true,
            current: true,
            quota: [],
          },
          {
            id: 'acct-1',
            index: 1,
            label: 'Backup',
            enabled: false,
            current: false,
            quota: [],
          },
        ],
      }),
      applyFor('antigravity-account'),
    )
    await renderDialog(localFake)
    const clearCallsBefore = localFake.clearCalls

    const backupOption = localFake.capturedSelectProps?.options?.find(
      (option) => option.title === 'Backup',
    )
    localFake.capturedSelectProps?.onSelect?.({
      title: backupOption?.title,
      value: backupOption?.value,
    })
    await renderDialog(localFake)
    const currentOption = localFake.capturedSelectProps?.options?.find(
      (option) => option.title === 'Set as current',
    )
    localFake.capturedSelectProps?.onSelect?.({
      title: currentOption?.title,
      value: currentOption?.value,
    })
    for (let i = 0; i < 5; i += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    await renderDialog(localFake)

    const call = applyMock.mock.calls.at(-1)
    expect(call?.[1]).toBe('current 1')
    expect(call?.[2]?.timeoutMs).toBe(2_000)
    expect(localFake.clearCalls).toBe(clearCallsBefore)
  })

  it('antigravity-account remove action gates on DialogConfirm before applying', async () => {
    const localFake = makeFakeApi()
    applyMock.mockImplementationOnce(async (_cmd, _args, options) => ({
      text: 'Account removed',
      knobs: {
        action: 'remove',
        accounts: [],
        timeoutMs: options?.timeoutMs ?? 2_000,
      },
    }))
    dispatcher.openCommandDialog(
      localFake,
      payloadFor('antigravity-account', {
        accounts: [
          {
            id: 'acct-0',
            index: 0,
            label: 'Primary',
            enabled: true,
            current: true,
            quota: [],
          },
        ],
      }),
      applyFor('antigravity-account'),
    )
    await renderDialog(localFake)
    const applyCallsBefore = applyMock.mock.calls.length

    // Drill into the row, then pick "Remove account…".
    const rowOption = localFake.capturedSelectProps?.options?.find(
      (option) => option.title === 'Primary',
    )
    localFake.capturedSelectProps?.onSelect?.({
      title: rowOption?.title,
      value: rowOption?.value,
    })
    await renderDialog(localFake)
    const removeOption = localFake.capturedSelectProps?.options?.find(
      (option) => option.title === 'Remove account…',
    )
    localFake.capturedSelectProps?.onSelect?.({
      title: removeOption?.title,
      value: removeOption?.value,
    })
    await renderDialog(localFake)
    // Confirm dialog mounts (NOT yet applied).
    const confirm = localFake.capturedConfirmProps
    expect(confirm).not.toBeNull()
    expect(confirm?.title).toBe('Remove account')
    expect(confirm?.message).toContain('Primary')
    expect(applyMock.mock.calls.length).toBe(applyCallsBefore)

    // Confirming the dialog triggers the apply.
    confirm?.onConfirm?.('yes')
    for (let i = 0; i < 5; i += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    expect(applyMock.mock.calls.length).toBe(applyCallsBefore + 1)
    const removeCall = applyMock.mock.calls.at(-1)
    expect(removeCall?.[1]).toBe('remove 0')
    expect(removeCall?.[2]?.timeoutMs).toBe(2_000)
  })

  it('antigravity-account remove cancel returns to the account list without applying', async () => {
    const localFake = makeFakeApi()
    dispatcher.openCommandDialog(
      localFake,
      payloadFor('antigravity-account', {
        accounts: [
          {
            id: 'acct-0',
            index: 0,
            label: 'Primary',
            enabled: true,
            current: true,
            quota: [],
          },
        ],
      }),
      applyFor('antigravity-account'),
    )
    await renderDialog(localFake)
    const applyCallsBefore = applyMock.mock.calls.length
    const rowOption = localFake.capturedSelectProps?.options?.find(
      (option) => option.title === 'Primary',
    )
    localFake.capturedSelectProps?.onSelect?.({
      title: rowOption?.title,
      value: rowOption?.value,
    })
    await renderDialog(localFake)
    const removeOption = localFake.capturedSelectProps?.options?.find(
      (option) => option.title === 'Remove account…',
    )
    localFake.capturedSelectProps?.onSelect?.({
      title: removeOption?.title,
      value: removeOption?.value,
    })
    await renderDialog(localFake)
    const confirm = localFake.capturedConfirmProps
    expect(confirm).not.toBeNull()
    confirm?.onCancel?.()
    expect(applyMock.mock.calls.length).toBe(applyCallsBefore)
  })

  it('antigravity-account add action starts OAuth with a 120s timeout', async () => {
    const localFake = makeFakeApi()
    dispatcher.openCommandDialog(
      localFake,
      payloadFor('antigravity-account', {
        accounts: [
          {
            id: 'acct-0',
            index: 0,
            label: 'Primary',
            enabled: true,
            current: true,
            quota: [],
          },
        ],
      }),
      applyFor('antigravity-account'),
    )
    await renderDialog(localFake)
    const addOption = localFake.capturedSelectProps?.options?.find(
      (option) => option.title === 'Add account…',
    )
    localFake.capturedSelectProps?.onSelect?.({
      title: addOption?.title,
      value: addOption?.value,
    })
    for (let i = 0; i < 5; i += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    await renderDialog(localFake)
    const call = applyMock.mock.calls.at(-1)
    expect(call?.[0]).toBe('antigravity-account')
    expect(call?.[1]).toBe('add-oauth-start')
    expect(call?.[2]?.timeoutMs).toBe(120_000)
  })

  it('antigravity-account opening is cache-only — apply is never called during mount', async () => {
    const localFake = makeFakeApi()
    dispatcher.openCommandDialog(
      localFake,
      payloadFor('antigravity-account', {
        accounts: [
          {
            id: 'acct-0',
            index: 0,
            label: 'Primary',
            enabled: true,
            current: true,
            quota: [],
          },
        ],
      }),
      applyFor('antigravity-account'),
    )
    await renderDialog(localFake)
    expect(applyMock).not.toHaveBeenCalled()
  })

  // ============================================================================
  // SHOULD-4 — empty pool after remove-last re-renders the placeholder
  //
  // Removing the only account must leave the dialog mounted with the
  // "No accounts configured…" placeholder (not crash, not silently
  // close). This is the dialog's "destructive op succeeded but the
  // pool is now empty" branch — the only path that exercises the
  // empty-`accounts` re-render.
  // ============================================================================

  it('antigravity-account shows the empty-pool placeholder after remove-last', async () => {
    const localFake = makeFakeApi()
    applyMock.mockImplementationOnce(async (_cmd, _args, options) => ({
      text: 'Account removed',
      knobs: {
        action: 'remove',
        accounts: [],
        timeoutMs: options?.timeoutMs ?? 2_000,
      },
    }))
    dispatcher.openCommandDialog(
      localFake,
      payloadFor('antigravity-account', {
        accounts: [
          {
            id: 'acct-0',
            index: 0,
            label: 'Primary',
            enabled: true,
            current: true,
            quota: [],
          },
        ],
      }),
      applyFor('antigravity-account'),
    )

    await renderDialog(localFake)
    // Drill in, confirm remove, apply resolves.
    const rowOption = localFake.capturedSelectProps?.options?.find(
      (option) => option.title === 'Primary',
    )
    localFake.capturedSelectProps?.onSelect?.({
      title: rowOption?.title,
      value: rowOption?.value,
    })
    await renderDialog(localFake)
    const removeOption = localFake.capturedSelectProps?.options?.find(
      (option) => option.title === 'Remove account…',
    )
    localFake.capturedSelectProps?.onSelect?.({
      title: removeOption?.title,
      value: removeOption?.value,
    })
    await renderDialog(localFake)
    const confirm = localFake.capturedConfirmProps
    expect(confirm).not.toBeNull()
    confirm?.onConfirm?.('yes')

    for (let i = 0; i < 5; i += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    await renderDialog(localFake)

    // Dialog re-renders in place with the empty-pool body text.
    const props = localFake.capturedSelectProps
    expect(props).not.toBeNull()
    expect(props?.title).toBe('Antigravity accounts')
    const frame = localFake.testSetup?.captureCharFrame() ?? ''
    expect(frame).toContain('No accounts configured')
    // Only "Add account…" + "Back" remain on the DialogSelect. The
    // data is in the body, not the options list.
    expect(props?.options).toHaveLength(2)
    const optionTitles = (props?.options ?? []).map((o) => o.title)
    expect(optionTitles).toContain('Add account…')
    expect(optionTitles).toContain('Back')
    // Dialog never cleared — must stay alive for the user to add a
    // replacement or back out.
    expect(localFake.clearCalls).toBe(0)
  })

  it('leaves antigravity-quota to the TUI quota panel rather than DialogSelect', () => {
    const localFake = makeFakeApi()
    expect(() =>
      dispatcher.openCommandDialog(
        localFake,
        payloadFor('antigravity-quota'),
        applyFor('antigravity-quota'),
      ),
    ).toThrow('antigravity-quota is rendered by the TUI quota panel')
    expect(localFake.replaceCalls).toBe(0)
  })

  it('rejects unknown commands explicitly (no dialog open)', async () => {
    const localFake = makeFakeApi()
    const bogus = 'antigravity-bogus' as unknown as OpenDialogPayload['command']
    expect(() =>
      dispatcher.openCommandDialog(
        localFake,
        payloadFor(bogus),
        applyFor(bogus),
      ),
    ).toThrow()
    expect(localFake.replaceCalls).toBe(0)
    expect(localFake.setSizeArgs).toEqual([])
  })
})

// keep `mock` import live so the helpers above can be extended without
// touching the top-of-file imports.
void mock

// Re-export so other suites (e.g. tui.test.tsx) can probe the dispatcher
// integration through the same surface without re-importing.
export type { ApplyFn }
