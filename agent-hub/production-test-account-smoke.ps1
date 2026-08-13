$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
function Read-Setting([string]$path, [string]$name) {
  $line = [IO.File]::ReadAllLines($path) | Where-Object { $_ -match "^$([regex]::Escape($name))=" } | Select-Object -Last 1
  if (-not $line) { return '' }
  return $line.Substring($line.IndexOf('=') + 1).Trim()
}
$secrets = Join-Path $root '.secrets.local'
$envFile = Join-Path $root '.env.local'
$url = Read-Setting $envFile 'VITE_SUPABASE_URL'
$key = Read-Setting $envFile 'VITE_SUPABASE_ANON_KEY'
$email = Read-Setting $secrets 'NEMO_E2E_EMAIL'
$password = Read-Setting $secrets 'NEMO_E2E_PASSWORD'
if (-not $url -or -not $key -or -not $email -or -not $password) { throw 'Production test account settings are missing.' }
$headers = @{ apikey = $key; 'Content-Type' = 'application/json' }
$session = Invoke-RestMethod -Uri "$url/auth/v1/token?grant_type=password" -Method Post -Headers $headers -Body (@{ email = $email; password = $password } | ConvertTo-Json)
if (-not $session.access_token) { throw 'Production test login failed.' }
$auth = @{ apikey = $key; Authorization = "Bearer $($session.access_token)"; 'Content-Type' = 'application/json'; Prefer = 'return=representation' }
function Assert-ExternalBlocked([string]$uri, [hashtable]$body, [bool]$allowDraftBlock = $false) {
  try {
    Invoke-WebRequest -Uri $uri -Method Post -Headers $auth -Body ($body | ConvertTo-Json -Depth 5) -UseBasicParsing | Out-Null
    throw 'External action unexpectedly succeeded.'
  } catch {
    $status = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
    $detail = [string]$_.ErrorDetails.Message
    if (-not $detail -and $_.Exception.Response) {
      $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
      try { $detail = $reader.ReadToEnd() } finally { $reader.Dispose() }
    }
    $productionBlocked = $status -eq 403 -and $detail -match 'PRODUCTION_E2E_EXTERNAL_BLOCKED'
    $draftBlocked = $allowDraftBlock -and $status -eq 409 -and $detail -match 'AGENT_EVAL_REQUIRED'
    if (-not $productionBlocked -and -not $draftBlocked) {
      $endpoint = ([Uri]$uri).AbsolutePath
      throw "External action at $endpoint returned status $status without the production E2E block code."
    }
  }
}
$account = @(Invoke-RestMethod -Uri "$url/rest/v1/accounts?select=id,is_production_e2e" -Headers $auth)[0]
if (-not $account.is_production_e2e) { throw 'Refusing to test an unmarked account.' }
$manager = @{ name = 'Synthetic Read-only Team'; prompt = @{ role = 'Synthetic lead'; tasks = 'Verify atomic creation'; tone = 'Concise'; rules = 'Read only' }; action_policy = 'read_only'; risk_tier = 'standard'; purpose = 'Synthetic E2E only'; skills = @() }
$specialists = @(
  @{ role = 'Planner'; name = 'Synthetic Planner'; prompt = @{ role = 'Planner'; tasks = 'Create a synthetic plan'; tone = 'Concise'; rules = 'No external actions' }; skills = @(); status = 'active' },
  @{ role = 'Reviewer'; name = 'Synthetic Reviewer'; prompt = @{ role = 'Reviewer'; tasks = 'Review synthetic output'; tone = 'Concise'; rules = 'No external actions' }; skills = @(); status = 'active' }
)
$rpcBody = @{ p_manager = $manager; p_department = @{ name = 'Synthetic E2E'; niche = 'Testing' }; p_specialists = $specialists } | ConvertTo-Json -Depth 8
$team = Invoke-RestMethod -Uri "$url/rest/v1/rpc/create_agent_team" -Method Post -Headers $auth -Body $rpcBody
if (-not $team.agent_id -or -not $team.department_id -or $team.specialist_count -ne 2) { throw 'Atomic production team creation failed.' }
try {
  $countHeaders = $auth.Clone()
  $countHeaders['Prefer'] = 'count=exact'
  $countResponse = Invoke-WebRequest -Uri "$url/rest/v1/sub_agents?department_id=eq.$($team.department_id)&select=id" -Method Head -Headers $countHeaders -UseBasicParsing
  if ($countResponse.Headers['Content-Range'] -notmatch '/2$') { throw 'Synthetic specialist roster is incomplete.' }
  Assert-ExternalBlocked "$url/functions/v1/connect-channel" @{ agent_id = $team.agent_id; type = 'whatsapp'; credentials = @{ phone_number_id = 'synthetic'; token = 'synthetic-token-never-sent' } } $true
  Assert-ExternalBlocked "$url/functions/v1/connect-telegram" @{ agent_id = $team.agent_id; bot_token = '000000000:synthetic-token-never-sent' } $true
  Assert-ExternalBlocked "$url/functions/v1/connect-provider" @{ action = 'connect'; provider = 'replicate'; api_key = 'synthetic-key-never-sent-000000' }
  Assert-ExternalBlocked "$url/functions/v1/connect-social" @{ action = 'connect'; platform = 'twitter'; credentials = @{ api_key = 'synthetic'; api_secret = 'synthetic'; access_token = 'synthetic'; access_secret = 'synthetic' } }
  Assert-ExternalBlocked "$url/functions/v1/google-oauth" @{ action = 'authorize' }
  Assert-ExternalBlocked "$url/functions/v1/browser-task" @{ action = 'run'; task = 'Read a synthetic public page only' }
  Assert-ExternalBlocked "$url/functions/v1/make-call" @{ agent_id = $team.agent_id; to = '+15550100101'; message = 'Synthetic test only' }
  Assert-ExternalBlocked "$url/functions/v1/create-checkout" @{ package = 'dabbler' }
  Assert-ExternalBlocked "$url/functions/v1/connect-model" @{ action = 'connect'; api_key = 'synthetic-key-never-sent-000000' }
  Assert-ExternalBlocked "$url/functions/v1/custom-tools" @{ action = 'create'; kind = 'http'; name = 'Synthetic'; url = 'https://example.com/never-called' }
  Assert-ExternalBlocked "$url/functions/v1/agent-tool" @{ instruction = 'Read a synthetic marketplace page' }
  Assert-ExternalBlocked "$url/functions/v1/crm-push" @{ webhook_url = 'https://example.com/never-called'; lead = @{ name = 'Synthetic' } }
  Assert-ExternalBlocked "$url/functions/v1/autopost" @{ action = 'schedule'; platform = 'telegram'; target_chat = '@synthetic'; content = 'Synthetic'; scheduled_at = '2099-01-01T00:00:00Z' }
  Assert-ExternalBlocked "$url/functions/v1/follow-up" @{ action = 'enqueue'; channel = 'telegram'; target = '100000000'; goal = 'Synthetic' }
  Assert-ExternalBlocked "$url/functions/v1/google-tools" @{ action = 'gmail_send'; to = 'synthetic@example.invalid'; body = 'Synthetic' }
  Assert-ExternalBlocked "$url/functions/v1/create-planerka-sheet" @{ title = 'Synthetic' }
  Assert-ExternalBlocked "$url/functions/v1/watch-sources" @{ action = 'add'; url = 'https://www.youtube.com/@synthetic'; auto_publish = $true; platforms = @('telegram') }
  Assert-ExternalBlocked "$url/functions/v1/ops-workflow" @{ action = 'meeting_to_tasks'; transcript = 'Synthetic meeting' }
  Assert-ExternalBlocked "$url/functions/v1/generate-image" @{ prompt = 'Synthetic image' }
  Assert-ExternalBlocked "$url/functions/v1/render-video" @{ action = 'render'; props = @{ title = 'Synthetic'; scenes = @() } }
  Assert-ExternalBlocked "$url/functions/v1/transcribe-file" @{ action = 'start'; audio_b64 = 'c3ludGhldGlj' }

  $providerStatus = Invoke-RestMethod -Uri "$url/functions/v1/connect-provider" -Method Post -Headers $auth -Body (@{ action = 'status' } | ConvertTo-Json)
  if (@($providerStatus.connected).Count -ne 0) { throw 'Production test account has a persisted provider key.' }
  $googleStatus = Invoke-RestMethod -Uri "$url/functions/v1/google-oauth" -Method Post -Headers $auth -Body (@{ action = 'status' } | ConvertTo-Json)
  if ($googleStatus.connected) { throw 'Production test account has a persisted Google account.' }
  $socialStatus = Invoke-RestMethod -Uri "$url/functions/v1/connect-social" -Method Post -Headers $auth -Body (@{ action = 'status' } | ConvertTo-Json)
  if ($socialStatus.meta.connected -or $socialStatus.twitter.connected -or $socialStatus.reddit.connected) { throw 'Production test account has a persisted social account.' }
  $channelResponse = Invoke-WebRequest -Uri "$url/rest/v1/channels?agent_id=eq.$($team.agent_id)&select=id" -Method Head -Headers $countHeaders -UseBasicParsing
  if ($channelResponse.Headers['Content-Range'] -notmatch '/0$') { throw 'Blocked channel credentials were persisted.' }
} finally {
  Invoke-RestMethod -Uri "$url/rest/v1/departments?id=eq.$($team.department_id)" -Method Delete -Headers $auth | Out-Null
  Invoke-RestMethod -Uri "$url/rest/v1/agents?id=eq.$($team.agent_id)" -Method Delete -Headers $auth | Out-Null
}
Write-Host 'Production test login, isolation, atomic team, expanded egress kill switch and no-persistence smoke passed.' -ForegroundColor Green
