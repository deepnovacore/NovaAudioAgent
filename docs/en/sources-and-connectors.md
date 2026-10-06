# Sources and connectors

Nova only reads what you explicitly connect — local folders, mail and calendars, and Feishu chats — and only lets a model process that content once you separately consent to it.

## Connect, consent, pause, disconnect, delete

| Action | What it does |
|---|---|
| Connect | Grants access to a source: a folder, an account, or a set of chats |
| Consent to processing | A separate switch letting the configured model service read the content; a source can be connected without it |
| Pause | Keeps the connection and everything already collected; just stops new reads |
| Disconnect | Stops local collection but keeps already-collected data (and, for Feishu, your app configuration). For services connected through Composio it does not revoke the OAuth grant you gave; revoke that separately in Composio or the service itself if you need to |
| Delete history / local data | Removes what was already collected, as a separate step from disconnecting |

## Local files

In settings, under local files, the consent checkbox has to be checked before "choose folder" or "authorize all accessible local files" can be used. Each sync pass reads at most 1 to 200 files and up to 20 MB per source; anything beyond that is deferred to later passes, so this is a per-pass budget, not a lifetime cap. Supported types: text, Markdown, JSON, YAML, CSV, common source-code extensions, PDF and Word (`.docx`).

Version-control, build, dependency and cache directories, and browser profile folders, are excluded automatically. Hidden files and folders are skipped unless you pick them by name; anything your project already ignores in Git is skipped too. Whole-computer access also excludes system and application directories, still respects OS file permissions, processes in batches, and stops reading as soon as you pause it.

## Mail and calendar

| Source | Window | Checked per round | Kept for |
|---|---|---|---|
| macOS Mail | up to 180 days back | up to 500 messages | 180 days after receipt |
| macOS Calendar | — | up to 200 events per page | 30 days after the event ends |
| Composio Gmail | since the last sync, or a fresh snapshot the first time | up to 200 pending changes, 8 message bodies per page | 30 days after the message time |
| Composio Calendar | a configured window of past and future days | — | 30 days after the event ends |

macOS Mail and Calendar use the apps already on your Mac. Composio connects Google Mail and Calendar on any platform through its own OAuth flow, and caps how many source connections one host can hold open at once, at 20. Long message bodies are truncated (around 99,000 characters), with a note pointing back to the original for the rest.

## Feishu

Feishu access goes through your own Feishu app via `lark-cli` — there is no bundled app or shared credential. The connector requires `lark-cli` 1.0.69 or newer and refuses older versions outright.

1. **Connect an app** — create one on Feishu's own developer site, or bind one you already have with its App ID and secret. The secret is only ever piped in, never passed as a command-line argument, and an existing binding is never silently replaced.
2. **Sign in** your account through an OAuth device-code flow.
3. **Choose chats** — pick the real chats you want synced by name; there are no preset categories.

Required scopes cover reading your chat list, reading messages, reading message reactions, plus offline access for the OAuth token. The first sync covers the most recent 7 days, then resumes from where it left off. Text and rich-text messages are stored; attachments are not downloaded, and show a plain notice instead. Only messages from real people are recorded — the bot's own messages are never re-ingested. Message content is kept for 30 days.

Bot reminders are opt-in and delivered only to your own private chat with the bot, never a group. A reminder card can be opened, snoozed or ignored; opening it only navigates to Nova, it does not authorize anything. Credentials are stored in their own directory, isolated from any other app's login.

Disconnecting clears the login but keeps app configuration and history; deleting history clears the collected messages and the memory built from them, and reconnecting later starts a fresh collection.

[Workbench](workbench.md) · [Tasks](tasks.md) · [Personal memory](personal-memory.md) · [Core configuration](configuration.md)
