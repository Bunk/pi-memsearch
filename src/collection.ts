/**
 * Per-project Milvus collection derivation.
 *
 * Every project shares the default `memsearch_chunks` collection unless we pass an explicit
 * `--collection`, so recall in one project can surface another project's memories. We derive a
 * deterministic, per-project collection name from the project directory — mirroring upstream's
 * `plugins/codex/scripts/derive-collection.sh` so the same project always maps to the same
 * collection across index, search, and expand.
 *
 * Format: `ms_<sanitized_basename>_<8-char sha256 of the absolute path>`. The result always
 * satisfies Milvus naming rules (starts with a letter, only [A-Za-z0-9_], length <= 255).
 *
 * The hashed path is the canonical project root from paths.ts (git root, realpath-resolved), NOT the
 * raw cwd, so it matches upstream's isolation behavior on two axes that a raw-cwd hash would miss:
 *   - launch depth: a subdir launch and a repo-root launch map to the SAME collection (git-root
 *     normalization, mirroring common.sh's `git rev-parse --show-toplevel`).
 *   - symlinks: symlink-equivalent launch paths map to the SAME collection (realpath, mirroring
 *     `derive-collection.sh`'s `realpath -m`).
 * The sanitized basename is taken from that same resolved root so the human-readable prefix tracks
 * the repo, not the subdir. paths.ts anchors the journal/notes/state .memsearch tree on the same
 * root, so the collection and its source journals never diverge.
 */

import { createHash } from "node:crypto";
import { basename } from "node:path";
import { projectRoot } from "./paths";

/** Sanitize the project basename the way upstream derive-collection.sh does: lowercase ->
 *  non-alphanumerics to `_` -> collapse repeats -> trim leading/trailing `_` -> truncate to 40. */
function sanitizeBasename(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]/g, "_")
		.replace(/_+/g, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, 40);
}

/**
 * Derive the deterministic per-project collection name for `cwd`.
 * Mirrors upstream `ms_<sanitized_basename>_<sha256(abspath)[:8]>`, hashing the canonical project
 * root (git root + realpath, via projectRoot) rather than the raw cwd.
 */
export function deriveCollection(cwd: string): string {
	const abs = projectRoot(cwd);
	const sanitized = sanitizeBasename(basename(abs));
	const hash = createHash("sha256").update(abs).digest("hex").slice(0, 8);
	return `ms_${sanitized}_${hash}`;
}
