/**
 * Conversation extraction helpers.
 *
 * Adapted from examples/extensions/summarize.ts. Used by the capture pipeline
 * (serialize an agent_end exchange for summarization) and by the native L3
 * memory_transcript tool (list / render turns from a pi session branch).
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export interface ContentBlock {
	type?: string;
	text?: string;
	name?: string;
	arguments?: Record<string, unknown>;
}

export interface ConversationMessage {
	role?: string;
	content?: unknown;
}

/** Subset of a pi SessionEntry we read for L3 transcript rendering. */
export interface TurnEntry {
	id: string;
	type: string;
	timestamp?: string | number;
	message?: ConversationMessage;
}

// NEW exported guard, used by recall.ts (I8). Typed against SessionEntry (the
// real getBranch() element type) and narrowing to SessionEntry & TurnEntry so
// `.filter(isTurnEntry)` actually narrows AND validates the `message.role` field
// renderTurns reads. `SessionEntry & TurnEntry` is assignable to both SessionEntry
// (predicate validity) and TurnEntry[] (renderTurns/listTurns signatures).
export function isTurnEntry(x: SessionEntry): x is SessionEntry & TurnEntry {
	return x.type === "message" && typeof (x as TurnEntry).message?.role === "string";
}

export interface TurnInfo {
	id: string;
	role: string;
	time: string;
	preview: string;
}

const hhmm = (ts?: string | number): string => {
	if (ts === undefined) return "";
	const d = new Date(ts);
	if (Number.isNaN(d.getTime())) return "";
	const p = (n: number) => String(n).padStart(2, "0");
	return `${p(d.getHours())}:${p(d.getMinutes())}`;
};

const firstLine = (s: string, max = 72): string => {
	const line =
		s
			.split("\n")
			.map((l) => l.trim())
			.find(Boolean) ?? "";
	return line.length > max ? `${line.slice(0, max - 1)}\u2026` : line;
};

export function extractTextParts(content: unknown): string[] {
	if (typeof content === "string") return [content];
	if (!Array.isArray(content)) return [];
	const parts: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const block = part as ContentBlock;
		if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
	}
	return parts;
}

export function extractToolCallLines(content: unknown): string[] {
	if (!Array.isArray(content)) return [];
	const lines: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const block = part as ContentBlock;
		if (block.type !== "toolCall" || typeof block.name !== "string") continue;
		lines.push(`Tool ${block.name} was called with args ${JSON.stringify(block.arguments ?? {})}`);
	}
	return lines;
}

/**
 * Serialize an exchange (agent_end event.messages) into User/Assistant text for summarization.
 *
 * The role filter is an ALLOWLIST (only `user`/`assistant` pass), which is load-bearing: agent_end
 * delivers AgentMessage[] that also includes our own cold-start injections as `role:"custom"`
 * CustomMessages (and bash output as `role:"bashExecution"`). Excluding everything but user/assistant
 * keeps injected memories — the recalled past-session bullets and the durable PROJECT.md/USER.md notes
 * — OUT of the summary input, so memory is never re-summarized back into the journal (a drift loop the
 * upstream OpenClaw plugin instead handles by string-stripping injected blocks). Do NOT widen this to
 * other roles without re-establishing that exclusion. (Locked by a regression test in
 * conversation.test.ts.)
 */
export function extractExchangeText(messages: ConversationMessage[]): string {
	const sections: string[] = [];
	for (const message of messages) {
		const role = message?.role;
		if (role !== "user" && role !== "assistant") continue;
		const lines: string[] = [];
		const text = extractTextParts(message.content).join("\n").trim();
		if (text) lines.push(`${role === "user" ? "User" : "Assistant"}: ${text}`);
		if (role === "assistant") lines.push(...extractToolCallLines(message.content));
		if (lines.length) sections.push(lines.join("\n"));
	}
	return sections.join("\n\n");
}

/** List user/assistant turns in a branch (L3 "all turns"). */
export function listTurns(entries: TurnEntry[]): TurnInfo[] {
	const turns: TurnInfo[] = [];
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const role = entry.message?.role;
		if (role !== "user" && role !== "assistant") continue;
		const preview = firstLine(extractTextParts(entry.message?.content).join("\n"));
		turns.push({ id: entry.id, role, time: hhmm(entry.timestamp), preview });
	}
	return turns;
}

/** Render dialogue around a target turn, or the whole branch when no target. */
export function renderTurns(entries: TurnEntry[], targetId?: string, context = 3): string {
	const turns = entries.filter(
		(e) => e.type === "message" && (e.message?.role === "user" || e.message?.role === "assistant"),
	);
	let lo = 0;
	let hi = turns.length;
	let targetIdx = -1;
	if (targetId) {
		const exact = turns.findIndex((t) => t.id === targetId);
		if (exact >= 0) {
			targetIdx = exact;
		} else {
			const matches = turns.filter((t) => t.id.startsWith(targetId));
			if (matches.length === 0) return `Turn "${targetId}" not found in transcript.`;
			if (matches.length > 1) {
				const ids = matches.map((t) => t.id).join(", ");
				return `Turn id "${targetId}" is ambiguous — matches ${matches.length} turns: ${ids}. Use a longer id.`;
			}
			targetIdx = turns.indexOf(matches[0]);
		}
		lo = Math.max(0, targetIdx - context);
		hi = Math.min(turns.length, targetIdx + context + 1);
	}
	const blocks: string[] = [];
	for (let i = lo; i < hi; i++) {
		const t = turns[i];
		const marker = i === targetIdx ? ">>> " : "";
		const label = t.message?.role === "user" ? "User" : "Assistant";
		const text = extractTextParts(t.message?.content).join("\n").trim();
		const toolLines = t.message?.role === "assistant" ? extractToolCallLines(t.message?.content) : [];
		const body = [text, ...toolLines].filter(Boolean).join("\n");
		blocks.push(`${marker}[${hhmm(t.timestamp)}] ${label} (${t.id})\n${body}`);
	}
	return blocks.join("\n\n");
}
