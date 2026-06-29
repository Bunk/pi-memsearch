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

> **Correction (2026-06-29).** Shipped, but the first cut keyed the collection off the **raw
> cwd**, which is not full parity with upstream's isolation. Two axes were missing, now fixed in
> `src/paths.ts` (`projectRoot`):
> - **git-root normalization.** Claude Code's `common.sh` keys off `git rev-parse --show-toplevel`,
>   so any subdir of a repo shares one collection. Keying off raw cwd meant a subdir launch and a
>   repo-root launch produced *different* collections (and wouldn't share memory with a Claude Code
>   install of the same repo). We now walk up for a `.git` entry and key off the repo root.
> - **symlink resolution.** `derive-collection.sh` uses `realpath -m`; we now `realpath` the root so
>   symlink-equivalent launch paths map to one collection.
>
> The journal dir, semantic notes, and maintenance state are anchored on the **same** resolved root
> (`memsearchDir`), so the collection and its source journals can never diverge — which also closes a
> latent data-loss footgun: a subdir-keyed journal dir + repo-root-keyed collection would let a
> `/memory-reset` from one subdir reindex only that subdir and silently drop the rest of the repo's
> indexed memory.

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

**Split precedent:** OpenClaw re-indexes inline on each captured turn; OpenCode runs a background
`capture-daemon.py` that polls its SQLite store and indexes. Claude Code / Codex run a `watch`
daemon **only against Server-mode Milvus (http/tcp)**.

> **Correction (2026-06-29).** The original "three plugins use a live watcher/daemon" framing is
> misleading for the **default Milvus-Lite** backend that we (and most users) run. In Lite mode
> Claude Code / Codex `start_watch` **explicitly skips `watch`** ("file lock prevents concurrent
> access") and instead indexes at session boundaries — `index` on session-start + `index` on the
> Stop hook. So in the common case there is no live daemon at all. Our digest-gated reindex on
> `before_agent_start` (turn start) is therefore comparable to — and arguably *more* responsive
> than — their session-boundary indexing for catching externally-written / parallel-session
> journals, without any long-lived process to orphan.

### 5. Config + diagnostics surface (`memory-config`, `stats`)

Upstream ships a `memory-config` skill that inspects config, file state, and index health, and
explains/changes settings in natural language. We expose exactly one flag
(`--memsearch-provider`) and no introspection. A `/memory-status` command (or skill) reporting
collection, chunk count (`stats`), provider, and journal dir would close most "why isn't
recall working" loops.

### 6. `compact` / `reset` surfacing

- `reset` — drop/rebuild after a provider/model switch. **✅ Shipped** in `ef52dfb` as part of the
  Priority 5 config surface (`/memory-reset`).
- `compact` — **Closed / won't-do** (decided 2026-06-28). The original premise here ("LLM
  compression of old chunks; matters for long-term scaling") was wrong on two counts, verified
  against the v0.4.10 CLI and the upstream plugin source:
  1. `memsearch compact` prunes/compresses **nothing**. It LLM-summarizes indexed chunks and
     **appends** a new `memory/YYYY-MM-DD.md` summary — additive, not reductive. No age/threshold
     flag exists; there is no prune-by-age mechanism short of `reset` or deleting source files. The
     scaling rationale is unachievable with this command.
  2. The "never standalone — always reached through the `memory-config` skill" claim is false. A
     direct read of all four reference plugins found **zero** compact invocations: it is not a
     `maintenance-runner.py` task, has no `compact.txt` prompt, and is absent from every
     `memory-config` SKILL.md (not even a `prompts.compact` key).
  Compact's real behavior (LLM synthesis → markdown artifact) overlaps the **semantic layer**
  (PROJECT.md/USER.md) we already shipped, and its default output path collides with capture's daily
  journal. Wiring it would put us *ahead of* every plugin on a feature none of them surface.
  Full evidence: `.rpiv/artifacts/research/2026-06-28_18-27-08_compact-gap-6.md`. A future reversal
  (a denser searchable rollup) would be a net-new product decision, not a parity gap.

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
| **4. Live re-index** | ✅ digest-gated reindex on turn-start | ⚠️ Lite: index at session boundaries (`watch` only in Server mode) | ⚠️ same | ✅ capture daemon | ⚠️ index-on-capture |
| **5. Config + diagnostics surface (`memory-config`, `stats`)** | ❌ (one flag) | ✅ | ✅ | ✅ | ✅ |
| **6. `compact` / `reset` surfacing** | ❌ | ✅ via skill | ✅ via skill | ✅ via skill | ✅ via skill |

## How the priorities align with existing plugins

- **Priorities 1, 2, 3, 5 are universal** across all four upstream plugins — they're no
  longer "advanced," they're the current standard. Implementing them closes us to parity
  rather than speculating. (Confirmed: `derive-collection.sh`, `maintenance-runner.py`, and
  all three skills — `memory-recall`, `memory-config`, `memory-to-skill` — ship in *all four*
  plugin dirs.)
- **Priority 1** is the starkest gap and the only feature with no precedent for skipping.
- **Priority 4** has a split precedent, but note (see §4 correction) that in the default
  Milvus-Lite backend Claude Code / Codex do **not** run a live `watch` daemon — they index at
  session boundaries. Our digest-gated turn-start reindex is comparable or better in that mode.
- **Priority 6**: `reset` shipped inside the config skill (Priority 5). `compact` is **closed /
  won't-do** — its real CLI behavior (summarize-and-append, not compression) doesn't match the need
  and no reference plugin wires it (see §6).
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
5. **Live re-index** (`watch`) — matters for subagents / parallel sessions ✅ shipped (`135cea2`)
6. **`reset`** — folded into the config surface ✅ shipped (`ef52dfb`); **`compact`** closed /
   won't-do (2026-06-28, see §6)

**Status (2026-06-28):** all six roadmap items resolved. Gaps 1–5 shipped; gap 6's `reset` shipped
and `compact` closed as not-applicable. The roadmap is complete.

## Sources

- [zilliztech/memsearch (README)](https://github.com/zilliztech/memsearch)
- [memsearch CLI Reference](https://zilliztech.github.io/memsearch/cli/)
- [Skills from Memory](https://zilliztech.github.io/memsearch/home/skills-from-memory/)
- [Advanced Plugin Maintenance (Configuration)](https://zilliztech.github.io/memsearch/home/configuration/)
- [Claude Code plugin — How It Works](https://zilliztech.github.io/memsearch/platforms/claude-code/how-it-works/)
