import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { caseNames, fixture, hash, repository } from './fixture.mjs'

// Overrides are executable paths, never versions inferred from a generic alias.
// Required acquisitions fail explicitly; missing runtimes cannot fill acceptance.
const runtimes = [
  {
    name: 'Node 20.0.0',
    version: 'v20.0.0',
    path:
      process.env.RPC_NODE20 ??
      join(
        repository,
        `test/common-auth-094-adoption/rpc/.owned/node-v20.0.0-${process.platform}-${process.arch}/bin/node`,
      ),
  },
  {
    name: 'Node 24.16.0',
    version: 'v24.16.0',
    path:
      process.env.RPC_NODE24 ??
      join(homedir(), '.local/share/mise/installs/node/24.16.0/bin/node'),
  },
  {
    name: 'Bun 1.3.14',
    version: '1.3.14',
    path:
      process.env.RPC_BUN13 ??
      join(homedir(), '.local/share/mise/installs/bun/1.3.14/bin/bun'),
  },
  {
    name: 'Bun 1.4.2',
    version: '1.4.2',
    path: process.env.RPC_BUN14 ?? process.execPath,
  },
]

for (const runtime of runtimes) {
  test(`S-RPC exact runtime acceptance: ${runtime.name}`, async () => {
    const version = spawnSync(runtime.path, ['--version'], {
      cwd: repository,
      encoding: 'utf8',
    })
    expect(
      version.error,
      `acquire ${runtime.name}; configure RPC_NODE20/RPC_NODE24/RPC_BUN13/RPC_BUN14`,
    ).toBeUndefined()
    expect(version.status).toBe(0)
    expect(version.stdout.trim()).toBe(runtime.version)
    const owned = join(repository, 'test/common-auth-094-adoption/rpc/.owned')
    await mkdir(owned, { recursive: true })
    const root = await mkdtemp(join(owned, 'runtime-'))
    try {
      const inputs = await fixture(root)
      const argv = [
        join(repository, 'test/common-auth-094-adoption/rpc/runtime.mjs'),
        root,
      ]
      const child = spawnSync(runtime.path, argv, {
        cwd: repository,
        encoding: 'utf8',
        timeout: 45000,
      })
      expect(child.error).toBeUndefined()
      const result = JSON.parse(child.stdout.trim())
      expect(result.rows.map((row: { name: string }) => row.name)).toEqual(
        caseNames,
      )
      const receipt = {
        executable: runtime.path,
        executableSha256: hash(await readFile(runtime.path)),
        version: version.stdout.trim(),
        argv,
        cwd: repository,
        inputs,
        exit: child.status,
        stderr: child.stderr,
        ...result,
      }
      const evidence = await mkdtemp(join(owned, 'receipt-'))
      await writeFile(
        join(evidence, 'result.json'),
        JSON.stringify(receipt, null, 2),
      )
      console.log(
        JSON.stringify({
          runtime: runtime.name,
          receipt: join(evidence, 'result.json'),
          exit: child.status,
          cases: result.rows.map((row: { name: string; ok: boolean }) => ({
            name: row.name,
            ok: row.ok,
          })),
          idle: result.rows.find(
            (row: { name: string }) => row.name === 'rpc.timeout_zero',
          ).observation,
        }),
      )
      expect(result.rows.filter((row: { ok: boolean }) => !row.ok)).toEqual([])
      expect(child.status, child.stderr).toBe(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 60000)
}
