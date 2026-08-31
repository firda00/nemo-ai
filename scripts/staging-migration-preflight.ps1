[CmdletBinding()]
param(
  [switch]$SkipDatabaseReset
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

function Invoke-Checked {
  param([string]$Label, [scriptblock]$Command)
  Write-Host "[RUN] $Label" -ForegroundColor Cyan
  & $Command
  if ($LASTEXITCODE -ne 0) { throw "$Label failed with exit code $LASTEXITCODE" }
  Write-Host "[OK] $Label" -ForegroundColor Green
}

Push-Location $root
try {
  $requiredArtifacts = @(
    'supabase/migrations/20260830120000_marketing_brand_kits.sql',
    'supabase/rollbacks/20260830120000_marketing_brand_kits.down.sql',
    'supabase/tests/marketing_finance_tenant_isolation.sql'
  )
  foreach ($artifact in $requiredArtifacts) {
    if (-not (Test-Path -LiteralPath (Join-Path $root $artifact))) { throw "Required staging artifact is missing: $artifact" }
  }

  if (-not $SkipDatabaseReset) {
    Invoke-Checked 'Docker Engine availability' { docker info --format '{{.ServerVersion}}' | Out-Null }
    Invoke-Checked 'Local Supabase services' { npm run safe:exec -- npx supabase start }
    Invoke-Checked 'Clean local Supabase migration reset' { npx supabase db reset --local }
    Invoke-Checked 'Local database lint' { npx supabase db lint --local --level error }
    Invoke-Checked 'Local pgTAP tenant isolation' { npx supabase test db --local supabase/tests/marketing_finance_tenant_isolation.sql }
    Invoke-Checked 'Local Brand Kit rollback rehearsal' { npx supabase db query --local --file supabase/rollbacks/20260830120000_marketing_brand_kits.down.sql }
    Invoke-Checked 'Restore local schema after rollback rehearsal' { npx supabase db reset --local }
  }

  Invoke-Checked 'Marketing structured-output contracts' { npm run test:marketing-campaign }
  Invoke-Checked 'Finance cash-flow contracts' { npm run test:finance-cash-flow }
  Invoke-Checked 'Finance ingestion and grounding' { npm run test:finance-ingestion }
  Invoke-Checked 'Research Notebook contracts' { npm run test:research-notebook }
  Invoke-Checked 'Edge deployment manifest' { npm run test:edge-deployment }
  Invoke-Checked 'Secret scan' { npm run scan:secrets }
} finally {
  Pop-Location
}

Write-Host 'Staging migration pre-flight passed. No remote project was changed.' -ForegroundColor Green
