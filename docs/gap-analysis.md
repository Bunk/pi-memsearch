# pi-memsearch — Gap Analysis vs. Upstream memsearch

> Reference document. Compares `pi-memsearch` against the upstream
> [zilliztech/memsearch](https://github.com/zilliztech/memsearch) project and its four
> reference agent plugins (Claude Code, Codex, OpenCode, OpenClaw), and identifies
> gaps worth implementing to support pi agent-driven development.
>
> Date: 2026-06-19 · Branch: `main`

## Method

- Read the upstream repo: docs, CLI reference, all four platform plugins, the maintenance
  runner (`maintenance-runner.py`), and the prompt files (`summarize`, `project_review`,
  `user_profile`, `memory_to_skill`).
- Audited our plugin source: `src/index.ts`, `capture.ts`, `recall.ts`, `memsearch.ts`,
  `constants.ts`, `lock.ts`.
- Verified per-plugin feature support by inspecting each plugin's file tree and grepping
  (rather than inferring) for `watch`, `index`, cold-start injection, per-prompt hints,
  collection derivation, maintenance tasks, and skills.

## What we have today (solid)

`pi-memsearch` covers the **episodic memory** loop well — and in some respects more rigorously
than the reference plugins:

- **3-layer recall**: `memory_recall` (search) → `memory_expand` (expand) →
  `memory_transcript` (L3 via **native pi `SessionManager`**, so no transcript-format
  dependency).
- **Automatic capture** on `agent_end` (summarize → journal → index), crash-safe and
  idempotent across resume/reload/fork.
- **Cold-start injection** on the first prompt of a session.
- **Security hardening**: trust-gating (fail-closed), path confinement, argument-injection
  hardening (`--` separator), schema validation at the CLI boundary, cross-process R/W
  locking, provider pinning. The shell-based reference plugins have none of this — this is
  our edge.

## Gaps, ranked by value to pi agent-driven development

### 1. Per-project collection isolation — correctness/privacy bug

We never pass `--collection`, so **every project shares the default `memsearch_chunks`
collection** in the shared Milvus Lite DB. Journals are per-project, but search hits the
global collection with no source filter — so recall in project B can surface project A's
memories. Upstream solves this with `derive-collection.sh` (a deterministic per-project
collection name). We rely only on a global lock, which serializes access but does **not**
isolate data. Fix: derive a per-project collection and pass it to index / search / expand.

**This is the starkest gap** — the one feature with zero precedent for skipping. Small,
self-contained, and should be done first.

### 2. Procedural memory ("Skills from Memory") — highest dev value

Upstream's newest layer distills *recurring workflows* into installable Agent-Skills
`SKILL.md` files (`memsearch skills add/list/install`, the `/memory-to-skill` skill, plus an
opt-in background miner). Direct fit for pi — pi already has a first-class skills system
(`.pi/agents`, `.agents/skills`). We capture every exchange already and surface none of it as
reusable capability. "Make a skill out of what we just did" → a real pi `/`-command.

### 3. Semantic memory layer (PROJECT.md / USER.md)

Upstream's opt-in `project_review` / `user_profile` background tasks maintain durable notes —
active threads, decisions, risks, next steps, and reusable user preferences — refreshed only
when journals change and a min-interval has elapsed. We have only the episodic journal. A
durable, agent-readable `PROJECT.md` surfaced at session start would meaningfully improve
cross-session continuity.

### 4. Live re-indexing (`memsearch watch`)

Upstream runs `watch` as a session-scoped background process, so hand-edits to journals — and
writes from parallel pi subagents/sessions — get re-indexed immediately. We index only on our
own `agent_end`, so an externally-written or edited journal can go stale until the next
capture in *this* session. Relevant because pi spawns subagents and supports concurrent
sessions.

**Split precedent:** three plugins use a live watcher/daemon (Claude Code, Codex, OpenCode);
OpenClaw re-indexes inline on each captured turn. Two valid designs to choose from.

### 5. Config + diagnostics surface (`memory-config`, `stats`)

Upstream ships a `memory-config` skill that inspects config, file state, and index health, and
explains/changes settings in natural language. We expose exactly one flag
(`--memsearch-provider`) and no introspection. A `/memory-status` command (or skill) reporting
collection, chunk count (`stats`), provider, and journal dir would close most "why isn't
recall working" loops.

### 6. `compact` / `reset` surfacing

- `compact` — LLM compression of old chunks; matters for long-term scaling.
- `reset` — drop/rebuild after a provider/model switch.

**Never standalone** in any plugin — always reached through the `memory-config` skill's guided
flows. If we build the diagnostics/config surface (Priority 5), these come along as operations
within it.

### Minor / probably skip

- Per-prompt "memory available" hint — we cover this via tool descriptions + cold-start.
- Cross-agent L3 drill-down — other agents can't parse pi's JSONL via `memsearch transcript`,
  but our native L3 path is the better trade-off for pi.

## Plugin feature matrix

Legend: ✅ supported · ⚠️ partial / implicit · ❌ absent

### Baseline episodic memory (table stakes — we're at parity)

| Feature | pi-memsearch | Claude Code | Codex | OpenCode | OpenClaw |
|---|:--:|:--:|:--:|:--:|:--:|
| Auto-capture → journal → index | ✅ | ✅ | ✅ | ✅ (daemon) | ✅ |
| L1 search (`memory_recall`) | ✅ | ✅ | ✅ | ✅ | ✅ |
| L2 expand (`memory_expand`) | ✅ | ✅ | ✅ | ✅ | ✅ |
| L3 transcript drill-down | ✅ native pi | ✅ `transcript.py` | ✅ parse-rollout | ✅ parse-transcript | ✅ parse-transcript |
| Cold-start injection | ✅ | ✅ | ✅ | ✅ | ✅ |
| Per-prompt "memory available" hint | ❌ (tool-desc only) | ✅ | ✅ | ✅ | ⚠️ |
| Security hardening (trust gate, path confinement, arg-injection, R/W lock) | ✅ **strongest** | ⚠️ minimal | ⚠️ minimal | ⚠️ minimal | ⚠️ minimal |

### The six identified priorities (where we lag)

| Priority | pi-memsearch | Claude Code | Codex | OpenCode | OpenClaw |
|---|:--:|:--:|:--:|:--:|:--:|
| **1. Per-project collection isolation** | ❌ shared default | ✅ | ✅ | ✅ | ✅ |
| **2. Procedural memory (skills-from-memory)** | ❌ | ✅ | ✅ | ✅ | ✅ |
| **3. Semantic layer (PROJECT.md / USER.md)** | ❌ | ✅ opt-in | ✅ opt-in | ✅ opt-in | ✅ opt-in |
| **4. Live re-index (`watch`)** | ❌ index on `agent_end` | ✅ | ✅ | ✅ daemon | ⚠️ index-on-capture |
| **5. Config + diagnostics surface (`memory-config`, `stats`)** | ❌ (one flag) | ✅ | ✅ | ✅ | ✅ |
| **6. `compact` / `reset` surfacing** | ❌ | ✅ via skill | ✅ via skill | ✅ via skill | ✅ via skill |

## How the priorities align with existing plugins

- **Priorities 1, 2, 3, 5 are universal** across all four upstream plugins — they're no
  longer "advanced," they're the current standard. Implementing them closes us to parity
  rather than speculating. (Confirmed: `derive-collection.sh`, `maintenance-runner.py`, and
  all three skills — `memory-recall`, `memory-config`, `memory-to-skill` — ship in *all four*
  plugin dirs.)
- **Priority 1** is the starkest gap and the only feature with no precedent for skipping.
- **Priority 4** has a split precedent (live watcher/daemon vs. inline re-index), giving us
  two valid designs.
- **Priority 6** is never a standalone surface — it lives inside the config skill (Priority 5).
- **Our security hardening is the inverted gap** — the one dimension where every upstream
  plugin is behind us. Preserve it as the design constraint when porting these features:
  anything we add (collection derivation, watch, skill install paths) must stay trust-gated
  and path-confined.

**Net:** the upstream plugins converge on a 3-layer memory model (episodic + semantic +
procedural) with per-project isolation and a config skill as connective tissue. We've
implemented one layer (episodic) more safely than anyone, and none of the other two.

## Suggested implementation sequence

Highest-alignment, lowest-risk first:

1. **Per-project collection** (bug fix, small)
2. **Config + diagnostics surface** (`/memory-status`, `stats`) — connective tissue
3. **Procedural memory → pi skills** (flagship dev value)
4. **Semantic layer** (PROJECT.md / USER.md)
5. **Live re-index** (`watch`) — matters for subagents / parallel sessions
6. **`compact` / `reset`** — folded into the config surface

## Sources

- [zilliztech/memsearch (README)](https://github.com/zilliztech/memsearch)
- [memsearch CLI Reference](https://zilliztech.github.io/memsearch/cli/)
- [Skills from Memory](https://zilliztech.github.io/memsearch/home/skills-from-memory/)
- [Advanced Plugin Maintenance (Configuration)](https://zilliztech.github.io/memsearch/home/configuration/)
- [Claude Code plugin — How It Works](https://zilliztech.github.io/memsearch/platforms/claude-code/how-it-works/)
