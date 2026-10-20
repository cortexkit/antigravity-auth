/**
 * Recognizes the vault libraries' refusal to save an enrollment token under a
 * folder that another user could replace, so a menu can name that folder and
 * the fix instead of showing the library's own error text.
 *
 * Two libraries can refuse. The embedded common-auth enrollment code checks
 * every folder above the token for group or world write access first; the
 * `@cortexkit/claustrum-client` token writer then checks again, and also
 * refuses a folder owned by another user. Neither gives the refusal its own
 * error class or code (the client throws a plain `Error`), so the message
 * shapes below are the contract, matched against the versions this package
 * pins.
 */

/** The client's `notPrivate` check emits this message for an enrollment-token
 * folder it refuses; the pattern extracts that folder before applying the
 * shared-folder remedy below.
 */
const CLIENT_REFUSAL = /^enrollment token folder (.+) is not private: (.+)$/s

/**
 * The client's reasons that mean the folder is shared with other users: owned
 * by someone else, or writable by a group or by everyone. Its other reasons
 * (a folder that cannot be inspected, a path component that is not a folder,
 * a sticky shared folder such as /tmp) need a different fix, so they are not
 * reported as a shared folder.
 */
const SHARED_FOLDER_REASON =
  /^(?:foreign owner|world-writable ancestor|group-writable ancestor|could not (?:read|parse) \S+ to establish a user-private group)/

/**
 * The embedded common-auth enrollment code (`refuseWritableAncestor` in
 * claustrum/enrollment.js, POSIX branch):
 * `Claustrum enrollment path has a writable ancestor: <path>. Another user could replace it. ...`
 */
const EMBEDDED_REFUSAL =
  /^Claustrum enrollment path has a writable ancestor: (.+?)\. Another user could replace it\./s

/**
 * The folder named by a refusal to save the vault enrollment token because
 * that folder is shared with other users, or undefined for any other error.
 */
export function sharedVaultTokenFolder(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined
  const client = CLIENT_REFUSAL.exec(error.message)
  if (client?.[1] && client[2] && SHARED_FOLDER_REASON.test(client[2]))
    return client[1]
  const embedded = EMBEDDED_REFUSAL.exec(error.message)
  if (embedded?.[1]) return embedded[1]
  return undefined
}

/** The result code a menu reports with `sharedVaultTokenFolderText`. */
export const SHARED_VAULT_TOKEN_FOLDER_CODE = 'vault-folder-shared'

/** The one sentence a menu shows for a refusal `sharedVaultTokenFolder` recognized. */
export function sharedVaultTokenFolderText(folder: string): string {
  return `The vault key can't be saved because the folder ${folder} can be changed by other users. Make that folder owned by you and not writable by your group or by others, then try again.`
}

/**
 * A failed menu result for a shared-folder refusal, or undefined when the
 * error is something else and the caller should handle it as before.
 */
export function sharedVaultTokenFolderOutcome(
  error: unknown,
): { ok: false; text: string; code: string } | undefined {
  const folder = sharedVaultTokenFolder(error)
  return folder === undefined
    ? undefined
    : {
        ok: false,
        text: sharedVaultTokenFolderText(folder),
        code: SHARED_VAULT_TOKEN_FOLDER_CODE,
      }
}
