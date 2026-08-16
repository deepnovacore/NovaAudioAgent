"""R104: deterministic speech preparation for realtime-injected facts."""

from __future__ import annotations

from nova_audio_agent.realtime.speech_prep import SPEECH_FINAL_LIMIT, prepare_for_speech


def test_fenced_code_block_becomes_spoken_placeholder() -> None:
    text = "运行方式：\n```bash\npython3 -m pip install pygame\npython3 tetris.py\n```\n完成。"
    prepped, truncated = prepare_for_speech(text, limit=SPEECH_FINAL_LIMIT)
    assert "```" not in prepped
    assert "pip install" not in prepped
    assert "（代码示例略）" in prepped
    assert "运行方式" in prepped and "完成" in prepped
    assert truncated is False


def test_flattened_fence_without_newlines_is_still_removed() -> None:
    # codex_app_server._sanitize_final_message flattens C-category chars to spaces,
    # so fences arrive on one line.
    text = "运行方式： ```bash python3 -m pip install pygame python3 tetris.py ``` 代码已通过冒烟测试。"
    prepped, _ = prepare_for_speech(text, limit=SPEECH_FINAL_LIMIT)
    assert "```" not in prepped
    assert "pip install" not in prepped
    assert "（代码示例略）" in prepped
    assert "代码已通过冒烟测试" in prepped


def test_inline_code_unwraps_to_plain_text() -> None:
    prepped, _ = prepare_for_speech("按 `R` 重新开始。", limit=SPEECH_FINAL_LIMIT)
    assert "`" not in prepped
    assert "按 R 重新开始" in prepped


def test_link_reduces_to_its_text_and_image_to_alt() -> None:
    text = "已创建 [tetris.py](/Users/someone/ws/tetris.py)，示意 ![界面截图](shot.png)。"
    prepped, _ = prepare_for_speech(text, limit=SPEECH_FINAL_LIMIT)
    assert "tetris.py" in prepped
    assert "/Users/someone/ws" not in prepped
    assert "shot.png" not in prepped
    assert "界面截图" in prepped
    assert "](" not in prepped


def test_bare_urls_drop_to_placeholder() -> None:
    prepped, _ = prepare_for_speech(
        "详见 https://example.com/docs/page?id=3 的说明。", limit=SPEECH_FINAL_LIMIT
    )
    assert "https://" not in prepped
    assert "example.com" not in prepped
    assert "（链接略）" in prepped


def test_long_hex_runs_are_removed() -> None:
    digest = "af8a7d2c440a3463f6df0188beae281fae9685d70fe1d2d9f1460186b480ff52"
    prepped, _ = prepare_for_speech(f"校验和 {digest} 已记录。", limit=SPEECH_FINAL_LIMIT)
    assert digest not in prepped
    assert "af8a7d2c" not in prepped


def test_markdown_structure_markers_strip() -> None:
    text = "## 结果\n**已完成**：\n- 七种方块\n- 计分系统\n| 键 | 动作 |\n|---|---|\n| R | 重开 |"
    prepped, _ = prepare_for_speech(text, limit=SPEECH_FINAL_LIMIT)
    for marker in ("##", "**", "- ", "|"):
        assert marker not in prepped
    assert "七种方块" in prepped and "计分系统" in prepped


def test_arrow_runs_collapse_and_whitespace_normalizes() -> None:
    prepped, _ = prepare_for_speech("使用 ←/→ 移动，↑  旋转。", limit=SPEECH_FINAL_LIMIT)
    assert "←" not in prepped and "→" not in prepped and "↑" not in prepped
    assert "  " not in prepped
    assert "移动" in prepped and "旋转" in prepped


def test_limit_clip_reports_truncation() -> None:
    prepped, truncated = prepare_for_speech("很长的句子。" * 400, limit=SPEECH_FINAL_LIMIT)
    assert truncated is True
    assert len(prepped) <= SPEECH_FINAL_LIMIT


def test_short_clean_text_passes_through() -> None:
    prepped, truncated = prepare_for_speech("已完成俄罗斯方块游戏。", limit=SPEECH_FINAL_LIMIT)
    assert prepped == "已完成俄罗斯方块游戏。"
    assert truncated is False


def test_empty_after_stripping_returns_empty() -> None:
    prepped, truncated = prepare_for_speech("```\ncode only\n```", limit=SPEECH_FINAL_LIMIT)
    assert prepped == "（代码示例略）"
    assert truncated is False


def test_tetris_controls_regression_fixture() -> None:
    """The live final that was read aloud verbatim ('空格' bug), post-flattening."""
    text = (
        "已创建完整的 Pygame 俄罗斯方块游戏：[tetris.py](/Users/someone/ws/tetris.py)  包含：  "
        "- 七种方块与 7-bag 随机机制 - 左右移动、加速下落、旋转及硬降 - 满行消除和计分系统 "
        "- 游戏结束检测，按 `R` 重新开始  运行方式：  ```bash python3 -m pip install pygame "
        "python3 tetris.py ```  代码已通过语法编译和核心游戏逻辑冒烟测试，"
        "校验 af8a7d2c440a3463f6df0188beae281fae9685d70fe1d2d9f1460186b480ff52。"
    )
    prepped, _ = prepare_for_speech(text, limit=SPEECH_FINAL_LIMIT)
    assert "```" not in prepped
    assert "{" not in prepped and "}" not in prepped
    assert "/Users/someone" not in prepped
    assert "af8a7d2c" not in prepped
    assert "pip install" not in prepped
    assert "`" not in prepped
    assert "俄罗斯方块" in prepped
    assert "七种方块" in prepped
    assert "tetris.py" in prepped


def test_url_does_not_swallow_following_cjk_prose() -> None:
    """CP2: \\S+ ate CJK punctuation and the no-space prose after a URL."""
    prepped, _ = prepare_for_speech(
        "详见 https://example.com/docs。然后继续下一步。", limit=SPEECH_FINAL_LIMIT
    )
    assert "然后继续下一步" in prepped
    assert "example.com" not in prepped


def test_unclosed_fence_preserves_trailing_cjk_prose() -> None:
    """P2 tradeoff: with no reliable end boundary, only the marker is removed —
    prose survives even though code fragments may too."""
    prepped, _ = prepare_for_speech(
        "已实现主体。 ```python print(1) 后续说明：测试全部通过。", limit=SPEECH_FINAL_LIMIT
    )
    assert "已实现主体" in prepped
    assert "后续说明" in prepped and "测试全部通过" in prepped
    assert "```" not in prepped


def test_flattened_heading_markers_strip() -> None:
    """CP2: upstream flattens newlines, so heading markers arrive mid-line."""
    prepped, _ = prepare_for_speech("前言 ## 最终结果 **完成**", limit=SPEECH_FINAL_LIMIT)
    assert "#" not in prepped
    assert "*" not in prepped
    assert "最终结果" in prepped and "完成" in prepped


def test_issue_number_hash_survives() -> None:
    prepped, _ = prepare_for_speech("修复了 #47 的问题。", limit=SPEECH_FINAL_LIMIT)
    assert "#47" in prepped


def test_unclosed_fence_preserves_trailing_english_prose() -> None:
    """P2: Codex finals are often English; an unclosed fence must not assume the
    trailing prose contains a CJK boundary. Only the marker is removed."""
    prepped, _ = prepare_for_speech(
        "Implemented core. ```python print(1) Tests passed and docs updated.",
        limit=SPEECH_FINAL_LIMIT,
    )
    assert "Implemented core" in prepped
    assert "Tests passed and docs updated" in prepped
    assert "```" not in prepped
