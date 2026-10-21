// Executable contracts for the 2026-07 release: video-resolution entitlement,
// 5-hour recordings, team model gating, Sheets knowledge ingestion, team RAG.
// Static source assertions (same style as security-contracts.mjs); live behavior
// is exercised separately by deploy probes and the live smokes.
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8')

let failed = 0
const check = (name, condition, detail = '') => {
  console.log(`[${condition ? 'OK' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`)
  if (!condition) failed++
}

// ---------- B. 1080p/4K are a Pro-and-above entitlement, enforced server-side ----------
{
  const plans = read('supabase/functions/_shared/plans.ts')
  const planLine = (id) => plans.match(new RegExp(`^\\s*${id}:\\s*\\{.*$`, 'm'))?.[0] ?? ''
  const hiRes = (id) => /hiResVideo:\s*true/.test(planLine(id))
  check('hiResVideo granted to pro/business/agency/enterprise/beta', ['pro', 'business', 'agency', 'enterprise', 'beta'].every(hiRes))
  check('hiResVideo denied to free/starter', ['free', 'starter'].every((id) => /hiResVideo:\s*false/.test(planLine(id))))
  check('Starter media requires a customer provider key', /mediaIncluded:\s*false/.test(planLine('starter')) && /mediaTrialWeekly:\s*0/.test(planLine('starter')))
  check('BYO plans without a trial fail closed with NEED_KEY', /return \{ ok: false, code: 'NEED_KEY', message: MSG_NO_NEMO_KEY \}/.test(read('supabase/functions/_shared/mediaAccess.ts')))

  const rv = read('supabase/functions/render-video/index.ts')
  check('render-video accepts only the quality enum', /VIDEO_QUALITIES = \['720p', '1080p', '4k'\]/.test(rv) && !/props\.width|body\?.\.width|body\.width/.test(rv))
  check('hi-res without entitlement is rejected, not downgraded', /quality !== '720p' && !hiResAllowed/.test(rv) && /PLAN_HIRES/.test(rv))
  check('absent quality defaults plan-aware on the server', /hiResAllowed \? '1080p' : '720p'/.test(rv))
  check('quality is forwarded to the worker and recorded in usage', /JSON\.stringify\(\{ accountId, props, quality \}\)/.test(rv) && /tool_runs'\)\.insert\(\{[^}]*quality/.test(rv))

  const worker = read('render-worker/server.mjs')
  check('worker validates quality against its own allowlist', /QUALITIES = \['720p', '1080p', '4k'\]/.test(worker) && /QUALITIES\.includes\(quality\) \? quality : '1080p'/.test(worker))
  check('worker gives 4K a larger render timeout', /quality === '4k' \? 300000 : 120000/.test(worker))

  const reel = read('render-worker/src/Reel.tsx')
  check('canvas dimensions come from the composition allowlist', /QUALITY_CANVAS/.test(reel) && /width: canvas\.width, height: canvas\.height/.test(reel))
  check('reel typography scales with width (not fixed to 1080)', /const k = width \/ 1080/.test(reel) && /fontSize: 84 \* k/.test(reel))

  const panel = read('src/components/platform/VideoRenderPanel.tsx')
  check('UI sends the enum only and surfaces the plan rejection', panel.includes("quality: quality === 'auto' ? undefined : quality") && !/width|height/.test(panel.match(/invoke\('render-video', \{ action: 'render'[\s\S]*?\}\)/)?.[0] ?? 'width'))
  check('UI defaults to auto so lower plans never hit a surprise rejection', panel.includes("useState<Quality>('auto')") && panel.includes('qualityAuto'))
  check('4K polling outlasts the worker render timeout', panel.includes("quality === '4k' ? 95 : 60"))
}

// ---------- A. recordings up to 5 hours (windowed, resumable, seam-deduped) ----------
{
  const tf = read('supabase/functions/transcribe-file/index.ts')
  check('recording cap raised to 5 hours with a 600k transcript bound', /LONG_MAX_SECONDS = 5 \* 60 \* 60/.test(tf) && /MAX_TRANSCRIPT_CHARS = 600_000/.test(tf))
  check('server enforces a hard window bound (a lying client cannot buy more)', /MAX_WINDOWS = 7/.test(tf) && tf.includes('Math.min(MAX_WINDOWS, Number(job.max_windows)') && tf.includes('job.windows_done < maxWindows'))
  check('Gemini file is polled to ACTIVE before transcription', /state === 'PROCESSING'/.test(tf) && /state !== 'ACTIVE'/.test(tf))
  check('windows overlap and merge through the seam-dedupe helper', /WINDOW_OVERLAP_SECONDS = 30/.test(tf) && /mergeTranscriptWindows\(job\.transcript, r\.text\)/.test(tf))
  check('long jobs are resumable within the edge wall-clock budget', /REQUEST_BUDGET_MS/.test(tf) && /'continue'/.test(tf) && /pending: true, job_id/.test(tf))
  check('billing happens once at finalize: max(provider tokens, chars/4)', read('supabase/migrations/20260714110000_transcribe_jobs.sql').includes("greatest(coalesce(p_provider_tokens, 0), ceil(length(coalesce(p_transcript, ''))::numeric / 4)::bigint, 1)"))
  check('job state is private (service-role table) with an atomic claim lease', tf.includes("from('transcribe_jobs')") && tf.includes('claimed_at.is.null,claimed_at.lt.') && !tf.includes('transcripts/'))
  check('every job write proves lease ownership via the claim token', tf.includes("claim_token: crypto.randomUUID()") && tf.includes(".eq('claim_token', job.claim_token)"))
  const jobsMigration = read('supabase/migrations/20260714110000_transcribe_jobs.sql')
  check('finalize is one transaction: token check + usage + balance + done/billed', tf.includes("rpc('finalize_transcribe_job'") && /claim_token = p_claim_token[\s\S]*insert into public\.usage[\s\S]*perform public\.decrement_token_balance/.test(jobsMigration))
  check('the balance is charged in CREDITS via the existing converter, never raw tokens', jobsMigration.includes('perform public.decrement_token_balance(p_account_id, v_billable)') && !/token_balance - v_billable/.test(jobsMigration))
  check('a stale lease can never delete the new owner\'s Gemini file', (tf.match(/if \(failedRow\?\.id\) await geminiDeleteFile/g) ?? []).length === 2)
  check('a failed finalize keeps the Gemini file and stays retryable', tf.includes("note: 'finalize retry'") && /finalizeError\) \{[\s\S]*?saveProgress\(job\)/.test(tf))
  check('done transcripts stay readable past the credit gate', tf.indexOf("=== 'continue'") < tf.indexOf('token_balance) <= 0'))
  check('empty model output is end-of-audio ONLY on a normal STOP', tf.includes("finishReason === 'STOP'"))
  check('the final window is clamped to the 5-hour bound', tf.includes('Math.min(start + WINDOW_SECONDS, LONG_MAX_SECONDS)'))
  check('transcribe_jobs is RLS-locked and deployed', /enable row level security/.test(jobsMigration) && !/create policy/.test(jobsMigration) && /grant execute on function public\.finalize_transcribe_job[\s\S]*to service_role/.test(jobsMigration) && read('deploy.ps1').includes('20260714110000_transcribe_jobs.sql'))

  const ops = read('supabase/functions/ops-workflow/index.ts')
  check('meeting analysis covers the 600k-char five-hour transcript', /MEETING_INPUT_MAX_CHARS = 600_000/.test(ops) && /MEETING_CHUNK_CHARS = 30_000/.test(ops) && /MEETING_MAX_CHUNKS = 24/.test(ops))

  const runner = read('src/components/platform/OpsWorkflowRunner.tsx')
  check('frontend accepts 5h and loops server continuations', /MAX_AUDIO_SECONDS = 5 \* 60 \* 60/.test(runner) && /action: 'continue', job_id/.test(runner))

  // behavioral: seam dedupe on the real module
  const { mergeTranscriptWindows } = await import('../supabase/functions/_shared/transcriptMerge.ts')
  const prevWindow = 'Speaker 1: Мы обсудили план на квартал и договорились запустить рекламу в июле после праздников'
  const nextWindow = 'план на квартал и договорились запустить рекламу в июле после праздников Speaker 2: Да, и бюджет утвердим в понедельник'
  const merged = mergeTranscriptWindows(prevWindow, nextWindow)
  check('duplicated seam words appear exactly once after the merge', merged.includes('бюджет утвердим') && merged.split('запустить рекламу').length === 2)
  check('non-overlapping windows are joined without loss', mergeTranscriptWindows('Первая часть встречи закончилась.', 'Вторая часть началась с другой темы.').includes('Первая часть') && mergeTranscriptWindows('Первая часть встречи закончилась.', 'Вторая часть началась с другой темы.').includes('Вторая часть'))
  check('empty windows are handled', mergeTranscriptWindows('', 'text') === 'text' && mergeTranscriptWindows('text', '') === 'text')
  // alignment: a phrase repeated DEEP in the next window (past the seam region)
  // must not delete the novel words before its reoccurrence
  const seamPhrase = 'мы обсудили бюджет на маркетинг в третьем квартале этого года'
  const novel = Array.from({ length: 130 }, (_, i) => `новое${i}`).join(' ')
  const alignedMerge = mergeTranscriptWindows(`Начало встречи. ${seamPhrase}`, `${novel} ${seamPhrase} и продолжили обсуждение`)
  check('a repeated phrase far from the seam never deletes novel text', alignedMerge.includes('новое0') && alignedMerge.includes('новое129'))
}

// ---------- D. team model/provider/sphere selection + server-side model gating ----------
{
  const agentTs = read('supabase/functions/_shared/agent.ts')
  const testAgent = read('supabase/functions/test-agent/index.ts')
  const tgProcess = read('supabase/functions/_shared/tgProcess.ts')
  const platform = read('src/data/platform.ts')

  // one synchronized premium contract: every model the frontend offers must be
  // classified identically by the server's PREMIUM_RE gate
  const reMatch = agentTs.match(/const PREMIUM_RE = \/(.+)\/i\r?$/m)
  const premiumRe = new RegExp(reMatch?.[1] ?? '$^', 'i')
  const providersBlock = platform.slice(platform.indexOf('export const PROVIDERS'), platform.indexOf('// Flat list'))
  const models = [...providersBlock.matchAll(/\{ id: '([^']+)', label: '[^']+', tokenRate: \d+(, premium: true)? \}/g)]
    .map((m) => ({ id: m[1], premium: Boolean(m[2]) }))
  const mismatches = models.filter((m) => premiumRe.test(m.id) !== m.premium).map((m) => m.id)
  check('frontend model catalog premium flags match the server gate', models.length >= 15 && mismatches.length === 0, mismatches.length ? `mismatch: ${mismatches.join(', ')}` : `${models.length} models verified`)

  check('team specialists run their SAVED model through the plan gate', /select\('id, role, name, prompt, status, model'\)/.test(agentTs) && /gateModel\(sa\.model, premiumAllowed\)/.test(agentTs))
  check('team direct fallback is plan-gated (no raw agent.model)', /gateModel\(agent\.model, premiumAllowed\)/.test(agentTs) && !/model: agent\.model \|\| PRIMARY_MODEL/.test(agentTs))
  check('the lead\'s saved model drives routing, fallbacks and synthesis', (agentTs.match(/model: leadModel/g) ?? []).length >= 4)
  check('direct sub-agent channels are plan-gated', /gateModel\(sub\.model, premiumAllowed\)/.test(agentTs) && /buildSubAgentReply\(db, apiKey, sub, chronological, planOf\(acc\?\.plan\)\.premium\)/.test(tgProcess))
  check('test sandbox mirrors the live plan gate (main + routed)', /const premiumAllowed = planOf\(acc\?\.plan\)\.premium/.test(testAgent) && /gateModel\(agent\?\.model, premiumAllowed\)/.test(testAgent) && /gateModel\(tgt\.model, premiumAllowed\)/.test(testAgent) && !/ALLOWED_MODELS\b/.test(testAgent))

  // authoritative server allowlist: arbitrary ids can never run on Nemo's key,
  // and every model the UI offers must be present in the allowlist
  const serverModels = read('supabase/functions/_shared/models.ts')
  check('unknown model ids fall back to the primary model server-side', agentTs.includes('ALLOWED_MODEL_IDS.has(r)') && agentTs.includes("from './models.ts'"))
  const allowlistIds = new Set([...serverModels.matchAll(/'([\w./:-]+\/[\w./:-]+)'/g)].map((m) => m[1]))
  const missingFromAllowlist = models.filter((m) => !allowlistIds.has(m.id)).map((m) => m.id)
  check('every UI model id is in the server allowlist', missingFromAllowlist.length === 0, missingFromAllowlist.length ? `missing: ${missingFromAllowlist.join(', ')}` : `${models.length} ids covered`)

  const runner = read('src/components/platform/AutonomousRunner.tsx')
  const marketplace = read('src/pages/app/MarketplacePage.tsx')
  check('custom team builder saves the chosen model and sphere', /const model = saveModel \|\| undefined/.test(runner) && /saveSphere\.trim\(\)/.test(runner) && /PROVIDERS\.map/.test(runner))
  check('sphere pickers suggest the 12 industry spheres', runner.includes('nemo-team-sphere-options') && runner.includes('INDUSTRY_TEAM_BLUEPRINTS') && marketplace.includes('nemo-sphere-options'))
}

// ---------- E. Google Sheets + XLSX/CSV/PDF/DOCX into knowledge ----------
{
  const gt = read('supabase/functions/google-tools/index.ts')
  const knowledgeBranch = gt.slice(gt.indexOf("action === 'sheets_read_knowledge'"), gt.indexOf("action === 'sheets_append'"))
  check('dedicated knowledge sheet-read exists with a clamped server-side range', knowledgeBranch.includes('A1:Z5000') && !knowledgeBranch.includes('body.range'))
  check('sheet content is bounded and cell-escaped before leaving the server', knowledgeBranch.includes('MAX_CONTENT = 200_000') && knowledgeBranch.includes("replace(/[\\t\\r\\n]+/g, ' ')") && knowledgeBranch.includes('truncated'))
  check('the pasted URL\'s gid picks the sheet tab', knowledgeBranch.includes('gid=') && knowledgeBranch.includes('sheetId === gid'))
  check('an unknown gid is rejected, never silently swapped for the first tab', knowledgeBranch.includes('gid != null && !target') && knowledgeBranch.includes('not found'))

  const km = read('src/components/platform/KnowledgeManager.tsx')
  check('knowledge reads are filtered by owner_type AND owner_id', km.includes(".eq('owner_id', agentId)") && km.includes(".eq('owner_type', ownerType)"))
  check('Google Sheets is a first-class knowledge source in the manager', km.includes("action: 'sheets_read_knowledge'") && km.includes("'gsheet'"))

  const et = read('src/lib/extractText.ts')
  check('XLSX/CSV/PDF/DOCX uploads stay supported in the browser extractor', ['.pdf', '.docx', '.xlsx', '.csv'].every((ext) => et.includes(ext)))
}

// ---------- F. team-shared RAG with tenant-scoped RLS ----------
{
  const mig = read('supabase/migrations/20260714100000_team_shared_rag.sql')
  check('knowledge policy recognizes agent AND team owners per tenant', /owner_type = 'agent' and owner_id in \(select id from public\.agents/.test(mig) && /owner_type = 'team' and owner_id in \(select id from public\.departments/.test(mig))
  check('owner_type is constrained for new rows without breaking legacy data', /knowledge_docs_owner_type_check/.test(mig) && /not valid/.test(mig))
  check('chunk owner columns are backfilled from their parent docs', /update public\.knowledge_chunks c/.test(mig) && /from public\.knowledge_docs d/.test(mig))
  check('department/sub-agent tenant integrity is trigger-enforced', /departments_tenant_guard/.test(mig) && /sub_agents_tenant_guard/.test(mig) && /42501/.test(mig))
  const rpcBody = mig.slice(mig.indexOf('create or replace function public.match_knowledge_team'))
  check('team retrieval RPC verifies BOTH owners against the account and joins docs', /a\.account_id = p_account_id/.test(rpcBody) && /t\.account_id = p_account_id/.test(rpcBody) && /join public\.knowledge_docs d on d\.id = c\.doc_id/.test(rpcBody))
  check('team retrieval RPC is service-role only; single-owner RPC retained', /revoke all on function public\.match_knowledge_team[\s\S]*grant execute on function public\.match_knowledge_team[\s\S]*to service_role/.test(mig) && !/drop function public\.match_knowledge\b/.test(mig))

  const kn = read('supabase/functions/_shared/knowledge.ts')
  check('runtime team retrieval uses the account-aware RPC with a naive fallback', /match_knowledge_team/.test(kn) && /p_account_id: accountId/.test(kn) && /naiveTeamDump/.test(kn))
  check('EVERY team retrieval path (incl. fallback) is gated by a tenant check', kn.includes(".eq('id', departmentId).eq('account_id', accountId)") && kn.includes("if (!dept?.id) return ''"))
  const agentTs = read('supabase/functions/_shared/agent.ts')
  check('team replies retrieve shared knowledge and inject it into SPECIALIST prompts', /retrieveTeamKnowledge\(db, agent\.account_id, dept\.id/.test(agentTs) && /specialistKnowledgeBlock/.test(agentTs))
  check('runtime department lookup is account-scoped', agentTs.includes(".eq('main_agent_id', agent.id).eq('account_id', agent.account_id)"))
  check('pre-existing cross-tenant team rows are remediated in the migration', /set main_agent_id = null/.test(mig) && /delete from public\.sub_agents s/.test(mig))
  const ki = read('supabase/functions/knowledge-index/index.ts')
  check('indexing verifies team-doc ownership through the department', /ownsDepartment/.test(ki) && /owner_type === 'team' \? await ownsDepartment/.test(ki))
  const ta = read('supabase/functions/test-agent/index.ts')
  check('test sandbox mirrors team knowledge retrieval', /retrieveTeamKnowledge\(admin, accountId, dept\.id, message\)/.test(ta))
  const kp = read('src/pages/app/KnowledgePage.tsx')
  check('knowledge page exposes the team-shared base', /ownerType=\{kind === 'team' \? 'team' : 'agent'\}/.test(kp) && /groupTeams/.test(kp))
  const deployScript = read('deploy.ps1')
  check('team RAG migration and verification are deployed', /20260714100000_team_shared_rag\.sql/.test(deployScript) && /match_knowledge_team\(uuid,uuid,uuid,vector,integer\)/.test(deployScript))
  const smoke = read('agent-hub/security-live-smoke.mjs')
  check('live smoke covers cross-tenant team writes, indexing, retrieval and guards', /match_knowledge_team/.test(smoke) && /Cross-tenant department lead is rejected/.test(smoke) && /Foreign tenant cannot index/.test(smoke))
}

// ---------- leads follow-up: one external CRM attempt per claim ----------
{
  const agentTs = read('supabase/functions/_shared/agent.ts')
  const pushFn = agentTs.slice(agentTs.indexOf('async function pushLeadToCrm'), agentTs.indexOf('async function extractLead'))
  check('CRM push never fans out after an ambiguous failure', (pushFn.match(/return \{ provider: r/g) ?? []).length >= 3 && !/if \(r\.ok\) return \{ provider/.test(pushFn))
}

// ---------- C. Content Factory (campaign entry plus all existing groups) ----------
{
  const cs = read('src/pages/app/ContentStudioPage.tsx')
  check('factory retains its three groups alongside the campaign entry', /type Group = 'campaign' \| 'autopilot' \| 'studio' \| 'tools'/.test(cs) && cs.includes("tab === 'campaign' && <MarketingCampaignStudio />"))
  check('old deep-link leaf ids stay canonical with a safe campaign fallback', /useSearchParams/.test(cs) && cs.includes("'autopilot' | 'video' | 'media' | 'strategy' | 'content' | 'analyze' | 'battle' | 'multilang' | 'watch'") && cs.includes(": 'campaign'"))
  check('only the default campaign clears the query; Autopilot keeps its explicit deep link', cs.includes("setParams(leaf === 'campaign' ? {} : { tab: leaf }, { replace: true })"))
  check('no capability was removed in the regroup', ['FactoryAutopilotPanel', 'CompetitorTeamPanel', 'MultiLangPanel', 'ChannelWatchPanel', 'MarketingStrategyPanel', 'ContentTeamPanel', 'ContentAnalyzePanel', 'VideoRenderPanel', 'MediaConnectPanel'].every((p) => cs.includes(`<${p}`)))
  check('the coordinator lives with Autopilot only', cs.includes("group === 'autopilot' && ("))
  check('channel watch is its own tool', cs.includes("tab === 'watch' && <ChannelWatchPanel />"))
}

console.log(failed ? `Release entitlement contracts: ${failed} FAILED` : 'Release entitlement contracts passed.')
if (failed) process.exit(1)
