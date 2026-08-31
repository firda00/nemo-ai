# Finance & Accounting Swarm — foundation

## Local reference reviewed

The local archive `ustudy-finance-full-code.zip` contains a standalone finance dashboard with 515
imported operations, account/category/payment/counterparty directories, project fields, exchange
rates, payroll placeholders and an audit log. Its operation model is useful, but its single JSONB
`finance_state` persistence and email allowlist RLS are not suitable for a multi-tenant Nemo module.

Useful source fields retained conceptually:

- date, operation type (`income`, `expense`, `transfer`) and amount;
- account or transfer source/destination accounts;
- hierarchical category, project, payment method and counterparty;
- cash-flow (DDS) and recognition (P&L) periods;
- import row and audit provenance.

## Canonical transaction input

`FinanceTransactionSchema` stores money as integer minor units and separates inflow/outflow from
internal transfers. Every record belongs to one workspace and contains its source provenance.
Evidence can point to a bank reference, CSV/XLSX row, PDF page, OCR document or audio/video
timestamp. Transactions are converted to the request base currency before analytics; the engine
must never silently invent an exchange rate.

Optional `impact_context` connects an outflow to an initiative, business purpose and measurable
outcome. Missing attribution remains an explicit data-quality gap rather than an AI guess.

## Analytics contract

`CashFlowAnalyticsOutputSchema` contains reconciled opening/inflow/outflow/net/closing balances,
category breakdown, grounded impact assessments, inefficiencies, recommendations and data-quality
warnings. Transfers are reported separately and do not change net company cash flow.

Every impact claim and recommendation requires evidence with a concrete locator. ROI can be `null`
when outcomes cannot be measured. Recommendations are advisory and always carry
`requires_human_approval: true`; this sprint does not cancel subscriptions, move money, post journal
entries or sign HR/accounting documents.

## Next backend stages

1. Tenant-isolated transaction/source tables with RLS and idempotent import keys.
2. Deterministic normalization for CSV/XLSX/bank statements and OCR review queue.
3. Cash-flow aggregation and impact attribution service.
4. Shared Knowledge & Source Engine for document pages and media timestamps.
5. Approval-gated accounting/HR document generation and audit trail.
