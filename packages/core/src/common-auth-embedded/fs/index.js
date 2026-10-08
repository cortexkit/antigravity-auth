export { writeJsonAtomic } from './atomic-write.js';
export { WRITER_LOCK_CONSTANTS } from './lock-constants.js';
// The try-once lock underneath withLock, for callers that hold a lock across
// several steps or poll instead of waiting (for example a refresh lease).
export { acquireRefreshFileLock, isLostMarkerRaceError, } from './refresh-file-lock.js';
export { LockContentionError, LockOwnershipError, lockPathFor, withLock, } from './with-lock.js';
