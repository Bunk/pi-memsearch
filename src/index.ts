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
import { registerConfigSurfaces } from "./config";
import { MEMSEARCH_PROVIDER_FLAG, memsearchOptions, searchMemory } from "./memsearch";
import { registerRecallSurfaces } from "./recall";
import { registerReindex } from "./reindex";
import { readSemanticNotes, registerSemanticSurfaces } from "./semantic";
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
	// Read-only diagnostics (/memory-status) + reset (/memory-reset). Registers no agent_end handler,
	// so it slots here freely (D5 only constrains the capture → semantic agent_end order below).
	registerConfigSurfaces(pi);
	registerCapture(pi);
	// Registered AFTER registerCapture so the gated agent_end synthesis observes the journal
	// this turn just wrote (D5).
	registerSemanticSurfaces(pi);
	// Live re-index (gap #4): digest-gated whole-dir reindex on before_agent_start. Registered
	// BEFORE the cold-start before_agent_start handler below so its handler fires first and the
	// same turn's cold-start recall reads the freshly-indexed external journals (registration-order
	// dispatch, mirroring the D5 capture->semantic agent_end order).
	registerReindex(pi);

	// Cold-start injection: once per session, on the first user prompt, inject (a) the durable
	// semantic notes (PROJECT.md/USER.md, D4) and (b) prompt-relevant episodic recall. Never
	// per-turn (research constraint). Two independent latches so a recall failure still lets recall
	// retry next prompt while the (prompt-independent) notes inject exactly once.
	let coldStartDone = false; // episodic recall injected
	let coldStartWarned = false; // warn-once latch so a persistent recall failure doesn't toast every prompt
	let notesInjected = false; // durable notes injected (independent of recall)
	const resetColdStart = (): void => {
		coldStartDone = false;
		coldStartWarned = false;
		notesInjected = false;
	};

	pi.on("session_start", async () => resetColdStart());
	// I6 — reset on fork/tree-switch too (mirrors capture), so the forked branch re-injects.
	pi.on("session_tree", async () => resetColdStart());

	pi.on("before_agent_start", async (event, ctx) => {
		if (coldStartDone && notesInjected) return; // nothing left to inject this session
		if (!ctx.isProjectTrusted()) return; // I2 — no auto read/subprocess in untrusted projects (slots not burned)

		const prompt = event.prompt?.trim();
		if (!prompt) return; // Q1 — don't consume a slot on an empty/whitespace prompt

		const cwd = ctx.sessionManager.getCwd();
		const sections: string[] = [];

		// (a) Durable semantic notes (D4): prompt-independent, cheap file reads, injected once.
		if (!notesInjected) {
			try {
				const notes = await readSemanticNotes(cwd);
				notesInjected = true; // mark even when empty so we don't re-read the notes every prompt
				if (notes) sections.push(notes);
			} catch {
				// best-effort — leave notesInjected false to retry next prompt
			}
		}

		// (b) Prompt-relevant episodic recall.
		if (!coldStartDone) {
			try {
				const chunks = await searchMemory(prompt, COLD_START_TOP_K, memsearchOptions(pi, cwd, ctx.signal));
				coldStartDone = true; // Q1 — consume the slot only after a successful search
				if (chunks.length) {
					const body = chunks
						.map((c) => `- (${typeof c.score === "number" ? c.score.toFixed(2) : "n/a"}) ${c.heading || c.source}: ${c.content}`)
						.join("\n");
					sections.push(`Relevant memories from past sessions (via memsearch):\n\n${body}`);
				}
			} catch (e) {
				// Q3 — surface the recall failure (slot NOT burned, retries next prompt); warn-once.
				if (ctx.hasUI && !coldStartWarned) {
					coldStartWarned = true;
					ctx.ui.notify(`memsearch cold-start recall failed: ${(e as Error).message}`, "warning");
				}
			}
		}

		if (sections.length === 0) return;
		return {
			message: {
				customType: "memsearch-coldstart",
				content: sections.join("\n\n"),
				display: true,
			},
		};
	});
}
