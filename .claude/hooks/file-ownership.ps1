$ErrorActionPreference = 'Stop'

try {
  $inputJson = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $filePath = [string]$inputJson.tool_input.file_path
  $sessionId = [string]$inputJson.session_id
  if (-not $filePath -or -not $sessionId) { exit 0 }

  $projectDir = [string]$env:CLAUDE_PROJECT_DIR
  if (-not $projectDir) { $projectDir = [string]$inputJson.cwd }
  $projectDir = [IO.Path]::GetFullPath($projectDir).TrimEnd('\', '/')
  $resolved = [IO.Path]::GetFullPath($filePath)
  if (-not $resolved.StartsWith($projectDir, [StringComparison]::OrdinalIgnoreCase)) { exit 0 }

  $relative = $resolved.Substring($projectDir.Length).TrimStart('\', '/').Replace('\', '/')
  if ($relative -eq 'agent-hub/state/file-owners.json') { exit 0 }

  $stateDir = Join-Path $projectDir 'agent-hub\state'
  $statePath = Join-Path $stateDir 'file-owners.json'
  New-Item -ItemType Directory -Force -Path $stateDir | Out-Null

  $mutex = [Threading.Mutex]::new($false, 'Local\NemoAgentFileOwnership')
  $locked = $false
  try {
    $locked = $mutex.WaitOne([TimeSpan]::FromSeconds(10))
    if (-not $locked) { throw 'Timed out waiting for the Nemo file ownership registry.' }

    $owners = @()
    if (Test-Path -LiteralPath $statePath) {
      try {
        $loaded = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
        if ($loaded -and $loaded.owners) { $owners = @($loaded.owners) }
      } catch {
        throw 'agent-hub/state/file-owners.json is invalid JSON.'
      }
    }

    $now = [DateTimeOffset]::UtcNow
    $activeOwners = @()
    foreach ($entry in $owners) {
      $claimedAt = $entry.claimedAt
      $expired = $true
      if ($claimedAt) {
        try { $expired = ($now - [DateTimeOffset]::Parse([string]$claimedAt)).TotalHours -gt 12 } catch {}
      }
      if (-not $expired) { $activeOwners += $entry }
    }

    $owner = $activeOwners | Where-Object { [string]$_.path -eq $relative } | Select-Object -First 1
    if ($owner -and [string]$owner.sessionId -ne $sessionId) {
      [Console]::Error.WriteLine("Blocked: '$relative' is owned by another active Claude session ($($owner.sessionId)). Assign different files or wait for that session to finish.")
      exit 2
    }

    $activeOwners = @($activeOwners | Where-Object { [string]$_.path -ne $relative })
    $activeOwners += [pscustomobject]@{
      path = $relative
      sessionId = $sessionId
      claimedAt = $now.ToString('o')
    }
    @{ owners = @($activeOwners) } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $statePath -Encoding UTF8
  } finally {
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
  }
  exit 0
} catch {
  [Console]::Error.WriteLine("Nemo ownership hook failed: $($_.Exception.Message)")
  exit 2
}
