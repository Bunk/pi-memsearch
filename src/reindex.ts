/**
 * Live re-indexing (gap #4): a digest-gated whole-dir re-index on before_agent_start that catches
 * externally-written / hand-edited journals (and parallel-session writes) at the next turn start.
 *
 * Trigger (D2): turn-start ONLY. Capture already indexes our own turn on agent_end (capture.ts),
 * so a digest-gated reindex there would re-fire every turn; before_agent_start has no such
 * redundancy — at turn start the only journal change since last turn is an EXTERNAL write, exactly
 * the target. registerReindex MUST be wired before the cold-start handler so the same turn's recall
 * reads the freshly-indexed content (see index.ts).
 *
 * Gate (D3): purely digest-gated (no interval) via digestChanged against a persisted live_reindex
 * digest in .maintenance-state.json. Reuses digestJournals (the SAME RECENT_JOURNAL_LIMIT window the
 * semantic layer uses) + readState/updateTaskState wholesale.
 *
 * Lock (critical): indexMemory self-acquires the NON-REENTRANT global write lock, so it is called
 * from this UNLOCKED handler context — never nested in another write lock (memsearch.ts:261-262).
 *
 * Write-then-mark (D8/I3): the live_reindex digest is recorded only AFTER a successful index; a
 * thrown index records nothing and retries next turn start. Trust-gated (I2) like every auto path.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { RECENT_JOURNAL_LIMIT } from "./constants";
import { EMPTY_JOURNAL_DIGEST, digestJournals, journalMemoryDir } from "./journal";
import { digestChanged, readState, updateTaskState } from "./maintenance-state";
import { indexMemory, memsearchOptions } from "./memsearch";

/**
 * Re-index the project's journals iff their digest changed since the last successful index. Cheap
 * when nothing changed: a single digest hash + a small state read, then an early return. Exported
 * for testing. `now` is injectable for deterministic tests.
 */
export async function runDueReindex(pi: ExtensionAPI, ctx: ExtensionContext, now: number = Date.now()): Promise<void> {
	if (!ctx.isProjectTrusted()) return; // I2 — no auto subprocess in untrusted projects
	const cwd = ctx.sessionManager.getCwd();
	const digest = await digestJournals(cwd, RECENT_JOURNAL_LIMIT);
	if (digest === EMPTY_JOURNAL_DIGEST) return; // no journals yet — nothing to index (mirrors semantic's empty bail)
	const state = await readState(cwd);
	if (!digestChanged(state.live_reindex, digest)) return; // journals unchanged since last index — no-op
	// indexMemory self-acquires the NON-REENTRANT write lock, so it MUST run from this unlocked
	// handler context; never nest it inside a write lock (memsearch.ts:261-262). memsearchOptions
	// threads the per-project --collection + provider pin so the right collection is indexed.
	await indexMemory([journalMemoryDir(cwd)], memsearchOptions(pi, cwd, ctx.signal));
	// write-then-mark (D8/I3): record the indexed digest only AFTER a successful index; a thrown
	// index records nothing for live_reindex and retries next turn start.
	await updateTaskState(cwd, "live_reindex", {
		last_success_at: new Date(now).toISOString(),
		last_input_digest: digest,
		last_action: "none",
	});
}

/**
 * Register the live re-index trigger: a before_agent_start handler (trust-gated inside runDueReindex)
 * that re-indexes on a journal-digest change. MUST be called BEFORE the cold-start before_agent_start
 * handler so the same turn's recall reads the freshly-indexed content (registration-order dispatch,
 * mirroring the capture->semantic agent_end order). Errors are surfaced warn-once (mirrors cold-start).
 */
export function registerReindex(pi: ExtensionAPI): void {
	let reindexWarned = false; // warn-once latch
	const resetWarn = (): void => {
		reindexWarned = false;
	};
	pi.on("session_start", async () => resetWarn());
	pi.on("session_tree", async () => resetWarn());

	pi.on("before_agent_start", async (_event, ctx) => {
		try {
			await runDueReindex(pi, ctx);
		} catch (e) {
			if (ctx.hasUI && !reindexWarned) {
				reindexWarned = true;
				ctx.ui.notify(`memsearch live re-index failed: ${(e as Error).message}`, "warning");
			}
		}
	});
}
