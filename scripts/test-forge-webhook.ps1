[CmdletBinding()]
param(
  [ValidateSet('Uzum', 'AmoCRM')]
  [string]$Provider = 'Uzum',

  [string]$EndpointUrl = '',

  [string]$TriggerId = $env:FORGE_TRIGGER_ID,

  [string]$WebhookSecret = $env:FORGE_WEBHOOK_SECRET,

  [switch]$IncludeTenantSpoofProbe,

  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($EndpointUrl)) {
  $functionName = if ($Provider -eq 'Uzum') { 'uzum-event-hook' } else { 'amocrm-event-hook' }
  $EndpointUrl = "http://127.0.0.1:54321/functions/v1/$functionName"
}

if ($TriggerId -notmatch '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$') {
  throw 'FORGE_TRIGGER_ID (or -TriggerId) must be a valid UUID from runtime.event_triggers.'
}
if ([string]::IsNullOrWhiteSpace($WebhookSecret)) {
  throw 'FORGE_WEBHOOK_SECRET (or -WebhookSecret) is required. Never commit this value.'
}

$Now = [DateTimeOffset]::UtcNow
$TimestampHeader = $Now.ToString('o')
$EventId = "smoke-$($Provider.ToLowerInvariant())-$($Now.ToUnixTimeMilliseconds())"

if ($Provider -eq 'Uzum') {
  $EventData = [ordered]@{
    event_id = $EventId
    event_type = 'marketplace.order.status_changed'
    timestamp = $TimestampHeader
    payload = [ordered]@{
      order_id = 'UZ-984210'
      status = 'CONFIRMED'
      customer_id = 'must-be-discarded'
      total_amount = 450000
      currency = 'UZS'
      untrusted_extra_field = 'must-be-discarded'
    }
  }
} else {
  $EventData = [ordered]@{
    event_id = $EventId
    event_type = 'crm.lead.created'
    occurred_at = $TimestampHeader
    lead = [ordered]@{
      id = 984210
      status_id = 142
      pipeline_id = 21
      responsible_user_id = 77
      untrusted_extra_field = 'must-be-discarded'
    }
  }
}

# This is a deliberate negative probe. The server must still derive account_id
# exclusively from the verified trigger and must never trust this field.
if ($IncludeTenantSpoofProbe) {
  $EventData.account_id = 'attacker-controlled-tenant'
}

$JsonBody = $EventData | ConvertTo-Json -Depth 6 -Compress
$SignaturePayload = "$TimestampHeader.$JsonBody"
$Hmac = [System.Security.Cryptography.HMACSHA256]::new(
  [System.Text.Encoding]::UTF8.GetBytes($WebhookSecret)
)
try {
  $HashBytes = $Hmac.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($SignaturePayload))
} finally {
  $Hmac.Dispose()
}
$SignatureHex = -join ($HashBytes | ForEach-Object { '{0:x2}' -f $_ })

$Headers = @{
  'Content-Type' = 'application/json'
  'X-Nemo-Trigger-Id' = $TriggerId
  'X-Nemo-Event-Timestamp' = $TimestampHeader
  'X-Signature' = "sha256=$SignatureHex"
}

Write-Host '--- Forge Event Bridge webhook smoke ---' -ForegroundColor Cyan
Write-Host "Provider:  $Provider"
Write-Host "URL:       $EndpointUrl"
Write-Host "Trigger:   $TriggerId"
Write-Host "Timestamp: $TimestampHeader"
Write-Host "Signature: sha256=$($SignatureHex.Substring(0, 12))... (redacted)"
Write-Host "Payload:   $JsonBody"

if ($DryRun) {
  Write-Host '[DRY RUN] Request was signed but not sent.' -ForegroundColor Yellow
  return
}

try {
  $Response = Invoke-WebRequest `
    -Uri $EndpointUrl `
    -Method Post `
    -Headers $Headers `
    -ContentType 'application/json; charset=utf-8' `
    -Body ([System.Text.Encoding]::UTF8.GetBytes($JsonBody)) `
    -UseBasicParsing

  Write-Host "[OK] HTTP $([int]$Response.StatusCode)" -ForegroundColor Green
  if ($Response.Content) {
    $Response.Content | ConvertFrom-Json | ConvertTo-Json -Depth 6 | Write-Host
  }
} catch {
  $StatusCode = $null
  $ErrorBody = $null
  if ($_.Exception.Response) {
    try { $StatusCode = [int]$_.Exception.Response.StatusCode } catch { }
    try {
      $Reader = [System.IO.StreamReader]::new($_.Exception.Response.GetResponseStream())
      $ErrorBody = $Reader.ReadToEnd()
      $Reader.Dispose()
    } catch { }
  }
  Write-Host "[ERR] HTTP $StatusCode" -ForegroundColor Red
  if ($ErrorBody) { Write-Host $ErrorBody -ForegroundColor Yellow }
  throw
}
