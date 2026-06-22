---
name: memory-to-skill
description: Distill a recurring workflow from this project's captured memory into an installed, reusable pi skill. Use when the user says "make a skill out of what we just did", "turn this workflow into a skill", or wants a repeatable procedure captured from past sessions.
---

# Memory → Skill

Turn a recurring workflow that lives in this project's captured memory into an installed pi skill.
You (the agent) do the distillation by reading memory, then persist it with the `create_skill` tool.

## When to use

The user wants to capture "what we just did" (or a workflow from earlier sessions) as a reusable
`/skill:<name>`. Memory is captured per-project under `.memsearch/memory/`; recall it with the
`memory_recall`, `memory_expand`, and `memory_transcript` tools.

## Steps

1. **Identify the workflow.** From the user's request, name the concrete, repeatable procedure to
   capture (e.g. "deploy a test drive and smoke-test it"). If it is ambiguous, ask one clarifying
   question before proceeding.

2. **Recover the real steps from memory — do NOT rely on your chat memory.**
   - `memory_recall` with a natural-language query for the workflow to find the relevant journal
     entries (each result carries a `chunk_hash` and a source anchor).
   - `memory_expand` on a `chunk_hash` when a snippet is too short.
   - `memory_transcript` with an anchor's transcript path + turn id to read the **verbatim** tool
     calls and commands. Use this to get exact command names, flags, and file paths — never guess or
     hallucinate commands.

3. **Draft the SKILL.md body** (Markdown, no frontmatter — `name`/`description` are passed
   separately to the tool). Structure it so a future agent can execute it without the original
   context:
   - A short purpose line and a "When to use" note.
   - Numbered, copy-pasteable steps with the **exact** commands you verified in step 2.
   - Any setup/prerequisites and gotchas you observed.
   Keep it specific to this project's verified workflow; omit steps you could not confirm.

4. **Choose a name + description.**
   - `name`: lowercase letters/digits/hyphens only (e.g. `deploy-and-smoke-test`). It is slugified
     to the `/skill:` command and the directory name.
   - `description`: one line stating what the skill does AND when it should trigger (this is what a
     future agent matches on — be specific).

5. **Persist it.** Call the `create_skill` tool with `{ name, description, body }`. It writes a
   candidate via `memsearch skills add` and installs it into `.agents/skills/<slug>/SKILL.md`,
   returning the slug + install path.

6. **Report back.** Tell the user the installed path and that the skill surfaces as `/skill:<slug>`
   after the next reload (`/reload` or a new session).

## Notes

- On-demand only — there is no background miner. One skill per invocation.
- `create_skill` is disabled in untrusted projects (the whole memory surface is trust-gated).
- If `create_skill` fails *after* the candidate is written (e.g. the install step errors), the
  git-backed candidate is left behind harmlessly — re-running the skill (or `memsearch skills
  install`) recovers it; no manual cleanup is needed (D1).
- If `memory_recall` returns nothing, the workflow may not be captured yet; tell the user rather than
  inventing steps.
