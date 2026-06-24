/**
 * Config + diagnostics surfaces: the read-only /memory-status command and the destructive
 * /memory-reset command, plus the bundled /memory-config SKILL.md path (contributed via skills.ts).
 *
 * Trust (I2): both commands are trust-gated fail-closed (the report spawns the CLI; reset mutates the
 * shared DB). Lock-by-mutate is handled inside the wrappers (getStats → read lock, resetMemory →
 * write lock). The diagnostics report is overwhelmingly extension-side state aggregation — only the
 * chunk count comes from the CLI, and it renders DEGRADED on failure (Dec11) so a broken CLI doesn't
 * sink the report. Reset confirmation is owned by the extension via ctx.ui.confirm (Dec10), NOT the
 * CLI's --yes (which buildResetArgs auto-passes).
 *
 * Packaging (Dec12): assets/memory-config/SKILL.md ships by npm default (no files allowlist / no
 * .npmignore), like assets/memory-to-skill/SKILL.md; resolved via import.meta.url + ".." for src/dist parity.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatDate, formatTime, journalMemoryDir, listDailyJournals } from "./journal";
import { type MaintenanceState, type MaintenanceTaskId, readState } from "./maintenance-state";
import { getStats, memsearchOptions, resetMemory } from "./memsearch";
import { enabledTasks, intervalMs, listSemanticNotes, type SemanticNoteInfo } from "./semantic";

/** Absolute path to the bundled /memory-config SKILL.md. Resolves the same from src/ (tsx dev) and
 *  dist/ (built) — one level under the package root where assets/ lives (Dec12). Imported by
 *  skills.ts and merged into the single resources_discover handler (Dec9). */
const baseDir = dirname(fileURLToPath(import.meta.url));
export const MEMORY_CONFIG_PATH = join(baseDir, "..", "assets", "memory-config", "SKILL.md");

interface StatusData {
	provider?: string;
	collection?: string;
	chunks: number | null; // null → the stats CLI failed (Dec11)
	chunkError?: string; // first line of the failure reason, when chunks === null
	journals: string[];
	notes: SemanticNoteInfo[];
	state: MaintenanceState;
	enabled: MaintenanceTaskId[];
	intervalHours: number;
}

function fmtProvider(p?: string): string {
	return p ? `${p} (pinned via --memsearch-provider)` : "(unset — memsearch config default)";
}

/** Render the index-health line, distinguishing broken-empty from healthy-empty (I2). A null count is
 *  a CLI failure (degraded, Dec11). `0 chunks while journals exist` means the index is empty relative
 *  to its surviving source (e.g. a reset whose reindex failed) — flag it and point at /memory-reset
 *  rather than render it identically to a genuinely fresh 0/0 project. */
function fmtChunks(chunks: number | null, chunkError: string | undefined, journalCount: number): string {
	if (chunks === null) return `Indexed chunks: unavailable (${chunkError ?? "memsearch stats failed"})`;
	if (chunks === 0 && journalCount > 0)
		return `Indexed chunks: 0 ⚠ ${journalCount} journal file${journalCount === 1 ? "" : "s"} exist but nothing is indexed — run /memory-reset to rebuild`;
	return `Indexed chunks: ${chunks}`;
}

function fmtJournals(names: string[]): string {
	if (names.length === 0) return "none";
	const newest = names[names.length - 1].replace(/\.md$/, "");
	return `${names.length} daily file${names.length === 1 ? "" : "s"} (newest ${newest})`;
}

function fmtNotes(notes: SemanticNoteInfo[]): string {
	// Local date+time (via journal's formatters) so note mtimes share the journal basenames' local
	// calendar basis (Step-9 findings #2/#3) instead of mixing in a UTC slice.
	return notes
		.map((n) => (n.exists ? `${n.file} ✓ (${n.mtime ? `${formatDate(n.mtime)} ${formatTime(n.mtime)}` : "?"})` : `${n.file} ✗`))
		.join(", ");
}

function fmtSemantic(enabled: MaintenanceTaskId[], intervalHours: number): string {
	const mark = (id: MaintenanceTaskId): string => (enabled.includes(id) ? "✓" : "✗");
	return `project_review ${mark("project_review")}, user_profile ${mark("user_profile")} · interval ${intervalHours}h`;
}

function fmtState(state: MaintenanceState): string {
	const ids = Object.keys(state) as MaintenanceTaskId[];
	if (ids.length === 0) return "no runs recorded";
	// Render the stored ISO (UTC) last_success_at in LOCAL time to match the journal basenames
	// (Step-9 finding #3); fall back to the raw value if it doesn't parse.
	return ids
		.map((id) => {
			const s = state[id]!;
			const d = new Date(s.last_success_at);
			const when = Number.isNaN(d.getTime()) ? s.last_success_at : `${formatDate(d)} ${formatTime(d)}`;
			return `${id} last ${s.last_action} ${when}`;
		})
		.join("; ");
}

/** Pure formatter for the /memory-status report (no I/O — unit-testable). Exported for testing. */
export function formatStatusReport(d: StatusData): string {
	return [
		"# memsearch status",
		"",
		"Trust: trusted",
		`Provider: ${fmtProvider(d.provider)}`,
		`Collection: ${d.collection ?? "(default)"}`,
		fmtChunks(d.chunks, d.chunkError, d.journals.length),
		`Journals: ${fmtJournals(d.journals)}`,
		`Semantic tasks: ${fmtSemantic(d.enabled, d.intervalHours)}`,
		`Notes: ${fmtNotes(d.notes)}`,
		`Maintenance: ${fmtState(d.state)}`,
	].join("\n");
}

/** Register /memory-status (read-only diagnostics) + /memory-reset (destructive, confirm-gated). */
export function registerConfigSurfaces(pi: ExtensionAPI): void {
	pi.registerCommand("memory-status", {
		description: "Show memsearch memory diagnostics (collection, provider, journals, notes, index health).",
		handler: async (_args, ctx) => {
			if (!ctx.isProjectTrusted()) {
				if (ctx.hasUI) ctx.ui.notify("Memory is disabled in untrusted projects — trust the project to enable recall/capture.", "warning");
				return;
			}
			const cwd = ctx.sessionManager.getCwd();
			const opts = memsearchOptions(pi, cwd);

			// Chunk count is the ONLY CLI-dependent field — capture it degraded on failure (Dec11) so a
			// broken CLI doesn't sink the rest of the report. Keep the NUMBER (not a pre-baked line) so
			// formatStatusReport can compare it against the journal count to flag a broken-empty index (I2).
			let chunks: number | null = null;
			let chunkError: string | undefined;
			try {
				chunks = await getStats(opts);
			} catch (e) {
				chunkError = (e as Error).message.split("\n")[0];
			}

			const [journals, notes] = await Promise.all([listDailyJournals(cwd), listSemanticNotes(cwd)]);
			const state = await readState(cwd);
			const content = formatStatusReport({
				provider: opts.provider,
				collection: opts.collection,
				chunks,
				chunkError,
				journals,
				notes,
				state,
				enabled: enabledTasks(pi),
				intervalHours: Math.round(intervalMs(pi) / 3_600_000),
			});
			pi.sendMessage({ customType: "memsearch-status", content, display: true });
		},
	});

	pi.registerCommand("memory-reset", {
		description: "Drop this project's memsearch collection and reindex the journals (destructive; confirmation required).",
		handler: async (_args, ctx) => {
			if (!ctx.isProjectTrusted()) {
				if (ctx.hasUI) ctx.ui.notify("Memory reset is disabled in untrusted projects.", "warning");
				return;
			}
			// No dialog-capable UI → refuse rather than drop a destructive op unconfirmed (Dec10).
			if (!ctx.hasUI) return;
			const cwd = ctx.sessionManager.getCwd();
			const opts = memsearchOptions(pi, cwd);
			const ok = await ctx.ui.confirm(
				"Reset memsearch memory?",
				`Drops collection ${opts.collection ?? "(default)"} and reindexes the journals under ${journalMemoryDir(cwd)}. ` +
					"Journal markdown is preserved; only the index is rebuilt. Continue?",
			);
			if (!ok) {
				ctx.ui.notify("Memory reset cancelled.", "info");
				return;
			}
			let result: string;
			try {
				result = await resetMemory(opts);
			} catch (e) {
				// The collection is already dropped here (the reindex is what failed). Make recovery
				// explicit (Step-9 finding #1): the surviving journals rebuild the index on a re-run.
				ctx.ui.notify(
					`Collection dropped but reindex failed — recall is empty until rebuilt. Re-run /memory-reset to rebuild from the journals.\n${(e as Error).message}`,
					"error",
				);
				return;
			}
			pi.sendMessage({ customType: "memsearch-reset", content: result, display: true });
		},
	});
}
