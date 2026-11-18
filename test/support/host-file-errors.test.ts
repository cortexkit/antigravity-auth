import { loadCommonAuthFs } from '@cortexkit/antigravity-auth-core'

export const retryHintPath = '/tmp/unavailable-500/try again later/x.json'
export const hostFileErrorKinds = ['private file', 'lock'] as const

export async function hostFileError(
  kind: (typeof hostFileErrorKinds)[number],
): Promise<Error> {
  const { PrivateFileError, LockOwnershipError } = await loadCommonAuthFs()
  return kind === 'private file'
    ? new PrivateFileError(retryHintPath, 'read', new Error('read refusal'))
    : new LockOwnershipError({ target: retryHintPath, name: 'test-lock' })
}
