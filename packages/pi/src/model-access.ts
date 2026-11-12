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
 * The settings modules load on first use, so Pi's start stays lazy. The
 * file is re-read before every vault send and menu build: Pi sends one
 * request at a time, and a re-read keeps edits from OpenCode current
 * without a watcher.
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
}

export interface PiModelAccess {
  /** Re-read the user file and recompute the policy in force. */
  refresh(): Promise<void>
  /** The policy in force after the last refresh; deny-all before the first. */
  policy(): Pick<ModelAccessPolicy, 'allows'>
  /** One vault account's list as the menu shows it, by base model name. */
  list(routeId: string): AntigravityAccountModelList
  /** The models a list may name, after the first refresh. */
  catalog(): readonly string[]
  /** A Limits line when the setting can't be used; undefined otherwise. */
  notice(): string | undefined
  /** Sets (or, with null, removes) one vault account's list, keeping comments. */
  update(routeId: string, models: readonly string[] | null): Promise<void>
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

export function createPiModelAccess(
  options: PiModelAccessOptions,
): PiModelAccess {
  const log = options.log ?? { warn() {}, info() {} }
  let loaded:
    | {
        readonly settings: SettingsModule
        readonly rules: PolicyModule
        readonly file: string
        readonly handle: SettingsHandle<
          PolicyModule['ANTIGRAVITY_SETTINGS']['settings']
        >
        readonly store: ProtectionStore
        persisted: AppliedProtection | undefined
      }
    | undefined
  let protection: ResolvedProtection | undefined
  let policy: Pick<ModelAccessPolicy, 'allows'> = { allows: () => false }
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

  const load = async () => {
    if (loaded) return loaded
    const settings = await import(
      '@cortexkit/antigravity-auth-core/common-auth/settings'
    )
    const rules = await import('@cortexkit/antigravity-auth-core/settings')
    const file = options.file ?? (await piSettingsFile())
    const store = rules.createProtectionStore(options.statePath)
    loaded = {
      settings,
      rules,
      file,
      store,
      handle: settings.openSettings(rules.ANTIGRAVITY_SETTINGS, {
        file,
        log,
        separateInstall: false,
        // Pi never creates the file: a file Pi created would stop OpenCode's
        // one-time move of antigravity.json.
        createMissing: false,
      }),
      persisted: await store.load(file),
    }
    return loaded
  }

  const refreshOnce = async () => {
    const { rules, handle, file, store } = await load()
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
      ...(loaded?.persisted ? { persisted: loaded.persisted } : {}),
    })
    if (protection.accountModelsSource === 'setting') {
      lastApplied = { accountModels: protection.accountModels as AccountModels }
      const next = { accountModels: lastApplied.accountModels }
      if (
        loaded &&
        JSON.stringify(next) !== JSON.stringify(loaded.persisted ?? {})
      ) {
        try {
          await store.save(file, next)
          loaded.persisted = next
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

  return {
    refresh: () => serial(refreshOnce),
    policy: () => policy,
    list(routeId) {
      if (!protection || !loaded) return null
      const lists = protection.accountModels
      if (lists === 'deny-all') return 'deny-all'
      const list = Object.hasOwn(lists, routeId) ? lists[routeId] : undefined
      const canonical = loaded.rules.canonicalModelId
      return list ? [...new Set(list.map(canonical))] : null
    },
    catalog: () => loaded?.rules.knownModelIds() ?? [],
    notice() {
      if (!protection || protection.accountModelsSource === 'setting')
        return undefined
      return protection.accountModelsSource === 'most-restrictive'
        ? "account_models in antigravity-auth.jsonc can't be used and no earlier value is known, so no vault account serves until it is fixed."
        : "account_models in antigravity-auth.jsonc can't be used; the last applied value stays in force until it is fixed."
    },
    update: (routeId, models) =>
      serial(async () => {
        const { settings, rules, handle, file } = await load()
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
        await refreshOnce()
      }),
  }
}

/** Pi's state file for the last applied lists, beside its vault files. */
export function piModelAccessStatePath(vaultDir: string): string {
  return join(vaultDir, 'settings-protection.json')
}
