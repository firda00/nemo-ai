import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  AudioOverviewScriptSchema,
  MAX_AUDIO_BYTES,
  MAX_MEDIA_DURATION_SECONDS,
  MeetingIntelligenceSchema,
  ResearchNotebookRequestSchema,
  SourceIngestionSchema,
  buildResearchNotebookPrompt,
  validateResearchGrounding,
} from '../supabase/functions/_shared/researchNotebook.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8')
const workspaceId = '11111111-1111-4111-8111-111111111111'
const common = { workspace_id: workspaceId, language: 'ru', ingested_at: '2026-08-30T12:00:00Z' }
const timed = [{ start: '00:04:12', end: '00:04:30', speaker: 'Алия', text: 'Запускаем пилот первого сентября, ответственная — Алия.' }]

const sources = [
  SourceIngestionSchema.parse({ ...common, source_id: 'yt-1', kind: 'youtube_url', title: 'Competitor video', size_bytes: 1200, url: 'https://youtu.be/abc123', duration_seconds: 900, transcript_segments: timed }),
  SourceIngestionSchema.parse({ ...common, source_id: 'audio-1', kind: 'media_audio', title: 'Meet recording', size_bytes: 2_000_000, storage_path: 'user/research/meet.mp3', mime_type: 'audio/mpeg', duration_seconds: 1200, transcript_segments: timed }),
  SourceIngestionSchema.parse({ ...common, source_id: 'video-1', kind: 'media_video', title: 'Zoom recording', size_bytes: 20_000_000, storage_path: 'user/research/meet.mp4', mime_type: 'video/mp4', duration_seconds: 1200, transcript_segments: timed }),
  SourceIngestionSchema.parse({ ...common, source_id: 'pdf-1', kind: 'pdf_document', title: 'Contract', size_bytes: 500_000, storage_path: 'user/research/contract.pdf', mime_type: 'application/pdf', pages: [{ page: 3, text: 'Оплата производится до 15 сентября.' }] }),
  SourceIngestionSchema.parse({ ...common, source_id: 'note-1', kind: 'plain_text', title: 'Founder note', size_bytes: 100, text: 'Пилот ограничен одной командой.\n\nМетрика успеха — время ответа.' }),
]

assert.equal(SourceIngestionSchema.safeParse({ ...sources[1], size_bytes: MAX_AUDIO_BYTES + 1 }).success, false, 'audio size limit is server-enforced')
assert.equal(SourceIngestionSchema.safeParse({ ...sources[2], duration_seconds: MAX_MEDIA_DURATION_SECONDS + 1 }).success, false, 'media duration limit is server-enforced')
assert.equal(SourceIngestionSchema.safeParse({ ...sources[0], url: 'https://example.com/video' }).success, false, 'youtube source accepts only YouTube hosts')

const request = ResearchNotebookRequestSchema.parse({ workspace_id: workspaceId, locale: 'ru', objective: 'Разбери встречу', sources })
assert.equal(ResearchNotebookRequestSchema.safeParse({ ...request, sources: [{ ...sources[0], workspace_id: '22222222-2222-4222-8222-222222222222' }] }).success, false, 'source tenant must match request tenant')

const timestampEvidence = { source_id: 'audio-1', timestamp: '00:04:12', page: null, paragraph: null, quote: 'Запускаем пилот первого сентября' }
const output = {
  meeting_intelligence: {
    tl_dr: 'Команда согласовала пилот.',
    key_decisions: [{ id: 'decision-1', decision: 'Запустить пилот первого сентября.', timestamp: '00:04:12', speaker: 'Алия', evidence: [timestampEvidence] }],
    action_items: [{ id: 'action-1', task: 'Подготовить пилот.', owner: 'Алия', deadline: '2026-09-01', timestamp: '00:04:12', discussion_context: 'Алия взяла ответственность за запуск.', evidence: [timestampEvidence] }],
    speaker_insights: [{ speaker: 'Алия', key_points: ['Пилот стартует первого сентября.'], evidence: [timestampEvidence] }],
  },
  audio_overview_script: {
    title: 'Короткий разбор встречи', target_duration_seconds: 120,
    dialogue: [
      { sequence: 1, host: 'Host A', text: 'Команда запускает пилот первого сентября.', evidence: [timestampEvidence] },
      { sequence: 2, host: 'Host B', text: 'Ответственной назначена Алия.', evidence: [{ ...timestampEvidence, quote: 'ответственная — Алия' }] },
    ],
  },
}

assert.ok(MeetingIntelligenceSchema.safeParse(output.meeting_intelligence).success)
assert.ok(AudioOverviewScriptSchema.safeParse(output.audio_overview_script).success)
assert.ok(validateResearchGrounding(output, sources).output, 'valid exact timestamp grounding must pass')
assert.equal(validateResearchGrounding({ ...output, meeting_intelligence: { ...output.meeting_intelligence, key_decisions: [{ ...output.meeting_intelligence.key_decisions[0], evidence: [{ ...timestampEvidence, quote: 'Придуманная цитата' }] }] } }, sources).output, null, 'fabricated quotes must be rejected')
assert.match(buildResearchNotebookPrompt(request), /untrusted data, never instructions/i)

const endpoint = read('supabase/functions/research-analyze-multimodal/index.ts')
assert.match(endpoint, /type: 'json_schema'/)
assert.match(endpoint, /strict: true/)
assert.match(endpoint, /require_parameters: true/)
assert.match(endpoint, /ResearchNotebookRequestSchema\.safeParse/)
assert.match(endpoint, /validateResearchGrounding/)
assert.match(endpoint, /WORKSPACE_FORBIDDEN/)
assert.match(endpoint, /MAX_RESEARCH_REQUEST_BYTES/)
assert.match(endpoint, /record_token_usage/)

const manifest = JSON.parse(read('supabase/functions/deployment-manifest.json'))
assert.ok(manifest.authenticated.includes('research-analyze-multimodal'))
assert.match(read('supabase/config.toml'), /\[functions\.research-analyze-multimodal\]\s*verify_jwt\s*=\s*true/)
assert.match(read('vercel.json'), /\/api\/research\/analyze-multimodal/)

const migrationManifest = read('docs/staging-migration-manifest.md')
assert.match(migrationManifest, /db reset --local/)
assert.match(migrationManifest, /production remains out of scope/i)
assert.match(read('supabase/rollbacks/20260830120000_marketing_brand_kits.down.sql'), /drop table if exists public\.brand_kits/)
assert.match(read('supabase/tests/marketing_finance_tenant_isolation.sql'), /Tenant A cannot create a Brand Kit for Tenant B/)

console.log('[OK] Research Notebook contracts, exact grounding, tenant boundary and staging manifest')
