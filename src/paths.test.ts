import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { deriveCollection } from "./collection";
import { memsearchDir, projectRoot } from "./paths";

// realpath the fixture root: on macOS tmpdir() is under /var, a symlink to /private/var, so the
// expected values must be canonicalized to match projectRoot's realpath.
const tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "memsearch-paths-")));
after(() => rmSync(tmpRoot, { recursive: true, force: true }));

test("projectRoot normalizes a subdirectory to the enclosing git root", () => {
	const repo = join(tmpRoot, "repo");
	const deep = join(repo, "src", "deep");
	mkdirSync(join(repo, ".git"), { recursive: true });
	mkdirSync(deep, { recursive: true });
	assert.equal(projectRoot(deep), repo);
	assert.equal(projectRoot(repo), repo);
});

test("a subdir launch and a repo-root launch derive the SAME collection (isolation parity)", () => {
	const repo = join(tmpRoot, "repo2");
	const deep = join(repo, "a", "b");
	mkdirSync(join(repo, ".git"), { recursive: true });
	mkdirSync(deep, { recursive: true });
	assert.equal(deriveCollection(deep), deriveCollection(repo));
});

test("projectRoot detects a .git FILE (worktree / submodule), not just a directory", () => {
	const wt = join(tmpRoot, "worktree");
	const sub = join(wt, "pkg");
	mkdirSync(sub, { recursive: true });
	writeFileSync(join(wt, ".git"), "gitdir: /somewhere/.git/worktrees/wt\n");
	assert.equal(projectRoot(sub), wt);
});

test("projectRoot falls back to the dir itself when there is no enclosing repo", () => {
	const lone = join(tmpRoot, "norepo");
	mkdirSync(lone, { recursive: true });
	assert.equal(projectRoot(lone), lone);
});

test("projectRoot is total for a non-existent path (lexical fallback, no throw)", () => {
	// No .git ancestor and realpath would throw → returns the resolved (lexical) path.
	assert.equal(projectRoot("/no/such/path-xyz"), resolve("/no/such/path-xyz"));
});

test("memsearchDir composes projectRoot + .memsearch", () => {
	const repo = join(tmpRoot, "repo3");
	const deep = join(repo, "x");
	mkdirSync(join(repo, ".git"), { recursive: true });
	mkdirSync(deep, { recursive: true });
	assert.equal(memsearchDir(deep), join(repo, ".memsearch"));
});
