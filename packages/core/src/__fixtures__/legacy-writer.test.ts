import { createHash } from 'node:crypto'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as ts from 'typescript'
import {
  admitPublicConsumer,
  publicFixtureBytes,
} from './common-auth-public-consumer.test.ts'

// Recreate the writer from before migration retired legacy JSON files, not the
// current writer that refuses legacy writes. All four runtime modules come from
// immutable Git blobs; the entry must match the migration test's original JS hash.
export const LEGACY_WRITER_PROVENANCE = {
  commit: 'dc1683258658912bfc1fe40d99c6431343d4bd7b',
  compiler: 'typescript@6.0.3',
  compilerOptions: {
    target: 'ESNext',
    module: 'ESNext',
    verbatimModuleSyntax: true,
    sourceMap: true,
    rewriteRelativeImportExtensions: true,
  },
  originalEntrySha256:
    '5346976e87486ca3496881d5f9e16cc71039a205c39aea39228965fc2dc767c1',
  runtimeClosure: [
    {
      name: 'account-storage',
      blob: '619687373fa20fb40007bac0b07c5c4a0e16cf9e',
      sourceSha256:
        'f210df44f53ae605fa29b05aaf03a63c83e2fd80d00a34ce15d6cc5e31f664ac',
      outputBytes: 24425,
      outputSha256:
        '5346976e87486ca3496881d5f9e16cc71039a205c39aea39228965fc2dc767c1',
    },
    {
      name: 'atomic-write',
      blob: 'a2a36aa1a4a4ad60a2552cc2eb3087402ab34d85',
      sourceSha256:
        '5871b3b6aaaaaddde765343c3c89c0d14e2a9126f0c3f35690aaf6b924a34f12',
      outputBytes: 2602,
      outputSha256:
        '01f7149f5605693e5b8a4ef0d441ba8b7ab49f7282e5870915c4296cfd7fed08',
    },
    {
      name: 'file-lock',
      blob: '04a707049d003136a52b1b505b82e03a575b7a4f',
      sourceSha256:
        'd38318c4926545892057cdebb9ff4c0977752fc7cfbcbced379874ecb48ac9d6',
      outputBytes: 17205,
      outputSha256:
        'b6dbc0e2de9db485141925460d50bff3ccdd297eccfd12c7c1105a54d73e2e23',
    },
    {
      name: 'logger',
      blob: '4a420f25ee842ac7ab3586a046793cf76e3ce074',
      sourceSha256:
        '499b0a5f60d6e78e7dd0bbfcf04c66696f9ba4242e23b9ffbcda70fa625b5b0c',
      outputBytes: 2139,
      outputSha256:
        '207e7dcbbd54f18372735322154d5f2c8d2acfa78dc811bae29747899c3cb3d3',
    },
  ],
} as const

async function compiledLegacyWriter() {
  if (ts.version !== '6.0.3')
    throw new Error('legacy writer compiler version differs')
  const outputs = new Map<string, Buffer>()
  for (const row of LEGACY_WRITER_PROVENANCE.runtimeClosure) {
    const source = await publicFixtureBytes(
      join(
        dirname(fileURLToPath(import.meta.url)),
        `legacy-${row.name}.ts.txt`,
      ),
    )
    const gitBlob = createHash('sha1')
      .update(`blob ${source.length}\0`)
      .update(source)
      .digest('hex')
    if (
      gitBlob !== row.blob ||
      createHash('sha256').update(source).digest('hex') !== row.sourceSha256
    )
      throw new Error(`legacy writer source identity differs: ${row.name}`)
    const emitted = ts.transpileModule(source.toString(), {
      fileName: `${row.name}.ts`,
      compilerOptions: {
        target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.ESNext,
        verbatimModuleSyntax: true,
        sourceMap: true,
        rewriteRelativeImportExtensions: true,
      },
    })
    const output = Buffer.from(emitted.outputText)
    if (
      output.length !== row.outputBytes ||
      createHash('sha256').update(output).digest('hex') !== row.outputSha256
    )
      throw new Error(`legacy writer build identity differs: ${row.name}`)
    if (!emitted.sourceMapText)
      throw new Error('legacy writer source map missing')
    outputs.set(`${row.name}.js`, output)
    outputs.set(`${row.name}.js.map`, Buffer.from(emitted.sourceMapText))
  }
  return outputs
}

function receipt(outputs: ReadonlyMap<string, Buffer>) {
  return `${JSON.stringify({
    ...LEGACY_WRITER_PROVENANCE,
    sources: LEGACY_WRITER_PROVENANCE.runtimeClosure.map((row) => ({
      path: `packages/core/src/${row.name}.ts`,
      fixture: `legacy-${row.name}.ts.txt`,
      blob: row.blob,
      sha256: row.sourceSha256,
    })),
    outputs: [...outputs].map(([path, bytes]) => ({
      path,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    })),
  })}\n`
}

export async function prepareLegacyWriter(publicRoot: string): Promise<string> {
  await admitPublicConsumer(publicRoot)
  const outputs = await compiledLegacyWriter()
  const root = join(publicRoot, 'old-writer-dist')
  await mkdir(root, { mode: 0o700 })
  for (const [path, bytes] of outputs)
    await writeFile(join(root, path), bytes, { mode: 0o600, flag: 'wx' })
  await writeFile(join(root, 'legacy-writer-receipt.json'), receipt(outputs), {
    mode: 0o600,
    flag: 'wx',
  })
  return root
}

export async function admitLegacyWriter(publicRoot: string): Promise<string> {
  await admitPublicConsumer(publicRoot)
  const outputs = await compiledLegacyWriter()
  const root = join(publicRoot, 'old-writer-dist')
  const expectedPaths = [...outputs.keys(), 'legacy-writer-receipt.json'].sort()
  if (
    JSON.stringify((await readdir(root)).sort()) !==
    JSON.stringify(expectedPaths)
  )
    throw new Error('legacy writer member inventory differs')
  for (const [path, bytes] of outputs)
    if (!(await publicFixtureBytes(join(root, path))).equals(bytes))
      throw new Error(`legacy writer payload differs: ${path}`)
  if (
    (
      await publicFixtureBytes(join(root, 'legacy-writer-receipt.json'))
    ).toString() !== receipt(outputs)
  )
    throw new Error('legacy writer provenance receipt differs')
  return root
}
