#Requires -Version 5.1
<#
.SYNOPSIS
    Windows launcher for the Ambient Orb desktop app.

.DESCRIPTION
    Mirrors scripts/start_ambient_orb.sh: checks npm and the Codex CLI on PATH, requires a
    .env file at the repository root, resolves a Python interpreter that can import
    nova_audio_agent (NOVA_AUDIO_AGENT_PYTHON -> %CONDA_PREFIX%\python.exe ->
    .venv\Scripts\python.exe -> `conda run -n nova-audio-agent python`), exports
    NOVA_AUDIO_AGENT_PYTHON / _CODEX_WORKSPACE / _ENV_FILE, and starts the desktop app.
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

if (-not (Get-Command codex -ErrorAction SilentlyContinue)) {
    Fail '缺少 Codex CLI，请先安装 codex'
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
