# Design QA — Dynamic Desk-Agent Virtual Office

## Evidence

- Source visual truth: `C:/Users/firda/Downloads/Characters_working_in_tech_office_202608251751.jpeg`
- Source pixels: `2752 × 1536`
- Active implementation: `C:/Users/firda/nemo-ai/docs/archive/design-qa/virtual-office-desk-working-final-2.png`
- Completed implementation: `C:/Users/firda/nemo-ai/docs/archive/design-qa/virtual-office-desk-complete-final-3.png`
- Mobile Canvas: `C:/Users/firda/nemo-ai/docs/archive/design-qa/virtual-office-desk-mobile-canvas-final.png`
- Side-by-side comparison: `C:/Users/firda/nemo-ai/docs/archive/design-qa/virtual-office-desk-comparison-final.jpg`
- Desktop viewport: `1280 × 720` CSS px, density `1`; implementation capture `1238 × 714` px after the in-app browser panel crop.
- Mobile viewport: `390 × 844` CSS px, density `1`; implementation capture `380 × 822` px after the in-app browser panel crop.
- State: coordinator receives a video + copy + estimate brief, spawns three role-specific desks, runs them in parallel, then returns PDF/MP4 artifacts and waits for approval.

The source and implementation were normalized into one `1600 × 700` comparison image with contain-fit scaling. The source is an art-direction reference rather than a literal application frame: comparison therefore focused on the isometric office, workstation characters, neon palette, spatial hierarchy, and activity states.

## Full-view comparison

The implementation preserves the supplied isometric neon-office language and uses real provided diorama assets for every desk. The product frame intentionally adds the requested split-screen chat, four-item navigation, telemetry, safe status bubbles, and artifact output. The office remains the dominant visual region and no longer uses primitive circles or emoji avatars.

## Focused region comparison

Focused checks were made on the Canvas region at active, completed, and mobile states. Workstation silhouettes, seated characters, monitor glow, labels, status bubbles, and the generated-artifact handoff remained readable. Image masks show no checkerboard background; minor soft antialiasing around one generated workstation is acceptable at rendered scale.

## Required fidelity surfaces

- Fonts and typography: existing Nemo UI system font stack is preserved; labels and chat hierarchy remain legible at desktop/mobile sizes. Long operational statuses are bounded and never expose model reasoning.
- Spacing and layout rhythm: fixed `720px` desktop split-screen prevents chat growth from stretching the Canvas; mobile stacks chat and office without horizontal overflow (`380px` document width inside a `390px` viewport).
- Colors and visual tokens: cyan/emerald/amber operational states match the supplied neon art and remain distinguishable on the dark office background.
- Image quality and asset fidelity: supplied real office/character artwork is used. No CSS-drawn characters, placeholder circles, handcrafted SVG people, or emoji assets remain in the Canvas.
- Copy and content: navigation is limited to Office, Artifacts, Activity & Telemetry, and Settings. Chat and speech bubbles contain only high-level operational statuses.
- Accessibility and behavior: Canvas has an accessible label; visible controls use semantic buttons; reduced-motion is respected; the animation owns one managed `requestAnimationFrame` loop with cleanup and capped delta/device density.

## Comparison history

1. **P2 — oversized desks and clipped labels at Canvas edges.** The first desktop capture showed workstations extending beyond the visible cover-cropped world. Fixed by reducing desk scale and moving all seven slots into the visible center band. Post-fix evidence: `virtual-office-desk-idle-fixed.png`.
2. **P2 — mobile bubbles and technical badge clipped.** The first mobile Canvas capture showed a partially clipped coordinator bubble and an empty secondary badge. Fixed by narrowing bubbles, pulling columns inward, and hiding the secondary technical badge below `sm`. Post-fix evidence: `virtual-office-desk-mobile-canvas-final.png`.
3. **P2 — simultaneous active bubbles overlapped each other and telemetry.** Fixed by staggering bubble anchors per desk column. Post-fix evidence: `virtual-office-desk-working-final-2.png`.
4. **P1 — completed chat content stretched the grid and produced an unstable oversized Canvas.** Fixed by constraining the desktop split-screen row to `720px` and keeping chat scrolling internal. Post-fix evidence: `virtual-office-desk-complete-final-3.png`.

## Interaction and runtime checks

- Brief submission spawned Copywriter, Media, and Finance workstations.
- Active state showed working monitor glow and role-specific safe status bubbles.
- Completed state returned `campaign-script.pdf`, `service-estimate.pdf`, and `promo-cut.mp4` in chat.
- Add/remove workstation controls were exercised.
- Sidebar exposes exactly the four requested destinations.
- Browser console: no application errors. Only expected Vite development messages and the explicit demo-mode placeholder warning were present.
- Canvas measured `60 FPS` at the `1280 × 720` desktop viewport through the render-loop QA counter.
- TypeScript, capability contracts, security contracts, UI smoke, UI stability, demo build, and secret scan passed.

## Findings

No actionable P0/P1/P2 findings remain.

## Follow-up polish

- P3: add per-role soundless micro-gestures when dedicated multi-frame character assets become available; the current breathing, monitor glow, completion bounce, and full-body result pose intentionally avoid fake frame-by-frame animation.

final result: passed
