import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	appendToJournal,
	buildAnchor,
	dailyJournalPath,
	digestJournals,
	ensureDailyFile,
	formatDate,
	formatExchangeBlock,
	formatSessionHeader,
	formatTime,
	journalHasEntry,
	journalHasSession,
	journalMemoryDir,
	listDailyJournals,
	readRecentJournals,
	toBulletList,
} from "./journal";

test("formatDate / formatTime pad", () => {
	const d = new Date(2026, 0, 5, 9, 3);
	assert.equal(formatDate(d), "2026-01-05");
	assert.equal(formatTime(d), "09:03");
});

test("toBulletList normalizes bullets", () => {
	assert.equal(toBulletList("- a\n* b\n\n  c  "), "- a\n- b\n- c");
});

test("buildAnchor + formatExchangeBlock embed the anchor", () => {
	const anchor = buildAnchor("sess1", "turn1", "/path/s.jsonl");
	assert.match(anchor, /session:sess1 turn:turn1 transcript:\/path\/s\.jsonl/);
	const block = formatExchangeBlock({ date: new Date(2026, 0, 1, 8, 0), anchor, bullets: "- x" });
	assert.match(block, /### 08:00/);
	assert.match(block, /- x/);
});

test("journalMemoryDir / dailyJournalPath compose under cwd", () => {
	assert.equal(journalMemoryDir("/p"), join("/p", ".memsearch", "memory"));
	assert.equal(dailyJournalPath("/p", new Date(2026, 0, 1)), join("/p", ".memsearch", "memory", "2026-01-01.md"));
});

test("ensureDailyFile creates the dated file; journalHasSession reflects anchors", async () => {
	const dir = await mkdtemp(join(tmpdir(), "memsearch-journal-"));
	try {
		const now = new Date(2026, 0, 1, 10, 0);
		const file = await ensureDailyFile(dir, now);
		assert.equal(await journalHasSession(file, "sessA"), false);
		await appendToJournal(file, formatSessionHeader(now));
		await appendToJournal(file, formatExchangeBlock({ date: now, anchor: buildAnchor("sessA", "t1", "x"), bullets: "- b" }));
		assert.equal(await journalHasSession(file, "sessA"), true);
		assert.equal(await journalHasSession(file, "sessB"), false);
		const content = await readFile(file, "utf8");
		assert.match(content, /# 2026-01-01/);
		assert.match(content, /## Session 10:00/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("journalHasSession is prefix-safe and missing-file-safe", async () => {
	assert.equal(await journalHasSession("/no/such/file.md", "sess"), false);
	const dir = await mkdtemp(join(tmpdir(), "memsearch-journal2-"));
	try {
		const file = join(dir, "f.md");
		await appendToJournal(file, buildAnchor("abcd", "t", "x"));
		assert.equal(await journalHasSession(file, "abc"), false);
		assert.equal(await journalHasSession(file, "abcd"), true);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("ensureDailyFile is race-safe: concurrent creates never truncate the header (I4)", async () => {
	const dir = await mkdtemp(join(tmpdir(), "memsearch-journal-race-"));
	try {
		const now = new Date(2026, 0, 1, 10, 0);
		const files = await Promise.all(Array.from({ length: 12 }, () => ensureDailyFile(dir, now)));
		assert.equal(new Set(files).size, 1, "all resolve to the same daily file");
		await appendToJournal(files[0], formatExchangeBlock({ date: now, anchor: buildAnchor("s", "t", "x"), bullets: "- b" }));
		const content = await readFile(files[0], "utf8");
		const headers = content.match(/^# 2026-01-01$/gm) ?? [];
		assert.equal(headers.length, 1, "exactly one day header, never truncated/duplicated");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("journalHasEntry detects an entry anchor and is prefix-safe", async () => {
	const dir = await mkdtemp(join(tmpdir(), "memsearch-journal-entry-"));
	try {
		const file = join(dir, "f.md");
		await appendToJournal(file, formatExchangeBlock({ date: new Date(2026, 0, 1, 8, 0), anchor: buildAnchor("sessA", "L12", "x"), bullets: "- b" }));
		assert.equal(await journalHasEntry(file, "sessA", "L12"), true);
		assert.equal(await journalHasEntry(file, "sessA", "L1"), false, "prefix of an entryId must not match");
		assert.equal(await journalHasEntry(file, "sessB", "L12"), false, "different session must not match");
		assert.equal(await journalHasEntry("/no/such/file.md", "sessA", "L12"), false);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("journalHasSession ignores a bare anchor-like substring in the body (S1)", async () => {
	const dir = await mkdtemp(join(tmpdir(), "memsearch-journal-s1-"));
	try {
		const file = join(dir, "f.md");
		await appendToJournal(file, "- discussed the anchor format session:evil turn: in the summary\n");
		assert.equal(await journalHasSession(file, "evil"), false, "bare body substring must not satisfy the header guard");
		await appendToJournal(file, buildAnchor("evil", "t1", "x"));
		assert.equal(await journalHasSession(file, "evil"), true);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("journalHasEntry ignores a bare anchor-like substring in the body (S1)", async () => {
	const dir = await mkdtemp(join(tmpdir(), "memsearch-journal-s1e-"));
	try {
		const file = join(dir, "f.md");
		await appendToJournal(file, "- note: session:evil turn:LX appeared in the chat\n");
		assert.equal(await journalHasEntry(file, "evil", "LX"), false, "bare body substring must not satisfy the entry guard");
		await appendToJournal(file, formatExchangeBlock({ date: new Date(2026, 0, 1, 8, 0), anchor: buildAnchor("evil", "LX", "x"), bullets: "- b" }));
		assert.equal(await journalHasEntry(file, "evil", "LX"), true);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("digestJournals is deterministic, changes on edit, and is empty for a missing dir", async () => {
	const dir = await mkdtemp(join(tmpdir(), "memsearch-digest-"));
	try {
		assert.equal(await digestJournals(dir, 12), "sha256:empty");
		const file = await ensureDailyFile(dir, new Date(2026, 0, 1, 9, 0));
		await appendToJournal(file, formatExchangeBlock({ date: new Date(2026, 0, 1, 9, 0), anchor: buildAnchor("s", "t", "x"), bullets: "- a" }));
		const d1 = await digestJournals(dir, 12);
		assert.match(d1, /^sha256:[0-9a-f]{64}$/);
		assert.equal(await digestJournals(dir, 12), d1, "deterministic for unchanged journals");
		await appendToJournal(file, formatExchangeBlock({ date: new Date(2026, 0, 1, 9, 5), anchor: buildAnchor("s", "t2", "x"), bullets: "- b" }));
		assert.notEqual(await digestJournals(dir, 12), d1, "digest changes when a journal changes");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("listDailyJournals returns all daily basenames sorted; missing dir → []", async () => {
	assert.deepEqual(await listDailyJournals("/no/such/dir"), []);
	const dir = await mkdtemp(join(tmpdir(), "memsearch-listjournals-"));
	try {
		for (const day of [3, 1, 2]) await ensureDailyFile(dir, new Date(2026, 0, day, 9, 0));
		// a non-journal file must be ignored
		await appendToJournal(join(dir, ".memsearch", "memory", "notes.md"), "x");
		assert.deepEqual(await listDailyJournals(dir), ["2026-01-01.md", "2026-01-02.md", "2026-01-03.md"]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("readRecentJournals returns the most recent daily files' contents", async () => {
	const dir = await mkdtemp(join(tmpdir(), "memsearch-recent-"));
	try {
		assert.equal(await readRecentJournals(dir, 12), "");
		for (const day of [1, 2, 3]) {
			const f = await ensureDailyFile(dir, new Date(2026, 0, day, 9, 0));
			await appendToJournal(f, `\n- entry day ${day}\n`);
		}
		const recent2 = await readRecentJournals(dir, 2);
		assert.match(recent2, /entry day 2/);
		assert.match(recent2, /entry day 3/);
		assert.doesNotMatch(recent2, /entry day 1/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
