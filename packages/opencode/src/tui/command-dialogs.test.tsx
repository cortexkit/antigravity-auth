/**
 * Tests for the shared `/antigravity` drawer and the payload parsers it
 * relies on.
 *
 * The drawer is host-neutral: it talks to a `MenuUi` (promise dialogs) and a
 * `MenuApply` transport. These tests drive it with a scripted fake UI that
 * records every dialog it was asked to show and answers from a queue, so
 * each assertion reads the exact dialog sequence a user would see.
 */

import { describe, expect, it } from 'bun:test'

import {
  firstLink,
  itemOptions,
  MenuRefusedError,
  openAntigravityMenu,
  promptValue,
  sectionListOptions,
  sectionOptions,
} from './command-dialogs'
import {
  ANTIGRAVITY_MENU_COMMAND,
  MENU_REFUSED_TEXT,
  MENU_SECTION_SLOTS,
  type MenuApplyRequest,
  type MenuApplyResult,
  type MenuDialogPayload,
  type MenuModel,
  type MenuUi,
  parseMenuApplyResult,
  parseMenuDialogPayload,
  parseMenuNotifyPayload,
} from './host-api'

// ── Fixtures ────────────────────────────────────────────────────────────────

function menu(overrides: { killswitchLine?: string } = {}): MenuModel {
  return {
    command: 'antigravity',
    title: 'Antigravity',
    sections: [
      {
        id: 'accounts',
        slot: 'accounts',
        title: 'Accounts',
        lines: ['2 accounts'],
        items: [
          {
            id: 'sel-7f3a',
            label: 'Account 1',
            detail: 'enabled · current',
            account: {
              id: 'sel-7f3a',
              label: 'Account 1',
              enabled: true,
              type: 'oauth',
            },
            facts: { health: 92 },
            actions: [
              {
                id: 'disable',
                label: 'Disable',
                knobs: [],
              },
              {
                id: 'remove',
                label: 'Remove',
                knobs: [],
                confirm: { message: 'Remove Account 1?', irreversible: true },
              },
            ],
          },
        ],
        actions: [
          {
            id: 'add',
            label: 'Add account',
            knobs: [{ kind: 'text', id: 'code', label: 'Code', masked: true }],
          },
        ],
      },
      {
        id: 'limits',
        slot: 'limits',
        title: 'Limits',
        lines: [overrides.killswitchLine ?? 'Killswitch: off · floor 10%'],
        items: [],
        actions: [
          {
            id: 'killswitch',
            label: 'Killswitch',
            knobs: [
              { kind: 'toggle', id: 'enabled', label: 'Enabled', value: false },
              {
                kind: 'number',
                id: 'floor',
                label: 'Floor',
                value: 10,
                min: 0,
                max: 100,
              },
            ],
          },
        ],
      },
      {
        id: 'diagnostics',
        slot: 'diagnostics',
        title: 'Diagnostics',
        lines: ['Logging: info', 'Wire dump: off'],
        items: [],
        actions: [
          {
            id: 'log-level',
            label: 'Log level',
            knobs: [
              {
                kind: 'choice',
                id: 'level',
                label: 'Level',
                value: 'info',
                choices: [
                  { value: 'info', label: 'Info' },
                  { value: 'debug', label: 'Debug' },
                ],
              },
            ],
          },
        ],
      },
    ],
  }
}

function payload(model: MenuModel = menu()): MenuDialogPayload {
  return { command: 'antigravity', menu: model }
}

function result(
  partial: Partial<MenuApplyResult> & { menu?: MenuModel },
): MenuApplyResult {
  return {
    command: 'antigravity',
    ok: true,
    text: 'Done.',
    menu: menu(),
    ...partial,
  }
}

type Shown =
  | { kind: 'select'; title: string; options: string[]; current?: string }
  | { kind: 'prompt'; title: string; value?: string }
  | { kind: 'confirm'; title: string; message: string }
  | { kind: 'alert'; title: string; message: string }

/**
 * A scripted UI: each dialog takes the next answer from `answers`. A select
 * answer is matched against option titles; running out of answers dismisses
 * the dialog, which ends the drawer.
 */
function scriptedUi(answers: Array<string | boolean | undefined>) {
  const shown: Shown[] = []
  const toasts: Array<{ message: string; kind?: string }> = []
  let cleared = 0
  const next = () => (answers.length > 0 ? answers.shift() : undefined)
  const ui: MenuUi = {
    async select(input) {
      shown.push({
        kind: 'select',
        title: input.title,
        options: input.options.map((option) => option.title),
        ...(input.current === undefined ? {} : { current: input.current }),
      })
      const answer = next()
      if (answer === undefined) return undefined
      const match = input.options.find((option) => option.title === answer)
      if (!match) throw new Error(`no option titled ${String(answer)}`)
      return match.value
    },
    async prompt(input) {
      shown.push({
        kind: 'prompt',
        title: input.title,
        ...(input.value === undefined ? {} : { value: input.value }),
      })
      const answer = next()
      return typeof answer === 'string' ? answer : undefined
    },
    async confirm(input) {
      shown.push({
        kind: 'confirm',
        title: input.title,
        message: input.message,
      })
      return next() === true
    },
    async alert(input) {
      shown.push({ kind: 'alert', title: input.title, message: input.message })
      next()
    },
    toast(message, kind) {
      toasts.push({ message, ...(kind ? { kind } : {}) })
    },
    clear() {
      cleared += 1
    },
  }
  return { ui, shown, toasts, cleared: () => cleared }
}

function recordingApply(answers: Array<MenuApplyResult | Error>) {
  const requests: MenuApplyRequest[] = []
  const apply = async (request: MenuApplyRequest) => {
    requests.push(request)
    const answer = answers.shift()
    if (!answer) throw new Error('unexpected apply')
    if (answer instanceof Error) throw answer
    return answer
  }
  return { apply, requests }
}

// ── Drawer ──────────────────────────────────────────────────────────────────

describe('openAntigravityMenu', () => {
  it('lists the sections in menu order and shows a section as read-only lines, items, actions and Back', async () => {
    const { ui, shown } = scriptedUi(['Accounts'])
    const { apply, requests } = recordingApply([])
    await openAntigravityMenu({ ui, apply }, payload())

    expect(shown[0]).toEqual({
      kind: 'select',
      title: 'Antigravity',
      options: ['Accounts', 'Limits', 'Diagnostics'],
    })
    expect(shown[1]).toEqual({
      kind: 'select',
      title: 'Accounts',
      options: ['2 accounts', 'Account 1', 'Add account', 'Back'],
    })
    expect(requests).toEqual([])
  })

  it('applies an item action by its opaque section, item and action ids', async () => {
    const { ui } = scriptedUi(['Accounts', 'Account 1', 'Disable'])
    const { apply, requests } = recordingApply([result({ text: 'Disabled.' })])
    await openAntigravityMenu({ ui, apply }, payload())

    expect(requests).toEqual([
      {
        command: 'antigravity',
        sectionId: 'accounts',
        itemId: 'sel-7f3a',
        actionId: 'disable',
        values: {},
      },
    ])
    // No ordinal index or account label is sent as a target.
    expect(JSON.stringify(requests)).not.toContain('Account 1')
  })

  it('redraws from the menu the apply returned, not a replay of the opening menu', async () => {
    const fresh = menu({ killswitchLine: 'Killswitch: on · floor 25%' })
    const { ui, shown, toasts } = scriptedUi([
      'Limits',
      'Killswitch',
      'On',
      '25',
    ])
    const { apply, requests } = recordingApply([
      result({ text: 'Killswitch on.', menu: fresh }),
    ])
    await openAntigravityMenu({ ui, apply }, payload())

    expect(requests[0]).toEqual({
      command: 'antigravity',
      sectionId: 'limits',
      actionId: 'killswitch',
      values: { enabled: true, floor: 25 },
    })
    expect(toasts).toEqual([{ message: 'Killswitch on.', kind: 'info' }])
    const last = shown.at(-1)
    expect(last).toEqual({
      kind: 'select',
      title: 'Limits',
      options: ['Killswitch: on · floor 25%', 'Killswitch', 'Back'],
    })
  })

  it('shows each input with its current value as the default', async () => {
    const { ui, shown } = scriptedUi(['Diagnostics', 'Log level'])
    const { apply } = recordingApply([])
    await openAntigravityMenu({ ui, apply }, payload())
    expect(shown[2]).toEqual({
      kind: 'select',
      title: 'Log level: Level',
      options: ['Info', 'Debug', 'Cancel'],
      current: 'info',
    })
  })

  it('never pre-fills a masked input', async () => {
    const { ui, shown } = scriptedUi(['Accounts', 'Add account'])
    const { apply } = recordingApply([])
    await openAntigravityMenu({ ui, apply }, payload())
    expect(shown[2]).toEqual({
      kind: 'prompt',
      title: 'Add account: Code',
      value: '',
    })
  })

  it('confirms an irreversible action before applying and sends confirmed', async () => {
    const { ui, shown } = scriptedUi(['Accounts', 'Account 1', 'Remove', true])
    const { apply, requests } = recordingApply([result({ text: 'Removed.' })])
    await openAntigravityMenu({ ui, apply }, payload())
    expect(shown[3]).toEqual({
      kind: 'confirm',
      title: 'Remove',
      message: 'Remove Account 1?',
    })
    expect(requests[0]?.confirmed).toBe(true)
  })

  it('does not apply when the confirmation is declined', async () => {
    const { ui } = scriptedUi(['Accounts', 'Account 1', 'Remove', false])
    const { apply, requests } = recordingApply([])
    await openAntigravityMenu({ ui, apply }, payload())
    expect(requests).toEqual([])
  })

  it('asks again when the server answers needsConfirmation, then resends confirmed', async () => {
    const { ui } = scriptedUi(['Accounts', 'Account 1', 'Disable', true])
    const { apply, requests } = recordingApply([
      result({
        ok: false,
        code: 'needs-confirmation',
        needsConfirmation: true,
        text: 'Disable the last enabled account?',
      }),
      result({ text: 'Disabled.' }),
    ])
    await openAntigravityMenu({ ui, apply }, payload())
    expect(requests).toHaveLength(2)
    expect(requests[0]?.confirmed).toBeUndefined()
    expect(requests[1]?.confirmed).toBe(true)
  })

  it('fails visibly when the refreshed menu no longer offers the item, without retargeting', async () => {
    const withoutItem: MenuModel = {
      ...menu(),
      sections: menu().sections.map((section) =>
        section.id === 'accounts' ? { ...section, items: [] } : section,
      ),
    }
    const { ui, toasts, shown } = scriptedUi([
      'Accounts',
      'Account 1',
      'Disable',
    ])
    const { apply, requests } = recordingApply([
      result({
        ok: false,
        code: 'refused',
        text: 'That account is gone.',
        menu: withoutItem,
      }),
    ])
    await openAntigravityMenu({ ui, apply }, payload())
    expect(requests).toHaveLength(1)
    expect(toasts[0]).toEqual({
      message: 'That account is gone.',
      kind: 'warning',
    })
    expect(shown.at(-1)).toEqual({
      kind: 'select',
      title: 'Accounts',
      options: ['2 accounts', 'Add account', 'Back'],
    })
  })

  it('shows the refusal text when an answer fails validation', async () => {
    const errors: string[] = []
    const { ui, toasts } = scriptedUi(['Accounts', 'Account 1', 'Disable'])
    const { apply } = recordingApply([new MenuRefusedError(['result.menu: x'])])
    await openAntigravityMenu(
      { ui, apply, onError: (message) => errors.push(message) },
      payload(),
    )
    expect(toasts[0]).toEqual({ message: MENU_REFUSED_TEXT, kind: 'error' })
    expect(errors).toEqual(['menu-apply-refused'])
  })

  it('reports an unreachable server without leaking the error text', async () => {
    const errors: Array<Record<string, unknown>> = []
    const { ui, toasts } = scriptedUi(['Accounts', 'Account 1', 'Disable'])
    const { apply } = recordingApply([new Error('token=secret-value')])
    await openAntigravityMenu(
      { ui, apply, onError: (_message, detail) => errors.push(detail) },
      payload(),
    )
    expect(toasts[0]?.message).toBe(
      'The action could not reach Antigravity auth.',
    )
    expect(JSON.stringify(errors)).not.toContain('secret-value')
  })

  it('offers to copy a sign-in link from a long result', async () => {
    const copied: string[] = []
    const { ui, shown, toasts } = scriptedUi([
      'Accounts',
      'Add account',
      'pasted-code',
      'Copy link',
    ])
    const { apply } = recordingApply([
      result({
        text: 'Open https://accounts.example/o/oauth2?state=abc to sign in.\nThen paste the code.',
      }),
    ])
    await openAntigravityMenu(
      {
        ui,
        apply,
        copy: (text) => {
          copied.push(text)
          return true
        },
      },
      payload(),
    )
    expect(shown[3]).toEqual({
      kind: 'select',
      title: 'Done',
      options: ['Copy link', 'Continue'],
    })
    expect(copied).toEqual(['https://accounts.example/o/oauth2?state=abc'])
    expect(toasts).toEqual([
      { message: 'Link copied to the clipboard.', kind: 'info' },
    ])
  })

  it('shows a long result in full when the host has no clipboard', async () => {
    const { ui, shown } = scriptedUi(['Accounts', 'Account 1', 'Disable'])
    const text = `${'Line one of a long result. '.repeat(6)}\nLine two.`
    const { apply } = recordingApply([result({ text })])
    await openAntigravityMenu({ ui, apply }, payload())
    expect(shown[3]).toEqual({ kind: 'alert', title: 'Done', message: text })
  })

  it('opens a single-section menu on that section and closes on Back', async () => {
    const only: MenuModel = { ...menu(), sections: [menu().sections[1]!] }
    const { ui, shown, cleared } = scriptedUi(['Back'])
    const { apply } = recordingApply([])
    await openAntigravityMenu({ ui, apply }, payload(only))
    expect(shown).toHaveLength(1)
    expect(shown[0]).toMatchObject({ title: 'Limits' })
    expect(cleared()).toBe(1)
  })

  it('ends when the user dismisses a dialog', async () => {
    const { ui, shown } = scriptedUi([])
    const { apply } = recordingApply([])
    await openAntigravityMenu({ ui, apply }, payload())
    expect(shown).toHaveLength(1)
  })
})

describe('drawer option builders', () => {
  it('sectionListOptions uses the first line as the description', () => {
    expect(sectionListOptions(menu())[2]).toEqual({
      title: 'Diagnostics',
      value: 'section:diagnostics',
      description: 'Logging: info',
    })
  })

  it('sectionOptions and itemOptions never carry a hide property', () => {
    const rows = [
      ...menu().sections.flatMap((section) => sectionOptions(section)),
      ...itemOptions(menu().sections[0]!.items[0]!),
    ]
    for (const row of rows) expect('disabled' in row).toBe(false)
  })

  it('promptValue sends numbers for number inputs and null for empty', () => {
    const knob = { kind: 'number', id: 'n', label: 'N' } as const
    expect(promptValue(knob, ' 42 ')).toBe(42)
    expect(promptValue(knob, 'abc')).toBe('abc')
    expect(promptValue(knob, '  ')).toBeNull()
  })

  it('firstLink finds a web link', () => {
    expect(firstLink('go to https://x.example/a?b=1 now')).toBe(
      'https://x.example/a?b=1',
    )
    expect(firstLink('no link')).toBeUndefined()
  })
})

// ── Parsers ─────────────────────────────────────────────────────────────────

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

describe('parseMenuDialogPayload', () => {
  it('accepts the shared command menu payload', () => {
    expect(parseMenuDialogPayload(payload()).ok).toBe(true)
  })

  it('names the menu command and the fixed slot order', () => {
    expect(ANTIGRAVITY_MENU_COMMAND).toBe('antigravity')
    expect(MENU_SECTION_SLOTS).toEqual([
      'accounts',
      'quota',
      'routing',
      'limits',
      'cache',
      'diagnostics',
      'extra',
    ])
  })

  const refusals: Array<
    [string, (value: Record<string, any>) => void, string]
  > = [
    [
      'a credential-shaped fact name',
      (value) => {
        value.menu.sections[0].items[0].facts.refreshToken = 'x'
      },
      'credential-shaped field',
    ],
    [
      'an email-shaped fact value',
      (value) => {
        value.menu.sections[0].items[0].facts.owner = 'someone@example.com'
      },
      'carries an email address',
    ],
    [
      'an email-shaped line',
      (value) => {
        value.menu.sections[0].lines.push('Signed in as someone@example.com')
      },
      'carries an email address',
    ],
    [
      'an account identity',
      (value) => {
        value.menu.sections[0].items[0].account.identity = 'person'
      },
      'unexpected field',
    ],
    [
      'a non-ordinal account label',
      (value) => {
        value.menu.sections[0].items[0].account.label = 'Work laptop'
      },
      'expected an ordinal account label',
    ],
    [
      'a project id on an item',
      (value) => {
        value.menu.sections[0].items[0].projectId = 'p-1'
      },
      'unexpected field',
    ],
    [
      'another command',
      (value) => {
        value.command = 'antigravity-account'
      },
      'not the antigravity menu',
    ],
    [
      'sections out of the fixed order',
      (value) => {
        value.menu.sections.reverse()
      },
      'out of the fixed order',
    ],
    [
      'an unknown input kind',
      (value) => {
        value.menu.sections[0].actions[0].knobs[0].kind = 'secret'
      },
      'unknown input kind',
    ],
  ]

  for (const [name, mutate, expected] of refusals) {
    it(`refuses ${name}`, () => {
      const value = clone(payload()) as unknown as Record<string, any>
      mutate(value)
      const parsed = parseMenuDialogPayload(value)
      expect(parsed.ok).toBe(false)
      if (!parsed.ok) {
        expect(parsed.issues.join('\n')).toContain(expected)
        // Issues name fields, never the refused value.
        expect(parsed.issues.join('\n')).not.toContain('someone@example.com')
      }
    })
  }

  it('refuses the retired per-command dialog payload', () => {
    const parsed = parseMenuDialogPayload({
      command: 'antigravity-account',
      text: 'Antigravity accounts',
      knobs: { accounts: [] },
    })
    expect(parsed.ok).toBe(false)
  })
})

describe('parseMenuApplyResult / parseMenuNotifyPayload', () => {
  it('accepts a result with its refreshed menu', () => {
    expect(parseMenuApplyResult(result({})).ok).toBe(true)
  })

  it('refuses a result without a menu', () => {
    const { menu: _menu, ...withoutMenu } = result({})
    expect(parseMenuApplyResult(withoutMenu).ok).toBe(false)
  })

  it('refuses a result whose text carries an email address', () => {
    expect(
      parseMenuApplyResult(result({ text: 'Added someone@example.com' })).ok,
    ).toBe(false)
  })

  it('accepts a notify payload and refuses an unknown kind', () => {
    expect(
      parseMenuNotifyPayload({
        command: 'antigravity',
        notify: { message: 'Account added.', kind: 'info' },
      }).ok,
    ).toBe(true)
    expect(
      parseMenuNotifyPayload({
        command: 'antigravity',
        notify: { message: 'x', kind: 'loud' },
      }).ok,
    ).toBe(false)
  })
})
