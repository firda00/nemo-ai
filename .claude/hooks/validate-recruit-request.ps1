$ErrorActionPreference = 'Stop'

try {
  $inputJson = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $description = [string]$inputJson.task_description
  $required = @('RECRUIT_REQUEST', 'ROLE:', 'TASK:', 'OWNED_PATHS:', 'REASON:', 'DONE_WHEN:')
  $missing = @($required | Where-Object { $description -notmatch [regex]::Escape($_) })
  if ($missing.Count -gt 0) {
    [Console]::Error.WriteLine("Task rejected. Recruit specialists only with all fields: RECRUIT_REQUEST, ROLE, TASK, OWNED_PATHS, REASON, DONE_WHEN. Missing: $($missing -join ', ')")
    exit 2
  }
  exit 0
} catch {
  [Console]::Error.WriteLine("Recruit validation failed: $($_.Exception.Message)")
  exit 2
}
