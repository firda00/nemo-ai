// Экран владельца: во что система верит, откуда, насколько уверена — и как ей возразить.
//
// Читает через эту функцию, а не прямым запросом к таблице под RLS. RLS отдал бы строку целиком,
// вместе с source_detail, где лежат идентификаторы прогонов и внутренние следы инструментов. Для
// изоляции арендаторов этого хватило бы; для минимальной привилегии — нет.
//
// Писать напрямую владелец не может вовсе: source='owner' нельзя подделать задним числом, а
// счётчики свидетельств вычисляемы и не имеют колонки для присвоения.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2'
import { corsPreflight, json } from '../_shared/cors.ts'
import { embedText } from '../_shared/knowledge.ts'
import { canonicalSubject, screenStatement, expiryFor, type ClaimKind } from '../_shared/orgMemory.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const KINDS: ClaimKind[] = ['fact', 'preference', 'constraint', 'lesson']

Deno.serve(async (req) => {
  const preflight = corsPreflight(req)
  if (preflight) return preflight
  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ error: 'unauthorized' }, 401)

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE)
  const userDb = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } })
  const { data: auth } = await userDb.auth.getUser()
  if (!auth?.user) return json({ error: 'unauthorized' }, 401)
  const { data: profile } = await admin.from('users').select('account_id').eq('id', auth.user.id).maybeSingle()
  const accountId = profile?.account_id
  if (!accountId) return json({ error: 'no_account' }, 403)

  const body = await req.json().catch(() => ({}))
  const action = String(body?.action ?? 'list')

  // ── Что система знает ──────────────────────────────────────────────────────────────────────
  if (action === 'list') {
    const { data: claims, error } = await admin.from('org_claims')
      .select('id, statement, kind, subject, source, status, confidence, evidence_for, evidence_against, valid_until, created_at, run_ref')
      .eq('account_id', accountId).order('status').order('created_at', { ascending: false }).limit(300)
    if (error) return json({ error: 'claim_lookup_failed' }, 500)

    const now = Date.now()
    const shaped = (claims ?? []).map((claim: Record<string, unknown>) => ({
      id: claim.id,
      statement: claim.statement,
      kind: claim.kind,
      subject: claim.subject,
      source: claim.source,
      status: claim.status,
      confidence: Number(claim.confidence ?? 0),
      evidence_for: Number(claim.evidence_for ?? 0),
      evidence_against: Number(claim.evidence_against ?? 0),
      // Истёкшее показывается отдельным состоянием, а не молча исчезает: владелец должен видеть,
      // что наблюдение отжило, иначе исчезновение выглядит как потеря данных.
      expired: claim.valid_until ? Date.parse(String(claim.valid_until)) <= now : false,
      valid_until: claim.valid_until,
      created_at: claim.created_at,
      // run_ref отдаётся как признак «выведено таким-то прогоном», без внутренних следов.
      from_run: Boolean(claim.run_ref),
    }))

    const { data: board } = await admin.rpc('org_learning_scoreboard', { p_days: 90 })
    const { data: health } = await admin.from('org_memory_health')
      .select('recalls_ok, recalls_empty, embed_failed, query_failed').eq('account_id', accountId)
    const totals = (health ?? []).reduce((sum: Record<string, number>, row: Record<string, number>) => ({
      ok: sum.ok + Number(row.recalls_ok ?? 0),
      empty: sum.empty + Number(row.recalls_empty ?? 0),
      failed: sum.failed + Number(row.embed_failed ?? 0) + Number(row.query_failed ?? 0),
    }), { ok: 0, empty: 0, failed: 0 })

    // Что система умеет измерять — и о чём честно говорит, что не умеет. Без этого «поддержка
    // подключена, CRM нет» остаётся словами в переписке, а владелец не знает, на что вправе
    // рассчитывать.
    const { data: metrics } = await admin.from('org_metrics')
      .select('key, domain, label, unit, is_wired, unwired_reason').order('domain').order('key')

    return json({
      ok: true,
      claims: shaped,
      scoreboard: (Array.isArray(board) ? board[0] : board) ?? null,
      recalls: totals,
      metrics: metrics ?? [],
    })
  }

  // ── Владелец говорит, как есть на самом деле ───────────────────────────────────────────────
  if (action === 'state') {
    const statement = String(body?.statement ?? '').trim()
    const screen = screenStatement(statement)
    if (!screen.ok) return json({ error: 'rejected', reason: screen.reason }, 400)
    const kind = KINDS.includes(String(body?.kind) as ClaimKind) ? String(body?.kind) as ClaimKind : 'constraint'
    const subject = String(body?.subject ?? '').trim().slice(0, 120) || 'general'

    // Слово владельца записывается ДАЖЕ ЕСЛИ вектор посчитать не удалось: потерять его из-за
    // недоступного Supabase.ai хуже, чем на время оставить ненаходимым. Достроит воркер.
    let embedding: number[] | null = null
    try { embedding = await embedText(statement) } catch { embedding = null }

    // Правило владельца бессрочно, наблюдение — нет: то же правило, что и для агентов, потому
    // что срок годности замера не зависит от того, кто его произнёс.
    const validUntil = expiryFor(kind, statement, new Date(), body?.horizon)

    const { data: result, error } = await admin.rpc('org_claim_record', {
      p_account_id: accountId,
      p_statement: statement,
      p_kind: kind,
      p_subject: subject,
      p_subject_key: canonicalSubject(subject),
      p_source: 'owner',
      p_source_detail: { stated_by: 'owner' },
      p_run_ref: null,
      p_audience: 'account',
      p_audience_ref: null,
      p_embedding: embedding,
      p_conflicts: [],
      p_valid_until: validUntil,
    })
    if (error) return json({ error: 'state_failed', detail: error.message }, 500)
    return json({ ok: true, result, embedded: embedding != null, valid_until: validUntil })
  }

  // ── Возражение ─────────────────────────────────────────────────────────────────────────────
  if (action === 'retire') {
    const { data, error } = await userDb.rpc('org_claim_retire', {
      p_claim_id: String(body?.claim_id ?? ''),
      p_reason: String(body?.reason ?? '').slice(0, 300) || 'снято владельцем',
    })
    if (error) return json({ error: 'retire_failed', detail: error.message }, 500)
    return json({ ok: true, result: data })
  }

  if (action === 'affirm') {
    const { data, error } = await userDb.rpc('org_claim_affirm', { p_claim_id: String(body?.claim_id ?? '') })
    if (error) return json({ error: 'affirm_failed', detail: error.message }, 500)
    return json({ ok: true, result: data })
  }

  return json({ error: 'unknown_action' }, 400)
})
