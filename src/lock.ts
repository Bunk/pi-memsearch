/**
 * Global cross-process reader/writer lock for serialized memsearch CLI access.
 *
 * Why global: the default Milvus Lite DB (~/.memsearch/milvus.db) is shared by
 * EVERY project, so two different projects using defaults collide on it. A
 * per-cwd lock would miss that — the lock lives under the memsearch home.
 *
 * Protocol (writer-exclusive, multi-reader):
 *   - A writer creates `write.lock` atomically (open "wx"); holding it blocks
 *     other writers AND signals readers to wait (writer priority). It then waits
 *     for the `readers/` dir to drain before proceeding.
 *   - A reader waits until `write.lock` is absent, registers a unique file under
 *     `readers/`, then re-checks `write.lock`; if a writer appeared it removes
 *     its reader file, backs off, and retries.
 *
 * Stale locks (owner pid dead, or age > STALE_MS) are reclaimed. Acquisition is
 * bounded by ACQUIRE_TIMEOUT_MS; on timeout we reclaim ONLY a demonstrably stale
 * lock and otherwise THROW, rather than preempt a live owner and run two writers
 * against one DB (review findings 2/3). A crashed session leaves a stale lock that
 * the next acquirer reclaims, so this never deadlocks.
 */

import { mkdir, open, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { SUBPROCESS_TIMEOUT_MS } from "./constants";

// Global by default (the shared default Lite DB lives here). PI_MEMSEARCH_LOCK_DIR
// overrides it — used for hermetic tests and as a relocation escape hatch.
const LOCK_DIR = process.env.PI_MEMSEARCH_LOCK_DIR
	? resolve(process.env.PI_MEMSEARCH_LOCK_DIR)
	: join(homedir(), ".memsearch", ".pi-memsearch-lock");
const WRITE_LOCK = join(LOCK_DIR, "write.lock");
const READERS_DIR = join(LOCK_DIR, "readers");

const STALE_MS = 30_000;
const ACQUIRE_TIMEOUT_MS = 15_000;
const POLL_MS = 40;
// Refresh the holder's `time` while fn runs so a long-running index/search (up to
// SUBPROCESS_TIMEOUT_MS, the shared cap in ./constants) is never judged stale by a
// waiter and reclaimed mid-operation (review finding 1). HEARTBEAT_MS << STALE_MS.
const HEARTBEAT_MS = 5_000;

// Reader-drain budget (ms), read per-call so a hermetic-test / escape-hatch override
// (PI_MEMSEARCH_DRAIN_TIMEOUT_MS, mirroring PI_MEMSEARCH_LOCK_DIR) applies without a
// re-import. The production default MUST stay >= a reader's max hold (SUBPROCESS_TIMEOUT_MS
// in ./constants) so a live reader finishes before we give up; on exceed withWriteLock
// THROWS rather than indexing concurrent with a reader (I2).
function drainTimeoutMs(): number {
	return Number(process.env.PI_MEMSEARCH_DRAIN_TIMEOUT_MS) || SUBPROCESS_TIMEOUT_MS;
}

interface LockMeta {
	pid: number;
	time: number;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function isPidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** A lock file is stale when unreadable/malformed, aged out, or owned by a dead pid. */
async function isStale(path: string): Promise<boolean> {
	try {
		const meta = JSON.parse(await readFile(path, "utf8")) as LockMeta;
		if (Date.now() - meta.time > STALE_MS) return true;
		return !isPidAlive(meta.pid);
	} catch {
		return true;
	}
}

async function safeUnlink(path: string): Promise<void> {
	try {
		await unlink(path);
	} catch {
		/* already gone */
	}
}

async function ensureDirs(): Promise<void> {
	await mkdir(READERS_DIR, { recursive: true });
}

/**
 * Atomically (re)write a lock file: serialize to a unique per-holder temp file, then
 * rename() over the target. rename(2) is atomic on POSIX, so a concurrent isStale() read
 * sees either the old or the new COMPLETE file — never a torn/empty one (I1). Returns true
 * on success; on a failed write/rename the previous file is left intact, the temp is cleaned
 * up, and false is returned so the heartbeat can surface sustained failure (Q4). Exported for testing.
 */
export async function writeLockAtomic(path: string, meta: LockMeta): Promise<boolean> {
	// Temp file lives in LOCK_DIR root (NOT READERS_DIR) so liveReaders()'s readdir of
	// READERS_DIR never enumerates an in-flight reader-heartbeat temp and counts it as a
	// phantom live reader (Step-4 concern). rename() within LOCK_DIR is same-filesystem
	// and atomic; the pid+random name avoids collisions between concurrent holders.
	const tmp = join(LOCK_DIR, `.hb-${process.pid}-${Math.random().toString(36).slice(2, 8)}.tmp`);
	try {
		await writeFile(tmp, JSON.stringify(meta));
		await rename(tmp, path);
		return true;
	} catch {
		await safeUnlink(tmp);
		return false;
	}
}

/** Consecutive heartbeat-refresh failures after which the lock could be judged stale and
 *  reclaimed by a waiter; at that point surface a one-time process warning. */
const HEARTBEAT_FAIL_LIMIT = Math.ceil(STALE_MS / HEARTBEAT_MS);

/**
 * Keep a held lock file's `time` fresh while the guarded fn runs (review finding 1). The
 * refresh is ATOMIC (writeLockAtomic, I1) so a waiter's isStale() read never sees a torn file.
 * Best-effort, but sustained failure (>= HEARTBEAT_FAIL_LIMIT in a row, i.e. the lock could age
 * past STALE_MS and be reclaimed mid-operation) emits ONE process warning (Q4). Timer is unref'd.
 */
function startHeartbeat(path: string): () => void {
	let consecutiveFailures = 0;
	let warned = false;
	const timer = setInterval(() => {
		void writeLockAtomic(path, { pid: process.pid, time: Date.now() }).then((ok) => {
			if (ok) {
				consecutiveFailures = 0;
				warned = false;
				return;
			}
			consecutiveFailures++;
			if (consecutiveFailures >= HEARTBEAT_FAIL_LIMIT && !warned) {
				warned = true;
				process.emitWarning(
					`memsearch: lock heartbeat for ${path} has failed ${consecutiveFailures}x in a row; ` +
						"the lock may be reclaimed as stale by another process mid-operation.",
				);
			}
		});
	}, HEARTBEAT_MS);
	if (typeof timer.unref === "function") timer.unref();
	return () => clearInterval(timer);
}

/** True if a live writer holds the lock. Reclaims a stale writer lock as a side effect. */
async function writerHeld(): Promise<boolean> {
	try {
		await readFile(WRITE_LOCK, "utf8");
	} catch {
		return false;
	}
	if (await isStale(WRITE_LOCK)) {
		await safeUnlink(WRITE_LOCK);
		return false;
	}
	return true;
}

/** Atomically create the writer lock. Returns true on success, false if held by a live owner. */
async function tryAcquireWrite(): Promise<boolean> {
	try {
		const fh = await open(WRITE_LOCK, "wx");
		await fh.writeFile(JSON.stringify({ pid: process.pid, time: Date.now() } satisfies LockMeta));
		await fh.close();
		return true;
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
		if (await isStale(WRITE_LOCK)) {
			await safeUnlink(WRITE_LOCK);
			return tryAcquireWrite();
		}
		return false;
	}
}

/** Remove stale reader entries; return the count of live readers remaining. */
async function liveReaders(): Promise<number> {
	let entries: string[];
	try {
		entries = await readdir(READERS_DIR);
	} catch {
		return 0;
	}
	let live = 0;
	for (const name of entries) {
		if (await isStale(join(READERS_DIR, name))) {
			await safeUnlink(join(READERS_DIR, name));
		} else {
			live++;
		}
	}
	return live;
}

/** Run `fn` while holding the exclusive write lock (serialized against all readers/writers). */
export async function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
	await ensureDirs();
	const deadline = Date.now() + ACQUIRE_TIMEOUT_MS;
	while (!(await tryAcquireWrite())) {
		if (Date.now() > deadline) {
			// Never preempt a LIVE writer (review finding 2): only reclaim a demonstrably
			// stale lock; otherwise fail loud rather than run two indexes against one DB.
			if (await isStale(WRITE_LOCK)) {
				await safeUnlink(WRITE_LOCK);
				if (await tryAcquireWrite()) break;
			}
			throw new Error("memsearch: timed out acquiring the write lock (a live writer holds it).");
		}
		await sleep(POLL_MS);
	}
	const stopHeartbeat = startHeartbeat(WRITE_LOCK);
	try {
		// Drain readers before writing. Budget is independent of ACQUIRE_TIMEOUT_MS and >= a
		// reader's max hold; on timeout we THROW (never index concurrently with a live reader —
		// I2), matching the throw-on-timeout stance for acquisition above.
		const drainDeadline = Date.now() + drainTimeoutMs();
		while ((await liveReaders()) > 0) {
			if (Date.now() > drainDeadline) {
				throw new Error("memsearch: timed out draining readers before the write lock (a live reader holds it).");
			}
			await sleep(POLL_MS);
		}
		return await fn();
	} finally {
		stopHeartbeat();
		await safeUnlink(WRITE_LOCK);
	}
}

/** Run `fn` while holding a shared read lock (concurrent with other readers, excluded by a writer). */
export async function withReadLock<T>(fn: () => Promise<T>): Promise<T> {
	await ensureDirs();
	const deadline = Date.now() + ACQUIRE_TIMEOUT_MS;
	const readerFile = join(
		READERS_DIR,
		`${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.lock`,
	);
	while (true) {
		// writerHeld() reclaims a stale writer lock as a side effect, so a LIVE writer is
		// the only thing that keeps us here — on deadline fail loud rather than read
		// concurrently with an in-flight index (review finding 3).
		while (await writerHeld()) {
			if (Date.now() > deadline) {
				throw new Error("memsearch: timed out acquiring a read lock (a live writer holds it).");
			}
			await sleep(POLL_MS);
		}
		await writeFile(readerFile, JSON.stringify({ pid: process.pid, time: Date.now() } satisfies LockMeta));
		if (!(await writerHeld())) break; // registered with no writer present — we hold the read lock
		// a writer appeared between the check and our registration: yield our slot and retry
		await safeUnlink(readerFile);
		if (Date.now() > deadline) {
			throw new Error("memsearch: timed out acquiring a read lock (writer contention).");
		}
		await sleep(POLL_MS);
	}
	const stopHeartbeat = startHeartbeat(readerFile);
	try {
		return await fn();
	} finally {
		stopHeartbeat();
		await safeUnlink(readerFile);
	}
}

/**
 * Run `fn` while holding an exclusive advisory lock at `lockPath` (open "wx" + stale
 * reclaim). Lightweight: no reader tracking and no heartbeat — intended for SHORT critical
 * sections (e.g. a journal read-check+append) so the holder cannot age past STALE_MS
 * mid-section. Bounded by ACQUIRE_TIMEOUT_MS; on timeout against a live holder it THROWS
 * rather than corrupt the shared file (mirrors withWriteLock). Lock scope is whatever path
 * the caller picks (the journal uses a per-daily-file `<file>.lock`). Released in `finally`.
 */
export async function withFileLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
	await mkdir(dirname(lockPath), { recursive: true });
	const deadline = Date.now() + ACQUIRE_TIMEOUT_MS;
	const acquire = async (): Promise<boolean> => {
		try {
			const fh = await open(lockPath, "wx");
			await fh.writeFile(JSON.stringify({ pid: process.pid, time: Date.now() } satisfies LockMeta));
			await fh.close();
			return true;
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
			if (await isStale(lockPath)) {
				await safeUnlink(lockPath);
				return acquire();
			}
			return false;
		}
	};
	while (!(await acquire())) {
		if (Date.now() > deadline) {
			if (await isStale(lockPath)) {
				await safeUnlink(lockPath);
				if (await acquire()) break;
			}
			throw new Error(`memsearch: timed out acquiring file lock ${lockPath} (a live holder holds it).`);
		}
		await sleep(POLL_MS);
	}
	try {
		return await fn();
	} finally {
		await safeUnlink(lockPath);
	}
}
