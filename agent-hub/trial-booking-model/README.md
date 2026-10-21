# Trial booking model loop — local preparation, no paid approval

Previous acceptance is preserved in `agent-hub/artifacts/trial-booking-acceptance/acceptance-report.md`. This stage uses only `nemo-trial-booking-local`, API55431 and app55439. No Docker configuration change, production schema, outbound customer channel or new profession is needed. The accepted SQL executor is unchanged.

## Application path

`node agent-hub/trial-booking-local/app.mjs --model-chat` opens the existing chat at `http://127.0.0.1:55439/auth` with model mode enabled, **paid execution disabled**. A normal trial-lesson message enters the server cycle. Other modes retain their established behavior. In this scoped conversation the four model tools are schedule, request, read result and recover. Owner decisions/execution stay human actions in the existing card. The model card cannot create a separate manual request/new identity. Server authentication calls real local Auth, derives account/role from the JWT-scoped profile and verifies the schedule authorization before journal access; LLM arguments contain no account, user, approval, operation key or execution capability.

The model uses the existing `callChatProvider` OpenRouter adapter. Server-owned tool results continue the dialogue; no ready tool call is inserted instead of a real model during live acceptance. Model text is labelled as non-authoritative; confirmation comes from the accepted card's separate persisted result read.

The existing ordinary `book_appointment` executor now refuses organizations with canonical trial courses regardless of model text. It also fails closed on missing/unreadable schema. Ordinary accounts with an accessible empty course list retain the old behavior. Therefore deploying that guard later requires the canonical trial schema first; this stage performs no deployment. Calendar/custom/MCP mutation paths retain their existing approval gate. The audit found no additional direct booking insert.

## Persistence and recovery

Actual operations, approval, booking and audit remain in the accepted PostgreSQL runtime. No second booking table or execution queue was introduced. The previously stateless local chat gets a bounded, server-side local journal in `agent-hub/trial-booking-local/.data/model-chat`: identity is a hash of verified account/user/chat, file replacement is atomic, Windows ACL is current-user-only, active process locks serialize turns. Dead process locks are reclaimed only after OS proof; unverifiable locks fail closed. Vite refuses HTTP access to all agent-hub files and retains its default secret denies, including `/@fs` access.

The server fixes `operationKey=chat:<chat UUID>` and saves proposed parameters BEFORE request RPC. Retry/reload uses the same message ID; a reused ID with changed text is rejected. A genuinely new message may repeat the same words while keeping the same operation. Browser reload reads the journal and operation without calling a model. Interrupted tool batches are reconciled using real reads, never replayed as mutations. Unknown provider responses permanently block automatic continuation in that chat pending review; reserved cost is retained. Existing operation recovery/human actions still work. The journal is a local-development persistence choice, not a production distributed conversation service.

Before every RPC the application obtains a current session and pins the original user. It refreshes or asks for sign-in without replaying the mutation. The real temporal expiry test uses a synthetic JWT signed with the existing isolated local key, starts with Auth/PostgREST200, waits until that same token becomes401, then uses a real GoTrue refresh grant. Server expiry settings and time are unchanged. This is distinct from waiting an hour for an ordinary GoTrue token.

## Free reproduction

Only reset this disposable project; preserve previous evidence first. Run commands sequentially, stop and diagnose on failure:

```powershell
node agent-hub/trial-booking-local/setup.mjs prepare
node agent-hub/trial-booking-local/setup.mjs start
node agent-hub/trial-booking-local/setup.mjs reset
node agent-hub/trial-booking-local/integration.mjs --model-stage
# Repeat reset + integration for clean concurrent cases.
node agent-hub/trial-booking-local/app.mjs
# Another terminal, while the manual app runs:
node agent-hub/trial-booking-local/browser-acceptance.mjs
node agent-hub/trial-booking-local/token-expiry.mjs
# Stop only that app before acceptance.mjs owns its port:
node agent-hub/trial-booking-model/acceptance.mjs
npx vitest run tests/trial_booking_client.test.ts tests/legacy_booking_guard.test.ts
npm run quality
```

The model acceptance harness explicitly substitutes model responses but uses real application UI/Auth/PostgREST/tools. It is NOT LLM E2E. It owns/stops its Vite process, adds only synthetic fixtures, and never calls a paid model. Results and source identities live separately in `agent-hub/artifacts/trial-booking-model-loop`. The 21-case harness includes no model substitutions. General quality includes existing mock/demo tests; do not add them to real booking counts.

## Proposed live package — NOT AUTHORIZED / NOT EXECUTED

Catalogue checked 2026-09-08: exact model `openai/gpt-4o-mini`, OpenRouter endpoint `https://openrouter.ai/api/v1/chat/completions`, pinned upstream `openai` (OpenAI). [Official endpoint catalogue](https://openrouter.ai/api/v1/models/openai/gpt-4o-mini/endpoints) explicitly lists tools/tool_choice/max_tokens for OpenAI. The generic model page has inconsistent tool-support prose; the endpoint-specific catalogue is used. [Tool cycle documentation](https://openrouter.ai/docs/guides/features/tool-calling).

Limits: **40 requests total**, at most four model steps per user turn, prompt+tools <=16000 UTF-8 bytes (conservative input budget20000 tokens), output<=512 tokens/call. Prices verified before every live request: input<=0.15USD/million, output<=0.60USD/million, no additional nonzero endpoint fees. Worst token cost =40*(20000*0.15+512*0.60)/1e6 = **$0.132288**. Proposed separately approved ceiling **$0.20** for API token usage, below the previously discussed but unapproved $5. Account funding fees are not model token charges. If provider price/tool metadata cannot be verified, the call is blocked. `node agent-hub/trial-booking-model/plan.mjs` reads only this public catalogue.

Suggested allocation: access+schedule2; successful human-approved cycle6; missing data4; ambiguous lesson4; no capacity6; rejection+prompt approval bypass6; recovery4; contingency8 =40 maximum. Each scenario is driven through ordinary messages in the existing application, not an API-only script. No compulsory tool choice replaces model decisions. Synthetic data only. Assert exact requested vs reported model and provider, tool calls, operation/booking IDs, fresh readback and usage/cost. Missing response model/provider is a failure, never filled from a default for acceptance.

There is no permission to run this package yet. After explicit owner authorization, the coordinator can start the same app with `--model-chat --owner-approved-model-package` and the separate process variable `NEMO_TRIAL_MODEL_APPROVAL=owner-approved-trial-chat-40-requests`. This dual gate is NOT set during preparation. Only then is the already stored OpenRouter key loaded via the repository loader into server memory; no other environment setting is copied and no key is printed or sent to the browser. The durable budget folder reserves a slot before each attempted request and never refunds unknown outcomes or retries automatically. Reusing that directory cannot exceed40 calls; do not delete/replace it to bypass the agreed limit. Previous probe authorization strings do not enable this package.

Source manifests include uncommitted working bytes. Each journal and receipt records its source hash; changed source makes existing chats read-only for recovery. The source journal directory and evidence are excluded from source identity, while all canonical application/harness files are included. Unknown live response requires evidence review, not a fresh chat/budget directory to retry spending.
