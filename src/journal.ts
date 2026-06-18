/**
 * Project-local daily journal: path resolution, formatting, and append.
 *
 * Layout (memsearch convention):
 *   <cwd>/.memsearch/memory/YYYY-MM-DD.md
 *     # YYYY-MM-DD
 *     ## Session HH:MM
 *     ### HH:MM
 *     <!-- session:ID turn:ID transcript:PATH -->
 *     - bullet
 */

import { appendFile, mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";

const pad2 = (n: number): string => String(n).padStart(2, "0");

export function formatDate(d: Date): string {
	return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function formatTime(d: Date): string {
	return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Absolute path to the project-local memory directory. */
export function journalMemoryDir(cwd: string): string {
	return join(cwd, ".memsearch", "memory");
}

/** Absolute path to the daily journal file for `date`. */
export function dailyJournalPath(cwd: string, date: Date): string {
	return join(journalMemoryDir(cwd), `${formatDate(date)}.md`);
}

/** Anchor comment linking a memory entry back to its pi session + turn for L3 drill-down. */
export function buildAnchor(sessionId: string, turnId: string, transcriptPath: string): string {
	return `<!-- session:${sessionId} turn:${turnId} transcript:${transcriptPath} -->`;
}

/** Per-session heading. */
export function formatSessionHeader(date: Date): string {
	return `\n## Session ${formatTime(date)}\n`;
}

/** Normalize a model summary into a clean `- ` bullet list. */
export function toBulletList(summary: string): string {
	return summary
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean)
		.map((l) => `- ${l.replace(/^[-*]\s*/, "")}`)
		.join("\n");
}

/** Per-exchange block: `### HH:MM` + anchor + bullets. */
export function formatExchangeBlock(opts: { date: Date; anchor: string; bullets: string }): string {
	return `\n### ${formatTime(opts.date)}\n${opts.anchor}\n\n${opts.bullets}\n`;
}

/** Ensure the memory dir + dated file (with day header) exist. Returns the file path. */
export async function ensureDailyFile(cwd: string, date: Date): Promise<string> {
	await mkdir(journalMemoryDir(cwd), { recursive: true });
	const file = dailyJournalPath(cwd, date);
	// I4 — atomic exclusive-create so two cwd-sharing processes can't both pass a
	// check-then-act exists() probe and truncate the header. EEXIST = the header already
	// exists, which is success. (appendFile/O_APPEND for the body is already atomic.)
	try {
		const fh = await open(file, "wx");
		try {
			await fh.writeFile(`# ${formatDate(date)}\n`, "utf8");
		} finally {
			await fh.close();
		}
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
	}
	return file;
}

/** Append raw text to a journal file. */
export async function appendToJournal(filePath: string, text: string): Promise<void> {
	await appendFile(filePath, text, "utf8");
}

/**
 * True if the journal file already contains an exchange anchor for `sessionId`
 * — i.e. this session has written a block (and therefore its `## Session` header)
 * into this file. Drives the I5 header decision from the file's actual contents.
 * Anchored to buildAnchor's `<!-- session:ID turn:...` comment opener (S1) so a journal
 * BODY line that merely mentions `session:ID turn:` cannot satisfy the header guard; the
 * trailing ` turn:` keeps it prefix-safe (session ids carry no spaces). Missing file => false.
 */
export async function journalHasSession(filePath: string, sessionId: string): Promise<boolean> {
	try {
		const content = await readFile(filePath, "utf8");
		return content.includes(`<!-- session:${sessionId} turn:`);
	} catch {
		return false;
	}
}

/**
 * True if the journal file already contains the per-exchange anchor for `sessionId`+`entryId`
 * (the `<!-- session:S turn:T ` form buildAnchor emits). Used by the capture pipeline (I3) to
 * make the journal append idempotent. Anchored to the `<!-- ` comment opener + trailing space
 * (S1) so neither a body substring nor a prefix entryId can false-positive. Missing file => false.
 */
export async function journalHasEntry(filePath: string, sessionId: string, entryId: string): Promise<boolean> {
	try {
		const content = await readFile(filePath, "utf8");
		return content.includes(`<!-- session:${sessionId} turn:${entryId} `);
	} catch {
		return false;
	}
}
