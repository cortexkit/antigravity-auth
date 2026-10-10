import { randomUUID } from 'node:crypto'
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
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  inputPath,
  productionPin,
  readVerifiedArchive,
  sha256,
  validatePublication,
} from '../../../opencode/scripts/embed-common-auth.ts'

export const PUBLIC_CONSUMER_ENV = 'AGY_COMMON_AUTH_STORE_CONSUMER'
export const PUBLIC_CONSUMER_PROJECT_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../..',
)
const CONSUMER_PARENT = join(PUBLIC_CONSUMER_PROJECT_ROOT, 'node_modules')
const PREFIX = '.common-auth-public-consumer-'
const ARCHIVE_BYTES = 235492
const PACKAGE = '@cortexkit/common-auth'
const VERSION = '0.12.0'
const CONSUMER_MANIFEST = `${JSON.stringify({ name: 'common-auth-public-consumer', private: true, type: 'module' })}\n`
const publicEntrySource = (entry: 'store' | 'fs') =>
  `export * from '${PACKAGE}/${entry}'\n`

export async function publicFixtureBytes(path: string): Promise<Buffer> {
  const stat = await lstat(path)
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size > 16 * 1024 * 1024 ||
    (await realpath(dirname(path))) !== dirname(path)
  )
    throw new Error(
      'public fixture refuses symlink, oversized or nonregular input',
    )
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = await fd.stat()
    if (stat.ino !== opened.ino || stat.dev !== opened.dev)
      throw new Error('public fixture input inode changed')
    return await fd.readFile()
  } finally {
    await fd.close()
  }
}

export function requirePublicConsumerRoot(root: string | undefined): string {
  if (
    !root ||
    root !== resolve(root) ||
    dirname(root) !== CONSUMER_PARENT ||
    !root.startsWith(`${CONSUMER_PARENT}${sep}${PREFIX}`) ||
    !/^[a-zA-Z0-9]+$/.test(
      root.slice(`${CONSUMER_PARENT}${sep}${PREFIX}`.length),
    )
  )
    throw new Error('explicit worktree-local public package fixture required')
  return root
}

export async function admittedPublicArchive(): Promise<Map<string, Buffer>> {
  const compressed = await publicFixtureBytes(
    join(PUBLIC_CONSUMER_PROJECT_ROOT, inputPath),
  )
  return admitPublicArchiveBytes(compressed)
}

export function admitPublicArchiveBytes(
  compressed: Buffer,
): Map<string, Buffer> {
  if (compressed.length !== ARCHIVE_BYTES)
    throw new Error('public archive byte length differs')
  const entries = readVerifiedArchive(compressed, productionPin)
  validatePublication(entries)
  return entries
}

export function publicPackageReceipt(entries: ReadonlyMap<string, Buffer>) {
  return {
    name: PACKAGE,
    version: VERSION,
    archive: { path: inputPath, bytes: ARCHIVE_BYTES, ...productionPin },
    files: entries.size,
    payloadBytes: [...entries.values()].reduce(
      (n, bytes) => n + bytes.length,
      0,
    ),
    members: [...entries]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, bytes]) => ({
        path,
        bytes: bytes.length,
        sha256: sha256(bytes),
      })),
  }
}

async function packageInventory(
  directory: string,
  prefix = '',
): Promise<string[]> {
  if ((await realpath(directory)) !== directory)
    throw new Error('public package directory is not canonical')
  const paths: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = entry.name
    const path = join(directory, name)
    if (entry.isSymbolicLink())
      throw new Error('public package refuses symlink')
    if (entry.isDirectory())
      paths.push(...(await packageInventory(path, `${prefix}${name}/`)))
    else if (entry.isFile()) paths.push(`${prefix}${name}`)
    else throw new Error('public package refuses nonregular member')
  }
  return paths.sort()
}

export async function admitPublicConsumer(root: string) {
  requirePublicConsumerRoot(root)
  if ((await realpath(root)) !== root)
    throw new Error('public consumer root is not canonical')
  const owner = JSON.parse(
    (await publicFixtureBytes(join(root, '.owner.json'))).toString(),
  )
  if (
    owner.projectRoot !== PUBLIC_CONSUMER_PROJECT_ROOT ||
    owner.root !== root ||
    !Number.isSafeInteger(owner.pid) ||
    owner.pid <= 0 ||
    typeof owner.nonce !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      owner.nonce,
    )
  )
    throw new Error('public consumer ownership differs')
  const entries = await admittedPublicArchive()
  if (
    (await publicFixtureBytes(join(root, 'package.json'))).toString() !==
    CONSUMER_MANIFEST
  )
    throw new Error('public consumer manifest differs')
  for (const entry of ['store', 'fs'] as const)
    if (
      (
        await publicFixtureBytes(join(root, `${entry}-bridge.mjs`))
      ).toString() !== publicEntrySource(entry)
    )
      throw new Error(`public consumer entrypoint bytes differ: ${entry}`)
  const packageRoot = join(root, 'node_modules', PACKAGE)
  const expectedPaths = [...entries.keys()]
    .map((path) => path.slice('package/'.length))
    .sort()
  if (
    JSON.stringify(await packageInventory(packageRoot)) !==
    JSON.stringify(expectedPaths)
  )
    throw new Error('public package member inventory differs')
  const rows = [...entries]
  // Compare every payload before use, with at most eight open files at a time.
  // Bounded parallel reads avoid delaying child startup on serial filesystem calls.
  for (let start = 0; start < rows.length; start += 8) {
    await Promise.all(
      rows.slice(start, start + 8).map(async ([member, payload]) => {
        const actual = await publicFixtureBytes(
          join(packageRoot, member.slice('package/'.length)),
        )
        if (!actual.equals(payload))
          throw new Error(`public payload byte identity differs: ${member}`)
      }),
    )
  }
  const receipt = `${JSON.stringify(publicPackageReceipt(entries))}\n`
  if (
    (
      await publicFixtureBytes(join(root, 'public-package-receipt.json'))
    ).toString() !== receipt
  )
    throw new Error('public package receipt differs')
  const pkg = JSON.parse(
    (await publicFixtureBytes(join(packageRoot, 'package.json'))).toString(),
  )
  if (pkg.name !== PACKAGE || pkg.version !== VERSION)
    throw new Error('public package identity/version differs')
  return { entries, packageRoot, receipt: JSON.parse(receipt) }
}

export async function provisionPublicConsumer() {
  const entries = await admittedPublicArchive()
  if ((await realpath(CONSUMER_PARENT)) !== CONSUMER_PARENT)
    throw new Error('public consumer parent is not canonical')
  const root = await mkdtemp(join(CONSUMER_PARENT, PREFIX))
  const nonce = randomUUID()
  const owner = {
    root,
    projectRoot: PUBLIC_CONSUMER_PROJECT_ROOT,
    pid: process.pid,
    nonce,
  }
  await writeFile(join(root, '.owner.json'), JSON.stringify(owner), {
    mode: 0o600,
    flag: 'wx',
  })
  const remove = async () => {
    if (
      (await realpath(root)) !== root ||
      (await publicFixtureBytes(join(root, '.owner.json'))).toString() !==
        JSON.stringify(owner)
    )
      throw new Error('public consumer cleanup ownership differs')
    await rm(root, { recursive: true })
  }
  try {
    const packageRoot = join(root, 'node_modules', PACKAGE)
    for (const [member, payload] of entries) {
      const path = join(packageRoot, member.slice('package/'.length))
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      await writeFile(path, payload, { mode: 0o600, flag: 'wx' })
    }
    await writeFile(join(root, 'package.json'), CONSUMER_MANIFEST, {
      mode: 0o600,
      flag: 'wx',
    })
    // These consumer entrypoints use the publication's export map, not private dist paths.
    for (const entry of ['store', 'fs'] as const)
      await writeFile(
        join(root, `${entry}-bridge.mjs`),
        publicEntrySource(entry),
        { mode: 0o600, flag: 'wx' },
      )
    await writeFile(
      join(root, 'public-package-receipt.json'),
      `${JSON.stringify(publicPackageReceipt(entries))}\n`,
      { mode: 0o600, flag: 'wx' },
    )
    const admitted = await admitPublicConsumer(root)
    return { root, ...admitted, remove }
  } catch (error) {
    await remove()
    throw error
  }
}
