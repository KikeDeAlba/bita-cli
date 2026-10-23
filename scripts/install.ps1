#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$Target = $(if ($env:BITA_TARGET) { $env:BITA_TARGET } else { 'claude' }),
    [switch]$NoDrawio,
    [switch]$NoAtlassian
)

$ErrorActionPreference = 'Stop'

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

function Write-Info([string]$Message) { Write-Host "  $Message" }
function Write-Warn([string]$Message) { [Console]::Error.WriteLine("  ! $Message") }

function Test-Command([string]$Name) {
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Assert-Node {
    if (-not (Test-Command 'node')) {
        Write-Warn 'node is not on PATH. bita needs Node 24 or newer.'
        exit 1
    }
    $major = [int](node -p 'process.versions.node.split(".")[0]')
    if ($major -lt 24) {
        Write-Warn "node $major found; bita needs 24 or newer for node:sqlite and type stripping."
        exit 1
    }
    Write-Info "node $(node -v)"
}

function Install-Dependencies {
    if (Test-Path (Join-Path $RepoRoot 'node_modules/@kikedealba/kit')) {
        Write-Info 'dependencies already installed'
        return
    }
    Push-Location $RepoRoot
    try {
        if (Test-Command 'pnpm') {
            pnpm install --prod --frozen-lockfile
        } elseif (Test-Command 'npm') {
            npm install --omit=dev --no-audit --no-fund
        } else {
            Write-Warn 'neither pnpm nor npm is on PATH; install the dependencies by hand'
            exit 1
        }
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    } finally {
        Pop-Location
    }
    Write-Info 'dependencies installed'
}

function Install-Shim([string]$BinDir) {
    $entry = (Join-Path $RepoRoot 'src/bin/bita.ts').Replace('%', '%%')
    $node = (Get-Command node -CommandType Application | Select-Object -First 1).Source
    if (-not $node) {
        Write-Warn 'node is not on PATH; cannot write the shim'
        exit 1
    }
    $node = $node.Replace('%', '%%')
    $shim = Join-Path $BinDir 'bita.cmd'
    $content = "@echo off`r`n`"$node`" `"$entry`" %*`r`n"
    if ((Test-Path $shim) -and ((Get-Content -Raw $shim) -eq $content)) {
        Write-Info "already linked: $shim"
        return
    }
    if (Test-Path $shim) {
        Move-Item -Force $shim "$shim.backup"
        Write-Warn "moved the existing $shim to $shim.backup"
    }
    [IO.File]::WriteAllText($shim, $content)
    Write-Info "linked: $shim"
}

if ($NoDrawio) { Write-Warn '-NoDrawio is ignored: bita no longer sets up draw.io' }
if ($NoAtlassian) { Write-Warn '-NoAtlassian is ignored: bita no longer sets up the Atlassian MCP' }

Write-Host "bita - installing the $Target integration"
Write-Host ''
Assert-Node

Write-Host ''
Write-Host 'Dependencies'
Install-Dependencies

Write-Host ''
Write-Host 'Binary'
$binDir = ''
if ($env:BITA_BIN_DIR) {
    $binDir = $env:BITA_BIN_DIR
} elseif ($env:PNPM_HOME -and (Test-Path $env:PNPM_HOME)) {
    $binDir = $env:PNPM_HOME
} elseif (Test-Command 'pnpm') {
    $global = (pnpm bin -g 2>$null | Select-Object -Last 1)
    if ($LASTEXITCODE -eq 0 -and $global) { $binDir = $global }
}
if (-not $binDir) {
    $local = Join-Path $HOME '.local/bin'
    if (Test-Path $local) { $binDir = $local }
}

if ($binDir -and (Test-Path $binDir)) {
    Install-Shim $binDir
    $onPath = ($env:PATH -split [IO.Path]::PathSeparator) -contains $binDir
    if (-not $onPath) { Write-Warn "$binDir is not on PATH; add it to your user PATH" }
} else {
    Write-Warn 'found no bin directory to link into.'
    Write-Warn 'set BITA_BIN_DIR to one on your PATH and re-run, or create the shim yourself:'
    Write-Warn "  node `"$RepoRoot\src\bin\bita.ts`" %*  (in a bita.cmd on your PATH)"
}

Write-Host ''
Write-Host 'Integration'
node (Join-Path $RepoRoot 'src/bin/bita.ts') setup --target $Target
exit $LASTEXITCODE
