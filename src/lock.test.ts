import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const lockRoot = mkdtempSync(join(tmpdir(), "memsearch-lock-"));
process.env.PI_MEMSEARCH_LOCK_DIR = lockRoot;
const { withFileLock, withReadLock, withWriteLock, writeLockAtomic } = await import("./lock");

after(() => rmSync(lockRoot, { recursive: true, force: true }));

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test("withWriteLock serializes concurrent writers", async () => {
	let active = 0;
	let maxActive = 0;
	const job = () =>
		withWriteLock(async () => {
			active++;
			maxActive = Math.max(maxActive, active);
			await sleep(50);
			active--;
		});
	await Promise.all([job(), job(), job()]);
	assert.equal(maxActive, 1, "writers must not overlap");
});

test("withReadLock allows concurrent readers", async () => {
	let active = 0;
	let maxActive = 0;
	const job = () =>
		withReadLock(async () => {
			active++;
			maxActive = Math.max(maxActive, active);
			await sleep(80);
			active--;
		});
	await Promise.all([job(), job(), job()]);
	assert.ok(maxActive >= 2, "readers should run concurrently");
});

test("a held writer blocks a reader until released (deterministic)", async () => {
	const events: string[] = [];
	let release!: () => void;
	const held = new Promise<void>((r) => {
		release = r;
	});
	const writer = withWriteLock(async () => {
		events.push("w-start");
		await held;
		events.push("w-end");
	});
	while (!events.includes("w-start")) await sleep(5); // wait until the writer actually holds the lock
	const reader = withReadLock(async () => {
		events.push("r");
	});
	await sleep(120); // ample time (>> POLL_MS); a correct reader stays blocked
	assert.deepEqual(events, ["w-start"], "reader blocked while the writer holds the lock");
	release();
	await Promise.all([writer, reader]);
	assert.deepEqual(events, ["w-start", "w-end", "r"]);
});

test("a stale writer lock owned by a dead pid is reclaimed", async () => {
	writeFileSync(join(lockRoot, "write.lock"), JSON.stringify({ pid: 2 ** 30, time: Date.now() }));
	assert.equal(await withWriteLock(async () => "ok"), "ok");
});

test("withWriteLock returns the fn result", async () => {
	assert.equal(await withWriteLock(async () => 42), 42);
});

test("writeLockAtomic refresh is never observed torn or empty (I1)", async () => {
	const p = join(lockRoot, "hb.lock");
	await writeLockAtomic(p, { pid: process.pid, time: Date.now() });
	let torn = 0;
	let reads = 0;
	let stop = false;
	const reader = (async () => {
		while (!stop) {
			try {
				JSON.parse(readFileSync(p, "utf8")); // a torn/empty read throws
				reads++;
			} catch {
				torn++;
			}
			await sleep(0); // yield so the writer can interleave
		}
	})();
	for (let i = 0; i < 200; i++) {
		await writeLockAtomic(p, { pid: process.pid, time: Date.now() });
	}
	stop = true;
	await reader;
	assert.ok(reads > 0, "the lock file was read during refreshes");
	assert.equal(torn, 0, "no refresh was ever observed as a torn/empty file");
});

test("withWriteLock throws rather than running fn() while a reader is live (I2)", async () => {
	process.env.PI_MEMSEARCH_DRAIN_TIMEOUT_MS = "120";
	let releaseReader!: () => void;
	const readerHeld = new Promise<void>((r) => (releaseReader = r));
	const reader = withReadLock(async () => {
		await readerHeld;
	});
	await sleep(40); // let the reader register under readers/
	let ran = false;
	await assert.rejects(
		withWriteLock(async () => {
			ran = true;
			return "x";
		}),
		/draining readers/,
	);
	assert.equal(ran, false, "the write fn must not run while a reader is live");
	releaseReader();
	await reader;
	delete process.env.PI_MEMSEARCH_DRAIN_TIMEOUT_MS;
});

test("withFileLock serializes concurrent holders", async () => {
	const p = join(lockRoot, "file-a.lock");
	let active = 0;
	let maxActive = 0;
	const job = () =>
		withFileLock(p, async () => {
			active++;
			maxActive = Math.max(maxActive, active);
			await sleep(40);
			active--;
		});
	await Promise.all([job(), job(), job()]);
	assert.equal(maxActive, 1, "file-lock holders must not overlap");
});

test("withFileLock reclaims a stale lock owned by a dead pid", async () => {
	const p = join(lockRoot, "file-b.lock");
	writeFileSync(p, JSON.stringify({ pid: 2 ** 30, time: Date.now() }));
	assert.equal(await withFileLock(p, async () => "ok"), "ok");
});

test("withFileLock releases the lock after fn and on throw", async () => {
	const p = join(lockRoot, "file-c.lock");
	await withFileLock(p, async () => "done");
	await assert.rejects(
		withFileLock(p, async () => {
			throw new Error("boom");
		}),
		/boom/,
	);
	assert.equal(await withFileLock(p, async () => "again"), "again");
});

test("writeLockAtomic returns true on success, false on failure", async () => {
	assert.equal(await writeLockAtomic(join(lockRoot, "wla.lock"), { pid: process.pid, time: Date.now() }), true);
	assert.equal(
		await writeLockAtomic(join(lockRoot, "nope", "deep", "wla.lock"), { pid: process.pid, time: Date.now() }),
		false,
	);
});
