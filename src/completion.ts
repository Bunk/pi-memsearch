/**
 * Shared bounded LLM-completion helper.
 *
 * Extracted from capture.ts's summarizeExchange so both the capture summary and the semantic
 * maintenance synthesis (semantic.ts) share one source. This is a DIRECT model call via
 * complete() — it does NOT run the agent loop and therefore cannot re-fire agent_end (the same
 * rationale that makes capture's summarization safe to call from an agent_end handler).
 *
 * Bounding (Q3): the call is capped by AbortSignal.timeout(timeoutMs), composed with the caller's
 * ctx.signal via AbortSignal.any so either cancels it. Degrades to "" on no-model / no-key /
 * error so callers can fall back gracefully rather than throw.
 */

import { complete } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Run a single bounded completion and return the concatenated text (trimmed), or "" on
 *  no-model / no-key / failure. */
export async function runCompletion(ctx: ExtensionContext, prompt: string, timeoutMs: number): Promise<string> {
	const model = ctx.model;
	if (!model) return "";
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok || !auth.apiKey) return "";
	try {
		const timeout = AbortSignal.timeout(timeoutMs);
		const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout;
		const response = await complete(
			model,
			{
				messages: [
					{
						role: "user" as const,
						content: [{ type: "text" as const, text: prompt }],
						timestamp: Date.now(),
					},
				],
			},
			{ apiKey: auth.apiKey, headers: auth.headers, signal },
		);
		return response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n")
			.trim();
	} catch {
		return "";
	}
}
