# Related-Work Survey for Whole-Trajectory Evaluation

**Status:** research survey for colleague review, 2026-08-01. This document proposes mechanisms to
borrow; it does not claim benchmark equivalence, allocate an architecture revision, or make an
external dataset a Phase G dependency. It predates the project's public name — "nova-brain" below
refers to what is now Nova Audio Agent.

## 1. Question and Conclusion

The target is unusually composite: a foreground FastBrain must remain present while an asynchronous
Codex turn builds a real artifact, route a user's correction into that same turn, surface grounded
progress, and close from the correct Handoff. A useful evaluation must therefore observe both the
conversation trajectory and the final workspace.

The survey found strong precedents for individual layers, but none of the public work surveyed
jointly tests:

1. foreground conversational presence during long-running work;
2. same-turn steering of the active coding agent;
3. delegate/progress/Handoff causality;
4. execution-based correctness of the resulting code; and
5. optional full-duplex voice timing and interruption.

The proposed suite should compose proven mechanisms rather than present itself as a new general
benchmark: JoyAI-VL-Interaction and Thinking Machines Lab motivate the two-loop interaction shape;
τ-bench/τ-Voice motivate event-aligned simulation and outcome grading; SWE-bench motivates executable
regression gates; AgentRewardBench motivates evaluating the judge; and full-duplex speech benchmarks
motivate isolated timing and interruption tests.

## 2. Fit Map

| Work | Relationship | What it evaluates | Mechanism worth borrowing | Missing for nova-brain |
|---|---|---|---|---|
| JoyAI-VL-Interaction | direct system precedent | per-second speak/silence behavior and human preference in six non-delegation scenarios; delegation appears in training and system design | foreground/background split, time-aligned actions, blinded quality-and-timing review | coding artifact gates and same-turn slow-brain steering |
| Thinking Machines interaction models | direct architecture precedent | combined responsiveness and intelligence in a trained interaction model | shared context, asynchronous background results, foreground interleaving | public reproducible dataset and Codex-specific protocol checks |
| τ-bench / τ³-bench | complementary harness | tool-agent-user task outcome across domain policy, tools, and simulation | outcome-first grading, task/state fixtures, complete trajectories | foreground plus asynchronous coding worker and steering |
| τ-Voice | complementary voice harness | grounded completion under full-duplex audio conditions | tick-aligned audio/events, text control, speech ablations, rich run artifacts | long-lived asynchronous tool work; tools complete synchronously within a tick |
| SWE-bench | complementary artifact benchmark | repository issue resolution through hidden tests | new-behavior and regression tests in an isolated workspace | interaction, progress, steering, and voice |
| AgentRewardBench | direct judge precedent | whether automatic trajectory judges match expert labels | judge calibration, side-effect and repetition labels, source-stratified reporting | coding/voice tasks and foreground/background causality |
| PaperBench / Agent-as-a-Judge | adjacent rubric methods | long-form engineering tasks against hierarchical requirements | requirement trees and auditable sub-scores | reliable real-time interaction timing; evaluator cost is much higher |
| Full-Duplex-Bench | complementary M2 benchmark | pause, backchannel, turn-taking, and interruption | component scenarios and automatic temporal metrics | code artifacts, tool causality, and slow-brain steering |
| Inspect AI | adjacent infrastructure | repeatable eval execution, logs, scorers, and analysis | versioned run bundles, status, usage, attachments, replayable analysis | task-specific semantics; it is infrastructure, not this benchmark |

## 3. Direct Interaction Precedents

### 3.1 JoyAI-VL-Interaction

The local checkout at
[thirdparty/JoyAI-VL-Interaction](https://github.com/jd-opensource/JoyAI-VL-Interaction/tree/6cce28d977b4047ade3b027da7578f72580a2313), snapshot
`6cce28d977b4047ade3b027da7578f72580a2313`, is the closest open implementation found. Its model
makes a per-second choice among speaking, staying silent, and delegating. The released data format
turns a stream into time-aligned assistant actions such as `</silence>` and `</response>`, and the
system runs delegated work asynchronously while the foreground loop continues.

The resemblance is architectural rather than protocol-level. In the training choreography, a
foreground holding reply precedes a hidden delegation query; a randomized background delay is
injected while the foreground keeps observing and responding, and the returned result is later
folded into context. Candidate data is filtered by both a global verifier over the complete clip
and annotation and a local verifier around the annotated moment. Those are useful patterns for
trajectory synthesis and validation.

The local background service wraps `codex exec --ephemeral`; it does not use app-server
`turn/steer`, correlate progress with an active turn, or test run-versus-steer Handoff ownership.
Its modality is also live video rather than a repository workspace.

Its evaluation is still valuable as a soft-quality precedent. The
[technical report](https://github.com/jd-opensource/JoyAI-VL-Interaction/blob/6cce28d977b4047ade3b027da7578f72580a2313/JoyAI-VL-Interaction-Reportv1.pdf)
describes 58 cases across six event-driven scenarios. Five raters compare blinded, randomized
system outputs. Response quality and response timing are each graded good/fair/poor and combined
with equal weight. None of the six evaluation categories tests delegation, so the reported result
is not evidence for background-agent or steering quality. The report explicitly calls the study
preliminary, making the method more useful here than its aggregate win rates.

Borrow:

- represent silence, speech, delegation, and returned background work on one relative timeline;
- judge wording quality and timing separately before any aggregate preference;
- blind prompt variants and randomize A/B order;
- keep foreground dialogue available while background work is pending;
- use verifier-produced training/evaluation records as candidates that still require human audit.

Do not borrow:

- a one-second sampling grid as the Codex event clock;
- visual-scene datasets as a proxy for coding interaction;
- its `codex exec` wrapper as evidence for same-turn steering;
- human preference as evidence that the generated artifact works.

### 3.2 Thinking Machines Lab interaction models

The official [Interaction Models](https://thinkingmachines.ai/blog/interaction-models/) preview is
the closest published statement of the ambition. It uses 200 ms micro-turns for continuous input and
output, delegates deeper work to an asynchronous background model, sends rich shared context rather
than an isolated query, and lets foreground interaction continue while background results stream
back and are interleaved at an appropriate moment.

This supports measuring *presence* independently from slow-brain quality. It does not provide a
released benchmark or harness for same-turn coding-agent steering, so it cannot be adopted as an
acceptance suite. nova-brain also cannot reproduce behavior learned through joint training merely by
changing orchestration or a system prompt. The honest comparison is architectural and qualitative.

## 4. Outcome and Trajectory Evaluation

### 4.1 τ-bench and τ-Voice

The official local checkout at [thirdparty/tau2-bench](https://github.com/sierra-research/tau2-bench/tree/363133ada1936491fb5bcec33cd62c3518a99f65),
snapshot `363133ada1936491fb5bcec33cd62c3518a99f65`, now covers half-duplex text and full-duplex
voice. A domain supplies policy, tools, tasks, state, and optionally user tools. Its core evaluator
grades the resulting database and required communication; a reference action sequence can derive
the target state without requiring the evaluated agent to reproduce one exact path.

That is the right default for the Tetris artifact: require observable behavior, not a golden file
layout or exact Codex command sequence. Exact ordering should be reserved for architectural causal
contracts such as “steer acceptance precedes completion” and “the run delegate owns final output.”

τ-Voice ([arXiv:2603.13686](https://arxiv.org/abs/2603.13686)) adds a
controllable user simulator and a tick-based full-duplex orchestrator. Its published 278-task
evaluation keeps grounded task completion separate from speech interaction. Verbose runs retain
tick data, tool calls and results, user/assistant audio labels, stereo audio, and model debug
artifacts. It also compares clean and speech-complexity conditions, which gives M2 a useful
text-versus-voice control design.

The main mismatch is concurrency: τ-Voice tool calls execute synchronously within a tick; their
results are recorded in that tick and delivered to the participant on the next tick. It does not
exercise a foreground agent that remains responsive throughout a long Codex turn or routes new
instructions into that turn. Its orchestrator is a reference for capture and simulation, not a
drop-in runtime.

### 4.2 SWE-bench

[SWE-bench](https://github.com/SWE-bench/SWE-bench) evaluates repository changes for real issues.
Its useful pattern is two-sided execution: `FAIL_TO_PASS` tests establish the requested behavior and
`PASS_TO_PASS` tests guard existing behavior. The human-screened
[SWE-bench Verified](https://openai.com/index/introducing-swe-bench-verified/) release also shows why
fixture quality is part of benchmark validity: underspecified tasks and unfair tests can dominate
the measured agent failure rate.

For the contracted Tetris case, this translates to visible requirements plus varied hidden inputs,
original-behavior regression checks, and mutation tests against the checker. It does not justify
importing SWE-bench tasks or treating a patch pass as evidence of good interaction.

### 4.3 Hierarchical engineering rubrics

[PaperBench](https://openai.com/index/paperbench/) decomposes long research-replication tasks into
hierarchical, explicit criteria. [Agent-as-a-Judge](https://proceedings.mlr.press/v267/zhuge25a.html)
similarly pairs 55 coding tasks with 365 hierarchical requirements and lets an evaluator agent
inspect intermediate work.

These are good future references when Tetris grows beyond the minimal synthetic fixture's three
coarse gate results: report a requirement tree with leaf evidence, and never let a high-level
impression erase a failed required leaf. They are not the minimal pytest design. An evaluator agent
with filesystem access also adds a new capability, cost, and prompt-injection surface that Qwen-Max
does not need for the first study.

## 5. Evaluating the Evaluator

### 5.1 AgentRewardBench

AgentRewardBench ([arXiv:2504.08942](https://arxiv.org/abs/2504.08942))
is a benchmark of trajectory evaluators. It contains 1,302 web-agent trajectories from five
benchmarks and four agent LLMs. Experts label success, side effects, and repetitive behavior, then
twelve automatic judges are compared with those labels. Its central warning is directly relevant:
no evaluated judge is uniformly best across trajectory sources.

Consequences for the proposed Qwen-Max evaluator:

- keep it non-gating until calibrated against blinded expert labels;
- retain deterministic end-state and causality gates as ground truth where available;
- include plausible failures, alternative valid paths, repetition, side effects, and
  prompt-injection attempts in the calibration set;
- report agreement and flip rate by scenario/model source instead of one global accuracy;
- retain the exact sanitized judge input, structured output, prompt, and model version;
- require evidence references and reject citations outside the sanitized view.

The official [code checkout](https://github.com/McGill-NLP/agent-reward-bench/tree/f838338886d723d40b586309465a38277803d9e6) is present at snapshot
`f838338886d723d40b586309465a38277803d9e6`, but that snapshot contains no `LICENSE` file. It is
available for research inspection only; no implementation should be copied without permission or a
later license clarification. The dataset is web-agent data and should not be imported as a score for
FastBrain/Codex. Its labeling design is the reusable result.

### 5.2 What Qwen-Max may and may not decide

Qwen-Max may assess responsiveness, whether speech accurately describes accepted steering, progress
cadence, grounded wording, persona continuity, and closure. It may attach findings to visible event
references.

It may not decide whether the app-server identity was correct, whether steering happened in the same
turn, whether a Handoff belonged to the correct delegate, whether secret fields leaked before the
judge view was built, or whether Tetris works. Those are deterministic gates. A judge error can
invalidate the soft score, but cannot turn a hard failure into a pass.

## 6. Full-Duplex Speech Evaluation

[Full-Duplex-Bench](https://arxiv.org/abs/2503.04721) isolates pause handling, backchanneling,
turn-taking, and interruption management with automatic metrics. Later versions expand overlap and
multi-turn scenarios, but the original decomposition is already useful for M2. These cases should
exercise VAD/ASR/TTS/playback fencing independently before voice is combined with a costly Codex run.

**Update 2026-08-10**: the sentence above under-describes the series. Full-Duplex-Bench is now a
versioned line whose v3 evaluates tool use under disfluent speech — the closest public neighbor to
this suite's target — and a second, independently named "FD-Bench" exists. Both are pinned in the
[addendum](#addendum-2026-08-10-fdb-series-update-and-the-duplexlm-survey) below; any citation of
"FDB" or "FD-Bench" in nova-brain documents should name the team and version.

τ-Voice contributes the end-to-end control: execute the same grounded task in text and voice, vary
speech complexity deliberately, retain aligned audio/events, and report the voice-induced capability
gap. Neither benchmark should be used to grade code correctness or app-server steering.

The desktop bubble changes the client surface, not the evaluation semantics. Hardware-gated tests
must record actual playback acknowledgement and barge-in overlap; default pytest continues to test
the transport state machine without a browser, microphone, speaker, or provider.

## 7. Evaluation Infrastructure

[Inspect AI logs](https://inspect.aisi.org.uk/eval-logs.html) are a useful packaging reference:
versioned run status, model/plan metadata, sample events, scores, token statistics, errors, optional
attachments, and tools for later analysis. Its optimized log format also illustrates why large
trajectory artifacts should not be duplicated blindly.

The proposed run bundle deliberately remains a small nova-brain-specific format for now. Adopting
Inspect as a dependency before the schema stabilizes would broaden Phase G without removing the need
for custom Codex identity, Handoff, privacy, and artifact validators. Compatibility or export can be
revisited after real bundles exist.

## 8. Recommended Composition

| Evaluation layer | Primary precedent | nova-brain decision |
|---|---|---|
| Run validity and provenance | Inspect AI, benchmark harness practice | versioned manifest, explicit invalid outcomes, cost and provider metadata |
| Protocol and causality | none identified in this survey | custom deterministic validator over allowlisted events |
| Artifact correctness | SWE-bench, τ-bench | execution-based requirement and regression gates; no exact implementation path |
| Foreground/background interaction | JoyAI, TML interaction models | measure presence, steering acknowledgement, progress cadence, and closure separately |
| Judge reliability | AgentRewardBench | expert calibration and evidence-fenced, non-gating Qwen-Max findings |
| Voice behavior | τ-Voice, Full-Duplex-Bench | text control, isolated component tests, aligned audio/event rehearsal |

The initial repository slice therefore remains intentionally modest: a synthetic JSONL trajectory,
an offline deterministic validator, and privacy/evidence-fencing tests. The first meaningful live
claim requires one real FastBrain + Codex run to produce the same schema and pass a real artifact
checker. Broader datasets, an evaluator-agent, and voice batches belong to later research stages.

## 9. Dataset and License Decision

No surveyed dataset is imported into the first-party nova-brain evaluation suite or mirrored as a
separate dataset snapshot at this stage. The reference checkouts retain their own bundled fixtures,
annotations, and metadata:

- JoyAI data targets streaming visual actions, not coding trajectories;
- τ-bench tasks can inform simulator structure but do not represent asynchronous Codex work;
- SWE-bench tasks measure repository repair, not foreground interaction;
- AgentRewardBench data is valuable for judge research but is web-specific and its local code
  snapshot has no declared license;
- speech benchmark media has different storage, consent, and redistribution requirements.

The JoyAI code checkout declares Apache-2.0 and its dataset card currently uses the same label, but
original video provenance still needs per-source review. τ-bench declares MIT. The AgentRewardBench
code snapshot has no `LICENSE`, `COPYING`, `NOTICE`, or package license metadata, and its dataset
license remains a separate unresolved question.

A local material inventory (kept outside this repository) records exact commits,
download status, and license caveats. Any later dataset import needs a separate size, provenance,
privacy, redistribution, and maintenance review.

## 10. Review Questions

- Is the “none identified in this survey” conclusion supported strongly enough to justify a custom
  protocol layer, without overstating novelty?
- Should the human calibration labels copy AgentRewardBench's success/side-effect/repetition axes or
  add a separate unsupported-progress axis from the start?
- Should the first paired judge study compare Qwen-Max with one second judge, or spend that budget on
  more human labels?
- Which evidence may remain in local-only attachments while still allowing another engineer to audit
  a failure?
- At what number of validated live runs should the bundle schema be considered stable enough for an
  Inspect exporter or a canonical architecture revision?

## Addendum (2026-08-10): FDB Series Update and the DuplexLM Survey

**Status:** post-review addendum. The 2026-08-01 survey above is kept as reviewed; this section
pins the facts that surfaced afterward and that the
[blog post](../../blog/2026-08-proactive-voice-agent-design-space.md) cites. Everything quoted was
read from the primary source on 2026-08-10.

### A.1 Two benchmark series share a confusable name

- **Full-Duplex-Bench (FDB)** — the versioned line by Lin et al. (NTU/NVIDIA): v1
  ([arXiv:2503.04721](https://arxiv.org/abs/2503.04721)) → v1.5 (overlap decomposed into four
  scenarios, including talking-to-others / background speech) → v2
  ([arXiv:2510.07838](https://arxiv.org/abs/2510.07838)) → v3
  ([arXiv:2604.04847](https://arxiv.org/abs/2604.04847)).
- **FD-Bench** — an independent pipeline-style benchmark generator by Peng et al.

The two are not interchangeable, and uncited mentions of "FD-Bench" in recent papers are sometimes
ambiguous. Nova-brain documents should always name the team and version. §6 of the main survey
predates this distinction and describes v1 only.

### A.2 FDB v2 (arXiv:2510.07838)

Replaces the static test set with a multi-turn **automated examiner** that actively drives the
system under staged goals at two pacings (Fast / Slow). This is a paradigm shift from passive
pre-recorded test sets to an active conversational partner; the original §6 sentence "later
versions expand overlap and multi-turn scenarios" under-describes it.

### A.3 FDB v3 (arXiv:2604.04847) — the nearest public neighbor, and what it does not test

FDB v3 evaluates full-duplex voice agents (GPT-Realtime, Gemini Live 2.5/3.1, Grok, Ultravox, a
cascaded baseline) on **multi-step tool use under real-human disfluent speech**: 100 scenarios of
chained API calls across four domains, tiered Easy/Medium/Hard, with five disfluency categories
(fillers, pauses, hesitations, false starts, self-corrections). Metrics: Tool Selection F1,
Argument Accuracy, Pass@1, judged Response Quality, and turn-taking/latency measures including
pre-emptive tool calls (negative tool-call latency) and filler rate.

Three verified boundaries matter for nova-brain's gap claim:

1. **Tools are synchronous and instantaneous.** The benchmark uses "locally executed mock APIs with
   deterministic, zero-latency responses"; its limitations note it does "not test robustness to
   real-world network anomalies such as API timeouts." Nothing stays outstanding, so there is no
   foreground-presence-during-background-work condition to score.
2. **No steering of dispatched work.** Self-correction scenarios test rolling back tool
   *parameters* before commit ("programmatic state rollback"); the paper frames the axis as "when
   to commit tool parameters — eagerly for speed or conservatively for correctness." There is no
   mechanism for amending or cancelling a call already dispatched.
3. **No delegation causality.** Attribution of a returned result to the task that produced it is
   not scored, because results return within the same exchange.

Consequence: the survey's §1 conclusion stands after being checked against this nearest neighbor,
but its wording must engage v3 explicitly rather than characterize the series by v1 ("nothing is
executing while those conversations run" is true of v1, false of the series read as a whole).

### A.4 The DuplexLM survey (arXiv:2606.19453)

"A Survey of Full-Duplex Spoken Dialogue Systems" (Zhejiang University / Qwen / HunYuan / ByteDance,
June 2026) contributes three frameworks this repo now borrows vocabulary from, plus audits. The
specific claims nova-brain documents cite:

- **L0–L3 architectural hierarchy** — where the duplex decision is made: L0 external module, L1
  hidden-state sidecar predictor, L2 token-level, L3 shared-latent (empty). Nova-brain's harness
  tier is L0.
- **L1 is a structural attractor**: MinMo's Full-Duplex Predictor and Freeze-Omni on the
  FD-claiming side, Qwen2.5/3.5-Omni Thinker–Talker and Step-Audio R1.1 on the non-FD streaming
  side, converge on the same shape (external module reading LLM hidden state) from different
  product goals.
- **"L0 remains contested rather than legacy"**: the X-Talk position paper plus the 2025–26 modular
  wave (FireRedChat, FlexDuo, SoulX-Duplug) argue the modular blueprint is competitive on latency,
  interpretability, and engineering cost — not merely a transitional stage before L2.
- **T×I×R interaction ontology** (temporal relation × user intent × system response, 210 nominal
  cells) **contains no delegation axis**, and proactive initiation appears in the entire framework
  as a single response class (R6 "initiate") realized by one FSM transition (τ2, a
  silence-threshold timer).
- **Five-state decision FSM** (Idle/Listen/Speak/Wait/Dual): the duplex-specific transitions are
  the overlap family — on user audio during system speech, disambiguate floor-claim (yield, τ9)
  vs backchannel (continue, τ10) vs third-party (ignore, τ11). "A half-duplex system … does not
  distinguish τ9 from τ10 or τ11, which is the formal sense in which it 'cannot tell backchannel
  from interruption.'"
- **Six acid-test cells** decompose utterance-level competence into testable units: standard turn,
  latched zero-gap, cooperative barge-in, backchannel during system speech, third-party speech,
  hesitation with long silence (sustained concurrent speech is the open seventh).
- **Realization gap**: architecture sets capacity, training data realizes it, evaluation reports
  it. Several published claims at the token level are audited as *apparent* rather than
  substantive full-duplex (chunk-boundary transitions in SyncLLM, keyword-triggered interruption
  in Mini-Omni2); the survey recommends per-cell reporting over aggregate "is it full-duplex"
  claims, and notes the binding constraint at L0–L2 is two-channel time-synchronous (Type-C)
  training data, not architecture.
