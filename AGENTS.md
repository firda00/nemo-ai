# Nemo AI instructions for Codex

Read `NEMO_AI_SPEC.md`, `CLAUDE.md`, and `agent-hub/agent-capabilities.json` before reviewing work.

## Role

The user authorized Codex to implement and coordinate Nemo on 2026-09-06. Codex owns the current implementation; Claude Fable 5.1 may receive bounded independent tasks through the user's Claude Code subscription. Do not require Claude participation before routine authorized work. See `docs/AI_WORKFLOW.md` for the current workflow and prompt template.

User instructions take precedence over repository skills and role defaults. Continue authorized reversible work, keep prior requirements when the user adds a request, and ask only when a missing decision changes the result. Report concrete results and remaining gaps in Russian.

Current priority: reliable functionality, landing page and coherent brand/logo together. Preserve the universal platform scope; demonstrate specific verified workflows. AGI remains a research direction, never an unsupported product claim. Do not replace the existing model router with one flagship model merely because we use Astra for development.

The user additionally requested direct Google/email/password access, lower avoidable latency, and the API-accessible capabilities of GPT-6 Astra and Claude Fable 5.1. Preserve this as a product goal. The first direct-provider chat layer is distinct from workflow/tool integration; track the remaining connections in `docs/MODEL_CAPABILITIES.md`. Never silently substitute a model the user explicitly selected. Keep sign-in and registration directly accessible; pilot signup is optional.

## Required review areas

Auth, RLS, migrations, billing, secrets, external integrations, agent routing, and deploy changes need independent review in addition to implementation review. Check tenant isolation, authorization, failure handling, idempotency, secret exposure, regression risk, and rollback strategy. If a reviewer hits a quota, keep the review gap visible and continue independent local work; never claim independent approval.

Delegate concrete independent tasks when useful, normally at most two alongside the owner. State owned paths, acceptance criteria and limitations; one writer per file. Request exactly `claude-fable-5-1` for the user's Claude tasks and report any unavailable-model response instead of silently falling back. Never configure reverse Claude MCP from Codex.

The owner authorized deployment on 2026-09-06 after the auth/latency stage, together with a universal AI employee catalog (call center, finance, marketing, SEO, engineering and other configurable roles). Deploy to the established project after independent review and release checks. Read-only production configuration/schema/health inspection is authorized. Apply only necessary reviewed additive schema changes after checking the actual migration state; do not blindly replay historical migrations or activate unrelated scheduled jobs. Do not treat a draft employee as evaluated or connected.

Remaining limits: no Nemo paid/live model calls, real outbound messaging, commits, destructive production migrations or credential rotation. Explicitly requested Claude Code delegation uses the authenticated subscription; no API-key fallback or automatic credit purchase. Local/mock checks and public documentation are allowed.

## Verification

Use meaningful targeted checks first. Run `npm run quality` once the implementation and review fixes are stable, before declaring a feature complete. Repeat only when changes or failures justify it. The component commands include:

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

When a diagnostic command can echo environment values, credentials, headers, connection strings, or
configuration files, run it through `npm run safe:exec -- <command> [args...]`. Never dump an entire
secret-bearing file to stdout; inspect names and metadata only. The wrapper redacts token formats,
secret assignments, connection passwords and multiline private keys.
