# Nemo agent hub

This directory coordinates Claude Agent Teams with Codex as an independent MCP reviewer.

## Start

```powershell
cd "C:\Users\firda\nemo-ai"
powershell -ExecutionPolicy Bypass -File .\agent-hub\check-setup.ps1 -Deep
powershell -ExecutionPolicy Bypass -File .\agent-hub\start-team.ps1
```

The launcher uses Fable 5 by default, enables in-process Agent Teams on Windows, explicitly loads only the project MCP servers, and passes the workflow in `team-prompt.md` to Claude. Codex and Playwright start without a project-approval prompt; Supabase may still request OAuth the first time its read-only tools are used.

Codex review replies reuse one `threadId` for the lifetime of the MCP process. Because a server restart can invalidate that ID, the hub also stores a compact review summary and automatically opens a replacement thread with that context instead of losing the discussion or looping on a stale session.

## Quality gates

`npm run quality` runs TypeScript, ESLint, the production build, static agent capability contracts, and browser smoke tests. Add `-IncludeLiveAgentEval` to call the real configured model through the existing eval harness. Run `smoke-ops.ps1` only against an intentionally selected deployed environment.

## Safety model

- Claude owns implementation.
- Codex runs read-only architecture and review conversations.
- Supabase MCP is project-scoped and read-only.
- Production deploys and writes require the human user.
- Runtime thread IDs, browser artifacts, and file locks are not committed.
