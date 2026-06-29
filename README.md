# pi-memsearch

Persistent, semantic long-term memory for the [pi](https://github.com/earendil-works/pi-coding-agent)
coding agent, backed by [memsearch](https://github.com/zilliztech/memsearch) — Markdown journals
indexed into Milvus for hybrid (BM25 + dense-vector) retrieval.

Coding agents forget everything between sessions. pi-memsearch closes that gap: every exchange is
summarized to a daily Markdown journal and indexed automatically, and on the first prompt of each new
session the most relevant memories from past work are surfaced back into context. The agent can also
search, expand, and replay past conversations on demand, distill recurring workflows into reusable
skills, and maintain durable per-project and per-user notes.

## Goals

- **Continuity** — pick up where you left off, across sessions, forks, and days, without re-explaining
  context.
- **Low friction** — capture and cold-start recall are fully automatic once the project is trusted.
  There is nothing to run by hand for the common case.
- **Progressive disclosure** — recall returns small ranked snippets first; the agent drills into a full
  section or the verbatim transcript only when it actually needs to.
- **Safe by default** — fail-closed on untrusted projects, path-confined transcript reads, argument-
  injection hardening, and cross-process locking around the shared index.
- **Zero backend lock-in** — the Milvus backend and embedding provider are owned by your own `memsearch`
  config. It works offline out of the box and scales to managed/self-hosted Milvus without touching this
  extension.

## How it works

```
 ┌── you ↔ agent exchange ──┐
 │                          │   agent_end
 ▼                          ▼
 summarize (pi model) ─► .memsearch/memory/YYYY-MM-DD.md ─► memsearch index ─► Milvus
                                                                                  │
 next session, first prompt ──► memsearch search ──► relevant memories injected ◄─┘
```

1. **Capture** — on every `agent_end`, the exchange is summarized into a few bullet points (using pi's
   own model), appended to the project's daily journal, and incrementally indexed.
2. **Cold-start recall** — on the first prompt of a session, that prompt is used to search past memory,
   and the top matches (plus any durable notes) are injected into context. Once per session, never
   per-turn.
3. **On-demand recall** — three tools and a slash command let the agent (or you) search, expand, and
   read the original transcript behind any memory.

## Features

### Recall surfaces

| Surface | Type | Purpose |
| --- | --- | --- |
| `memory_recall` | tool | L1 — hybrid semantic + keyword search of past sessions. Returns ranked chunks with a `chunk_hash` and source anchors. |
| `memory_expand` | tool | L2 — expand a `chunk_hash` from a recall result to its full heading section. |
| `memory_transcript` | tool | L3 — read the verbatim original conversation (turns + tool calls) behind a memory, from its transcript anchor. |
| `/memory-recall <query>` | command | Manually search memory and print the results into the session. |

The agent uses these as **progressive disclosure**: search → expand the promising chunk → read the
original transcript turn only if needed.

### Automatic capture

Each exchange is journaled to `<project>/.memsearch/memory/YYYY-MM-DD.md`:

```markdown
# 2026-06-18
## Session 17:25
### 17:25
<!-- session:<id> turn:<id> transcript:/path/to/session.jsonl -->
- The user asked to …
- The assistant implemented …
```

The anchor comment links each memory back to the exact pi session, turn, and transcript, so
`memory_transcript` can reconstruct the original dialogue. Capture is **crash-safe and idempotent**: the
journal append happens first and is deduplicated per entry, the bookkeeping marker is written only after
a successful append, and resuming, reloading, or forking a session never double-writes.

### Cold-start recall

On the first user prompt of each session (and after a fork / tree-switch), pi-memsearch searches memory
with that prompt and injects the top matches as a displayed context message. A transient failure retries
on the next prompt; a persistent failure warns **once** rather than on every turn.

### Per-project isolation

Memories never leak between projects. Each project is mapped to its own deterministic Milvus collection,
derived from the canonical project root (git root, symlink-resolved), so a subdirectory launch and a
repo-root launch share the same collection while two different repos never see each other's memory.

### Live re-indexing

At the start of each turn, a digest-gated re-index catches journals written **outside** the current
session — hand edits, or journals produced by a parallel session in the same project — so on-demand
recall sees them immediately. It is a no-op (a single hash + state read) when nothing changed.

### Semantic memory (durable notes)

Beyond the per-exchange episodic journal, two **opt-in** tasks synthesize durable notes from recent
journals and inject them at cold-start:

- `project_review` → `.memsearch/PROJECT.md` — stable project state: direction, decisions, open
  questions, risks, next steps.
- `user_profile` → `.memsearch/USER.md` — durable user/workflow preferences and defaults.

Synthesis runs in the background, gated by both a minimum interval and a journal-content change, so it
only calls the model when there is genuinely something new to fold in. Notes are pure derived data —
rebuildable from the journals at any time.

### Procedural memory (skills from memory)

| Surface | Type | Purpose |
| --- | --- | --- |
| `/skill:memory-to-skill` | bundled skill | Drives the agent to distill a recurring workflow from memory (verifying exact commands via `memory_transcript`), draft a `SKILL.md`, and install it. |
| `create_skill` | tool | Persists an agent-drafted skill: writes a git-backed candidate, then installs it into `.agents/skills/<name>/SKILL.md`. |

On-demand only — there is no background miner. The new skill surfaces as `/skill:<name>` after the next
reload.

### Diagnostics & maintenance

| Surface | Type | Purpose |
| --- | --- | --- |
| `/memory-status` | command | Read-only health report: collection, provider, journal count, durable notes, semantic-task state, and indexed-chunk count (renders *degraded* if the CLI is unreachable rather than failing the whole report). |
| `/memory-reset` | command | Drop this project's collection and rebuild the index from the surviving journals. Destructive; requires confirmation. Journal Markdown is preserved. |
| `/skill:memory-config` | bundled skill | Guides interpreting `/memory-status`, explaining provider/semantic settings, and performing a safe reset. |

### Safety

- **Trust-gated (fail-closed)** — every read path *and* the auto-firing capture / cold-start / re-index
  are gated on project trust. Untrusted projects spawn no `memsearch` subprocess.
- **Path confinement** — `memory_transcript` refuses any transcript path outside the project's pi session
  directory (symlink-aware), and `create_skill` refuses to report an install outside `.agents/skills`.
- **Argument-injection hardening** — untrusted values (queries, hashes, paths) are passed after a `--`
  end-of-options separator, so a value beginning with `--` is treated as data, not a flag.
- **Schema validation** — CLI JSON is narrowed through runtime guards at the boundary; schema drift
  surfaces as an actionable error instead of a downstream `undefined`.
- **Cross-process locking** — the default Milvus Lite DB is shared across projects, so every CLI call is
  serialized through a global reader/writer lock (shared read for search/expand, exclusive write for
  index/reset). A single CLI call is capped at 5 minutes.

## Requirements

- [pi](https://github.com/earendil-works/pi-coding-agent)
- The `memsearch` CLI on your `PATH`:
  ```bash
  uv tool install "memsearch[onnx]"            # or: pipx install / pip install
  memsearch config set embedding.provider onnx # offline embeddings, no API key
  ```

## Install

This is a [pi package](https://github.com/earendil-works/pi-coding-agent/blob/main/docs/packages.md) — its
extension is declared via the `pi.extensions` key in `package.json`, so install it with `pi install`
rather than copying files (the entry point imports sibling modules a single-file copy would leave
behind).

```bash
# Project-local (writes to .pi/settings.json — shareable with your team)
pi install -l /path/to/pi-memsearch

# or user-global (writes to ~/.pi/agent/settings.json)
pi install /path/to/pi-memsearch
```

Then reload pi with `/reload` (or restart). To try it for a single run without installing:

```bash
pi -e /path/to/pi-memsearch
```

## Quick start

1. Install the `memsearch` CLI and set an embedding provider (see [Requirements](#requirements)).
2. Install the extension and reload pi (see [Install](#install)).
3. **Trust the project** — memory is disabled in untrusted projects. (`/memory-status` will tell you if
   trust is the blocker.)
4. Just work. From here, capture and cold-start recall are automatic — memories accumulate under
   `.memsearch/memory/` and are surfaced on future sessions.

That's the whole setup for the common case. The scenarios below show what else you can do.

## Common scenarios

### 1. Automatic continuity (no action required)

You work on a feature one day and come back the next. On your first prompt of the new session,
pi-memsearch searches memory with that prompt and injects the closest matches before the agent responds.

```
> Let's keep going on the write-lock refactor from yesterday.
```

The agent starts with the relevant decisions and context already in view — you don't have to re-explain
what "the write-lock refactor" was. Nothing to run; this is the default behavior once the project is
trusted.

### 2. Manually recalling a past decision

When you want to pull something specific from history, or the agent didn't surface it on its own:

```
/memory-recall how did we decide to handle the cross-process write lock?
```

Or just ask in plain language and let the agent reach for the recall tools itself:

```
> Remind me why we serialized every CLI call through a global lock — find where we discussed it
  and show me the original conversation.
```

Here the agent typically chains all three layers: `memory_recall` to find the chunk, `memory_expand` to
read the full section, then `memory_transcript` to replay the exact turn where the decision was made.

### 3. Turning a repeated workflow into a skill

You've done the same multi-step procedure a few times (e.g. a deploy-and-smoke-test loop). Capture it as
a reusable skill so the agent can replay it precisely later:

```
/skill:memory-to-skill the deploy-and-smoke-test loop we just did
```

or

```
> Make a skill out of what we just did.
```

The agent distills the workflow from memory (verifying exact commands via `memory_transcript`), drafts a
`SKILL.md`, and calls `create_skill` to install it under `.agents/skills/`. After your next reload it's
available as `/skill:<name>`.

### 4. Maintaining durable project & user memory

Episodic recall is great for "what did we do," but for stable, always-relevant context you can enable the
semantic-memory tasks. Turn them on with flags (see [Configuration](#configuration)):

```bash
pi --memsearch-project-review --memsearch-user-profile
```

Now, as you work, the agent periodically synthesizes `.memsearch/PROJECT.md` (project direction,
decisions, risks, next steps) and `.memsearch/USER.md` (your durable preferences and defaults). These are
injected at the start of every session, so the agent always opens with the project's stable state in
view. To check when they were last updated:

```
/memory-status
```

### 5. Troubleshooting recall that "feels empty"

If recall seems to return nothing, or you've just switched embedding provider/model:

```
/memory-status
```

The report shows the active collection and provider, how many journals exist, how many chunks are
actually indexed, and flags the common failure where journals exist but the index is empty. If the index
is stale or broken, rebuild it from the journals (the Markdown is preserved):

```
/memory-reset
```

For help interpreting the report or choosing settings, ask the config skill:

```
/skill:memory-config why is my indexed-chunk count zero when I have journals?
```

## Configuration

All options are pi flags. Pass them on the command line (`pi --flag value`) or set them in your pi
settings so they persist. The Milvus backend and embedding provider themselves are configured in
`memsearch`, not here.

| Flag | Type | Default | Effect |
| --- | --- | --- | --- |
| `--memsearch-provider <name>` | string | unset (defers to `memsearch` config) | Pins the embedding provider (e.g. `onnx`) on **both** index and search, so index-time and search-time providers cannot silently diverge. |
| `--memsearch-summary-model <ref>` | string | unset (uses the session model) | Pins a cheaper model for capture summarization, e.g. `anthropic/claude-haiku-4-5` or a bare unambiguous model id. The pinned model must be authenticated; an unresolvable value falls back to the session model with a one-time warning. |
| `--memsearch-project-review` | boolean | `false` | Enables the `project_review` task that synthesizes `.memsearch/PROJECT.md` from journals. |
| `--memsearch-user-profile` | boolean | `false` | Enables the `user_profile` task that synthesizes `.memsearch/USER.md` from journals. |
| `--memsearch-review-interval-hours <n>` | string | `24` | Minimum hours between semantic-memory synthesis runs. |

Examples:

```bash
# Offline embeddings, pinned on both index and search
pi --memsearch-provider onnx

# Cheap summarization model + durable project notes, synthesized at most every 6 hours
pi --memsearch-summary-model anthropic/claude-haiku-4-5 \
   --memsearch-project-review --memsearch-review-interval-hours 6
```

## Data layout

Everything this extension writes lives under `<project>/.memsearch/` (git-ignored by default):

```
.memsearch/
├── memory/YYYY-MM-DD.md      # daily episodic journals (source of truth)
├── PROJECT.md                # durable project notes  (if project_review enabled)
├── USER.md                   # durable user notes      (if user_profile enabled)
└── .maintenance-state.json   # synthesis / re-index bookkeeping
```

The journals are the source of truth — the Milvus index is always rebuildable from them via
`/memory-reset`.

## Development

```bash
npm install
npm run build
npm test          # per-module test suite (node --test via tsx)
npm run typecheck
```

The source is organized one concern per module under `src/` (capture, recall, semantic, reindex,
collection, lock, journal, memsearch CLI wrappers, …), each with a colocated `*.test.ts`. The extension
entry point is `src/index.ts`, which wires the surfaces together; handler registration order is
load-bearing (capture before semantic synthesis on `agent_end`; live re-index before cold-start on
`before_agent_start`), so preserve it when adding handlers.

To iterate against a live pi without installing, run pi with the extension flag:

```bash
pi -e .
```

See the [pi extension docs](https://github.com/earendil-works/pi-coding-agent/blob/main/docs/extensions.md)
and [pi package docs](https://github.com/earendil-works/pi-coding-agent/blob/main/docs/packages.md).

## License

MIT — see [LICENSE](./LICENSE).
