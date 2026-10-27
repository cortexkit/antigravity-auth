import { lstat, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  ANTIGRAVITY_PROVIDER_ID,
  getPiAntigravityVaultDir,
  loadCommonAuthClaustrum,
  loadCommonAuthFs,
  loadCommonAuthPiSlot,
  resolveClaustrumConnectionPath,
} from '@cortexkit/antigravity-auth-core'
import {
  OPENCODE2_POOL_AUTH_LABEL,
  OPENCODE2_VAULT_AUTH_LABEL,
} from './auth-method-labels.ts'
import type { CliDependencies } from './cli.ts'
import {
  assertHostsStopped,
  createProcessFence,
  runSetup,
  type SetupCallbackContext,
  type SetupHost,
  type SetupIO,
  type SetupPlugin,
} from './common-auth-embedded/setup/index.js'
import type { AntigravityTokenExchangeSuccess } from './plugin/oauth-login.ts'
import { getStoragePath, UNMIGRATED_ACCOUNT_MESSAGE } from './plugin/storage.ts'
import { nativeOpenCodeAuthPath } from './plugin/vault-activation.ts'
import {
  OPENCODE_VAULT_ENROLLMENT_NAME,
  OPENCODE_VAULT_PROVIDER,
} from './plugin/vault-custody.ts'
import { currentVaultFolder } from './vault-folder.ts'

const PI_PLACEHOLDER_KEY = 'antigravity-vault-custody'

/**
 * OpenCode's vault folder for `accountFile`, as this process settled it: in
 * the state home once the vault files moved there, beside the account file
 * before. A process that has not settled it (a dry run, a preview) follows
 * the layout marker without writing anything.
 */
function openCodeVaultDir(accountFile: string): string {
  const folder = currentVaultFolder(accountFile)
  if (folder.refusal) throw folder.refusal
  return folder.vaultDir
}

function nativeAuthPath(
  host: SetupHost,
  context: SetupCallbackContext,
): string {
  return host === 'opencode'
    ? nativeOpenCodeAuthPath()
    : join(context.piAgentDir, 'auth.json')
}

function provider(host: SetupHost): string {
  return host === 'opencode' ? OPENCODE_VAULT_PROVIDER : ANTIGRAVITY_PROVIDER_ID
}

async function nativeAuth(
  host: SetupHost,
  context: SetupCallbackContext,
): Promise<Record<string, unknown>> {
  return readNativeAuth(nativeAuthPath(host, context))
}

async function readNativeAuth(path: string): Promise<Record<string, unknown>> {
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.nlink !== 1)
      throw new Error('Native auth must be a regular, unaliased file.')
    const value: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Native auth is invalid; refusing to replace it.')
    return value as Record<string, unknown>
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
}

/**
 * Refuse local sign-in if vault access is approved or auth.json holds its vault
 * marker. Re-read both because they can change while the OAuth browser is open.
 */
export async function assertLocalOpenCodeLogin(
  legacyPath: string,
  generation?: SetupCallbackContext['opencodeGeneration'],
): Promise<void> {
  const claustrum = await loadCommonAuthClaustrum()
  if (
    (await claustrum.enrollmentAuthority(
      claustrum.hostEnrollmentPaths({
        stateDir: openCodeVaultDir(legacyPath),
        host: 'opencode',
      }),
      OPENCODE_VAULT_ENROLLMENT_NAME,
    )) !== 'local'
  )
    throw new Error(
      'Vault enrollment excludes local sign-in. Resolve vault access before choosing local setup.',
    )
  // OpenCode 2 authenticates Google through its own connection, not OpenCode 1's
  // auth.json. That dormant file must not block its native login.
  if (generation === '2') return
  claustrum.assertHostSlotMatchesMode({
    mode: 'local',
    auth: (await readNativeAuth(nativeOpenCodeAuthPath()))[
      OPENCODE_VAULT_PROVIDER
    ],
    provider: OPENCODE_VAULT_PROVIDER,
  })
}

export async function assertSetupHostsStopped(): Promise<void> {
  await assertHostsStopped(createProcessFence(), process.env)
}

async function writeNativeSlot(
  host: SetupHost,
  slot: unknown,
  context: SetupCallbackContext,
  expectedAuthority: 'local' | 'vault' = 'local',
): Promise<void> {
  const before = await nativeAuth(host, context)
  const key = provider(host)
  if (JSON.stringify(before[key]) === JSON.stringify(slot)) return
  const fs = await loadCommonAuthFs()
  await fs.writeJsonAtomic(
    nativeAuthPath(host, context),
    { ...before, [key]: slot },
    {
      beforeRename: async () => {
        await assertSetupHostsStopped()
        const claustrum = await loadCommonAuthClaustrum()
        const stateDir =
          host === 'opencode'
            ? openCodeVaultDir(resolve(getStoragePath()))
            : getPiAntigravityVaultDir()
        if (
          (await claustrum.enrollmentAuthority(
            claustrum.hostEnrollmentPaths({ stateDir, host }),
            `antigravity-auth-${host}`,
          )) !== expectedAuthority
        )
          throw new Error(
            'Vault enrollment changed during setup; native auth was not replaced.',
          )
        if (
          JSON.stringify(await nativeAuth(host, context)) !==
          JSON.stringify(before)
        )
          throw new Error(
            'Native auth changed during setup; rerun with hosts stopped.',
          )
      },
    },
  )
}

/** Pi stores its local login in auth.json, not OpenCode's account pool. */
export async function persistPiSetupLogin(
  result: AntigravityTokenExchangeSuccess,
  context: SetupCallbackContext,
): Promise<void> {
  await writeNativeSlot(
    'pi',
    {
      type: 'oauth',
      refresh: result.refresh,
      access: result.access,
      expires: result.expires,
    },
    context,
  )
}

export async function createSetupPlugin(
  deps: CliDependencies,
  migrateOpenCode: () => Promise<number>,
  forceLogin = false,
): Promise<SetupPlugin> {
  const claustrum = await loadCommonAuthClaustrum()
  const piDir = getPiAntigravityVaultDir()
  const hosts = {
    opencode: {
      name: OPENCODE_VAULT_ENROLLMENT_NAME,
      // Read at each use: a real run settles the vault folder in
      // `beforeSignIn`, which may move it after this plugin is built.
      paths: {
        get stateDir() {
          return openCodeVaultDir(resolve(getStoragePath()))
        },
        host: 'opencode',
      },
    },
    pi: {
      name: 'antigravity-auth-pi',
      paths: { stateDir: piDir, host: 'pi' },
    },
  }
  const authority = (host: SetupHost) =>
    claustrum.enrollmentAuthority(
      claustrum.hostEnrollmentPaths(hosts[host].paths),
      hosts[host].name,
    )
  const assertLocal = async (
    host: SetupHost,
    context: SetupCallbackContext,
  ) => {
    if (host === 'opencode')
      return assertLocalOpenCodeLogin(
        resolve(getStoragePath()),
        context.opencodeGeneration,
      )
    if ((await authority(host)) !== 'local')
      throw new Error(
        'Vault enrollment excludes local sign-in. Resolve vault access before choosing local setup.',
      )
    claustrum.assertHostSlotMatchesMode({
      mode: 'local',
      auth: (await nativeAuth(host, context))[provider(host)],
      provider: provider(host),
    })
    if (host === 'pi') {
      const { openPiSlot } = await loadCommonAuthPiSlot()
      if (
        (
          await openPiSlot({
            authPath: nativeAuthPath(host, context),
            stashPath: join(piDir, 'google-login-stash.json'),
            provider: ANTIGRAVITY_PROVIDER_ID,
            placeholderKey: PI_PLACEHOLDER_KEY,
          }).inspect()
        ).slot === 'placeholder'
      )
        throw new Error(
          'Pi holds the vault marker, not a local login. Restore its saved login before local setup.',
        )
    }
  }
  let openCodeLogin: AntigravityTokenExchangeSuccess | undefined
  const manifest = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { version: string }
  return {
    packages: {
      opencode: '@cortexkit/opencode-antigravity-auth',
      pi: '@cortexkit/pi-antigravity-auth',
    },
    version: manifest.version,
    displayName: 'Antigravity',
    slashCommand: '/antigravity',
    vault: { connectionFile: await resolveClaustrumConnectionPath(), hosts },
    beforeSignIn: async (_host, context) => {
      // Validate every selected host before the first can change credentials or enrollment.
      // Public Windows readers may tighten owned file DACLs; never run them on a preview.
      await assertSetupHostsStopped()
      // A real run is about to use the plugin's data: settle where OpenCode's
      // vault files live (every host is stopped, so moving them is usually
      // safe now), then put this process's heartbeat on disk. A preview never
      // reaches this callback. Pi's files never move.
      if (context.hosts.includes('opencode')) await deps.prepareVaultFolder?.()
      await deps.processHeartbeat?.()
      for (const selected of context.hosts) {
        if (context.mode === 'local') {
          await assertLocal(selected, context)
        } else if (
          selected === 'opencode' &&
          context.opencodeGeneration !== '2'
        ) {
          claustrum.assertHostSlotMatchesMode({
            mode: 'custody',
            auth: (await nativeAuth(selected, context))[provider(selected)],
            provider: provider(selected),
          })
        } else if (selected === 'pi') {
          const { openPiSlot } = await loadCommonAuthPiSlot()
          const inspection = await openPiSlot({
            authPath: nativeAuthPath('pi', context),
            stashPath: join(piDir, 'google-login-stash.json'),
            provider: ANTIGRAVITY_PROVIDER_ID,
            placeholderKey: PI_PLACEHOLDER_KEY,
          }).inspect()
          if (inspection.slot === 'foreign')
            throw new Error(
              'Pi has a different login from its saved stash; resolve the conflict before vault setup.',
            )
          if (
            inspection.slot === 'placeholder' &&
            inspection.stash === 'missing'
          )
            throw new Error(
              'Pi holds a vault marker without its saved login stash; resolve it before vault setup.',
            )
        }
      }
      if (
        forceLogin &&
        context.mode === 'local' &&
        context.hosts.includes('opencode') &&
        context.opencodeGeneration !== '2'
      ) {
        const source = await deps.accountStore.read(
          deps.accountStore.legacyPath(),
        )
        if (source.kind === 'legacy')
          throw new Error(UNMIGRATED_ACCOUNT_MESSAGE)
        if (source.kind === 'unavailable') throw new Error(source.reason)
      }
    },
    signInLocal: async (host, context) => {
      await assertLocal(host, context)
      // The OpenCode 2 host login creates its Google integration connection.
      // A standalone OAuth flow here cannot create it and would require a second login.
      if (host === 'opencode' && context.opencodeGeneration === '2') return
      const slot = (await nativeAuth(host, context))[provider(host)]
      const source =
        host === 'opencode'
          ? await deps.accountStore.read(deps.accountStore.legacyPath())
          : undefined
      if (source?.kind === 'unavailable') throw new Error(source.reason)
      if (forceLogin && source?.kind === 'legacy')
        throw new Error(UNMIGRATED_ACCOUNT_MESSAGE)
      const accounts =
        source?.kind === 'store'
          ? source.accounts
          : source?.kind === 'legacy'
            ? ((await deps.loadAccounts())?.accounts ?? [])
            : []
      if (
        !forceLogin &&
        (host === 'pi'
          ? claustrum.classifyHostSlot(slot, provider(host)) === 'login'
          : accounts.length > 0)
      ) {
        deps.stdout.write(
          `Using existing local Antigravity login for ${host}.\n`,
        )
        if (
          host === 'opencode' &&
          claustrum.classifyHostSlot(slot, provider(host)) !== 'login'
        ) {
          const account = accounts[0]!
          await writeNativeSlot(
            host,
            {
              type: 'oauth',
              access: '',
              expires: 0,
              refresh: [
                account.refreshToken,
                account.projectId ?? '',
                account.managedProjectId ?? '',
              ].join('|'),
            },
            context,
          )
        }
        return
      }
      const result = await deps.performLogin(
        {
          noBrowser: false,
          isHeadless: deps.isHeadless?.() ?? false,
          accounts: [],
          startFresh: false,
        },
        deps.openBrowser,
        host,
        context,
      )
      if (host === 'opencode') openCodeLogin = result
    },
    beforeRegister: async (host, mode, context) => {
      const needsOpenCode2 =
        host === 'opencode' && context.opencodeGeneration !== '1'
      const nativeNextStep = (label: string) => {
        deps.stdout.write(
          `In OpenCode 2, run opencode auth login, select Google, then choose ${label}.\n` +
            'Setup has not completed the OpenCode 2 native Google connection.\n',
        )
      }
      if (mode === 'local') {
        await assertLocal(host, context)
        if (
          host === 'opencode' &&
          context.opencodeGeneration !== '2' &&
          openCodeLogin
        )
          await writeNativeSlot(
            host,
            {
              type: 'oauth',
              refresh: openCodeLogin.refresh,
              access: openCodeLogin.access,
              expires: openCodeLogin.expires,
            },
            context,
          )
        if (needsOpenCode2) nativeNextStep(OPENCODE2_POOL_AUTH_LABEL)
        return
      }
      if ((await authority(host)) !== 'vault')
        throw new Error('Vault access must be approved before activation.')
      if (host === 'opencode') {
        if (context.opencodeGeneration === '2') {
          nativeNextStep(OPENCODE2_VAULT_AUTH_LABEL)
          return
        }
        const slot = (await nativeAuth(host, context))[provider(host)]
        claustrum.assertHostSlotMatchesMode({
          mode: 'custody',
          auth: slot,
          provider: provider(host),
        })
        await writeNativeSlot(
          host,
          claustrum.custodyPlaceholder(provider(host)),
          context,
          'vault',
        )
        if (needsOpenCode2) nativeNextStep(OPENCODE2_VAULT_AUTH_LABEL)
      } else {
        // Pi's existing slot editor moves the original login to its private stash.
        // Serving sees only the non-secret marker, never simultaneous local/vault credentials.
        const { openPiSlot } = await loadCommonAuthPiSlot()
        await assertSetupHostsStopped()
        await openPiSlot({
          authPath: nativeAuthPath(host, context),
          stashPath: join(piDir, 'google-login-stash.json'),
          provider: ANTIGRAVITY_PROVIDER_ID,
          placeholderKey: PI_PLACEHOLDER_KEY,
        }).enterVault()
      }
    },
    migrate: async (host, context) => {
      if (context.mode === 'local') await assertLocal(host, context)
      else if ((await authority(host)) !== 'vault')
        throw new Error('Vault access must remain approved during setup.')
      if (host === 'opencode') {
        // Vault activation must not import dormant local credentials into a store.
        const current = await authority(host)
        if (context.mode === 'claustrum') {
          if (current !== 'vault')
            throw new Error('Vault access must remain approved during setup.')
          return
        }
        if (current === 'unreadable')
          throw new Error(
            'Vault enrollment is unreadable; account migration was not started.',
          )
        if (current !== 'local')
          throw new Error(
            'Vault enrollment changed during setup; account migration was not started.',
          )
        const source = await deps.accountStore.read(
          deps.accountStore.legacyPath(),
        )
        if (source.kind === 'unavailable') throw new Error(source.reason)
        if (source.kind !== 'legacy') {
          deps.stdout.write(
            source.kind === 'store'
              ? 'Accounts already migrated.\n'
              : 'No accounts to migrate.\n',
          )
          return
        }
        if ((await migrateOpenCode()) !== 0)
          throw new Error('Offline Antigravity account migration failed.')
      } else {
        deps.stdout.write(
          'Pi uses its native auth.json; no Antigravity account-pool migration is needed.\n',
        )
      }
    },
  }
}

/** CLI-only entry: importing setup must never add the vault client to a renderer graph. */
export async function runPluginSetup(
  argv: string[],
  deps: CliDependencies,
  migrateOpenCode: () => Promise<number>,
  io: SetupIO = {},
): Promise<void> {
  const plugin = await createSetupPlugin(
    deps,
    migrateOpenCode,
    argv.includes('--login'),
  )
  await runSetup(plugin, argv, io)
}
