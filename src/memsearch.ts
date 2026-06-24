/**
 * Typed wrappers around the memsearch CLI (subprocess model).
 *
 * Concurrency (I1): the default Milvus Lite DB is shared across processes, so
 * every CLI call is serialized through the global reader/writer lock in
 * ./lock — search/expand take a shared READ lock, index takes the exclusive
 * WRITE lock.
 *
 * Validation (I8): parsed CLI JSON is narrowed through runtime guards at the
 * boundary rather than blindly cast, so a schema drift in the memsearch output
 * cannot resurface as a downstream `undefined` dereference.
 *
 * Provider (D1): provider is owned by the user's memsearch config (zero-config).
 * An OPTIONAL `--provider` pin can be supplied via opts.provider (sourced from
 * the `memsearch-provider` pi flag) and is applied to search + index so the
 * index-time and search-time embedding providers cannot silently diverge.
 */

import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { deriveCollection } from "./collection";
import { SUBPROCESS_TIMEOUT_MS } from "./constants";
import { journalMemoryDir } from "./journal";
import { withReadLock, withWriteLock } from "./lock";

/** Name of the optional pi flag that pins the embedding provider (D1). */
export const MEMSEARCH_PROVIDER_FLAG = "memsearch-provider";

/** A single search result chunk from `memsearch search --json-output`. */
export interface MemoryChunk {
	content: string;
	source: string;
	heading: string;
	heading_level: number;
	chunk_hash: string;
	start_line: number;
	end_line: number;
	score: number;
}

/** Result of `memsearch expand <hash> --json-output`. */
export interface ExpandResult {
	chunk_hash: string;
	source: string;
	heading: string;
	start_line: number;
	end_line: number;
	content: string;
}

export interface MemsearchOptions {
	signal?: AbortSignal;
	cwd?: string;
	/** Optional embedding provider pin (D1); applied to search + index when set. */
	provider?: string;
	/** Optional per-project collection pin (collection isolation); applied to search + expand + index. */
	collection?: string;
}

interface RunResult {
	stdout: string;
	stderr: string;
	code: number;
}

const INSTALL_HINT = 'Install: uv tool install "memsearch[onnx]"';
const CONFIG_HINT = "If embeddings fail, set a provider once: memsearch config set embedding.provider onnx";

/** `--provider <p>` args when a provider pin is set, else nothing. */
function providerArgs(opts: MemsearchOptions): string[] {
	return opts.provider ? ["--provider", opts.provider] : [];
}

/** `--collection <c>` args when a collection is set, else nothing. Trusted (derived from cwd) so it
 *  precedes the `--` separator like providerArgs (S1). */
function collectionArgs(opts: MemsearchOptions): string[] {
	return opts.collection ? ["--collection", opts.collection] : [];
}

/** Build argv for `memsearch search`. The untrusted `query` is placed after a literal
 *  `--` end-of-options separator (S1) so a value beginning with `--` is treated as data,
 *  not a flag. Trusted flags (providerArgs) precede the separator. Exported for testing. */
export function buildSearchArgs(query: string, topK: number, opts: MemsearchOptions = {}): string[] {
	return ["search", "--top-k", String(topK), "--json-output", ...providerArgs(opts), ...collectionArgs(opts), "--", query];
}

/** Build argv for `memsearch expand`; untrusted `chunkHash` after `--` (S1). Exported for testing. */
export function buildExpandArgs(chunkHash: string, opts: MemsearchOptions = {}): string[] {
	return ["expand", "--json-output", ...collectionArgs(opts), "--", chunkHash];
}

/** Build argv for `memsearch index`; untrusted `paths` after `--`, provider flags before (S1). Exported for testing. */
export function buildIndexArgs(paths: string[], opts: MemsearchOptions = {}): string[] {
	return ["index", ...providerArgs(opts), ...collectionArgs(opts), "--", ...paths];
}

/** Build argv for `memsearch stats`. Read-only count; no embedding so no providerArgs, and no
 *  untrusted positionals so no `--` separator (named-flag-only, like skills add). `collectionArgs`
 *  scopes the count to the project's collection (else it counts the shared global collection).
 *  Exported for testing. */
export function buildStatsArgs(opts: MemsearchOptions = {}): string[] {
	return ["stats", ...collectionArgs(opts)];
}

/** Build argv for `memsearch reset`. `--yes` (LONG flag — v0.4.10 has no `-y`) bypasses the CLI's
 *  confirmation so the EXTENSION owns confirmation (Dec10). `collectionArgs` is mandatory: an
 *  unscoped reset drops the shared global collection holding every project's memories. No embedding
 *  so no providerArgs (like buildExpandArgs); no untrusted positionals so no `--`. Exported for testing. */
export function buildResetArgs(opts: MemsearchOptions = {}): string[] {
	return ["reset", "--yes", ...collectionArgs(opts)];
}

/** Build argv for `memsearch skills add`. `name`/`description` are untrusted *named-flag values* and
 *  the (untrusted) body rides stdin via `--body-file -` (Dec4), so nothing untrusted becomes a
 *  positional — with a fixed binary + array argv (no shell) there is no injection vector, so no `--`
 *  separator is needed here (add has no positionals). Exported for testing. */
export function buildSkillsAddArgs(name: string, description: string): string[] {
	return ["skills", "add", "--name", name, "--description", description, "--body-file", "-"];
}

/** Build argv for `memsearch skills install`. The untrusted `slug` positional is placed after a
 *  literal `--` end-of-options separator (S1); the trusted, cwd-derived `--path destDir` precedes it.
 *  Exported for testing. */
export function buildSkillsInstallArgs(slug: string, destDir: string): string[] {
	return ["skills", "install", "--path", destDir, "--", slug];
}

export function isMemoryChunk(x: unknown): x is MemoryChunk {
	if (!x || typeof x !== "object") return false;
	const c = x as Record<string, unknown>;
	return (
		typeof c.content === "string" &&
		typeof c.source === "string" &&
		typeof c.heading === "string" &&
		typeof c.chunk_hash === "string" &&
		typeof c.score === "number"
	);
}

export function isExpandResult(x: unknown): x is ExpandResult {
	if (!x || typeof x !== "object") return false;
	const r = x as Record<string, unknown>;
	return (
		typeof r.source === "string" &&
		typeof r.heading === "string" &&
		typeof r.content === "string" &&
		typeof r.start_line === "number" &&
		typeof r.end_line === "number"
	);
}

/** Run the memsearch CLI and capture stdout/stderr, with an abort+timeout signal (Q3). When `input`
 *  is provided it is written to the child's stdin and the stream is closed (Dec4 — used for
 *  `skills add --body-file -` so the untrusted body never touches argv). */
function runMemsearch(args: string[], opts: MemsearchOptions = {}, input?: string): Promise<RunResult> {
	return new Promise((resolve, reject) => {
		const timeout = AbortSignal.timeout(SUBPROCESS_TIMEOUT_MS);
		const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
		const child = spawn("memsearch", args, { signal, cwd: opts.cwd });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d) => (stdout += d.toString()));
		child.stderr.on("data", (d) => (stderr += d.toString()));
		child.on("error", reject);
		child.on("close", (code) => resolve({ stdout, stderr, code: code ?? -1 }));
		if (input !== undefined) {
			// Defer EPIPE only (Q5): if the child exits before draining stdin, the `close` handler
			// still resolves with its exit code (which failSkills() turns into an actionable error).
			// Any other stdin write error is genuine — reject so it is not silently masked.
			child.stdin.on("error", (err: NodeJS.ErrnoException) => {
				if (err.code !== "EPIPE") reject(err);
			});
			child.stdin.end(input);
		}
	});
}

function fail(action: string, code: number, stderr: string): never {
	throw new Error(
		`memsearch ${action} failed (exit ${code}). Is the CLI installed and configured?\n` +
			`${INSTALL_HINT}\n${CONFIG_HINT}\n\n${stderr.trim()}`,
	);
}

/** L1: semantic search. Returns parsed+validated chunks (empty array when no matches). */
export async function searchMemory(query: string, topK = 5, opts: MemsearchOptions = {}): Promise<MemoryChunk[]> {
	return withReadLock(async () => {
		const { stdout, stderr, code } = await runMemsearch(buildSearchArgs(query, topK, opts), opts);
		if (code !== 0) fail("search", code, stderr);
		const trimmed = stdout.trim();
		if (!trimmed) return [];
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			throw new Error(`memsearch search returned non-JSON output:\n${trimmed}`);
		}
		if (!Array.isArray(parsed)) throw new Error(`memsearch search returned a non-array payload:\n${trimmed}`);
		const chunks = parsed.filter(isMemoryChunk);
		// I4 — a non-empty payload that filters to empty is schema drift between this extension and
		// the memsearch CLI. Throw (like the non-JSON/non-array branches) so cold-start's catch fires
		// (slot not burned, retries) and memory_recall surfaces an actionable error instead of a
		// misleading "No memories found". A genuinely empty payload (length 0) still returns [].
		if (chunks.length === 0 && parsed.length > 0) {
			throw new Error(`memsearch search: all ${parsed.length} result(s) failed validation (schema drift?).`);
		}
		return chunks;
	});
}

/** L2: expand a chunk to its full heading section. */
export async function expandChunk(chunkHash: string, opts: MemsearchOptions = {}): Promise<ExpandResult> {
	return withReadLock(async () => {
		const { stdout, stderr, code } = await runMemsearch(buildExpandArgs(chunkHash, opts), opts);
		if (code !== 0) fail("expand", code, stderr);
		const trimmed = stdout.trim();
		if (!trimmed) throw new Error(`memsearch expand returned no output for chunk ${chunkHash} (not found?).`);
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			throw new Error(`memsearch expand returned non-JSON output:\n${trimmed}`);
		}
		if (!isExpandResult(parsed)) throw new Error(`memsearch expand returned an unexpected shape:\n${trimmed}`);
		return parsed;
	});
}

/** Index one or more journal paths (incremental; content-hash dedup). Returns the CLI status line. */
export async function indexMemory(paths: string[], opts: MemsearchOptions = {}): Promise<string> {
	if (paths.length === 0) return "";
	return withWriteLock(async () => {
		const { stdout, stderr, code } = await runMemsearch(buildIndexArgs(paths, opts), opts);
		if (code !== 0) fail("index", code, stderr);
		return stdout.trim();
	});
}

// Output shape pinned to memsearch v0.4.10: `stats` emits exactly `Total indexed chunks: N` (no
// --json-output support). Line-anchored (/m) so a stray warning line can't win; non-greedy digit
// capture. The fake-binary harness masks output drift — live-verify against the real binary (Q4).
const STATS_COUNT_RE = /^Total indexed chunks:\s+(\d+)$/m;

/** Indexed-chunk count for the project's collection (diagnostics). Read path → withReadLock. Throws
 *  on non-zero exit (fail) or unparseable output; the /memory-status caller catches and renders the
 *  count as unavailable (Dec11) so a broken CLI doesn't sink the whole report. */
export async function getStats(opts: MemsearchOptions = {}): Promise<number> {
	return withReadLock(async () => {
		const { stdout, stderr, code } = await runMemsearch(buildStatsArgs(opts), opts);
		if (code !== 0) fail("stats", code, stderr);
		const m = stdout.match(STATS_COUNT_RE);
		if (!m) throw new Error(`memsearch stats: could not parse the chunk count from output:\n${stdout.trim()}`);
		return Number(m[1]);
	});
}

/**
 * Drop the project's collection, then auto-reindex the surviving journals (D3) — both inside a SINGLE
 * withWriteLock body so no concurrent cross-process reader (searchMemory/getStats) can observe the
 * emptied collection between the drop and the rebuild (I1). The drop and reindex are issued as direct
 * runMemsearch calls (buildResetArgs / buildIndexArgs) rather than calling indexMemory(), because the
 * global write lock is NOT reentrant and indexMemory() would self-acquire it — nesting would deadlock.
 * The journal markdown survives the drop (reset clears the index, not the source), so the reindex
 * rebuilds the same per-project collection with the pinned provider (idempotent). Returns a status
 * line. With no cwd the reindex is skipped (drop only).
 */
export async function resetMemory(opts: MemsearchOptions = {}): Promise<string> {
	return withWriteLock(async () => {
		const reset = await runMemsearch(buildResetArgs(opts), opts);
		if (reset.code !== 0) fail("reset", reset.code, reset.stderr);
		if (!opts.cwd) return "Dropped collection (no cwd — skipped reindex).";
		// Direct runMemsearch(buildIndexArgs(...)) — NOT indexMemory() — to stay inside THIS lock
		// (indexMemory self-acquires the non-reentrant write lock; nesting would deadlock). Same argv.
		const idx = await runMemsearch(buildIndexArgs([journalMemoryDir(opts.cwd)], opts), opts);
		if (idx.code !== 0) fail("index", idx.code, idx.stderr);
		const out = idx.stdout.trim();
		return `Dropped collection and reindexed journals.${out ? ` ${out}` : ""}`;
	});
}

// Output shapes are pinned to memsearch v0.4.10. Both are line-anchored (/m) so a stray warning or
// echo line resembling the result cannot win (Q4); the install capture is non-greedy + trimmed so a
// future trailing token (e.g. `Installed: /x/SKILL.md (updated)`) is not glued onto the path (Q3).
/** Slug echoed by `memsearch skills add`: `Added candidate skill: <slug>`. */
const SKILL_ADD_SLUG_RE = /^Added candidate skill:\s*(\S+)/m;
/** Absolute path echoed by `memsearch skills install`: `Installed: <abspath>`. */
const SKILL_INSTALL_PATH_RE = /^Installed:\s*(.+?)\s*$/m;

/** Non-zero-exit error for the skills paths. Unlike the shared fail() it omits the embedding/provider
 *  config hint (CONFIG_HINT) — skills add/install do no embedding work, so that hint would mislead. */
function failSkills(action: string, code: number, stderr: string): never {
	throw new Error(`memsearch ${action} failed (exit ${code}). Is the CLI installed?\n${INSTALL_HINT}\n\n${stderr.trim()}`);
}

/**
 * Persist an agent-drafted skill as a git-backed candidate (`memsearch skills add`), feeding the
 * untrusted body over stdin (Dec4). Returns the slug the CLI assigned (parsed from stdout). No lock:
 * the candidate store is file/git-backed, not the shared Milvus DB (Dec9).
 */
export async function addSkillCandidate(
	name: string,
	description: string,
	body: string,
	opts: MemsearchOptions = {},
): Promise<string> {
	const { stdout, stderr, code } = await runMemsearch(buildSkillsAddArgs(name, description), opts, body);
	if (code !== 0) failSkills("skills add", code, stderr);
	const slug = stdout.match(SKILL_ADD_SLUG_RE)?.[1];
	if (!slug) throw new Error(`memsearch skills add: could not parse the candidate slug from output:\n${stdout.trim()}`);
	return slug;
}

/**
 * Install a candidate skill into `destDir` (`memsearch skills install <slug> --path destDir`).
 * Returns the absolute installed SKILL.md path (parsed from stdout) so the caller can verify it exists
 * and is within cwd before reporting success (I3/I7). No lock (Dec9).
 */
export async function installSkill(slug: string, destDir: string, opts: MemsearchOptions = {}): Promise<string> {
	const { stdout, stderr, code } = await runMemsearch(buildSkillsInstallArgs(slug, destDir), opts);
	if (code !== 0) failSkills("skills install", code, stderr);
	const installed = stdout.match(SKILL_INSTALL_PATH_RE)?.[1]?.trim();
	if (!installed) {
		throw new Error(`memsearch skills install: could not parse the installed path from output:\n${stdout.trim()}`);
	}
	return installed;
}

/**
 * Build MemsearchOptions for a call site: the per-project collection (collection isolation), the
 * optional provider pin (D1), plus cwd + signal. Centralizes the flag read + collection derivation
 * that the recall/capture/cold-start sites would otherwise each duplicate.
 */
export function memsearchOptions(pi: ExtensionAPI, cwd: string, signal?: AbortSignal): MemsearchOptions {
	return {
		cwd,
		signal,
		provider: pi.getFlag(MEMSEARCH_PROVIDER_FLAG) as string | undefined,
		collection: deriveCollection(cwd),
	};
}
