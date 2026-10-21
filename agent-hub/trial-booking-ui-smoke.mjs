// Mounted REAL component; MOCK Auth and fetch only. No real Auth/backend/model validation.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import esbuild from 'esbuild'
import puppeteer from 'puppeteer'
import assert from 'node:assert/strict'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'nemo-trial-ui-'))
const mock = path.join(temporary, 'mock.tsx')
fs.writeFileSync(mock, `import React from 'react';
const listeners=new Set(); const authListeners=new Set();
globalThis.fixture={user:'owner-a',calls:[],operation:null,failResult:false};
export function useAuth(){const [id,set]=React.useState(globalThis.fixture.user);React.useEffect(()=>{listeners.add(set);return()=>listeners.delete(set)},[]);return {user:{id}}}
export function useI18n(){return {lang:'en'}}
export const supabase={auth:{getSession:async()=>({data:{session:{user:{id:globalThis.fixture.user},access_token:'synthetic-token',expires_at:Math.floor(Date.now()/1000)+3600}},error:null}),onAuthStateChange:fn=>{authListeners.add(fn);return {data:{subscription:{unsubscribe:()=>authListeners.delete(fn)}}}}}};
globalThis.switchUser=()=>{globalThis.fixture.user='owner-b';for(const fn of authListeners)fn('SIGNED_IN',{user:{id:'owner-b'}});for(const fn of listeners)fn('owner-b')};
globalThis.fetch=async(url,options)=>{
 const f=globalThis.fixture;const name=String(url).split('/').at(-1);const args=JSON.parse(options.body||'{}');f.calls.push({name,args});
 if(options.signal?.aborted)throw new Error('aborted');
 const reply=value=>new Response(JSON.stringify(value),{status:200});
 if(String(url).includes('/users?'))return reply([{account_id:f.user==='owner-a'?'account-a':'account-b',role:'owner'}]);
 if(name==='trial_booking_schedule')return reply([{id:'slot-a',course_name:'Synthetic English',starts_at:'2030-09-10T10:00:00Z',timezone:'Asia/Tashkent',available:1,status:'scheduled'}]);
 if(name==='trial_booking_request'){f.operation={operation_id:'operation-a',approval_request_id:'approval-a',status:'waiting_for_approval',payload:{course_name:'Synthetic English',attendee_label:'Synthetic attendee'},booking_id:null};return reply(f.operation)}
 if(name==='trial_booking_decide'){f.operation.status='waiting_for_action';return reply(f.operation)}
 if(name==='trial_booking_execute'){f.operation.status='completed';f.operation.booking_id='booking-a';return reply({...f.operation})}
 if(name==='trial_booking_result'){if(f.failResult)return new Response('{}',{status:503});return reply(f.operation)}
 if(name==='trial_booking_recover')return reply(f.operation);
 if(name==='trial_booking_recent')return reply(args.p_account_id==='account-a'&&f.operation?[f.operation]:[]);
 throw new Error('unexpected mocked fetch '+name);
};`)
const entry = path.join(temporary, 'entry.tsx')
fs.writeFileSync(entry, `import React from 'react';import{createRoot}from'react-dom/client';import{TrialBookingChatCard}from${JSON.stringify(path.join(root, 'src/components/platform/TrialBookingChatCard.tsx'))};let mounted;globalThis.mount=()=>{mounted?.unmount();mounted=createRoot(document.getElementById('root'));mounted.render(<TrialBookingChatCard/>)};globalThis.mount();`)
await esbuild.build({ entryPoints: [entry], outfile: path.join(temporary, 'bundle.js'), bundle: true, format: 'iife', jsx: 'automatic', nodePaths: [path.join(root, 'node_modules')], logLevel: 'silent', define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.VITE_SUPABASE_URL': '"http://127.0.0.1:55431"', 'import.meta.env.VITE_SUPABASE_ANON_KEY': '"synthetic-anon"' }, plugins: [{ name: 'explicit-mocked-infrastructure', setup(build) { build.onResolve({ filter: /(?:AuthContext|\/i18n|\/lib\/supabase)$/ }, () => ({ path: mock })) } }] })
fs.writeFileSync(path.join(temporary, 'index.html'), '<div id="root"></div><script src="bundle.js"></script>')
const report = { kind: 'MOCK-mounted-ui-only', realAuth: false, realBackend: false, modelCalls: 0, checks: [] }
let browser
try {
  browser = await puppeteer.launch({ headless: true })
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.setRequestInterception(true)
  page.on('request', request => /^https?:/.test(request.url()) ? request.abort() : request.continue())
  await page.goto(pathToFileURL(path.join(temporary, 'index.html')).href)
  const waitIdle = () => page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent === 'Refresh schedule and state' && !b.disabled))
  const click = text => page.evaluate(label => { const button = [...document.querySelectorAll('button')].find(b => b.textContent === label); if (!button || button.disabled) throw new Error('button unavailable '+label); button.click() }, text)
  const count = name => page.evaluate(value => globalThis.fixture.calls.filter(c => c.name === value).length, name)
  const confirmed = () => page.evaluate(() => document.body.textContent.includes('Booking confirmed by reading'))
  await waitIdle()
  await page.select('select', 'slot-a')
  await click('Request approval'); await waitIdle()
  assert.equal(await count('trial_booking_request'), 1)
  await page.evaluate(() => { globalThis.fixture.failResult = true })
  await click('Approve and execute'); await waitIdle()
  assert.equal(await count('trial_booking_execute'), 1)
  assert.equal(await confirmed(), false)
  assert.ok(await page.$('[role=alert]'))
  report.checks.push('execute returned completed booking but failed readback shows error and never confirmation')
  await page.evaluate(() => { globalThis.fixture.failResult = false })
  await click('Refresh schedule and state'); await waitIdle()
  assert.equal(await confirmed(), true)
  assert.equal(await count('trial_booking_request'), 1)
  assert.equal(await count('trial_booking_execute'), 1)
  report.checks.push('retry reads existing operation without another request or execution')
  await page.evaluate(() => globalThis.mount()); await waitIdle()
  assert.equal(await confirmed(), true)
  assert.equal(await count('trial_booking_request'), 1)
  report.checks.push('remount restores saved operation and reads persisted confirmation')
  await page.evaluate(() => globalThis.switchUser())
  await page.waitForFunction(() => !document.body.textContent.includes('Booking confirmed by reading'))
  await waitIdle()
  assert.equal(await confirmed(), false)
  assert.equal(await page.evaluate(() => document.body.textContent.includes('booking-a')), false)
  report.checks.push('switch user removes old booking confirmation')
  assert.deepEqual(errors, [])
  report.status = 'passed'
} catch (error) { report.status = 'failed'; report.error = String(error.message); process.exitCode = 1 }
finally { await browser?.close() }
console.log(JSON.stringify(report, null, 2))
