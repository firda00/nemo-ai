import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  FORGE_DOCUMENT_PROFILE,
  renderForgeDocument,
  type ForgeDocumentArtifactRegistrar,
} from '../agent-hub/forge/document-renderer.ts'

const ACCOUNT_ID = '01917b12-3a5c-7d9e-bf33-9118c7e7c101'
const WORKFLOW_ID = '01917b12-3a5c-7d9e-bf33-9118c7e7c102'
const EXECUTION_ID = '01917b12-3a5c-7d9e-bf33-9118c7e7c103'
const STEP_ID = '01917b12-3a5c-7d9e-bf33-9118c7e7c104'

const registrations: Array<{ accountId: string; sha256: string; bytes: Uint8Array }> = []
const registrar: ForgeDocumentArtifactRegistrar = {
  async register(input) {
    registrations.push({ accountId: input.accountId, sha256: input.sha256, bytes: input.bytes })
    return { storagePath: `tenants/${input.accountId}/artifacts/2026/08/27/${input.stepId}-${input.name}` }
  },
}

const request = {
  accountId: ACCOUNT_ID,
  workflowId: WORKFLOW_ID,
  executionId: EXECUTION_ID,
  stepId: STEP_ID,
  computeProfile: FORGE_DOCUMENT_PROFILE,
  input: {
    kind: 'typst_document',
    template: 'commercial_proposal',
    output_name: 'ustadi-proposal.pdf',
    title: 'Ustadi pilot proposal',
    recipient: 'Pilot customer',
    currency: 'UZS',
    sections: [
      { heading: 'Goal', body: 'Create a grounded multilingual content and sales workflow.' },
      { heading: 'Controls', body: 'Publishing and CRM writes require explicit human approval.' },
    ],
    line_items: [{ description: 'Pilot setup', quantity: 1, unit_price: 2_500_000 }],
    seed: 'ustadi-pilot-v1',
  },
} as const

const artifact = await renderForgeDocument(request, { artifacts: registrar })
assert.equal(artifact.mimeType, 'application/pdf')
assert.equal(artifact.name, 'ustadi-proposal.pdf')
assert.ok(artifact.storagePath.startsWith(`tenants/${ACCOUNT_ID}/artifacts/`))
assert.equal(registrations.length, 1)
assert.equal(registrations[0].accountId, ACCOUNT_ID)
assert.equal(registrations[0].sha256, createHash('sha256').update(registrations[0].bytes).digest('hex'))
assert.equal(new TextDecoder().decode(registrations[0].bytes.subarray(0, 5)), '%PDF-')

await assert.rejects(
  renderForgeDocument(request, {
    artifacts: {
      async register() {
        return { storagePath: 'tenants/01917b12-3a5c-7d9e-bf33-9118c7e7ffff/artifacts/2026/08/27/stolen.pdf' }
      },
    },
    render: async () => ({
      bytes: new Uint8Array([37, 80, 68, 70, 45, 49]),
      outputName: 'safe.pdf',
      mimeType: 'application/pdf',
      seed: 0,
      executionTimeMs: 1,
    }),
  }),
  /FORGE_DOCUMENT_ARTIFACT_TENANT_MISMATCH/,
)

await assert.rejects(
  renderForgeDocument({ ...request, computeProfile: 'PROFILE_C_BROWSER' }, { artifacts: registrar }),
  /PROFILE_B_DOCS/,
)

console.log('Forge document adapter passed: isolated PDF, SHA-256 integrity, and tenant-scoped registration.')
