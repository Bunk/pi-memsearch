/**
 * pi-memsearch — pi extension integrating the memsearch agent memory plugin.
 *
 * memsearch (https://github.com/zilliztech/memsearch) is a persistent, semantic
 * memory layer for AI agents, backed by Markdown files and a Milvus shadow index.
 * This extension lets pi:
 *   - recall past sessions via semantic search (`memsearch search`)
 *   - (planned) capture conversation turns into the memsearch journal
 *
 * Requires the `memsearch` CLI on PATH:
 *   uv tool install "memsearch[onnx]"
 *
 * This is an early scaffold — the recall tool shells out to the CLI; capture
 * (turn summarization + journal append) is not yet wired up.
 */

import { spawn } from "node:child_process";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Run the memsearch CLI and capture stdout. */
function runMemsearch(args: string[], signal?: AbortSignal): Promise<{ stdout: string; stderr: string; code: number }> {
	return new Promise((resolve, reject) => {
		const child = spawn("memsearch", args, { signal });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d) => (stdout += d.toString()));
		child.stderr.on("data", (d) => (stderr += d.toString()));
		child.on("error", reject);
		child.on("close", (code) => resolve({ stdout, stderr, code: code ?? -1 }));
	});
}

const memoryRecallTool = defineTool({
	name: "memory_recall",
	label: "Memory Recall",
	description:
		"Search long-term memory of past sessions using memsearch (hybrid semantic + keyword search). " +
		"Use when the user references a prior conversation, decision, or context not present in the current session.",
	parameters: Type.Object({
		query: Type.String({ description: "What to recall, in natural language." }),
		topK: Type.Optional(Type.Number({ description: "Max results to return (default 5).", default: 5 })),
	}),

	async execute(_toolCallId, params, signal) {
		const topK = params.topK ?? 5;
		const { stdout, stderr, code } = await runMemsearch(
			["search", params.query, "--top-k", String(topK), "--json-output"],
			signal,
		);

		if (code !== 0) {
			return {
				content: [
					{
						type: "text",
						text:
							`memsearch search failed (exit ${code}). Is the CLI installed and configured?\n` +
							`Install: uv tool install "memsearch[onnx]"\n\n${stderr.trim()}`,
					},
				],
				isError: true,
			};
		}

		return {
			content: [{ type: "text", text: stdout.trim() || "No memories found." }],
			details: { query: params.query, topK },
		};
	},
});

export default function (pi: ExtensionAPI) {
	pi.registerTool(memoryRecallTool);

	// Convenience command mirroring memsearch's /memory-recall on other platforms.
	pi.registerCommand?.({
		name: "memory-recall",
		description: "Search long-term memory (memsearch) for past context.",
		async run(ctx: { args?: string }) {
			const query = (ctx.args ?? "").trim();
			if (!query) {
				return { content: [{ type: "text", text: "Usage: /memory-recall <what to recall>" }] };
			}
			const { stdout, stderr, code } = await runMemsearch(["search", query, "--top-k", "5", "--json-output"]);
			return {
				content: [{ type: "text", text: code === 0 ? stdout.trim() || "No memories found." : stderr.trim() }],
			};
		},
	});
}
