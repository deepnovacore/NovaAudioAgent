# I5: tools on host-requested continuations

Date: 2026-09-06. Status: accepted for `v0.2.0dev`.

## Approval record

The following excerpts are transcribed from the user-approved implementation plan
in the Codex conversation that produced this record. This is a durable transcription
of that conversation, not an independently retrieved transcript or a live-test receipt.

> 知识库实现 content_digest；I5 收窄禁用工具的范围，支持工具结果续接。

The approved Phase 1 instruction specifies the boundary:

> 按宿主请求的实际类型决定工具权限：事实播报禁用工具，tool_output 续接保留工具；不把 response origin 当授权。

## Decision and scope

Host factual narration disables tools. A bound `tool_output` continuation retains
its configured tools so a requested multi-step tool chain can continue. Response
origin provides correlation only; current user item / revision and host confirmation
ownership still govern authorization for side effects.

This supersedes the blanket `host_request` → `tools: []` disposition retained as
history in [branch review roadmap §3.5](../handoffs/2026-09-06-branch-review-and-merge-roadmap.md#35-已拍板的合并前处置).
It does not close live provider, human audio, or release acceptance gates. The
[integration review follow-up](../handoffs/2026-09-06-integration-review-followup.md)
records implementation verification separately.
