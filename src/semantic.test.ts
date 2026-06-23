import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { digestJournals, ensureDailyFile } from "./journal";
import { readState } from "./maintenance-state";
import {
	applyMaintenanceResult,
	parseMaintenanceResult,
	PROJECT_REVIEW_FLAG,
	readSemanticNotes,
	runDueSemanticTasks,
	USER_PROFILE_FLAG,
} from "./semantic";

const HOUR = 3_600_000;

function fakePi(flags: Record<string, unknown>): ExtensionAPI {
	return { getFlag: (n: string) => flags[n], registerFlag: () => {}, on: () => {} } as unknown as ExtensionAPI;
}
function fakeCtx(cwd: string, trusted = true): ExtensionContext {
	return {
		isProjectTrusted: () => trusted,
		hasUI: false,
		model: undefined,
		signal: undefined,
		sessionManager: { getCwd: () => cwd },
	} as unknown as ExtensionContext;
}
async function seedJournal(cwd: string): Promise<void> {
	const file = await ensureDailyFile(cwd, new Date());
	await writeFile(file, "# day\n\n### 10:00\n- did a thing\n", "utf8");
}

test("parseMaintenanceResult accepts valid contracts and rejects drift", () => {
	assert.equal(parseMaintenanceResult('{"action":"none","reason":"x"}')?.action, "none");
	assert.equal(parseMaintenanceResult('{"action":"replace","content":"# A"}')?.action, "replace");
	assert.equal(parseMaintenanceResult("```json\n{\"action\":\"none\"}\n```")?.action, "none");
	assert.equal(parseMaintenanceResult('{"action":"replace"}'), null, "replace without content is invalid");
	assert.equal(parseMaintenanceResult('{"action":"replace","content":""}'), null, "empty replace content is invalid (no clobber)");
	assert.equal(parseMaintenanceResult('{"action":"replace","content":"   "}'), null, "whitespace-only replace content is invalid");
	assert.equal(parseMaintenanceResult('{"action":"bogus"}'), null);
	assert.equal(parseMaintenanceResult("not json"), null);
	assert.equal(parseMaintenanceResult(""), null);
});

test("applyMaintenanceResult writes the note on replace and records state", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "sem-apply-"));
	try {
		await applyMaintenanceResult(
			cwd,
			"project_review",
			{ action: "replace", content: "# Project Memory\n## Current Direction\nship it" },
			"sha256:d",
			Date.UTC(2026, 0, 1),
		);
		assert.equal(existsSync(join(cwd, ".memsearch", "PROJECT.md")), true);
		const st = await readState(cwd);
		assert.equal(st.project_review?.last_action, "replace");
		assert.equal(st.project_review?.last_input_digest, "sha256:d");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("applyMaintenanceResult on 'none' records state without writing the note", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "sem-none-"));
	try {
		await applyMaintenanceResult(cwd, "user_profile", { action: "none" }, "sha256:e", Date.UTC(2026, 0, 1));
		assert.equal(existsSync(join(cwd, ".memsearch", "USER.md")), false);
		const st = await readState(cwd);
		assert.equal(st.user_profile?.last_action, "none");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("write-then-mark: a failed note write records no state (D8/I3)", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "sem-writefail-"));
	try {
		// Put a regular FILE where .memsearch/ must be so the note mkdir/write throws.
		await writeFile(join(cwd, ".memsearch"), "x", "utf8");
		await assert.rejects(
			applyMaintenanceResult(cwd, "project_review", { action: "replace", content: "# Project Memory\n" }, "sha256:d", Date.now()),
		);
		assert.deepEqual(await readState(cwd), {}, "no state recorded when the note write fails");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("readSemanticNotes is empty without notes and combines present notes", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "sem-read-"));
	try {
		assert.equal(await readSemanticNotes(cwd), "");
		await mkdir(join(cwd, ".memsearch"), { recursive: true });
		await writeFile(join(cwd, ".memsearch", "PROJECT.md"), "# Project Memory\n## Current Direction\nX\n", "utf8");
		const out = await readSemanticNotes(cwd);
		assert.match(out, /Durable project & user memory/);
		assert.match(out, /# Project Memory/);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("runDueSemanticTasks is a no-op with no flags (no state, no note)", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "sem-noflag-"));
	try {
		await seedJournal(cwd);
		await runDueSemanticTasks(fakePi({}), fakeCtx(cwd), Date.now());
		assert.deepEqual(await readState(cwd), {});
		assert.equal(existsSync(join(cwd, ".memsearch", "PROJECT.md")), false);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("runDueSemanticTasks with a flag but no model writes nothing and records no state (D8)", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "sem-nomodel-"));
	try {
		await seedJournal(cwd);
		await runDueSemanticTasks(fakePi({ [PROJECT_REVIEW_FLAG]: true }), fakeCtx(cwd), Date.now());
		assert.equal(existsSync(join(cwd, ".memsearch", "PROJECT.md")), false, "no model => no note");
		assert.deepEqual(await readState(cwd), {}, "failed run records nothing (retries)");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("digest gate: an unchanged digest is not re-run (state untouched)", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "sem-digest-"));
	try {
		await seedJournal(cwd);
		const digest = await digestJournals(cwd, 12);
		const oldMs = Date.now() - 100 * HOUR;
		await applyMaintenanceResult(cwd, "project_review", { action: "none" }, digest, oldMs);
		const before = (await readState(cwd)).project_review?.last_success_at;
		await runDueSemanticTasks(fakePi({ [PROJECT_REVIEW_FLAG]: true }), fakeCtx(cwd), Date.now());
		assert.equal((await readState(cwd)).project_review?.last_success_at, before, "unchanged digest => not re-run");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("interval gate: within the interval, not re-run even if the digest changed", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "sem-interval-"));
	try {
		await seedJournal(cwd);
		const recentMs = Date.now();
		await applyMaintenanceResult(cwd, "user_profile", { action: "none" }, "sha256:stale", recentMs);
		await runDueSemanticTasks(
			fakePi({ [USER_PROFILE_FLAG]: true, "memsearch-review-interval-hours": "24" }),
			fakeCtx(cwd),
			recentMs + HOUR,
		);
		assert.equal((await readState(cwd)).user_profile?.last_input_digest, "sha256:stale", "within interval => not re-run");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
