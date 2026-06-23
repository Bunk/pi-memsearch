import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	digestChanged,
	intervalElapsed,
	isDue,
	maintenanceStatePath,
	readState,
	type TaskState,
	updateTaskState,
} from "./maintenance-state";

const HOUR = 3_600_000;

test("digestChanged: never-run changed; equal unchanged; different changed", () => {
	const s: TaskState = { last_success_at: new Date().toISOString(), last_input_digest: "sha256:a", last_action: "none" };
	assert.equal(digestChanged(undefined, "sha256:a"), true);
	assert.equal(digestChanged(s, "sha256:a"), false);
	assert.equal(digestChanged(s, "sha256:b"), true);
});

test("intervalElapsed: never-run/unparseable elapsed; within not; past elapsed", () => {
	const now = Date.now();
	assert.equal(intervalElapsed(undefined, 24 * HOUR, now), true);
	const recent: TaskState = { last_success_at: new Date(now - HOUR).toISOString(), last_input_digest: "x", last_action: "none" };
	assert.equal(intervalElapsed(recent, 24 * HOUR, now), false);
	const old: TaskState = { last_success_at: new Date(now - 25 * HOUR).toISOString(), last_input_digest: "x", last_action: "none" };
	assert.equal(intervalElapsed(old, 24 * HOUR, now), true);
	const bad: TaskState = { last_success_at: "not-a-date", last_input_digest: "x", last_action: "none" };
	assert.equal(intervalElapsed(bad, 24 * HOUR, now), true);
});

test("isDue requires both a changed digest AND an elapsed interval", () => {
	const now = Date.now();
	assert.equal(isDue(undefined, "sha256:a", 24 * HOUR, now), true);
	const old: TaskState = { last_success_at: new Date(now - 25 * HOUR).toISOString(), last_input_digest: "sha256:a", last_action: "none" };
	assert.equal(isDue(old, "sha256:a", 24 * HOUR, now), false);
	assert.equal(isDue(old, "sha256:b", 24 * HOUR, now), true);
	const recent: TaskState = { last_success_at: new Date(now - HOUR).toISOString(), last_input_digest: "sha256:a", last_action: "none" };
	assert.equal(isDue(recent, "sha256:b", 24 * HOUR, now), false);
});

test("readState returns {} for missing/corrupt and drops invalid task entries", async () => {
	const dir = await mkdtemp(join(tmpdir(), "ms-state-"));
	try {
		assert.deepEqual(await readState(dir), {});
		await mkdir(join(dir, ".memsearch"), { recursive: true });
		await writeFile(maintenanceStatePath(dir), "{not json", "utf8");
		assert.deepEqual(await readState(dir), {});
		await writeFile(
			maintenanceStatePath(dir),
			JSON.stringify({
				project_review: { last_success_at: "x" },
				user_profile: { last_success_at: "2026-01-01T00:00:00Z", last_input_digest: "sha256:z", last_action: "none" },
			}),
			"utf8",
		);
		const st = await readState(dir);
		assert.equal(st.project_review, undefined);
		assert.equal(st.user_profile?.last_input_digest, "sha256:z");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("updateTaskState merges, persists, and preserves the other task (I1)", async () => {
	const dir = await mkdtemp(join(tmpdir(), "ms-state2-"));
	try {
		const pr: TaskState = { last_success_at: "2026-01-01T00:00:00.000Z", last_input_digest: "sha256:p", last_action: "replace" };
		const up: TaskState = { last_success_at: "2026-01-02T00:00:00.000Z", last_input_digest: "sha256:u", last_action: "none" };
		await updateTaskState(dir, "project_review", pr);
		await updateTaskState(dir, "user_profile", up);
		const st = await readState(dir);
		assert.deepEqual(st.project_review, pr);
		assert.deepEqual(st.user_profile, up);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
