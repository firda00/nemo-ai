import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { ForgeComputeProfile } from '../../src/types/forge-contracts.ts'
import { MarpPresentationInputSchema } from '../documents/marp-renderer.ts'
import { TypstDocumentInputSchema } from '../documents/typst-renderer.ts'
import { renderProfileBDocument } from '../workers/document-worker.ts'

const DocumentInputSchema = z.discriminatedUnion('kind', [
  TypstDocumentInputSchema,
  MarpPresentationInputSchema,
])

export const ForgeDocumentRenderRequestSchema = z.object({
  accountId: z.string().uuid(),
  workflowId: z.string().uuid(),
  executionId: z.string().uuid(),
  stepId: z.string().uuid(),
  computeProfile: z.literal('PROFILE_B_DOCS'),
  input: DocumentInputSchema,
}).strict()

const TENANT_ARTIFACT_PATH = /^tenants\/([0-9a-f-]{36})\/artifacts\/\d{4}\/\d{2}\/\d{2}\/[A-Za-z0-9._-]{1,160}$/i

export const ForgeDocumentArtifactRefSchema = z.object({
  executionId: z.string().uuid(),
  stepId: z.string().uuid(),
  storagePath: z.string().min(1).max(512),
  name: z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  mimeType: z.enum(['application/pdf', 'text/html']),
  sizeBytes: z.number().int().positive().max(64 * 1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  engineVersion: z.string().min(1).max(128),
  seed: z.union([z.number().int(), z.string().max(128)]),
}).strict()

export type ForgeDocumentRenderRequest = z.infer<typeof ForgeDocumentRenderRequestSchema>
export type ForgeDocumentArtifactRef = z.infer<typeof ForgeDocumentArtifactRefSchema>

export interface ForgeDocumentArtifactRegistrar {
  register(input: {
    accountId: string
    workflowId: string
    executionId: string
    stepId: string
    name: string
    mimeType: 'application/pdf' | 'text/html'
    bytes: Uint8Array
    sha256: string
  }): Promise<{ storagePath: string }>
}

export interface ForgeDocumentRendererDependencies {
  artifacts: ForgeDocumentArtifactRegistrar
  render?: typeof renderProfileBDocument
}

export const FORGE_DOCUMENT_PROFILE: ForgeComputeProfile = 'PROFILE_B_DOCS'
export const FORGE_DOCUMENT_ENGINE_VERSION = 'nemo-forge-documents/1 profile-b'

function assertTenantArtifactPath(storagePath: string, accountId: string): void {
  const match = TENANT_ARTIFACT_PATH.exec(storagePath)
  if (!match || match[1].toLowerCase() !== accountId.toLowerCase()) {
    throw new Error('FORGE_DOCUMENT_ARTIFACT_TENANT_MISMATCH')
  }
}

/**
 * Executes only the deterministic document portion of a Forge step.
 * Persistence stays behind a scoped registrar so this adapter never receives a service-role key.
 */
export async function renderForgeDocument(
  rawRequest: unknown,
  dependencies: ForgeDocumentRendererDependencies,
): Promise<ForgeDocumentArtifactRef> {
  const request = ForgeDocumentRenderRequestSchema.parse(rawRequest)
  const rendered = await (dependencies.render ?? renderProfileBDocument)(request.input)
  const sha256 = createHash('sha256').update(rendered.bytes).digest('hex')
  const registration = await dependencies.artifacts.register({
    accountId: request.accountId,
    workflowId: request.workflowId,
    executionId: request.executionId,
    stepId: request.stepId,
    name: rendered.outputName,
    mimeType: rendered.mimeType,
    bytes: rendered.bytes,
    sha256,
  })
  assertTenantArtifactPath(registration.storagePath, request.accountId)

  return ForgeDocumentArtifactRefSchema.parse({
    executionId: request.executionId,
    stepId: request.stepId,
    storagePath: registration.storagePath,
    name: rendered.outputName,
    mimeType: rendered.mimeType,
    sizeBytes: rendered.bytes.byteLength,
    sha256,
    engineVersion: FORGE_DOCUMENT_ENGINE_VERSION,
    seed: rendered.seed,
  })
}

