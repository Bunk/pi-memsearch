/**
 * Capture pipeline: summarize each exchange on agent_end, append to the daily
 * journal, and incrementally index. Idempotent across resume/reload/fork via
 * "memsearch-capture" bookkeeping entries. Gated behind project trust.
 *
 * Crash-safety (I3): the journal append runs FIRST and is made idempotent via a
 * per-entry anchor check (journalHasEntry); the bookkeeping marker is written only
 * AFTER a successful append. A crash between the append and the marker re-enters on
 * the next agent_end, finds the entry already journaled, skips the (non-deterministic)
 * re-append, and records the marker. A failed append leaves NO marker, so the exchange
 * is retried next agent_end and is never promoted to indexed (no silent strand/mask).
 *
 * Index retry (I4): each marker carries `indexed`; a journaled-but-unindexed
 * exchange (index failed, or crash before the index) is retried on the next
 * agent_end. The whole-dir index + content-hash dedup makes this safe.
 *
 * Session header (I5): whether to write a `## Session` header is derived from
 * the daily file's current contents (journalHasSession), not an in-memory flag,
 * so a resumed session never duplicates a header and a session crossing midnight
 * gets a header in the new daily file.
 *
 * No recursion guard needed: summarization uses complete() (a direct LLM API
 * call), which does not run the agent loop and cannot re-fire agent_end.
 */

import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { runCompletion } from "./completion";

/** Optional cheap-model pin for capture summarization (mirrors --memsearch-provider for embeddings).
 *  Unset = summarize with the session's current model (ctx.model). A pinned model keeps per-turn
 *  summarization cost/latency off the (often expensive) primary model — upstream's Claude Code plugin
 *  hardcodes `--model haiku` for the same reason. */
export const SUMMARY_MODEL_FLAG = "memsearch-summary-model";

/**
 * Resolve the pinned summarize model from the flag, or undefined to fall back to ctx.model. Accepts a
 * canonical `provider/modelId` reference, or a bare `modelId` when it is unambiguous across providers
 * (mirroring pi's own model-reference matching). A bare id matching 0 or >1 models returns undefined
 * so the caller can warn + fall back rather than silently pick the wrong provider. Exported for testing.
 */
export function resolveSummaryModel(pi: ExtensionAPI, ctx: ExtensionContext): ExtensionContext["model"] {
	const ref = (pi.getFlag(SUMMARY_MODEL_FLAG) as string | undefined)?.trim();
	if (!ref) return undefined;
	if (ref.includes("/")) {
		const i = ref.indexOf("/");
		return ctx.modelRegistry.find(ref.slice(0, i), ref.slice(i + 1));
	}
	const matches = ctx.modelRegistry.getAll().filter((m) => m.id === ref);
	return matches.length === 1 ? matches[0] : undefined; // bare id must be unambiguous
}
import { type ConversationMessage, extractExchangeText } from "./conversation";
import {
	appendToJournal,
	buildAnchor,
	ensureDailyFile,
	formatExchangeBlock,
	formatSessionHeader,
	journalHasEntry,
	journalHasSession,
	journalMemoryDir,
	toBulletList,
} from "./journal";
import { withFileLock } from "./lock";
import { indexMemory, memsearchOptions } from "./memsearch";

const SUMMARY_PROMPT = [
	"Summarize the following exchange between a user and a coding assistant as 2-10 concise,",
	"third-person bullet points capturing decisions, actions taken, and open questions.",
	"Output ONLY the bullets, one per line, no preamble.",
].join(" ");

function buildSummaryPrompt(exchangeText: string): string {
	return `${SUMMARY_PROMPT}\n\n<exchange>\n${exchangeText}\n</exchange>`;
}

const RAW_FALLBACK_CHARS = 1500;
/** Q3 — cap the summarization call so a hung LLM request cannot wedge agent_end. */
const SUMMARY_TIMEOUT_MS = 60_000;

async function summarizeExchange(ctx: ExtensionContext, exchangeText: string, model: ExtensionContext["model"]): Promise<string> {
	return runCompletion(ctx, buildSummaryPrompt(exchangeText), SUMMARY_TIMEOUT_MS, { model });
}

/** Rebuild the capture bookkeeping sets from a session branch (pure; exported for testing). */
export function reconstructSets(entries: readonly SessionEntry[]): { captured: Set<string>; indexed: Set<string> } {
	const captured = new Set<string>();
	const indexed = new Set<string>();
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== "memsearch-capture") continue;
		const data = entry.data as { entryId?: string; indexed?: boolean } | undefined;
		if (!data?.entryId) continue;
		captured.add(data.entryId);
		if (data.indexed) indexed.add(data.entryId);
	}
	return { captured, indexed };
}

export function registerCapture(pi: ExtensionAPI): void {
	let captured = new Set<string>(); // entryIds journaled — skip re-journal (I3)
	let indexed = new Set<string>(); // entryIds confirmed indexed (I4)
	let summaryModelWarned = false; // warn-once: a set-but-unresolvable summary-model flag

	pi.registerFlag(SUMMARY_MODEL_FLAG, {
		type: "string",
		description:
			"Pin a (cheap) model for capture summarization, e.g. 'anthropic/claude-haiku-4-5' or a bare unambiguous model id. " +
			"The pinned model must be authenticated. Unset = summarize with the session's current model.",
	});

	const reconstruct = (ctx: ExtensionContext): void => {
		const sets = reconstructSets(ctx.sessionManager.getBranch());
		captured = sets.captured;
		indexed = sets.indexed;
		summaryModelWarned = false; // re-warn once per session / tree-switch (mirrors other warn-once latches)
	};

	pi.on("session_start", async (_event, ctx) => reconstruct(ctx));
	pi.on("session_tree", async (_event, ctx) => reconstruct(ctx));

	/** Run a whole-dir index; notify + return false on failure (G1-style). */
	const runIndex = async (ctx: ExtensionContext): Promise<boolean> => {
		const cwd = ctx.sessionManager.getCwd();
		try {
			await indexMemory([journalMemoryDir(cwd)], memsearchOptions(pi, cwd, ctx.signal));
			return true;
		} catch (e) {
			if (ctx.hasUI) ctx.ui.notify(`memsearch index failed: ${(e as Error).message}`, "warning");
			return false;
		}
	};

	pi.on("agent_end", async (event, ctx) => {
		if (!ctx.isProjectTrusted()) return;

		const entryId = ctx.sessionManager.getLeafId();
		if (entryId && !captured.has(entryId)) {
			const exchangeText = extractExchangeText(event.messages as unknown as ConversationMessage[]);
			if (exchangeText.trim()) {
				// Resolve the optional cheap-model pin; a set-but-unresolvable ref warns once and falls
				// back to ctx.model (inside runCompletion) rather than degrading to the raw-text fallback.
				const summaryModel = resolveSummaryModel(pi, ctx);
				if (!summaryModel && pi.getFlag(SUMMARY_MODEL_FLAG) && ctx.hasUI && !summaryModelWarned) {
					summaryModelWarned = true;
					ctx.ui.notify(
						`memsearch: --${SUMMARY_MODEL_FLAG} "${pi.getFlag(SUMMARY_MODEL_FLAG)}" matched no known model; summarizing with the session model.`,
						"warning",
					);
				}
				const summary = await summarizeExchange(ctx, exchangeText, summaryModel);
				const bullets = toBulletList(summary.trim() || exchangeText.slice(0, RAW_FALLBACK_CHARS));

				const cwd = ctx.sessionManager.getCwd();
				const now = new Date();
				const sessionId = ctx.sessionManager.getSessionId();

				// I3 — journal FIRST, mark only on success. journalHasEntry makes the append
				// idempotent: a crash between append and marker re-enters here, finds the entry
				// already journaled, and skips the (non-deterministic) re-append. A failed append
				// throws before the marker is written, so the exchange is retried next agent_end
				// and is never added to `captured` (and therefore never indexed) — no strand/mask.
				try {
					const file = await ensureDailyFile(cwd, now);
					// I1 — serialize the read-check + append across cwd-sharing processes with a
					// per-daily-file advisory lock; the unguarded check-then-act otherwise lets two
					// processes both pass journalHasEntry and double-append.
					await withFileLock(`${file}.lock`, async () => {
						if (await journalHasEntry(file, sessionId, entryId)) return;
						// I5 — header decision from the file's contents (write once per session/file).
						const needHeader = !(await journalHasSession(file, sessionId));
						const anchor = buildAnchor(sessionId, entryId, ctx.sessionManager.getSessionFile() ?? "");
						const block = formatExchangeBlock({ date: now, anchor, bullets });
						// I2 — header + block as ONE append: a crash can no longer leave a header-only
						// partial state (invisible to both guards) that duplicates the header on retry.
						await appendToJournal(file, needHeader ? formatSessionHeader(now) + block : block);
					});
					// Journal append succeeded (or the entry was already present) — NOW record the marker.
					captured.add(entryId);
					pi.appendEntry("memsearch-capture", { entryId, indexed: false });
				} catch (e) {
					if (ctx.hasUI) ctx.ui.notify(`memsearch journal write failed: ${(e as Error).message}`, "warning");
				}
			}
		}

		// I4 — index the new exchange + any prior journaled-but-unindexed entries in one pass.
		// `captured` now contains only successfully-journaled entries, so indexing never
		// promotes an un-journaled exchange to indexed:true.
		const pending = [...captured].filter((id) => !indexed.has(id));
		if (pending.length === 0) return;
		if (await runIndex(ctx)) {
			for (const id of pending) {
				indexed.add(id);
				pi.appendEntry("memsearch-capture", { entryId: id, indexed: true });
			}
		}
	});
}
