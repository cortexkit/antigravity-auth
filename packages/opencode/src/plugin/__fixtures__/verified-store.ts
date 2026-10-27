import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { loadCommonAuthStoreModules } from '@cortexkit/antigravity-auth-core'

const PIN = {
  package: '@cortexkit/common-auth',
  version: '0.28.0',
  tarballSha256:
    '8070e3c1882238d78ac5e955fb140484e08d9f97ed0f2d5d40f35928c60fbbc5',
} as const

async function filesBelow(root: string, dir: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`
    if (entry.isDirectory()) out.push(...(await filesBelow(root, path)))
    else out.push(path)
  }
  return out
}

/** Verify the published archive identity and every store/fs member before loading executable code. */
export async function loadVerifiedStoreModules() {
  const root = dirname(
    dirname(
      Bun.resolveSync(
        '@cortexkit/antigravity-auth-core/common-auth/store',
        import.meta.dir,
      ),
    ),
  )
  const receipt = JSON.parse(
    await readFile(join(root, 'source-output.json'), 'utf8'),
  ) as {
    package?: unknown
    version?: unknown
    artifactStatus?: unknown
    tarballSha256?: unknown
    files?: Array<{ output: string; bytes: number; outputSha256: string }>
  }
  if (
    receipt.package !== PIN.package ||
    receipt.version !== PIN.version ||
    receipt.artifactStatus !== 'published' ||
    receipt.tarballSha256 !== PIN.tarballSha256 ||
    !Array.isArray(receipt.files)
  ) {
    throw new Error(
      `the embedded common-auth receipt is not the pinned published ${PIN.version}`,
    )
  }
  const recorded = receipt.files.filter((file) =>
    /^(store|fs)\//.test(file.output),
  )
  const present = [
    ...(await filesBelow(root, 'store')),
    ...(await filesBelow(root, 'fs')),
  ].sort()
  if (
    JSON.stringify(present) !==
    JSON.stringify(recorded.map((file) => file.output).sort())
  ) {
    throw new Error('embedded store/fs files differ from the receipt')
  }
  for (const file of recorded) {
    const bytes = await readFile(join(root, file.output))
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    if (bytes.length !== file.bytes || sha256 !== file.outputSha256) {
      throw new Error(`embedded ${file.output} differs from the receipt`)
    }
  }
  return loadCommonAuthStoreModules()
}
