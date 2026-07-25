# Nemo AI — Build Specification (Multi-Agent Ecosystem)

> Implementation spec for a high-end **Multi-Agent Orchestration Platform**, branded **Nemo AI**, by Ustudy IT.
> Goal: Move beyond simple chatbots to a system of interconnected AI agents (Master $\rightarrow$ Sub-agents).
> UI: Bilingual **Uzbek (default) + Russian**. Design: **Premium Dark SaaS**.

---

## 0. Core Philosophy
Nemo AI is not a bot builder; it is an **AI workforce architect**. 
Instead of one giant prompt, users build a **swarm of specialists**. 
- **Master Agent (The Brain):** Handles the initial request, analyzes intent, and delegates tasks.
- **Sub-Agents (The Specialists):** Experts in specific domains (e.g., "Billing Expert", "Technical Support", "Sales Closer").
- **Collaboration:** Agents can pass context to each other, verify each other's work, and collaborate to solve complex user queries.

---

## 1. Product Overview
Nemo AI allows businesses to deploy an autonomous AI organization. 
1. **Architect Stage:** User defines a hierarchy (Who is the boss? Who are the specialists?).
2. **Specialization Stage:** Each agent gets its own prompt, knowledge base, and tools.
3. **Deployment:** The swarm is connected to channels (Telegram, WhatsApp, etc.).
4. **Orchestration:** When a user writes "I want to change my plan and get a refund", the Master Agent identifies two tasks $\rightarrow$ delegates to "Billing Agent" $\rightarrow$ receives confirmation $\rightarrow$ replies to the user.

### 1.1 Product North Star and stages

#### Stage 1 — Universal Agent Platform

The primary product goal is a domain-neutral constructor where a user can describe a bounded task in natural language and create either one agent or a coordinated swarm to perform it. Sales and support are examples, not hardcoded product limits.

Every created agent must be configurable with:
- goal, role, instructions, tone, constraints, and success criteria;
- knowledge sources and durable/shared memory;
- tools, HTTP APIs, MCP integrations, and communication channels;
- triggers, schedules, routing rules, and human approval checkpoints;
- test cases, eval thresholds, version history, observability, and rollback.

"Any task" means any lawful task that can be completed through explicitly connected data and tools within granted permissions. Nemo must not claim or attempt capabilities for which no tool, data, permission, or reliable verification path exists.

**Stage 1 exit criteria:** a user can go from a plain-language task description to a tested and published agent without code; advanced users can add custom tools; the agent can be monitored, paused, revised, rolled back, and escalated to a human; critical actions never execute without the configured approval policy.

#### Stage 2 — AGI-oriented research

Stage 2 begins only after Stage 1 reliability and safety gates are met. It explores cross-domain planning, dynamic specialist creation, long-horizon memory, self-evaluation, adaptive workflows, and constrained self-improvement. It remains human-governed and evaluation-driven. Nemo must not market or label the system as true AGI unless that claim is supported by independently validated capabilities and safety evidence.

---

## 2. Multi-Agent Feature Set

| Feature | Implementation |
|---|---|
| **Agent Hierarchy** | Visual graph editor to link Master and Sub-agents. |
| **Dynamic Routing** | Orchestrator logic to decide which sub-agent to invoke. |
| **Shared Context** | A "global session memory" that all agents in a swarm can access. |
| **Hand-off Protocol** | Smooth transition of a conversation from Agent A $\rightarrow$ Agent B. |
| **Specialist Tools** | Different agents can have different tools (one can search PDF, another can call an API). |
| **Verification Loop** | "Reviewer" agents that check the output of "Worker" agents before the user sees it. |
| **Human-in-the-loop** | Operators can jump into any point of the agent-to-agent chain. |

---

## 3. Design System (MANDATORY)
*(Preserved from original spec to maintain premium dark aesthetic)*
- **Colors:** `--bg: #0A0D1C`, `--panel: #10162E`, `--violet: #8B7CF8`, `--cyan: #22D3EE`.
- **Visuals:** Glassmorphism cards, gradient borders, Inter font, high-contrast typography.
- **New Component:** `AgentGraph` — An interactive node-based map showing agent connections.

---

## 4. Tech Stack
- **Frontend:** React 19 + Vite + TS + Tailwind + Zustand (for complex agent state).
- **Backend:** Supabase (Postgres + Auth + Edge Functions).
- **Orchestration Engine:** Custom logic in Supabase Edge Functions using LangChain or similar autonomous agent patterns.
- **Memory:** Vector database (pgvector in Supabase) for shared RAG across the swarm.

---

## 5. Information Architecture (Routes)
```
/                      Landing
/auth                   Auth Flow
/app                    Dashboard (Swarm Overview)
/app/swarms             List of Agent Swarms
/app/swarms/:id        Swarm Architect (Visual Graph Editor)
/app/agents             Global Agent Library
/app/agents/:id        Agent Specialist Editor (Prompt, Knowledge, Tools)
/app/dialogues         Global Chat Manager (Multi-agent traces)
/app/dialogues/:id     Conversation View (with "Agent Trace" sidebar)
/app/knowledge         Shared & Specific Knowledge Bases
/app/analytics         Swarm Efficiency & Performance Metrics
/app/settings           Profile & Team
```

---

## 6. Detailed Multi-Agent Features

### 6.1 The Swarm Architect (The Core)
A node-based editor where users:
- Create a **Master Agent**.
- Create **Sub-Agents** and drag arrows to connect them to the Master.
- Define "Trigger Conditions" (e.g., "If user mentions 'Price' $\rightarrow$ route to Billing Agent").
- **AC:** User can visually build a tree; connections are saved as parent-child relationships in DB.

### 6.2 Agent Specialist Editor
Each agent in the swarm has:
- **Identity:** Name, Role, Tone.
- **Capability:** Specific tools (API access, PDF search) it is allowed to use.
- **Scope:** What it is *not* allowed to do (Guardrails).
- **AC:** Changes are atomic; "Test in Chat" simulates the agent as part of a swarm.

### 6.3 The Orchestration Engine (Backend)
1. **Input:** User message arrives.
2. **Analysis:** Master Agent determines the intent.
3. **Delegation:** Master Agent calls the appropriate Sub-Agent(s).
4. **Synthesis:** Master Agent collects results and formats the final response.
5. **Trace:** The system logs exactly which agents were involved (Agent A $\rightarrow$ Agent B $\rightarrow$ Agent A).

### 6.4 Multi-Agent Dialogue Manager
A view where operators see:
- The final message sent to the client.
- **The "Thought Trace":** A hidden log of how agents collaborated behind the scenes.
- **Takeover:** Ability to pause the entire swarm and reply manually.

---

## 7. Data Model (Updated for MAS)
```sql
accounts(id, name, plan, token_balance)
users(id, account_id, email, role)

swarms(id, account_id, name, description, created_at)

agents(
  id, 
  swarm_id, 
  parent_id, -- Self-reference for hierarchy
  name, 
  role, -- 'Master', 'Specialist', 'Reviewer'
  prompt, 
  model, 
  status,
  created_at
)

agent_tools(id, agent_id, tool_type, config_json)
knowledge_docs(id, agent_id, content, embedding)

dialogues(id, swarm_id, customer_info, status)
messages(id, dialogue_id, agent_id, author, content, type /* user|agent|system_trace */)
```

---

## 8. Build Order (New Milestones)

### Milestone 1: The Foundation & Swarm Shell
- Setup Supabase + Auth.
- Implement the new Sidebar/Topbar for "Swarms" and "Agents".
- Build the `Swarm` list and basic `Agent` list.

### Milestone 2: The Architect (Visual Graph)
- Implement the Visual Node Editor (React Flow or similar) to create agent hierarchies.
- Save `parent_id` relationships to Supabase.

### Milestone 3: The Orchestration Engine (The Brain)
- Build the Edge Function that implements the Master $\rightarrow$ Sub-agent routing logic.
- Implement "Context Passing" between agents.
- Connect to one channel (Telegram) to test the swarm.

### Milestone 4: Specialist Tooling & RAG
- Implement per-agent Knowledge Bases (RAG).
- Add the ability to assign specific tools to specific agents.

### Milestone 5: The Trace & Analytics
- Build the Dialogue Manager with the "Agent Trace" view.
- Implement metrics for swarm efficiency (how many hops to a solution).

### Milestone 6: Universal Agent Factory
- Generate a draft agent or swarm from a plain-language task description.
- Keep the generated configuration domain-neutral: no department-specific behavior in the core runtime.
- Let users attach knowledge, memory, tools, channels, triggers, schedules, approvals, and success criteria.
- Generate an initial eval suite and require a passing sandbox run before publishing.
- Support reusable templates without making templates mandatory.

### Milestone 7: Reliability and Safe Autonomy
- Add per-tool timeouts, bounded retries, circuit breakers, idempotency, and fallbacks.
- Add confidence-based human handoff and approval gates for critical actions.
- Add versioning, rollback, audit history, cost/latency/error budgets, and automatic pause rules.
- Validate agents in shadow mode before progressively enabling autonomous actions.

### Stage 2: AGI-oriented research
- Explore long-horizon planning, dynamic specialist recruitment, cross-domain memory, self-evaluation, and constrained adaptation.
- Add governed code improvement teams: one builder proposes an isolated branch/patch, an independent reviewer inspects the diff, and a QA/security agent runs required tests. No agent may edit production directly; merge and deployment require policy approval, audit evidence, canary rollout, and automatic rollback on failed health checks.
- Let agents improve each other's prompts, skills and evaluations from measured outcomes first. Code changes remain a separate higher-risk workflow and cannot grant new tools, permissions, billing access or secrets to the agents that proposed them.
- Keep production actions permission-bound, auditable, reversible where possible, and subject to human governance.

---

## 9. Definition of Done
- **Universal creation:** A user can describe a new bounded task, generate an agent or swarm, attach the required knowledge/tools, and edit every generated setting.
- **Verification before publish:** The system generates and runs task-specific evals; failed critical cases block publishing.
- **Safe operation:** Permissions, approvals, timeouts, bounded retries, human handoff, audit logs, pause, versioning, and rollback are enforced.
- **Domain neutrality:** Core authoring and runtime paths do not depend on a fixed list of departments or agent templates.
- **Hierarchy:** User can create a Master agent with at least 2 sub-agents.
- **Routing:** A message to the Master is successfully delegated to a specialist.
- **Traceability:** We can see exactly which sub-agents were called in the backend.
- **Premium Feel:** The graph editor and chat manager feel like a pro tool, not a toy.
