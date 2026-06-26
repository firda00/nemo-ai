# Nemo AI — Build Specification (for Claude Code)

> Implementation spec for an AI‑agent SaaS platform (a Moon AI / mooonai.com equivalent), branded **Nemo AI**, by Ustudy IT.
> Audience: Claude Code. Goal: build the product correctly from this single source of truth.
> UI must be bilingual: **Uzbek (default) + Russian** toggle. Design: **premium dark SaaS** (tokens below).

---

## 0. How to use this file
- Treat this as the product + design spec. Implement screen by screen, in the **Build order** (section 11).
- Keep all colors/spacing/typography as defined in **Design system** (section 3). Do not invent new colors.
- After each milestone, run the app and verify against **Acceptance criteria** per feature.
- Never put API keys in the frontend. All LLM/channel calls go through the backend (Supabase Edge Functions).

---

## 1. Product overview
Nemo AI lets a business **create AI agents** and connect them to its channels (Telegram, WhatsApp, Instagram, website widget) to automate **sales and customer support**. Users build an agent through an onboarding wizard (no coding), configure a prompt + knowledge base, connect channels, then the agent handles conversations 24/7. Operators can take over dialogues. Owners see analytics and pay via subscription + AI tokens.

**Model decision:** constructor + onboarding (user creates/configures the agent), exactly like mooonai.

---

## 2. Moon AI feature analysis → what we must implement
Every Moon AI capability mapped to our build:

| Moon AI feature | Our implementation |
|---|---|
| No‑code AI agent creation | Onboarding wizard + Agent editor |
| Onboarding (create → prompt → channels → test) | 4‑step wizard `/onboarding?step=1..4` |
| Ready‑made scenarios/templates by industry | Templates gallery (sales mgr, qualifier, support, consultant, admin) |
| Multi‑channel (Telegram, WhatsApp, Instagram, site widget) | Channels module + per‑channel connect flows + embeddable widget |
| CRM/ERP integrations (AmoCRM, Bitrix24, Google) | Integrations module (OAuth/webhooks) |
| Dialogue Manager (view, analyze, operator takeover, bulk, error tracking) | Dialogues (Chat Manager) module |
| Knowledge base (train on your data) | Knowledge base module (files/FAQ/links + RAG) |
| LLM model selection | Model picker per agent |
| Lead forms | Lead form builder + lead storage/export |
| Follow‑up messages | Scheduled re‑engagement jobs |
| Images & voice understanding | Multimodal message handling |
| Multilingual | i18n UZ/RU; agent replies in client language |
| Analytics (dialogues, response time, resolution %, satisfaction) | Analytics dashboard |
| Pricing: subscription + AI tokens, calculator | Billing module + token metering + calculator |
| Auth, team/operators | Auth + team roles |
| Marketing landing | Public landing (already designed — see `Nemo_AI_Landing.html`) |

---

## 3. Design system (MANDATORY — do not deviate)

### Colors (CSS variables / Tailwind theme)
```
--bg:      #0A0D1C   /* page background (NOT pure black) */
--panel:   #10162E   /* panels, sidebar */
--card:    rgba(255,255,255,.045)   /* glass cards */
--border:  rgba(255,255,255,.09)
--text:    #EAECF6
--muted:   #98A2BC
--violet:  #8B7CF8   /* gradient start */
--blue:    #5B7CF6   /* gradient mid */
--cyan:    #22D3EE   /* gradient end / accent */
--teal:    #13C5B4   /* success */
--amber:   #F59F00   /* warning / status */
--danger:  #F2545B
--gradient: linear-gradient(135deg,#8B7CF8 0%,#5B7CF6 45%,#22D3EE 100%);
```

### Typography
- Font: **Inter** (Google Fonts). Headings bold, tight tracking (−0.5…−1.5px).
- H1 56–72/900 · H2 32–42/800 · H3 20–24/700 · body 15–16/400–500 · caption 12–13/600 (uppercase labels with 2px tracking).

### Spacing / shape
- Container max‑width 1180 (marketing) / fluid with 240px sidebar (app). Spacing scale: 4,8,12,16,24,32,48,64,80.
- Radius: buttons 12, cards 16–20, avatars/pills 99. Soft dark shadows. Subtle glow blobs behind hero only.

### Core components (build as reusable)
`Button` (primary=gradient+shadow, ghost=glass border), `Card` (glass), `Input`/`Textarea` (glass, violet focus ring), `Badge`/`StatusPill` (waiting=grey, working=amber, done=teal, error=danger), `Avatar` (round, role color), `ChatBubble` (assistant left glass / user right gradient‑tint), `Tabs`, `Modal`, `Toast`, `Skeleton`, `Sidebar`, `Topbar`, `Stepper`, `EmptyState`, `Table`, `Chart`.

### Anti‑patterns (forbidden)
Pure black bg, generic blue, equal‑weight colors, tiny headings, no whitespace, system default font, flat cards without depth, inconsistent radius, missing empty/loading states, stretched/broken images.

---

## 4. Tech stack
- **Frontend:** React + Vite + TypeScript + Tailwind CSS. Routing: React Router. i18n: i18next (uz, ru). State: React Query + lightweight store (Zustand).
- **Backend:** Supabase (Postgres, Auth, Storage, Realtime, Edge Functions).
- **Agent/LLM logic:** Supabase Edge Functions (or a separate Node/Python service). Model‑agnostic (OpenAI/Anthropic + open models). RAG over knowledge base.
- **Channels:** webhooks (Telegram Bot API, WhatsApp Cloud API, Instagram Graph), website widget = embeddable `<script>` chat.
- **Realtime:** Supabase Realtime / WebSocket for live dialogues + streaming agent replies.
- **Hosting:** Vercel/Netlify (frontend) + Supabase. Keep secrets server‑side.

---

## 5. Information architecture (routes)
```
/                      landing (public)
/auth/signin /auth/signup /auth/reset
/onboarding?step=1..4  first‑run agent wizard
/app                   dashboard (overview)
/app/agents            agents list
/app/agents/:id        agent editor (tabs)
/app/dialogues         chat manager
/app/dialogues/:id     conversation view
/app/integrations      channels + CRM/ERP
/app/knowledge         knowledge base
/app/lead-forms        lead form builder
/app/templates         scenario templates gallery
/app/analytics         analytics
/app/billing           subscription + tokens
/app/settings          profile, language, team
```
App layout: left **Sidebar** (nav) + **Topbar** (account, language, balance). Dark theme everywhere.

---

## 6. Screens & features (with acceptance criteria)

### 6.1 Auth
Email+password and Google OAuth (Supabase Auth). Invite‑code / waitlist for beta. Password reset.
**AC:** user can sign up, log in, log out; protected routes redirect to signin; new users land on `/onboarding`.

### 6.2 Onboarding wizard (4 steps)
Stepper at top (1–2–3–4). Optional template gallery first.
- **Step 1 — Create agent:** name, avatar (opt), timezone, schedule (24/7 or hours), default language.
- **Step 2 — Prompt:** role/tasks/tone/rules; prompt templates & hints; optional knowledge upload.
- **Step 3 — Channels:** pick + connect Telegram / WhatsApp / Instagram / website widget (QR/token/OAuth).
- **Step 4 — Test & launch:** built‑in playground chat; "Launch" button.
**AC:** progress persists; back/next works; validation; on finish, agent is created and active; redirect to dashboard.

### 6.3 Dashboard
Metric cards (dialogues today, leads, % auto‑answered, avg response time), recent dialogues, agent status, quick actions (Create agent, Top up).
**AC:** metrics load from backend (with skeletons); empty state when no data.

### 6.4 Agents list
Cards/table: name, status (on/off), channels, model, last activity. Actions: create, edit, duplicate, enable/disable, delete.
**AC:** toggle updates status; delete confirms.

### 6.5 Agent editor (key screen)
Left tabs, main editing area, persistent Save + "Test in chat".
Tabs: **General** (name, avatar, timezone, schedule, language) · **Prompt** (role, tasks, tone, rules, templates, variables) · **Knowledge base** (files/FAQ/links + indexing status) · **LLM model** (model, temperature, limits) · **Lead forms** (fields, trigger, destination) · **Channels** (connect) · **Test** (playground).
**AC:** changes save; test chat calls the backend agent; unsaved‑changes guard.

### 6.6 Dialogues — Chat Manager
3 columns: dialogue list (search + filter by channel/status/date/agent) · conversation view (full message history with context) · customer panel (name, phone, channel, CRM card, tags).
Features: **operator takeover** (pause agent, reply manually, hand back), bulk actions, error flags, quality review.
**AC:** realtime updates; takeover toggles who responds; search works; messages persist with context.

### 6.7 Integrations
Channel cards (Telegram, WhatsApp, Instagram, website widget) + CRM/ERP cards (AmoCRM, Bitrix24, Google). Each: status, connect wizard, test connection, disconnect.
**AC:** connecting a channel routes its inbound messages to the agent; webhook verified.

### 6.8 Knowledge base
Sources: files (PDF/DOCX/TXT), FAQ pairs, links. Global + per‑agent. Indexing status; update/delete; preview retrieved chunks.
**AC:** uploaded docs get indexed; agent answers use them (RAG).

### 6.9 Lead forms
Field builder (name, phone, service, custom). Show conditions. Destination: CRM or table/export.
**AC:** captured leads stored and visible; optional CRM push.

### 6.10 Templates / scenarios
Gallery of ready agents by industry; preview dialogue; "Use template" prefills the agent.
**AC:** selecting a template creates a pre‑configured agent.

### 6.11 Analytics
Metrics: dialogue count, avg response time, % resolved without operator, lead conversion, satisfaction. Time‑series charts, breakdown by channel/agent, funnel, export.
**AC:** charts render real aggregates; date range filter.

### 6.12 Billing
Subscription (e.g. $50/mo) + AI tokens (separate, by dialogs × model). Token balance, top‑up, usage history, pricing calculator (slider by monthly dialogs), invoices.
**AC:** calculator updates live; balance decremented on usage (stub provider in beta).

### 6.13 Settings
Profile, interface language (UZ/RU), notifications, team (invite operators, roles/permissions).
**AC:** language switch updates whole UI instantly; invited operator gets scoped access.

---

## 7. Data model (Supabase / Postgres)
```
accounts(id, name, plan, token_balance, created_at)
users(id, account_id, email, role, language, created_at)
agents(id, account_id, name, avatar, prompt, model, temperature,
       timezone, schedule, default_lang, status, created_at)
channels(id, agent_id, type, credentials_json, status)
integrations(id, account_id, type, settings_json, status)
dialogues(id, agent_id, channel, customer_name, customer_contact,
          status, tags, operator_id, created_at, updated_at)
messages(id, dialogue_id, author /* customer|agent|operator */,
         content, media_url, created_at)
leads(id, dialogue_id, fields_json, status, pushed_to_crm)
knowledge_docs(id, owner_type /* account|agent */, owner_id,
               source, status, created_at)
templates(id, industry, name, prompt_preset, config_json)
usage(id, account_id, tokens, cost, model, created_at)
```
Add Row‑Level Security: users only access their `account_id` rows. Operators scoped to assigned dialogues.

---

## 8. Agent runtime (backend)
1. Inbound message (channel webhook) → resolve agent + dialogue → store message.
2. Build context: system prompt + agent config + retrieved knowledge (RAG) + recent history.
3. Call LLM (selected model) with streaming.
4. Persist reply, send back to channel, update analytics + token usage.
5. If operator took over → skip agent, deliver operator message.
**Functions:** `onInboundMessage`, `runAgent`, `ragSearch`, `sendToChannel`, `meterUsage`. Keep keys server‑side.

---

## 9. i18n (UZ/RU)
- All UI strings in `locales/uz.json` + `locales/ru.json`; Uzbek is default, RU toggle in topbar.
- Agent detects and replies in the customer's language.
- No hardcoded strings in components.

---

## 10. Non‑functional
Realtime (<2–3s first token via streaming), security (RLS, server‑side secrets, webhook verification, rate limits), privacy (encrypt sensitive data; plan local data residency), observability (logs, error flags, token spend), responsive (sidebar collapses, right panel collapses on mobile).

---

## 11. Build order (milestones)
1. **Foundation:** Vite+TS+Tailwind, theme tokens, base components, i18n, Supabase auth, app shell (sidebar/topbar), routing.
2. **Agents + Onboarding:** agents table, onboarding wizard, agent editor (General+Prompt+Test with a real LLM edge function).
3. **Dialogues:** Telegram channel webhook + website widget, Chat Manager with realtime + operator takeover.
4. **Knowledge base + Models + Lead forms.**
5. **Integrations (WhatsApp/Instagram/CRM) + Templates gallery.**
6. **Analytics + Billing + Settings/Team.**
7. **Polish:** empty/loading/error states, responsive, QA against design system.

Beta target = milestones 1–3 (+basic analytics).

---

## 12. Definition of done (global)
- Matches design tokens (dark premium), no anti‑patterns.
- Bilingual UZ/RU everywhere.
- Every screen has empty + loading + error states.
- Agent actually responds via backend (no keys in frontend).
- Responsive on desktop + mobile.
```
Run: npm create vite@latest, add Tailwind + the tokens above, then implement milestones in order.
```
