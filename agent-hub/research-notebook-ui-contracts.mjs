import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const hub = read('src/components/research/ResearchNotebookHub.tsx')
const app = read('src/App.tsx')
const layout = read('src/components/layout/AppLayout.tsx')
const desk = read('src/components/platform/SmartTaskDesk.tsx')
const translations = read('src/i18n/extra.ts')

assert.match(app, /path="research" element=\{<Navigate to="\/app" replace \/>\}/, 'legacy Research route must return to the unified chat')
assert.doesNotMatch(layout, /to: '\/app\/research'/, 'Research must not reappear as a separate navigation item')
assert.match(desk, /<ResearchNotebookHub initialFiles=\{attachments\} autoAnalyze \/>/, 'Research Hub must render as an in-chat file artifact')
assert.match(desk, /type="file" multiple accept=\{CHAT_FILE_ACCEPT\}/, 'main chat must expose its file picker')
assert.match(hub, /ResearchNotebookOutputSchema\.safeParse\(body\?\.analysis\)/, 'live responses must be validated by the canonical Zod schema')
assert.match(hub, /fetch\('\/api\/research\/analyze-multimodal'/, 'UI must call the product multimodal endpoint')
assert.match(hub, /Authorization: `Bearer \$\{token\}`/, 'multimodal analysis must use the authenticated session')
assert.match(hub, /accept="[^"]*\.mp3[^"]*\.mp4[^"]*\.pdf[^"]*\.txt/, 'source intake must expose the agreed media and document formats')
assert.match(hub, /functions\.invoke\('transcribe-file'/, 'audio and video files must enter the protected transcription pipeline')
assert.match(hub, /youtube\.com[\s\S]*youtu\.be/, 'YouTube input must validate supported hosts')
assert.match(hub, /key_decisions\.map/, 'meeting view must render decisions')
assert.match(hub, /action_items\.map/, 'meeting view must render action items')
assert.match(hub, /speaker_insights\.map/, 'meeting view must render speaker insights')
assert.match(hub, /speechSynthesis/, 'Audio Overview must provide real browser playback')
assert.match(hub, /setSelectedEvidence/, 'insights and timestamps must drive the Grounding Inspector')
for (const locale of ['extraUz', 'extraRu', 'extraEn']) assert.match(translations, new RegExp(`export const ${locale} = \\{[\\s\\S]*?"researchHub"`), `${locale} must include the Research Hub dictionary`)

console.log('[OK] Research Notebook UI: multimodal sources, meeting intelligence, audio overview and strict grounding')
