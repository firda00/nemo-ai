# Nemo Directory — design QA

Source references:

- Claude Directory navigation with Skills, Connectors, and Plugins.
- Connector grid with add controls.
- Connector detail view with capabilities, authorization, and setup fields.

Verified implementation:

- Route: `/app/tools`, Directory modal.
- Desktop viewport: two-column connector grid, persistent left navigation, bounded modal height, internal scroll.
- Mobile viewport: 390 × 844, single-column cards, compact tab navigation, no horizontal overflow.
- Interactions: Directory opens and closes; tabs switch; connector details open; Google detail exposes tools and an on-demand authorization explanation; setup remains inside the selected connector.
- Product-system adaptation: the reference's white surface was intentionally translated to Nemo's existing dark tokens, typography, borders, radii, and Lucide icon system.
- Security truthfulness: built-in skills do not claim external access; connectors explain when authorization is required; secrets remain server-side; unavailable executors are not presented as working.

Issues:

- P0: none.
- P1: none.
- P2: none.
- P3: provider brand logos use the existing Nemo icon system instead of external logo assets.

final result: passed
