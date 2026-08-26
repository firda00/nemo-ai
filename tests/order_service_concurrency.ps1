# ADR 004 real concurrency races for commerce_runtime.reserve_inventory and
# commerce_runtime.claim_order_outbox_events. These need real separate connections/transactions
# genuinely contending on the same row locks (see supabase/migrations/20260826113000_order_service_rpcs.sql),
# so they launch `supabase db query` as parallel PowerShell jobs rather than looping in one session,
# mirroring tests/billing_concurrency_reserve.ps1's split for the same reason.
# Requires a reachable local Supabase Postgres (`npx supabase start`, i.e. Docker Desktop running).
#
# This script owns the database lifecycle: it resets the local database to a known-clean state
# before running. Fixture ids are generated fresh per run so re-running this script never collides
# with a previous run's rows even without a reset in between.
#
# Two real races:
#   1. 20 orders, each requesting 1 unit of a single SKU with only 3 units available -> exactly 3
#      reservations succeed (deterministic product_id lock order proves the all-or-nothing check is
#      race-free, not just correct in a single transaction).
#   2. 20 workers racing commerce_runtime.claim_order_outbox_events against one pending event ->
#      exactly one worker claims it, the rest see nothing.
#
# Usage: pwsh -File tests/order_service_concurrency.ps1

$ErrorActionPreference = 'Stop'

function Invoke-SupabaseQuery {
  param(
    [Parameter(Mandatory = $true)][string]$Sql,
    [switch]$Json
  )
  $args = @('supabase', 'db', 'query', '--local')
  if ($Json) { $args += @('-o', 'json') }
  $out = & npx @args $Sql 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "npx supabase db query failed (exit $LASTEXITCODE): $out"
  }
  return $out
}

function New-FixtureId {
  return [guid]::NewGuid().ToString()
}

Write-Host 'Resetting local Supabase database to a known-clean state...'
& npx supabase db reset --local
if ($LASTEXITCODE -ne 0) {
  throw "npx supabase db reset --local failed (exit $LASTEXITCODE)"
}

# ---------------------------------------------------------------------------------------------
# Race 1: 20 orders, one scarce SKU with 3 units -> exactly 3 reservations admitted.
# ---------------------------------------------------------------------------------------------

$accountId = New-FixtureId
$productId = New-FixtureId

Write-Host 'Race 1: seeding account, inventory (3 units) and 20 created orders...'
$setupSql = @"
insert into public.accounts (id, name) values ('$accountId', 'order-concurrency-reserve');
insert into commerce_runtime.inventory (account_id, product_id, available, reserved)
values ('$accountId', '$productId', 3, 0);
"@
Invoke-SupabaseQuery -Sql $setupSql | Out-Null

$orderIds = 1..20 | ForEach-Object {
  $orderSql = "select (commerce_runtime.create_order('$accountId', 'concurrency-reserve-$_', 'USD', 100)) ->> 'order_id' as order_id;"
  $out = Invoke-SupabaseQuery -Sql $orderSql -Json
  ($out | Select-String -Pattern '"order_id"\s*:\s*"([^"]+)"').Matches[0].Groups[1].Value
}

Write-Host 'Race 1: firing 20 concurrent reserve_inventory calls, each requesting 1 unit...'
$jobs = $orderIds | ForEach-Object {
  $orderId = $_
  Start-Job -ScriptBlock {
    param($accountId, $orderId)
    $sql = @"
select (commerce_runtime.reserve_inventory(
  '$accountId', '$orderId', 0,
  jsonb_build_array(jsonb_build_object('product_id', '$using:productId', 'quantity', 1))
)) ->> 'status' as status;
"@
    $out = & npx supabase db query --local -o json $sql 2>&1
    [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = $out }
  } -ArgumentList $accountId, $orderId
}

$results = $jobs | Wait-Job | Receive-Job
$jobs | Remove-Job

$failed = $results | Where-Object { $_.ExitCode -ne 0 }
if ($failed) {
  throw "race 1: $($failed.Count) worker(s) hit a native command error: $($failed[0].Output)"
}

$outputs = $results | ForEach-Object { $_.Output }
$admitCount = ($outputs | Select-String -Pattern '"transitioned"').Count

$countSql = "select count(*)::text as reserved_count from commerce_runtime.orders where account_id = '$accountId' and status = 'reserved';"
$countOut = Invoke-SupabaseQuery -Sql $countSql -Json
$reservedCount = [int](($countOut | Select-String -Pattern '"reserved_count"\s*:\s*"?(\d+)"?').Matches[0].Groups[1].Value)

Write-Host "race 1: admits=$admitCount (expected 3), reserved orders=$reservedCount (expected 3)"
if ($admitCount -ne 3 -or $reservedCount -ne 3) {
  throw "race 1 FAILED: expected 3 admits / 3 reserved orders, got $admitCount / $reservedCount"
}

$availableSql = "select available::text from commerce_runtime.inventory where account_id = '$accountId' and product_id = '$productId';"
$availableOut = Invoke-SupabaseQuery -Sql $availableSql -Json
$available = [int](($availableOut | Select-String -Pattern '"available"\s*:\s*"?(\d+)"?').Matches[0].Groups[1].Value)
Write-Host "race 1: remaining available=$available (expected 0)"
if ($available -ne 0) {
  throw "race 1 FAILED: expected available=0 after exactly 3 successful reservations, got $available"
}

# ---------------------------------------------------------------------------------------------
# Race 2: 20 workers racing to claim one pending outbox event -> exactly one claim succeeds.
# ---------------------------------------------------------------------------------------------

Write-Host 'Race 2: 20 workers racing to claim one pending outbox event...'
$claimAccountId = New-FixtureId
$claimSetupSql = @"
insert into public.accounts (id, name) values ('$claimAccountId', 'order-concurrency-claim');
select (commerce_runtime.create_order('$claimAccountId', 'concurrency-claim-1', 'USD', 100)) ->> 'order_id' as order_id;
"@
Invoke-SupabaseQuery -Sql $claimSetupSql | Out-Null

$claimJobs = 1..20 | ForEach-Object {
  $n = $_
  Start-Job -ScriptBlock {
    param($claimAccountId, $n)
    $sql = "select count(*)::text as claimed from commerce_runtime.claim_order_outbox_events('claim-worker-$n', 300, 10) where account_id = '$claimAccountId';"
    $out = & npx supabase db query --local -o json $sql 2>&1
    [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = $out }
  } -ArgumentList $claimAccountId, $n
}

$claimResults = $claimJobs | Wait-Job | Receive-Job
$claimJobs | Remove-Job

$claimFailed = $claimResults | Where-Object { $_.ExitCode -ne 0 }
if ($claimFailed) {
  throw "race 2: $($claimFailed.Count) worker(s) hit a native command error: $($claimFailed[0].Output)"
}

$claimOutputs = $claimResults | ForEach-Object { $_.Output }
$totalClaimed = ($claimOutputs | Select-String -Pattern '"claimed"\s*:\s*"?(\d+)"?' -AllMatches).Matches |
  ForEach-Object { [int]$_.Groups[1].Value } | Measure-Object -Sum | Select-Object -ExpandProperty Sum

Write-Host "race 2: total rows claimed across 20 workers = $totalClaimed (expected 1)"
if ($totalClaimed -ne 1) {
  throw "race 2 FAILED: expected exactly 1 claimed row across all workers, got $totalClaimed"
}

Write-Host 'Both concurrency races PASSED.'
