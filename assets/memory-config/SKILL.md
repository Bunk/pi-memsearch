---
name: memory-config
description: Inspect and troubleshoot this project's memsearch memory — interpret /memory-status diagnostics, explain provider/semantic settings, and guide a safe reset. Use when recall seems broken/empty, after switching embedding provider or model, or when the user asks why memory isn't working.
---

# Memory Config & Diagnostics

Help the user understand and fix this project's memsearch memory. Diagnostics are surfaced by the
deterministic `/memory-status` command; remediation (a destructive rebuild) is the `/memory-reset`
command, which the USER runs and confirms. You (the agent) interpret the output and direct the user —
you do not type slash commands yourself, and there is no config-mutation tool (settings are surfaced
as guidance the user applies).

## When to use

- Recall returns nothing or stale results, or cold-start injects nothing.
- The user switched embedding provider/model and old chunks no longer match.
- "Why isn't memory working?" — you need to localize the failure.

## Steps

1. **Get the diagnostics.** Ask the user to run `/memory-status` and share what it shows. The report
   has these fields:
   - **Trust** — if the project is untrusted, capture/recall/cold-start are ALL disabled. This is the
     most common cause; tell the user to trust the project.
   - **Provider** — `(unset)` means memsearch's own config default; a pinned value comes from
     `--memsearch-provider`. Index-time and search-time providers must match or recall is empty.
   - **Collection** — the exact per-project `--collection`; every op is scoped to it.
   - **Indexed chunks** — `0` means nothing indexed yet (no captured turns, or a reset without
     reindex); `unavailable (...)` means the `memsearch` CLI failed (not installed/configured).
   - **Journals** — how many daily files exist + the newest date. Zero journals ⇒ nothing to recall.
   - **Semantic tasks / Notes** — whether project_review/user_profile are enabled and whether
     PROJECT.md/USER.md exist.
   - **Maintenance** — last synthesis run per task.

2. **Localize the failure** from the fields:
   - Untrusted ⇒ trust the project (nothing else will work until then).
   - `Indexed chunks: unavailable` ⇒ the CLI is broken — install/configure it
     (`uv tool install "memsearch[onnx]"`; `memsearch config set embedding.provider onnx`).
   - Chunks `0` but journals `> 0` ⇒ the index is empty relative to the source — a **reset** rebuilds it.
   - Provider mismatch after a model/provider switch ⇒ a **reset** re-embeds every chunk with the
     current provider.

3. **Guide remediation (read-only — you direct, the user acts).**
   - **Provider**: to pin a provider, tell the user to set `--memsearch-provider <p>` (e.g. `onnx`).
   - **Semantic notes**: enable with the `memsearch-project-review` / `memsearch-user-profile` flags.
   - **Reset** (destructive but recoverable): tell the user to run `/memory-reset`. It drops the
     project's collection and immediately reindexes the surviving journal markdown, so recall is
     restored with the current provider. The command shows a confirmation dialog the user must accept.

4. **Confirm the fix.** Ask the user to run `/memory-status` again — `Indexed chunks` should be
   non-zero and the provider/collection should match expectations.

## Notes

- `reset` is recoverable: it clears the index, not the journals under `.memsearch/memory/`, so a
  reindex rebuilds everything. It is scoped to THIS project's collection — it never touches other
  projects' memories.
- `compact` is intentionally **not** wired into this skill. Despite the name, `memsearch compact`
  does not prune or compress the index — it LLM-summarizes indexed chunks and appends a new
  `memory/YYYY-MM-DD.md` file (additive, not reductive), and no reference plugin surfaces it. Its
  synthesis behavior overlaps the semantic layer (PROJECT.md/USER.md). See
  `.rpiv/artifacts/research/2026-06-28_18-27-08_compact-gap-6.md`.
- Everything here is trust-gated: in an untrusted project both `/memory-status` and `/memory-reset`
  decline.
