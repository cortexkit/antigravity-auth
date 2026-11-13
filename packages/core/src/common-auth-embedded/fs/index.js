export { writeJsonAtomic } from './atomic-write.js';
// Canonical path of a file other processes may atomically replace: resolves
// the folder, never the file itself (see canonical-file-path.ts).
export { canonicalFilePath, canonicalFilePathSync, } from './canonical-file-path.js';
export { WRITER_LOCK_CONSTANTS } from './lock-constants.js';
export { PrivateFileError } from './private-files.js';
// The try-once lock underneath withLock, for callers that hold a lock across
// several steps or poll instead of waiting (for example a refresh lease).
export { acquireRefreshFileLock, isLostMarkerRaceError, } from './refresh-file-lock.js';
export { LockContentionError, LockOwnershipError, lockPathFor, withLock, } from './with-lock.js';
