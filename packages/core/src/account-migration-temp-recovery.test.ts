import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createSourceFile, isIdentifier, ScriptTarget } from 'typescript'
import {
  type AccountMigrationJournal,
  decodeAccountMigrationJournal,
  resolveAccountStorePaths,
} from './account-migration.ts'

// These inert checks can run without launching the local process-crash fixture.
describe('migration recovery protocol', () => {
  it('strictly rejects the retired native-temp ownership field', () => {
    const id = '00000000-0000-4000-8000-000000000001'
    const paths = resolveAccountStorePaths('/tmp/synthetic/accounts.json', id)
    const journal: AccountMigrationJournal = {
      schemaVersion: 1,
      id,
      legacyPath: paths.legacyPath,
      storeDir: paths.storeDir,
      status: 'pending',
      operation: 'migrate',
      phase: 'capture',
      sourceKind: 'absent',
      manifest: {
        sourceVersion: null,
        normalizationClock: 1,
        accounts: [],
        routing: { schemaVersion: 1 },
        effectiveActiveIndex: 0,
      },
      mapping: [],
      completedRows: [],
    }
    expect(decodeAccountMigrationJournal(journal)).toEqual(journal)
    expect(() =>
      decodeAccountMigrationJournal({ ...journal, ownedTemps: [] }),
    ).toThrow('journal has unknown fields')
    expect(() =>
      decodeAccountMigrationJournal({ ...journal, unknown: true }),
    ).toThrow('journal has unknown fields')
  })

  it('does not use directory inventories or native-temp ownership for recovery', () => {
    const source = createSourceFile(
      'account-migration.ts',
      readFileSync(new URL('./account-migration.ts', import.meta.url), 'utf8'),
      ScriptTarget.Latest,
      true,
    )
    const identifiers: string[] = []
    const visit = (node: import('typescript').Node) => {
      if (isIdentifier(node)) identifiers.push(node.text)
      node.forEachChild(visit)
    }
    visit(source)
    expect(identifiers).toContain('assertPublishedAccountStoreGeneration')
    expect(identifiers).toContain('syncFile')
    expect(identifiers).toContain('syncDirectory')
    for (const retired of [
      'readdir',
      'ownedTemps',
      'recoverStoreTemps',
      'checkpointStoreStage',
    ])
      expect(identifiers).not.toContain(retired)
  })
})
