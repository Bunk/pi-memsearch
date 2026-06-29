import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { dailyJournalPath } from "./journal";

// Hermetic harness: temp cwd, temp lock dir, fake `memsearch` on PATH (set BEFORE importing capture).
const tmpRoot = mkdtempSync(join(tmpdir(), "memsearch-capture-"));
const cwd = join(tmpRoot, "proj");
const binDir = join(tmpRoot, "bin");
mkdirSync(cwd, { recursive: true });
mkdirSync(binDir, { recursive: true });
writeFileSync(join(binDir, "memsearch"), "#!/bin/sh\nexit ${MEMSEARCH_FAKE_EXIT:-0}\n");
chmodSync(join(binDir, "memsearch"), 0o755);
process.env.PI_MEMSEARCH_LOCK_DIR = join(tmpRoot, "lock");
process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;

const { registerCapture, reconstructSets, resolveSummaryModel } = await import("./capture");

after(() => rmSync(tmpRoot, { recursive: true, force: true }));

type FakeEntry = { id: string; type: string; customType?: string; data?: unknown };
type Marker = { entryId: string; indexed?: boolean };

const exchange = [
	{ role: "user", content: "question text" },
	{ role: "assistant", content: [{ type: "text", text: "answer text" }] },
];

function makeHarness(harnessCwd = cwd) {
	const branch: FakeEntry[] = [];
	let leafId = "L1";
	const handlers: Record<string, (event: unknown, ctx: unknown) => Promise<unknown>> = {};
	const pi = {
		on: (name: string, fn: (event: unknown, ctx: unknown) => Promise<unknown>) => {
			handlers[name] = fn;
		},
		appendEntry: (customType: string, data: unknown) => {
			branch.push({ id: `c${branch.length}`, type: "custom", customType, data });
		},
		getFlag: () => undefined,
		registerFlag: () => {},
	};
	registerCapture(pi as unknown as ExtensionAPI);
	const ctx = {
		isProjectTrusted: () => true,
		hasUI: false,
		model: undefined,
		signal: undefined,
		sessionManager: {
			getLeafId: () => leafId,
			getCwd: () => harnessCwd,
			getSessionId: () => "sessTest",
			getSessionFile: () => join(harnessCwd, "sess.jsonl"),
			getBranch: () => branch,
		},
	};
	return {
		branch,
		setLeaf: (id: string) => {
			leafId = id;
		},
		agentEnd: (messages: unknown[]) => handlers.agent_end({ messages } as unknown, ctx as unknown as ExtensionContext),
		markers: (entryId: string): Marker[] =>
			branch
				.filter((e) => e.customType === "memsearch-capture")
				.map((e) => e.data as Marker)
				.filter((d) => d.entryId === entryId),
	};
}

test("reconstructSets rebuilds captured + indexed and derives pending", () => {
	const m = (entryId: string, indexed?: boolean): FakeEntry => ({
		id: `e-${entryId}-${indexed ? "i" : "j"}`,
		type: "custom",
		customType: "memsearch-capture",
		data: indexed === undefined ? { entryId } : { entryId, indexed },
	});
	const { captured, indexed } = reconstructSets(
		[m("a", false), m("a", true), m("b", false), m("c"), { id: "x", type: "message" }] as never,
	);
	assert.deepEqual([...captured].sort(), ["a", "b", "c"]);
	assert.deepEqual([...indexed].sort(), ["a"]);
	assert.deepEqual([...captured].filter((id) => !indexed.has(id)).sort(), ["b", "c"]);
});

test("reconstructSets ignores markers without entryId and other custom types", () => {
	const { captured } = reconstructSets([
		{ id: "1", type: "custom", customType: "memsearch-capture", data: {} },
		{ id: "2", type: "custom", customType: "other", data: { entryId: "z" } },
	] as never);
	assert.equal(captured.size, 0);
});

test("agent_end journals once, marks indexed on success, no double-append (I3)", async () => {
	process.env.MEMSEARCH_FAKE_EXIT = "0";
	const h = makeHarness();
	await h.agentEnd(exchange);

	const m1 = h.markers("L1");
	assert.ok(m1.some((d) => d.indexed === false), "journaled marker recorded");
	assert.ok(m1.some((d) => d.indexed === true), "indexed marker recorded after successful index");

	const file = dailyJournalPath(cwd, new Date());
	const count = () => (readFileSync(file, "utf8").match(/session:sessTest turn:L1/g) ?? []).length;
	assert.equal(count(), 1, "exactly one journal block for L1");

	await h.agentEnd(exchange); // same leaf → captured set skips re-journaling
	assert.equal(count(), 1, "no duplicate journal block on a repeated agent_end");
});

test("a failed index leaves indexed:false and retries on the next agent_end (I4)", async () => {
	process.env.MEMSEARCH_FAKE_EXIT = "1"; // index fails
	const h = makeHarness();
	h.setLeaf("L2");
	await h.agentEnd(exchange);
	let m = h.markers("L2");
	assert.ok(m.some((d) => d.indexed === false), "journaled marker present");
	assert.ok(!m.some((d) => d.indexed === true), "not marked indexed while index fails");

	process.env.MEMSEARCH_FAKE_EXIT = "0"; // index now succeeds
	await h.agentEnd(exchange); // same leaf L2 → journaling skipped, pending re-indexed
	m = h.markers("L2");
	assert.ok(m.some((d) => d.indexed === true), "pending entry indexed on retry");
});

test("a journal-write failure records no marker, retries, and never indexes the exchange (I3)", async () => {
	process.env.MEMSEARCH_FAKE_EXIT = "0";
	const badCwd = join(tmpRoot, "badproj");
	mkdirSync(badCwd, { recursive: true });
	// Put a regular FILE where the .memsearch dir must be so ensureDailyFile's mkdir throws (ENOTDIR).
	writeFileSync(join(badCwd, ".memsearch"), "x");
	const h = makeHarness(badCwd);
	h.setLeaf("LF");
	await h.agentEnd(exchange);
	assert.equal(h.markers("LF").length, 0, "no marker recorded when the journal write fails");

	// Recover: remove the blocking file; the retry journals and only then records markers.
	rmSync(join(badCwd, ".memsearch"));
	await h.agentEnd(exchange);
	const m = h.markers("LF");
	assert.ok(m.some((d) => d.indexed === false), "journaled marker recorded on retry");
	assert.ok(m.some((d) => d.indexed === true), "indexed only after a successful journal append");
});

test("a crash that loses the marker does not double-append on retry (I3 idempotency)", async () => {
	process.env.MEMSEARCH_FAKE_EXIT = "0";
	const crashCwd = join(tmpRoot, "crashproj");
	mkdirSync(crashCwd, { recursive: true });
	const h1 = makeHarness(crashCwd);
	h1.setLeaf("LC");
	await h1.agentEnd(exchange);
	const file = dailyJournalPath(crashCwd, new Date());
	const count = () => (readFileSync(file, "utf8").match(/session:sessTest turn:LC /g) ?? []).length;
	assert.equal(count(), 1, "one journal block after first capture");

	// Simulate a crash that dropped the marker: a fresh harness (empty in-memory sets) re-fires
	// agent_end for the same leaf. journalHasEntry must skip the re-append.
	const h2 = makeHarness(crashCwd);
	h2.setLeaf("LC");
	await h2.agentEnd(exchange);
	assert.equal(count(), 1, "no duplicate journal block after a marker-loss retry");
});

test("concurrent agent_end for one leaf writes exactly one block + one header (I1/I2)", async () => {
	process.env.MEMSEARCH_FAKE_EXIT = "0";
	const conCwd = join(tmpRoot, "concproj");
	mkdirSync(conCwd, { recursive: true });
	// two independent harnesses = two processes sharing one cwd / daily file
	const a = makeHarness(conCwd);
	const b = makeHarness(conCwd);
	a.setLeaf("LX");
	b.setLeaf("LX");
	await Promise.all([a.agentEnd(exchange), b.agentEnd(exchange)]);
	const file = dailyJournalPath(conCwd, new Date());
	const content = readFileSync(file, "utf8");
	const blocks = (content.match(/<!-- session:sessTest turn:LX /g) ?? []).length;
	const headers = (content.match(/^## Session /gm) ?? []).length;
	assert.equal(blocks, 1, "exactly one journal block despite concurrent agent_end");
	assert.equal(headers, 1, "exactly one session header (combined header+block append)");
});

test("agent_end is a no-op in an untrusted project (I2)", async () => {
	process.env.MEMSEARCH_FAKE_EXIT = "0";
	const branch: FakeEntry[] = [];
	const handlers: Record<string, (event: unknown, ctx: unknown) => Promise<unknown>> = {};
	const pi = {
		on: (name: string, fn: (event: unknown, ctx: unknown) => Promise<unknown>) => {
			handlers[name] = fn;
		},
		appendEntry: (customType: string, data: unknown) => branch.push({ id: `c${branch.length}`, type: "custom", customType, data }),
		getFlag: () => undefined,
		registerFlag: () => {},
	};
	registerCapture(pi as unknown as ExtensionAPI);
	const ctx = {
		isProjectTrusted: () => false,
		hasUI: false,
		model: undefined,
		signal: undefined,
		sessionManager: { getLeafId: () => "L9", getCwd: () => cwd, getSessionId: () => "s", getSessionFile: () => "", getBranch: () => branch },
	};
	await handlers.agent_end({ messages: exchange } as unknown, ctx as unknown as ExtensionContext);
	assert.equal(branch.length, 0, "untrusted project writes no bookkeeping");
});

// --- resolveSummaryModel (cheap-model pin) -------------------------------------------------------

const M_HAIKU = { provider: "anthropic", id: "claude-haiku-4-5" };
const M_GPT = { provider: "openai", id: "gpt-5-mini" };
const ALL_MODELS = [M_HAIKU, M_GPT, { provider: "bedrock", id: "claude-haiku-4-5" }]; // dup id across providers

function modelCtx() {
	return {
		modelRegistry: {
			getAll: () => ALL_MODELS,
			find: (provider: string, id: string) => ALL_MODELS.find((m) => m.provider === provider && m.id === id),
		},
	} as unknown as ExtensionContext;
}
const flagPi = (ref?: string) => ({ getFlag: () => ref }) as unknown as ExtensionAPI;

test("resolveSummaryModel returns undefined when the flag is unset (use ctx.model)", () => {
	assert.equal(resolveSummaryModel(flagPi(undefined), modelCtx()), undefined);
	assert.equal(resolveSummaryModel(flagPi("   "), modelCtx()), undefined); // blank trims to unset
});

test("resolveSummaryModel resolves a provider/modelId reference", () => {
	assert.equal(resolveSummaryModel(flagPi("openai/gpt-5-mini"), modelCtx()), M_GPT);
});

test("resolveSummaryModel resolves an unambiguous bare model id", () => {
	assert.equal(resolveSummaryModel(flagPi("gpt-5-mini"), modelCtx()), M_GPT);
});

test("resolveSummaryModel returns undefined for an ambiguous bare id (dup across providers)", () => {
	assert.equal(resolveSummaryModel(flagPi("claude-haiku-4-5"), modelCtx()), undefined);
});

test("resolveSummaryModel returns undefined for an unknown reference", () => {
	assert.equal(resolveSummaryModel(flagPi("openai/nope"), modelCtx()), undefined);
	assert.equal(resolveSummaryModel(flagPi("nope"), modelCtx()), undefined);
});
