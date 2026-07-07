# Nemo AI — full production deploy (security fixes + Ustudy Operations Team + reliability).
# Run from the project root:  powershell -ExecutionPolicy Bypass -File .\deploy.ps1
# Reads the Supabase Personal Access Token from .secrets.local (never hard-coded).

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$ref = 'ogfmyjiuqmgroobckdyw'
$pat = (Get-Content .secrets.local | Select-String '^SUPABASE_ACCESS_TOKEN=').ToString().Split('=', 2)[1].Trim()
$env:SUPABASE_ACCESS_TOKEN = $pat
$hdr = @{ Authorization = "Bearer $pat"; 'Content-Type' = 'application/json' }

Add-Type -AssemblyName System.Web.Extensions
$jsonSer = New-Object System.Web.Script.Serialization.JavaScriptSerializer
function Apply-Migration($path) {
  Write-Host "  migration: $([IO.Path]::GetFileName($path))" -ForegroundColor DarkCyan
  # Read as UTF-8 + serialize via .NET (PS 5.1 ConvertTo-Json mangles non-ASCII SQL).
  $sql = [IO.File]::ReadAllText($path)
  $body = $jsonSer.Serialize(@{ query = $sql })
  Invoke-RestMethod -Uri "https://api.supabase.com/v1/projects/$ref/database/query" -Method Post -Headers $hdr -Body $body | Out-Null
}

# Sync the OpenRouter LLM key (from .secrets.local) into the Supabase secret so
# every edge function uses the funded key.
$orLine = Get-Content .secrets.local | Select-String '^OPENROUTER_API_KEY='
if ($orLine) {
  $orKey = $orLine.ToString().Split('=', 2)[1].Trim()
  Write-Host "0/3  Setting OPENROUTER_API_KEY secret..." -ForegroundColor Cyan
  $secretBody = ConvertTo-Json @(@{ name = 'OPENROUTER_API_KEY'; value = $orKey })
  Invoke-RestMethod -Uri "https://api.supabase.com/v1/projects/$ref/secrets" -Method Post -Headers $hdr -Body $secretBody | Out-Null
  Write-Host "     OpenRouter key set." -ForegroundColor Green
}

Write-Host "1/3  Applying DB migrations..." -ForegroundColor Cyan
Apply-Migration .\supabase\migrations\20260702120000_security_hardening.sql
Apply-Migration .\supabase\migrations\20260703090000_ops_workflows.sql
Write-Host "     migrations applied." -ForegroundColor Green

$failed = @()

Write-Host "2/3  Deploying public webhooks (verify_jwt=false)..." -ForegroundColor Cyan
foreach ($fn in 'whatsapp-webhook','instagram-webhook','stripe-webhook','telegram-webhook') {
  Write-Host "  -> $fn" -ForegroundColor DarkCyan
  npx supabase functions deploy $fn --project-ref $ref --use-api --no-verify-jwt
  if ($LASTEXITCODE -ne 0) { $failed += $fn }
}

Write-Host "3/3  Deploying authenticated functions..." -ForegroundColor Cyan
foreach ($fn in 'backend-status','fetch-url','crm-push','ops-workflow','orchestrate','research-agent','test-agent') {
  Write-Host "  -> $fn" -ForegroundColor DarkCyan
  npx supabase functions deploy $fn --project-ref $ref --use-api
  if ($LASTEXITCODE -ne 0) { $failed += $fn }
}

# Verify the two previously-missing functions now respond (not 404)
Write-Host "`nVerifying..." -ForegroundColor Cyan
foreach ($fn in 'backend-status','ops-workflow') {
  $code = -1
  try { $r = Invoke-WebRequest -Uri "https://$ref.supabase.co/functions/v1/$fn" -Method Options -UseBasicParsing -TimeoutSec 10; $code = $r.StatusCode } catch { if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode } }
  $ok = ($code -ne 404 -and $code -ne -1)
  Write-Host ("  {0} -> {1} {2}" -f $fn, $code, $(if ($ok) { 'OK' } else { 'STILL MISSING' })) -ForegroundColor $(if ($ok) { 'Green' } else { 'Red' })
}

if ($failed.Count) {
  Write-Host "`nSOME DEPLOYS FAILED: $($failed -join ', ')" -ForegroundColor Red
  Write-Host "Re-run this script, or check your internet / Supabase token in .secrets.local." -ForegroundColor Yellow
} else {
  Write-Host "`nDONE. All functions deployed, OpenRouter key funded, model = openai/gpt-4o-mini." -ForegroundColor Green
  Write-Host "The AI team now runs on Telegram (connect a bot from the team page)." -ForegroundColor Green
}
Write-Host "Optional full check:  powershell -ExecutionPolicy Bypass -File .\smoke-ops.ps1" -ForegroundColor Yellow
