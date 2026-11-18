import { AccountStoreBusyError } from './account-migration.ts'
import { AccountRepositoryError } from './account-repository.ts'
import { redactCredentialText } from './credential-redaction.ts'
import { PreResponseTimeoutError } from './pre-response-deadline.ts'
import { sharedVaultTokenFolder } from './vault-folder-refusal.ts'

export const HOST_STORE_READ_FAILURE =
  'antigravity-auth could not read its account store. Check the plugin log for details.'
const HOST_STORE_LOCK_FAILURE =
  'antigravity-auth could not secure its account store. Check the plugin log for details.'
const HOST_CREDENTIAL_SLOT_FAILURE =
  'antigravity-auth could not update the host credential slot. Check the plugin log for details.'
const HOST_VAULT_FOLDER_FAILURE =
  'antigravity-auth could not use its vault folder. Check the plugin log for details.'
const HOST_REQUEST_FAILURE =
  'antigravity-auth could not complete the operation. Check the plugin log for details.'

/** Only plugin-owned, fixed messages belong in a host refusal. */
export class HostRefusalError extends Error {}

const upstreamFailures = new WeakSet<Error>()

/** Preserve real transport/reader exceptions without exposing a marker on them. */
export function markUpstreamFailure(error: unknown): Error {
  const failure = error instanceof Error ? error : new Error(String(error))
  upstreamFailures.add(failure)
  return failure
}

export function isUpstreamFailure(error: unknown): error is Error {
  return error instanceof Error && upstreamFailures.has(error)
}

function errorChain(error: unknown): Error[] {
  const chain: Error[] = []
  for (
    let current = error;
    current instanceof Error && !chain.includes(current);
    current = current.cause
  ) {
    chain.push(current)
  }
  return chain
}

function failureMessage(chain: readonly Error[]): string {
  // OpenCode bundles its own copy of common-auth, and repository failures
  // can wrap either copy. Their error names and the repository kind survive
  // that boundary without importing either embedded runtime into the mapper.
  if (chain.some((error) => error.name === 'PiSlotError'))
    return HOST_CREDENTIAL_SLOT_FAILURE
  if (
    chain.some(
      (error) =>
        [
          'LockContentionError',
          'LockOwnershipError',
          'FileLockOwnershipError',
          'AccountStorageLockContentionError',
        ].includes(error.name) ||
        (error instanceof AccountRepositoryError &&
          ['lock-contention', 'lock-ownership'].includes(error.failure.kind)),
    )
  )
    return HOST_STORE_LOCK_FAILURE
  if (chain.some((error) => sharedVaultTokenFolder(error) !== undefined))
    return HOST_VAULT_FOLDER_FAILURE
  if (
    chain.some(
      (error) =>
        error instanceof AccountRepositoryError ||
        [
          'PrivateFileError',
          'AccountStorageUnreadableError',
          'AccountStoreNotReadyError',
          'AccountStoreAdmissionError',
        ].includes(error.name),
    )
  )
    return HOST_STORE_READ_FAILURE
  return HOST_REQUEST_FAILURE
}

function diagnostics(chain: readonly Error[], error: unknown): string {
  const messages = chain.length
    ? chain.map((entry) => {
        const details = entry as Error & {
          code?: string
          path?: string
          details?: {
            path?: string
            target?: string
            backupPath?: string
            reason?: string
          }
        }
        return [
          entry.name,
          details.code,
          entry.message,
          ...[
            details.path,
            details.details?.path,
            details.details?.target,
          ].filter((path) => path && !entry.message.includes(path)),
          details.details?.backupPath,
          details.details?.reason,
        ]
          .filter(Boolean)
          .join(': ')
      })
    : [String(error)]
  return redactCredentialText([...new Set(messages)].join('; caused by '))
}

/** Log a plugin failure at the host boundary, then discard its diagnostic fields. */
export function hostFailure(
  error: unknown,
  log: (diagnostic: string) => void,
): Error {
  if (
    error instanceof HostRefusalError ||
    error instanceof AccountStoreBusyError ||
    error instanceof PreResponseTimeoutError ||
    isUpstreamFailure(error) ||
    (error instanceof Error &&
      error.name === 'ClaustrumUnreachableError' &&
      error.message === 'Claustrum vault could not be reached')
  )
    return error
  const chain = errorChain(error)
  log(diagnostics(chain, error))
  if (
    error instanceof Error &&
    error.name === 'ClaustrumCredentialError' &&
    'code' in error &&
    error.code === 'grant_denied'
  ) {
    return Object.assign(
      new HostRefusalError(
        'The vault refused access to the selected account. Check the plugin log for details.',
      ),
      { code: 'grant_denied' as const },
    )
  }
  return new HostRefusalError(failureMessage(chain))
}
