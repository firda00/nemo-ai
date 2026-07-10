$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'tooling.ps1')

$codex = Find-CodexBinary
if (-not $codex) {
  [Console]::Error.WriteLine('Codex CLI was not found. Install Codex CLI or Codex Desktop.')
  exit 1
}

& $codex mcp-server
exit $LASTEXITCODE
