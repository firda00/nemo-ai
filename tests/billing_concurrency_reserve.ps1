# ADR 003 invariant #1 + real concurrency races for billing.reserve_usage. These need real
# separate connections/transactions genuinely contending on the same row locks inside
# billing.reserve_usage (see supabase/migrations/20260826093000_billing_reservation_rpcs.sql), so
# they launch `supabase db query` as parallel PowerShell jobs rather than looping in one session.
# Requires a reachable local Supabase Postgres (`npx supabase start`, i.e. Docker Desktop running).
#
# This script owns the database lifecycle: it resets the local database to a known-clean state
# before running (a disposable DB, not manual per-test cleanup), which is also what lets
# billing.activate_global_cutover's quad_zero_check() pass without fighting leftover state from
# other test runs. Fixture ids are generated fresh per run (not hardcoded UUIDs) so re-running this
# script never collides with a previous run's rows even without a reset in between.
#
# Three real races, each against its own disposable fixture set:
#   1. 20 distinct idempotency keys, a bucket with 3 units      -> exactly 3 admits.
#   2. 20 distinct idempotency keys, budget_units = 2, buckets with ample units -> exactly 2 admits
#      (budget-limited, not bucket-limited — proves the account_usage_policies lock, not just the
#      bucket lock, actually serializes admission).
#   3. 20 identical idempotency keys, ample budget and units    -> exactly one reservation id
#      created, and no native command errors (the idempotency replay path under contention).
#
# Any native command failure (non-zero exit code from `npx supabase ...`) fails the whole run
# immediately — this script does not treat a stderr line as a soft warning.
#
# Usage: pwsh -File tests/billing_concurrency_reserve.ps1

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
  # A fresh v4 UUID per race/run, so distinct races within one run (and distinct script runs)
  # never collide on account_id/bucket_id, without requiring a reset between races.
  return [guid]::NewGuid().ToString()
}

function New-FixtureMatrixVersion {
  # billing.pricing_matrices.version is a plain integer with a unique constraint; a random value
  # in a range no fixed test constant ever uses avoids colliding with any other test's version.
  return Get-Random -Minimum 900000 -Maximum 999999
}

Write-Host 'Resetting local Supabase database to a known-clean state...'
& npx supabase db reset --local
if ($LASTEXITCODE -ne 0) {
  throw "npx supabase db reset --local failed (exit $LASTEXITCODE)"
}

Write-Host 'Activating the global v2 cutover (billing.reserve_usage denies everything until v2_active)...'
$activateSql = @"
select runtime.enter_billing_maintenance('concurrency-test-operator', 'CONCURRENCY_TEST_CUTOVER');
select billing.activate_global_cutover('concurrency-test-operator', 'CONCURRENCY_TEST_CUTOVER');
"@
Invoke-SupabaseQuery -Sql $activateSql | Out-Null

function Invoke-ReserveRace {
  param(
    [Parameter(Mandatory = $true)][string]$RaceName,
    [Parameter(Mandatory = $true)][bigint]$BudgetUnits,
    [Parameter(Mandatory = $true)][bigint]$BucketUnits,
    [Parameter(Mandatory = $true)][scriptblock]$KeyForWorker,
    [Parameter(Mandatory = $true)][int]$ExpectedAdmits,
    [Parameter(Mandatory = $true)][int]$ExpectedDistinctReservations
  )

  $accountId = New-FixtureId
  $bucketId  = New-FixtureId
  $matrixVersion = New-FixtureMatrixVersion

  $setupSql = @"
insert into public.accounts (id, name) values ('$accountId', 'billing-concurrency-$RaceName');
insert into billing.pricing_matrices (id, version, name, conversion_rules, is_active)
values (gen_random_uuid(), $matrixVersion, 'concurrency-test-matrix-$RaceName', jsonb_build_object('legacy_credit_to_unit', 1), false);
insert into billing.account_usage_policies (account_id, pricing_matrix_version, budget_units)
values ('$accountId', $matrixVersion, $BudgetUnits);
insert into billing.usage_buckets (id, account_id, source, pricing_matrix_version, total_units, remaining_units, expires_at)
values ('$bucketId', '$accountId', 'purchase', $matrixVersion, $BucketUnits, $BucketUnits, now() + interval '1 day');
"@
  Invoke-SupabaseQuery -Sql $setupSql | Out-Null

  $jobs = 1..20 | ForEach-Object {
    $n = $_
    $key = & $KeyForWorker $n
    Start-Job -ScriptBlock {
      param($accountId, $key, $n)
      $sql = "select (billing.reserve_usage('$accountId', '$key', 1, 'worker-$n')) ->> 'status' as status;"
      $out = & npx supabase db query --local -o json $sql 2>&1
      [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = $out }
    } -ArgumentList $accountId, $key, $n
  }

  $results = $jobs | Wait-Job | Receive-Job
  $jobs | Remove-Job

  $failed = $results | Where-Object { $_.ExitCode -ne 0 }
  if ($failed) {
    throw "race '$RaceName': $($failed.Count) worker(s) hit a native command error: $($failed[0].Output)"
  }

  $outputs = $results | ForEach-Object { $_.Output }
  $admitCount = ($outputs | Select-String -Pattern '"reserved"').Count

  $countSql = "select count(distinct id)::text as distinct_reservations from billing.usage_reservations where account_id = '$accountId' and status = 'reserved';"
  $countOut = Invoke-SupabaseQuery -Sql $countSql -Json
  $distinctReservations = [int](($countOut | Select-String -Pattern '"distinct_reservations"\s*:\s*"?(\d+)"?').Matches[0].Groups[1].Value)

  Write-Host "race '$RaceName': admits=$admitCount (expected $ExpectedAdmits), distinct reservations=$distinctReservations (expected $ExpectedDistinctReservations)"

  if ($admitCount -ne $ExpectedAdmits -or $distinctReservations -ne $ExpectedDistinctReservations) {
    throw "race '$RaceName' FAILED: expected $ExpectedAdmits admits / $ExpectedDistinctReservations distinct reservations, got $admitCount / $distinctReservations"
  }
}

# Race 1: 20 distinct keys, a bucket with only 3 units -> exactly 3 admits (bucket-limited).
Invoke-ReserveRace `
  -RaceName 'distinct-keys-bucket-limited' `
  -BudgetUnits 1000 `
  -BucketUnits 3 `
  -KeyForWorker { param($n) "distinct-bucket-key-$n" } `
  -ExpectedAdmits 3 `
  -ExpectedDistinctReservations 3

# Race 2: 20 distinct keys, ample bucket units but budget_units = 2 -> exactly 2 admits
# (budget-limited: proves the account_usage_policies row lock serializes admission, not just the
# bucket lock).
Invoke-ReserveRace `
  -RaceName 'distinct-keys-budget-limited' `
  -BudgetUnits 2 `
  -BucketUnits 1000 `
  -KeyForWorker { param($n) "distinct-budget-key-$n" } `
  -ExpectedAdmits 2 `
  -ExpectedDistinctReservations 2

# Race 3: 20 identical keys, ample budget and units -> exactly one reservation id, no errors
# (the idempotency-replay path under real contention).
Invoke-ReserveRace `
  -RaceName 'identical-keys-idempotent-replay' `
  -BudgetUnits 1000 `
  -BucketUnits 1000 `
  -KeyForWorker { param($n) 'identical-key-shared' } `
  -ExpectedAdmits 20 `
  -ExpectedDistinctReservations 1

Write-Host 'All three concurrency races PASSED.'
