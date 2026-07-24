/**
 * Atomic JSON file writer.
 *
 * Stages the payload at `${path}.${randomUUID()}.tmp` (same directory as
 * the target so the rename is atomic on POSIX, and uses the same NTFS
 * volume on Windows) and renames onto `path`. The `0o600` mode is enforced
 * on the staged file; on POSIX the rename replaces the target's inode so
 * the new file inherits the staged mode bits. Windows ignores POSIX mode
 * bits and relies on the current user's inherited ACL — we do not attempt
 * to harden ACLs from Node.
 *
 * Failures are deliberately NOT masked by a copy fallback: a blind
 * copy-then-unlink after a failing replace can paper over partial writes
 * and let concurrent writers silently corrupt state. The caller decides
 * whether to retry, surface, or back off.
 */

import { randomUUID } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * Atomically serialize `value` as pretty-printed JSON and rename it onto
 * `path`. Throws if any step fails; the staged temp file is removed before
 * rethrow so no `${path}.<uuid>.tmp` is left behind.
 */
export async function writeJsonAtomic(
  path: string,
  value: unknown,
): Promise<void> {
  const serialized = `${JSON.stringify(value, null, 2)}\n`
  const tempPath = `${path}.${randomUUID()}.tmp`

  await mkdir(dirname(path), { recursive: true })

  let renamed = false
  try {
    await writeFile(tempPath, serialized, {
      encoding: 'utf8',
      mode: 0o600,
    })
    await rename(tempPath, path)
    renamed = true
  } finally {
    if (!renamed) {
      // Cleanup the staged temp whether `writeFile` threw after a partial
      // write or `rename` failed. `force: true` makes the call a no-op
      // when the file never landed on disk.
      await rm(tempPath, { force: true }).catch(() => {})
    }
  }
}
