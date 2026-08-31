# Finance & Accounting Swarm — Sprint 2 backend pipeline

## Endpoint

Authenticated product route:

```text
POST /api/finance/analyze-cashflow
```

The Vercel route proxies to the authenticated Supabase Edge Function
`finance-analyze-cashflow`. The caller's account is authoritative: `workspace_id` and every direct
transaction must match the authenticated account or the request is rejected.

The request contains a period, base currency, opening balance in integer minor units, and either:

- already normalized `FinanceTransaction` objects;
- CSV text;
- `excel_json` sheets containing extracted row objects;
- `pdf_json` pages containing extracted table rows.

Raw binary XLSX/PDF parsing stays outside the Edge isolate. The document worker should extract a
bounded JSON dump first; this avoids executing complex archive/PDF parsers in the authenticated API.
Requests are capped at 8 MiB and 10,000 rows.

## Analysis boundary

The server calculates inflow, outflow, transfers, net cash flow, closing balance, category totals
and data-quality scores deterministically. OpenRouter receives only bounded aggregates and
evidence-backed facts. It produces structured impact assessments, inefficiencies and advisory
recommendations through strict JSON Schema output.

Returned citations are internal source locators: bank reference, CSV/XLSX row, PDF page, or media
timestamp. The server rejects invented source locators, unknown transaction IDs, impossible savings,
category spend above the ledger total, and ROI values when attribution is insufficient.

No subscription cancellation, payment, ledger posting, document signature or HR action is executed.

## Example source input

```json
{
  "workspace_id": "11111111-1111-4111-8111-111111111111",
  "period": {
    "from": "2026-08-01T00:00:00+05:00",
    "to": "2026-09-01T00:00:00+05:00"
  },
  "base_currency": "UZS",
  "opening_balance_minor": 500000000,
  "sources": [{
    "format": "csv",
    "source_id": "bank-august",
    "imported_at": "2026-08-30T12:00:00Z",
    "default_currency": "UZS",
    "amount_scale": 100,
    "content": "date;type;amount;account;category;reference\n2026-08-01;income;1000000;main;Sales;R-1"
  }]
}
```

## HR and operational orders

`HrOrderGenerator` defines the next service boundary for vacation, business trip, inventory
write-off, bonus, hiring, termination and procurement drafts. Inputs require organization facts,
signatories and grounded evidence. Outputs can only have `draft_requires_review`, pending signatures
and `requires_human_approval: true`.
