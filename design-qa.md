# Teamly-style Isometric Virtual Office — Design QA

## Evidence

- Source visual truth: `C:/Users/firda/Downloads/Characters_working_in_tech_office_202608251751.jpeg` — 2752×1536 px.
- Idle browser implementation: `C:/Users/firda/nemo-ai/docs/archive/design-qa/virtual-office-isometric-fixed.png` — 1440×1000 px, 1440×1000 CSS viewport, deviceScaleFactor 1.
- Active workflow implementation: `C:/Users/firda/nemo-ai/docs/archive/design-qa/virtual-office-isometric-active.png` — 1430×993 px after submitting a media brief.
- Mobile implementation: `C:/Users/firda/nemo-ai/docs/archive/design-qa/virtual-office-isometric-mobile.png` — 380×822 px in a 390×844 CSS viewport, deviceScaleFactor 1.
- Combined comparison input: `C:/Users/firda/nemo-ai/docs/archive/design-qa/virtual-office-isometric-comparison.jpg` — 2400×878 px. Source and implementation were cover-normalized into equal 1200×820 panels and viewed together.
- State: `/app/office` in local demo mode; browser checks covered idle, executing, waiting-for-approval, add-agent, remove-agent, desktop, and mobile states. Dashboard values remain unavailable (`—`) instead of being fabricated.

## Findings

- No remaining P0/P1/P2 findings.
- Fonts and typography: the Nemo UI hierarchy stays consistent across chat, toolbar, telemetry, agent labels, and journal. Russian action copy wraps cleanly and no chain-of-thought text is exposed.
- Spacing and layout rhythm: desktop keeps the requested 42/58 split between team chat and canvas, with the office as the dominant surface. Mobile intentionally stacks both regions without control collisions.
- Colors and visual tokens: the white shell and chat balance the dark cyan/violet office artwork. Emerald denotes online/approved state; amber denotes HITL; canvas labels retain sufficient contrast.
- Image quality and asset fidelity: the supplied Nemo isometric office is used directly. Agent portraits are clean transparent raster assets derived from the supplied specialist artwork, without checkerboard remnants, stretching, or placeholder shapes.
- Copy and content: visible statuses are limited to safe operational labels such as `Анализ брифа`, `Расчёт сметы`, `Рендер видео`, and `Ожидает согласования`. Internal reasoning, prompts, secrets, and tenant payloads are absent.
- Icons and interactions: Lucide controls match the host app. Brief submission, Refocus, Status update, Add Agent, remove desk, refresh, and HITL actions use semantic buttons and accessible labels.
- Motion and accessibility: the Canvas uses one managed `requestAnimationFrame` loop, delta-capped interpolation, depth sorting, ResizeObserver, and explicit cleanup. `prefers-reduced-motion` stops travel while preserving state.

## Full-view Comparison Evidence

The combined source/implementation image confirms the same room, city-office composition, cyan/purple lighting, central coordination table, workstations, and lounge area. The product view intentionally adds the requested 42/58 chat-and-canvas command center, agent nodes, safe telemetry, and staffing controls.

## Focused Region Comparison Evidence

Focused inspection covered agent portrait masks, canvas labels, telemetry, the composer, and the mobile stack. The source art remains sharp and correctly cropped; portraits have clean transparent edges; labels stay legible; mobile chat cards and hints wrap without overlap. A separate focused crop was unnecessary because these regions are readable in the desktop and mobile captures.

## Comparison History

1. Initial isometric pass — blocked:
   - [P2] Character crops retained checkerboard backgrounds.
   - [P2] Finance and right-side agents sat too close to the canvas crop boundary.
2. Visual fixes:
   - Converted character crops to true transparent PNGs.
   - Moved destinations into a safe-center grid and used a uniform cover transform.
3. Interaction pass — blocked:
   - [P1] Clicking Add Agent exposed an invalid React effect cleanup and temporarily blanked the screen.
4. Interaction fix:
   - Corrected the chat auto-scroll effect so it returns no value; verified add/remove and hot-reload without a crash.
5. Post-fix evidence:
   - `virtual-office-isometric-fixed.png` shows the full idle composition with clean portraits.
   - `virtual-office-isometric-active.png` shows the submitted media brief, safe journal events, and active state.
   - `virtual-office-isometric-mobile.png` confirms the stacked narrow-screen layout.
   - Browser logs after the fix contain no runtime errors; only the expected demo-mode Supabase warning remains. Earlier errors remain in browser history as evidence of the resolved iteration.

## Primary Interactions Tested

- Submitted `Создай промо-видео и смету для запуска новой услуги`; verified `Рендер видео`, then `Ожидает согласования`.
- Verified that chat and journal report only safe operational stages.
- Removed the fifth workstation and confirmed `4 агента`, then added it back and confirmed `5 агентов`.
- Verified localStorage persistence for team size.
- Verified desktop at 1440×1000 and mobile at 390×844.
- Exercised route reload/HMR after the cleanup fix without a new runtime error.

## Implementation Checklist

- [x] Split-screen Team Chat / Isometric Canvas layout.
- [x] Agent nodes with idle, walking, working, and waiting-approval behavior.
- [x] Linear path interpolation, speech bubbles, depth sorting, and managed rAF cleanup.
- [x] 3-second authenticated dashboard polling with safe unavailable states.
- [x] Runtime brief submission through the existing orchestrator; deterministic demo simulation only when Supabase is disabled.
- [x] Add/remove workstations with local preference persistence.
- [x] Desktop/mobile browser QA, TypeScript, contracts, UI smoke, and UI-stability gates.

## Follow-up Polish

- [P3] The dashboard metrics contract does not yet emit optional `active_workflow_state`, `active_compute_profile`, and `active_workflow_id`. The client validates them and falls back safely; exposing them server-side will let production agents mirror every compute profile without the demo transition path.

final result: passed
