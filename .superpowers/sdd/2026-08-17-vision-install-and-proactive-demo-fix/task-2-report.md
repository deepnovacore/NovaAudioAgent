# Task 2 report

## Status

DONE

## Files changed

- `tests/test_project_files.py`
- `scripts/bootstrap_backend.sh`
- `README.md`
- `README.zh-CN.md`

## Red test command and failure evidence

```bash
PYTHONPATH=src /Users/fishwowater/sqxh/nova-audio-agent/.venv/bin/python -m pytest tests/test_project_files.py::test_ambient_orb_readme_installs_vision_before_launch tests/test_project_files.py::test_conda_backend_bootstrap_installs_vision_extra -q
```

Expected result observed: 3 failed (two README parameterized cases raised `ValueError` because the install command was absent; the bootstrap assertion failed because the command lacked `--extra vision`).

## Green test command and output summary

The same focused command passed after the minimal changes:

```text
...                                                                      [100%]
3 passed in 0.02s
```

`git diff --check` also passed.

## Commit SHA

`afd190d2152d4cd55413ffd5b701bfc64a0347d3`

## Self-review

The Conda bootstrap retains the existing environment selection, `UV_PROJECT_ENVIRONMENT`, locked sync, and create/update behavior while adding the `vision` extra. Both bilingual Ambient Orb sections place `uv sync --extra vision --dev` immediately before launch and document camera/video playback requirements. No optional-dependency boundaries, runtime behavior, proactive demo files, or production prompts were changed.

## Concerns

The worktree-local `uv` environment could not sync because PyPI returned a TLS EOF, so verification used the specified repository `.venv` fallback. No other concerns.
