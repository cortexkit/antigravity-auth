import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  type AccountMigrationModules,
  createAccountMigrationFactory,
  createAccountRollbackFactory,
  decodeAccountMigrationJournal,
  initializeFreshAccountStore,
  type MigrationPoolStore,
  resolvePublishedAccountStorePaths,
} from '../../packages/core/src/account-migration.ts'
import {
  encodeProviderState,
  isValidProviderState,
  providerStateCredentialBound,
  QUOTA_CODEC,
} from '../../packages/core/src/account-repository-codecs.ts'

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const INPUT_ROOT = join(
  PROJECT_ROOT,
  '.cortexkit/parent-inputs/common-auth-0114-public-current',
)
const INPUT_MANIFEST_SHA256 =
  'e40b2d3e89391c5728dcaeac45d083dc2114b55350ec0a4c5276d0ff7d538e7c'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('fixture object required')
  return value as Record<string, unknown>
}
function sha(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex')
}
async function regularBytes(path: string): Promise<Buffer> {
  const stat = await lstat(path)
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    (await realpath(dirname(path))) !== dirname(path)
  )
    throw new Error('fixture refuses symlink or nonregular input')
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = await fd.stat()
    if (stat.ino !== opened.ino || stat.dev !== opened.dev)
      throw new Error('fixture input inode changed')
    return await fd.readFile()
  } finally {
    await fd.close()
  }
}

export interface FixturePoolStore extends MigrationPoolStore {
  /** Real public rotate writes a newer current token, which rollback must export instead of reviving the original backup token. */
  rotate(
    id: string,
    credential: {
      type: 'oauth'
      refresh: string
      access?: string
      expires?: number
    },
  ): Promise<{ id: string }>
  replace(
    id: string,
    credential: { type: 'oauth'; refresh: string },
    input?: { providerState?: unknown },
  ): Promise<{ id: string; credentialEpoch: number }>
}
export type FixtureModules = Omit<AccountMigrationModules, 'store'> & {
  store: Omit<AccountMigrationModules['store'], 'openPoolStore'> & {
    openPoolStore(
      options: Parameters<AccountMigrationModules['store']['openPoolStore']>[0],
    ): FixturePoolStore
  }
}
export interface MigrationFixtureInputs {
  publicRoot: string
  oldDistRoot?: string
}
/** Accepts only the common-auth publication fixture root and the separately pinned old-writer dist root from the gate environment. */
export function migrationFixtureInputs(
  environment: NodeJS.ProcessEnv,
): MigrationFixtureInputs {
  if (environment.ACCOUNT_MIGRATION_PUBLIC_INPUT_ROOT !== INPUT_ROOT)
    throw new Error('explicit worktree-local public package fixture required')
  const oldDistRoot = environment.ACCOUNT_MIGRATION_OLD_DIST_ROOT
  if (
    oldDistRoot !== undefined &&
    oldDistRoot !== join(PROJECT_ROOT, 'packages/core/dist')
  )
    throw new Error('old writer fixture location differs')
  return {
    publicRoot: INPUT_ROOT,
    ...(oldDistRoot === undefined ? {} : { oldDistRoot }),
  }
}
export const MIGRATION_SOURCE = {
  version: 4,
  activeIndex: 7,
  activeIndexByFamily: { claude: 0, gemini: 7, future: null },
  future: { retained: [null, false] },
  accounts: [
    {
      refreshToken: 'synthetic-first-refresh',
      email: 'exact-A',
      projectId: 'first-project',
      managedProjectId: null,
      addedAt: 1,
      lastUsed: 2,
      label: null,
      lastSwitchReason: 'rotation',
      rateLimitResetTimes: { dynamic: 123, claude: null },
      coolingDownUntil: null,
      cooldownReason: 'network-error',
      cachedQuota: {
        group: {
          remainingFraction: null,
          modelCount: 2,
          resetTime: 'raw',
          windows: [],
        },
      },
      cachedPerModelQuota: [
        {
          modelId: 'model',
          group: null,
          remainingFraction: 0.123456,
          displayName: null,
        },
      ],
      cachedQuotaAccountId: null,
      cachedQuotaUpdatedAt: 10,
      capturedTierId: 'raw-tier',
      capturedPaidTierId: null,
      capturedTierAt: 4,
      capturedTierSchemaVersion: 1,
      dailyRequestCounts: { date: '2000-01-01', claude: 7, gemini: 8 },
      verificationRequired: null,
      accountIneligible: false,
      future: { nested: [null, {}] },
    },
    {
      refreshToken: 'synthetic-second-refresh',
      email: null,
      addedAt: 3,
      lastUsed: 4,
      enabled: false,
      fingerprint: null,
      fingerprintHistory: [],
      verificationRequired: false,
      verificationRequiredAt: null,
      verificationRequiredReason: '',
      verificationUrl: null,
      accountIneligibleAt: null,
      accountIneligibleReason: '',
      eligibilityStateUpdatedAt: null,
      cachedQuota: null,
      cachedPerModelQuota: [],
    },
  ],
}
export async function loadOldMigrationWriter(
  inputs: MigrationFixtureInputs,
): Promise<
  Pick<
    typeof import('../../packages/core/src/account-storage.ts'),
    | 'loadAccountStorage'
    | 'saveAccountStorage'
    | 'saveAccountStorageReplace'
    | 'clearAccountStorage'
  >
> {
  const root = join(PROJECT_ROOT, 'packages/core/dist')
  if (inputs.oldDistRoot !== root)
    throw new Error('explicit prepared baseline old-writer build required')
  const entry = join(root, 'account-storage.js')
  if (
    sha(await regularBytes(entry)) !==
    '5346976e87486ca3496881d5f9e16cc71039a205c39aea39228965fc2dc767c1'
  )
    throw new Error('old writer entry is not the admitted baseline build')
  const module: unknown = await import(pathToFileURL(entry).href)
  const loaded = record(module)
  for (const key of [
    'loadAccountStorage',
    'saveAccountStorage',
    'saveAccountStorageReplace',
    'clearAccountStorage',
  ])
    if (typeof loaded[key] !== 'function')
      throw new Error('baseline old writer API differs')
  // This pinned legacy-writer build predates canonical pointer/journal retirement
  // refusal. Its source SHA256 is f210df44f53ae605fa29b05aaf03a63c83e2fd80d00a34ce15d6cc5e31f664ac.
  // It tests old writers only, not supported common-auth package export resolution.
  return module as Pick<
    typeof import('../../packages/core/src/account-storage.ts'),
    | 'loadAccountStorage'
    | 'saveAccountStorage'
    | 'saveAccountStorageReplace'
    | 'clearAccountStorage'
  >
}

/** Checks every common-auth package payload against its recorded bytes/SHA256 before copying it unchanged into the owned local consumer. */
export async function preparePublicMigrationConsumer(
  fixture: MigrationFixture,
  inputs: MigrationFixtureInputs,
  reuseVerified = false,
): Promise<PublicMigrationConsumer> {
  if (
    inputs.publicRoot !== INPUT_ROOT ||
    (await realpath(INPUT_ROOT)) !== INPUT_ROOT
  )
    throw new Error('public fixture location differs')
  await assertFixtureOwner(fixture)
  const manifestBytes = await regularBytes(
    join(INPUT_ROOT, 'copy-manifest.json'),
  )
  if (sha(manifestBytes) !== INPUT_MANIFEST_SHA256)
    throw new Error('public input manifest identity differs')
  const manifest = record(JSON.parse(manifestBytes.toString('utf8')))
  if (!Array.isArray(manifest.rows) || manifest.version !== '0.11.4')
    throw new Error('public input manifest rows/version missing')
  const consumerDir = join(fixture.root, 'public-consumer')
  const packageRoot = join(consumerDir, 'node_modules/@cortexkit/common-auth')
  if (!reuseVerified) {
    await mkdir(consumerDir, { mode: 0o700 })
    await mkdir(packageRoot, { mode: 0o700, recursive: true })
  }
  let files = 0
  let bytes = 0
  let packageManifest: Record<string, unknown> | undefined
  for (const entry of manifest.rows) {
    const row = record(entry)
    if (typeof row.path !== 'string')
      throw new Error('public payload path missing')
    const source = join(INPUT_ROOT, 'package', row.path)
    if (!source.startsWith(`${INPUT_ROOT}${sep}`) || source !== resolve(source))
      throw new Error('public input path escapes fixture root')
    const payload = await regularBytes(source)
    if (payload.length !== row.bytes || sha(payload) !== row.sha256)
      throw new Error('public payload byte identity differs')
    const relative = row.path
    const destination = join(packageRoot, relative)
    if (
      !destination.startsWith(`${packageRoot}${sep}`) ||
      destination !== resolve(destination)
    )
      throw new Error('consumer package path escapes fixture root')
    if (!reuseVerified) {
      await mkdir(dirname(destination), { mode: 0o700, recursive: true })
      await writeFile(destination, payload, { mode: 0o600, flag: 'wx' })
    }
    if (sha(await regularBytes(destination)) !== row.sha256)
      throw new Error('consumer package copy differs')
    if (relative === 'package.json')
      packageManifest = record(JSON.parse(payload.toString('utf8')))
    files++
    bytes += payload.length
  }
  if (
    files !== 175 ||
    bytes !== 819855 ||
    packageManifest?.name !== '@cortexkit/common-auth' ||
    packageManifest.version !== '0.11.4'
  )
    throw new Error('public package inventory differs')
  const exports = record(packageManifest.exports)
  const declared = (subpath: string, condition: 'import' | 'types') => {
    const value = record(exports[subpath])[condition]
    if (typeof value !== 'string' || !value.startsWith('./'))
      throw new Error('public export condition missing')
    const path = resolve(packageRoot, value)
    if (!path.startsWith(`${packageRoot}${sep}`))
      throw new Error('declared public export escapes package')
    return path
  }
  const consumerPath = join(consumerDir, 'consumer.mjs')
  const bridge = [
    'export function resolveEntries() {',
    "  return { store: import.meta.resolve('@cortexkit/common-auth/store'), fs: import.meta.resolve('@cortexkit/common-auth/fs') }",
    '}',
    'export async function importEntries() {',
    "  return { store: await import('@cortexkit/common-auth/store'), fs: await import('@cortexkit/common-auth/fs') }",
    '}',
  ].join('\n')
  if (reuseVerified) {
    if ((await regularBytes(consumerPath)).toString('utf8') !== bridge)
      throw new Error('prepared consumer bridge bytes differ')
  } else await writeFile(consumerPath, bridge, { mode: 0o600, flag: 'wx' })
  const declarationsPath = join(consumerDir, 'consumer.mts')
  const migrationTypes = relative(
    consumerDir,
    join(PROJECT_ROOT, 'packages/core/src/account-migration.ts'),
  )
    .split(sep)
    .join('/')
  const declarations = [
    "import * as store from '@cortexkit/common-auth/store'",
    "import * as fs from '@cortexkit/common-auth/fs'",
    `import type { AccountMigrationModules } from '${migrationTypes.startsWith('.') ? migrationTypes : `./${migrationTypes}`}'`,
    'export const modules: AccountMigrationModules = { store, fs }',
  ].join('\n')
  if (reuseVerified) {
    if (
      (await regularBytes(declarationsPath)).toString('utf8') !== declarations
    )
      throw new Error('prepared declaration consumer bytes differ')
  } else
    await writeFile(declarationsPath, declarations, { mode: 0o600, flag: 'wx' })
  return {
    fixture,
    packageRoot,
    consumerPath,
    declarationsPath,
    expectedStore: declared('./store', 'import'),
    expectedFs: declared('./fs', 'import'),
    storeDeclarations: declared('./store', 'types'),
    fsDeclarations: declared('./fs', 'types'),
  }
}

export interface PublicMigrationConsumer {
  fixture: MigrationFixture
  packageRoot: string
  consumerPath: string
  declarationsPath: string
  expectedStore: string
  expectedFs: string
  storeDeclarations: string
  fsDeclarations: string
}
export function resolvedConsumerPath(value: string): string {
  if (value.startsWith('file:')) return fileURLToPath(value)
  if (isAbsolute(value)) return value
  throw new Error('public resolver did not return a file location')
}
interface ConsumerNamespace {
  resolveEntries(): { store: string; fs: string }
  importEntries(): Promise<{ store: unknown; fs: unknown }>
}
async function consumerNamespace(
  consumer: PublicMigrationConsumer,
): Promise<ConsumerNamespace> {
  await assertFixtureOwner(consumer.fixture)
  const namespace: unknown = await import(
    pathToFileURL(consumer.consumerPath).href
  )
  if (
    typeof record(namespace).resolveEntries !== 'function' ||
    typeof record(namespace).importEntries !== 'function'
  )
    throw new Error('owned consumer exports differ')
  return namespace as ConsumerNamespace
}
/** Resolves @cortexkit/common-auth/store and /fs package exports before execution and requires both to remain inside the verified package. */
export async function resolvePublicMigrationConsumer(
  consumer: PublicMigrationConsumer,
): Promise<{ store: string; fs: string }> {
  const namespace = await consumerNamespace(consumer)
  const paths = namespace.resolveEntries()
  for (const [resolved, expected] of [
    [paths.store, consumer.expectedStore],
    [paths.fs, consumer.expectedFs],
  ]) {
    if (resolved === undefined || expected === undefined)
      throw new Error('public entry resolution pair missing')
    const path = resolvedConsumerPath(resolved)
    if (
      path !== expected ||
      (await realpath(path)) !== expected ||
      !path.startsWith(`${consumer.packageRoot}${sep}`)
    )
      throw new Error(
        'supported public export resolution differs from the verified package',
      )
    await regularBytes(path)
  }
  await regularBytes(consumer.storeDeclarations)
  await regularBytes(consumer.fsDeclarations)
  return paths
}
/** Loads only supported package specifiers, never private dist file URLs. */
export async function loadPublicMigrationModules(
  fixture: MigrationFixture,
  inputs: MigrationFixtureInputs,
): Promise<FixtureModules> {
  const consumer = await preparePublicMigrationConsumer(
    fixture,
    inputs,
    import.meta.main && process.argv[2] === '--child',
  )
  await resolvePublicMigrationConsumer(consumer)
  const { store, fs } = await (
    await consumerNamespace(consumer)
  ).importEntries()
  if (
    typeof record(store).openPoolStore !== 'function' ||
    typeof record(store).PoolOperationError !== 'function' ||
    [
      'withLock',
      'lockPathFor',
      'writeJsonAtomic',
      'LockContentionError',
      'LockOwnershipError',
    ].some((key) => typeof record(fs)[key] !== 'function')
  )
    throw new Error('public entry exports differ')
  // Native package export resolution and unchanged verified bytes establish the
  // runtime store/fs namespaces; the genuine declaration-assignment consumer
  // separately checks their TypeScript interface compatibility.
  return {
    store: store as FixtureModules['store'],
    fs: fs as FixtureModules['fs'],
  }
}

export async function assertDisposableChildRoot(
  root: string,
  nonce: string,
  parentPid: number,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  if (
    !UUID.test(nonce) ||
    !/^agy-migration-[A-Za-z0-9]+$/.test(basename(root)) ||
    (await realpath(root)) !== root
  )
    throw new Error('child refuses a non-disposable root')
  const owner = record(
    JSON.parse(
      (await regularBytes(join(root, '.fixture-owner.json'))).toString('utf8'),
    ),
  )
  if (
    owner.nonce !== nonce ||
    owner.parentPid !== parentPid ||
    owner.temporaryParent !== dirname(root) ||
    (await realpath(dirname(root))) !== dirname(root)
  )
    throw new Error('child fixture ownership differs')
  if (parentPid === process.pid && dirname(root) !== (await realpath(tmpdir())))
    throw new Error('child refuses a non-disposable root')
  const expected = migrationChildEnvironment(
    {
      root,
      nonce,
      ownerPid: parentPid,
      legacyPath: join(root, 'accounts.json'),
    },
    migrationFixtureInputs(environment),
  )
  for (const [key, path] of Object.entries(expected))
    if (environment[key] !== path)
      throw new Error(`child refuses unisolated ${key}`)
  for (const key of Object.keys(environment)) {
    if (Object.hasOwn(expected, key)) continue
    if (key === 'NODE_CHANNEL_FD' && /^\d+$/.test(environment[key] ?? ''))
      continue
    if (
      key === 'NODE_CHANNEL_SERIALIZATION_MODE' &&
      environment[key] === 'json'
    )
      continue
    throw new Error(`child refuses unexpected environment key ${key}`)
  }
}
export interface MigrationFixture {
  root: string
  nonce: string
  ownerPid: number
  legacyPath: string
  cleanupBlocked?: string
}
export function migrationChildEnvironment(
  fixture: MigrationFixture,
  inputs: MigrationFixtureInputs,
): NodeJS.ProcessEnv {
  if (
    inputs.publicRoot !== INPUT_ROOT ||
    (inputs.oldDistRoot !== undefined &&
      inputs.oldDistRoot !== join(PROJECT_ROOT, 'packages/core/dist'))
  )
    throw new Error('child fixture input location differs')
  const root = fixture.root
  return {
    HOME: join(root, 'home'),
    USERPROFILE: join(root, 'home'),
    TMPDIR: join(root, 'tmp'),
    TMP: join(root, 'tmp'),
    TEMP: join(root, 'tmp'),
    APPDATA: join(root, 'appdata'),
    LOCALAPPDATA: join(root, 'localappdata'),
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_CACHE_HOME: join(root, 'cache'),
    XDG_STATE_HOME: join(root, 'state'),
    XDG_DATA_HOME: join(root, 'data'),
    PI_AGENT_DIR: join(root, 'pi'),
    OPENCODE_CONFIG_DIR: join(root, 'opencode'),
    OPENCODE_DB: join(root, 'opencode.db'),
    ACCOUNT_MIGRATION_PUBLIC_INPUT_ROOT: inputs.publicRoot,
    ...(inputs.oldDistRoot === undefined
      ? {}
      : { ACCOUNT_MIGRATION_OLD_DIST_ROOT: inputs.oldDistRoot }),
    LANG: 'C',
    LC_ALL: 'C',
    TZ: 'UTC',
    NO_COLOR: '1',
  }
}
async function assertFixtureOwner(fixture: MigrationFixture): Promise<void> {
  if (
    (await realpath(fixture.root)) !== fixture.root ||
    !/^agy-migration-[A-Za-z0-9]+$/.test(basename(fixture.root))
  )
    throw new Error('fixture root is not the owned temporary directory')
  const owner = record(
    JSON.parse(
      (await regularBytes(join(fixture.root, '.fixture-owner.json'))).toString(
        'utf8',
      ),
    ),
  )
  const childOfOwner =
    import.meta.main &&
    process.argv[2] === '--child' &&
    fixture.ownerPid === process.ppid
  if (
    owner.nonce !== fixture.nonce ||
    owner.parentPid !== fixture.ownerPid ||
    owner.temporaryParent !== dirname(fixture.root) ||
    (fixture.ownerPid !== process.pid && !childOfOwner)
  )
    throw new Error('fixture ownership differs')
  if (
    fixture.ownerPid === process.pid &&
    dirname(fixture.root) !== (await realpath(tmpdir()))
  )
    throw new Error('fixture root is outside its allocating temporary parent')
}
export async function createMigrationFixture(
  source: unknown,
): Promise<MigrationFixture> {
  const root = await realpath(
    await mkdtemp(join(await realpath(tmpdir()), 'agy-migration-')),
  )
  const nonce = randomUUID()
  await writeFile(
    join(root, '.fixture-owner.json'),
    JSON.stringify({
      nonce,
      parentPid: process.pid,
      temporaryParent: dirname(root),
    }),
    { mode: 0o600, flag: 'wx' },
  )
  for (const name of [
    'home',
    'tmp',
    'appdata',
    'localappdata',
    'config',
    'cache',
    'state',
    'data',
    'pi',
    'opencode',
  ])
    await mkdir(join(root, name), { mode: 0o700 })
  const legacyPath = join(root, 'accounts.json')
  await writeFile(legacyPath, `${JSON.stringify(source, null, 2)}\n`, {
    mode: 0o600,
    flag: 'wx',
  })
  return { root, nonce, ownerPid: process.pid, legacyPath }
}
export async function removeMigrationFixture(
  fixture: MigrationFixture,
): Promise<void> {
  if (fixture.cleanupBlocked !== undefined)
    throw new Error(`fixture retained: ${fixture.cleanupBlocked}`)
  await assertFixtureOwner(fixture)
  await rm(fixture.root, { recursive: true })
}
export type MigrationFixtureFactory = (
  source?: unknown,
) => Promise<MigrationFixture>
/** Preserves the primary test error and every independent owned-fixture cleanup failure in the reported result. */
export async function withMigrationFixtures<T>(
  body: (create: MigrationFixtureFactory) => Promise<T>,
): Promise<T> {
  const owned: MigrationFixture[] = []
  const create: MigrationFixtureFactory = async (source = MIGRATION_SOURCE) => {
    const fixture = await createMigrationFixture(source)
    owned.push(fixture)
    return fixture
  }
  let result: { ok: true; value: T } | { ok: false; error: unknown }
  try {
    result = { ok: true, value: await body(create) }
  } catch (error) {
    result = { ok: false, error }
  }
  const cleanup: unknown[] = []
  for (const fixture of owned.reverse()) {
    try {
      await removeMigrationFixture(fixture)
    } catch (error) {
      cleanup.push(error)
    }
  }
  if (!result.ok) {
    if (cleanup.length)
      throw new AggregateError(
        [result.error, ...cleanup],
        'migration test and fixture cleanup both failed',
      )
    throw result.error
  }
  if (cleanup.length)
    throw new AggregateError(cleanup, 'migration fixture cleanup failed')
  return result.value
}
export interface ChildLockClaim {
  path: string
  ownerId: string
}
async function lockClaims(root: string): Promise<ChildLockClaim[]> {
  const claims: ChildLockClaim[] = []
  const pending: string[] = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (
      /^accounts\.json\.store\.[0-9a-f-]{36}\.generation$/.test(entry.name) &&
      entry.isDirectory()
    )
      pending.push(join(root, entry.name))
    if (entry.name.endsWith('.lock')) {
      const path = join(root, entry.name)
      const payload = record(
        JSON.parse((await regularBytes(path)).toString('utf8')),
      )
      if (typeof payload.ownerId !== 'string' || !UUID.test(payload.ownerId))
        throw new Error('child lock has no public owner ID')
      claims.push({ path, ownerId: payload.ownerId })
    }
  }
  let visited = 0
  while (pending.length) {
    const directory = pending.pop()
    if (!directory) break
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++visited > 128) throw new Error('bounded fixture inventory exceeded')
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink())
        throw new Error('child fixture contains symlink')
      if (entry.isDirectory()) pending.push(path)
      else if (entry.name.endsWith('.lock')) {
        const payload = record(
          JSON.parse((await regularBytes(path)).toString('utf8')),
        )
        if (typeof payload.ownerId !== 'string' || !UUID.test(payload.ownerId))
          throw new Error('child lock has no public owner ID')
        claims.push({ path, ownerId: payload.ownerId })
      }
    }
  }
  return claims
}
async function send(message: unknown): Promise<void> {
  if (!process.send) throw new Error('child requires owned IPC channel')
  await new Promise<void>((resolve, reject) =>
    process.send?.(message, undefined, undefined, (error: Error | null) =>
      error ? reject(error) : resolve(),
    ),
  )
}

async function runChild(): Promise<void> {
  const [flag, root, nonce, boundary, operation] = process.argv.slice(2)
  if (
    flag !== '--child' ||
    !root ||
    !nonce ||
    !boundary ||
    (operation !== 'migrate' &&
      operation !== 'rollback' &&
      operation !== 'initialize')
  )
    throw new Error('invalid migration child invocation')
  await assertDisposableChildRoot(root, nonce, process.ppid, process.env)
  await send({ kind: 'owned', nonce, pid: process.pid })
  const deadline = setTimeout(() => process.exit(75), 2500)
  try {
    const inputs = migrationFixtureInputs(process.env)
    const modules = await loadPublicMigrationModules(
      {
        root,
        nonce,
        ownerPid: process.ppid,
        legacyPath: join(root, 'accounts.json'),
      },
      inputs,
    )
    let seeded = false
    const onBoundary = async (point: string) => {
      if (
        !seeded &&
        point === 'before-build' &&
        (boundary.startsWith('public:reorder:') ||
          boundary.startsWith('public:enable:'))
      ) {
        seeded = true
        const paths = await resolvePublishedAccountStorePaths(
          join(root, 'accounts.json'),
        )
        if (!paths) throw new Error('seed has no published physical generation')
        const journal = decodeAccountMigrationJournal(
          JSON.parse(
            (await regularBytes(paths.migrationPath)).toString('utf8'),
          ),
        )
        const store = modules.store.openPoolStore({
          provider: 'antigravity',
          configPath: paths.configPath,
          statePath: paths.statePath,
          quota: QUOTA_CODEC,
          providerState: {
            validate: isValidProviderState,
            credentialBound: providerStateCredentialBound,
            merge: (_previous, incoming) => incoming,
            onReplace: () => undefined,
          },
          requireCredentialStamps: true,
          now: Date.now,
        })
        const indices = boundary.startsWith('public:reorder:')
          ? [...journal.mapping.keys()].reverse()
          : [...journal.mapping.keys()]
        for (const index of indices) {
          const mapped = journal.mapping[index]
          const row = journal.manifest.accounts[index]
          if (!mapped || !row) throw new Error('seed journal mapping absent')
          await store.add({
            id: mapped.id,
            credential: { type: 'oauth', refresh: row.refreshToken },
            providerState: encodeProviderState({
              schemaVersion: 1,
              metadata: row.metadata,
            }),
          })
        }
        if (boundary.startsWith('public:enable:')) {
          const firstMapping = journal.mapping[0]
          if (!firstMapping)
            throw new Error('seed journal first mapping absent')
          await store.disable(firstMapping.id, 'synthetic-restart-disable')
        }
      }
      if (point !== boundary) return
      await send({
        kind: 'crash',
        nonce,
        pid: process.pid,
        boundary: point,
        locks: await lockClaims(root),
      })
      // This fixture child exits after reporting its scoped lease references. The
      // parent signals only that direct child handle, never a guessed PID, group
      // or another test's process/locks; deletion also requires observed exit.
      process.exit(73)
    }
    const input = {
      legacyPath: join(root, 'accounts.json'),
      now: Date.now,
      onBoundary,
    }
    const result =
      operation === 'initialize'
        ? await initializeFreshAccountStore(modules, input)
        : await (operation === 'migrate'
            ? createAccountMigrationFactory(modules)
            : createAccountRollbackFactory(modules))({
            ...input,
            offline: { processesStopped: true },
          })
    await send({ kind: 'completed', nonce, pid: process.pid, result })
  } finally {
    clearTimeout(deadline)
  }
}

if (import.meta.main) {
  await runChild()
  process.disconnect?.()
  process.exit(0)
}
