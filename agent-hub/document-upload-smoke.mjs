// DOCUMENT-ARTIFACT-UPLOAD boundary smoke: the ACTUAL Deno.serve handler and the ACTUAL
// inspectOoxml module run under Node — real Request objects in, real Response objects out,
// REAL assembler bytes for the positive cases. Storage and PostgREST are SCRIPTED stubs
// (honest distinction: behavior against real Supabase Storage is NOT proven here — no live
// calls, no deploy). Covered per the Codex conditional GO + follow-up probes:
//   • inspector: real DOCX and PPTX from our assemblers accepted; malformed ZIP, macro part,
//     macro content type, external rels in double quotes, SINGLE quotes, entity-encoded
//     (&#104;ttp), and COMMENT-MASKED variants refused; duplicate normalized entry names and
//     central/local name disagreement refused; traversal names refused; non-UTF-8 refused;
//   • transport: 404 non-POST, 503 unconfigured, 401 bad bearer, 400 malformed headers
//     (nonfinite epoch/size, bad sha/name), 413 declared AND chunked-undeclared oversize,
//     kind↔extension mismatch, HASH_MISMATCH/SIZE_MISMATCH on actual bytes;
//   • one shared deadline: STALLED precheck rpc / storage upload / storage download /
//     registration rpc each return a bounded 408 — and when the stalled call is DELIBERATELY
//     released afterwards, the expired handler still never reaches registration; the injected
//     fetch is asserted to carry the shared AbortSignal (the stub client does not exercise it,
//     so REAL network cancellation is not proven by this mock);
//   • existing-object path: upsert conflict → stored bytes verified equal → registration
//     proceeds; stored bytes differ → STORAGE_CONFLICT, no registration;
//   • fence propagation: stale_lease → 409, bad_request → 400, already:true passthrough with
//     the REGISTERED path (not this attempt's path).
// Run: npm run test:document-upload
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import esbuild from 'esbuild'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (m) => m.slice(1))), '..')
const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nemo-document-upload-'))

let failed = 0
const check = (name, cond, detail = '') => {
  if (cond) console.log(`[OK] ${name}`)
  else { failed += 1; console.error(`[FAIL] ${name}${detail ? `: ${detail}` : ''}`) }
}

// ── scripted supabase-js: rpc + storage recorders with per-test scripting ───────────────────────
const script = {
  rpcCalls: [],
  storageCalls: [],
  verifyResult: { data: { ok: true, kind: 'docx_document', workflow_id: randomUUID() }, error: null },
  verifyDelayMs: 0,
  registerResult: null, // computed per call below when null
  uploadResult: { data: { path: 'x' }, error: null },
  downloadResult: null,
  hang: null, // 'verify' | 'upload' | 'download' | 'register'
  pending: [], // deferred releases for hung calls — resolved AFTER the 408 to prove no continuation
  clientOptions: null,
}
globalThis.__uploadSmokeScript = script
const stubPath = path.join(buildDir, 'supabase-stub.mjs')
fs.writeFileSync(stubPath, `
const script = globalThis.__uploadSmokeScript
// a "hung" call is a DEFERRED promise: the test resolves it after the 408 and proves the
// expired handler never continues into registration
const gated = (factory) => new Promise((resolve) => { script.pending.push(() => resolve(factory())) })
const delayed = (ms, value) => ms > 0 ? new Promise((resolve) => setTimeout(() => resolve(value), ms)) : Promise.resolve(value)
export function createClient(_url, _key, opts) {
  script.clientOptions = opts
  return {
    rpc(name, args) {
      script.rpcCalls.push({ name, args })
      return name === 'document_verify_upload'
        ? (script.hang === 'verify' ? gated(() => script.verifyResult) : delayed(script.verifyDelayMs, script.verifyResult))
        : (script.hang === 'register' ? gated(() => script.registerResult) : Promise.resolve(script.registerResult ?? {
            data: { ok: true, already: false,
              storage_path: 'tenants/' + args.p_account_id + '/artifacts/' + args.p_job_id + '/' + args.p_expected_epoch + '/' + args.p_sha256 + '-' + args.p_name },
            error: null,
          }))
    },
    storage: { from(_bucket) {
      return {
        upload(path, _bytes, opts2) {
          script.storageCalls.push({ op: 'upload', path, upsert: opts2?.upsert, contentType: opts2?.contentType })
          return script.hang === 'upload' ? gated(() => script.uploadResult) : Promise.resolve(script.uploadResult)
        },
        download(path) {
          script.storageCalls.push({ op: 'download', path })
          return script.hang === 'download' ? gated(() => script.downloadResult) : Promise.resolve(script.downloadResult)
        },
      }
    } },
  }
}
`)

const DOCUMENT_TOKEN = 'document-worker-token-0123456789abcdef'
const ENV = {
  SUPABASE_URL: 'https://stub.local',
  SUPABASE_SERVICE_ROLE_KEY: 'service',
  NEMO_DOCUMENT_WORKER_TOKEN: DOCUMENT_TOKEN,
  DOCUMENT_UPLOAD_BUDGET_MS: '400',
}
let handler = null
globalThis.Deno = {
  env: { get: (key) => ENV[key] ?? '' },
  serve: (h) => { handler = h },
}

async function bundle(entry, outName) {
  const outfile = path.join(buildDir, outName)
  await esbuild.build({
    entryPoints: [path.join(root, entry)],
    bundle: true,
    outfile,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
    plugins: [{
      name: 'stub-esm-sh',
      setup(build) { build.onResolve({ filter: /^https:\/\/esm\.sh\// }, () => ({ path: stubPath })) },
    }],
  })
  return outfile
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const jsonOf = async (response) => { try { return await response.json() } catch { return null } }
// hex LETTERS are required here: an all-digit UUID survives toUpperCase() unchanged and the
// uppercase-canonicalization test would prove nothing
const ACCOUNT = 'ab11c1de-1111-4111-8111-1111111fab11'
const JOB = 'cd22e2fa-2222-4222-8222-2222222abc22'
const TOKEN = 'ef33a3bc-3333-4333-8333-3333333def33'

function uploadRequest(bytes, headerOverrides = {}, { chunked = false } = {}) {
  const headers = {
    authorization: `Bearer ${DOCUMENT_TOKEN}`,
    'x-account-id': ACCOUNT,
    'x-job-id': JOB,
    'x-claim-token': TOKEN,
    'x-lease-epoch': '1',
    'x-artifact-name': 'report.docx',
    'x-artifact-sha256': sha256(bytes),
    'x-artifact-size': String(bytes.byteLength),
    ...headerOverrides,
  }
  for (const key of Object.keys(headers)) if (headers[key] === null) delete headers[key]
  const body = chunked
    ? new ReadableStream({
        start(controller) {
          for (let offset = 0; offset < bytes.byteLength; offset += 65536) {
            controller.enqueue(bytes.subarray(offset, Math.min(bytes.byteLength, offset + 65536)))
          }
          controller.close()
        },
      })
    : bytes
  return new Request('https://x/document-artifact-upload', { method: 'POST', headers, body, duplex: 'half' })
}

// ── minimal stored-entry ZIP builder for adversarial fixtures (full header control) ─────────────
function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}
function buildZip(entries) {
  const encoder = new TextEncoder()
  const chunks = []
  const central = []
  let offset = 0
  for (const entry of entries) {
    const data = typeof entry.data === 'string' ? encoder.encode(entry.data) : entry.data
    const centralName = encoder.encode(entry.name)
    const localName = encoder.encode(entry.localName ?? entry.name)
    const crc = crc32(data)
    const local = new Uint8Array(30 + localName.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true)
    lv.setUint32(14, crc, true)
    lv.setUint32(18, data.length, true)
    lv.setUint32(22, data.length, true)
    lv.setUint16(26, localName.length, true)
    local.set(localName, 30)
    chunks.push(local, data)
    const record = new Uint8Array(46 + centralName.length)
    const cv = new DataView(record.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(4, 20, true)
    cv.setUint16(6, 20, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, data.length, true)
    cv.setUint32(24, data.length, true)
    cv.setUint16(28, centralName.length, true)
    cv.setUint32(42, offset, true)
    record.set(centralName, 46)
    central.push(record)
    offset += local.length + data.length
  }
  const centralStart = offset
  let centralSize = 0
  for (const record of central) { chunks.push(record); centralSize += record.length }
  const eocd = new Uint8Array(22)
  const ev = new DataView(eocd.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, central.length, true)
  ev.setUint16(10, central.length, true)
  ev.setUint32(12, centralSize, true)
  ev.setUint32(16, centralStart, true)
  chunks.push(eocd)
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const joined = new Uint8Array(total)
  let cursor = 0
  for (const chunk of chunks) { joined.set(chunk, cursor); cursor += chunk.length }
  return joined
}

const CONTENT_TYPES = '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
const RELS_OK = '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
const DOC_XML = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>'
const docxLike = (overrides = {}) => buildZip([
  { name: '[Content_Types].xml', data: overrides.contentTypes ?? CONTENT_TYPES },
  { name: '_rels/.rels', data: overrides.rels ?? RELS_OK, ...(overrides.relsEntry ?? {}) },
  { name: 'word/document.xml', data: DOC_XML },
  ...(overrides.extraEntries ?? []),
])

try {
  // ── the ACTUAL inspector, adversarial matrix ──────────────────────────────────────────────────
  const inspector = await import(pathToFileURL(await bundle('supabase/functions/_shared/ooxmlInspect.ts', 'inspect.mjs')).href)
  const { inspectOoxml } = inspector
  const { assembleDocx } = await import(pathToFileURL(await bundle('agent-hub/documents/docx-assembler.ts', 'docx.mjs')).href)
  const { assemblePptx } = await import(pathToFileURL(await bundle('agent-hub/documents/pptx-assembler.ts', 'pptx.mjs')).href)

  const realDocx = assembleDocx({
    kind: 'docx_document', title: 'Настоящий документ', language: 'ru',
    blocks: [{ type: 'paragraph', text: 'Настоящий документ для инспекции.' }],
  }).bytes
  const realPptx = assemblePptx({
    kind: 'pptx_presentation', title: 'Настоящая презентация',
    slides: [{ title: 'Слайд', bullets: ['Первый пункт'] }],
  }).bytes
  check('inspector: real assembler DOCX accepted', (await inspectOoxml(realDocx, 'docx_document')).ok === true)
  check('inspector: real assembler PPTX accepted', (await inspectOoxml(realPptx, 'pptx_presentation')).ok === true)
  check('inspector: DOCX bytes declared as PPTX refused',
    (await inspectOoxml(realDocx, 'pptx_presentation')).reason === 'missing_primary_part')
  check('inspector: minimal stored-entry docx-like accepted', (await inspectOoxml(docxLike(), 'docx_document')).ok === true)
  check('inspector: garbage is not a zip', (await inspectOoxml(new Uint8Array(64).fill(7), 'docx_document')).reason === 'not_zip')
  const truncated = docxLike().slice(0, 40)
  check('inspector: truncated zip refused', (await inspectOoxml(truncated, 'docx_document')).ok === false)
  check('inspector: macro part refused',
    (await inspectOoxml(docxLike({ extraEntries: [{ name: 'word/vbaProject.bin', data: 'x' }] }), 'docx_document')).reason === 'macro_part')
  check('inspector: macroEnabled content type refused',
    (await inspectOoxml(docxLike({ contentTypes: CONTENT_TYPES.replace('document.main+xml', 'document.macroEnabled.main+xml') }), 'docx_document')).reason,
    'macro or main-type refusal')
  const externalDouble = RELS_OK.replace('/>', '/><Relationship Id="rX" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" TargetMode="External" Target="https://example.invalid"/>')
  check('inspector: external rel (double quotes) refused',
    (await inspectOoxml(docxLike({ rels: externalDouble }), 'docx_document')).reason === 'external_relationship')
  const externalSingle = RELS_OK.replace('/>', "/><Relationship Id='rX' Type='http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink' TargetMode='External' Target='https://example.invalid'/>")
  check('inspector: external rel (SINGLE quotes) refused',
    (await inspectOoxml(docxLike({ rels: externalSingle }), 'docx_document')).reason === 'external_relationship')
  const externalEntity = RELS_OK.replace('/>', '/><Relationship Id="rX" Target="&#104;ttps://example.invalid"/>')
  check('inspector: entity-encoded Target refused',
    (await inspectOoxml(docxLike({ rels: externalEntity }), 'docx_document')).reason === 'external_relationship')
  const commentMasked = '<?xml version="1.0"?><Relationships><!-- a=" --><Relationship TargetMode=\'External\' Target=\'https://example.invalid\'/><!-- " --></Relationships>'
  check('inspector: comment-masked external rel refused (exact Codex fixture)',
    (await inspectOoxml(docxLike({ rels: commentMasked }), 'docx_document')).reason === 'xml_comment')
  check('inspector: CDATA in control part refused',
    (await inspectOoxml(docxLike({ rels: RELS_OK.replace('</Relationships>', '<![CDATA[x]]></Relationships>') }), 'docx_document')).reason === 'xml_cdata')
  check('inspector: DTD refused',
    (await inspectOoxml(docxLike({ rels: RELS_OK.replace('<Relationships', '<!DOCTYPE r [<!ENTITY x "y">]><Relationships') }), 'docx_document')).reason === 'xml_dtd')
  check('inspector: non-UTF-8 declared encoding refused',
    (await inspectOoxml(docxLike({ rels: RELS_OK.replace('encoding="UTF-8"', 'encoding="UTF-16"') }), 'docx_document')).reason === 'unsupported_encoding')
  check('inspector: duplicate normalized entry names refused',
    (await inspectOoxml(buildZip([
      { name: '[Content_Types].xml', data: CONTENT_TYPES },
      { name: '_rels/.rels', data: RELS_OK },
      { name: 'word/document.xml', data: DOC_XML },
      { name: 'word/Document.xml', data: '<hostile/>' },
    ]), 'docx_document')).reason === 'zip_duplicate_entry')
  check('inspector: central/local name disagreement refused',
    (await inspectOoxml(docxLike({ relsEntry: { localName: '_rels/.hidden' } }), 'docx_document')).reason === 'zip_name_mismatch')
  check('inspector: traversal entry name refused',
    (await inspectOoxml(docxLike({ extraEntries: [{ name: '../escape.xml', data: 'x' }] }), 'docx_document')).reason === 'zip_path_traversal')

  // ── the ACTUAL handler ────────────────────────────────────────────────────────────────────────
  handler = null
  await import(pathToFileURL(await bundle('supabase/functions/document-artifact-upload/index.ts', 'upload.mjs')).href)
  check('upload handler registered', typeof handler === 'function')

  const { renderProfileBDocument } = await import(pathToFileURL(path.join(root, 'agent-hub/workers/document-worker.ts')).href)
  const actualPdf = (await renderProfileBDocument({ kind: 'typst_document', template: 'report', title: 'PDF report',
    sections: [{ heading: 'Summary', body: 'A real registered PDF with the original source material.' }], line_items: [] })).bytes
  script.verifyResult = { data: { ok: true, kind: 'typst_document', workflow_id: randomUUID() }, error: null }
  script.rpcCalls.length = 0
  const pdfResponse = await handler(uploadRequest(actualPdf, { 'x-artifact-name': 'report.pdf' }))
  const pdfRegistration = script.rpcCalls.find((call) => call.name === 'document_register_artifact')
  check('real PDF is inspected and registered with server-bound PDF MIME/hash', pdfResponse.status === 200
    && pdfRegistration?.args.p_mime_type === 'application/pdf' && pdfRegistration.args.p_sha256 === sha256(actualPdf)
    && script.storageCalls.at(-1)?.contentType === 'application/pdf')
  script.rpcCalls.length = 0
  const disguisedPdf = await handler(uploadRequest(realDocx, { 'x-artifact-name': 'report.pdf' }))
  check('DOCX bytes disguised as PDF are refused before registration', disguisedPdf.status === 422
    && (await jsonOf(disguisedPdf))?.error?.code === 'PDF_INVALID'
    && !script.rpcCalls.some((call) => call.name === 'document_register_artifact'))
  check('PDF request with DOCX extension is refused',
    (await handler(uploadRequest(actualPdf, { 'x-artifact-name': 'report.docx' }))).status === 400)
  script.registerResult = { data: { ok: false, reason: 'stale_lease' }, error: null }
  const stalePdf = await handler(uploadRequest(actualPdf, { 'x-artifact-name': 'report.pdf' }))
  check('PDF publication remains fenced if lease expires after successful precheck',
    stalePdf.status === 409 && (await jsonOf(stalePdf))?.error?.reason === 'stale_lease')
  script.registerResult = null
  script.verifyResult = { data: { ok: true, kind: 'docx_document', workflow_id: randomUUID() }, error: null }
  script.rpcCalls.length = 0
  script.storageCalls.length = 0

  const goodBytes = docxLike()
  check('non-POST → 404', (await handler(new Request('https://x/u', { method: 'GET' }))).status === 404)
  const savedToken = ENV.NEMO_DOCUMENT_WORKER_TOKEN
  ENV.NEMO_DOCUMENT_WORKER_TOKEN = ''
  check('unconfigured → 503', (await handler(uploadRequest(goodBytes))).status === 503)
  ENV.NEMO_DOCUMENT_WORKER_TOKEN = savedToken
  check('bad bearer → 401', (await handler(uploadRequest(goodBytes, { authorization: 'Bearer nope' }))).status === 401)
  check('nonfinite epoch → 400', (await handler(uploadRequest(goodBytes, { 'x-lease-epoch': 'NaN' }))).status === 400)
  check('missing epoch → 400', (await handler(uploadRequest(goodBytes, { 'x-lease-epoch': null }))).status === 400)
  check('fractional size → 400', (await handler(uploadRequest(goodBytes, { 'x-artifact-size': '10.5' }))).status === 400)
  check('bad sha → 400', (await handler(uploadRequest(goodBytes, { 'x-artifact-sha256': 'xyz' }))).status === 400)
  check('traversal name → 400', (await handler(uploadRequest(goodBytes, { 'x-artifact-name': 'a..docx' }))).status === 400)
  check('declared oversize → 413', (await handler(uploadRequest(goodBytes, { 'content-length': String(65 * 1024 * 1024) }))).status === 413)

  script.rpcCalls.length = 0
  const wrongExt = await handler(uploadRequest(goodBytes, { 'x-artifact-name': 'report.pptx' }))
  check('kind↔extension mismatch → 400 (after precheck reveals kind)', wrongExt.status === 400)

  // chunked oversize: NO content-length header, the DECLARED size stays within the cap —
  // only the COUNTED streamed bytes can catch this
  const big = new Uint8Array(65 * 1024 * 1024)
  const chunkedBig = await handler(uploadRequest(big, { 'x-artifact-size': String(64 * 1024 * 1024) }, { chunked: true }))
  check('chunked oversize with legal declared size → 413 from the counted cap',
    chunkedBig.status === 413 && (await jsonOf(chunkedBig))?.error?.code === 'REQUEST_TOO_LARGE')

  const wrongSha = await handler(uploadRequest(goodBytes, { 'x-artifact-sha256': 'a'.repeat(64) }))
  check('declared vs actual hash mismatch → 400 HASH_MISMATCH',
    wrongSha.status === 400 && (await jsonOf(wrongSha))?.error?.code === 'HASH_MISMATCH')
  const wrongSize = await handler(uploadRequest(goodBytes, { 'x-artifact-size': String(goodBytes.byteLength + 1) }))
  check('declared vs actual size mismatch', wrongSize.status === 400 || wrongSize.status === 413)
  const badZip = await handler(uploadRequest(new Uint8Array(64).fill(7)))
  check('malformed ZIP → 422 OOXML_INVALID',
    badZip.status === 422 && (await jsonOf(badZip))?.error?.code === 'OOXML_INVALID')

  // happy path: canonical path in the storage call, registered path echoed back
  script.rpcCalls.length = 0
  script.storageCalls.length = 0
  const happy = await handler(uploadRequest(goodBytes))
  const happyBody = await jsonOf(happy)
  const expectedPath = `tenants/${ACCOUNT}/artifacts/${JOB}/1/${sha256(goodBytes)}-report.docx`
  check('happy path → 200 with canonical registered path',
    happy.status === 200 && happyBody?.ok === true && happyBody?.storage_path === expectedPath)
  check('storage upload used upsert:false and the canonical path',
    script.storageCalls[0]?.op === 'upload' && script.storageCalls[0]?.path === expectedPath && script.storageCalls[0]?.upsert === false)
  check('registration fence called with actual byte metadata',
    script.rpcCalls.some((c) => c.name === 'document_register_artifact' && c.args.p_sha256 === sha256(goodBytes)
      && c.args.p_size_bytes === goodBytes.byteLength))

  // existing object: verified-equal reuse vs conflict
  script.uploadResult = { data: null, error: { message: 'The resource already exists', statusCode: '409' } }
  script.downloadResult = { data: new Blob([goodBytes]), error: null }
  const reused = await handler(uploadRequest(goodBytes))
  check('existing object with EQUAL stored bytes → verified reuse, 200', reused.status === 200)
  script.downloadResult = { data: new Blob([new Uint8Array([1, 2, 3])]), error: null }
  script.rpcCalls.length = 0
  const conflicted = await handler(uploadRequest(goodBytes))
  check('existing object with DIFFERENT stored bytes → 409 STORAGE_CONFLICT, no registration',
    conflicted.status === 409 && (await jsonOf(conflicted))?.error?.code === 'STORAGE_CONFLICT'
    && !script.rpcCalls.some((c) => c.name === 'document_register_artifact'))
  script.uploadResult = { data: { path: 'x' }, error: null }
  script.downloadResult = null

  // fence refusal propagation + already:true passthrough of the REGISTERED (older) path
  script.registerResult = { data: { ok: false, reason: 'stale_lease' }, error: null }
  const stale = await handler(uploadRequest(goodBytes))
  check('registration stale_lease → 409 REGISTRATION_REFUSED',
    stale.status === 409 && (await jsonOf(stale))?.error?.reason === 'stale_lease')
  const olderPath = `tenants/${ACCOUNT}/artifacts/${JOB}/0/${'b'.repeat(64)}-report.docx`
  script.registerResult = { data: { ok: true, already: true, storage_path: olderPath }, error: null }
  const already = await handler(uploadRequest(goodBytes))
  const alreadyBody = await jsonOf(already)
  check('already:true returns the REGISTERED path, not this attempt path',
    already.status === 200 && alreadyBody?.already === true && alreadyBody?.storage_path === olderPath)
  script.registerResult = null
  const verifyRefused = { data: { ok: false, reason: 'stale_lease' }, error: null }
  const savedVerify = script.verifyResult
  script.verifyResult = verifyRefused
  check('advisory precheck refusal → 409 before any bytes', (await handler(uploadRequest(goodBytes))).status === 409)
  script.verifyResult = savedVerify

  // uppercase UUID headers are canonicalized: the storage path and every fence argument stay
  // lowercase, so registration always references the object that was actually stored
  script.rpcCalls.length = 0
  script.storageCalls.length = 0
  const upper = await handler(uploadRequest(goodBytes, {
    'x-account-id': ACCOUNT.toUpperCase(),
    'x-job-id': JOB.toUpperCase(),
    'x-claim-token': TOKEN.toUpperCase(),
  }))
  const upperBody = await jsonOf(upper)
  check('uppercase UUID headers → lowercase canonical path everywhere',
    upper.status === 200 && upperBody?.storage_path === expectedPath
    && script.storageCalls[0]?.path === expectedPath
    && ACCOUNT !== ACCOUNT.toUpperCase() // fixture really exercises canonicalization
    && script.rpcCalls.every((c) => c.args.p_account_id === ACCOUNT && c.args.p_job_id === JOB
      && c.args.p_claim_token === TOKEN))

  // deadline expiring BETWEEN steps that each individually resolve: delayed (but resolving)
  // precheck plus a slow body — the lazy bound()'s pre/post expiry guards make this a
  // deterministic 408 regardless of which race the last step wins
  script.verifyDelayMs = 250
  // NOTE: start() runs eagerly at Request construction, so the delay must exceed the WHOLE
  // budget (400ms) — chunk 2 then lands after expiry no matter how fast the other steps were
  const slowBody = new ReadableStream({
    async start(controller) {
      controller.enqueue(goodBytes.subarray(0, 10))
      await new Promise((resolve) => setTimeout(resolve, 550))
      controller.enqueue(goodBytes.subarray(10))
      controller.close()
    },
  })
  const slowRequest = new Request('https://x/document-artifact-upload', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${DOCUMENT_TOKEN}`,
      'x-account-id': ACCOUNT, 'x-job-id': JOB, 'x-claim-token': TOKEN, 'x-lease-epoch': '1',
      'x-artifact-name': 'report.docx', 'x-artifact-sha256': sha256(goodBytes),
      'x-artifact-size': String(goodBytes.byteLength),
    },
    body: slowBody,
    duplex: 'half',
  })
  script.rpcCalls.length = 0
  const expiredBetween = await handler(slowRequest)
  check('expiry BETWEEN resolving steps → 408, no registration',
    expiredBetween.status === 408 && !script.rpcCalls.some((c) => c.name === 'document_register_artifact'))
  script.verifyDelayMs = 0

  // abort wiring: the injected fetch attaches the shared AbortSignal. This mock cannot
  // prove real network cancellation (the stub client never uses the fetch) — it proves the
  // wrapper the real client WOULD use carries the signal.
  const savedFetch = globalThis.fetch
  let capturedInit = null
  globalThis.fetch = (_input, init) => { capturedInit = init; return Promise.resolve(new Response('{}')) }
  await script.clientOptions?.global?.fetch?.('https://stub.local/x', { method: 'POST' })
  globalThis.fetch = savedFetch
  check('injected fetch carries the shared AbortSignal', capturedInit?.signal instanceof AbortSignal)

  // stalled dependencies: each returns a bounded 408, and when the stalled call is RELEASED
  // afterwards, the expired handler still performs no registration (no dangling continuation)
  for (const stage of ['verify', 'upload', 'download', 'register']) {
    script.hang = stage
    if (stage === 'download') script.uploadResult = { data: null, error: { message: 'exists', statusCode: '409' } }
    script.rpcCalls.length = 0
    script.pending.length = 0
    const started = Date.now()
    const stalled = await handler(uploadRequest(goodBytes))
    const elapsed = Date.now() - started
    const registeredAt408 = script.rpcCalls.filter((c) => c.name === 'document_register_artifact').length
    // release the stalled promise NOW — a live continuation would call registration next
    script.pending.splice(0).forEach((release) => release())
    await new Promise((resolve) => setTimeout(resolve, 30))
    const registeredAfterRelease = script.rpcCalls.filter((c) => c.name === 'document_register_artifact').length
    check(`stalled ${stage} → bounded 408 (${elapsed}ms), no registration after release`,
      stalled.status === 408 && elapsed < 5_000
      && (stage === 'register' ? registeredAfterRelease === registeredAt408 : registeredAfterRelease === 0))
    script.hang = null
    script.uploadResult = { data: { path: 'x' }, error: null }
  }

  // DEFAULT budget path: Number('')===0 once clamped the default to ~100ms. With
  // absent/blank/whitespace/NaN budget a hung precheck must STILL be pending at 1s
  // (default 60s), not 408 within the regression window.
  for (const variant of [undefined, '', '   ', 'not-a-number']) {
    if (variant === undefined) delete ENV.DOCUMENT_UPLOAD_BUDGET_MS
    else ENV.DOCUMENT_UPLOAD_BUDGET_MS = variant
    script.hang = 'verify'
    script.pending.length = 0
    const probe = handler(uploadRequest(goodBytes))
    const state = await Promise.race([
      probe.then((r) => `settled:${r.status}`),
      new Promise((resolve) => setTimeout(() => resolve('pending'), 1_000)),
    ])
    check(`default upload budget with ${variant === undefined ? 'ABSENT' : JSON.stringify(variant)} env: hang survives the probe window (default budget, not the 100ms regression)`,
      state === 'pending', String(state))
    script.hang = null
    script.pending.splice(0).forEach((release) => release())
    await probe
  }
  ENV.DOCUMENT_UPLOAD_BUDGET_MS = '400'
} catch (error) {
  failed += 1
  console.error(`[FAIL] upload smoke crashed: ${error?.stack ?? error}`)
} finally {
  fs.rmSync(buildDir, { recursive: true, force: true })
}

if (failed) {
  console.error(`document-upload smoke: ${failed} check(s) failed`)
  process.exit(1)
}
console.log('document-upload smoke passed: inspector adversarial matrix, transport, deadline, storage reuse, fence propagation.')
