import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// Hermetic harness: temp bin with a fake `memsearch` that branches on the subcommand — `skills add`
// echoes a fixed slug; `skills install` echoes MEMSEARCH_FAKE_INSTALLED. Set BEFORE importing.
const tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "memsearch-skills-")));
const binDir = join(tmpRoot, "bin");
mkdirSync(binDir, { recursive: true });
writeFileSync(
	join(binDir, "memsearch"),
	'#!/bin/sh\ncase "$*" in\n  *"skills add"*) printf "Added candidate skill: my-skill" ;;\n  *"skills install"*) printf "Installed: %s" "${MEMSEARCH_FAKE_INSTALLED:-}" ;;\nesac\nexit ${MEMSEARCH_FAKE_EXIT:-0}\n',
);
chmodSync(join(binDir, "memsearch"), 0o755);
process.env.PI_MEMSEARCH_LOCK_DIR = join(tmpRoot, "lock");
process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;

const { createSkillTools, registerSkillSurfaces } = await import("./skills");

after(() => rmSync(tmpRoot, { recursive: true, force: true }));

const tool = () => createSkillTools().find((t) => t.name === "create_skill")!;

test("create_skill is a no-op in an untrusted project (I2)", async () => {
	const ctx = { isProjectTrusted: () => false } as unknown as ExtensionContext;
	const res = await tool().execute("tc", { name: "n", description: "d", body: "b" }, undefined, undefined, ctx);
	assert.deepEqual(res.details, { trusted: false });
});

test("create_skill adds, installs, and confirms a skill within the project (happy path)", async () => {
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "memsearch-skill-cwd-")));
	try {
		const installed = join(cwd, ".agents", "skills", "my-skill", "SKILL.md");
		mkdirSync(dirname(installed), { recursive: true });
		writeFileSync(installed, "---\nname: my-skill\n---\nbody");
		process.env.MEMSEARCH_FAKE_EXIT = "0";
		process.env.MEMSEARCH_FAKE_INSTALLED = installed;
		const ctx = { isProjectTrusted: () => true, sessionManager: { getCwd: () => cwd } } as unknown as ExtensionContext;
		const res = await tool().execute("tc", { name: "My Skill", description: "does X", body: "## Steps" }, undefined, undefined, ctx);
		const details = res.details as { slug: string; installedPath: string };
		assert.equal(details.slug, "my-skill");
		assert.equal(details.installedPath, installed);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
		delete process.env.MEMSEARCH_FAKE_INSTALLED;
	}
});

test("create_skill refuses an install path outside the project (I7)", async () => {
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "memsearch-skill-cwd2-")));
	const outside = realpathSync(mkdtempSync(join(tmpdir(), "memsearch-skill-out-")));
	try {
		const evil = join(outside, "evil", "SKILL.md");
		mkdirSync(dirname(evil), { recursive: true });
		writeFileSync(evil, "x");
		process.env.MEMSEARCH_FAKE_EXIT = "0";
		process.env.MEMSEARCH_FAKE_INSTALLED = evil;
		const ctx = { isProjectTrusted: () => true, sessionManager: { getCwd: () => cwd } } as unknown as ExtensionContext;
		await assert.rejects(
			tool().execute("tc", { name: "n", description: "d", body: "b" }, undefined, undefined, ctx),
			/outside the project/,
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
		rmSync(outside, { recursive: true, force: true });
		delete process.env.MEMSEARCH_FAKE_INSTALLED;
	}
});

test("create_skill throws when the installed file does not exist (I3)", async () => {
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "memsearch-skill-cwd3-")));
	try {
		process.env.MEMSEARCH_FAKE_EXIT = "0";
		process.env.MEMSEARCH_FAKE_INSTALLED = join(cwd, ".agents", "skills", "ghost", "SKILL.md");
		const ctx = { isProjectTrusted: () => true, sessionManager: { getCwd: () => cwd } } as unknown as ExtensionContext;
		await assert.rejects(
			tool().execute("tc", { name: "n", description: "d", body: "b" }, undefined, undefined, ctx),
			/does not exist/,
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
		delete process.env.MEMSEARCH_FAKE_INSTALLED;
	}
});

test("create_skill refuses an in-project path outside the install dir (Q2 defense-in-depth)", async () => {
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "memsearch-skill-cwd4-")));
	try {
		// Inside the project root but NOT under .agents/skills — must still be refused.
		const sneaky = join(cwd, "elsewhere", "SKILL.md");
		mkdirSync(dirname(sneaky), { recursive: true });
		writeFileSync(sneaky, "x");
		process.env.MEMSEARCH_FAKE_EXIT = "0";
		process.env.MEMSEARCH_FAKE_INSTALLED = sneaky;
		const ctx = { isProjectTrusted: () => true, sessionManager: { getCwd: () => cwd } } as unknown as ExtensionContext;
		await assert.rejects(
			tool().execute("tc", { name: "n", description: "d", body: "b" }, undefined, undefined, ctx),
			/outside the project/,
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
		delete process.env.MEMSEARCH_FAKE_INSTALLED;
	}
});

test("registerSkillSurfaces registers create_skill and contributes the bundled SKILL.md", async () => {
	const registered: string[] = [];
	let discover: (() => Promise<{ skillPaths?: string[] }>) | undefined;
	const pi = {
		registerTool: (t: { name: string }) => registered.push(t.name),
		on: (evt: string, cb: () => Promise<{ skillPaths?: string[] }>) => {
			if (evt === "resources_discover") discover = cb;
		},
	} as unknown as ExtensionAPI;
	registerSkillSurfaces(pi);
	assert.ok(registered.includes("create_skill"), "create_skill tool registered");
	assert.ok(discover, "resources_discover handler registered");
	const res = await discover!();
	assert.equal(res.skillPaths?.length, 2, "two skill paths contributed (memory-to-skill + memory-config)");
	const paths = res.skillPaths!;
	for (const p of paths) assert.ok(existsSync(p), `bundled SKILL.md exists at ${p}`);
	const byName = Object.fromEntries(paths.map((p) => [readFileSync(p, "utf8").match(/name:\s*(\S+)/)?.[1], p]));
	assert.ok(byName["memory-to-skill"], "memory-to-skill path contributed");
	assert.ok(byName["memory-config"], "memory-config path contributed");
	assert.match(readFileSync(byName["memory-config"], "utf8"), /name:\s*memory-config[\s\S]*description:/, "memory-config has name+description frontmatter");
});
