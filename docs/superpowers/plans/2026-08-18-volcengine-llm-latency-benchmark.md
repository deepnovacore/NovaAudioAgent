# Volcengine LLM Latency Benchmark Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and run an opt-in Ark model benchmark that selects a faster realtime LLM only when its function-call reliability is not below the current Seed 2.0 Pro baseline.

**Architecture:** A provider-independent benchmark core defines synthetic Chinese tool cases, scores normalized `ArkResponsesClient` events, and aggregates content-free quality and latency metrics. A separate live CLI constructs the production Ark client for an explicit model allowlist; default CI injects fake streams and never uses credentials or network access. Production configuration changes only after the live matrix and full speech smoke both pass.

**Tech Stack:** Python 3.11+, asyncio, OpenAI `AsyncOpenAI` Responses client, existing `ArkResponsesClient`, `jsonschema` Draft 2020-12 validation, pytest/pytest-asyncio, ruff.

## Global Constraints

- Keep `doubao-seed-2-0-pro-260215` as the baseline until a live candidate passes every quality gate.
- Test only the six explicit model IDs in the design; reject arbitrary model IDs at the CLI boundary.
- Use `thinking=disabled`, `parallel_tool_calls=false`, `store=true`, and `previous_response_id` through the existing production Ark client.
- Never log API keys, prompts, arguments, tool outputs, response text, response bodies, microphone audio, or full conversations.
- Live provider calls require `--live` and never run in default CI.
- A candidate must match or exceed the baseline overall and in every case category, with zero severe failures.
- Do not add runtime failover or a DeepSeek Chat Completions adapter during this plan.

---

### Task 1: Benchmark Cases and Structural Scoring

**Files:**
- Create: `src/nova_audio_agent/realtime/volcengine/benchmark.py`
- Modify: `src/nova_audio_agent/realtime/volcengine/__init__.py`
- Modify: `pyproject.toml`
- Modify: `uv.lock`
- Test: `tests/test_realtime_volcengine_benchmark.py`

**Interfaces:**
- Consumes: `ArkToolCall`, `ArkTextDelta`, and `ArkResponseFailed` from `realtime.volcengine.ark`.
- Produces: `BenchmarkCase`, `CaseExpectation`, `CaseScore`, `benchmark_cases()`, and `score_events(case, events)`.

- [ ] **Step 1: Write failing scoring tests**

```python
def test_score_events_accepts_exact_schema_valid_tool_call() -> None:
    case = next(case for case in benchmark_cases() if case.case_id == "weather_exact")
    score = score_events(
        case,
        [ArkToolCall("item", "call", "weather__get", {"city": "上海", "unit": "celsius"})],
    )
    assert score.passed is True
    assert score.severe_failure is False


def test_score_events_rejects_wrong_tool_and_mixed_text() -> None:
    case = next(case for case in benchmark_cases() if case.case_id == "weather_exact")
    score = score_events(
        case,
        [ArkTextDelta("我来查询"), ArkToolCall("item", "call", "calendar__list", {})],
    )
    assert score.passed is False
    assert score.correct_tool is False
    assert score.mixed_text_and_tool is True
    assert score.severe_failure is True


def test_score_events_accepts_expected_no_call() -> None:
    case = next(case for case in benchmark_cases() if case.case_id == "small_talk_no_call")
    score = score_events(case, [ArkTextDelta("你好")])
    assert score.passed is True
    assert score.unexpected_tool is False
```

- [ ] **Step 2: Run the new tests and verify RED**

Run: `uv run pytest tests/test_realtime_volcengine_benchmark.py -q`

Expected: collection fails because `benchmark` and its public types do not exist.

- [ ] **Step 3: Implement immutable cases and strict scoring**

Implement these public shapes:

```python
@dataclass(frozen=True, slots=True)
class CaseExpectation:
    kind: Literal["tool", "text"]
    tool_name: str | None = None
    argument_equals: Mapping[str, Any] = field(default_factory=dict)
    continuation_output: str | None = None
    continuation_facts: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class BenchmarkCase:
    case_id: str
    category: str
    input_items: tuple[dict[str, Any], ...]
    tools: tuple[dict[str, Any], ...]
    expectation: CaseExpectation


@dataclass(frozen=True, slots=True)
class CaseScore:
    passed: bool
    correct_tool: bool
    valid_arguments: bool
    unexpected_tool: bool
    mixed_text_and_tool: bool
    provider_failed: bool
    continuation_passed: bool | None
    severe_failure: bool
```

Use `Draft202012Validator(tool["parameters"]).is_valid(arguments)` and exact expected key/value checks. Treat invented/wrong tools, unexpected calls, invalid argument objects, mixed prose/tool output, and provider failures as severe. Define cases for exact weather selection, ordinary small talk, ambiguous calendar request, similar calendar tools, nested device configuration, unsupported/injected argument, continuation, and short multi-turn context. All prompts and fake tool outputs must be synthetic.

Add `jsonschema>=4.23,<5` to the `volcengine` optional extra, run `uv lock`, and re-export only the benchmark types/functions needed by the script.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `uv run pytest tests/test_realtime_volcengine_benchmark.py -q`

Expected: all scoring tests pass.

- [ ] **Step 5: Commit Task 1**

```bash
git add pyproject.toml uv.lock src/nova_audio_agent/realtime/volcengine/benchmark.py src/nova_audio_agent/realtime/volcengine/__init__.py tests/test_realtime_volcengine_benchmark.py
git commit -m "test: add Volcengine function-call benchmark cases"
```

---

### Task 2: Async Runner, Continuation, and Sanitized Metrics

**Files:**
- Modify: `src/nova_audio_agent/realtime/volcengine/benchmark.py`
- Test: `tests/test_realtime_volcengine_benchmark.py`

**Interfaces:**
- Consumes: an object implementing `stream(input_items, tools, previous_response_id) -> AsyncIterator[ArkEvent]`.
- Produces: `AttemptResult`, `ModelSummary`, `run_attempt(client, model, case, repeat, clock)`, `summarize_model(model, attempts)`, and `candidate_passes_gate(baseline, candidate)`.

- [ ] **Step 1: Write failing runner and gate tests**

```python
@pytest.mark.asyncio
async def test_run_attempt_scores_tool_continuation_without_retaining_content() -> None:
    client = FakeArkClient(first_tool_call=True, continuation_text="上海，晴，22度")
    case = next(case for case in benchmark_cases() if case.case_id == "weather_continuation")
    result = await run_attempt(client, "model", case, repeat=0, clock=StepClock())
    assert result.score.passed is True
    assert result.score.continuation_passed is True
    assert result.function_call_ms is not None
    assert result.continuation_first_text_ms is not None
    assert not hasattr(result, "response_text")


def test_candidate_gate_requires_each_category_and_zero_severe_failures() -> None:
    baseline = ModelSummary.for_test(overall_rate=0.9, categories={"selection": 0.9})
    faster = ModelSummary.for_test(overall_rate=1.0, categories={"selection": 1.0})
    regressed = ModelSummary.for_test(
        overall_rate=1.0, categories={"selection": 0.8}, severe_failures=0
    )
    assert candidate_passes_gate(baseline, faster) is True
    assert candidate_passes_gate(baseline, regressed) is False
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `uv run pytest tests/test_realtime_volcengine_benchmark.py -q`

Expected: failures for missing runner, summary, and gate functions.

- [ ] **Step 3: Implement event timing and continuation**

`run_attempt` must:

1. timestamp before `client.stream` consumption;
2. record `ArkResponseStarted`, first `ArkTextDelta`, completed `ArkToolCall`, and terminal timings;
3. keep response text only in a local variable used for fact predicates, never in `AttemptResult`;
4. for continuation cases, submit exactly:

```python
{
    "type": "function_call_output",
    "call_id": tool_call.call_id,
    "output": case.expectation.continuation_output,
}
```

with the first response ID as `previous_response_id`;
5. catch provider exceptions and store only `type(exc).__name__`;
6. emit milliseconds and boolean scores, never raw content.

`summarize_model` uses nearest-rank p50/p95 and groups pass rate by category. `candidate_passes_gate` requires candidate overall/category rates greater than or equal to baseline and zero severe failures.

- [ ] **Step 4: Run tests and verify GREEN**

Run: `uv run pytest tests/test_realtime_volcengine_benchmark.py -q`

Expected: all benchmark core tests pass.

- [ ] **Step 5: Commit Task 2**

```bash
git add src/nova_audio_agent/realtime/volcengine/benchmark.py tests/test_realtime_volcengine_benchmark.py
git commit -m "feat: run and score Ark model benchmark attempts"
```

---

### Task 3: Explicit Live Matrix CLI

**Files:**
- Create: `scripts/benchmark_volcengine_llm.py`
- Create: `tests/test_benchmark_volcengine_llm.py`
- Modify: `docs/getting-started.md`
- Modify: `docs/getting-started.zh-CN.md`

**Interfaces:**
- Consumes: `benchmark_cases`, `run_attempt`, `summarize_model`, and `candidate_passes_gate` from Task 2.
- Produces: `build_parser()`, `run_matrix(args)`, and a CLI that prints aggregate JSON without provider content.

- [ ] **Step 1: Write failing CLI safety tests**

```python
def test_parser_defaults_to_baseline_and_rejects_unlisted_model() -> None:
    parser = build_parser()
    args = parser.parse_args(["--models", "doubao-seed-2-0-pro-260215"])
    assert args.live is False
    with pytest.raises(SystemExit):
        parser.parse_args(["--models", "arbitrary-model"])


@pytest.mark.asyncio
async def test_run_matrix_requires_live_before_constructing_client() -> None:
    args = build_parser().parse_args(["--models", "doubao-seed-2-0-pro-260215"])
    with pytest.raises(ValueError, match="require --live"):
        await run_matrix(args, client_factory=lambda model: pytest.fail(model))


def test_public_report_contains_no_case_content() -> None:
    report = public_report([sanitized_summary_fixture()])
    serialized = json.dumps(report, ensure_ascii=False)
    assert "上海" not in serialized
    assert "function_call_output" not in serialized
```

- [ ] **Step 2: Run CLI tests and verify RED**

Run: `uv run pytest tests/test_benchmark_volcengine_llm.py -q`

Expected: import fails because the CLI module does not exist.

- [ ] **Step 3: Implement the bounded live CLI**

Define the exact allowlist:

```python
MODEL_CHOICES = (
    "doubao-seed-2-0-pro-260215",
    "doubao-seed-2-1-pro-260628",
    "doubao-seed-2-1-turbo-260628",
    "deepseek-v4-pro-ga-260813",
    "deepseek-v4-flash-ga-260731",
    "doubao-seed-2-0-lite-260428",
    "doubao-seed-1-6-flash-250828",
    "doubao-seed-1-8-251228",
    "glm-5-2-260617",
    "kimi-k2-250905",
)
```

Arguments are `--live`, `--models` (one or more allowlisted choices), `--runs` (1..5, default 2), and `--timeout` (positive, default 30 seconds). Load `ARK_API_KEY` only from the environment, construct `AsyncOpenAI` with the configured Ark base URL, wrap every attempt in `asyncio.timeout`, and shuffle the model/case schedule with a fixed seed so warmup/order bias is reproducible.

The JSON report contains model ID, attempt count, overall/category rates, severe-failure count, sanitized error-class counts, p50/p95 metrics, and whether each candidate passes the baseline gate. It contains no per-case prompts, arguments, outputs, or response text.

Document the opt-in command and data-handling constraints in both getting-started guides.

- [ ] **Step 4: Run CLI tests, benchmark tests, and lint**

Run: `uv run pytest tests/test_benchmark_volcengine_llm.py tests/test_realtime_volcengine_benchmark.py -q`

Run: `uv run ruff check scripts/benchmark_volcengine_llm.py src/nova_audio_agent/realtime/volcengine/benchmark.py tests/test_benchmark_volcengine_llm.py tests/test_realtime_volcengine_benchmark.py`

Expected: all tests and lint checks pass.

- [ ] **Step 5: Commit Task 3**

```bash
git add scripts/benchmark_volcengine_llm.py tests/test_benchmark_volcengine_llm.py docs/getting-started.md docs/getting-started.zh-CN.md
git commit -m "feat: add opt-in Ark function-call benchmark"
```

---

### Task 4: Live Matrix, Winner Verification, and Production Selection

**Files:**
- Create: `docs/research/volcengine-llm-benchmark-2026-08-18.md`
- Conditionally modify after a passing result: `src/nova_audio_agent/config.py`
- Conditionally modify after a passing result: `tests/test_assembly.py`
- Conditionally modify after a passing result: `docs/getting-started.md`
- Conditionally modify after a passing result: `docs/getting-started.zh-CN.md`

**Interfaces:**
- Consumes: the live matrix CLI and existing `scripts/smoke_volcengine_realtime.py`.
- Produces: a sanitized benchmark report and, only for a verified winner, a new default `volcengine_ark_model`.

- [ ] **Step 1: Run the live model matrix twice per case**

Run with `ARK_API_KEY` sourced from the ignored worktree `.env`:

```bash
uv run --extra volcengine python scripts/benchmark_volcengine_llm.py --live --runs 2 --models doubao-seed-2-0-pro-260215 doubao-seed-2-1-pro-260628 doubao-seed-2-1-turbo-260628 deepseek-v4-pro-ga-260813 deepseek-v4-flash-ga-260731 doubao-seed-2-0-lite-260428 doubao-seed-1-6-flash-250828 doubao-seed-1-8-251228 glm-5-2-260617 kimi-k2-250905
```

Expected: aggregate JSON for every candidate; an incompatible model is reported without aborting the matrix.

- [ ] **Step 2: Record only sanitized aggregate evidence**

Create `docs/research/volcengine-llm-benchmark-2026-08-18.md` with the model IDs, attempt counts, pass rates, severe failures, protocol status, and latency p50/p95. Do not paste prompts, arguments, outputs, response text, request IDs, or credentials.

- [ ] **Step 3: Select the fastest passing candidate**

Apply this deterministic rule:

1. remove candidates that fail `candidate_passes_gate`;
2. remove candidates that cannot use the production Responses continuation contract;
3. rank the remainder by function-call p95, then first-text p95;
4. keep Seed 2.0 Pro if no candidate remains or the improvement is not repeatable.

- [ ] **Step 4: Verify the winner through the complete speech cascade**

Temporarily set `NOVA_AUDIO_AGENT_VOLCENGINE_ARK_MODEL` in the process environment to the selected model and run at least three repetitions of:

```bash
uv run --extra volcengine python scripts/smoke_volcengine_realtime.py --live --wav /tmp/nova-volcengine-smoke.wav --runs 3
```

Expected: all runs complete and the `asr_final_to_llm_first_text_ms` p50/p95 improves without TTS or terminal failures.

- [ ] **Step 5: Test-drive the selected default**

If and only if Steps 1-4 pass, first update the config test to expect the selected exact model ID and run:

```bash
uv run pytest tests/test_assembly.py -q
```

Expected: FAIL showing the old `doubao-seed-2-0-pro-260215` default.

Then update `Settings.volcengine_ark_model` and both guides to the selected exact ID. If no candidate passes, add no config change and state that outcome in the research report.

- [ ] **Step 6: Run complete verification**

Run: `uv run pytest -q`

Run: `uv run ruff check .`

Run: `uv run ruff format --check .`

Run: `git diff --check`

Expected: the complete deterministic suite, lint, formatting, and diff checks pass.

- [ ] **Step 7: Commit evidence and any verified selection**

```bash
git add docs/research/volcengine-llm-benchmark-2026-08-18.md src/nova_audio_agent/config.py tests/test_assembly.py docs/getting-started.md docs/getting-started.zh-CN.md
git commit -m "perf: select verified low-latency Ark model"
```

If the baseline remains selected, omit unchanged config/test/guide paths and use commit message `docs: record Ark function-call benchmark results`.
