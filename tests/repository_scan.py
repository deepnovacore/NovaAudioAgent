from __future__ import annotations

import ast
from functools import cache
from pathlib import Path


@cache
def repository_python_files() -> tuple[Path, ...]:
    files = list(Path("src/nova_audio_agent").rglob("*.py"))
    fake = Path("tests/fakes.py")
    if fake.is_file():
        files.append(fake)
    return tuple(sorted(files))


@cache
def repository_markdown_files() -> tuple[Path, ...]:
    roots = (Path("assets"), Path("docs"))
    files = {Path("README.md"), Path("README.zh-CN.md")}
    for root in roots:
        files.update(root.rglob("*.md"))
    return tuple(sorted(path for path in files if path.is_file()))


@cache
def source_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


@cache
def parsed_python(path: Path) -> ast.Module:
    return ast.parse(source_text(path), filename=str(path))


@cache
def python_nodes(path: Path) -> tuple[ast.AST, ...]:
    """Return one shared traversal snapshot for repository-wide AST checks."""
    return tuple(ast.walk(parsed_python(path)))
