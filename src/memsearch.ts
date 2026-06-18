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
import { SUBPROCESS_TIMEOUT_MS } from "./constants";
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

/** Build argv for `memsearch search`. The untrusted `query` is placed after a literal
 *  `--` end-of-options separator (S1) so a value beginning with `--` is treated as data,
 *  not a flag. Trusted flags (providerArgs) precede the separator. Exported for testing. */
export function buildSearchArgs(query: string, topK: number, opts: MemsearchOptions = {}): string[] {
	return ["search", "--top-k", String(topK), "--json-output", ...providerArgs(opts), "--", query];
}

/** Build argv for `memsearch expand`; untrusted `chunkHash` after `--` (S1). Exported for testing. */
export function buildExpandArgs(chunkHash: string): string[] {
	return ["expand", "--json-output", "--", chunkHash];
}

/** Build argv for `memsearch index`; untrusted `paths` after `--`, provider flags before (S1). Exported for testing. */
export function buildIndexArgs(paths: string[], opts: MemsearchOptions = {}): string[] {
	return ["index", ...providerArgs(opts), "--", ...paths];
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

/** Run the memsearch CLI and capture stdout/stderr, with an abort+timeout signal (Q3). */
function runMemsearch(args: string[], opts: MemsearchOptions = {}): Promise<RunResult> {
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
		const { stdout, stderr, code } = await runMemsearch(buildExpandArgs(chunkHash), opts);
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
