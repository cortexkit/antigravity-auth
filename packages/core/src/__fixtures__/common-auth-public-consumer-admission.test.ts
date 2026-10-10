import { expect, it } from 'bun:test'
import { symlink, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  admitPublicArchiveBytes,
  admitPublicConsumer,
  admittedPublicArchive,
  PUBLIC_CONSUMER_PROJECT_ROOT,
  provisionPublicConsumer,
  publicFixtureBytes,
  requirePublicConsumerRoot,
} from './common-auth-public-consumer.test.ts'
import {
  admitLegacyWriter,
  LEGACY_WRITER_PROVENANCE,
  prepareLegacyWriter,
} from './legacy-writer.test.ts'

it('reconstructs the exact historical writer and refuses missing or changed runtime closure bytes', async () => {
  const fixture = await provisionPublicConsumer()
  try {
    await expect(admitLegacyWriter(fixture.root)).rejects.toThrow('ENOENT')
    const root = await prepareLegacyWriter(fixture.root)
    expect(await admitLegacyWriter(fixture.root)).toBe(root)
    const receipt = JSON.parse(
      (
        await publicFixtureBytes(join(root, 'legacy-writer-receipt.json'))
      ).toString(),
    )
    expect(receipt.originalEntrySha256).toBe(
      '5346976e87486ca3496881d5f9e16cc71039a205c39aea39228965fc2dc767c1',
    )
    expect(receipt.compiler).toBe('typescript@6.0.3')
    expect(receipt.commit).toBe(LEGACY_WRITER_PROVENANCE.commit)
    await writeFile(join(root, 'file-lock.js'), 'corrupt synthetic dependency')
    await expect(admitLegacyWriter(fixture.root)).rejects.toThrow(
      'legacy writer payload differs: file-lock.js',
    )
  } finally {
    await fixture.remove()
  }
})

it('requires an explicit worktree-local consumer instead of a default or parent fixture', () => {
  for (const root of [
    undefined,
    '',
    '/tmp/not-owned',
    join(
      PUBLIC_CONSUMER_PROJECT_ROOT,
      '.cortexkit/parent-inputs/common-auth-0114-public-current',
    ),
  ])
    expect(() => requirePublicConsumerRoot(root)).toThrow(
      'explicit worktree-local public package fixture required',
    )
})

it('refuses a missing owned public consumer', async () => {
  await expect(
    admitPublicConsumer(
      join(
        PUBLIC_CONSUMER_PROJECT_ROOT,
        'node_modules/.common-auth-public-consumer-missing',
      ),
    ),
  ).rejects.toThrow('ENOENT')
})

it('admits the complete genuine publication and records every member payload', async () => {
  const fixture = await provisionPublicConsumer()
  try {
    const admitted = await admitPublicConsumer(fixture.root)
    expect(admitted.receipt.archive.bytes).toBe(235492)
    expect(admitted.receipt.archive.sha256).toBe(
      '35ce4c601c94e8aba94762fade7895047b3038b70c0d93753aa4d955bb04e951',
    )
    expect(admitted.entries).toEqual(await admittedPublicArchive())
    const pkg = JSON.parse(
      (
        await publicFixtureBytes(join(fixture.packageRoot, 'package.json'))
      ).toString(),
    )
    expect(pkg.name).toBe('@cortexkit/common-auth')
    expect(pkg.version).toBe('0.12.0')
    expect(pkg.exports['./store'].import).toBe('./dist/store/index.js')
    expect(pkg.exports['./fs'].import).toBe('./dist/fs/index.js')
  } finally {
    await fixture.remove()
  }
})

it('refuses corrupted public store payload bytes', async () => {
  const fixture = await provisionPublicConsumer()
  try {
    const entry = join(fixture.packageRoot, 'dist/store/index.js')
    await writeFile(entry, 'corrupt synthetic bytes')
    await expect(admitPublicConsumer(fixture.root)).rejects.toThrow(
      'public payload byte identity differs: package/dist/store/index.js',
    )
  } finally {
    await fixture.remove()
  }
})

it('refuses altered consumer entrypoints and publication receipts', async () => {
  const fixture = await provisionPublicConsumer()
  try {
    const bridge = join(fixture.root, 'store-bridge.mjs')
    const original = await publicFixtureBytes(bridge)
    await writeFile(bridge, 'export const openPoolStore = () => ({})')
    await expect(admitPublicConsumer(fixture.root)).rejects.toThrow(
      'public consumer entrypoint bytes differ: store',
    )
    await writeFile(bridge, original)
    await writeFile(join(fixture.root, 'public-package-receipt.json'), '{}')
    await expect(admitPublicConsumer(fixture.root)).rejects.toThrow(
      'public package receipt differs',
    )
  } finally {
    await fixture.remove()
  }
})

it('refuses wrong package identity, version and export metadata', async () => {
  const fixture = await provisionPublicConsumer()
  try {
    const path = join(fixture.packageRoot, 'package.json')
    const pkg = JSON.parse((await publicFixtureBytes(path)).toString())
    for (const changed of [
      { ...pkg, name: 'wrong-name' },
      { ...pkg, version: '0.11.4' },
      { ...pkg, exports: {} },
    ]) {
      await writeFile(path, JSON.stringify(changed))
      await expect(admitPublicConsumer(fixture.root)).rejects.toThrow(
        'public payload byte identity differs: package/package.json',
      )
    }
  } finally {
    await fixture.remove()
  }
})

it('refuses missing, extra and symlinked public package members', async () => {
  const fixture = await provisionPublicConsumer()
  try {
    const path = join(fixture.packageRoot, 'dist/store/index.js')
    const bytes = await publicFixtureBytes(path)
    await unlink(path)
    await expect(admitPublicConsumer(fixture.root)).rejects.toThrow(
      'public package member inventory differs',
    )
    await writeFile(path, bytes)
    const extra = join(fixture.packageRoot, 'extra.js')
    await writeFile(extra, 'not a published member')
    await expect(admitPublicConsumer(fixture.root)).rejects.toThrow(
      'public package member inventory differs',
    )
    await unlink(extra)
    await unlink(path)
    await symlink(join(fixture.packageRoot, 'dist/fs/index.js'), path)
    await expect(admitPublicConsumer(fixture.root)).rejects.toThrow(
      'public package refuses symlink',
    )
  } finally {
    await fixture.remove()
  }
})

it('refuses missing, truncated and corrupt archives before provisioning', async () => {
  expect(() => admitPublicArchiveBytes(Buffer.alloc(0))).toThrow(
    'public archive byte length differs',
  )
  const archive = await publicFixtureBytes(
    join(
      PUBLIC_CONSUMER_PROJECT_ROOT,
      'tools/common-auth-build/inputs/cortexkit-common-auth-0.12.0.tgz',
    ),
  )
  expect(() => admitPublicArchiveBytes(archive.subarray(1))).toThrow(
    'public archive byte length differs',
  )
  const corrupt = Buffer.from(archive)
  corrupt[20] = (corrupt[20] ?? 0) ^ 1
  expect(() => admitPublicArchiveBytes(corrupt)).toThrow(
    'integrity: SHA256 mismatch',
  )
})
