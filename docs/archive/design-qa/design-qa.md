# Design QA — Team detail overflow

- Source visual truth: `C:/Users/firda/AppData/Local/Temp/codex-clipboard-f5e9f4f6-2041-4152-9dfc-b8202ce0f695.png`
- Implementation screenshot: `C:/Users/firda/nemo-ai/design-qa-implementation.png`
- Target viewport: 1564 × 670 CSS px
- Screenshot dimensions: 1564 × 670 px
- Density normalization: 1 screenshot pixel per CSS pixel
- Target state: authenticated Team detail page, collapsed run row

## Evidence

- Full-view source inspection identified horizontal clipping in the two-column Team detail layout.
- Production DOM check after deployment: `documentElement.clientWidth = 1564`, `documentElement.scrollWidth = 1564`.
- No content element overflowed the right edge of the viewport. The two reported left-edge elements are the intentionally collapsed sidebar logo/link.
- Code-level checks cover the focused region: both grid tracks use `minmax(0, ...)`, children use `min-w-0`, long run text truncates, and expanded reports scroll internally.

## Comparison history

1. Source: right-side coordinator/run panels extend beyond the visible viewport; long run text has no bounded flex width.
2. Implementation: CSS containment and truncation were added and production reports no horizontal document overflow.
3. Visual state limitation: the available Chrome profile is authenticated as another user, so the referenced team ID renders “Команда не найдена”. The exact populated state could not be re-captured without changing account/session data.

## Findings

- P0: none.
- P1: none.
- P2: exact populated-state screenshot is blocked by account ownership; functional layout containment is verified in production.

## Final result

blocked
