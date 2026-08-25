param(
  [switch]$IncludeLiveAgentEval,
  [string]$EvalSuite = ''
)

$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$steps = @(
  @{ Name = 'TypeScript and ESLint'; Command = { npm run test } },
  # Сборка здесь — проверка компиляции, а не выкладываемый артефакт: обход проверки переменных
  # ставится явно. Настоящая выкладка идёт без него и остановится, если переменные не заданы.
  @{ Name = 'Production build'; Command = { $env:NEMO_ALLOW_DEMO_BUILD = '1'; npm run build } },
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
  @{ Name = 'Price target behavior'; Command = { npm run test:price-target } },
  @{ Name = 'Price chat behavior'; Command = { npm run test:price-chat } },
  @{ Name = 'Entitlement behavior'; Command = { npm run test:entitlement } },
  @{ Name = 'Payment protocol behavior'; Command = { npm run test:payment-protocol } },
  @{ Name = 'Uzum Bank merchant cashdesk'; Command = { npm run test:uzum } },
  @{ Name = 'Sales trend behavior'; Command = { npm run test:sales-trend } },
  @{ Name = 'Listing submit behavior'; Command = { npm run test:listing-submit } },
  @{ Name = 'Extension contracts'; Command = { npm run test:extension } },
  @{ Name = 'Agent plan behavior'; Command = { npm run test:agent-plan } },
  @{ Name = 'Scanner visibility'; Command = { npm run test:scanner } },
  @{ Name = 'Scanner shadow DOM traversal'; Command = { npm run test:scanner-shadow } },
  @{ Name = 'Scanner field context'; Command = { npm run test:scanner-context } },
  @{ Name = 'Leadgen sanitizer'; Command = { npm run test:leadgen } },
  @{ Name = 'SDR pipeline behavior'; Command = { npm run test:sdr } },
  @{ Name = 'SDR keyless discovery (OpenStreetMap)'; Command = { npm run test:sdr-overpass } },
  @{ Name = 'Local env key loading'; Command = { npm run test:local-env } },
  @{ Name = 'Interactive TUI'; Command = { npm run test:tui } },
  @{ Name = 'TUI theme, banner and layout'; Command = { npm run test:tui-theme } },
  @{ Name = 'Natural query parsing + TUI layout'; Command = { npm run test:query-parse } },
  @{ Name = 'Agent tool registry, MCP and browser'; Command = { npm run test:tools } },
  @{ Name = 'V5 contracts and Telegram lead card'; Command = { npm run test:v5 } },
  @{ Name = 'V5 schema and agent-tool contracts'; Command = { npm run test:v5-contracts } },
  @{ Name = 'Agent loop contracts'; Command = { npm run test:agent-loop } },
  @{ Name = 'Agent loop behaviour'; Command = { npm run test:agent } },
  @{ Name = 'CLI slash commands and roles'; Command = { npm run test:cli-commands } },
  @{ Name = 'QA runner and site audit'; Command = { npm run test:qa } },
  @{ Name = 'Sales call auditor (evidence verification)'; Command = { npm run test:sales-qa } },
  @{ Name = 'Outbound dialer safety'; Command = { npm run test:dialer } },
  @{ Name = 'Sales tools wiring and permissions'; Command = { npm run test:sales-tools } },
    @{ Name = 'HUD and terminal layout'; Command = { npm run test:hud } },
  @{ Name = 'Legal pages, consent and host split'; Command = { npm run test:legal } },
@{ Name = 'Render suites under a TTY'; Command = { npm run test:tty } },
  @{ Name = 'API Gateway and Dragonfly queue'; Command = { npm run test:gateway } },
  @{ Name = 'Typed Durable Runtime client'; Command = { npm run test:runtime-client } },
  @{ Name = 'ADR 002 WASI sandbox'; Command = { npm run test:sandbox } },
  @{ Name = 'ADR 002 document worker'; Command = { npm run test:document-worker } },
  @{ Name = 'ADR 002 media worker'; Command = { npm run test:media-worker } },
  @{ Name = 'ADR 002 vision shadow gateway'; Command = { npm run test:vision } },
  @{ Name = 'ADR 002 factual grounding and precision evals'; Command = { npm run test:grounding-evals } },
  @{ Name = 'ADR 002 ecosystem integration'; Command = { npm run test:ecosystem } },
  @{ Name = 'ADR 001/002 multimodal E2E pipeline'; Command = { npm run test:e2e } },
  @{ Name = 'ADR 002 continuous self-healing loop'; Command = { npm run test:self-healing } },
  @{ Name = 'amoCRM shadow enrichment worker'; Command = { npm run test:amocrm-enrichment } },
  @{ Name = 'Native amoCRM webhook parser'; Command = { npm run test:amocrm-native } },
  @{ Name = 'amoCRM webhook secret lifecycle'; Command = { npm run test:amocrm-webhook-secret } },
  @{ Name = 'Docker compose and image contracts'; Command = { npm run test:infra } },
  @{ Name = 'Voice pipeline: codec, VAD, barge-in, analytics'; Command = { npm run test:voice } },
  @{ Name = 'Media pipeline: .ass subtitles and FFmpeg graph'; Command = { npm run test:media } },
  @{ Name = 'CRM webhook sync'; Command = { npm run test:crm-sync } },
  @{ Name = 'Telegram HOT-lead alerts'; Command = { npm run test:telegram-alert } },
  @{ Name = 'Lead console report'; Command = { npm run test:lead-report } },
  @{ Name = 'Platform API token security'; Command = { npm run test:api-tokens } },
  @{ Name = 'SDR contracts'; Command = { npm run test:sdr-contracts } },
  @{ Name = 'Secrets scan'; Command = { npm run test:secrets } },
  @{ Name = 'Paywall behavior'; Command = { npm run test:paywall } },
  @{ Name = 'Listing vision behavior'; Command = { npm run test:listing-vision } },
  @{ Name = 'Listing images behavior'; Command = { npm run test:listing-images } },
  @{ Name = 'Listing upload behavior'; Command = { npm run test:listing-upload } },
  @{ Name = 'Listing Telegram behavior'; Command = { npm run test:listing-telegram } },
  @{ Name = 'Cost campaign behavior'; Command = { npm run test:cost-campaign } },
  @{ Name = 'Onboarding key normalisation'; Command = { npm run test:onboarding-keys } },
  @{ Name = 'Silence watchdog behavior'; Command = { npm run test:freshness } },
  @{ Name = 'Organizational memory behavior'; Command = { npm run test:org-memory } },
  @{ Name = 'Organizational memory contracts'; Command = { npm run test:org-memory-contracts } },
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
  @{ Name = 'Agent trace UI assertions'; Command = { npm run test:trace-ui } },
  @{ Name = 'Integrations UI assertions'; Command = { npm run test:integrations-ui } },
  @{ Name = 'Landing navigation assertions'; Command = { npm run test:landing-nav } },
  @{ Name = 'Pricing readability'; Command = { npm run test:pricing-contrast } },
  @{ Name = 'CLI auth behaviour'; Command = { npm run test:cli-auth } },
  @{ Name = 'Marketing skills'; Command = { npm run test:marketing-skills } },
  @{ Name = 'CLI documentation matches the CLI'; Command = { npm run test:cli-docs } },
  @{ Name = 'CLI install from a clean folder'; Command = { npm run test:cli-install } }
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
