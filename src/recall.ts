/**
 * Recall surfaces: three LLM tools + the /memory-recall command.
 *
 * L1 memory_recall     -> memsearch search   (CLI)
 * L2 memory_expand     -> memsearch expand   (CLI)
 * L3 memory_transcript -> NATIVE pi transcript via SessionManager.open
 *
 * Trust (I2): every read path is gated on ctx.isProjectTrusted() (fail-closed).
 * Path safety (I7): memory_transcript resolves transcriptPath and refuses any
 * path outside the project's session directory before opening it.
 * The tools are built inside createRecallTools(pi) so each execute can read the
 * optional memsearch-provider flag (D1).
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, SessionManager } from "@earendil-works/pi-coding-agent";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { isTurnEntry, listTurns, renderTurns, type TurnInfo } from "./conversation";
import { expandChunk, memsearchOptions, type MemoryChunk, searchMemory } from "./memsearch";

const UNTRUSTED_RESULT = {
	content: [{ type: "text" as const, text: "Memory recall is disabled in untrusted projects." }],
	details: { trusted: false },
};

function formatChunks(query: string, chunks: MemoryChunk[]): string {
	const blocks = chunks.map(
		(c, i) =>
			`### ${i + 1}. ${c.heading || c.source} (score ${typeof c.score === "number" ? c.score.toFixed(3) : "n/a"})\n` +
			`${c.content}\n\n— source: ${c.source} · chunk_hash: ${c.chunk_hash}`,
	);
	return `Memories for "${query}":\n\n${blocks.join("\n\n")}`;
}

function formatTurnList(turns: TurnInfo[]): string {
	if (turns.length === 0) return "No turns found.";
	const rows = turns.map((t) => `  ${t.id}  ${t.time}  ${t.role.padEnd(9)}  ${t.preview}`);
	return `All turns (${turns.length}):\n\n${rows.join("\n")}`;
}

/** True if `target` resolves to a path at or under `root`. */
export function isWithin(target: string, root: string): boolean {
	const rel = relative(root, target);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function createRecallTools(pi: ExtensionAPI) {
	const memoryRecallTool = defineTool({
		name: "memory_recall",
		label: "Memory Recall",
		description:
			"Search long-term memory of past sessions using memsearch (hybrid semantic + keyword search). " +
			"Use when the user references a prior conversation, decision, or context not present in the current session.",
		promptSnippet: "Search long-term memory of past sessions (semantic + keyword).",
		promptGuidelines: [
			"Use memory_recall when the user references a prior conversation, decision, or context not present in the current session.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "What to recall, in natural language." }),
			topK: Type.Optional(Type.Number({ description: "Max results to return (default 5).", default: 5 })),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (!ctx.isProjectTrusted()) return UNTRUSTED_RESULT;
			const topK = params.topK ?? 5;
			const chunks = await searchMemory(params.query, topK, memsearchOptions(pi, ctx.sessionManager.getCwd(), signal));
			const text = chunks.length ? formatChunks(params.query, chunks) : "No memories found.";
			return { content: [{ type: "text", text }], details: { query: params.query, topK, count: chunks.length } };
		},
	});

	const memoryExpandTool = defineTool({
		name: "memory_expand",
		label: "Memory Expand",
		description: "Expand a memory_recall result chunk to its full heading section (progressive disclosure L2).",
		promptSnippet: "Expand a memory_recall result chunk to its full section.",
		promptGuidelines: [
			"Use memory_expand with a chunk_hash from a memory_recall result when a search snippet is too short to answer.",
		],
		parameters: Type.Object({
			chunkHash: Type.String({ description: "The chunk_hash from a memory_recall result." }),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (!ctx.isProjectTrusted()) return UNTRUSTED_RESULT;
			const result = await expandChunk(params.chunkHash, memsearchOptions(pi, ctx.sessionManager.getCwd(), signal));
			const text =
				`Source: ${result.source} (lines ${result.start_line}-${result.end_line})\n` +
				`Heading: ${result.heading}\n\n${result.content}`;
			return { content: [{ type: "text", text }], details: { chunkHash: params.chunkHash, source: result.source } };
		},
	});

	const memoryTranscriptTool = defineTool({
		name: "memory_transcript",
		label: "Memory Transcript",
		description:
			"Read the original pi conversation behind a memory (progressive disclosure L3). " +
			"Use the transcript path + turn id from a memory anchor.",
		promptSnippet: "Read the original conversation behind a memory (L3).",
		promptGuidelines: [
			"Use memory_transcript with the transcript path and turn id from a memory_recall result's anchor to read the verbatim past dialogue.",
		],
		parameters: Type.Object({
			transcriptPath: Type.String({ description: "Path to the pi session JSONL (from a memory anchor)." }),
			turn: Type.Optional(Type.String({ description: "Target turn / entry id (prefix match ok). Omit to list all turns." })),
			context: Type.Optional(Type.Number({ description: "Turns of context around the target (default 3).", default: 3 })),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (!ctx.isProjectTrusted()) return UNTRUSTED_RESULT;
			signal?.throwIfAborted(); // Q6 — honor cancellation at entry (the rest is sync fs)

			// I7 — confine the LLM/anchor-supplied path to the project's session directory.
			let root: string;
			try {
				root = realpathSync(ctx.sessionManager.getSessionDir());
			} catch {
				throw new Error("Session directory unavailable; cannot open transcript.");
			}
			let resolved: string;
			try {
				resolved = realpathSync(resolve(params.transcriptPath));
			} catch (e) {
				throw new Error(`Could not resolve transcript ${params.transcriptPath}: ${(e as Error).message}`);
			}
			if (!isWithin(resolved, root)) {
				throw new Error("Refusing to open a transcript outside the project session directory.");
			}

			let sm: SessionManager;
			try {
				sm = SessionManager.open(resolved);
			} catch (e) {
				throw new Error(`Could not open transcript ${params.transcriptPath}: ${(e as Error).message}`);
			}
			const entries = sm.getBranch().filter(isTurnEntry); // I8 — validated at the boundary
			const text = params.turn
				? renderTurns(entries, params.turn, params.context ?? 3)
				: formatTurnList(listTurns(entries));
			return {
				content: [{ type: "text", text: text || "No turns found." }],
				details: { transcriptPath: resolved, turn: params.turn ?? null },
			};
		},
	});

	return [memoryRecallTool, memoryExpandTool, memoryTranscriptTool];
}

/** Register the three recall tools + the /memory-recall command. */
export function registerRecallSurfaces(pi: ExtensionAPI): void {
	for (const tool of createRecallTools(pi)) pi.registerTool(tool);

	pi.registerCommand("memory-recall", {
		description: "Search long-term memory (memsearch) for past context.",
		handler: async (args, ctx) => {
			if (!ctx.isProjectTrusted()) {
				if (ctx.hasUI) ctx.ui.notify("Memory recall is disabled in untrusted projects.", "warning");
				return;
			}
			const query = args.trim();
			if (!query) {
				if (ctx.hasUI) ctx.ui.notify("Usage: /memory-recall <what to recall>", "warning");
				return;
			}
			let chunks: MemoryChunk[];
			try {
				chunks = await searchMemory(query, 5, memsearchOptions(pi, ctx.sessionManager.getCwd()));
			} catch (e) {
				if (ctx.hasUI) ctx.ui.notify((e as Error).message, "error");
				return;
			}
			if (chunks.length === 0) {
				if (ctx.hasUI) ctx.ui.notify(`No memories found for "${query}"`, "info");
				return;
			}
			pi.sendMessage({ customType: "memsearch-recall", content: formatChunks(query, chunks), display: true });
		},
	});
}
