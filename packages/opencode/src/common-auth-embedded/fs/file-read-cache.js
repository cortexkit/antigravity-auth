import { lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
async function identity(path) {
    try {
        const metadata = await lstat(path);
        // Do not follow a symlink: its target can change without changing the link.
        return metadata.isFile() ? metadata : undefined;
    }
    catch (error) {
        return error.code === 'ENOENT'
            ? 'absent'
            : undefined;
    }
}
function sameIdentity(left, right) {
    if (left === 'absent' || right === 'absent')
        return left === right;
    return (left.dev === right.dev &&
        left.ino === right.ino &&
        left.size === right.size &&
        left.mtimeMs === right.mtimeMs &&
        left.ctimeMs === right.ctimeMs);
}
/** Process-local reads, capped at 64 path sets with one value per resolved set. */
export class FileReadCache {
    #entries = new Map();
    async read(paths, read, validateHit) {
        const resolvedPaths = paths.map((path) => resolve(path));
        const key = JSON.stringify(resolvedPaths);
        const probed = await Promise.all(resolvedPaths.map(identity));
        const identities = probed.every((entry) => entry !== undefined)
            ? probed
            : undefined;
        const cached = this.#entries.get(key);
        if (identities &&
            cached &&
            identities.every((entry, index) => {
                const previous = cached.identities[index];
                return previous !== undefined && sameIdentity(entry, previous);
            })) {
            validateHit?.(identities);
            return cached.value;
        }
        // A failed probe or read must not leave a previous successful value reusable.
        this.#entries.delete(key);
        const value = await read(resolvedPaths);
        if (identities) {
            if (this.#entries.size >= 64) {
                const oldest = this.#entries.keys().next().value;
                if (oldest !== undefined)
                    this.#entries.delete(oldest);
            }
            this.#entries.set(key, { identities, value });
        }
        return value;
    }
}
