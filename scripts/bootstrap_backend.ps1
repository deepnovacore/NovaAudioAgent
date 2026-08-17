#Requires -Version 5.1
<#
.SYNOPSIS
    Windows mirror of scripts/bootstrap_backend.sh.

.DESCRIPTION
    Creates or updates the conda environment from environment.yml, then runs a uv-based
    dependency sync (`uv sync --locked`) inside that environment.
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RootDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$EnvName = 'nova-audio-agent'

if (-not (Get-Command conda -ErrorAction SilentlyContinue)) {
    Write-Error "conda is required to bootstrap $EnvName"
    exit 1
}

$EnvironmentFile = Join-Path $RootDir 'environment.yml'
$ExistingEnvNames = (conda env list) |
    Select-Object -Skip 2 |
    ForEach-Object { ($_ -split '\s+', 2)[0] } |
    Where-Object { $_ }

if ($ExistingEnvNames -contains $EnvName) {
    & conda env update --name $EnvName --file $EnvironmentFile --prune
} else {
    & conda env create --name $EnvName --file $EnvironmentFile
}
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

$CondaPrefix = ((& conda run --name $EnvName python -c 'import sys; print(sys.prefix)') |
    Select-Object -Last 1).ToString().Trim()
if (-not $CondaPrefix) {
    Write-Error "could not resolve the conda prefix for $EnvName"
    exit 1
}

$env:UV_PROJECT_ENVIRONMENT = $CondaPrefix
Push-Location $RootDir
try {
    & conda run --name $EnvName -- uv sync --locked
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
} finally {
    Pop-Location
    Remove-Item Env:\UV_PROJECT_ENVIRONMENT -ErrorAction SilentlyContinue
}
