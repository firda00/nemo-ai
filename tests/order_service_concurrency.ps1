# ADR 004 real concurrency races for public.commerce_create_order, public.commerce_reserve_inventory
# and public.commerce_claim_order_outbox_events (the public.commerce_* wrappers are the actual
# callable contract — see supabase/migrations/20260826113000_order_service_rpcs.sql §5.6 — so the
# races exercise those, not the commerce_runtime.* functions directly). These need real separate
# connections/transactions genuinely contending on the same row locks, so they launch
# `supabase db query` as parallel PowerShell jobs rather than looping in one session, mirroring
# tests/billing_concurrency_reserve.ps1's split for the same reason.
# Requires a reachable local Supabase Postgres (`npx supabase start`, i.e. Docker Desktop running).
#
# This script owns the database lifecycle: it resets the local database to a known-clean state
# before running. Fixture ids are generated fresh per run so re-running this script never collides
# with a previous run's rows even without a reset in between.
#
# Three real races:
#   1. 20 orders, each requesting 1 unit of a single SKU with only 3 units available -> exactly 3
#      reservations succeed (deterministic product_id lock order proves the all-or-nothing check is
#      race-free, not just correct in a single transaction).
#   2. 20 workers racing commerce_claim_order_outbox_events against one pending event -> exactly one
#      worker claims it, the rest see nothing.
#   3. 20 identical concurrent create_order calls (same account, same idempotency key, same payload)
#      -> zero native command errors (the ON CONFLICT DO NOTHING idempotency arbiter must never let
#      a concurrent loser hit unique_violation), exactly one order/birth transition/outbox event, and
#      replay semantics (exactly one call reports idempotent_replay=false, the other 19 report true,
#      all pointing at the same order id).
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
  $orderSql = "select (public.commerce_create_order('$accountId', 'concurrency-reserve-$_', 'USD', 100)) ->> 'order_id' as order_id;"
  $out = Invoke-SupabaseQuery -Sql $orderSql -Json
  ($out | Select-String -Pattern '"order_id"\s*:\s*"([^"]+)"').Matches[0].Groups[1].Value
}

Write-Host 'Race 1: firing 20 concurrent reserve_inventory calls, each requesting 1 unit...'
$jobs = $orderIds | ForEach-Object {
  $orderId = $_
  Start-Job -ScriptBlock {
    param($accountId, $orderId)
    $sql = @"
select (public.commerce_reserve_inventory(
  '$accountId', '$orderId', 1,
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

$countSql = "select count(*)::text as reserved_count from commerce_runtime.orders where account_id = '$accountId' and status = 'inventory_reserved';"
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

$rejectedCountSql = "select count(*)::text as rejected_count from commerce_runtime.orders where account_id = '$accountId' and status = 'inventory_rejected';"
$rejectedCountOut = Invoke-SupabaseQuery -Sql $rejectedCountSql -Json
$rejectedCount = [int](($rejectedCountOut | Select-String -Pattern '"rejected_count"\s*:\s*"?(\d+)"?').Matches[0].Groups[1].Value)
Write-Host "race 1: rejected orders=$rejectedCount (expected 17 — the 17 that lost the scarce-stock race)"
if ($rejectedCount -ne 17) {
  throw "race 1 FAILED: expected the 17 non-admitted orders to land on inventory_rejected, got $rejectedCount"
}

# ---------------------------------------------------------------------------------------------
# Race 2: 20 workers racing to claim one pending outbox event -> exactly one claim succeeds.
# ---------------------------------------------------------------------------------------------

Write-Host 'Race 2: 20 workers racing to claim one pending outbox event...'
$claimAccountId = New-FixtureId
$claimSetupSql = @"
insert into public.accounts (id, name) values ('$claimAccountId', 'order-concurrency-claim');
select (public.commerce_create_order('$claimAccountId', 'concurrency-claim-1', 'USD', 100)) ->> 'order_id' as order_id;
"@
Invoke-SupabaseQuery -Sql $claimSetupSql | Out-Null

$claimJobs = 1..20 | ForEach-Object {
  $n = $_
  Start-Job -ScriptBlock {
    param($claimAccountId, $n)
    $sql = "select count(*)::text as claimed from public.commerce_claim_order_outbox_events('claim-worker-$n', 300, 10) where account_id = '$claimAccountId';"
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

# ---------------------------------------------------------------------------------------------
# Race 3: 20 identical concurrent create_order calls (same account, idempotency key and payload)
# -> zero native command errors, exactly one order/birth transition/outbox event, and clean replay
# semantics (exactly one winner, 19 replays, all pointing at the same order id).
# ---------------------------------------------------------------------------------------------

Write-Host 'Race 3: 20 concurrent identical create_order calls racing the same idempotency key...'
$idemAccountId = New-FixtureId
$idemSetupSql = "insert into public.accounts (id, name) values ('$idemAccountId', 'order-concurrency-idempotency');"
Invoke-SupabaseQuery -Sql $idemSetupSql | Out-Null

$idemJobs = 1..20 | ForEach-Object {
  $n = $_
  Start-Job -ScriptBlock {
    param($idemAccountId, $n)
    $sql = @"
with result as (
  select public.commerce_create_order(
    '$idemAccountId', 'concurrency-idempotency-key', 'USD', 12345, 'cust-race', '{"note":"race"}'::jsonb
  ) as body
)
select body ->> 'order_id' as order_id, body ->> 'idempotent_replay' as idempotent_replay from result;
"@
    $out = & npx supabase db query --local -o json $sql 2>&1
    [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = $out }
  } -ArgumentList $idemAccountId, $n
}

$idemResults = $idemJobs | Wait-Job | Receive-Job
$idemJobs | Remove-Job

$idemFailed = $idemResults | Where-Object { $_.ExitCode -ne 0 }
if ($idemFailed) {
  throw "race 3: $($idemFailed.Count) worker(s) hit a native command error (expected zero — this is exactly the unique_violation race the ON CONFLICT DO NOTHING fix closes): $($idemFailed[0].Output)"
}

$idemOutputs = $idemResults | ForEach-Object { $_.Output }
$orderIdSet = ($idemOutputs | Select-String -Pattern '"order_id"\s*:\s*"([^"]+)"' -AllMatches).Matches |
  ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique
$replayTrueCount = ($idemOutputs | Select-String -Pattern '"idempotent_replay"\s*:\s*"?true"?' -AllMatches).Matches.Count
$replayFalseCount = ($idemOutputs | Select-String -Pattern '"idempotent_replay"\s*:\s*"?false"?' -AllMatches).Matches.Count

Write-Host "race 3: distinct order ids returned = $($orderIdSet.Count) (expected 1)"
if ($orderIdSet.Count -ne 1) {
  throw "race 3 FAILED: expected every one of the 20 concurrent calls to converge on the same order id, got $($orderIdSet.Count) distinct ids"
}

Write-Host "race 3: idempotent_replay=false count = $replayFalseCount (expected 1), idempotent_replay=true count = $replayTrueCount (expected 19)"
if ($replayFalseCount -ne 1 -or $replayTrueCount -ne 19) {
  throw "race 3 FAILED: expected exactly 1 winner (idempotent_replay=false) and 19 replays (idempotent_replay=true), got $replayFalseCount / $replayTrueCount"
}

$idemRowCountsSql = @"
select
  (select count(*) from commerce_runtime.orders where account_id = '$idemAccountId')::text as order_count,
  (select count(*) from commerce_runtime.order_transitions where account_id = '$idemAccountId')::text as transition_count,
  (select count(*) from commerce_runtime.order_outbox_events where account_id = '$idemAccountId')::text as outbox_count;
"@
$idemRowCountsOut = Invoke-SupabaseQuery -Sql $idemRowCountsSql -Json
$idemOrderCount = [int](($idemRowCountsOut | Select-String -Pattern '"order_count"\s*:\s*"?(\d+)"?').Matches[0].Groups[1].Value)
$idemTransitionCount = [int](($idemRowCountsOut | Select-String -Pattern '"transition_count"\s*:\s*"?(\d+)"?').Matches[0].Groups[1].Value)
$idemOutboxCount = [int](($idemRowCountsOut | Select-String -Pattern '"outbox_count"\s*:\s*"?(\d+)"?').Matches[0].Groups[1].Value)

Write-Host "race 3: order_count=$idemOrderCount transition_count=$idemTransitionCount outbox_count=$idemOutboxCount (all expected 1)"
if ($idemOrderCount -ne 1 -or $idemTransitionCount -ne 1 -or $idemOutboxCount -ne 1) {
  throw "race 3 FAILED: expected exactly one order, one birth transition, and one outbox event across all 20 concurrent identical create_order calls, got $idemOrderCount / $idemTransitionCount / $idemOutboxCount"
}

Write-Host 'All three concurrency races PASSED.'
