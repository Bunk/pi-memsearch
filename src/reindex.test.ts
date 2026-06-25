import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// Hermetic harness: temp lock dir + fake `memsearch` on PATH (exit MEMSEARCH_FAKE_EXIT). Set BEFORE import.
const tmpRoot = mkdtempSync(join(tmpdir(), "memsearch-reindex-"));
const binDir = join(tmpRoot, "bin");
mkdirSync(binDir, { recursive: true });
writeFileSync(join(binDir, "memsearch"), "#!/bin/sh\nexit ${MEMSEARCH_FAKE_EXIT:-0}\n");
chmodSync(join(binDir, "memsearch"), 0o755);
process.env.PI_MEMSEARCH_LOCK_DIR = join(tmpRoot, "lock");
process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;

const { runDueReindex, registerReindex } = await import("./reindex");
const { readState } = await import("./maintenance-state");
const { digestJournals, journalMemoryDir } = await import("./journal");
const { RECENT_JOURNAL_LIMIT } = await import("./constants");

after(() => rmSync(tmpRoot, { recursive: true, force: true }));

function freshCwd(name: string): string {
	const cwd = join(tmpRoot, name);
	mkdirSync(journalMemoryDir(cwd), { recursive: true });
	return cwd;
}
function seedJournal(cwd: string, body = "- did a thing\n"): void {
	writeFileSync(join(journalMemoryDir(cwd), "2026-01-01.md"), `# 2026-01-01\n\n### 10:00\n${body}`);
}
function fakePi(handlers: Record<string, (e: unknown, c: unknown) => Promise<unknown>> = {}): ExtensionAPI {
	return { getFlag: () => undefined, registerFlag: () => {}, on: (n: string, fn: never) => { handlers[n] = fn; } } as unknown as ExtensionAPI;
}
function fakeCtx(cwd: string, opts: { trusted?: boolean; hasUI?: boolean; notes?: string[] } = {}): ExtensionContext {
	return {
		isProjectTrusted: () => opts.trusted ?? true,
		hasUI: opts.hasUI ?? false,
		signal: undefined,
		ui: { notify: (m: string) => opts.notes?.push(m) },
		sessionManager: { getCwd: () => cwd },
	} as unknown as ExtensionContext;
}

test("runDueReindex is a no-op in an untrusted project (I2)", async () => {
	const cwd = freshCwd("untrusted");
	seedJournal(cwd);
	await runDueReindex(fakePi(), fakeCtx(cwd, { trusted: false }));
	assert.deepEqual(await readState(cwd), {}, "untrusted → no index, no state");
});

test("runDueReindex no-ops with no journals (empty-digest guard)", async () => {
	const cwd = freshCwd("empty"); // memory dir exists, no journal files
	await runDueReindex(fakePi(), fakeCtx(cwd));
	assert.equal((await readState(cwd)).live_reindex, undefined, "no journals → nothing recorded, no throw");
});

test("runDueReindex indexes and records the digest on first run (never-run → changed)", async () => {
	process.env.MEMSEARCH_FAKE_EXIT = "0";
	const cwd = freshCwd("first");
	seedJournal(cwd);
	const digest = await digestJournals(cwd, RECENT_JOURNAL_LIMIT);
	await runDueReindex(fakePi(), fakeCtx(cwd), Date.UTC(2026, 0, 1));
	const st = (await readState(cwd)).live_reindex;
	assert.equal(st?.last_input_digest, digest, "records the indexed digest");
	assert.equal(st?.last_action, "none");
});

test("runDueReindex does not re-index an unchanged digest (state untouched)", async () => {
	process.env.MEMSEARCH_FAKE_EXIT = "0";
	const cwd = freshCwd("unchanged");
	seedJournal(cwd);
	await runDueReindex(fakePi(), fakeCtx(cwd), Date.UTC(2026, 0, 1));
	const before = (await readState(cwd)).live_reindex?.last_success_at;
	await runDueReindex(fakePi(), fakeCtx(cwd), Date.UTC(2026, 0, 2)); // later now, same journal bytes
	assert.equal((await readState(cwd)).live_reindex?.last_success_at, before, "unchanged digest → not re-run");
});

test("runDueReindex re-indexes when journals change externally (the gap-#4 case)", async () => {
	process.env.MEMSEARCH_FAKE_EXIT = "0";
	const cwd = freshCwd("changed");
	seedJournal(cwd, "- first\n");
	await runDueReindex(fakePi(), fakeCtx(cwd), Date.UTC(2026, 0, 1));
	const first = (await readState(cwd)).live_reindex?.last_input_digest;
	seedJournal(cwd, "- externally edited\n"); // overwrite the journal bytes (external write)
	await runDueReindex(fakePi(), fakeCtx(cwd), Date.UTC(2026, 0, 2));
	const second = (await readState(cwd)).live_reindex?.last_input_digest;
	assert.notEqual(second, first, "an external journal edit changes the digest and re-indexes");
});

test("a failed index records no state and retries (write-then-mark)", async () => {
	process.env.MEMSEARCH_FAKE_EXIT = "1"; // index fails
	const cwd = freshCwd("indexfail");
	seedJournal(cwd);
	await assert.rejects(runDueReindex(fakePi(), fakeCtx(cwd)), /index failed/i);
	assert.equal((await readState(cwd)).live_reindex, undefined, "no state recorded when the index fails");
	process.env.MEMSEARCH_FAKE_EXIT = "0";
});

test("registerReindex wires a before_agent_start handler that runs the reindex", async () => {
	process.env.MEMSEARCH_FAKE_EXIT = "0";
	const handlers: Record<string, (e: unknown, c: unknown) => Promise<unknown>> = {};
	const cwd = freshCwd("wired");
	seedJournal(cwd);
	registerReindex(fakePi(handlers));
	assert.equal(typeof handlers.before_agent_start, "function", "registers before_agent_start");
	await handlers.before_agent_start({}, fakeCtx(cwd));
	assert.ok((await readState(cwd)).live_reindex, "the handler ran the reindex and recorded state");
});

test("registerReindex handler swallows an index failure (warn-once, no throw)", async () => {
	process.env.MEMSEARCH_FAKE_EXIT = "1";
	const handlers: Record<string, (e: unknown, c: unknown) => Promise<unknown>> = {};
	const cwd = freshCwd("wired-fail");
	seedJournal(cwd);
	const notes: string[] = [];
	registerReindex(fakePi(handlers));
	await handlers.before_agent_start({}, fakeCtx(cwd, { hasUI: true, notes })); // must NOT throw
	assert.equal((await readState(cwd)).live_reindex, undefined, "failed index records nothing");
	assert.equal(notes.length, 1, "warns once on failure");
	process.env.MEMSEARCH_FAKE_EXIT = "0";
});
