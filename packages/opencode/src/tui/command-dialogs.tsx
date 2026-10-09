/**
 * The `/antigravity` drawer: one renderer for the server's command menu,
 * shared by the OpenCode 1 and OpenCode GA TUIs.
 *
 * The server builds the whole menu with the shared command menu of
 * `@cortexkit/common-auth/commands`: Accounts, Quota, Routing, Limits
 * (killswitch), Cache, Diagnostics (logging and wire dump) and the plugin's
 * extras (vault setup), each with its read-only lines, its items, and its
 * actions with their typed inputs and confirmations. This file only walks
 * that payload through the host's dialogs and sends back which action the
 * user chose, by the opaque section, item and action ids the server gave.
 * It never builds an account target of its own, never looks an account up
 * by position, and never retries a choice against a different target: an id
 * the server no longer knows comes back as a refused apply and the user sees
 * the server's message.
 *
 * Every redraw after an apply uses the menu that apply returned, which the
 * server built fresh for that answer; settings shown here are never a
 * replay of an earlier answer.
 *
 * The drawer talks to the host only through `MenuUi` (dialog primitives as
 * promises) and `MenuApply` (the transport), so the same code runs on both
 * hosts. Nothing here writes to the terminal or picks colors.
 */

import {
  type KnobValue,
  MENU_REFUSED_TEXT,
  type MenuAction,
  type MenuApply,
  type MenuApplyRequest,
  type MenuApplyResult,
  type MenuDialogPayload,
  type MenuItem,
  type MenuKnob,
  type MenuModel,
  type MenuSection,
  type MenuSelectOption,
  type MenuUi,
} from './host-api'

const BACK = 'back'

/** Text longer than this, or with a line break, is shown in full, not toasted. */
const TOAST_MAX_LENGTH = 120

/**
 * Raised by a transport when an answer fails validation, so the drawer can
 * tell a refused answer from an unreachable server.
 */
export class MenuRefusedError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(MENU_REFUSED_TEXT)
    this.name = 'MenuRefusedError'
  }
}

function factLines(
  facts: Readonly<Record<string, unknown>> | undefined,
): string[] {
  return Object.entries(facts ?? {}).map(
    ([name, value]) =>
      `${name}: ${typeof value === 'string' ? value : JSON.stringify(value)}`,
  )
}

/** One option per section, in the order the menu gives them. */
export function sectionListOptions(menu: MenuModel): MenuSelectOption[] {
  return menu.sections.map((section) => ({
    title: section.title,
    value: `section:${section.id}`,
    ...(section.lines[0] ? { description: section.lines[0] } : {}),
  }))
}

/**
 * A section's rows: its read-only lines and facts first (choosing one only
 * redraws the section), then its items, its own actions, and Back.
 */
export function sectionOptions(section: MenuSection): MenuSelectOption[] {
  return [
    ...[...section.lines, ...factLines(section.facts)].map((line, index) => ({
      title: line,
      value: `line:${index}`,
    })),
    ...section.items.map((item) => ({
      title: item.label,
      value: `item:${item.id}`,
      ...(item.detail ? { description: item.detail } : {}),
    })),
    ...section.actions.map((action) => ({
      title: action.label,
      value: `action:${action.id}`,
      ...(action.description ? { description: action.description } : {}),
    })),
    { title: 'Back', value: BACK },
  ]
}

/** An item's rows: its detail and facts (read-only), its actions, and Back. */
export function itemOptions(item: MenuItem): MenuSelectOption[] {
  return [
    ...(item.detail ? [{ title: item.detail, value: 'line:detail' }] : []),
    ...factLines(item.facts).map((line, index) => ({
      title: line,
      value: `line:${index}`,
    })),
    ...item.actions.map((action) => ({
      title: action.label,
      value: `action:${action.id}`,
      ...(action.description ? { description: action.description } : {}),
    })),
    { title: 'Back', value: BACK },
  ]
}

/**
 * The value a typed `number` or `text` input sends. Empty is `null` (the
 * action reads that as "leave unset"); a number input sends a number when
 * the text parses as one and the text otherwise, so the server can say what
 * is wrong with it.
 */
export function promptValue(knob: MenuKnob, raw: string): KnobValue {
  const text = raw.trim()
  if (text === '') return null
  if (knob.kind === 'number') {
    const number = Number(text)
    return Number.isFinite(number) ? number : text
  }
  return raw
}

function knobDefault(knob: MenuKnob): string {
  if (knob.kind === 'toggle') return knob.value ? 'on' : 'off'
  if (knob.kind === 'text' && knob.masked) return ''
  return knob.value === undefined ? '' : String(knob.value)
}

/** The first web link in a message, such as a sign-in URL. */
export function firstLink(text: string): string | undefined {
  return /https?:\/\/\S+/.exec(text)?.[0]
}

export interface DrawerOptions {
  readonly ui: MenuUi
  readonly apply: MenuApply
  /**
   * Copies text to the clipboard; returns false when the terminal cannot.
   * Absent when the host offers no clipboard.
   */
  readonly copy?: (text: string) => boolean
  /** Receives drawer failures; must not write to the terminal. */
  readonly onError?: (message: string, detail: Record<string, unknown>) => void
  /** Opens on this section instead of the section list, when it exists. */
  readonly startSection?: string
}

/**
 * Opens the drawer on a payload the server pushed for `/antigravity`. The
 * returned promise settles when the user closes the drawer.
 */
export function openAntigravityMenu(
  options: DrawerOptions,
  payload: MenuDialogPayload,
): Promise<void> {
  return new Drawer(options, payload.menu).start()
}

const CANCEL = '\u0000cancel'

class Drawer {
  private menu: MenuModel

  constructor(
    private readonly options: DrawerOptions,
    menu: MenuModel,
  ) {
    this.menu = menu
  }

  async start(): Promise<void> {
    const start = this.options.startSection
    if (start && this.menu.sections.some((section) => section.id === start)) {
      await this.section(start)
      return
    }
    const only =
      this.menu.sections.length === 1 ? this.menu.sections[0] : undefined
    if (only) {
      await this.section(only.id)
      return
    }
    await this.list()
  }

  private async list(): Promise<void> {
    const { ui } = this.options
    const chosen = await ui.select({
      title: this.menu.title,
      options: sectionListOptions(this.menu),
    })
    if (chosen === undefined) return
    await this.section(chosen.slice('section:'.length))
  }

  private async closeOrList(): Promise<void> {
    if (this.menu.sections.length === 1) {
      this.options.ui.clear()
      return
    }
    await this.list()
  }

  private async section(sectionId: string): Promise<void> {
    const { ui } = this.options
    const section = this.menu.sections.find((entry) => entry.id === sectionId)
    if (!section) {
      ui.toast('That section is no longer offered.', 'warning')
      await this.list()
      return
    }
    const chosen = await ui.select({
      title: section.title,
      options: sectionOptions(section),
    })
    // Dismissing the dialog (Escape) closes the drawer; Back goes up a level.
    if (chosen === undefined) return
    if (chosen === BACK) {
      await this.closeOrList()
      return
    }
    if (chosen.startsWith('item:')) {
      await this.item(section.id, chosen.slice('item:'.length))
      return
    }
    if (chosen.startsWith('action:')) {
      const action = section.actions.find(
        (entry) => entry.id === chosen.slice('action:'.length),
      )
      if (action) {
        await this.run(section, undefined, action)
        return
      }
    }
    // A read-only line: redraw the same section.
    await this.section(section.id)
  }

  private async item(sectionId: string, itemId: string): Promise<void> {
    const { ui } = this.options
    const section = this.menu.sections.find((entry) => entry.id === sectionId)
    const item = section?.items.find((entry) => entry.id === itemId)
    if (!section || !item) {
      ui.toast('That entry is no longer offered.', 'warning')
      if (section) await this.section(section.id)
      else await this.list()
      return
    }
    const chosen = await ui.select({
      title: `${section.title}: ${item.label}`,
      options: itemOptions(item),
    })
    if (chosen === undefined) return
    if (chosen === BACK) {
      await this.section(section.id)
      return
    }
    if (chosen.startsWith('action:')) {
      const action = item.actions.find(
        (entry) => entry.id === chosen.slice('action:'.length),
      )
      if (action) {
        await this.run(section, item, action)
        return
      }
    }
    await this.item(section.id, item.id)
  }

  /** Asks for one input; resolves undefined when the user backs out. */
  private async knob(
    title: string,
    knob: MenuKnob,
  ): Promise<KnobValue | undefined> {
    const { ui } = this.options
    if (knob.kind === 'choice' || knob.kind === 'toggle') {
      const choices: MenuSelectOption[] =
        knob.kind === 'choice'
          ? knob.choices.map((choice) => ({
              title: choice.label,
              value: choice.value,
            }))
          : [
              { title: 'On', value: 'on' },
              { title: 'Off', value: 'off' },
            ]
      const chosen = await ui.select({
        title: `${title}: ${knob.label}`,
        current: knobDefault(knob),
        options: [...choices, { title: 'Cancel', value: CANCEL }],
      })
      if (chosen === undefined || chosen === CANCEL) return undefined
      return knob.kind === 'toggle' ? chosen === 'on' : chosen
    }
    const placeholder = knob.kind === 'text' ? knob.placeholder : undefined
    const raw = await ui.prompt({
      title: `${title}: ${knob.label}`,
      ...(placeholder ? { placeholder } : {}),
      value: knobDefault(knob),
    })
    if (raw === undefined) return undefined
    return promptValue(knob, raw)
  }

  private back(section: MenuSection, item: MenuItem | undefined) {
    return item ? this.item(section.id, item.id) : this.section(section.id)
  }

  /**
   * Collects an action's inputs, confirms it when it carries a confirmation,
   * applies it and redraws from the refreshed menu.
   */
  private async run(
    section: MenuSection,
    item: MenuItem | undefined,
    action: MenuAction,
  ): Promise<void> {
    const { ui } = this.options
    const values: Record<string, KnobValue> = {}
    for (const knob of action.knobs) {
      const value = await this.knob(action.label, knob)
      if (value === undefined) {
        await this.back(section, item)
        return
      }
      values[knob.id] = value
    }
    let confirmed = false
    if (action.confirm) {
      confirmed = await ui.confirm({
        title: action.label,
        message: action.confirm.message,
      })
      if (!confirmed) {
        await this.back(section, item)
        return
      }
    }
    const request: MenuApplyRequest = {
      command: this.menu.command,
      sectionId: section.id,
      ...(item ? { itemId: item.id } : {}),
      actionId: action.id,
      values,
      ...(confirmed ? { confirmed: true as const } : {}),
    }
    let result = await this.send(request)
    if (!result) {
      await this.back(section, item)
      return
    }
    if (result.needsConfirmation && !confirmed) {
      const yes = await ui.confirm({
        title: action.label,
        message: result.text,
      })
      if (!yes) {
        this.menu = result.menu
        await this.section(section.id)
        return
      }
      const again = await this.send({ ...request, confirmed: true })
      if (!again) {
        this.menu = result.menu
        await this.back(section, item)
        return
      }
      result = again
    }
    this.menu = result.menu
    await this.finish(section.id, result)
  }

  private async send(
    request: MenuApplyRequest,
  ): Promise<MenuApplyResult | undefined> {
    const { ui, apply, onError } = this.options
    try {
      return await apply(request)
    } catch (error) {
      if (error instanceof MenuRefusedError) {
        onError?.('menu-apply-refused', { issues: error.issues })
        ui.toast(MENU_REFUSED_TEXT, 'error')
        return undefined
      }
      onError?.('menu-apply-failed', {
        error: error instanceof Error ? error.name : typeof error,
      })
      ui.toast('The action could not reach Antigravity auth.', 'error')
      return undefined
    }
  }

  /**
   * Shows the apply's message and returns to the section. A long message (a
   * sign-in URL, a multi-line result) is shown in full; a link in it can be
   * copied when the host has a clipboard. A short one is a toast.
   */
  private async finish(sectionId: string, result: MenuApplyResult) {
    const { ui, copy } = this.options
    const kind = result.ok ? 'info' : 'warning'
    const long =
      result.text.includes('\n') || result.text.length > TOAST_MAX_LENGTH
    const link = firstLink(result.text)
    if (link && copy) {
      const chosen = await ui.select({
        title: result.ok ? 'Done' : 'Not done',
        options: [
          { title: 'Copy link', value: 'copy', description: link },
          { title: 'Continue', value: 'continue', description: result.text },
        ],
      })
      if (chosen === 'copy') {
        ui.toast(
          copy(link)
            ? 'Link copied to the clipboard.'
            : 'Copy is unavailable here; select the link to copy it.',
          'info',
        )
      }
    } else if (long) {
      await ui.alert({
        title: result.ok ? 'Done' : 'Not done',
        message: result.text,
      })
    } else {
      ui.toast(result.text, kind)
    }
    await this.section(sectionId)
  }
}
