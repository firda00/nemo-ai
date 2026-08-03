# Nemo AI: Miro Board Blueprint

Create one Miro board named `Nemo AI - User Journey, System, and Scale Plan`.

Use three horizontal frames from left to right. Paste the labels below as sticky notes, then connect them in the stated order.

## Frame 1: User Journey

Title: `From a business task to a supervised result`

```mermaid
flowchart LR
  A[Business owner describes one bounded task] --> B[Chooses agent or AI team]
  B --> C[Sets goal, rules, language, and success criteria]
  C --> D[Adds company knowledge and approved tools]
  D --> E[Runs a safe test before publishing]
  E --> F{Result is supported and safe?}
  F -->|Yes| G[Publish to an approved channel]
  F -->|No or sensitive| H[Human reviews, edits, or takes over]
  G --> I[Agent handles the next real request]
  I --> J[Trace, cost, quality, and outcome are recorded]
  J --> K[Owner improves, pauses, or expands the workflow]
```

Sticky notes:

1. `Business owner describes one task`
2. `Create one agent or a team`
3. `Define boundaries: what the agent may not do`
4. `Connect knowledge, tools, and channel`
5. `Test with synthetic input`
6. `Publish only after a passing test`
7. `Agent prepares work`
8. `Human approves consequential actions`
9. `Trace and improve the workflow`

## Frame 2: Nemo System

Title: `Permission-bound AI workforce runtime`

```mermaid
flowchart TB
  subgraph Experience[Business workspace]
    UI[Web app: create, test, monitor]
    TG[Telegram and web widget]
  end
  subgraph Control[Control plane]
    AUTH[Auth and account isolation]
    POLICY[Permissions, approval policy, risk tier]
    EVAL[Test cases and quality gates]
    OBS[Trace, usage, cost, errors, pause]
  end
  subgraph Runtime[Agent runtime]
    ROUTER[Lead agent routes the task]
    SPECIALISTS[Specialist agents]
    REVIEW[Peer review and revision]
    HANDOFF[Human handoff]
  end
  subgraph Evidence[Verified context]
    RAG[Knowledge and memory]
    TOOLS[Approved server-side tools]
    CHANNEL[Channel message or user input]
  end
  subgraph Data[Server layer]
    DB[Supabase: Postgres, RLS, audit data]
    FN[Edge Functions and workers]
  end
  UI --> AUTH
  UI --> EVAL
  UI --> OBS
  TG --> CHANNEL
  CHANNEL --> FN
  FN --> ROUTER
  ROUTER --> SPECIALISTS
  SPECIALISTS --> REVIEW
  REVIEW --> HANDOFF
  RAG --> ROUTER
  TOOLS --> SPECIALISTS
  POLICY --> ROUTER
  POLICY --> TOOLS
  AUTH --> DB
  EVAL --> DB
  OBS --> DB
  FN --> DB
```

System principles:

- `No secrets in the frontend.`
- `Each account is isolated by authorization and RLS.`
- `Tools run on the server and only with configured permission.`
- `Unknown facts stay unknown; the agent must not invent them.`
- `Payments, refunds, publishing, pricing, orders, legal, medical, hiring, and other consequential actions require human approval.`
- `Every run can be traced, paused, revised, or escalated.`

## Frame 3: Scale Plan

Title: `One repeatable workflow at a time`

```mermaid
flowchart LR
  P0[Stage 0: Demonstrable core] --> P1[Stage 1: One customer workflow]
  P1 --> P2[Stage 2: Repeatable template]
  P2 --> P3[Stage 3: Connected tools and channels]
  P3 --> P4[Stage 4: Multi-workflow team]
  P4 --> P5[Stage 5: Cross-industry platform]
  P0a[Create agents, knowledge, test chat, trace, handoff] --- P0
  P1a[Choose one painful bounded task and measure quality] --- P1
  P2a[Reusable instructions, evals, approval rules, onboarding] --- P2
  P3a[Add integrations only after server executor, authorization, limits, and smoke test] --- P3
  P4a[Specialists coordinate with shared context and review] --- P4
  P5a[New industries are configuration, not a rewrite of the runtime] --- P5
```

Scale gates:

| Stage | Proof before moving forward |
| --- | --- |
| Demonstrable core | The workflow succeeds three times with synthetic non-sensitive data. |
| One customer workflow | A real user confirms the problem and agrees on a measurable success criterion. |
| Repeatable template | At least two similar customers can configure the workflow without a custom code fork. |
| Connected tools and channels | Server executor, account authorization, concrete limits, audit record, and live smoke test exist. |
| Multi-workflow team | Routing, handoff, evaluation, and cost limits remain observable. |
| Cross-industry platform | Each new industry is added as a template and policy, not hardcoded runtime behavior. |

## Investor Readout

Put these three statements at the bottom of the board:

1. `Nemo does not sell unconstrained autonomy. It sells measurable work with permission boundaries.`
2. `The first workflow proves the product; the governed runtime enables expansion.`
3. `A business starts with one responsibility, then adds teams, knowledge, tools, and channels as trust is earned.`
