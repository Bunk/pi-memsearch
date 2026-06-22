/**
 * pi-memsearch — persistent semantic memory for pi via the memsearch CLI.
 *
 * - Recall:  memory_recall / memory_expand / memory_transcript tools + /memory-recall command
 * - Capture: summarize each exchange on agent_end, append to the daily journal, index
 * - Cold start: inject prompt-relevant memories on the first prompt of a session
 * - Skills:  create_skill tool + bundled /memory-to-skill SKILL.md (procedural memory, on-demand)
 *
 * Trust (I2): the auto-firing cold-start spawns the memsearch CLI with no user
 * action, so it is gated on ctx.isProjectTrusted() like every other read path.
 *
 * Requires the `memsearch` CLI on PATH:  uv tool install "memsearch[onnx]"
 * Backend + embedding provider are owned by memsearch's own config (zero-config).
 * Optional: pin the provider on index + search with --memsearch-provider (D1).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCapture } from "./capture";
import { MEMSEARCH_PROVIDER_FLAG, memsearchOptions, type MemoryChunk, searchMemory } from "./memsearch";
import { registerRecallSurfaces } from "./recall";
import { registerSkillSurfaces } from "./skills";

const COLD_START_TOP_K = 3;

export default function (pi: ExtensionAPI): void {
	// Optional embedding-provider pin (D1). Unset = zero-config (memsearch owns the provider).
	pi.registerFlag(MEMSEARCH_PROVIDER_FLAG, {
		type: "string",
		description:
			"Pin the memsearch embedding provider (e.g. onnx) on index + search so index-time and search-time providers cannot diverge. Unset defers to memsearch config.",
	});

	registerRecallSurfaces(pi);
	registerSkillSurfaces(pi);
	registerCapture(pi);

	// Cold-start recall: once per session, on the first user prompt, inject
	// memories relevant to that prompt. Never per-turn (research constraint).
	let coldStartDone = false;
	let coldStartWarned = false; // warn-once latch so a persistent failure doesn't toast every prompt
	const resetColdStart = (): void => {
		coldStartDone = false;
		coldStartWarned = false;
	};

	pi.on("session_start", async () => resetColdStart());
	// I6 — reset on fork/tree-switch too (mirrors capture), so the forked branch re-injects.
	pi.on("session_tree", async () => resetColdStart());

	pi.on("before_agent_start", async (event, ctx) => {
		if (coldStartDone) return;
		if (!ctx.isProjectTrusted()) return; // I2 — no auto subprocess in untrusted projects (slot not burned)

		const prompt = event.prompt?.trim();
		if (!prompt) return; // Q1 — don't consume the slot on an empty/whitespace prompt

		let chunks: MemoryChunk[];
		try {
			chunks = await searchMemory(prompt, COLD_START_TOP_K, memsearchOptions(pi, ctx.sessionManager.getCwd(), ctx.signal));
		} catch (e) {
			// Q3 — surface the failure (consistent with the capture path) rather than staying fully
			// silent; the slot is NOT burned, so cold-start retries on the next prompt. The warn-once
			// latch keeps a persistent failure (missing CLI / schema drift) from toasting every prompt.
			if (ctx.hasUI && !coldStartWarned) {
				coldStartWarned = true;
				ctx.ui.notify(`memsearch cold-start recall failed: ${(e as Error).message}`, "warning");
			}
			return;
		}
		coldStartDone = true; // Q1 — consume the slot only after a successful search

		if (chunks.length === 0) return;

		const body = chunks
			.map((c) => `- (${typeof c.score === "number" ? c.score.toFixed(2) : "n/a"}) ${c.heading || c.source}: ${c.content}`)
			.join("\n");

		return {
			message: {
				customType: "memsearch-coldstart",
				content: `Relevant memories from past sessions (via memsearch):\n\n${body}`,
				display: true,
			},
		};
	});
}
