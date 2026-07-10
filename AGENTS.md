# Nemo AI instructions for Codex

Read `NEMO_AI_SPEC.md`, `CLAUDE.md`, and `agent-hub/agent-capabilities.json` before reviewing work.

## Role

Codex is the independent architect and reviewer in this repository. By default, inspect and advise without editing. Claude owns implementation and may ask Codex to review a plan, diff, migration, test result, or production risk.

## Required review areas

Auth, RLS, migrations, billing, secrets, external integrations, agent routing, and deploy changes require both Claude and Codex review. Check tenant isolation, authorization, failure handling, idempotency, secret exposure, regression risk, and rollback strategy.

## Verification

Use the smallest relevant checks, then run the full gate before declaring a feature complete:

```powershell
npm run test
npm run build
npm run test:contracts
npm run test:ui
```

Live model evals and post-deploy checks are opt-in because they use external services:

```powershell
powershell -ExecutionPolicy Bypass -File .\agent-hub\quality-gate.ps1 -IncludeLiveAgentEval
powershell -ExecutionPolicy Bypass -File .\smoke-ops.ps1
```

Never print or commit `.env.local`, `.secrets.local`, access tokens, service-role keys, channel credentials, or customer data.
