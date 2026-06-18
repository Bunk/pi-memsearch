import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createRecallTools, isWithin } from "./recall";

const root = realpathSync(mkdtempSync(join(tmpdir(), "memsearch-recall-")));
after(() => rmSync(root, { recursive: true, force: true }));

test("isWithin accepts a legitimate in-session path", () => {
	assert.equal(isWithin(join(root, "sessions", "s.jsonl"), root), true);
	assert.equal(isWithin(root, root), true, "the root itself is within");
});

test("isWithin rejects a ../ escape", () => {
	assert.equal(isWithin(join(root, "..", "evil.jsonl"), root), false);
});

test("isWithin rejects an absolute out-of-session path", () => {
	assert.equal(isWithin("/etc/passwd", root), false);
});

test("isWithin + realpathSync rejects a symlink that escapes the session dir", () => {
	const outside = mkdtempSync(join(tmpdir(), "memsearch-outside-"));
	try {
		const secret = join(outside, "secret.jsonl");
		writeFileSync(secret, "{}");
		const link = join(root, "link.jsonl");
		symlinkSync(secret, link);
		// the tool resolves with realpathSync before isWithin; the resolved target is outside root
		assert.equal(isWithin(realpathSync(link), root), false, "a symlink escaping the session dir is refused");
	} finally {
		rmSync(outside, { recursive: true, force: true });
	}
});

test("memory_transcript refuses a path outside the session dir (Q2 — call-site confinement)", async () => {
	const sessionRoot = realpathSync(mkdtempSync(join(tmpdir(), "memsearch-tx-root-")));
	const outside = realpathSync(mkdtempSync(join(tmpdir(), "memsearch-tx-out-")));
	try {
		const secret = join(outside, "secret.jsonl");
		writeFileSync(secret, "{}");
		const link = join(sessionRoot, "link.jsonl");
		symlinkSync(secret, link);
		const tools = createRecallTools({ getFlag: () => undefined } as unknown as ExtensionAPI);
		const transcript = tools.find((t) => t.name === "memory_transcript")!;
		const ctx = { isProjectTrusted: () => true, sessionManager: { getSessionDir: () => sessionRoot } } as unknown as ExtensionContext;
		await assert.rejects(transcript.execute("tc", { transcriptPath: secret }, undefined, undefined, ctx), /outside the project session directory/);
		await assert.rejects(transcript.execute("tc", { transcriptPath: link }, undefined, undefined, ctx), /outside the project session directory/);
		await assert.rejects(transcript.execute("tc", { transcriptPath: join(sessionRoot, "..", "x.jsonl") }, undefined, undefined, ctx), /Could not resolve|outside the project session directory/);
	} finally {
		rmSync(sessionRoot, { recursive: true, force: true });
		rmSync(outside, { recursive: true, force: true });
	}
});

test("memory_transcript admits an in-session path past the confinement gate (Q2)", async () => {
	const sessionRoot = realpathSync(mkdtempSync(join(tmpdir(), "memsearch-tx-ok-")));
	try {
		const inSession = join(sessionRoot, "s.jsonl");
		writeFileSync(inSession, "not-a-valid-session");
		const tools = createRecallTools({ getFlag: () => undefined } as unknown as ExtensionAPI);
		const transcript = tools.find((t) => t.name === "memory_transcript")!;
		const ctx = { isProjectTrusted: () => true, sessionManager: { getSessionDir: () => sessionRoot } } as unknown as ExtensionContext;
		// Confinement must ADMIT an in-session path: whether SessionManager.open succeeds (empty) or
		// throws a parse error, the failure (if any) must NOT be the confinement refusal.
		let refusedByConfinement = false;
		try {
			await transcript.execute("tc", { transcriptPath: inSession }, undefined, undefined, ctx);
		} catch (e) {
			refusedByConfinement = /outside the project session directory/.test((e as Error).message);
		}
		assert.equal(refusedByConfinement, false, "an in-session path must not be refused by the confinement gate");
	} finally {
		rmSync(sessionRoot, { recursive: true, force: true });
	}
});

test("memory_transcript honors an already-aborted signal (Q6)", async () => {
	const tools = createRecallTools({ getFlag: () => undefined } as unknown as ExtensionAPI);
	const transcript = tools.find((t) => t.name === "memory_transcript")!;
	const ctx = { isProjectTrusted: () => true, sessionManager: { getSessionDir: () => tmpdir() } } as unknown as ExtensionContext;
	await assert.rejects(
		transcript.execute("tc", { transcriptPath: "/x.jsonl" }, AbortSignal.abort(), undefined, ctx),
		(e: Error) => e.name === "AbortError" || /abort/i.test(e.message),
	);
});

test("memory_transcript is a no-op in an untrusted project (Q2)", async () => {
	const tools = createRecallTools({ getFlag: () => undefined } as unknown as ExtensionAPI);
	const transcript = tools.find((t) => t.name === "memory_transcript")!;
	const ctx = { isProjectTrusted: () => false } as unknown as ExtensionContext;
	const res = await transcript.execute("tc", { transcriptPath: "/whatever" }, undefined, undefined, ctx);
	assert.deepEqual(res.details, { trusted: false });
});
