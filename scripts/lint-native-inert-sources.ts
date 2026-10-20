import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createScopedBiomeConfig,
  scopedBiomeCheckArgs,
} from './native-inert-gate.ts'

export async function lintNativeInertSources(): Promise<number> {
  const root = process.cwd()
  const temporary = mkdtempSync(join(tmpdir(), 'native-inert-biome-'))
  try {
    const config = createScopedBiomeConfig(root, temporary)
    return await new Promise<number>((resolve) => {
      const child = spawn(
        './node_modules/.bin/biome',
        scopedBiomeCheckArgs(config),
        { cwd: root, stdio: 'inherit' },
      )
      child.once('error', (error) => {
        console.error(error)
        resolve(1)
      })
      child.once('close', (code) => resolve(code ?? 1))
    })
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

if (import.meta.main) process.exitCode = await lintNativeInertSources()
