import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

// Hermetic harness for the spawn path: temp lock dir + fake `memsearch` on PATH that echoes
// MEMSEARCH_FAKE_STDOUT and exits MEMSEARCH_FAKE_EXIT. Set BEFORE importing memsearch.
const tmpRoot = mkdtempSync(join(tmpdir(), "memsearch-unit-"));
const binDir = join(tmpRoot, "bin");
mkdirSync(binDir, { recursive: true });
writeFileSync(
	join(binDir, "memsearch"),
	'#!/bin/sh\nif [ -n "$MEMSEARCH_FAKE_STDIN_FILE" ]; then cat > "$MEMSEARCH_FAKE_STDIN_FILE"; fi\nprintf "%s" "${MEMSEARCH_FAKE_STDOUT:-}"\nexit ${MEMSEARCH_FAKE_EXIT:-0}\n',
);
chmodSync(join(binDir, "memsearch"), 0o755);
process.env.PI_MEMSEARCH_LOCK_DIR = join(tmpRoot, "lock");
process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;

const { addSkillCandidate, buildExpandArgs, buildIndexArgs, buildResetArgs, buildSearchArgs, buildSkillsAddArgs, buildSkillsInstallArgs, buildStatsArgs, getStats, installSkill, isExpandResult, isMemoryChunk, resetMemory, searchMemory } = await import("./memsearch");

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

test("buildSearchArgs places the trusted --collection before -- (S1)", () => {
	const args = buildSearchArgs("q", 5, { collection: "ms_proj_abc12345" });
	const sep = args.indexOf("--");
	const ci = args.indexOf("--collection");
	assert.ok(ci !== -1 && ci < sep, "--collection precedes the separator");
	assert.equal(args[ci + 1], "ms_proj_abc12345");
});

test("buildSearchArgs combines provider + collection before -- (S1)", () => {
	const args = buildSearchArgs("q", 3, { provider: "onnx", collection: "ms_proj_abc12345" });
	const sep = args.indexOf("--");
	assert.deepEqual(args.slice(0, sep), ["search", "--top-k", "3", "--json-output", "--provider", "onnx", "--collection", "ms_proj_abc12345"]);
	assert.deepEqual(args.slice(sep), ["--", "q"]);
});

test("buildExpandArgs threads --collection before -- and keeps the hash after (S1)", () => {
	assert.deepEqual(buildExpandArgs("h", { collection: "ms_proj_abc12345" }), ["expand", "--json-output", "--collection", "ms_proj_abc12345", "--", "h"]);
	assert.deepEqual(buildExpandArgs("--evil"), ["expand", "--json-output", "--", "--evil"]); // no opts → unchanged
});

test("buildIndexArgs places provider + collection before -- and paths after (S1)", () => {
	assert.deepEqual(buildIndexArgs(["a.md"], { provider: "onnx", collection: "ms_proj_abc12345" }), ["index", "--provider", "onnx", "--collection", "ms_proj_abc12345", "--", "a.md"]);
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

test("buildSkillsAddArgs uses named flags + stdin body-file, no -- needed (Dec4/S1)", () => {
	assert.deepEqual(buildSkillsAddArgs("My Skill", "does X"), [
		"skills", "add", "--name", "My Skill", "--description", "does X", "--body-file", "-",
	]);
});

test("buildSkillsInstallArgs places the untrusted slug after -- with trusted --path before (S1)", () => {
	const args = buildSkillsInstallArgs("--evil", "/abs/.agents/skills");
	const sep = args.indexOf("--");
	assert.ok(sep !== -1, "a -- separator is present");
	assert.equal(args[sep + 1], "--evil", "the slug is the first arg after --");
	assert.deepEqual(args.slice(0, sep), ["skills", "install", "--path", "/abs/.agents/skills"]);
});

test("addSkillCandidate feeds the body via stdin and returns the parsed slug (Dec4)", async () => {
	const stdinCap = join(tmpRoot, "stdin-cap.txt");
	process.env.MEMSEARCH_FAKE_STDIN_FILE = stdinCap;
	process.env.MEMSEARCH_FAKE_EXIT = "0";
	process.env.MEMSEARCH_FAKE_STDOUT = "Added candidate skill: my-skill\nInstall it with: memsearch skills install my-skill --path <dir>";
	try {
		const slug = await addSkillCandidate("My Skill", "does X", "## Steps\n- run tests");
		assert.equal(slug, "my-skill");
		assert.equal(readFileSync(stdinCap, "utf8"), "## Steps\n- run tests", "the body was delivered on stdin");
	} finally {
		delete process.env.MEMSEARCH_FAKE_STDIN_FILE;
	}
});

test("addSkillCandidate throws when the slug line is absent", async () => {
	process.env.MEMSEARCH_FAKE_EXIT = "0";
	process.env.MEMSEARCH_FAKE_STDOUT = "unexpected output";
	await assert.rejects(addSkillCandidate("n", "d", "body"), /could not parse the candidate slug/);
});

test("installSkill returns the parsed absolute install path", async () => {
	process.env.MEMSEARCH_FAKE_EXIT = "0";
	process.env.MEMSEARCH_FAKE_STDOUT = "Installed: /abs/cwd/.agents/skills/my-skill/SKILL.md";
	const p = await installSkill("my-skill", "/abs/cwd/.agents/skills");
	assert.equal(p, "/abs/cwd/.agents/skills/my-skill/SKILL.md");
});

test("installSkill throws when the Installed: line is absent", async () => {
	process.env.MEMSEARCH_FAKE_EXIT = "0";
	process.env.MEMSEARCH_FAKE_STDOUT = "nothing useful";
	await assert.rejects(installSkill("my-skill", "/abs/cwd/.agents/skills"), /could not parse the installed path/);
});

test("addSkillCandidate rejects on a non-zero exit (failSkills path, Q1)", async () => {
	process.env.MEMSEARCH_FAKE_STDOUT = "";
	process.env.MEMSEARCH_FAKE_EXIT = "1";
	try {
		await assert.rejects(addSkillCandidate("n", "d", "body"), /skills add failed \(exit 1\)/);
	} finally {
		process.env.MEMSEARCH_FAKE_EXIT = "0";
	}
});

test("installSkill rejects on a non-zero exit (failSkills path, Q1)", async () => {
	process.env.MEMSEARCH_FAKE_STDOUT = "";
	process.env.MEMSEARCH_FAKE_EXIT = "1";
	try {
		await assert.rejects(installSkill("my-skill", "/abs/cwd/.agents/skills"), /skills install failed \(exit 1\)/);
	} finally {
		process.env.MEMSEARCH_FAKE_EXIT = "0";
	}
});

test("buildStatsArgs scopes by collection, no -- and no provider", () => {
	assert.deepEqual(buildStatsArgs({ collection: "ms_proj_abc12345" }), ["stats", "--collection", "ms_proj_abc12345"]);
	assert.deepEqual(buildStatsArgs(), ["stats"]);
	assert.deepEqual(buildStatsArgs({ provider: "onnx" }), ["stats"]); // stats does no embedding
});

test("buildResetArgs emits the LONG --yes + collection, omits provider, no -- (v0.4.10)", () => {
	assert.deepEqual(buildResetArgs({ collection: "ms_proj_abc12345", provider: "onnx" }), ["reset", "--yes", "--collection", "ms_proj_abc12345"]);
	const bare = buildResetArgs();
	assert.deepEqual(bare, ["reset", "--yes"]);
	assert.ok(!bare.includes("-y"), "no short -y (absent in v0.4.10)");
});

test("getStats parses the v0.4.10 single-line count", async () => {
	process.env.MEMSEARCH_FAKE_EXIT = "0";
	process.env.MEMSEARCH_FAKE_STDOUT = "Total indexed chunks: 142";
	assert.equal(await getStats(), 142);
});

test("getStats throws on unparseable output (version drift)", async () => {
	process.env.MEMSEARCH_FAKE_EXIT = "0";
	process.env.MEMSEARCH_FAKE_STDOUT = "something unexpected";
	await assert.rejects(getStats(), /could not parse the chunk count/);
});

test("getStats throws on a non-zero exit (fail path)", async () => {
	process.env.MEMSEARCH_FAKE_STDOUT = "";
	process.env.MEMSEARCH_FAKE_EXIT = "1";
	try {
		await assert.rejects(getStats(), /stats failed \(exit 1\)/);
	} finally {
		process.env.MEMSEARCH_FAKE_EXIT = "0";
	}
});

test("resetMemory drops then auto-reindexes the journals (D3), returning a status line", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "memsearch-reset-cwd-"));
	try {
		process.env.MEMSEARCH_FAKE_EXIT = "0";
		process.env.MEMSEARCH_FAKE_STDOUT = "Indexed 9 files";
		const out = await resetMemory({ cwd, collection: "ms_proj_abc12345" });
		assert.match(out, /Dropped collection and reindexed journals\./);
		assert.match(out, /Indexed 9 files/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("resetMemory with no cwd drops only, skipping the reindex (Q1)", async () => {
	process.env.MEMSEARCH_FAKE_EXIT = "0";
	process.env.MEMSEARCH_FAKE_STDOUT = "";
	assert.equal(await resetMemory({ collection: "ms_x" }), "Dropped collection (no cwd — skipped reindex).");
});

test("resetMemory throws on a non-zero reset exit (before reindex)", async () => {
	process.env.MEMSEARCH_FAKE_STDOUT = "";
	process.env.MEMSEARCH_FAKE_EXIT = "1";
	try {
		await assert.rejects(resetMemory({ cwd: tmpRoot, collection: "ms_x" }), /reset failed \(exit 1\)/);
	} finally {
		process.env.MEMSEARCH_FAKE_EXIT = "0";
	}
});
