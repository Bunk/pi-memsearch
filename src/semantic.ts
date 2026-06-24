/**
 * Semantic-memory layer (gap #3): two opt-in maintenance tasks that synthesize durable notes from
 * the episodic journals via a gated complete() call.
 *
 * - project_review -> .memsearch/PROJECT.md   - user_profile -> .memsearch/USER.md
 *
 * Trigger (D5): runDueSemanticTasks runs from an agent_end handler registered AFTER registerCapture
 * (so the journal capture wrote this turn is visible). It is cheap when not due: with no task flag
 * set it returns immediately; otherwise it reads the small state file, skips unless a task's
 * min-interval elapsed (no journal hashing), and only then hashes journals once and (if the digest
 * changed) calls the model. The synthesis goes through runCompletion (a DIRECT model call), which
 * does not run the agent loop and cannot re-fire agent_end (same rationale as capture).
 *
 * Contract (D1): the model returns {action:"none"|"replace", reason?, content?}, validated at the
 * boundary by isMaintenanceResult before anything is written. Notes use upstream's section shape.
 *
 * Write-then-mark (D8/I3): on "replace" the note file is written FIRST, then the task's state entry
 * is recorded; any failure (no model, parse/validation failure, write failure) records nothing for
 * that task so it retries next due agent_end. Trust-gated (I2) like every other auto-firing path.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { runCompletion } from "./completion";
import { digestJournals, readRecentJournals } from "./journal";
import { withFileLock } from "./lock";
import { intervalElapsed, isDue, type MaintenanceTaskId, readState, updateTaskState } from "./maintenance-state";

export const PROJECT_REVIEW_FLAG = "memsearch-project-review";
export const USER_PROFILE_FLAG = "memsearch-user-profile";
export const REVIEW_INTERVAL_FLAG = "memsearch-review-interval-hours";

// Synthesis is a bigger prompt than capture's one-exchange summary, but a due agent_end already
// awaits capture's 60s summarize first, so cap synthesis at 90s to keep the worst-case stacked
// foreground block ~150s rather than ~180s (Step-9 finding #3).
const SYNTHESIS_TIMEOUT_MS = 90_000;
const RECENT_JOURNAL_LIMIT = 12;
const DEFAULT_INTERVAL_HOURS = 24;
const HOUR_MS = 3_600_000;

/** The model's maintenance response (upstream contract). */
export interface MaintenanceResult {
	action: "none" | "replace";
	reason?: string;
	content?: string;
}

interface SemanticTask {
	id: MaintenanceTaskId;
	file: string; // note filename under .memsearch/
	instruction: string;
}

const PROJECT_REVIEW_INSTRUCTION = [
	"You maintain a durable PROJECT memory file for this project, summarizing STABLE project state",
	"from recent work journals. Treat journal lines about decisions, progress, risks, constraints,",
	"active threads, open questions, and next steps as project state. Keep user-level preferences OUT",
	"(those belong in USER.md).",
	"",
	"Return ONLY a JSON object — no prose, no code fence:",
	'{"action":"none","reason":"..."}  when recent journals do not change durable project state, or',
	'{"action":"replace","reason":"...","content":"<full updated markdown>"}  when they do.',
	"",
	"When replacing, output the COMPLETE file as `content`. Preserve useful existing content; prefer",
	"small targeted additions over broad rewrites; do not rewrite for style. Use only the sections that",
	"are useful, drawn from:",
	"# Project Memory",
	"## Current Direction",
	"## Active Threads",
	"## Recent Progress",
	"## Decisions",
	"## Open Questions",
	"## Risks and Constraints",
	"## Next Steps",
	"## Cold Items",
].join("\n");

const USER_PROFILE_INSTRUCTION = [
	"You maintain a conservative USER / workflow profile for this user, capturing DURABLE preferences",
	"from recent work journals. Update only on stable evidence of durable preferences, priorities,",
	"constraints, or repeated workflows. Do not infer broad personality traits from one-off messages.",
	"Keep project state OUT (that belongs in PROJECT.md).",
	"",
	"Return ONLY a JSON object — no prose, no code fence:",
	'{"action":"none","reason":"..."}  when recent journals do not change the durable profile, or',
	'{"action":"replace","reason":"...","content":"<full updated markdown>"}  when they do.',
	"",
	"When replacing, output the COMPLETE file as `content`. Preserve useful existing content; prefer",
	"small targeted additions over broad rewrites. Use only the sections that are useful, drawn from:",
	"# User Memory",
	"## Priorities",
	"## Preferences",
	"## Working Style",
	"## Technical Defaults",
	"## Communication Notes",
	"## Repeated Workflows",
	"## Constraints",
].join("\n");

const TASKS: Record<MaintenanceTaskId, SemanticTask> = {
	project_review: { id: "project_review", file: "PROJECT.md", instruction: PROJECT_REVIEW_INSTRUCTION },
	user_profile: { id: "user_profile", file: "USER.md", instruction: USER_PROFILE_INSTRUCTION },
};

/** Absolute path to a task's note file (.memsearch/PROJECT.md | USER.md — sibling of memory/). */
function notePath(cwd: string, task: SemanticTask): string {
	return join(cwd, ".memsearch", task.file);
}

/** Strip a leading/trailing ```json fence the model may add around the JSON. */
function stripCodeFence(s: string): string {
	const m = s.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/);
	return m ? m[1].trim() : s;
}

/** Boundary guard for the model's maintenance response (D1). */
export function isMaintenanceResult(x: unknown): x is MaintenanceResult {
	if (!x || typeof x !== "object") return false;
	const r = x as Record<string, unknown>;
	if (r.action !== "none" && r.action !== "replace") return false;
	// A "replace" MUST carry non-empty content: a degenerate {action:"replace",content:""} would
	// otherwise clobber a previously-good note with an empty file (Step-9 finding #2). Reject it so
	// the run is treated as a failure (no clobber, retries).
	if (r.action === "replace" && !(typeof r.content === "string" && r.content.trim().length > 0)) return false;
	return true;
}

/** Parse + validate the model output into a MaintenanceResult, or null on any drift. */
export function parseMaintenanceResult(raw: string): MaintenanceResult | null {
	const trimmed = stripCodeFence(raw.trim());
	if (!trimmed) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return null;
	}
	return isMaintenanceResult(parsed) ? parsed : null;
}

function buildMaintenancePrompt(task: SemanticTask, recentJournals: string, existingNote: string): string {
	return (
		`${task.instruction}\n\n` +
		`<existing_note>\n${existingNote || "(none yet)"}\n</existing_note>\n\n` +
		`<recent_journals>\n${recentJournals}\n</recent_journals>`
	);
}

function ensureTrailingNewline(s: string): string {
	return s.endsWith("\n") ? s : `${s}\n`;
}

/**
 * Apply a validated result (write-then-mark, D8/I3): on "replace" write the note FIRST, then record
 * the task's state; "none" records state without writing. Exported for testing.
 */
export async function applyMaintenanceResult(
	cwd: string,
	taskId: MaintenanceTaskId,
	result: MaintenanceResult,
	digest: string,
	now: number,
): Promise<void> {
	if (result.action === "replace" && typeof result.content === "string") {
		const path = notePath(cwd, TASKS[taskId]);
		const content = ensureTrailingNewline(result.content);
		// I1 — serialize the note overwrite across cwd-sharing processes, like the journal append and
		// the state write (Step-9 finding #1). Distinct lock path from the state file's; not nested.
		await withFileLock(`${path}.lock`, async () => {
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, content, "utf8");
		});
	}
	await updateTaskState(cwd, taskId, {
		last_success_at: new Date(now).toISOString(),
		last_input_digest: digest,
		last_action: result.action,
	});
}

/** Run one task end-to-end: read journals + existing note -> complete() -> parse -> apply. */
async function runMaintenanceTask(ctx: ExtensionContext, cwd: string, taskId: MaintenanceTaskId, digest: string, now: number): Promise<void> {
	const task = TASKS[taskId];
	const recent = await readRecentJournals(cwd, RECENT_JOURNAL_LIMIT);
	if (!recent.trim()) return; // nothing to synthesize from yet — don't mark, retry once journals exist
	let existing = "";
	try {
		existing = await readFile(notePath(cwd, task), "utf8");
	} catch {
		// no note yet
	}
	const raw = await runCompletion(ctx, buildMaintenancePrompt(task, recent, existing), SYNTHESIS_TIMEOUT_MS);
	if (!raw) return; // no model / no key / failure (D8) — nothing recorded, retries next due
	const result = parseMaintenanceResult(raw);
	if (!result) return; // invalid contract (D8) — treated as failure, no state update
	await applyMaintenanceResult(cwd, taskId, result, digest, now);
}

/** Which tasks are opted in via flags. */
export function enabledTasks(pi: ExtensionAPI): MaintenanceTaskId[] {
	const out: MaintenanceTaskId[] = [];
	if (pi.getFlag(PROJECT_REVIEW_FLAG)) out.push("project_review");
	if (pi.getFlag(USER_PROFILE_FLAG)) out.push("user_profile");
	return out;
}

/** Min-interval in ms from the flag (string, parsed; default 24h; bad/negative -> default). */
export function intervalMs(pi: ExtensionAPI): number {
	const raw = pi.getFlag(REVIEW_INTERVAL_FLAG) as string | undefined;
	const n = raw != null ? Number(raw) : Number.NaN;
	return (Number.isFinite(n) && n >= 0 ? n : DEFAULT_INTERVAL_HOURS) * HOUR_MS;
}

/**
 * Orchestrator (D5/D7), called from agent_end. Cheap when not due: returns immediately with no flags;
 * otherwise reads state, skips hashing unless an enabled task's interval elapsed, hashes once, and
 * runs each task whose digest changed. Trust-gated (I2).
 */
export async function runDueSemanticTasks(pi: ExtensionAPI, ctx: ExtensionContext, now: number = Date.now()): Promise<void> {
	if (!ctx.isProjectTrusted()) return; // I2
	const enabled = enabledTasks(pi);
	if (enabled.length === 0) return; // not opted in — zero cost
	const cwd = ctx.sessionManager.getCwd();
	const interval = intervalMs(pi);
	const state = await readState(cwd);
	const timeDue = enabled.filter((id) => intervalElapsed(state[id], interval, now)); // cheap pre-gate (no hashing)
	if (timeDue.length === 0) return;
	const digest = await digestJournals(cwd, RECENT_JOURNAL_LIMIT); // same window synthesis consumes (#4)
	for (const id of timeDue) {
		if (!isDue(state[id], digest, interval, now)) continue; // digest unchanged
		await runMaintenanceTask(ctx, cwd, id, digest, now);
	}
}

export interface SemanticNoteInfo {
	id: MaintenanceTaskId;
	file: string; // "PROJECT.md" | "USER.md"
	path: string; // absolute
	exists: boolean;
	mtime: Date | null;
}

/** Presence + mtime of the durable note files (.memsearch/PROJECT.md, USER.md) for the /memory-status
 *  report (Dec8). Keeps notePath/TASKS private; a missing note → { exists:false, mtime:null }. */
export async function listSemanticNotes(cwd: string): Promise<SemanticNoteInfo[]> {
	const out: SemanticNoteInfo[] = [];
	for (const id of ["project_review", "user_profile"] as const) {
		const task = TASKS[id];
		const path = notePath(cwd, task);
		try {
			const st = await stat(path);
			out.push({ id, file: task.file, path, exists: true, mtime: st.mtime });
		} catch {
			out.push({ id, file: task.file, path, exists: false, mtime: null });
		}
	}
	return out;
}

/**
 * Read the durable notes for cold-start injection (D4). Returns a ready-to-inject block, or "" when
 * neither note exists. The note bodies are self-labeling (# Project Memory / # User Memory).
 */
export async function readSemanticNotes(cwd: string): Promise<string> {
	const parts: string[] = [];
	for (const id of ["project_review", "user_profile"] as const) {
		try {
			const content = (await readFile(notePath(cwd, TASKS[id]), "utf8")).trim();
			if (content) parts.push(content);
		} catch {
			// note not present
		}
	}
	if (parts.length === 0) return "";
	return `Durable project & user memory (via memsearch):\n\n${parts.join("\n\n")}`;
}

/**
 * Register the semantic-memory surfaces: the two opt-in task flags + the shared interval flag, and
 * the gated agent_end synthesis handler. MUST be called AFTER registerCapture so the agent_end order
 * lets synthesis observe the journal capture wrote this turn (D5). Errors are surfaced warn-once.
 */
export function registerSemanticSurfaces(pi: ExtensionAPI): void {
	pi.registerFlag(PROJECT_REVIEW_FLAG, {
		type: "boolean",
		default: false,
		description:
			"Enable the opt-in project_review task: synthesize a durable .memsearch/PROJECT.md from journals (gated by journal-change + min-interval).",
	});
	pi.registerFlag(USER_PROFILE_FLAG, {
		type: "boolean",
		default: false,
		description:
			"Enable the opt-in user_profile task: synthesize a durable .memsearch/USER.md from journals (gated by journal-change + min-interval).",
	});
	pi.registerFlag(REVIEW_INTERVAL_FLAG, {
		type: "string",
		description: "Minimum hours between semantic-memory synthesis runs (default 24).",
	});

	let synthesisWarned = false; // warn-once latch (mirrors cold-start)
	const resetWarn = (): void => {
		synthesisWarned = false;
	};
	pi.on("session_start", async () => resetWarn());
	pi.on("session_tree", async () => resetWarn());

	pi.on("agent_end", async (_event, ctx) => {
		try {
			await runDueSemanticTasks(pi, ctx);
		} catch (e) {
			if (ctx.hasUI && !synthesisWarned) {
				synthesisWarned = true;
				ctx.ui.notify(`memsearch semantic synthesis failed: ${(e as Error).message}`, "warning");
			}
		}
	});
}
