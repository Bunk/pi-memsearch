/**
 * Procedural-memory surface: the `create_skill` tool + the bundled `/memory-to-skill` SKILL.md.
 *
 * D1: distillation is driven by the agent loop (the bundled SKILL.md), which reasons over journals
 * via the existing memory_recall/expand/transcript tools, drafts a SKILL.md body, then calls
 * create_skill to persist it.
 *
 * D2: create_skill is a two-step delegate — `memsearch skills add` (git-backed candidate, body via
 * stdin) then `skills install <slug> --path .agents/skills`. The extension never opens a raw SKILL.md
 * write path.
 *
 * Security: trust-gated (I2) like every other path; the install path is derived from the trusted cwd,
 * and the returned install path is confirmed durable (I3) and confined to the project (I7) before
 * success is reported.
 *
 * Packaging (Dec7): the bundled SKILL.md ships at assets/memory-to-skill/SKILL.md (one level under the
 * package root, beside src/ and dist/) and is contributed via resources_discover skillPaths, surfacing
 * as /skill:memory-to-skill after (re)load.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MEMORY_CONFIG_PATH } from "./config";
import { addSkillCandidate, installSkill } from "./memsearch";
import { isWithin } from "./recall";

const UNTRUSTED_RESULT = {
	content: [{ type: "text" as const, text: "Skill creation is disabled in untrusted projects." }],
	details: { trusted: false },
};

/** Project-local pi skills dir that `skills install` snapshots into (cwd-derived, trusted). */
const SKILLS_INSTALL_SUBDIR = [".agents", "skills"] as const;

/** Absolute path to the bundled /memory-to-skill SKILL.md. Resolves the same from src/ (tsx dev) and
 *  dist/ (built) — both are one level under the package root, where assets/ lives (Dec7). */
const baseDir = dirname(fileURLToPath(import.meta.url));
const MEMORY_TO_SKILL_PATH = join(baseDir, "..", "assets", "memory-to-skill", "SKILL.md");

export function createSkillTools() {
	const createSkillTool = defineTool({
		name: "create_skill",
		label: "Create Skill",
		description:
			"Persist an agent-drafted workflow as an installed pi skill (procedural memory). " +
			"Calls `memsearch skills add` then `skills install` into the project's .agents/skills dir. " +
			"Use after distilling a reusable workflow from memory (see the /memory-to-skill skill).",
		promptSnippet: "Persist a drafted workflow as an installed pi skill (procedural memory).",
		promptGuidelines: [
			"Use create_skill only after drafting a complete SKILL.md body — verify exact commands via memory_transcript first.",
			"name must be lowercase a-z/0-9/hyphens; description states what the skill does and when to use it.",
		],
		parameters: Type.Object({
			name: Type.String({ description: "Skill name (lowercase, hyphens). Slugified to the command + dir name." }),
			description: Type.String({ description: "One line: what the skill does and when it should trigger." }),
			body: Type.String({ description: "The SKILL.md body in Markdown (no frontmatter — the CLI adds it)." }),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (!ctx.isProjectTrusted()) return UNTRUSTED_RESULT;
			const cwd = ctx.sessionManager.getCwd();
			const opts = { cwd, signal };

			const slug = await addSkillCandidate(params.name, params.description, params.body, opts);
			const destDir = join(cwd, ...SKILLS_INSTALL_SUBDIR);
			const installedPath = await installSkill(slug, destDir, opts);

			// I3 — the install must be durable before we report success.
			if (!existsSync(installedPath)) {
				throw new Error(`memsearch reported installing ${slug} but ${installedPath} does not exist.`);
			}
			// I7 — confine the install to the actual target dir (destDir = .agents/skills), not just cwd
			// (Q2): a CLI-reported path elsewhere under the project (cwd/elsewhere/SKILL.md) must still be
			// refused. Realpath cwd (which exists) and append the literal subdir so a not-yet-created
			// destDir doesn't throw; realpath installedPath too so a symlinked tmp (/var → /private/var)
			// does not spuriously fail isWithin.
			const confineRoot = join(realpathSync(cwd), ...SKILLS_INSTALL_SUBDIR);
			if (!isWithin(realpathSync(installedPath), confineRoot)) {
				throw new Error(`Refusing to report a skill installed outside the project skills dir (${destDir}): ${installedPath}`);
			}

			return {
				content: [
					{
						type: "text",
						text: `Installed skill "${slug}" at ${installedPath}. It will surface as /skill:${slug} after the next reload.`,
					},
				],
				details: { slug, installedPath },
			};
		},
	});

	return [createSkillTool];
}

/** Register the create_skill tool + contribute the bundled /memory-to-skill SKILL.md (Dec7). */
export function registerSkillSurfaces(pi: ExtensionAPI): void {
	for (const tool of createSkillTools()) pi.registerTool(tool);
	pi.on("resources_discover", async () => ({ skillPaths: [MEMORY_TO_SKILL_PATH, MEMORY_CONFIG_PATH] }));
}
