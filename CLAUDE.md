# Nemo AI — project guide for Claude Code

**Read `./NEMO_AI_SPEC.md` first — it is the full source of truth (product + design + data + build order).**

Nemo AI is a **universal AI-agent SaaS platform** for businesses, by Ustudy IT. Stage 1 lets users create agents or swarms for any lawful, bounded task supported by connected knowledge, tools, channels, and permissions; sales and support are examples, not product limits. Stage 2 is AGI-oriented research and starts only after the Stage 1 reliability and safety gates in `NEMO_AI_SPEC.md`. UI is bilingual **Uzbek (default) + Russian**, theme is **premium dark**.

## Current state (already in repo)
- Stack: Vite + React 19 + TypeScript + Tailwind, `react-router-dom`, `lucide-react`, `clsx`.
- Design tokens already set in `tailwind.config.js` (bg `#0A0D1C`, violet `#8B7CF8`, `brand-gradient`…). **Keep and reuse them.**
- Custom i18n in `src/i18n/` — **use it for all strings** (do not add i18next).
- Existing: `src/pages` (Landing, Auth, Chat, History, Settings, Admin), `src/context/AuthContext`, `src/components/{ui,layout,chat}`, `src/hooks/useNemoOrchestrator.ts`, `src/data/{agents,mock}.ts` (mock data).

## IMPORTANT — direction change
The current build follows an early "on‑demand single chat" idea. The product is now the **constructor + onboarding model like mooonai** (decided with the client). Implement the screens/modules in `NEMO_AI_SPEC.md` §5–6. Reuse existing components and the dark theme; replace mock flows with the real structure.

The North Star is the **Universal Agent Platform** in `NEMO_AI_SPEC.md` §1.1. New authoring, runtime, tool, memory, routing, eval, and observability work must stay domain-neutral. Do not hardcode a fixed list of departments into the core platform. Do not implement or market Stage 2 as true AGI during Stage 1.

## What to build (gap), in priority order
1. **App shell**: sidebar + topbar nav, routes per `NEMO_AI_SPEC.md` §5 (`/app/...`).
2. **Onboarding wizard** (4 steps) — §6.2.
3. **Agents list** + **Agent editor** (tabs: General, Prompt, Knowledge, LLM model, Lead forms, Channels, Test) — §6.4–6.5.
4. **Dialogues / Chat Manager** (list + conversation + customer panel, operator takeover, realtime) — §6.6.
5. **Integrations** (channels + CRM/ERP) — §6.7.
6. **Knowledge base, Lead forms, Templates gallery** — §6.8–6.10.
7. **Analytics, Billing, Settings/Team** — §6.11–6.13.
8. **Backend**: add **Supabase** (auth, Postgres per §7, Edge Functions for agent/LLM logic per §8). **Never put API keys in the frontend.**

## Conventions
- TypeScript strict; reusable UI in `src/components/ui`; one component per file.
- Every screen needs **empty + loading + error** states (skeletons, not bare spinners).
- Follow the design system in `NEMO_AI_SPEC.md` §3; avoid the anti‑patterns listed there.
- Responsive (sidebar + right panels collapse on mobile).
- Keep everything bilingual UZ/RU via `src/i18n`.

## Beta scope
Milestones 1–4 above + basic analytics (see `NEMO_AI_SPEC.md` §11).

## Suggested first command for Claude Code
> "Read NEMO_AI_SPEC.md and CLAUDE.md, then implement milestone 1 (app shell + routes + sidebar/topbar) and milestone 2 (onboarding wizard), reusing the existing Tailwind tokens and i18n. Show me a plan before coding."

## gstack (REQUIRED — global install)

**Before doing ANY work, verify gstack is installed:**

```bash
test -d ~/.claude/skills/gstack/bin && echo "GSTACK_OK" || echo "GSTACK_MISSING"
```

If GSTACK_MISSING: STOP. Do not proceed. Tell the user:

> gstack is required for all AI-assisted work in this repo.
> Install it:
> ```bash
> git clone --depth 1 https://github.com/garrytan/gstack.git ~/.claude/skills/gstack
> cd ~/.claude/skills/gstack && ./setup --team
> ```
> Then restart your AI coding tool.

Do not skip skills, ignore gstack errors, or work around missing gstack.

Using gstack skills: After install, skills like /qa, /ship, /review, /investigate,
and /browse are available. Use /browse for all web browsing.
Use ~/.claude/skills/gstack/... for gstack file paths (the global path).

## Claude + Codex development team (REQUIRED)

Start coordinated work through `agent-hub/start-team.ps1`. Claude is the team lead and implementation owner. Codex is the independent architect/reviewer exposed by the `codex-reviewer` MCP server.

- Keep at most three Claude teammates active. Recruit only when parallel work is genuinely independent.
- Every created team task must contain the exact fields `RECRUIT_REQUEST`, `ROLE`, `TASK`, `OWNED_PATHS`, `REASON`, and `DONE_WHEN`.
- A file may be edited by only one Claude session at a time. The project hook enforces session-level file ownership.
- Use Codex with `sandbox: read-only` for architecture and review. Do not ask Codex to edit while Claude teammates are editing.
- Reuse the feature's Codex `threadId` through `codex-reply`; store thread mappings in `agent-hub/state/codex-threads.json`.
- Auth, RLS, migrations, billing, secrets, agent routing, external integrations, and deploy require Claude + Codex discussion before implementation and a second review after the diff exists.
- Never configure a reverse Claude MCP call from Codex. The allowed direction is Claude -> Codex only.
- Before completion run `npm run quality`. Use the live agent eval only when external API usage is intended.
