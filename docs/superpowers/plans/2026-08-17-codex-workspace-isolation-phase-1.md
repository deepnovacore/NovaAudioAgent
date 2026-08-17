# Codex Workspace Isolation Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the web-versus-desktop clarification bias and guarantee that every independent Codex work order starts in a fresh Codex app-server thread.

**Architecture:** Keep natural clarification in the realtime frontend prompt, but express only a generic material-choice rule. Preserve startup prewarming for the first task, then close the app-server session after every completed work order so a later run must establish a fresh process and thread; same-turn `codex.steer` remains unchanged.

**Tech Stack:** Python 3.11+, pytest/pytest-asyncio, Ruff, Codex app-server JSON-RPC transport, Qwen Audio Realtime prompt.

## Global Constraints

- `NOVA_AUDIO_AGENT_CODEX_WORKSPACE` remains the single configured workspace in Phase 1.
- Do not change provider tool schemas, authorization, Runtime event contracts, progress projection, redaction, or user-visible startup flow.
- Ask at most one question only for a missing choice that materially changes the accepted result or validation method and cannot be safely inferred.
- Do not name a preferred artifact pair such as web page versus desktop program in the frontend instructions.
- Each accepted independent `codex.run` work order gets a fresh Codex thread.
- `codex.steer` remains same-turn only and must still reject steering after completion.
- Do not add dependencies.
- Preserve the user's untracked root `index.html`, `script.js`, and `styles.css`.

## File Structure

- `src/nova_audio_agent/realtime/qwen.py`: owns the provider-facing realtime instructions; only the clarification paragraph changes.
- `tests/test_realtime_qwen.py`: owns static prompt invariants and the regression against a preferred delivery-form pair.
- `src/nova_audio_agent/executors/codex_app_server.py`: owns app-server process, thread, turn, steering, and cleanup lifecycle; a clean warm run will now use the existing teardown path rather than retain its thread.
- `tests/test_codex_app_server.py`: owns the fake app-server protocol peer and lifecycle assertions; reuse-oriented tests become isolation-oriented tests while same-turn steering coverage remains intact.

---

### Task 1: Make clarification generic

**Files:**
- Modify: `tests/test_realtime_qwen.py:565-595`
- Modify: `src/nova_audio_agent/realtime/qwen.py:71-79`

**Interfaces:**
- Consumes: module constant `FRONTEND_INSTRUCTIONS: str`.
- Produces: a provider instruction string containing the generic material-choice policy and no `网页还是桌面程序` preferred pair.

- [ ] **Step 1: Replace the clarification invariant test with the generic rule and add the regression assertion**

Update the existing test in `tests/test_realtime_qwen.py` to read:

```python
def test_frontend_instructions_clarify_only_one_uninferable_material_choice() -> None:
    for phrase in (
        "最多追问一个",
        "验收结果或验证方式",
        "无法从当前请求和对话安全推断",
        "这一轮不得调用 codex__run",
        "可以合理默认",
    ):
        assert phrase in FRONTEND_INSTRUCTIONS
    assert "网页还是桌面程序" not in FRONTEND_INSTRUCTIONS
```

Keep `test_frontend_instructions_merge_clarification_into_one_work_order` unchanged; it covers the answer-merging and direct-dispatch half of the contract.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
uv run pytest tests/test_realtime_qwen.py::test_frontend_instructions_clarify_only_one_uninferable_material_choice -q
```

Expected: FAIL because the new generic phrases are absent and `网页还是桌面程序` is still present.

- [ ] **Step 3: Replace the concrete example with the generic decision rule**

In `src/nova_audio_agent/realtime/qwen.py`, replace only the clarification paragraph with:

```python
当用户要求实现、创建或开发，但缺少一个会实质改变验收结果或验证方式、
且无法从当前请求和对话安全推断的关键选择时，最多追问一个简短问题；
这一轮不得调用 codex__run。可以合理默认的偏好、样式或细节不要追问。
如果用户目标、主要约束和验收边界已经足够，直接调用 codex__run，不要为了追问而追问。
用户回答后，把原始目标、用户的补充要求和验收方式合并成一个完整 work_order，
不得重复追问，也不得拆成多个 Codex 任务。
```

Do not change the surrounding work-order preservation, monitoring, recall, status, or tool-result instructions.

- [ ] **Step 4: Run the prompt contract tests and verify GREEN**

Run:

```bash
uv run pytest tests/test_realtime_qwen.py::test_frontend_instructions_clarify_only_one_uninferable_material_choice tests/test_realtime_qwen.py::test_frontend_instructions_merge_clarification_into_one_work_order tests/test_realtime_qwen.py::test_frontend_instructions_preserve_the_complete_codex_work_order -q
```

Expected: `3 passed`.

- [ ] **Step 5: Run the complete realtime Qwen unit file**

Run:

```bash
uv run pytest tests/test_realtime_qwen.py -q
```

Expected: all tests pass with no failures or warnings introduced by this change.

- [ ] **Step 6: Commit the clarification correction**

```bash
git add tests/test_realtime_qwen.py src/nova_audio_agent/realtime/qwen.py
git commit -m "fix: remove clarify delivery bias"
```

### Task 2: Isolate every independent Codex work order

**Files:**
- Modify: `tests/test_codex_app_server.py:975-1190`
- Modify: `src/nova_audio_agent/executors/codex_app_server.py:55-65,215-235,450-490,840-875`

**Interfaces:**
- Consumes: `CodexAppServerTransport.run(work_order, *, on_status, on_progress, deadline=None) -> CodexTransportResult`, `CodexAppServerTransport.steer(instruction) -> SteerTransportResult`, and the existing `_teardown_session() -> Literal["none", "terminate", "kill"]` cleanup path.
- Produces: the same transport result schema, but every completed run reports a closed transport and leaves no reusable process/thread; a subsequent run establishes a fresh process and thread.

- [ ] **Step 1: Turn the old reuse test into a failing isolation regression**

Replace `test_completed_turns_reuse_the_warm_process_and_thread` in `tests/test_codex_app_server.py` with:

```python
async def test_completed_work_orders_use_distinct_app_server_threads(tmp_path: Path) -> None:
    transport, factory = _warm_transport(
        tmp_path,
        lambda: _Peer(tmp_path, multi_turn=True),
    )
    await transport.prewarm()

    first = await transport.run("task-1", on_status=lambda _s: None, on_progress=None)
    second = await transport.run("task-2", on_status=lambda _s: None, on_progress=None)

    assert first.classification == "completed"
    assert second.classification == "completed"
    assert len(factory.processes) == 2
    assert all(process.returncode == 0 for process in factory.processes)
    assert [_method_count(peer, "thread/start") for peer in factory.peers] == [1, 1]
    assert [_method_count(peer, "turn/start") for peer in factory.peers] == [1, 1]
    assert first.content["protocol"]["transport_closed"] is True
    assert second.content["protocol"]["transport_closed"] is True
    assert second.content["process"]["exit_code"] == 0
    assert second.content["process"]["stop"] == "none"
```

This test uses separate app-server processes as the observable proof of separate thread lifetimes. It does not expose private thread IDs through production results.

- [ ] **Step 2: Run the isolation regression and verify RED**

Run:

```bash
uv run pytest tests/test_codex_app_server.py::test_completed_work_orders_use_distinct_app_server_threads -q
```

Expected: FAIL at `len(factory.processes) == 2`; current behavior keeps one warm process and one thread for both turns.

- [ ] **Step 3: Update old lifecycle tests to state the new contract**

Make these focused edits in `tests/test_codex_app_server.py` before changing production code:

1. In `test_prewarm_establishes_the_thread_before_the_first_run`, keep the pre-run assertions unchanged. After `transport.run`, assert the first process has exited and the result says the transport is closed:

```python
    assert result.classification == "completed"
    assert len(factory.processes) == 1
    assert _method_count(peer, "initialize") == 1
    assert _method_count(peer, "thread/start") == 1
    assert _method_count(peer, "turn/start") == 1
    assert factory.processes[0].returncode == 0
    assert result.content["protocol"]["transport_closed"] is True
    assert transport._preflight.calls == 1  # type: ignore[attr-defined]
```

2. Replace `test_sensitive_inputs_redact_across_warm_turns` with a task-lifetime assertion:

```python
async def test_sensitive_inputs_are_cleared_after_each_completed_work_order(
    tmp_path: Path,
) -> None:
    transport, factory = _warm_transport(
        tmp_path,
        lambda: _Peer(tmp_path, multi_turn=True),
    )
    await transport.prewarm()

    first = await transport.run("机密工单甲", on_status=lambda _s: None, on_progress=None)

    assert first.classification == "completed"
    assert transport._sensitive_inputs == []  # type: ignore[attr-defined]

    second = await transport.run("任务乙", on_status=lambda _s: None, on_progress=None)

    assert second.classification == "completed"
    assert transport._sensitive_inputs == []  # type: ignore[attr-defined]
    assert len(factory.processes) == 2
```

3. Delete `test_warm_thread_recycles_at_the_turn_cap`; a configurable multi-turn cap contradicts the new invariant.

4. Delete `test_sensitive_input_pressure_recycles_the_warm_thread`; cross-work-order sensitive-input accumulation no longer exists. Keep `test_redaction_set_survives_a_full_turn_of_steers`, which covers multiple sensitive inputs within one active task.

5. Replace `test_stale_turn_started_cannot_hijack_the_next_warm_turn` with a post-completion steering assertion that uses the prewarmed transport:

```python
async def test_completed_isolated_work_order_cannot_be_steered(tmp_path: Path) -> None:
    transport, factory = _warm_transport(tmp_path, lambda: _Peer(tmp_path, multi_turn=True))
    await transport.prewarm()

    result = await transport.run("task-1", on_status=lambda _s: None, on_progress=None)
    stale = await transport.steer("do not send")

    assert result.classification == "completed"
    assert (stale.code, stale.written) == ("stale_turn", False)
    assert _method_count(factory.peers[0], "turn/steer") == 0
```

Do not alter `test_same_turn_steer_is_written_while_turn_start_is_waiting` or `test_redaction_set_survives_a_full_turn_of_steers`; they are the acceptance coverage for same-turn steering.

- [ ] **Step 4: Run the edited lifecycle group and confirm it still fails for the production reason**

Run:

```bash
uv run pytest tests/test_codex_app_server.py -q
```

Expected: the new isolation and closed-after-prewarm assertions fail because a clean warm completion still retains the process/thread. Same-turn steering tests should remain green.

- [ ] **Step 5: Make clean warm completion always use the existing teardown path**

In `src/nova_audio_agent/executors/codex_app_server.py`, remove both
`MAX_TURNS_PER_THREAD` and `MAX_SENSITIVE_INPUTS`, the `_turns_on_thread`
instance field, and both `_turns_on_thread = 0` reset sites. After the clean
branch below is simplified, neither constant has another production reference;
same-turn redaction retains every appended value until teardown.

Replace the complete `if clean:` branch in `_run_warm` with:

```python
            if clean:
                process = self._process
                stop = await self._teardown_session()
                exit_code = None if process is None else process.returncode
                on_status(
                    CodexProcessStatus(
                        running=exit_code is None,
                        exited=exit_code is not None,
                        terminal="completed" if exit_code is not None else None,
                        exit_code=exit_code,
                    )
                )
                return CodexTransportResult(
                    classification="completed",
                    code="completed",
                    content=_content(
                        completion=completion,
                        exit_code=exit_code,
                        stop=stop,
                        final_message=final_message,
                    ),
                )
```

Do not change `_run_cold`: it already closes and clears its process, private home, thread state, and sensitive inputs in `finally`.

Update `_append_sensitive`'s docstring to describe the remaining same-task purpose without claiming that separate work orders share a thread:

```python
    def _append_sensitive(self, text: str) -> None:
        """Retain the active work order and same-turn steers until final redaction."""
        self._sensitive_inputs.append(text)
```

- [ ] **Step 6: Run focused app-server tests and verify GREEN**

Run:

```bash
uv run pytest tests/test_codex_app_server.py::test_prewarm_establishes_the_thread_before_the_first_run tests/test_codex_app_server.py::test_completed_work_orders_use_distinct_app_server_threads tests/test_codex_app_server.py::test_completed_isolated_work_order_cannot_be_steered tests/test_codex_app_server.py::test_same_turn_steer_is_written_while_turn_start_is_waiting tests/test_codex_app_server.py::test_redaction_set_survives_a_full_turn_of_steers tests/test_codex_app_server.py::test_sensitive_inputs_are_cleared_after_each_completed_work_order -q
```

Expected: `6 passed`.

- [ ] **Step 7: Run the complete Codex transport/adapter regression set**

Run:

```bash
uv run pytest tests/test_codex_app_server.py tests/test_codex_app_server_protocol.py tests/test_codex_live.py tests/test_codex_executor.py tests/test_assembly.py tests/test_realtime_desktop_entry.py -q
```

Expected: all selected tests pass. The adapter may still accept a generic worker's `transport_closed=False` result, but the production `CodexAppServerTransport` never returns an open transport after a completed independent run.

- [ ] **Step 8: Run lint and formatting checks on the changed Python files**

Run:

```bash
uv run ruff check src/nova_audio_agent/realtime/qwen.py src/nova_audio_agent/executors/codex_app_server.py tests/test_realtime_qwen.py tests/test_codex_app_server.py
uv run ruff format --check src/nova_audio_agent/realtime/qwen.py src/nova_audio_agent/executors/codex_app_server.py tests/test_realtime_qwen.py tests/test_codex_app_server.py
```

Expected: both commands exit 0.

- [ ] **Step 9: Commit the thread isolation change**

```bash
git add tests/test_codex_app_server.py src/nova_audio_agent/executors/codex_app_server.py
git commit -m "fix: isolate codex work order threads"
```

## Final Verification

- [ ] Run the repository's complete Python verification:

```bash
uv run ruff check src tests scripts
uv run ruff format --check src tests scripts
uv run pytest -q
uv build
```

Expected: every command exits 0 and pytest reports zero failures.

- [ ] Run the desktop verification because Ambient Orb owns the backend startup boundary:

```bash
(cd desktop/ambient-orb && npm test && npm run build)
```

Expected: both commands exit 0. `npm ci` is unnecessary when the locked dependencies are already installed; run it first only if `node_modules` is absent.

- [ ] Inspect the final scope:

```bash
git status --short
git diff HEAD~2 -- src/nova_audio_agent/realtime/qwen.py src/nova_audio_agent/executors/codex_app_server.py tests/test_realtime_qwen.py tests/test_codex_app_server.py
```

Expected: only the four planned source/test files changed across the two implementation commits; the pre-existing untracked root frontend files remain unmodified.
