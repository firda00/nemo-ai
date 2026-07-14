param(
  [switch]$IncludeLiveAgentEval,
  [string]$EvalSuite = ''
)

$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$steps = @(
  @{ Name = 'TypeScript and ESLint'; Command = { npm run test } },
  @{ Name = 'Production build'; Command = { npm run build } },
  @{ Name = 'Agent capability contracts'; Command = { npm run test:contracts } },
  @{ Name = 'Autopost and funnel contracts'; Command = { npm run test:autopost } },
  @{ Name = 'Commerce and logistics contracts'; Command = { npm run test:commerce } },
  @{ Name = 'Industry team safety contracts'; Command = { npm run test:industries } },
  @{ Name = 'Legacy marketplace team persistence'; Command = { npm run test:legacy-teams } },
  @{ Name = 'Agent skills contracts'; Command = { npm run test:skills } },
  @{ Name = 'Governed agent evolution contracts'; Command = { npm run test:evolution } },
  @{ Name = 'Integration truthfulness contracts'; Command = { npm run test:integrations } },
  @{ Name = 'Logistics parser behavior'; Command = { npm run test:logistics-behavior } },
  @{ Name = 'Lead patch behavior'; Command = { npm run test:lead-behavior } },
  @{ Name = 'Release entitlement contracts'; Command = { npm run test:release } },
  @{ Name = 'Auth and trace RLS contracts'; Command = { npm run test:auth-contracts } },
  @{ Name = 'Thirty-point security contracts'; Command = { npm run test:security } },
  @{ Name = 'Thirty-point UI and stability contracts'; Command = { npm run test:ui-stability } },
  @{ Name = 'Website smoke test'; Command = { npm run test:ui } },
  @{ Name = 'Agent trace UI assertions'; Command = { npm run test:trace-ui } }
)

Push-Location $root
try {
  foreach ($step in $steps) {
    Write-Host "[RUN] $($step.Name)" -ForegroundColor Cyan
    $command = $step.Command
    & $command
    if ($LASTEXITCODE -ne 0) {
      Write-Host "[FAIL] $($step.Name)" -ForegroundColor Red
      exit $LASTEXITCODE
    }
    Write-Host "[OK] $($step.Name)" -ForegroundColor Green
  }

  if ($IncludeLiveAgentEval) {
    Write-Host '[RUN] Live agent behavior eval (external API usage)' -ForegroundColor Cyan
    if ($EvalSuite) { & node 'eval\agent-eval.mjs' $EvalSuite }
    else { & node 'eval\agent-eval.mjs' }
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    Write-Host '[OK] Live agent behavior eval' -ForegroundColor Green
  }
} finally {
  Pop-Location
}

Write-Host 'All requested Nemo quality gates passed.' -ForegroundColor Green
exit 0
