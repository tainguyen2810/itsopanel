# ITSO Panel — lệnh dev cho Windows (chuyển tiếp sang WSL2 Ubuntu 24.04)
# Dùng:  .\scripts\dev.ps1 help | structure | setup | dev | test | lint | check
param(
    [Parameter(Position = 0)]
    [string]$Target = "help"
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) {
    Write-Error "Không tìm thấy WSL. Cài WSL2 + Ubuntu 24.04 theo docs/runbooks (sẽ có ở Prompt 1.5)."
    exit 1
}

$repoWin = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$repoWsl = (wsl.exe wslpath -a "$repoWin").Trim()

wsl.exe --cd "$repoWsl" make $Target
exit $LASTEXITCODE
