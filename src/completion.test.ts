import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runCompletion } from "./completion";

// runCompletion degrades to "" without ever calling the model on these branches, so they are
// deterministic and need no network/model mock (mirrors capture.test.ts, which exercises the
// no-model fallback rather than the live complete() path).

test("runCompletion returns '' when no model is configured", async () => {
	const ctx = { model: undefined } as unknown as ExtensionContext;
	assert.equal(await runCompletion(ctx, "prompt", 1000), "");
});

test("runCompletion returns '' when auth is unavailable (not ok)", async () => {
	const ctx = {
		model: {} as unknown,
		modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: false, apiKey: undefined, headers: {} }) },
	} as unknown as ExtensionContext;
	assert.equal(await runCompletion(ctx, "prompt", 1000), "");
});

test("runCompletion returns '' when ok but the api key is missing", async () => {
	const ctx = {
		model: {} as unknown,
		modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: undefined, headers: {} }) },
	} as unknown as ExtensionContext;
	assert.equal(await runCompletion(ctx, "prompt", 1000), "");
});
