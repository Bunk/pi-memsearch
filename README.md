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

## Development

```bash
npm install
npm run build
npm test        # runs the per-module test suite
```

See [pi extension docs](https://github.com/earendil-works/pi-coding-agent/blob/main/docs/extensions.md).

## License

MIT — see [LICENSE](./LICENSE).
