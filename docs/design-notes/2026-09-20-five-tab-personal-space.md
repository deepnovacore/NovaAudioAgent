# Five-tab personal space

The desktop workbench's icon rail exposes Todos, Ideas, Goals, Feeds, 任务 (executor tasks) and Profile (2026-09-21: memory inspection is a disclosure at the bottom of Profile). Proactive reminders are messages in the pinned 主动提醒 conversation of the right-hand Nova pane, each rendered as a card with its discuss/snooze/dismiss actions; source and connector controls live in the settings window under 连接与权限.

- Todos are user-owned actions with open/doing/waiting/done/cancelled state, optional due date and goal link. Asking Nova for help drafts a conversation; it does not imply execution or mark the Todo completed.
- Ideas can be edited, archived and converted once each to a Todo or Goal. Related objects survive archiving. Only child-to-parent links are stored.
- Goals have purpose, success criteria and explicit active/paused/completed/archived state. Action progress counts non-cancelled linked Todos; zero Todos does not mean success, and completing all Todos does not automatically complete the Goal.
- Profile edits a user-stated introduction and the single canonical news-interest collection. Existing evidence-backed memories retain their own correction/forget semantics. News reading/saving does not become a personal fact.
- Feeds fetches fixed BBC News, Guardian Technology and IT Home RSS feeds while explicitly enabled. It retains source errors, original links/times, validated model matches, read/save state, topic weights and blocked sources. Polling runs every 15 minutes while the application runs; manual refresh is available. This is not a guarantee of second-level publication latency or all-interest coverage.

## Ownership and persistence

PersonalAgentHost owns the existing authenticated command path and process lock. LifeService and NewsService are separate bounded domains stored beside the host file as `.life.json` and `.news.json`. BoundedJsonStore uses validated input, private files, atomic replacement and directory fsync. There is no second reminder agent, public-article-to-memory ingestion path, or background task created by a news card.

News cache is bounded to 500 articles including at most 100 saved items. Per-refresh model work is at most 24 articles, selected across sources in batches of eight; pending count is visible. Recommendations are restricted to the last seven days, with a per-source display cap and optional unrelated exploration. Stable URL dedupe is implemented; cross-publisher semantic event clustering is not. Failed ranking visibly falls back to a timeline when no current scores exist. Source failures retain cache. Blocked sources are excluded from recommendation but saved articles remain accessible.

## Background personal understanding

After a new complete user message is durably stored, the host starts interpretation in the background. ASR partials, duplicate finals, assistant replies, startup replay and merely selecting an old conversation do not trigger extraction. The current message supplies exact evidence spans; up to six preceding role-labeled messages provide bounded reference context. A new message, conversation switch or clear cancels the obsolete interpretation, and source identity is rechecked before writing.

Only a supported Todo with an explicit request to record that object is created automatically. A general request for advice or execution is not record authorization. The panel shows “已记下待办” with undo; undo removes the unedited version-1 record and refuses to overwrite later edits. Up to 20 session-local receipts are scoped to their conversation. Receipts are transient across restart; persisted Todos remain editable and cancellable. Other useful facets appear as “可能想记下” with optional edit/save/skip actions, without an extraction button or interrupting the chat. Profile acceptance appends with an optimistic version check. No record acceptance executes an external task. The compatibility `understanding.start` command remains available to old clients, but the UI does not expose it.

Same-candidate requests are idempotent within the bounded receipt history. Re-extraction that changes generated wording can produce a new candidate ID; semantic dedupe, matching existing objects, proposed revisions and cross-object reasoning remain outside this first version. The explicit introduction does not replace the evidence memory engine.

## Reproducible verification

- Runtime: `npm run build --workspace @nova-audio-agent/runtime`, then `node --test --test-concurrency=4 runtime/dist/test/*.test.js`.
- Desktop: `node --test clients/desktop/test/*.test.mjs`.
- Real RSS + configured model: `node --env-file=/absolute/private.env runtime/scripts/live/news-feed.mjs /absolute/isolated/output`.
- Real host automatic capture and candidate lifecycle: `node --env-file=/absolute/private.env runtime/scripts/live/personal-understanding.mjs /absolute/isolated/output`.
- Isolated Electron: run `clients/desktop/scripts/personal-space-live.mjs` with Electron. `NOVA_SPACE_NEWS_DATA` optionally points to the prior live news cache. `NOVA_SPACE_LIVE_MODEL=1` and `NOVA_SPACE_ENV_FILE` enable the synthetic-message real-model UI check; `NOVA_SPACE_JEV_ENV_FILE` optionally loads the separate Jev credential environment. The conversation reply is stubbed, while extraction and Jev judgment use their actual configured services. External browser opening is intercepted after URL validation and reported as such.

Live scripts use synthetic profile/messages, never the user's actual memory database. Model availability is a required gate, not a mocked pass. Browser preview/screenshot is not native acceptance. Human-blinded recommendation quality, broad source coverage, 24-hour stability and a packaged installed release have not been completed by these scripts.

## Default Jev judgments

Jev (`typesafe/jev-1.13`, OpenRouter Decisions endpoint) is now the default for personal candidate decisions and public news ranking. The configured chat model still extracts open-ended text; Jev assesses attribution, modality, support, retention value and explicit recording intent in one batch. Source/context versions remain checked before applying a record. Per-dimension probability distributions are retained; confidence is not authorization.

News judgments compare every supplied excerpt with each explicit interest and assess concrete content versus thin/promotional excerpts. Relevance probabilities drive interest weights; code applies a bounded content-quality discount. Only title/summary evidence is used, with no claim to have read full articles. Failed calls stay visible; there is no silent provider fallback.

Set `OPENROUTER_API_KEY` in the ignored development `.env`, or save the OpenRouter key through desktop Settings, which uses the existing secret-storage mechanism. It is independent of conversational provider credentials. Never commit a key. Missing credentials leave affected judgments unavailable; manually managed personal objects remain usable. A source build or restart is required to load configuration changes; the running installed application is not hot-patched.
