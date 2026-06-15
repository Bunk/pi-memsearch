# pi-memsearch

A [pi](https://github.com/earendil-works/pi-coding-agent) extension that integrates the
[memsearch](https://github.com/zilliztech/memsearch) agent memory plugin — a persistent,
unified, semantic memory layer for AI agents backed by Markdown and Milvus.

> **Status:** early scaffold. The integration is not yet implemented.

## What this does

memsearch gives AI coding agents a cross-platform, semantic long-term memory: conversation
turns are summarized to Markdown files and indexed into Milvus for hybrid (BM25 + dense vector)
retrieval. Plugins exist for Claude Code, Codex CLI, OpenClaw, and OpenCode — this project adds
a first-class plugin for **pi**.

Goals:

- **Capture** — summarize each conversation turn and append it to the memsearch Markdown journal.
- **Recall** — expose a tool (and `/memory-recall` command) so pi can semantically search past
  sessions via the `memsearch` CLI / Python API.
- **Zero-config defaults** — work out of the box with local ONNX embeddings + Milvus Lite,
  while allowing Zilliz Cloud / self-hosted Milvus to be configured.

## Requirements

- [pi](https://github.com/earendil-works/pi-coding-agent)
- The `memsearch` CLI on your `PATH`:
  ```bash
  uv tool install "memsearch[onnx]"   # or: pipx install / pip install
  ```

## Install (planned)

```bash
# Project-local
cp src/index.ts .pi/extensions/memsearch.ts

# or global
cp src/index.ts ~/.pi/agent/extensions/memsearch.ts
```

Then reload pi with `/reload`.

## Development

```bash
npm install
npm run build
```

See [pi extension docs](https://github.com/earendil-works/pi-coding-agent/blob/main/docs/extensions.md).

## License

MIT — see [LICENSE](./LICENSE).
