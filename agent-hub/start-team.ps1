param(
  [string]$Model = 'claude-fable-5-1',
  [switch]$SkipSetupCheck
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'tooling.ps1')
$root = Get-NemoProjectRoot
$claude = Find-ClaudeBinary

if (-not $claude) {
  throw 'Claude Code binary was not found. Install Claude Code or enable its VS Code extension.'
}

Push-Location $root
try {
  if (-not $SkipSetupCheck) {
    & (Join-Path $PSScriptRoot 'check-setup.ps1') -Deep
    if ($LASTEXITCODE -ne 0) { throw 'Setup check failed. Fix the reported issues before starting the team.' }
  }

  $stateDir = Join-Path $PSScriptRoot 'state'
  New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
  foreach ($name in @('file-owners.json', 'codex-threads.json')) {
    $path = Join-Path $stateDir $name
    if (-not (Test-Path -LiteralPath $path)) {
      if ($name -eq 'file-owners.json') { '{"owners":[]}' | Set-Content -LiteralPath $path -Encoding UTF8 }
      else { '{"threads":{}}' | Set-Content -LiteralPath $path -Encoding UTF8 }
    }
  }

  $prompt = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'team-prompt.md')
  $mcpConfig = Join-Path $root '.mcp.json'
  Write-Host "Starting Claude team lead with $Model..." -ForegroundColor Cyan
  & $claude --model $Model --teammate-mode in-process --mcp-config $mcpConfig --strict-mcp-config $prompt
  exit $LASTEXITCODE
} finally {
  Pop-Location
}
