/**
 * Pi's per-account model lists: `account_models` in the user settings file
 * `antigravity-auth.jsonc`, the same file OpenCode reads.
 *
 * Pi serves one account at a time. Only a vault account has a stable id (its
 * roster route id, from Pi's own roster), so only vault mode is restricted;
 * Pi's own login has no stable id and always serves every model.
 *
 * The rules are OpenCode's (core `./settings`): a value the file can't
 * supply never widens access. The last applied value stays in force while
 * Pi runs and is persisted beside Pi's vault files for the next start; with
 * nothing persisted, no restricted account serves.
 *
 * The settings file is opened once per extension instance (`ready`), and the
 * library's watcher re-applies it after every change, including its
 * creation: Pi never creates the file, so a missing file means no lists
 * (every model) until it appears. A send only consults the policy in memory
 * and never reads the file. `dispose` stops the watcher; Pi calls it on
 * session shutdown, and the next `ready` opens the file again. The settings
 * modules load on first use, so Pi's start stays lazy.
 */

import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  ACCOUNT_MODELS_REFUSAL_TEXT,
  type AntigravityAccountModelList,
  AntigravityMenuRefusal,
} from '@cortexkit/antigravity-auth-core'
import type { SettingsHandle } from '@cortexkit/antigravity-auth-core/common-auth/settings'
import type {
  AccountModels,
  AppliedProtection,
  ModelAccessPolicy,
  ProtectionStore,
  ResolvedProtection,
} from '@cortexkit/antigravity-auth-core/settings'

type SettingsModule =
  typeof import('@cortexkit/antigravity-auth-core/common-auth/settings')
type PolicyModule = typeof import('@cortexkit/antigravity-auth-core/settings')

/** The vault-mode refusal for a model the serving account's list forbids. */
export const PI_ACCOUNT_MODELS_REFUSAL =
  'This vault account is set not to serve this model (account_models in antigravity-auth.jsonc). Choose another model or account, or change Account models in /antigravity. No request was sent.'

/** Fixed text when Pi would have to create the settings file to save a list. */
export const PI_ACCOUNT_MODELS_NO_FILE =
  "antigravity-auth.jsonc doesn't exist yet, so nothing was changed. Pi doesn't create it; create it, or let OpenCode move its settings there first."

export interface PiModelAccessOptions {
  /** The user settings file; defaults to the shared `antigravity-auth.jsonc`. */
  readonly file?: string
  /** Where the last applied value is kept; defaults beside Pi's vault files. */
  readonly statePath: string
  readonly log?: { warn(message: string): void; info(message: string): void }
  /** Test seam: the library's `openSettings`. */
  readonly open?: SettingsModule['openSettings']
}

export interface PiModelAccess {
  /**
   * Open the settings file, apply it and start watching it, once; later
   * calls wait for that same start. A failed start is retried on the next
   * call.
   */
  ready(): Promise<void>
  /** The policy in force; deny-all until `ready` has applied the file. */
  policy(): Pick<ModelAccessPolicy, 'allows'>
  /** One vault account's list as the menu shows it, by base model name. */
  list(routeId: string): AntigravityAccountModelList
  /** The models a list may name, once `ready` has finished. */
  catalog(): readonly string[]
  /** An Accounts line when the setting can't be used; undefined otherwise. */
  notice(): string | undefined
  /** Sets (or, with null, removes) one vault account's list, keeping comments. */
  update(routeId: string, models: readonly string[] | null): Promise<void>
  /** Stop watching the file and wait for any re-read in progress. */
  dispose(): Promise<void>
}

/** The shared settings file, as OpenCode resolves it for the same user. */
export async function piSettingsFile(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const { settingsFilePath } = await import(
    '@cortexkit/antigravity-auth-core/common-auth/settings'
  )
  return settingsFilePath({
    plugin: 'antigravity-auth',
    override: env.OPENCODE_ANTIGRAVITY_AUTH_SETTINGS_FILE,
    env,
    platform: process.platform,
    homedir: homedir(),
  })
}

interface OpenSettings {
  readonly settings: SettingsModule
  readonly rules: PolicyModule
  readonly file: string
  readonly handle: SettingsHandle<
    PolicyModule['ANTIGRAVITY_SETTINGS']['settings']
  >
  readonly store: ProtectionStore
  persisted: AppliedProtection | undefined
  /** Stops this start's watcher. */
  stop?: () => void
}

export function createPiModelAccess(
  options: PiModelAccessOptions,
): PiModelAccess {
  const log = options.log ?? { warn() {}, info() {} }
  // The settings handle of the current start; undefined once disposed.
  let current: OpenSettings | undefined
  let starting: Promise<OpenSettings> | undefined
  let protection: ResolvedProtection | undefined
  let policy: Pick<ModelAccessPolicy, 'allows'> = { allows: () => false }
  // Kept across restarts in one process: a value applied earlier still
  // stands in for a file that later becomes unusable.
  let lastApplied: AppliedProtection = {}
  // Reads and writes run one at a time, so a refresh never interleaves
  // with the state save of another.
  let queue: Promise<void> = Promise.resolve()
  const serial = <T>(step: () => Promise<T>): Promise<T> => {
    const run = queue.then(step)
    queue = run.then(
      () => {},
      () => {},
    )
    return run
  }

  const open = async (): Promise<OpenSettings> => {
    const settings = await import(
      '@cortexkit/antigravity-auth-core/common-auth/settings'
    )
    const rules = await import('@cortexkit/antigravity-auth-core/settings')
    const file = options.file ?? (await piSettingsFile())
    const store = rules.createProtectionStore(options.statePath)
    return {
      settings,
      rules,
      file,
      store,
      handle: (options.open ?? settings.openSettings)(
        rules.ANTIGRAVITY_SETTINGS,
        {
          file,
          log,
          separateInstall: false,
          // Pi never creates the file: a file Pi created would stop
          // OpenCode's one-time move of antigravity.json.
          createMissing: false,
        },
      ),
      persisted: await store.load(file),
    }
  }

  /** Read the file through `opened` and apply it; the only file read. */
  const apply = async (opened: OpenSettings) => {
    const { rules, handle, file, store } = opened
    await handle.read()
    const accountModels = await handle.get('account_models', { host: 'pi' })
    protection = rules.resolveProtection({
      accountModels,
      // Pi has no per-account floors; only the model lists are resolved.
      floors: {},
      accountModelsUnusable: rules.unusableAt(handle.report(), file, [
        'account_models',
      ]),
      floorsUnusable: false,
      lastApplied,
      ...(opened.persisted ? { persisted: opened.persisted } : {}),
    })
    if (protection.accountModelsSource === 'setting') {
      lastApplied = { accountModels: protection.accountModels as AccountModels }
      const next = { accountModels: lastApplied.accountModels }
      if (JSON.stringify(next) !== JSON.stringify(opened.persisted ?? {})) {
        try {
          await store.save(file, next)
          opened.persisted = next
        } catch (error) {
          log.warn(
            `Could not save the last applied account_models (${error instanceof Error ? error.name : 'unknown'})`,
          )
        }
      }
    }
    policy =
      protection.accountModels === 'deny-all'
        ? rules.compileModelAccess(undefined, { unusable: true })
        : rules.compileModelAccess(protection.accountModels)
  }

  const start = async (): Promise<OpenSettings> => {
    const opened = await open()
    await serial(() => apply(opened))
    current = opened
    opened.stop = opened.handle.watch(() => {
      // A change reported after dispose belongs to a closed start.
      if (current !== opened) return
      void serial(() => apply(opened)).catch((error: unknown) =>
        log.warn(
          `Could not apply a change to account_models (${error instanceof Error ? error.name : 'unknown'})`,
        ),
      )
    })
    return opened
  }

  const ready = (): Promise<OpenSettings> => {
    starting ??= start().catch((error: unknown) => {
      starting = undefined
      throw error
    })
    return starting
  }

  return {
    ready: async () => {
      await ready()
    },
    policy: () => policy,
    list(routeId) {
      if (!protection || !current) return null
      const lists = protection.accountModels
      if (lists === 'deny-all') return 'deny-all'
      const list = Object.hasOwn(lists, routeId) ? lists[routeId] : undefined
      const canonical = current.rules.canonicalModelId
      return list ? [...new Set(list.map(canonical))] : null
    },
    catalog: () => current?.rules.knownModelIds() ?? [],
    notice() {
      if (!protection || protection.accountModelsSource === 'setting')
        return undefined
      return protection.accountModelsSource === 'most-restrictive'
        ? "account_models in antigravity-auth.jsonc can't be used and no earlier value is known, so no vault account serves until it is fixed."
        : "account_models in antigravity-auth.jsonc can't be used; the last applied value stays in force until it is fixed."
    },
    update: async (routeId, models) => {
      const opened = await ready()
      return serial(async () => {
        const { settings, rules, handle, file } = opened
        let value: string[] | undefined
        if (models !== null) {
          const list = rules.normalizeAccountModelList(models)
          if (!list.ok)
            throw new AntigravityMenuRefusal(
              ACCOUNT_MODELS_REFUSAL_TEXT[list.reason],
              'invalid-input',
            )
          value = [...list.models]
        }
        try {
          await stat(file)
        } catch {
          throw new AntigravityMenuRefusal(
            PI_ACCOUNT_MODELS_NO_FILE,
            'settings-unavailable',
          )
        }
        try {
          await handle.update(
            [
              value === undefined
                ? { setting: 'account_models', path: [routeId], remove: true }
                : { setting: 'account_models', path: [routeId], value },
            ],
            { host: 'pi' },
          )
        } catch (error) {
          if (error instanceof settings.SettingsRefusal)
            throw new AntigravityMenuRefusal(
              rules.settingsRefusalText(error.code, file),
              error.code,
            )
          throw error
        }
        // Apply the edit now so the menu shows it; the watcher would also
        // report it, and applying the same text twice changes nothing.
        await apply(opened)
      })
    },
    async dispose() {
      const pending = starting
      starting = undefined
      const opened = await pending?.catch(() => undefined)
      if (current === opened) current = undefined
      opened?.stop?.()
      await queue
    },
  }
}

/** Pi's state file for the last applied lists, beside its vault files. */
export function piModelAccessStatePath(vaultDir: string): string {
  return join(vaultDir, 'settings-protection.json')
}
