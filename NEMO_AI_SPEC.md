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

---

## 9. Definition of Done
- **Hierarchy:** User can create a Master agent with at least 2 sub-agents.
- **Routing:** A message to the Master is successfully delegated to a specialist.
- **Traceability:** We can see exactly which sub-agents were called in the backend.
- **Premium Feel:** The graph editor and chat manager feel like a pro tool, not a toy.
