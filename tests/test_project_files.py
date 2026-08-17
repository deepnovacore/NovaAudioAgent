from __future__ import annotations

import ast
import configparser
import re
from collections.abc import Iterator
from functools import cache
from pathlib import Path
from urllib.parse import unquote, urlsplit

import pytest
from repository_scan import (
    parsed_python,
    repository_markdown_files,
    repository_python_files,
    source_text,
)


PROJECT_DOCS = repository_markdown_files()

_MARKDOWN_INLINE_LINK = re.compile(r"!?\[[^\]]*\]\((?P<target><[^>]+>|[^)\s]+)")
_MARKDOWN_REFERENCE_DEFINITION = re.compile(
    r"^[ \t]{0,3}\[(?P<label>[^\]\n]+)\]:[ \t]*(?P<target><[^>\n]+>|[^\s\n]+)",
    re.MULTILINE,
)
_MARKDOWN_REFERENCE_LINK = re.compile(r"!?\[(?P<text>[^\]\n]+)\](?:\[(?P<label>[^\]\n]*)\])?")


def _relative_markdown_target(raw_target: str) -> Path | None:
    raw_target = raw_target.strip("<>")
    if raw_target.startswith("#"):
        return None
    parsed = urlsplit(raw_target)
    if parsed.scheme or parsed.netloc or not parsed.path or Path(parsed.path).is_absolute():
        return None
    return Path(unquote(parsed.path))


def _reference_label(label: str) -> str:
    return " ".join(label.split()).casefold()


def markdown_relative_links(markdown: str) -> Iterator[Path]:
    references = {
        _reference_label(match.group("label")): match.group("target")
        for match in _MARKDOWN_REFERENCE_DEFINITION.finditer(markdown)
    }
    body = _MARKDOWN_REFERENCE_DEFINITION.sub("", markdown)

    for match in _MARKDOWN_INLINE_LINK.finditer(body):
        target = _relative_markdown_target(match.group("target"))
        if target is not None:
            yield target

    for match in _MARKDOWN_REFERENCE_LINK.finditer(body):
        label = match.group("label")
        if label is None and body[match.end() :].startswith("("):
            continue
        raw_target = references.get(_reference_label(label or match.group("text")))
        if raw_target is None:
            continue
        target = _relative_markdown_target(raw_target)
        if target is not None:
            yield target


def resolved_document_links(document: Path, repository: Path) -> Iterator[Path]:
    uninitialized_submodules = _uninitialized_submodule_roots(repository)
    document_text = (
        source_text(document) if document in PROJECT_DOCS else document.read_text(encoding="utf-8")
    )
    for target in markdown_relative_links(document_text):
        resolved = (document.parent / target).resolve()
        if not resolved.is_relative_to(repository):
            raise ValueError(f"Markdown link escapes repository: {target}")
        if not resolved.is_file():
            if any(resolved.is_relative_to(root) for root in uninitialized_submodules):
                continue
            raise FileNotFoundError(resolved)
        yield resolved


@cache
def _uninitialized_submodule_roots(repository: Path) -> tuple[Path, ...]:
    config_path = repository / ".gitmodules"
    if not config_path.is_file():
        return ()
    config = configparser.ConfigParser()
    config.read(config_path, encoding="utf-8")
    return tuple(
        root
        for section in config.values()
        if (path := section.get("path")) is not None
        and not Path(path).is_absolute()
        and (root := (repository / path).resolve()).is_relative_to(repository)
        and not (root / ".git").exists()
    )


def test_markdown_link_parser_supports_reference_links_and_ignores_nonrepository_targets() -> None:
    markdown = """
[inline](docs/runbooks/chat-cli.md)
[architecture][current architecture]
[guide][]
[README]
[web](https://example.com/inline)
[web reference][web]
[section](#operation)
[section reference][section]
[mail][mail]
[root][root]

[current architecture]: docs/archs/harness-v2.md "Current architecture"
[guide]: <docs/guides/downstream-reimplementation.md>
[README]: README.md
[web]: https://example.com/reference
[section]: #operation
[mail]: mailto:operator@example.com
[root]: /etc/passwd
"""

    assert set(markdown_relative_links(markdown)) == {
        Path("README.md"),
        Path("docs/archs/harness-v2.md"),
        Path("docs/guides/downstream-reimplementation.md"),
        Path("docs/runbooks/chat-cli.md"),
    }


def test_document_link_resolution_rejects_repository_escape(tmp_path: Path) -> None:
    repository = tmp_path / "repository"
    repository.mkdir()
    outside = tmp_path / "outside.md"
    outside.write_text("outside", encoding="utf-8")
    document = repository / "README.md"
    document.write_text("[outside](../outside.md)", encoding="utf-8")

    with pytest.raises(ValueError, match="escapes repository"):
        list(resolved_document_links(document, repository))


def test_document_link_resolution_skips_absent_optional_submodule_target(tmp_path: Path) -> None:
    repository = tmp_path / "repository"
    repository.mkdir()
    (repository / ".gitmodules").write_text(
        '[submodule "thirdparty/reference"]\npath = thirdparty/reference\n',
        encoding="utf-8",
    )
    (repository / "thirdparty/reference").mkdir(parents=True)
    document = repository / "README.md"
    document.write_text("[reference](thirdparty/reference/missing.md)", encoding="utf-8")

    assert list(resolved_document_links(document, repository)) == []


def test_document_link_resolution_rejects_missing_initialized_submodule_target(
    tmp_path: Path,
) -> None:
    repository = tmp_path / "repository"
    repository.mkdir()
    (repository / ".gitmodules").write_text(
        '[submodule "thirdparty/reference"]\npath = thirdparty/reference\n',
        encoding="utf-8",
    )
    submodule = repository / "thirdparty/reference"
    submodule.mkdir(parents=True)
    (submodule / ".git").write_text("gitdir: ../../.git/modules/reference\n", encoding="utf-8")
    document = repository / "README.md"
    document.write_text("[reference](thirdparty/reference/missing.md)", encoding="utf-8")

    with pytest.raises(FileNotFoundError):
        list(resolved_document_links(document, repository))


def test_project_document_links_resolve() -> None:
    repository = Path.cwd().resolve()
    for document in PROJECT_DOCS:
        assert document.is_file()
        list(resolved_document_links(document, repository))


def test_conda_environment_provisions_uv() -> None:
    environment = Path("environment.yml").read_text(encoding="utf-8")

    assert "  - uv>=0.8,<1" in environment


@pytest.mark.parametrize(
    ("readme", "section_heading", "next_heading"),
    (
        (Path("README.md"), "## 5. macOS Ambient Orb", "## 6. Repository layout"),
        (Path("README.zh-CN.md"), "## 5. macOS Ambient Orb", "## 6. 仓库布局"),
    ),
)
def test_ambient_orb_readme_installs_vision_before_launch(
    readme: Path,
    section_heading: str,
    next_heading: str,
) -> None:
    document = readme.read_text(encoding="utf-8")
    section = document.split(section_heading, 1)[1].split(next_heading, 1)[0]

    assert section.index("uv sync --extra vision --dev") < section.index(
        "./scripts/start_ambient_orb_macos.sh"
    )


def test_conda_backend_bootstrap_installs_vision_extra() -> None:
    bootstrap = Path("scripts/bootstrap_backend.sh").read_text(encoding="utf-8")

    assert "uv sync --locked --extra vision" in bootstrap


def test_persisted_data_and_sqlite_files_are_ignored() -> None:
    ignored = Path(".gitignore").read_text(encoding="utf-8").splitlines()

    assert "data/" in ignored
    assert ".data/" in ignored
    assert "*.sqlite3" in ignored


def test_realtime_provider_dependency_points_inward_only_from_explicit_assembly() -> None:
    protected = {
        Path("src/nova_audio_agent/runtime.py"),
        Path("src/nova_audio_agent/floor.py"),
        *Path("src/nova_audio_agent/memory").rglob("*.py"),
        *Path("src/nova_audio_agent/executors").rglob("*.py"),
    }

    for path in protected:
        source = source_text(path)
        assert "realtime.qwen" not in source, path


def test_production_package_never_imports_external_qwen_audio_agent_baseline() -> None:
    for path in repository_python_files():
        source = source_text(path)
        assert "qwen-audio-agent" not in source, path
        assert "thirdparty.qwen_audio_agent" not in source, path


def test_default_cli_and_module_imports_do_not_eagerly_load_realtime_service() -> None:
    cli_source = source_text(Path("src/nova_audio_agent/cli.py"))
    assert "RealtimeService" not in cli_source
    assert "build_qwen_realtime_assembly" not in cli_source

    assembly_tree = parsed_python(Path("src/nova_audio_agent/assembly.py"))
    eager_imports = {
        alias.name
        for node in assembly_tree.body
        if isinstance(node, ast.ImportFrom | ast.Import)
        for alias in node.names
    }
    assert not any(name.startswith("nova_audio_agent.realtime") for name in eager_imports)


def test_ambient_orb_is_isolated_hardened_and_baseline_independent() -> None:
    desktop = Path("desktop/ambient-orb")
    package = (desktop / "package.json").read_text(encoding="utf-8")
    main = (desktop / "src/main/main.mjs").read_text(encoding="utf-8")
    security = (desktop / "src/main/security.mjs").read_text(encoding="utf-8")
    html = (desktop / "src/renderer/index.html").read_text(encoding="utf-8")
    native = (desktop / "native/macos_voice_io.swift").read_text(encoding="utf-8")
    builder = (desktop / "electron-builder.yml").read_text(encoding="utf-8")
    entitlements = (desktop / "resources/entitlements.mac.plist").read_text(encoding="utf-8")
    text_suffixes = {".cjs", ".css", ".html", ".json", ".md", ".mjs", ".plist", ".swift", ".yml"}
    sources = "\n".join(
        path.read_text(encoding="utf-8")
        for path in desktop.rglob("*.*")
        if path.suffix in text_suffixes
        and not {"build", "dist", "node_modules"}.intersection(path.parts)
    )

    assert '"electron": "43.2.0"' in package
    assert "browserWindowOptions" in main
    assert "contextIsolation: true" in security
    assert "nodeIntegration: false" in security
    assert "sandbox: true" in security
    assert "Content-Security-Policy" in html
    assert "kAudioUnitSubType_VoiceProcessingIO" in native
    assert "NSMicrophoneUsageDescription" in builder
    assert "com.apple.security.device.audio-input" in entitlements
    assert "from 'qwen-audio-agent" not in sources
    assert 'from "qwen-audio-agent' not in sources
    assert "../thirdparty/" not in sources


def test_ambient_orb_packages_the_apache_license_for_adapted_voice_io() -> None:
    desktop = Path("desktop/ambient-orb")
    license_text = (desktop / "LICENSES/Apache-2.0.txt").read_text(encoding="utf-8")
    notices = (desktop / "THIRD_PARTY_NOTICES.md").read_text(encoding="utf-8")
    builder = (desktop / "electron-builder.yml").read_text(encoding="utf-8")

    assert "Apache License" in license_text
    assert "Version 2.0, January 2004" in license_text
    assert "LICENSES/Apache-2.0.txt" in notices
    assert "LICENSES/**/*" in builder
