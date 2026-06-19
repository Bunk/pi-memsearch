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
 * We use path.resolve (not fs.realpath): deterministic, never throws, no fs dependency, and
 * consistent with journal.ts deriving the journal dir from the raw cwd. The only divergence from
 * upstream is symlink resolution, which does not affect intra-extension determinism.
 */

import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";

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
 * Mirrors upstream `ms_<sanitized_basename>_<sha256(abspath)[:8]>`.
 */
export function deriveCollection(cwd: string): string {
	const abs = resolve(cwd);
	const sanitized = sanitizeBasename(basename(abs));
	const hash = createHash("sha256").update(abs).digest("hex").slice(0, 8);
	return `ms_${sanitized}_${hash}`;
}
