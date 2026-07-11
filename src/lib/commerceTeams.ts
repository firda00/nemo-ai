import type { AgentPrompt, PlatformAgent } from '../types/platform'
import { saveDynamicTeam } from './ustudyTeam'

export type CommerceTeamKind = 'marketplace' | 'dropshipping' | 'online-store' | 'logistics'

interface CommerceBlueprint {
  name: string
  goal: string
  workflowMode: 'generic' | 'logistics'
  specialists: { role: string; name: string; prompt: AgentPrompt }[]
}

const specialist = (role: string, name: string, tasks: string, rules: string): CommerceBlueprint['specialists'][number] => ({
  role,
  name,
  prompt: { role, tasks, tone: 'Concise, operational, evidence-based.', rules },
})

export const COMMERCE_BLUEPRINTS: Record<CommerceTeamKind, CommerceBlueprint> = {
  marketplace: {
    name: 'Marketplace Seller Team',
    workflowMode: 'generic',
    goal: 'Analyze supplied marketplace catalog, order, stock and review data, then prepare seller recommendations and reports. WB/Ozon tools are connected separately and remain read-only; all price, stock and order changes require human approval.',
    specialists: [
      specialist('Order Control Agent', 'Order Controller', 'Check new and unfulfilled marketplace orders, deadlines and operational exceptions.', 'Use only connected seller data; never expose order data in public customer channels.'),
      specialist('Catalog and Listing Specialist', 'Listing Specialist', 'Audit product cards, missing attributes, titles, descriptions and compliance requirements.', 'Recommendations only; publishing a card requires approval.'),
      specialist('Pricing and Promotion Analyst', 'Pricing Analyst', 'Calculate margin-aware pricing and promotion proposals from supplied costs and fees.', 'Never change a price automatically and never invent cost or commission data.'),
      specialist('Reviews and Returns Specialist', 'Reviews Specialist', 'Group review/return issues, draft replies and identify recurring product defects.', 'Drafts require approval before publishing.'),
      specialist('Seller Report Agent', 'Seller Reporter', 'Prepare a concise seller report with risks, owners, deadlines and next actions.', 'Separate verified facts from recommendations.'),
    ],
  },
  dropshipping: {
    name: 'Dropshipping Team',
    workflowMode: 'generic',
    goal: 'Analyze supplied product and supplier data, map SKUs, protect margin, prepare order-routing tasks and control supplier fulfillment. Supplier orders, payments and customer refunds always require human approval.',
    specialists: [
      specialist('Product Research Agent', 'Product Researcher', 'Evaluate supplied demand signals, competition notes and product viability.', 'Cite supplied sources and do not invent sales numbers.'),
      specialist('Supplier Sourcing Agent', 'Supplier Scout', 'Compare supplier price, MOQ, lead time, reliability and terms.', 'Never place a supplier order or payment.'),
      specialist('SKU and Feed Mapping Agent', 'SKU Mapper', 'Map supplier offers to store SKUs and flag conflicts or missing identifiers.', 'Do not merge uncertain SKUs without confirmation.'),
      specialist('Margin Guard and Order Router', 'Order Router', 'Check margin, availability and prepare a human task for supplier fulfillment.', 'Purchases, substitutions and cancellations require approval.'),
      specialist('Fulfillment and Customer Agent', 'Fulfillment Controller', 'Track supplied status data, flag exceptions and draft truthful customer updates.', 'Customer messages are drafts until approved.'),
    ],
  },
  'online-store': {
    name: 'Online Store Team',
    workflowMode: 'generic',
    goal: 'Analyze supplied online-store data for product consultation, lead qualification, order control, follow-up, content and management reporting. Store connectors are configured separately; payments, refunds and fulfillment changes require approval.',
    specialists: [
      specialist('Product and Sales Consultant', 'Product Consultant', 'Answer product questions from the connected knowledge/catalog and qualify intent.', 'Never invent stock, price or delivery terms.'),
      specialist('Lead and CRM Agent', 'CRM Agent', 'Structure customer data, qualify leads and prepare CRM handoff.', 'Respect consent and collect only necessary contact data.'),
      specialist('Order and Inventory Controller', 'Order Controller', 'Review supplied orders and inventory, flag unpaid, unfulfilled and low-stock cases.', 'All order/inventory writes require approval.'),
      specialist('Retention and Support Agent', 'Retention Agent', 'Draft follow-ups, abandoned-cart and support messages based on real context.', 'Stop on opt-out; messages require configured channels and policy.'),
      specialist('Content and Store Report Agent', 'Store Reporter', 'Prepare content ideas and a concise operational report.', 'Separate draft content from published content.'),
    ],
  },
  logistics: {
    name: 'Logistics Control Team',
    workflowMode: 'logistics',
    goal: 'Manual analysis beta for supplied order/tracking rows: parse source facts, detect stale scans and SLA risk, create owner/deadline tasks, draft carrier and customer messages, and report unresolved exceptions. There is no live carrier sync; external actions require human approval.',
    specialists: [
      specialist('Shipment Tracking Agent', 'Tracking Agent', 'Normalize shipment rows, last events, ETA and current delivery state.', 'Never invent a tracking event, location or delivery status.'),
      specialist('SLA and Delay Risk Monitor', 'SLA Monitor', 'Detect promised-date breach, stale scans and delay risk using deterministic dates.', 'Escalate uncertain or missing timestamps.'),
      specialist('Exception Triage Agent', 'Exception Controller', 'Classify pickup, scan, delay, address, customs, damage, loss and return exceptions.', 'Do not mark an exception resolved without a recovery event.'),
      specialist('Carrier and Customer Communication Agent', 'Communication Agent', 'Draft carrier cases and truthful customer updates with next checkpoints.', 'Every external message is a draft requiring approval.'),
      specialist('Logistics Task and Report Agent', 'Logistics Reporter', 'Create owner/deadline tasks and a daily SLA/exceptions report.', 'Refunds, reshipments, carrier changes and claims require approval.'),
    ],
  },
}

export async function createCommerceTeam(
  kind: CommerceTeamKind,
  addAgent: (a: PlatformAgent) => Promise<{ id?: string; error?: string }>,
  deleteAgent?: (id: string) => Promise<{ error?: string }>,
) {
  const bp = COMMERCE_BLUEPRINTS[kind]
  return await saveDynamicTeam(addAgent, bp, deleteAgent)
}

export const SAMPLE_LOGISTICS = `order_id,customer,carrier,status,shipped_at,promised_date,last_event_at,owner
ORD-1001,Aziza,Express24,shipped,2026-07-08,2026-07-11,2026-07-09 10:20,Dilshod
ORD-1002,Bekzod,BTS,pending,2026-07-10,2026-07-12,2026-07-10 09:00,Madina
ORD-1003,Kamola,Fargo,delivered,2026-07-07,2026-07-10,2026-07-10 16:40,Akmal
ORD-1004,Javohir,Express24,shipped,2026-07-06,2026-07-09,2026-07-07 08:15,Dilshod`
