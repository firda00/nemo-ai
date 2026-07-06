# Project Agent Skills

Skills installed for building **Nemo AI**. Claude Code (and any Agent-Skills-compatible tool)
auto-discovers each `<name>/SKILL.md` here and loads it on demand (progressive disclosure —
only names + descriptions load at startup; full body loads when a task activates it).

## Sources & licenses

| Set | Skills | Source | License |
|-----|--------|--------|---------|
| Context / harness engineering (15) | `context-fundamentals`, `context-degradation`, `context-compression`, `context-optimization`, `latent-briefing`, `multi-agent-patterns`, `memory-systems`, `tool-design`, `filesystem-context`, `hosted-agents`, `evaluation`, `advanced-evaluation`, `harness-engineering`, `project-development`, `bdi-mental-states` | [muratcankoylan/Agent-Skills-for-Context-Engineering](https://github.com/muratcankoylan/Agent-Skills-for-Context-Engineering) | MIT |
| Video rendering (1) | `remotion` (Remotion best-practices + ~40 topic rules) | [remotion-dev/skills](https://github.com/remotion-dev/skills) (Remotion monorepo, `packages/skills`) | Remotion license |

## Why these are here

- **Development**: they encode how to build a reliable agent runtime — tool contracts, multi-agent
  handoffs, memory/RAG, evaluation, autonomous harness loops — which is exactly Nemo's backend
  (`supabase/functions/_shared/*`).
- **Product**: the `remotion` skill is the domain knowledge for turning the Content Factory's
  generated scripts + images + voiceover into real rendered short videos (captions, subtitles,
  transitions, text animations). See the render-engine plan before wiring it into the product.

Update this table when adding or removing a skill.
