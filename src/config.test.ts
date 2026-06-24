import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

// Hermetic harness: fake `memsearch` on PATH echoing MEMSEARCH_FAKE_STDOUT / exit MEMSEARCH_FAKE_EXIT.
const tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "memsearch-config-")));
const binDir = join(tmpRoot, "bin");
mkdirSync(binDir, { recursive: true });
// Subcommand-aware fake: the `index` subcommand honors MEMSEARCH_FAKE_EXIT_INDEX / _STDOUT_INDEX so a
// reset can drop OK (reset exit 0) while its post-drop reindex fails (index exit 1) — drives Q1's
// reindex-fail catch. Every other subcommand falls back to the shared MEMSEARCH_FAKE_* vars.
writeFileSync(
	join(binDir, "memsearch"),
	'#!/bin/sh\ncase "$1" in\n  index) printf "%s" "${MEMSEARCH_FAKE_STDOUT_INDEX:-${MEMSEARCH_FAKE_STDOUT:-}}"; exit "${MEMSEARCH_FAKE_EXIT_INDEX:-${MEMSEARCH_FAKE_EXIT:-0}}";;\n  *) printf "%s" "${MEMSEARCH_FAKE_STDOUT:-}"; exit "${MEMSEARCH_FAKE_EXIT:-0}";;\nesac\n',
);
chmodSync(join(binDir, "memsearch"), 0o755);
process.env.PI_MEMSEARCH_LOCK_DIR = join(tmpRoot, "lock");
process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;

const { MEMORY_CONFIG_PATH, formatStatusReport, registerConfigSurfaces } = await import("./config");

after(() => rmSync(tmpRoot, { recursive: true, force: true }));

interface CmdDef { description: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>; }

function fakePi() {
	const commands = new Map<string, CmdDef>();
	const sent: Array<{ customType?: string; content: string }> = [];
	const pi = {
		registerCommand: (name: string, def: CmdDef) => commands.set(name, def),
		sendMessage: (m: { customType?: string; content: string }) => sent.push(m),
		getFlag: () => undefined,
		on: () => {},
		registerTool: () => {},
		registerFlag: () => {},
	} as unknown as ExtensionAPI;
	return { pi, commands, sent };
}

function fakeCtx(cwd: string, o: { trusted?: boolean; hasUI?: boolean; confirm?: boolean } = {}) {
	const notes: Array<[string, string]> = [];
	const ctx = {
		isProjectTrusted: () => o.trusted ?? true,
		hasUI: o.hasUI ?? true,
		sessionManager: { getCwd: () => cwd },
		ui: { notify: (m: string, l?: string) => notes.push([m, l ?? "info"]), confirm: async () => o.confirm ?? true },
	} as unknown as ExtensionCommandContext;
	return { ctx, notes };
}

test("MEMORY_CONFIG_PATH targets assets/memory-config/SKILL.md (shape only — file ships in Phase 4)", () => {
	assert.ok(MEMORY_CONFIG_PATH.endsWith(join("assets", "memory-config", "SKILL.md")), MEMORY_CONFIG_PATH);
});

test("formatStatusReport renders all fields deterministically (pure, no spawn)", () => {
	const out = formatStatusReport({
		provider: "onnx",
		collection: "ms_proj_abc12345",
		chunks: 7,
		journals: ["2026-06-22.md", "2026-06-23.md"],
		notes: [
			// local-component Date so formatDate/formatTime are deterministic regardless of machine TZ
			{ id: "project_review", file: "PROJECT.md", path: "/x/PROJECT.md", exists: true, mtime: new Date(2026, 5, 23, 14, 2) },
			{ id: "user_profile", file: "USER.md", path: "/x/USER.md", exists: false, mtime: null },
		],
		state: { project_review: { last_success_at: "2026-06-23T14:02:00Z", last_input_digest: "sha256:d", last_action: "replace" } },
		enabled: ["project_review"],
		intervalHours: 24,
	});
	assert.match(out, /Provider: onnx \(pinned/);
	assert.match(out, /Collection: ms_proj_abc12345/);
	assert.match(out, /Indexed chunks: 7/);
	assert.match(out, /Journals: 2 daily files \(newest 2026-06-23\)/);
	assert.match(out, /project_review ✓, user_profile ✗ · interval 24h/);
	assert.match(out, /PROJECT.md ✓ \(2026-06-23 14:02\), USER.md ✗/);
});

test("/memory-status is a no-op (no report) in an untrusted project (I2)", async () => {
	const { pi, commands, sent } = fakePi();
	registerConfigSurfaces(pi);
	await commands.get("memory-status")!.handler("", fakeCtx(tmpRoot, { trusted: false }).ctx);
	assert.equal(sent.length, 0);
});

test("/memory-status renders a report with the parsed chunk count", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "memsearch-status-ok-"));
	try {
		process.env.MEMSEARCH_FAKE_EXIT = "0";
		process.env.MEMSEARCH_FAKE_STDOUT = "Total indexed chunks: 7";
		const { pi, commands, sent } = fakePi();
		registerConfigSurfaces(pi);
		await commands.get("memory-status")!.handler("", fakeCtx(cwd).ctx);
		assert.equal(sent.length, 1);
		assert.equal(sent[0].customType, "memsearch-status");
		assert.match(sent[0].content, /Indexed chunks: 7/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("/memory-status renders DEGRADED when the CLI fails (Dec11)", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "memsearch-status-degraded-"));
	try {
		process.env.MEMSEARCH_FAKE_STDOUT = "";
		process.env.MEMSEARCH_FAKE_EXIT = "1";
		const { pi, commands, sent } = fakePi();
		registerConfigSurfaces(pi);
		await commands.get("memory-status")!.handler("", fakeCtx(cwd).ctx);
		assert.equal(sent.length, 1, "report still rendered despite CLI failure");
		assert.match(sent[0].content, /Indexed chunks: unavailable/);
	} finally {
		process.env.MEMSEARCH_FAKE_EXIT = "0";
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("/memory-reset cancels without dropping when the user declines (Dec10)", async () => {
	const { pi, commands, sent } = fakePi();
	registerConfigSurfaces(pi);
	const { ctx, notes } = fakeCtx(tmpRoot, { confirm: false });
	await commands.get("memory-reset")!.handler("", ctx);
	assert.equal(sent.length, 0, "no reset message — drop not performed");
	assert.ok(notes.some(([m]) => /cancelled/i.test(m)), "user told it was cancelled");
});

test("/memory-reset drops + reindexes after confirmation (Dec10/D3)", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "memsearch-reset-ok-"));
	try {
		process.env.MEMSEARCH_FAKE_EXIT = "0";
		process.env.MEMSEARCH_FAKE_STDOUT = "Indexed 3 files";
		const { pi, commands, sent } = fakePi();
		registerConfigSurfaces(pi);
		await commands.get("memory-reset")!.handler("", fakeCtx(cwd, { confirm: true }).ctx);
		assert.equal(sent.length, 1);
		assert.equal(sent[0].customType, "memsearch-reset");
		assert.match(sent[0].content, /Dropped collection and reindexed journals\./);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("formatStatusReport flags a broken-empty index — 0 chunks but journals exist (I2)", () => {
	const out = formatStatusReport({
		provider: "onnx",
		collection: "ms_proj_abc12345",
		chunks: 0,
		journals: ["2026-06-22.md", "2026-06-23.md"],
		notes: [],
		state: {},
		enabled: [],
		intervalHours: 24,
	});
	assert.match(out, /Indexed chunks: 0 ⚠ 2 journal files exist but nothing is indexed — run \/memory-reset/);
});

test("formatStatusReport renders a plain 0 for a genuinely empty project — no journals (I2)", () => {
	const out = formatStatusReport({ provider: "onnx", collection: "ms_x", chunks: 0, journals: [], notes: [], state: {}, enabled: [], intervalHours: 24 });
	assert.match(out, /^Indexed chunks: 0$/m);
	assert.doesNotMatch(out, /⚠/);
});

test("/memory-reset refuses (no drop) when there is no dialog-capable UI (Q1)", async () => {
	process.env.MEMSEARCH_FAKE_EXIT = "0";
	const { pi, commands, sent } = fakePi();
	registerConfigSurfaces(pi);
	const { ctx } = fakeCtx(tmpRoot, { hasUI: false });
	await commands.get("memory-reset")!.handler("", ctx);
	assert.equal(sent.length, 0, "no reset performed without a confirm-capable UI");
});

test("/memory-reset surfaces a recovery hint when the post-drop reindex fails (Q1/I2)", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "memsearch-reset-reindexfail-"));
	try {
		process.env.MEMSEARCH_FAKE_EXIT = "0"; // reset (drop) succeeds
		process.env.MEMSEARCH_FAKE_EXIT_INDEX = "1"; // post-drop reindex fails
		process.env.MEMSEARCH_FAKE_STDOUT = "";
		const { pi, commands, sent } = fakePi();
		registerConfigSurfaces(pi);
		const { ctx, notes } = fakeCtx(cwd, { confirm: true });
		await commands.get("memory-reset")!.handler("", ctx);
		assert.equal(sent.length, 0, "no success message when the reindex failed");
		assert.ok(
			notes.some(([m, l]) => l === "error" && /reindex failed/i.test(m) && /Re-run \/memory-reset/.test(m)),
			"recovery hint surfaced (collection dropped; re-run to rebuild)",
		);
	} finally {
		delete process.env.MEMSEARCH_FAKE_EXIT_INDEX;
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("/memory-reset is a no-op in an untrusted project (I2)", async () => {
	const { pi, commands, sent } = fakePi();
	registerConfigSurfaces(pi);
	await commands.get("memory-reset")!.handler("", fakeCtx(tmpRoot, { trusted: false }).ctx);
	assert.equal(sent.length, 0);
});
