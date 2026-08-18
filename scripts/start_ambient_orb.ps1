#Requires -Version 5.1
<#
.SYNOPSIS
    Windows launcher for the Ambient Orb desktop app.

.DESCRIPTION
    Mirrors scripts/start_ambient_orb.sh: checks npm on PATH, resolves a native codex.exe
    (never an npm .cmd/.ps1 shim, which CreateProcess cannot launch) into
    NOVA_AUDIO_AGENT_CODEX_BIN, requires a .env file at the repository root, resolves a
    Python interpreter that can import nova_audio_agent (NOVA_AUDIO_AGENT_PYTHON ->
    %CONDA_PREFIX%\python.exe -> .venv\Scripts\python.exe ->
    `conda run -n nova-audio-agent python`), exports NOVA_AUDIO_AGENT_PYTHON /
    _CODEX_BIN / _CODEX_WORKSPACE / _ENV_FILE, and starts the desktop app.
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RootDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$DesktopDir = Join-Path $RootDir 'desktop\ambient-orb'

function Fail {
    param([string]$Message)
    [Console]::Error.WriteLine("error: $Message")
    exit 1
}

if ($args.Count -ne 0) {
    Fail '此启动脚本不接受任何参数'
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Fail '缺少 npm，请先安装 Node.js'
}

# The backend launches codex with CreateProcess (`create_subprocess_exec`), which can only
# start a real executable image. npm installs codex as a set of shims — `codex.cmd`,
# `codex.ps1`, and an extension-less `codex` — none of which CreateProcess can run, and
# `Get-Command codex` hands back the `.ps1` first, so a PATH lookup that stops at the shim
# yields ENOENT at the first turn. Resolve a native `codex.exe` here and hand the backend
# its absolute path instead.
function Resolve-CodexExe {
    # -First 1 throughout: a PATH with several codex entries must still yield one string,
    # never the array that would silently become a garbage command line.
    $native = Get-Command codex.exe -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($native) {
        return $native.Source
    }

    $shim = Get-Command codex -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $shim) {
        return $null
    }
    $source = $shim.Source
    if (-not $source) {
        return $null
    }
    # Allowlist, not blocklist: enumerating the shim extensions npm happens to emit today
    # lets tomorrow's through. Only a real executable image may be exported; everything
    # else falls through to the sibling-exe probe below.
    if ($source -match '\.(exe|com)$') {
        return $source
    }

    # npm's shim sits next to the package's own binary, either directly or one level down in
    # the node_modules tree it was linked from; both layouts are worth one probe each.
    $shimDir = Split-Path -Parent $source
    $candidates = @(
        (Join-Path $shimDir 'codex.exe'),
        (Join-Path $shimDir 'node_modules\@openai\codex\bin\codex.exe'),
        (Join-Path $shimDir '..\@openai\codex\bin\codex.exe')
    )
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }
    return $null
}

if ($env:NOVA_AUDIO_AGENT_CODEX_BIN) {
    if (-not (Get-Command $env:NOVA_AUDIO_AGENT_CODEX_BIN -ErrorAction SilentlyContinue)) {
        Fail '环境变量 NOVA_AUDIO_AGENT_CODEX_BIN 必须指向一个可执行的 codex'
    }
    # An override pointing at a shim fails in exactly the same way as a shim on PATH, and
    # from further away, so it is worth catching here rather than at the first turn.
    if ($env:NOVA_AUDIO_AGENT_CODEX_BIN -match '\.(cmd|bat)$') {
        Fail 'NOVA_AUDIO_AGENT_CODEX_BIN 指向 npm 批处理包装（.cmd/.bat），后端无法直接启动它；请改为原生 codex.exe 的完整路径'
    }
} else {
    $CodexBin = Resolve-CodexExe
    if (-not $CodexBin) {
        if (Get-Command codex -ErrorAction SilentlyContinue) {
            Fail 'PATH 上的 codex 只是 npm 包装脚本（.cmd/.bat/.ps1），后端无法直接启动它；请安装原生 codex.exe，或将 NOVA_AUDIO_AGENT_CODEX_BIN 设为 codex.exe 的完整路径'
        }
        Fail '缺少 Codex CLI，请先安装 codex'
    }
    $env:NOVA_AUDIO_AGENT_CODEX_BIN = $CodexBin
}

$EnvFile = Join-Path $RootDir '.env'
if (-not (Test-Path -LiteralPath $EnvFile -PathType Leaf)) {
    Fail '缺少 .env 文件，请运行：copy .env.example .env'
}

function Test-NovaImport {
    param([string]$Candidate)

    if ([string]::IsNullOrWhiteSpace($Candidate)) {
        return $false
    }
    if (-not (Test-Path -LiteralPath $Candidate -PathType Leaf)) {
        return $false
    }

    Push-Location $RootDir
    try {
        & $Candidate -c 'import nova_audio_agent' *> $null
        return $LASTEXITCODE -eq 0
    } catch {
        return $false
    } finally {
        Pop-Location
    }
}

$PythonBin = $env:NOVA_AUDIO_AGENT_PYTHON
if ($PythonBin) {
    if (-not (Test-Path -LiteralPath $PythonBin -PathType Leaf)) {
        Fail '环境变量 NOVA_AUDIO_AGENT_PYTHON 必须指向一个可执行文件'
    }
    if (-not (Test-NovaImport $PythonBin)) {
        Fail '所选 Python 无法导入 nova_audio_agent，请运行：.\scripts\bootstrap_backend.ps1'
    }
} else {
    $PythonBin = $null

    if ($env:CONDA_PREFIX) {
        $CondaPython = Join-Path $env:CONDA_PREFIX 'python.exe'
        if (Test-NovaImport $CondaPython) {
            $PythonBin = $CondaPython
        }
    }

    if (-not $PythonBin) {
        $VenvPython = Join-Path $RootDir '.venv\Scripts\python.exe'
        if (Test-NovaImport $VenvPython) {
            $PythonBin = $VenvPython
        }
    }

    if (-not $PythonBin -and (Get-Command conda -ErrorAction SilentlyContinue)) {
        $Candidate = $null
        try {
            $Candidate = (& conda run -n nova-audio-agent python -c 'import sys; print(sys.executable)' 2>$null)
        } catch {
            $Candidate = $null
        }
        if ($Candidate) {
            $Candidate = ($Candidate | Select-Object -Last 1).ToString().Trim()
            if (Test-NovaImport $Candidate) {
                $PythonBin = $Candidate
            }
        }
    }

    if (-not $PythonBin) {
        Fail '未找到 Nova Audio Agent 的 Python 环境，请运行：.\scripts\bootstrap_backend.ps1'
    }
}

$ElectronBin = Join-Path $DesktopDir 'node_modules\.bin\electron.cmd'
if (-not (Test-Path -LiteralPath $ElectronBin -PathType Leaf)) {
    Write-Host '正在安装桌面端锁定依赖……'
    & npm --prefix $DesktopDir ci
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
}

$env:NOVA_AUDIO_AGENT_PYTHON = $PythonBin
if (-not $env:NOVA_AUDIO_AGENT_CODEX_WORKSPACE) {
    $env:NOVA_AUDIO_AGENT_CODEX_WORKSPACE = $RootDir
}
$env:NOVA_AUDIO_AGENT_ENV_FILE = $EnvFile

& npm --prefix $DesktopDir start
exit $LASTEXITCODE
