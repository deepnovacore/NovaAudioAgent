"""Wall-clock hygiene (Phase A green-light item 3): no second place in the core touches real time.

The allowlist has exactly two named points:
- `clock.py`'s `RealClock` (the production clock)
- `runtime.py`'s single `await asyncio.sleep(0)` (yield one scheduling turn, consumes no virtual time)

This pairs with conftest.py's session time budget: this test is responsible for **naming**
the offending file, the budget catches anything that slips through. Uses ast rather than
regex, or writing the words "asyncio.sleep" in a docstring would itself count as a violation.
"""

from __future__ import annotations

import ast
from collections.abc import Iterable

from repository_scan import parsed_python, python_nodes, repository_python_files

WALL_CLOCK_CALLS = frozenset(
    {
        "time.sleep",
        "time.time",
        "time.monotonic",
        "time.perf_counter",
        "asyncio.sleep",
        "datetime.now",
        "datetime.utcnow",
    }
)
WALL_CLOCK_MODULES = frozenset({"time", "datetime"})

# (relative path, symbol). The two named points — any addition must be registered here explicitly.
ALLOWED_CALLS = frozenset(
    {
        ("src/nova_audio_agent/clock.py", "time.monotonic"),
        ("src/nova_audio_agent/clock.py", "asyncio.sleep"),
        ("src/nova_audio_agent/runtime.py", "asyncio.sleep"),
    }
)


def _module_aliases(nodes: Iterable[ast.AST]) -> dict[str, str]:
    """`import asyncio as aio` → {"aio": "asyncio"}. Aliased calls must not bypass the scan."""
    aliases: dict[str, str] = {}
    for node in nodes:
        if isinstance(node, ast.Import):
            for alias in node.names:
                aliases[alias.asname or alias.name] = alias.name.split(".")[0]
    return aliases


def _calls_in(nodes: Iterable[ast.AST]) -> list[tuple[str, ast.Call]]:
    nodes = tuple(nodes)
    aliases = _module_aliases(nodes)
    found = []
    for node in nodes:
        if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Attribute):
            continue
        owner = node.func.value
        if isinstance(owner, ast.Name):
            module = aliases.get(owner.id, owner.id)
            found.append((f"{module}.{node.func.attr}", node))
    return found


def _calls(tree: ast.AST) -> list[tuple[str, ast.Call]]:
    return _calls_in(ast.walk(tree))


def test_scan_covers_the_two_named_points() -> None:
    """Positive twin: first prove the scanner can actually see those two files, or "zero
    violations" might just mean they were never scanned."""
    scanned = {str(path) for path in repository_python_files()}

    assert "src/nova_audio_agent/clock.py" in scanned
    assert "src/nova_audio_agent/runtime.py" in scanned
    assert len(scanned) >= 3


def test_no_unlisted_wall_clock_call() -> None:
    violations = []
    for path in repository_python_files():
        for symbol, node in _calls_in(python_nodes(path)):
            if symbol in WALL_CLOCK_CALLS and (str(path), symbol) not in ALLOWED_CALLS:
                violations.append(f"{path}:{node.lineno} {symbol}")

    assert violations == []


def test_wall_clock_imports_live_only_in_clock_module() -> None:
    """Also blocks the `from asyncio import sleep` workaround — it isn't an attribute call,
    so the attribute-call scan alone wouldn't catch it."""
    violations = []
    for path in repository_python_files():
        if str(path) == "src/nova_audio_agent/clock.py":
            continue
        for node in python_nodes(path):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    module = alias.name.split(".")[0]
                    if module in WALL_CLOCK_MODULES:
                        violations.append(f"{path}:{node.lineno} import {module}")
            elif isinstance(node, ast.ImportFrom):
                module = (node.module or "").split(".")[0]
                if module in WALL_CLOCK_MODULES:
                    violations.append(f"{path}:{node.lineno} from {module} import ...")
                # pulls the function name straight into the namespace: from asyncio import sleep
                imported = {f"{module}.{alias.name}" for alias in node.names}
                for symbol in sorted(imported & WALL_CLOCK_CALLS):
                    violations.append(f"{path}:{node.lineno} from … import {symbol}")

    assert violations == []


def test_scanner_catches_the_three_known_bypasses() -> None:
    """Positive twin: the scanner itself needs a test case too, or "zero violations" might
    just mean it can't see anything at all."""
    aliased = ast.parse("import asyncio as aio\n\nasync def f():\n    await aio.sleep(1)\n")
    assert ("asyncio.sleep",) == tuple(symbol for symbol, _ in _calls(aliased))

    direct = ast.parse("from asyncio import sleep\n")
    from_imports = [
        f"{(node.module or '')}.{alias.name}"
        for node in ast.walk(direct)
        if isinstance(node, ast.ImportFrom)
        for alias in node.names
    ]
    assert set(from_imports) & WALL_CLOCK_CALLS == {"asyncio.sleep"}

    plain = ast.parse("import time\n\ndef f():\n    return time.time()\n")
    assert ("time.time",) == tuple(symbol for symbol, _ in _calls(plain))


def test_runtime_only_yields_the_scheduler() -> None:
    """The asyncio.sleep in runtime.py must be sleep(0): yield one turn, consume no virtual time."""
    tree = parsed_python(
        next(path for path in repository_python_files() if path.name == "runtime.py")
    )
    sleeps = [node for symbol, node in _calls(tree) if symbol == "asyncio.sleep"]

    assert sleeps, "runtime.py 应当有 await asyncio.sleep(0)：分支 ① 靠它把 task 跑干"
    for node in sleeps:
        assert len(node.args) == 1
        assert isinstance(node.args[0], ast.Constant)
        assert node.args[0].value == 0
