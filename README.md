# pi-memsearch

A [pi](https://github.com/earendil-works/pi-coding-agent) extension that gives your coding
agent **persistent, semantic long-term memory** across sessions, backed by
[memsearch](https://github.com/zilliztech/memsearch) — Markdown journals indexed into Milvus
for hybrid (BM25 + dense vector) retrieval.

Every exchange is summarized to a daily Markdown journal and indexed automatically. On the
first prompt of each session, relevant memories from past sessions are surfaced back to the
agent. The agent can also search, expand, and read verbatim past conversations on demand.

## How it works

```
 ┌── you ↔ agent exchange ──┐
 │                          │   agent_end
 ▼                          ▼
 summarize (pi model) ─► .memsearch/memory/YYYY-MM-DD.md ─► memsearch index ─► Milvus
                                                                                  │
 next session, first prompt ──► memsearch search ──► relevant memories injected ◄─┘
```

1. **Capture** — on every `agent_end`, the exchange is summarized into 2–10 bullet points
   (using pi's own model), appended to the project's daily journal, and incrementally indexed.
2. **Cold-start recall** — on the first prompt of a session, the prompt is used to search past
   memory and the top matches are injected into context (once per session, never per-turn).
3. **On-demand recall** — three tools + a slash command let the agent (or you) search, expand,
   and drill down into the original transcript via *progressive disclosure*.

## Features

### Recall surfaces

| Surface | Backed by | Purpose |
| --- | --- | --- |
| `memory_recall` *(tool)* | `memsearch search` | L1 — hybrid semantic + keyword search of past sessions. Returns ranked chunks with `chunk_hash` + source anchors. |
| `memory_expand` *(tool)* | `memsearch expand` | L2 — expand a `chunk_hash` from a recall result to its full heading section. |
| `memory_transcript` *(tool)* | native pi `SessionManager` | L3 — read the verbatim original conversation (turns + tool calls) behind a memory, from its transcript anchor. |
| `/memory-recall <query>` *(command)* | `memsearch search` | Manually search memory and print results into the session. |

The agent uses these as **progressive disclosure**: search → expand the promising chunk →
read the original transcript turn only if needed.

### Cold-start recall

On the first user prompt of each session (and after a fork / tree-switch), pi-memsearch
searches memory with that prompt and injects the top 3 matches as a displayed context message.
The slot is consumed only on a *successful* search, so a transient failure retries on the next
prompt. A persistent failure warns **once** rather than toasting every prompt.

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

The anchor comment links each memory back to the exact pi session, turn, and transcript so
`memory_transcript` can reconstruct the original dialogue. Capture is **crash-safe and
idempotent**: the journal append happens first and is deduplicated per entry, the bookkeeping
marker is written only after a successful append, and indexing never promotes an unjournaled
exchange. Resuming, reloading, or forking a session never double-writes.

### Safety

- **Trust-gated (fail-closed)** — every read path *and* the auto-firing capture/cold-start are
  gated on `ctx.isProjectTrusted()`. Untrusted projects spawn no `memsearch` subprocess.
- **Path confinement** — `memory_transcript` resolves and refuses any transcript path outside
  the project's pi session directory (symlink-aware).
- **Argument injection hardening** — untrusted values (queries, hashes, paths) are passed after
  a `--` end-of-options separator so a value beginning with `--` is treated as data, not a flag.
- **Schema validation** — CLI JSON is narrowed through runtime guards at the boundary; schema
  drift surfaces as an actionable error instead of a downstream `undefined`.
- **Cross-process locking** — the default Milvus Lite DB is shared across *all* projects, so
  every CLI call is serialized through a global reader/writer lock (shared read for
  search/expand, exclusive write for index). A single CLI call is capped at 5 minutes.

### Zero-config

The Milvus backend and embedding provider are owned by your `memsearch` config — works out of
the box with local ONNX embeddings + Milvus Lite, and scales to Zilliz Cloud / self-hosted
Milvus without touching this extension.

## Requirements

- [pi](https://github.com/earendil-works/pi-coding-agent)
- The `memsearch` CLI on your `PATH`:
  ```bash
  uv tool install "memsearch[onnx]"   # or: pipx install / pip install
  memsearch config set embedding.provider onnx   # offline embeddings, no API key
  ```

## Install

This is a [pi package](https://github.com/earendil-works/pi-coding-agent/blob/main/docs/packages.md) — its extension is
declared via the `pi.extensions` key in `package.json`, so install it with `pi install` rather than copying files (the
entry point imports sibling modules that a single-file copy would leave behind).

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

## Usage

Once installed and the project is trusted, capture and cold-start recall are **automatic** — no
action needed. Memories accumulate under `.memsearch/memory/` and are surfaced on future
sessions.

To search memory manually:

```
/memory-recall how did we decide to handle the write lock?
```

The agent will also call `memory_recall` / `memory_expand` / `memory_transcript` on its own when
you reference a prior conversation, decision, or context that isn't in the current session.

### Configuration

| Flag | Default | Effect |
| --- | --- | --- |
| `--memsearch-provider <name>` | unset (defers to `memsearch` config) | Pins the embedding provider (e.g. `onnx`) on **both** index and search so index-time and search-time providers cannot silently diverge. |

```bash
pi --memsearch-provider onnx
```

## Development

```bash
npm install
npm run build
npm test          # per-module test suite (node --test via tsx)
npm run typecheck
```

See the [pi extension docs](https://github.com/earendil-works/pi-coding-agent/blob/main/docs/extensions.md)
and [pi package docs](https://github.com/earendil-works/pi-coding-agent/blob/main/docs/packages.md).

## License

MIT — see [LICENSE](./LICENSE).
