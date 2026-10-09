import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { sameRowRef } from '../../core/src/account-identity.ts'
import {
  createAccountMigrationFactory,
  readAccountStoreAdmission,
  resolvePublishedAccountStorePaths,
} from '../../core/src/account-migration.ts'
import { createAccountRepositoryFactory } from '../../core/src/account-repository.ts'
import type { AccountRepository } from '../../core/src/account-repository-types.ts'
import { loadCommonAuthStoreModules } from '../../core/src/common-auth-runtime.ts'
import * as protocol from '../../opencode/src/ga/rpc/protocol.ts'
import type { HarnessAccountsObservation } from '../../opencode/src/ga/server/index.ts'
import {
  MatrixSchema,
  PinSchema,
  validateMatrix,
} from '../docker/measure-ga-proxy-matrix.ts'
import {
  createGaProtocolClient,
  GA_CONTRACT_PATH,
  GA_PIN_PATH,
  type GaAccountObservation,
  type GaAccountRpcJoin,
  type GaCapturedMenuItem,
  type GaHarness,
  type GaHostIntegrationInputs,
  type GaMenu,
  type GaMenuSection,
  type GaMenuSlot,
  type GaOpenedMenu,
  type GaPaths,
  type GaSessionRef,
  gaDriverTypeFixture,
  gaObserverTypeFixtures,
  ownedPath,
  record,
  sha256,
} from './opencode-ga-harness.ts'

/**
 * Builds the inputs the GA host runner needs from the real modules: the RPC
 * protocol schemas, the public account store and filesystem modules, and the
 * production factory from the package installed under /opt/ga-consumer.
 */
export const GA_HOST_INPUT_MODULE =
  'packages/e2e-tests/src/opencode-ga-inputs.ts'
export const GA_HOST_INPUT_EXPORT = 'createGaHostIntegrationInputs'

function assertInput(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

export function matchSameReadObservation(
  state: protocol.AntigravityStateSnapshot,
  observations: readonly HarnessAccountsObservation[],
): HarnessAccountsObservation {
  const matches = observations.filter(
    (observation) =>
      observation.generation === state.generation &&
      observation.readSeq === state.readSeq,
  )
  assertInput(
    matches.length === 1,
    'Missing or ambiguous synchronous same-state-read account observation',
  )
  const observation = matches[0]
  assertInput(
    observation &&
      observation.status === 'ready' &&
      observation.accountsStatus === 'complete' &&
      state.accountsStatus.kind === 'complete',
    'Actual account read is pending/error/over-limit; no fabricated ready state',
  )
  const selectors = new Set(state.accounts.map((row) => row.selector))
  assertInput(
    observation.accounts.length === state.accounts.length &&
      observation.accounts.every((row) => selectors.has(row.selector)),
    'Observer and portable answer do not describe the same complete read',
  )
  return observation
}

export function normalizeSameReadState(
  state: protocol.AntigravityStateSnapshot,
  observation: HarnessAccountsObservation,
  sidebarPullMs: number,
): GaAccountObservation {
  assertInput(
    observation.generation === state.generation &&
      observation.readSeq === state.readSeq,
    'Account observation is not this exact state read',
  )
  assertInput(
    Number.isInteger(sidebarPullMs) && sidebarPullMs > 0,
    'Actual compiled GA sidebar pull interval is missing',
  )
  return {
    rows: state.accounts.map((row) => {
      const observed = observation.accounts.find(
        (candidate) => candidate.selector === row.selector,
      )
      assertInput(observed, 'SafeSelector has no same-read diagnostic row')
      return {
        label: row.label,
        publicId: row.id,
        selector: row.selector,
        enabled: row.enabled,
        current: row.current,
        metadataStatus: observed.metadataStatus,
        accessBlock: observed.accessBlock,
        verificationRequired:
          observed.accessBlock.kind === 'unknown' ||
          observed.accessBlock.kind === 'invalid'
            ? undefined
            : observed.accessBlock.kind === 'verification-required',
        accountIneligible:
          observed.accessBlock.kind === 'unknown' ||
          observed.accessBlock.kind === 'invalid'
            ? undefined
            : observed.accessBlock.kind === 'ineligible',
        reason:
          observed.accessBlock.kind === 'verification-required' ||
          observed.accessBlock.kind === 'ineligible'
            ? observed.accessBlock.reason
            : undefined,
        geminiRemaining: row.quota.gemini?.remainingPercent,
        nonGeminiRemaining: row.quota['non-gemini']?.remainingPercent,
      }
    }),
    routing: state.settings.routing.cliFirst
      ? 'cli_first'
      : 'antigravity_first',
    logging: state.settings.logLevel,
    dump: state.settings.dump,
    killswitch: state.settings.killswitch,
    sidebarPullMs,
  }
}

type GaMenuAction = GaMenuSection['actions'][number]
type GaMenuItem = GaMenuSection['items'][number]
type GaKnobValue = string | number | boolean

/** What an emitted action accepts: its knob ids and whether it asked for confirmation. */
export interface GaMenuActionShape {
  readonly knobs: ReadonlySet<string>
  readonly confirm: boolean
}

export function actionShape(action: GaMenuAction): GaMenuActionShape {
  return {
    knobs: new Set(action.knobs.map((knob) => knob.id)),
    confirm: action.confirm !== undefined,
  }
}

/**
 * The apply request for one emitted action. Values must name the action's
 * own knobs, and `confirmed` is sent only when the action asked for it, so a
 * request never carries anything the menu did not offer.
 */
export function menuRequest(
  sectionId: string,
  actionId: string,
  shape: GaMenuActionShape,
  values: Readonly<Record<string, GaKnobValue>> = {},
  itemId?: string,
): Omit<protocol.AntigravityMenuRequest, 'command'> {
  for (const knob of Object.keys(values))
    assertInput(shape.knobs.has(knob), `Action ${actionId} has no ${knob} knob`)
  return {
    sectionId,
    actionId,
    ...(itemId === undefined ? {} : { itemId }),
    ...(Object.keys(values).length === 0 ? {} : { values }),
    ...(shape.confirm ? { confirmed: true } : {}),
  }
}

/** The one section the menu emitted for `slot`. */
export function findMenuSection(menu: GaMenu, slot: GaMenuSlot): GaMenuSection {
  const sections = menu.sections.filter((section) => section.slot === slot)
  assertInput(sections.length === 1, `The menu has no single ${slot} section`)
  return sections[0] as GaMenuSection
}

/**
 * Picks the Accounts item for the account whose `acct-<n>` id is `publicId`.
 * Each state account carries a `selector`, an opaque value naming its current
 * credential. The state reads just before the command and just after its
 * menu arrived must list the same selectors in the same order: a selector
 * changes whenever its credential does, so the menu was built from that same
 * roster, and its items are in the same order as the state's accounts. The
 * `acct-<n>` id only chooses the row; the target is the item id the server
 * issued for that row's exact credential.
 */
export function captureMenuItem(
  opened: GaOpenedMenu,
  publicId: string,
): { target: GaCapturedMenuItem; item: GaMenuItem } {
  const { before, after, menu } = opened
  assertInput(
    before.accountsStatus.kind === 'complete' &&
      after.accountsStatus.kind === 'complete',
    'Account roster is not complete around the menu read',
  )
  const selectors = (snapshot: protocol.AntigravityStateSnapshot) =>
    snapshot.accounts.map((row) => row.selector).join('\0')
  assertInput(
    before.generation === after.generation &&
      selectors(before) === selectors(after),
    'Accounts changed while the menu was built; its items cannot be matched to state rows',
  )
  const position = after.accounts.findIndex((row) => row.id === publicId)
  const row = after.accounts[position]
  assertInput(row, 'State has no account with the requested redacted id')
  const section = findMenuSection(menu, 'accounts')
  assertInput(
    section.items.length === after.accounts.length &&
      section.items.every(
        (item, index) => item.label === after.accounts[index]?.label,
      ),
    'Menu account items do not line up with the state roster',
  )
  const item = section.items[position] as GaMenuItem
  const target: GaCapturedMenuItem = Object.freeze({
    generation: after.generation,
    sectionId: section.id,
    itemId: item.id,
    selector: row.selector,
    sectionTitle: section.title,
    itemLabel: item.label,
    actions: Object.freeze(item.actions.map((action) => action.id)),
    actionLabels: Object.freeze(
      Object.fromEntries(
        item.actions.map((action) => [action.id, action.label]),
      ),
    ),
  })
  return { target, item }
}

/**
 * Id of the account-item action that sets one account's minimum remaining
 * quota (its floor), in the menu built by createAntigravityCommandMenu.
 */
export const GA_ACCOUNT_FLOOR_ACTION = 'limit'

/**
 * The per-account killswitch override is the floor action the menu emits on
 * the account's own item. Its number knob must share its id with the Limits
 * section's global threshold knob, so both set the same kind of floor. When
 * the item has no such action (the host supplied no per-account floor
 * source) this throws, and the case reports missing evidence. No override
 * key is ever derived from a token.
 */
export function findAccountOverrideAction(
  menu: GaMenu,
  item: GaMenuItem,
): { actionId: string; knobId: string } {
  const limits = findMenuSection(menu, 'limits')
  const thresholds = new Set(
    limits.actions.flatMap((action) =>
      action.knobs
        .filter((knob) => knob.kind === 'number')
        .map((knob) => knob.id),
    ),
  )
  const action = item.actions.find(
    (candidate) => candidate.id === GA_ACCOUNT_FLOOR_ACTION,
  )
  const knobs =
    action?.knobs.filter(
      (knob) => knob.kind === 'number' && thresholds.has(knob.id),
    ) ?? []
  assertInput(
    action && knobs.length === 1,
    'Missing evidence: the menu emits no per-account quota floor action on the account item',
  )
  return { actionId: action.id, knobId: (knobs[0] as { id: string }).id }
}

function accountObservers(harness: GaHarness): HarnessAccountsObservation[] {
  return harness
    .readWrapperEvents()
    .filter((event) => event.event === 'accounts.snapshot')
    .map((event) => {
      const value = event.observation
      assertInput(
        value && typeof value === 'object',
        'Malformed actual account observer record',
      )
      return value as HarnessAccountsObservation
    })
}

async function openOwnedRepository(paths: GaPaths): Promise<AccountRepository> {
  const legacyPath = join(paths.opencodeConfig, 'antigravity-accounts.json')
  ownedPath(paths.root, legacyPath)
  const modules = await loadCommonAuthStoreModules()
  const active = await resolvePublishedAccountStorePaths(legacyPath)
  assertInput(
    active,
    'Verified migration did not publish a current store generation',
  )
  for (const path of Object.values(active)) {
    assertInput(
      typeof path === 'string',
      'Current generation returned a malformed path',
    )
    ownedPath(paths.root, path)
  }
  const admitted = await readAccountStoreAdmission(
    legacyPath,
    modules,
    Date.now,
  )
  assertInput(
    admitted.status === 'active',
    'Current store generation is not actively admitted',
  )
  return createAccountRepositoryFactory(modules)({
    paths: active,
    now: Date.now,
    exchange: async ({ refreshToken }) => ({
      refreshToken,
      accessToken: `${refreshToken}-access`,
      expiresAt: Date.now() + 3600000,
    }),
  })
}

async function seedOwnedCurrentStore(
  paths: GaPaths,
  scenario: string,
): Promise<void> {
  const legacyPath = join(paths.opencodeConfig, 'antigravity-accounts.json')
  ownedPath(paths.root, legacyPath)
  assertInput(
    !existsSync(legacyPath),
    'Current-store fixture refuses pre-existing legacy/profile data',
  )
  const count =
    /validation|required|ineligible|quota-429|two-location|account|stale-handle/.test(
      scenario,
    )
      ? 2
      : 1
  // The old-format account file is only input to the offline migration; the
  // host serves only the store generation that migration publishes.
  writeFileSync(
    legacyPath,
    JSON.stringify({
      version: 4,
      accounts: ['A', 'B'].slice(0, count).map((label, index) => ({
        refreshToken: `synthetic-ga-refresh-${label}`,
        email: `synthetic-${label}@example.invalid`,
        label: `Synthetic fixture ${label}`,
        projectId: 'synthetic-ga-project',
        managedProjectId: 'synthetic-ga-project',
        enabled: true,
        addedAt: index + 1,
        lastUsed: 0,
        rateLimitResetTimes: {},
      })),
      activeIndex: 0,
      activeIndexByFamily: { claude: 0, gemini: 0 },
    }),
    { mode: 0o600, flag: 'wx' },
  )
  const modules = await loadCommonAuthStoreModules()
  const outcome = await createAccountMigrationFactory(modules)({
    legacyPath,
    offline: { processesStopped: true },
    now: Date.now,
  })
  assertInput(
    outcome.status === 'completed',
    'Real owned migration did not complete',
  )
  assertInput(
    !existsSync(legacyPath),
    'Legacy fixture remained live after current-store activation',
  )
  const repository = await openOwnedRepository(paths)
  try {
    const read = await repository.read()
    assertInput(
      read.status === 'ready' &&
        read.rows.length === count &&
        read.rows.every((row) => row.usable),
      'Actual current repository did not admit the complete fixture roster',
    )
    // Both reauthorization cases need account A blocked the way a Google
    // verification answer leaves it, so its own Reauthorize action is used.
    if (
      scenario === 'pty-reauthorize-listener' ||
      scenario === 'pty-two-location-oauth-bearer'
    ) {
      const target = read.rows[0]
      assertInput(
        target,
        'Owned reauthorization fixture has no exact repository target',
      )
      await repository.recordAccessVerdict(target.ref, {
        kind: 'verification-required',
        observedAt: Date.now(),
        reason: 'VALIDATION_REQUIRED',
      })
      const blocked = await repository.read()
      assertInput(
        blocked.status === 'ready' &&
          blocked.rows.some(
            (row) => sameRowRef(row.ref, target.ref) && !row.enabled,
          ),
        'Actual repository did not establish the required reauthorization block',
      )
    }
  } finally {
    await repository.dispose()
  }
}

function pullMsFromActualCompiledArm(prefix: string): number {
  const entry = join(
    prefix,
    'node_modules',
    '@cortexkit',
    'opencode-antigravity-auth',
    'src',
    'tui-compiled',
    'ga',
    'ga',
    'tui',
    'host-ga.tsx',
  )
  assertInput(existsSync(entry), 'Actual packed compiled GA TUI arm is missing')
  const source = readFileSync(entry, 'utf8')
  const match = /(?:const|let|var)\s+GA_SIDEBAR_PULL_MS\s*=\s*(\d+)/.exec(
    source,
  )
  assertInput(
    match?.[1],
    'Compiled TUI does not expose the actual GA_SIDEBAR_PULL_MS binding',
  )
  return Number(match[1])
}

/**
 * Called only by the GA host runner (run-opencode-ga-test.sh inside the
 * container). Nothing is imported and no store is touched until it runs.
 */
export async function createGaHostIntegrationInputs(): Promise<GaHostIntegrationInputs> {
  assertInput(
    process.env.ANTIGRAVITY_GA_HOST_EXECUTION === '1',
    'GA integration inputs require explicit owned host admission',
  )
  const prefix = '/opt/ga-consumer'
  const packageRoot = join(
    prefix,
    'node_modules',
    '@cortexkit',
    'opencode-antigravity-auth',
  )
  const manifest = record(
    JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')),
  )
  const exportsMap = record(manifest.exports)
  assertInput(
    exportsMap['./server'],
    'Actual installed package has no public ./server export',
  )
  const require = createRequire(join(prefix, 'package.json'))
  const entry = require.resolve('@cortexkit/opencode-antigravity-auth/server')
  assertInput(
    entry.startsWith(`${packageRoot}/`) &&
      !entry.startsWith(`${resolve('.')}/`),
    'Production factory resolved to the repository instead of the installed pack',
  )
  const actual: unknown = await import(pathToFileURL(entry).href)
  assertInput(
    typeof record(actual).createGaAntigravityPlugin === 'function',
    'Actual packed named production factory is absent',
  )
  const pullMs = pullMsFromActualCompiledArm(prefix)
  const clients = new Map<string, ReturnType<typeof createGaProtocolClient>>()
  const client = (harness: GaHarness) => {
    let instance = clients.get(harness.host.url)
    if (!instance) {
      instance = createGaProtocolClient(protocol, harness.host.url)
      clients.set(harness.host.url, instance)
    }
    return instance
  }
  const nativeCommand = (harness: GaHarness, session: GaSessionRef) => () =>
    harness.native.command(session, protocol.ANTIGRAVITY_MENU_COMMAND_NAME)
  // What each captured item's emitted actions required, kept here so a later
  // apply can only send an action, knob or confirmation the menu offered.
  const capturedActions = new WeakMap<
    GaCapturedMenuItem,
    ReadonlyMap<string, GaMenuActionShape>
  >()
  const capture = async (
    harness: GaHarness,
    session: GaSessionRef,
    publicId: string,
    alreadyOpened?: GaOpenedMenu,
  ) => {
    const opened =
      alreadyOpened ??
      (await client(harness).openMenu(session, nativeCommand(harness, session)))
    const { target, item } = captureMenuItem(opened, publicId)
    capturedActions.set(
      target,
      new Map(item.actions.map((action) => [action.id, actionShape(action)])),
    )
    return { opened, target, item }
  }
  const accounts: GaAccountRpcJoin = {
    seedCurrentStore: (paths, scenario) =>
      seedOwnedCurrentStore(paths, scenario),
    async assertCurrentStoreInput(paths) {
      const repository = await openOwnedRepository(paths)
      try {
        assertInput(
          (await repository.read()).status === 'ready',
          'Current store is not ready',
        )
      } finally {
        await repository.dispose()
      }
    },
    async snapshot(harness, session) {
      const result = await client(harness).state(session)
      return normalizeSameReadState(
        result.snapshot,
        matchSameReadObservation(result.snapshot, accountObservers(harness)),
        pullMs,
      )
    },
    async openMenu(harness, session, runCommand) {
      return client(harness).openMenu(
        session,
        runCommand ?? nativeCommand(harness, session),
      )
    },
    async captureTarget(harness, session, publicId, opened) {
      return (await capture(harness, session, publicId, opened)).target
    },
    async captureKillswitchOverride(harness, session, publicId) {
      const { opened, target, item } = await capture(harness, session, publicId)
      const override = Object.freeze({
        ...target,
        ...findAccountOverrideAction(opened.menu, item),
      })
      const shapes = capturedActions.get(target)
      assertInput(shapes, 'Captured item lost its emitted actions')
      capturedActions.set(override, shapes)
      return override
    },
    async applyCapturedTarget(harness, session, action, target, values) {
      const known = capturedActions.get(target)
      assertInput(known, 'Target was not captured from a menu this join opened')
      const shape = known.get(action)
      assertInput(
        shape,
        `The captured menu item did not offer action ${action}`,
      )
      const current = (await client(harness).state(session)).snapshot
      assertInput(
        current.generation === target.generation,
        'The activation changed since the item was captured',
      )
      const result = await client(harness).apply(
        session,
        menuRequest(target.sectionId, action, shape, values, target.itemId),
      )
      return Object.freeze({
        ok: result.ok,
        text: result.text,
        ...(result.code === undefined ? {} : { code: result.code }),
      })
    },
    async applyMenuAction(harness, session, slot, actionId, values) {
      const opened = await client(harness).openMenu(
        session,
        nativeCommand(harness, session),
      )
      const section = findMenuSection(opened.menu, slot)
      const action = section.actions.find(
        (candidate) => candidate.id === actionId,
      )
      assertInput(action, `The ${slot} section offered no ${actionId} action`)
      const result = await client(harness).apply(
        session,
        menuRequest(section.id, actionId, actionShape(action), values),
      )
      assertInput(
        result.ok,
        `Menu action ${slot}/${actionId} was refused: ${result.code ?? result.text}`,
      )
    },
    async assertNoPortOrSidebarFiles(harness) {
      const visit = (directory: string) => {
        for (const name of readdirSync(directory, { withFileTypes: true })) {
          const path = join(directory, name.name)
          if (name.isDirectory()) visit(path)
          else
            assertInput(
              !/^port-.*\.json$/.test(name.name) &&
                name.name !== 'sidebar.json',
              'GA wrote a legacy port/sidebar file',
            )
        }
      }
      visit(harness.paths.root)
    },
  }
  return {
    protocol,
    accounts,
    async verifyConsumerBindings(out) {
      ownedPath(resolve(out), join(out, 'consumer-bindings'))
      // Compiles a consumer against the installed package's declarations in a
      // real tsc subprocess; generated text or an import alone proves nothing.
      await runActualConsumerBindingGate(out, prefix)
    },
    async verifyNativeMatrix(repoRoot, pin) {
      await verifyActualNativeMatrix(repoRoot, pin.binarySha256)
    },
    async jobOwnershipSupplement(id, harness) {
      await runActualOwnershipSupplement(id, harness)
    },
  }
}

async function runActualConsumerBindingGate(
  out: string,
  prefix: string,
): Promise<void> {
  const root = mkdtempSync(join(out, 'actual-consumer-types-'))
  const positive = join(root, 'positive.ts')
  const negative = join(root, 'async-observer.ts')
  const fixtures = gaObserverTypeFixtures()
  writeFileSync(positive, `${fixtures.synchronous}\n${gaDriverTypeFixture()}`, {
    mode: 0o600,
  })
  writeFileSync(negative, fixtures.asynchronous, { mode: 0o600 })
  const repo = resolve('.')
  const compiler = join(repo, 'node_modules', 'typescript', 'bin', 'tsc')
  assertInput(
    existsSync(compiler),
    'Pinned repository TypeScript compiler is absent',
  )
  const common = {
    compilerOptions: {
      target: 'ES2023',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      skipLibCheck: false,
      noEmit: true,
      types: ['node', 'bun'],
      lib: ['ES2023', 'DOM', 'DOM.Iterable'],
      typeRoots: [join(repo, 'node_modules', '@types')],
      paths: {
        '@cortexkit/opencode-antigravity-auth/server': [
          join(
            prefix,
            'node_modules',
            '@cortexkit',
            'opencode-antigravity-auth',
            'dist',
            'server.d.ts',
          ),
        ],
        '@opencode/*': [join(repo, 'node_modules', '@opencode', '*')],
        '@opencode-ai/*': [join(repo, 'node_modules', '@opencode-ai', '*')],
        '@opentui/core': [
          join(repo, 'packages', 'opencode', 'node_modules', 'ga-opentui-core'),
        ],
        '@opentui/solid': [
          join(
            repo,
            'packages',
            'opencode',
            'node_modules',
            'ga-opentui-solid',
          ),
        ],
        'solid-js': [
          join(repo, 'packages', 'opencode', 'node_modules', 'ga-solid-js'),
        ],
        'solid-js/*': [
          join(
            repo,
            'packages',
            'opencode',
            'node_modules',
            'ga-solid-js',
            '*',
          ),
        ],
      },
    },
  }
  const env = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: root, TMPDIR: root }
  const invoke = (file: string, name: string) => {
    const config = join(root, `${name}.json`)
    writeFileSync(config, JSON.stringify({ ...common, files: [file] }))
    return execFileSync(
      '/usr/local/bin/node',
      [compiler, '-p', config, '--pretty', 'false'],
      { cwd: root, env, encoding: 'utf8', timeout: 30_000 },
    )
  }
  invoke(positive, 'positive')
  let diagnostics = ''
  try {
    invoke(negative, 'negative')
  } catch (error) {
    const failure = record(error)
    diagnostics = String(failure.stdout ?? '')
  }
  const codes = [...diagnostics.matchAll(/error TS(\d+):/g)].map(
    (match) => match[1],
  )
  assertInput(
    codes.length === 1 && codes[0] === '2322',
    'Actual exposed async observer fixture did not produce exactly one TS2322',
  )
  writeFileSync(
    join(root, 'proof.json'),
    JSON.stringify({
      name: 'ga.raw-cancel.async-observer-rejected',
      actualPackedDeclarations: true,
      synchronousDiagnostics: 0,
      asynchronousDiagnostics: diagnostics,
      compilerVersion: execFileSync(
        '/usr/local/bin/node',
        [compiler, '--version'],
        { env, encoding: 'utf8' },
      ).trim(),
    }),
    { mode: 0o600 },
  )
}

async function verifyActualNativeMatrix(
  repoRoot: string,
  digest: string,
): Promise<void> {
  const pin = PinSchema.parse(
    JSON.parse(readFileSync(join(repoRoot, GA_PIN_PATH), 'utf8')),
  )
  assertInput(
    pin.binarySha256 === digest,
    'Native matrix/host pin digest mismatch',
  )
  const value: unknown = JSON.parse(
    readFileSync(
      join(repoRoot, 'packages/e2e-tests/docker/ga-proxy-env-matrix.json'),
      'utf8',
    ),
  )
  const matrix = validateMatrix(value, pin)
  assertInput(
    matrix.full && MatrixSchema.parse(value).binarySha256 === digest,
    'Native matrix is partial or belongs to another executable',
  )
  const provenance = record(
    JSON.parse(
      readFileSync(
        join(
          repoRoot,
          'packages/e2e-tests/docker/ga-proxy-env-matrix.provenance.json',
        ),
        'utf8',
      ),
    ),
  )
  assertInput(
    Object.keys(provenance).length > 0,
    'Native matrix lacks actual promotion provenance',
  )
  assertInput(
    existsSync(join(repoRoot, GA_CONTRACT_PATH)),
    'Tracked released-host contract is absent',
  )
}

async function runActualOwnershipSupplement(
  id: string,
  harness: GaHarness,
): Promise<void> {
  const field = id.replace('job-mismatch-', '')
  assertInput(
    ['location', 'origin', 'job', 'session', 'kind'].includes(field),
    'Unknown typed facade mismatch selector',
  )
  const file = resolve('packages/opencode/src/ga/server/boundary.test.ts')
  assertInput(
    existsSync(file),
    'Actual facade-owned typed ownership supplement is absent',
  )
  const source = readFileSync(file, 'utf8')
  const matching = [...source.matchAll(/(?:test|it)\(\s*(['"])([^'"\n]+)\1/g)]
    .map((match) => String(match[2]))
    .filter((name) => name.includes(field) && /mismatch|foreign/i.test(name))
  assertInput(
    matching.length > 0,
    `Actual facade supplement has no declared ${field} ownership assertion`,
  )
  const root = harness.paths.root
  const env = {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: harness.paths.home,
    XDG_CONFIG_HOME: harness.paths.config,
    XDG_DATA_HOME: harness.paths.data,
    XDG_STATE_HOME: harness.paths.state,
    XDG_CACHE_HOME: harness.paths.cache,
    TMPDIR: harness.paths.temp,
    OPENCODE_DB: harness.paths.database,
    OPENCODE_CONFIG_DIR: harness.paths.opencodeConfig,
    ANTIGRAVITY_TEST_ROOT: root,
  }
  const output = execFileSync(
    '/usr/local/bin/bun',
    [
      'test',
      '--isolate',
      file,
      '-t',
      matching
        .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('|'),
    ],
    {
      cwd: resolve('.'),
      env,
      encoding: 'utf8',
      timeout: 30_000,
      stdio: 'pipe',
    },
  )
  assertInput(
    matching.every((name) => output.includes(name)) &&
      !/0 pass|0 tests|\(skip\)|\(fail\)/.test(output),
    'Facade supplement was absent/skipped/red instead of executed',
  )
  writeFileSync(
    join(root, 'typed-facade-supplement.json'),
    JSON.stringify({
      id,
      proof: 'typed-facade-supplement-not-native-host',
      sourceSha256: sha256(Buffer.from(source)),
      names: matching,
      output,
    }),
    { mode: 0o600 },
  )
}
