# Knowledge base

Import your own documents so Nova can search them and cite what it finds. The knowledge base is separate from personal memory: it holds documents you admit deliberately, not facts gathered from conversation.

## Turn it on

The module is off by default. Enable it in the settings panel, or set `modules.knowledge.enabled` in `~/.nova-audio-agent/capabilities.json`. Embedding needs your DashScope credential.

## Import documents

Use the knowledge panel on the computer. Adding files, adding a folder, adding a URL, removing a source and rebuilding the index are all host actions — a model can never import or delete on your behalf.

| Source | Notes |
|---|---|
| Files | Text, Markdown, HTML, PDF and Word (`.docx`) |
| Folder | Imports supported files found inside |
| URL | Public addresses only; private and loopback addresses are refused |

Each document is split into overlapping passages of roughly 800 tokens, following headings where the format has them. One store holds up to 100 sources and 20,000 passages.

Importing is not instant. The panel shows each source and reports failed jobs; retry after checking the file format, the sensitive-content rule below, or your service connection.

## Where your data goes

Passages are stored locally at `~/.nova-audio-agent/knowledge.sqlite` (override with `KNOWLEDGE_PATH`).

**Local storage does not mean local processing.** To make documents searchable, their text is sent to the configured embedding service — DashScope `text-embedding-v4` by default. Import only documents you are willing to send there. Content that looks like a credential is rejected before it is stored or sent.

## How Nova uses it

Nova searches the corpus only when the answer calls for it; nothing is injected into every conversation automatically. Results are combined from meaning-based and keyword matching, and Nova treats them as **evidence, not instructions** — a document cannot direct Nova to act.

When Nova hands coding work to Codex, it may attach short passages as references. Citations are pinned to the exact passage content, so if you edit or remove a source, an old citation reports itself as outdated or missing rather than quietly returning the wrong text.

Optionally you can expose the corpus to Codex directly, so it can open a cited passage in full. Codex still cannot modify the corpus.

## Limits

Search quality depends on the embedding service. Removing a source removes its passages but does not retract text already sent for embedding. Rebuilding the index re-sends document text.

[Personal memory](personal-memory.md) · [Core configuration](configuration.md) · [Features](features.md)
