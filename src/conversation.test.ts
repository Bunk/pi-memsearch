import assert from "node:assert/strict";
import { test } from "node:test";
import {
	extractExchangeText,
	extractTextParts,
	extractToolCallLines,
	isTurnEntry,
	listTurns,
	renderTurns,
	type TurnEntry,
} from "./conversation";

test("extractTextParts handles string and block array", () => {
	assert.deepEqual(extractTextParts("hello"), ["hello"]);
	assert.deepEqual(extractTextParts([{ type: "text", text: "a" }, { type: "text", text: "b" }]), ["a", "b"]);
	assert.deepEqual(extractTextParts([{ type: "toolCall", name: "x" }]), []);
	assert.deepEqual(extractTextParts(null), []);
});

test("extractToolCallLines summarizes tool calls", () => {
	const lines = extractToolCallLines([{ type: "toolCall", name: "read", arguments: { path: "a" } }]);
	assert.equal(lines.length, 1);
	assert.match(lines[0], /Tool read was called with args/);
});

test("extractExchangeText serializes user + assistant turns, drops others", () => {
	const text = extractExchangeText([
		{ role: "user", content: "hi" },
		{ role: "assistant", content: [{ type: "text", text: "hello" }, { type: "toolCall", name: "read", arguments: {} }] },
		{ role: "system", content: "ignored" },
	]);
	assert.match(text, /User: hi/);
	assert.match(text, /Assistant: hello/);
	assert.match(text, /Tool read was called/);
	assert.doesNotMatch(text, /ignored/);
});

test("isTurnEntry narrows message entries with a string role (review finding 5)", () => {
	// Real getBranch() elements are SessionEntry; the guard validates the message.role field.
	assert.equal(isTurnEntry({ id: "a", type: "message", message: { role: "user", content: "hi" } } as never), true);
	assert.equal(isTurnEntry({ id: "a", type: "message" } as never), false); // message/role absent
	assert.equal(isTurnEntry({ id: "b", type: "custom" } as never), false); // non-message entry
});

const branch: TurnEntry[] = [
	{ id: "t1", type: "message", message: { role: "user", content: "first question" } },
	{ id: "t2", type: "message", message: { role: "assistant", content: [{ type: "text", text: "answer" }] } },
	{ id: "abc123", type: "message", message: { role: "user", content: "second" } },
	{ id: "abc999", type: "message", message: { role: "assistant", content: [{ type: "text", text: "third" }] } },
];

test("listTurns lists user/assistant turns with previews", () => {
	const turns = listTurns(branch);
	assert.equal(turns.length, 4);
	assert.equal(turns[0].id, "t1");
	assert.equal(turns[0].preview, "first question");
});

test("renderTurns marks an exact target", () => {
	const out = renderTurns(branch, "t2", 1);
	assert.match(out, />>> /);
	assert.match(out, /\(t2\)/);
});

test("renderTurns reports not found", () => {
	assert.match(renderTurns(branch, "zzz"), /not found/);
});

test("renderTurns flags an ambiguous prefix (Q9)", () => {
	const out = renderTurns(branch, "abc");
	assert.match(out, /ambiguous/);
	assert.match(out, /abc123/);
	assert.match(out, /abc999/);
});

test("renderTurns resolves a unique prefix", () => {
	const out = renderTurns(branch, "abc1", 0);
	assert.match(out, /\(abc123\)/);
	assert.doesNotMatch(out, /ambiguous/);
});
