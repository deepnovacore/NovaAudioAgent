from __future__ import annotations

from .models import ScenarioStep


DELEGATE_REQUEST = "请让 Codex 写一个可以运行的俄罗斯方块游戏。"
PROVENANCE_QUESTION = "刚才这三条进度是谁产生的？只回答来源，并说明是不是我说的。"
BARGE_IN_QUESTION = "顺便问一下，七乘八是多少？"
RECOVERY_QUESTION = "刚才委派的任务还在进行吗？"
CONTEXT_FOLLOWUP = "刚才委派的是什么任务，最终交付了什么？"
HISTORY_RECOVERY_FOLLOWUP = "最开始那个任务的结果怎么运行？"

PROGRESS_FACTS = (
    ("progress-1", "Codex 后台已完成俄罗斯方块的页面骨架。", ("页面", "骨架")),
    ("progress-2", "Codex 后台已完成方块碰撞检测与旋转逻辑。", ("碰撞", "旋转")),
    ("progress-3", "Codex 后台已完成键盘控制与计分，正在做最终检查。", ("键盘", "计分")),
)
FINAL_RESULT = "俄罗斯方块已经完成并通过脚本检查，交付物是单文件 index.html。"


def build_scenario(phase: str) -> list[ScenarioStep]:
    if phase not in {"phase-a", "full"}:
        raise ValueError(f"unsupported probe phase: {phase}")
    steps = [
        ScenarioStep("delegate-request", "audio_turn", DELEGATE_REQUEST),
        *[
            ScenarioStep(
                progress_id,
                "progress",
                text,
                {"required_terms": list(required_terms)},
            )
            for progress_id, text, required_terms in PROGRESS_FACTS
        ],
    ]
    if phase == "phase-a":
        return [*steps, ScenarioStep("provenance-question", "provenance", PROVENANCE_QUESTION)]
    return [
        steps[0],
        steps[1],
        ScenarioStep("barge-in", "barge_in", BARGE_IN_QUESTION),
        steps[2],
        ScenarioStep("disconnect", "disconnect"),
        ScenarioStep("recovery-question", "recovery", RECOVERY_QUESTION),
        steps[3],
        ScenarioStep("final-1", "final", FINAL_RESULT),
        ScenarioStep("context-followup", "context_followup", CONTEXT_FOLLOWUP),
    ]
