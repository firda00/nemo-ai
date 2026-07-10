# YC Fall 2026 application draft — Nemo AI

This is a drafting worksheet, not a verbatim copy of the private YC portal. Reconcile its sections with the live portal before submission.

## Company

### Company name

Nemo AI

Confirm legal/brand availability: **[FOUNDER INPUT REQUIRED]**

### Company URL

**[FOUNDER INPUT REQUIRED: public HTTPS URL]**

### Product link and demo credentials

- Product URL: **[FOUNDER INPUT REQUIRED]**
- Reviewer email: **[CREATE NON-SENSITIVE DEMO ACCOUNT]**
- Reviewer password: **[STORE OUTSIDE GIT]**

### One-line description

Nemo lets small businesses turn a written workflow into a supervised team of AI agents connected to their knowledge, messaging channels, and business tools.

Alternative shorter version:

Nemo builds and operates supervised AI teams for repetitive small-business workflows.

## What are you making?

Nemo is a no-code platform for creating and operating teams of AI agents. A business describes a workflow, connects its documents, channels, and tools, and Nemo creates a team lead plus specialist agents. The team routes work, uses approved tools, records an execution trace, and escalates low-confidence or sensitive actions to a person.

Our initial product is focused on repetitive sales and operations work handled through chat and spreadsheets. The same authoring and runtime system is designed to support other measurable workflows without hardcoding departments into the core product.

## What works today?

Verified in the current codebase:

- agent and multi-agent team creation/editing interfaces;
- knowledge, memory, custom tools, channels, routing, and human-handoff paths;
- Telegram, web widget, WhatsApp, and Instagram webhook code;
- observability and deterministic agent-evaluation infrastructure;
- a passing production build, 12-route browser smoke suite, and 76/76 latest agent eval run.

Current limitation: repository evidence does not establish production customers, revenue, or live integration reliability. Agent Trace is still being completed. Replace this paragraph before submission with the exact deployed and customer-verified status.

## Where do you live, and where will the company be after YC?

Current founder locations: **[FOUNDER INPUT REQUIRED]**

Planned company location after YC: **[FOUNDER INPUT REQUIRED]**

Can every founder attend the in-person San Francisco kickoff and regular batch meetups from October through December 2026? **[YES/NO + DETAILS]**

## How far along are you?

Product development started: **[FOUNDER INPUT REQUIRED: month/year]**

Current factual state:

- working local product and demo routes;
- Supabase backend and multi-channel integration code exists;
- automated quality and agent-behavior checks exist;
- public deployment status: **[FOUNDER INPUT REQUIRED]**;
- active design partners: **[FOUNDER INPUT REQUIRED]**;
- weekly active businesses/users: **[FOUNDER INPUT REQUIRED]**;
- workflows completed in the last 7/30 days: **[FOUNDER INPUT REQUIRED]**.

## How long have the founders worked on this, and how much was full-time?

**[FOUNDER INPUT REQUIRED: exact dates and full-time/part-time breakdown for each founder]**

## What technologies are you using?

React 19, TypeScript, Vite, Supabase/Postgres/Auth/Edge Functions, pgvector-style knowledge retrieval, provider-based LLM execution, HTTP/MCP tools, and webhook integrations. The product includes deterministic evals, browser smoke tests, execution tracing, human handoff, and permission boundaries.

Confirm actual production providers and remove unused technologies: **[FOUNDER REVIEW REQUIRED]**

## Are people using it?

**[FOUNDER INPUT REQUIRED — never infer this from the codebase]**

For every real user or design partner, provide:

- company and industry;
- start date;
- exact workflow;
- weekly volume;
- current result versus previous manual process;
- whether they pay and how much;
- whether YC may contact them.

## Do you have revenue?

**[FOUNDER INPUT REQUIRED: exact monthly revenue, source, start date, and whether recurring]**

If zero, write “No” and explain what concrete user evidence exists. Do not describe pipeline as revenue.

## What is your growth?

**[FOUNDER INPUT REQUIRED]**

Use a weekly table for the last eight weeks: activated businesses, active businesses, completed workflows, retained businesses, revenue, and gross model/tool cost.

## Why did you pick this idea? Do you have domain expertise?

Draft structure:

1. The founders repeatedly observed **[SPECIFIC WORKFLOW PROBLEM]** while working at/with **[COMPANY OR INDUSTRY]**.
2. Existing chatbots answer questions but do not reliably complete multi-step work across documents, messaging, and business tools.
3. The founders built Nemo because **[SPECIFIC INSIGHT OR UNFAIR ACCESS]**.
4. Evidence so far: **[INTERVIEWS, PILOTS, USAGE, OR MEASURED OUTCOME]**.

Founder story and domain evidence: **[FOUNDER INPUT REQUIRED]**

## Who are your competitors, and what do you understand that they do not?

Competitor research must be refreshed before submission. Relevant categories include general agent builders, workflow automation platforms, customer-support agents, and vertical AI workforce products.

Proposed insight to validate:

> Businesses do not need another chat interface or a bag of autonomous agents. They need a permission-bound team that can be created from their existing workflow, connected to local communication habits and business tools, tested before deployment, observed step by step, and handed back to a human when confidence is low.

Proof required: **[CUSTOMER QUOTES, SWITCHING REASONS, OR WIN/LOSS DATA]**

## How will you make money?

Proposed model: monthly SaaS tiers plus metered AI/tool usage, with expansion from additional teams, channels, workflow volume, and governance features.

Current pricing and paid validation: **[FOUNDER INPUT REQUIRED]**

## How big could this be?

Start bottom-up, not with a generic AI market number:

- initial customer profile: **[DEFINE PRECISELY]**;
- number of reachable businesses: **[SOURCE REQUIRED]**;
- expected annual contract value: **[VALIDATED RANGE REQUIRED]**;
- expansion per customer: **[REAL OR TESTABLE ASSUMPTION]**.

The long-term product can expand from one repeatable workflow into a permissioned AI workforce layer across departments. Do not use “AGI” as a substitute for a market calculation.

## Equity, legal entity, and funding

- Legal entity and jurisdiction: **[FOUNDER INPUT REQUIRED]**
- Incorporation date: **[FOUNDER INPUT REQUIRED]**
- Founders and exact equity percentages: **[FOUNDER INPUT REQUIRED]**
- Vesting terms: **[FOUNDER INPUT REQUIRED]**
- Employees/contractors with equity or options: **[FOUNDER INPUT REQUIRED]**
- Previous investment, grants, debt, or SAFEs: **[FOUNDER INPUT REQUIRED]**
- Current cash and monthly burn: **[FOUNDER INPUT REQUIRED]**
- Fundraising now: **[FOUNDER INPUT REQUIRED]**

## Founder achievements

For each founder, provide one or two specific, independently understandable achievements that are not simply “built Nemo.” Include numbers, difficulty, dates, and links when available.

**[FOUNDER INPUT REQUIRED]**

## Other accelerators or prior YC applications

**[FOUNDER INPUT REQUIRED: program, batch/date, funding/dilution, outcome, and progress since any rejection]**

## Other ideas considered

**[FOUNDER INPUT REQUIRED]**

Only include ideas the founders genuinely considered. Keep each to one sentence.

## Most successful non-computer system hack

**[FOUNDER INPUT REQUIRED: a true, specific story showing resourcefulness without illegal or unethical conduct]**

## What do you want YC to understand that is not obvious?

Draft:

Nemo is being built from Uzbekistan for businesses that operate through messaging-first workflows and are poorly served by English-first enterprise automation. Our near-term goal is not unconstrained autonomy: it is measurable work completed by supervised agent teams with local-language support, explicit permissions, traces, and human takeover. **[VERIFY FOUNDER LOCATION AND CUSTOMER EVIDENCE BEFORE USING]**
