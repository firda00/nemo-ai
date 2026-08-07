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
  @{ Name = 'Return reserve behavior'; Command = { npm run test:returns-reserve } },
  @{ Name = 'Unit economics behavior'; Command = { npm run test:unit-economics } },
  @{ Name = 'Listing draft behavior'; Command = { npm run test:listing-draft } },
  @{ Name = 'Listing Telegram behavior'; Command = { npm run test:listing-telegram } },
  @{ Name = 'Cost campaign behavior'; Command = { npm run test:cost-campaign } },
  @{ Name = 'Lead patch behavior'; Command = { npm run test:lead-behavior } },
  @{ Name = 'Release entitlement contracts'; Command = { npm run test:release } },
  @{ Name = 'Review convergence and input UX contracts'; Command = { npm run test:review-ux } },
  @{ Name = 'Autonomous source data and skill handoff behavior'; Command = { npm run test:autonomous-inputs } },
  @{ Name = 'Run telemetry and watchdog liveness'; Command = { npm run test:run-telemetry } },
  @{ Name = 'Durable autonomous run checkpoints'; Command = { npm run test:autonomous-checkpoints } },
  @{ Name = 'Claim-fenced autonomous background worker'; Command = { npm run test:autonomous-worker } },
  @{ Name = 'Autonomous complexity budget'; Command = { npm run test:autonomous-complexity } },
  @{ Name = 'Autonomous DAG scheduling'; Command = { npm run test:autonomous-dag } },
  @{ Name = 'Owner context for connected store data'; Command = { npm run test:owner-context } },
  @{ Name = 'Live store access for teams'; Command = { npm run test:store-access } },
  @{ Name = 'Model degrade chain'; Command = { npm run test:model-degrade } },
  @{ Name = 'Team model switching'; Command = { npm run test:team-model } },
    @{ Name = 'Owner approval queue'; Command = { npm run test:approvals } },
    @{ Name = 'Agent eval and publish gate'; Command = { npm run test:agent-publish-gate } },
  @{ Name = 'Mandatory first-login onboarding'; Command = { npm run test:onboarding } },
  @{ Name = 'Onboarding-based first-team recommendation'; Command = { npm run test:first-team } },
  @{ Name = 'Atomic manager and specialist team creation'; Command = { npm run test:atomic-teams } },
  @{ Name = 'Data leakage hardening'; Command = { npm run test:data-leakage } },
  @{ Name = 'Isolated production test account'; Command = { npm run test:production-account } },
  @{ Name = 'Complete Edge Function deployment manifest'; Command = { npm run test:edge-deployment } },
  @{ Name = 'Schema drift vs runtime reads'; Command = { npm run test:schema-drift } },
  @{ Name = 'Deterministic growth plan'; Command = { npm run test:growth-plan } },
  @{ Name = 'Marketplace catalogue audit'; Command = { npm run test:catalog-audit } },
  @{ Name = 'Swarm efficiency behavior'; Command = { npm run test:swarm-efficiency } },
  @{ Name = 'Tenant-bound credential encryption behavior'; Command = { npm run test:secret-box } },
  @{ Name = 'Telegram queue and Uzbek STT contracts'; Command = { npm run test:telegram-worker } },
  @{ Name = 'Document export contracts'; Command = { npm run test:exports } },
  @{ Name = 'Auth and trace RLS contracts'; Command = { npm run test:auth-contracts } },
  @{ Name = 'Thirty-point security contracts'; Command = { npm run test:security } },
  @{ Name = 'Visual RAG pilot limits and isolation'; Command = { npm run test:visual-rag } },
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
