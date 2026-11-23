import { storeIdentity, } from '@cortexkit/claustrum-client';
// Older clients need a project root to construct the identity. Claustrum's
// vault daemon does not use the root after validation, so newer clients omit
// it to avoid a refused route when the daemon cannot resolve the path.
const needsProjectRoot = storeIdentity.length !== 1;
const compatibleStoreIdentity = storeIdentity;
export function defaultStoreIdentity(options) {
    const storagePath = options.storagePath ?? process.cwd();
    return needsProjectRoot
        ? compatibleStoreIdentity(options.projectRoot ?? process.cwd(), storagePath)
        : compatibleStoreIdentity(storagePath);
}
export function claustrumWireOptions(options) {
    if (needsProjectRoot)
        return options;
    const { projectRoot: _projectRoot, ...wireOptions } = options;
    return wireOptions;
}
