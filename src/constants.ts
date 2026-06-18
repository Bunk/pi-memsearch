/**
 * Shared cross-module constants.
 *
 * SUBPROCESS_TIMEOUT_MS lives here (not in memsearch.ts) so the lock module can use it as
 * the reader-drain default without creating a lock <-> memsearch import cycle (memsearch.ts
 * already imports withReadLock/withWriteLock from lock.ts). The write-lock's reader-drain
 * budget MUST stay >= this value so a live reader (whose memsearch subprocess is capped at
 * this timeout) finishes before the writer gives up.
 */

/** Hard cap on a single memsearch CLI invocation, and the floor for the write-lock drain budget. */
export const SUBPROCESS_TIMEOUT_MS = 300_000;
