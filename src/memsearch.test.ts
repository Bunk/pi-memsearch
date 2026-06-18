import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

// Hermetic harness for the spawn path: temp lock dir + fake `memsearch` on PATH that echoes
// MEMSEARCH_FAKE_STDOUT and exits MEMSEARCH_FAKE_EXIT. Set BEFORE importing memsearch.
const tmpRoot = mkdtempSync(join(tmpdir(), "memsearch-unit-"));
const binDir = join(tmpRoot, "bin");
mkdirSync(binDir, { recursive: true });
writeFileSync(join(binDir, "memsearch"), '#!/bin/sh\nprintf "%s" "${MEMSEARCH_FAKE_STDOUT:-}"\nexit ${MEMSEARCH_FAKE_EXIT:-0}\n');
chmodSync(join(binDir, "memsearch"), 0o755);
process.env.PI_MEMSEARCH_LOCK_DIR = join(tmpRoot, "lock");
process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;

const { buildExpandArgs, buildIndexArgs, buildSearchArgs, isExpandResult, isMemoryChunk, searchMemory } = await import("./memsearch");

after(() => rmSync(tmpRoot, { recursive: true, force: true }));

const chunk = {
	content: "c", source: "s.md", heading: "H", heading_level: 2,
	chunk_hash: "h", start_line: 1, end_line: 2, score: 0.5,
};

test("isMemoryChunk accepts a well-formed chunk", () => {
	assert.equal(isMemoryChunk(chunk), true);
});

test("isMemoryChunk rejects malformed chunks", () => {
	assert.equal(isMemoryChunk({ ...chunk, score: "0.5" }), false);
	assert.equal(isMemoryChunk({ ...chunk, content: undefined }), false);
	assert.equal(isMemoryChunk(null), false);
	assert.equal(isMemoryChunk("x"), false);
	assert.equal(isMemoryChunk({}), false);
});

const expand = { chunk_hash: "h", source: "s.md", heading: "H", start_line: 1, end_line: 9, content: "body" };

test("isExpandResult accepts/rejects by shape", () => {
	assert.equal(isExpandResult(expand), true);
	assert.equal(isExpandResult({ ...expand, start_line: "1" }), false);
	assert.equal(isExpandResult({ ...expand, content: 5 }), false);
	assert.equal(isExpandResult(undefined), false);
});

test("buildSearchArgs places the untrusted query after a -- separator (S1)", () => {
	const args = buildSearchArgs("--provider evil", 5);
	const sep = args.indexOf("--");
	assert.ok(sep !== -1, "a -- separator is present");
	assert.equal(args[sep + 1], "--provider evil", "the query is the first arg after --");
	assert.ok(args.slice(0, sep).every((a) => a !== "--provider evil"), "no untrusted value before --");
});

test("buildSearchArgs keeps trusted flags (provider) before -- (S1)", () => {
	const args = buildSearchArgs("q", 3, { provider: "onnx" });
	const sep = args.indexOf("--");
	assert.deepEqual(args.slice(0, sep), ["search", "--top-k", "3", "--json-output", "--provider", "onnx"]);
	assert.deepEqual(args.slice(sep), ["--", "q"]);
});

test("buildExpandArgs places the untrusted chunkHash after -- (S1)", () => {
	assert.deepEqual(buildExpandArgs("--evil"), ["expand", "--json-output", "--", "--evil"]);
});

test("buildIndexArgs places untrusted paths after -- with provider flags before (S1)", () => {
	assert.deepEqual(buildIndexArgs(["--evil.md", "b.md"], { provider: "onnx" }), ["index", "--provider", "onnx", "--", "--evil.md", "b.md"]);
});

test("searchMemory throws on schema drift (non-empty payload, all rows invalid) (I4)", async () => {
	process.env.MEMSEARCH_FAKE_EXIT = "0";
	process.env.MEMSEARCH_FAKE_STDOUT = JSON.stringify([{ content: 123, source: "s" }]); // fails isMemoryChunk
	await assert.rejects(searchMemory("q", 3), /schema drift/);
});

test("searchMemory returns [] on a genuinely empty payload (I4)", async () => {
	process.env.MEMSEARCH_FAKE_EXIT = "0";
	process.env.MEMSEARCH_FAKE_STDOUT = "[]";
	assert.deepEqual(await searchMemory("q", 3), []);
});

test("searchMemory returns valid chunks unchanged", async () => {
	process.env.MEMSEARCH_FAKE_EXIT = "0";
	process.env.MEMSEARCH_FAKE_STDOUT = JSON.stringify([chunk]); // `chunk` = the well-formed module-level fixture
	const out = await searchMemory("q", 3);
	assert.equal(out.length, 1);
	assert.equal(out[0].chunk_hash, "h");
});
