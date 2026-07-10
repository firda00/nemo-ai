param(
  [switch]$Deep
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'tooling.ps1')
$root = Get-NemoProjectRoot
$failures = [Collections.Generic.List[string]]::new()

function Check([bool]$condition, [string]$success, [string]$failure) {
  if ($condition) { Write-Host "[OK] $success" -ForegroundColor Green }
  else { Write-Host "[FAIL] $failure" -ForegroundColor Red; $script:failures.Add($failure) }
}

Push-Location $root
try {
  Check (Test-Path -LiteralPath '.git') 'Git repository detected' 'Git repository is missing'
  Check ([bool](Get-Command git -ErrorAction SilentlyContinue)) 'Git is available' 'git is not in PATH'
  Check ([bool](Get-Command node -ErrorAction SilentlyContinue)) 'Node.js is available' 'node is not in PATH'
  Check ([bool](Get-Command npm.cmd -ErrorAction SilentlyContinue)) 'npm is available' 'npm is not in PATH'
  Check (Test-Path -LiteralPath "$env:USERPROFILE\.claude\skills\gstack\bin") 'gstack is installed' 'gstack is missing'

  $claude = Find-ClaudeBinary
  Check ([bool]$claude) 'Claude Code binary found' 'Claude Code binary was not found'
  if ($claude) {
    $version = & $claude --version 2>&1
    Check ($LASTEXITCODE -eq 0) "Claude Code responds: $version" 'Claude Code failed to start'
  }

  $codex = Find-CodexBinary
  Check ([bool]$codex) 'Codex CLI binary found' 'Codex CLI binary was not found'
  if ($codex) {
    $version = & $codex --version 2>&1
    Check ($LASTEXITCODE -eq 0) "Codex responds: $version" 'Codex failed to start'
    $null = & $codex mcp-server --help 2>&1
    Check ($LASTEXITCODE -eq 0) 'Codex MCP server command is available' 'codex mcp-server is unavailable'
  }

  foreach ($file in @('.mcp.json', 'AGENTS.md', 'agent-hub\team-prompt.md', 'agent-hub\agent-capabilities.json')) {
    Check (Test-Path -LiteralPath $file) "$file exists" "$file is missing"
  }

  try { $null = Get-Content -Raw '.mcp.json' | ConvertFrom-Json; Check $true '.mcp.json is valid JSON' '' }
  catch { Check $false '' '.mcp.json is invalid JSON' }
  try { $null = Get-Content -Raw '.claude\settings.json' | ConvertFrom-Json; Check $true '.claude/settings.json is valid JSON' '' }
  catch { Check $false '' '.claude/settings.json is invalid JSON' }

  Check (Test-Path -LiteralPath 'node_modules\puppeteer') 'Puppeteer dependency is installed' 'Run npm install before UI tests'
  $gitStatus = @(git status --porcelain 2>$null) -join "`n"
  Check ($gitStatus -notmatch '(^|\n)\?\? \.env|(^|\n)\?\? \.secrets') 'Secret files are not untracked' 'A secret file appears untracked; fix .gitignore before continuing'

  if ($Deep -and $failures.Count -eq 0) {
    Write-Host '[RUN] Static agent capability contracts' -ForegroundColor Cyan
    & node 'agent-hub\validate-agent-contracts.mjs'
    if ($LASTEXITCODE -ne 0) { $failures.Add('Static agent capability contracts failed') }
  }
} finally {
  Pop-Location
}

if ($failures.Count -gt 0) {
  Write-Host "Setup check failed ($($failures.Count) issue(s))." -ForegroundColor Red
  exit 1
}
Write-Host 'Nemo multi-agent setup is ready.' -ForegroundColor Green
exit 0
