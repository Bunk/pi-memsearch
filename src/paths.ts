/**
 * Project-root resolution — the single source of truth for where a project's `.memsearch` tree and
 * its Milvus collection live.
 *
 * Isolation behavior (matches the upstream plugins): every project's journals, notes, maintenance
 * state, AND collection name must derive from ONE canonical root, or they split. Two ways a naive
 * `cwd` join splits them:
 *   1. Launch depth — running the agent in a subdirectory of a repo would key off the subdir, so a
 *      subdir launch and a repo-root launch would use different journal dirs + collections and never
 *      share memory. Upstream's hook layer normalizes to the git root (`git rev-parse --show-toplevel`,
 *      via common.sh); we mirror that by walking up for a `.git` entry.
 *   2. Symlinks — two symlink-equivalent launch paths would hash to different collections. Upstream's
 *      `derive-collection.sh` uses `realpath -m`; we canonicalize with realpath for the same reason.
 *
 * Keeping journal/notes/state/collection on the same resolved root also avoids a concrete data-loss
 * footgun: if the journal dir keyed off the subdir but the collection keyed off the repo root, a
 * `/memory-reset` launched from one subdir would reindex only that subdir's journals into the shared
 * collection and silently drop every other subdir's indexed memory.
 *
 * `.git` is detected as either a directory (normal clone) or a FILE (worktrees / submodules point
 * `.git` at a gitdir), so worktree roots normalize correctly too.
 */

import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Resolve the canonical project root for `cwd`: the nearest enclosing directory containing a `.git`
 * entry (the repo root), or `cwd` itself when none is found, with symlinks canonicalized via realpath.
 *
 * Total + deterministic: `realpathSync` throws for a path that does not exist (e.g. a synthetic cwd in
 * a unit test), so we fall back to the lexical (resolved-but-not-realpathed) path rather than throw.
 */
export function projectRoot(cwd: string): string {
	const start = resolve(cwd);
	let cur = start;
	let root = start; // default: cwd itself when no enclosing repo is found
	for (;;) {
		if (existsSync(join(cur, ".git"))) {
			root = cur;
			break;
		}
		const parent = dirname(cur);
		if (parent === cur) break; // filesystem root reached, no repo — keep the resolved cwd
		cur = parent;
	}
	try {
		return realpathSync(root);
	} catch {
		return root;
	}
}

/** Absolute path to the project's `.memsearch` base dir, anchored at the canonical project root.
 *  All `.memsearch` subpaths (memory/, PROJECT.md, USER.md, .maintenance-state.json) derive from this
 *  one function so they can never split across launch depth or symlinks. */
export function memsearchDir(cwd: string): string {
	return join(projectRoot(cwd), ".memsearch");
}
