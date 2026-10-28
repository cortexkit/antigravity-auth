import { realpathSync } from 'node:fs'
import { lstat, readdir, readFile } from 'node:fs/promises'
import { basename, dirname, join, relative } from 'node:path'

async function lockObject(profile, path, marker = false) {
  const entry = { path: relative(profile, path) }
  try {
    const info = await lstat(path)
    entry.kind = info.isFile()
      ? 'file'
      : info.isDirectory()
        ? 'directory'
        : 'other'
    entry.mtimeMs = info.mtimeMs
    entry.ageMs = Date.now() - info.mtimeMs
    if (entry.kind === 'other') return entry
    const ownerPath = info.isDirectory() ? join(path, 'owner.json') : path
    const ownerInfo = await lstat(ownerPath)
    if (!ownerInfo.isFile() || ownerInfo.size > 8192) {
      entry.ownerError = 'not a bounded regular owner record'
      return entry
    }
    const owner = JSON.parse(await readFile(ownerPath, 'utf8'))
    // Read only lease metadata, never config, state, or arbitrary JSON fields.
    entry.owner = {
      ownerId:
        typeof owner?.ownerId === 'string' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          owner.ownerId,
        )
          ? owner.ownerId
          : undefined,
      ...(marker
        ? {
            createdAt: Number.isFinite(owner?.createdAt)
              ? owner.createdAt
              : undefined,
          }
        : {
            expiresAt: Number.isFinite(owner?.expiresAt)
              ? owner.expiresAt
              : undefined,
          }),
      pid: Number.isSafeInteger(owner?.pid) ? owner.pid : undefined,
    }
  } catch (error) {
    entry.error = error.code ?? error.name
  }
  return entry
}

/**
 * Whether a path as the store built it equals its long form from the file
 * system. Windows private files verify by a handle's final path, so a short
 * 8.3 alias (such as RUNNER~1) in a store path shows up here. Only the path
 * segments that differ are reported, never the whole path.
 */
function longPath(path) {
  try {
    const resolved = realpathSync.native(path)
    if (resolved === path) return { sameAsLong: true }
    const built = path.split(/[\\/]/)
    const long = resolved.split(/[\\/]/)
    const differing = []
    for (let i = 0; i < Math.max(built.length, long.length); i++)
      if (built[i] !== long[i])
        differing.push({ index: i, built: built[i], long: long[i] })
    return { sameAsLong: false, differing }
  } catch (error) {
    return { longPathError: error.code ?? error.name }
  }
}

/** Failure-only, read-only snapshots of leases beside both synthetic stores. */
export async function relocationLockDiagnostics(profile, anchors) {
  const snapshot = {
    capturedAt: Date.now(),
    profile: longPath(profile),
    anchorParents: anchors.map((anchor) => longPath(dirname(anchor))),
    generations: [],
  }
  for (const anchor of anchors) {
    const parent = dirname(anchor)
    let names
    try {
      names = await readdir(parent)
    } catch (error) {
      snapshot.generations.push({
        anchor: relative(profile, anchor),
        error: error.code ?? error.name,
      })
      continue
    }
    for (const name of names.sort()) {
      if (
        !name.startsWith(`${basename(anchor)}.store.`) ||
        !name.endsWith('.generation')
      )
        continue
      const directory = join(parent, name)
      const generation = {
        directory: relative(profile, directory),
        ...longPath(directory),
        locks: [],
      }
      snapshot.generations.push(generation)
      try {
        const info = await lstat(directory)
        if (!info.isDirectory()) continue
        const files = await readdir(directory)
        const locks = new Set(['config.json.antigravity-management.lock'])
        for (const file of files) {
          if (file.endsWith('.lock')) locks.add(file)
          if (file.endsWith('.lock.evicting'))
            locks.add(file.slice(0, -'.evicting'.length))
        }
        for (const lock of [...locks].sort()) {
          const path = join(directory, lock)
          generation.locks.push({
            lease: await lockObject(profile, path),
            evictionMarker: await lockObject(profile, `${path}.evicting`, true),
          })
        }
      } catch (error) {
        generation.error = error.code ?? error.name
      }
    }
  }
  return snapshot
}
