/**
 * Project-global maintenance state for the semantic-memory tasks (D2).
 *
 * Tracks, per task, the last successful run's input digest + timestamp + action in
 * <cwd>/.memsearch/.maintenance-state.json. The journal digest is cross-session / project-global,
 * so this lives in a file (mirrors upstream maintenance.py), not pi session entries. The
 * read-modify-write is serialized with withFileLock (I1) so two cwd-sharing processes can't clobber
 * the file. A failed task run updates nothing for that task (D8) so it retries next due agent_end.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { withFileLock } from "./lock";

export type MaintenanceTaskId = "project_review" | "user_profile" | "live_reindex";

/** Per-task record of the last successful run. */
export interface TaskState {
	last_success_at: string; // ISO-8601
	last_input_digest: string; // "sha256:..."
	last_action: "replace" | "none";
}

/** The on-disk state: a record keyed by task id. */
export type MaintenanceState = Partial<Record<MaintenanceTaskId, TaskState>>;

const TASK_IDS: readonly MaintenanceTaskId[] = ["project_review", "user_profile", "live_reindex"];

/** Absolute path to the project-global state file (sibling of memory/, mirrors upstream). */
export function maintenanceStatePath(cwd: string): string {
	return join(cwd, ".memsearch", ".maintenance-state.json");
}

/** Boundary guard for a persisted TaskState (the file is hand-editable). */
function isTaskState(x: unknown): x is TaskState {
	if (!x || typeof x !== "object") return false;
	const t = x as Record<string, unknown>;
	return (
		typeof t.last_success_at === "string" &&
		typeof t.last_input_digest === "string" &&
		(t.last_action === "replace" || t.last_action === "none")
	);
}

/** Read + validate the state file. Missing / corrupt / partial → {} (treated as never-run). */
export async function readState(cwd: string): Promise<MaintenanceState> {
	let raw: string;
	try {
		raw = await readFile(maintenanceStatePath(cwd), "utf8");
	} catch {
		return {};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return {};
	}
	if (!parsed || typeof parsed !== "object") return {};
	const out: MaintenanceState = {};
	for (const id of TASK_IDS) {
		const v = (parsed as Record<string, unknown>)[id];
		if (isTaskState(v)) out[id] = v;
	}
	return out;
}

/**
 * Lock-guarded read-modify-write (I1): set one task's state and persist. Re-reads under the lock so
 * a concurrent writer's update to the OTHER task is not lost. Returns the merged state.
 */
export async function updateTaskState(cwd: string, task: MaintenanceTaskId, next: TaskState): Promise<MaintenanceState> {
	const path = maintenanceStatePath(cwd);
	await mkdir(dirname(path), { recursive: true });
	return withFileLock(`${path}.lock`, async () => {
		const current = await readState(cwd);
		const merged: MaintenanceState = { ...current, [task]: next };
		await writeFile(path, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
		return merged;
	});
}

/** Pure: has the journal digest changed since the last successful run? Never-run → changed. */
export function digestChanged(state: TaskState | undefined, digest: string): boolean {
	return !state || state.last_input_digest !== digest;
}

/** Pure: has at least min-interval elapsed since the last run? Never-run / unparseable → elapsed. */
export function intervalElapsed(state: TaskState | undefined, intervalMs: number, now: number): boolean {
	if (!state) return true;
	const last = Date.parse(state.last_success_at);
	if (Number.isNaN(last)) return true;
	return now - last >= Math.max(0, intervalMs);
}

/** Pure due-decision (D7): due iff the digest changed AND the interval elapsed. Never-run → due. */
export function isDue(state: TaskState | undefined, digest: string, intervalMs: number, now: number): boolean {
	return digestChanged(state, digest) && intervalElapsed(state, intervalMs, now);
}
