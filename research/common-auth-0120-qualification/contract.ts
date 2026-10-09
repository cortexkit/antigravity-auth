import * as fs from '@cortexkit/common-auth/fs'
import * as store from '@cortexkit/common-auth/store'
import type { AccountMigrationModules } from '../../packages/core/src/account-migration.ts'
import type { AccountStoreModules } from '../../packages/core/src/account-repository.ts'
export const repositoryModules: AccountStoreModules = { store, fs }
export const migrationModules: AccountMigrationModules = { store, fs }
