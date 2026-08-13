$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$secretsPath = Join-Path $root '.secrets.local'
$envPath = Join-Path $root '.env.local'

function Read-Setting([string]$path, [string]$name) {
  if (-not [IO.File]::Exists($path)) { return '' }
  $line = [IO.File]::ReadAllLines($path) | Where-Object { $_ -match "^$([regex]::Escape($name))=" } | Select-Object -Last 1
  if (-not $line) { return '' }
  return $line.Substring($line.IndexOf('=') + 1).Trim()
}

$supabaseUrl = Read-Setting $envPath 'VITE_SUPABASE_URL'
$anonKey = Read-Setting $envPath 'VITE_SUPABASE_ANON_KEY'
$pat = Read-Setting $secretsPath 'SUPABASE_ACCESS_TOKEN'
if (-not $supabaseUrl -or -not $anonKey -or -not $pat) { throw 'Required local deployment settings are missing.' }
$projectRef = ([uri]$supabaseUrl).Host.Split('.')[0]
$managementHeaders = @{ Authorization = "Bearer $pat"; 'Content-Type' = 'application/json' }

$email = Read-Setting $secretsPath 'NEMO_E2E_EMAIL'
$password = Read-Setting $secretsPath 'NEMO_E2E_PASSWORD'
if (-not $email -or -not $password) {
  $bytes = New-Object byte[] 32
  $rng = New-Object Security.Cryptography.RNGCryptoServiceProvider
  $rng.GetBytes($bytes)
  $rng.Dispose()
  $random = [Convert]::ToBase64String($bytes).Replace('+','A').Replace('/','B').Replace('=','')
  $email = "nemo-production-e2e-$([guid]::NewGuid().ToString('N').Substring(0, 12))@example.com"
  $password = "Nemo!$random"
  [IO.File]::AppendAllText($secretsPath, "`r`nNEMO_E2E_EMAIL=$email`r`nNEMO_E2E_PASSWORD=$password`r`n", [Text.Encoding]::UTF8)
}

$headers = @{ apikey = $anonKey; 'Content-Type' = 'application/json' }
$session = $null
try {
  $session = Invoke-RestMethod -Uri "$supabaseUrl/auth/v1/token?grant_type=password" -Method Post -Headers $headers -Body (@{ email = $email; password = $password } | ConvertTo-Json)
} catch {
  try {
    $apiKeys = Invoke-RestMethod -Uri "https://api.supabase.com/v1/projects/$projectRef/api-keys" -Headers $managementHeaders
    $serviceKey = @($apiKeys) | Where-Object { $_.name -eq 'service_role' } | Select-Object -ExpandProperty api_key -First 1
    if (-not $serviceKey) { throw 'service key unavailable' }
    $adminHeaders = @{ apikey = $serviceKey; Authorization = "Bearer $serviceKey"; 'Content-Type' = 'application/json' }
    $users = Invoke-RestMethod -Uri "$supabaseUrl/auth/v1/admin/users?page=1&per_page=1000" -Headers $adminHeaders
    $existing = @($users.users) | Where-Object { $_.email -eq $email } | Select-Object -First 1
    $identityBody = @{ email = $email; password = $password; email_confirm = $true; user_metadata = @{ name = 'Nemo Production E2E' } } | ConvertTo-Json -Depth 4
    if ($existing) {
      Invoke-RestMethod -Uri "$supabaseUrl/auth/v1/admin/users/$($existing.id)" -Method Put -Headers $adminHeaders -Body $identityBody | Out-Null
    } else {
      Invoke-RestMethod -Uri "$supabaseUrl/auth/v1/admin/users" -Method Post -Headers $adminHeaders -Body $identityBody | Out-Null
    }
    $serviceKey = $null
    $session = Invoke-RestMethod -Uri "$supabaseUrl/auth/v1/token?grant_type=password" -Method Post -Headers $headers -Body (@{ email = $email; password = $password } | ConvertTo-Json)
  } catch { throw 'Could not provision the production test identity.' }
}
if (-not $session.access_token -or -not $session.user.id) { throw 'Production test identity did not return an authenticated session.' }

$safeUserId = [guid]::Parse($session.user.id).ToString()
$sql = "do `$`$ declare a uuid; marked int; begin select account_id into a from public.users where id = '$safeUserId'::uuid; if a is null then raise exception 'test profile missing'; end if; select count(*) into marked from public.accounts where is_production_e2e and id <> a; if marked > 0 then raise exception 'another production test account already exists'; end if; update public.accounts set is_production_e2e = true, name = 'Nemo Production E2E', plan = 'beta' where id = a; update public.users set is_admin = false, role = 'owner' where id = '$safeUserId'::uuid; end `$`$;"
Add-Type -AssemblyName System.Web.Extensions
$serializer = New-Object System.Web.Script.Serialization.JavaScriptSerializer
$body = $serializer.Serialize(@{ query = $sql })
Invoke-RestMethod -Uri "https://api.supabase.com/v1/projects/$projectRef/database/query" -Method Post -Headers $managementHeaders -Body $body | Out-Null

$authHeaders = @{ apikey = $anonKey; Authorization = "Bearer $($session.access_token)"; 'Content-Type' = 'application/json' }
$onboarding = @{
  company = 'Nemo Synthetic E2E'; market = 'other'; role = 'developer';
  goal = 'Verify safe read-only onboarding and atomic team creation.';
  tasks = @('development', 'research'); sources = @('later'); action_policy = 'read_only';
  accept_privacy = $true; accept_terms = $true; marketing_email = $false; marketing_telegram = $false
} | ConvertTo-Json -Depth 4
$completed = Invoke-RestMethod -Uri "$supabaseUrl/functions/v1/complete-onboarding" -Method Post -Headers $authHeaders -Body $onboarding
if (-not $completed.ok) { throw 'Production test onboarding failed.' }

Write-Host 'Production test account provisioned and isolated. Credentials remain only in .secrets.local.' -ForegroundColor Green
