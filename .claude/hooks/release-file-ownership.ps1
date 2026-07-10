$ErrorActionPreference = 'Stop'

try {
  $inputJson = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $sessionId = [string]$inputJson.session_id
  if (-not $sessionId) { exit 0 }

  $projectDir = [string]$env:CLAUDE_PROJECT_DIR
  if (-not $projectDir) { $projectDir = [string]$inputJson.cwd }
  $statePath = Join-Path $projectDir 'agent-hub\state\file-owners.json'
  if (-not (Test-Path -LiteralPath $statePath)) { exit 0 }

  $mutex = [Threading.Mutex]::new($false, 'Local\NemoAgentFileOwnership')
  $locked = $false
  try {
    $locked = $mutex.WaitOne([TimeSpan]::FromSeconds(10))
    if (-not $locked) { exit 0 }
    $state = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
    $owners = @($state.owners | Where-Object { [string]$_.sessionId -ne $sessionId })
    @{ owners = $owners } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $statePath -Encoding UTF8
  } finally {
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
  }
} catch {
  [Console]::Error.WriteLine("Nemo ownership release warning: $($_.Exception.Message)")
}
exit 0
