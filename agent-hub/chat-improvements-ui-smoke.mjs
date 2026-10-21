// Offline behavior: real SmartTaskDesk; synthetic Auth/SDK/factory. No live model or backend.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import puppeteer from 'puppeteer'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const out = path.join(root, 'agent-hub/artifacts/chat-improvements-20260914/ui')
fs.mkdirSync(out, { recursive: true })
if (fs.existsSync(path.join(out, 'results.json'))) fs.copyFileSync(path.join(out, 'results.json'), path.join(out, `results-${Date.now()}.json`))
const sources = ['src/components/platform/SmartTaskDesk.tsx', 'src/components/chat/AttachmentPreview.tsx', 'src/lib/chatDiscovery.ts', 'src/lib/chatSession.ts', 'agent-hub/chat-improvements-ui-smoke.mjs', 'agent-hub/chat-improvements-harness/factory.ts', 'agent-hub/chat-improvements-harness/scope.ts']
const hashes = () => Object.fromEntries(sources.map(p => [p, crypto.createHash('sha256').update(fs.readFileSync(path.join(root,p))).digest('hex')]))
const before = hashes(), checks = [], errors = []
await build({ entryPoints: [path.join(root,'agent-hub/frontier-chat-harness/entry.tsx')], outfile: path.join(out,'harness.js'), bundle:true, format:'iife', jsx:'automatic', logLevel:'silent', define:{'process.env.NODE_ENV':'"production"','import.meta.env':'{}'}, plugins:[{ name:'offline',setup(b) {
  b.onResolve({filter:/(?:supabase|AuthContext|chatEntityFactory|chatScope)$/},args=>{
    const p=path.resolve(args.resolveDir,args.path)
    const replacements={
      [path.join(root,'src/lib/supabase')]:'agent-hub/frontier-chat-harness/mock-supabase.ts',
      [path.join(root,'src/context/AuthContext')]:'agent-hub/frontier-chat-harness/mock-auth.ts',
      [path.join(root,'src/lib/chatEntityFactory')]:'agent-hub/chat-improvements-harness/factory.ts',
      [path.join(root,'src/lib/chatScope')]:'agent-hub/chat-improvements-harness/scope.ts',
    }
    if(replacements[p]) return {path:path.join(root,replacements[p])}
  })
}}] })
fs.writeFileSync(path.join(out,'index.html'), '<!doctype html><meta charset="utf-8"><div id="root"></div><script src="harness.js"></script>')
let browser,page
const check=(name,condition)=>{assert(condition,name);checks.push(name);console.log('[OK] '+name)}
const text=()=>page.evaluate(()=>document.body.innerText)
const wait=t=>page.waitForFunction(t=>document.body.innerText.includes(t),{timeout:10000},t)
const calls=()=>page.evaluate(()=>globalThis.__frontierCalls)
const send=async t=>{await page.type('textarea',t);await page.keyboard.press('Enter')}
const fresh=async()=>{
  await page.goto(new URL('file:///'+path.join(out,'index.html').replaceAll('\\','/')).href)
  await page.waitForFunction(()=>globalThis.__frontierReady)
  await page.evaluate(()=>{localStorage.clear();sessionStorage.clear();localStorage.setItem('nemo.lang','ru');globalThis.__mountFrontierDesk()})
  await page.waitForSelector('textarea')
}
try {
  browser=await puppeteer.launch({headless:true,args:['--no-sandbox','--proxy-server=http://127.0.0.1:9','--host-resolver-rules=MAP * ~NOTFOUND']})
  page=await browser.newPage();await page.setRequestInterception(true)
  page.on('request',r=>void(r.url().startsWith('file://')?r.continue():r.abort()))
  page.on('pageerror',e=>errors.push(e.message))
  await fresh()
  for(const question of ['что ты умешь','какие у тебя возможности','что умеет Nemo']) {
    await send(question);await wait('Что умеет Nemo')
    await page.waitForFunction(()=>document.querySelector('textarea').value==='')
  }
  check('three Russian capability variants use zero model calls',(await calls()).length===0)
  check('capabilities distinguish required connections',(await text()).includes('требуют подключения'))
  await fresh();await send('Создай команду для проверки текстов');await wait('С какими каналами')
  await send('что ты умеешь');await wait('Что умеет Nemo')
  await send('Telegram');await page.waitForFunction(()=>globalThis.__creationPrompts?.length===1)
  const intake=await page.evaluate(()=>globalThis.__creationPrompts[0])
  check('capability interruption preserves supplied goal and team format',intake.includes('проверки текстов')&&intake.includes('Telegram')&&!intake.includes('Цель: что ты умеешь'))
  check('intake never invokes a model in this fixture',(await calls()).length===0)
  await fresh();await send('Создай команду для проверки текстов в Telegram');await page.waitForFunction(()=>globalThis.__creationPrompts?.length===1)
  check('complete initial request skips redundant intake questions',!(await text()).includes('Начнём с цели')&&!(await text()).includes('С какими каналами'))
  await fresh();await send('Объясни, как создать команду для проверки текстов в Telegram');await wait('MOCK-REPLY-1')
  check('explanation about creation does not create a team',await page.evaluate(()=>!globalThis.__creationPrompts?.length))
  await fresh();await send('Создай команду для проверки текстов');await wait('С какими каналами');await send('Отмена')
  await page.waitForFunction(()=>document.querySelector('textarea').value==='')
  check('cancel during source question does not create a team',await page.evaluate(()=>!globalThis.__creationPrompts?.length))
  await fresh()
  await page.evaluate(async()=>{const c=document.createElement('canvas');c.width=2;c.height=2;const blob=await new Promise(resolve=>c.toBlob(resolve,'image/png'));const d=new DataTransfer();d.items.add(new File([blob],'pasted.png',{type:'image/png'}));d.setData('text/plain','Текст вместе с картинкой');document.querySelector('textarea').dispatchEvent(new ClipboardEvent('paste',{clipboardData:d,bubbles:true,cancelable:true}))})
  await wait('pasted.png')
  await page.waitForFunction(()=>[...document.querySelectorAll('img')].some(i=>i.src.startsWith('blob:')&&i.complete&&i.naturalWidth===2))
  check('pasted valid image renders a local object URL preview',await page.$eval('textarea',t=>t.value.includes('Текст вместе с картинкой')))
  check('image paste creates one removable attachment',await page.$$eval('button[aria-label]',bs=>bs.filter(b=>b.getAttribute('aria-label').includes('Удалить')).length===1))
  await page.evaluate(()=>{[...document.querySelectorAll('button[aria-label]')].find(b=>b.getAttribute('aria-label').includes('Удалить')).click()})
  await page.waitForFunction(()=>!document.body.innerText.includes('pasted.png'))
  check('attachment removal removes the pasted image',!(await text()).includes('pasted.png'))
  check('ordinary text paste is not prevented',await page.evaluate(()=>{const d=new DataTransfer();d.setData('text/plain','text');return document.querySelector('textarea').dispatchEvent(new ClipboardEvent('paste',{clipboardData:d,bubbles:true,cancelable:true}))}))
  await page.evaluate(()=>{const d=new DataTransfer();for(let i=0;i<8;i++)d.items.add(new File(['x'],`limit-${i}.png`,{type:'image/png'}));document.querySelector('textarea').dispatchEvent(new ClipboardEvent('paste',{clipboardData:d,bubbles:true,cancelable:true}))})
  await page.waitForSelector('[role=alert]')
  check('paste overflow shows an error and retains only four files',await page.$$eval('button[aria-label]',bs=>bs.filter(b=>b.getAttribute('aria-label').includes('Удалить')).length===4))
  await fresh()
  for(let i=0;i<12;i++){await send(i===0?'Меня зовут Синтетический Ученик.':'Продолжи объяснение номер '+i);await wait('MOCK-REPLY-'+(i+1))}
  const final=(await calls()).at(-1)
  check('fast chat retains early supplied context after twelve user turns',final.body.messages.some(m=>typeof m.content==='string'&&m.content.includes('Синтетический Ученик')))
  const reload=async(account)=>{await page.reload();await page.waitForFunction(()=>globalThis.__frontierReady);await page.evaluate(account=>{globalThis.__syntheticAccount=account;globalThis.__mountFrontierDesk()},account);await page.waitForSelector('textarea')}
  await reload();await wait('Синтетический Ученик')
  check('page reload restores fast transcript without automatically calling model',(await calls()).length===0)
  await send('Повтори имя');await wait('MOCK-REPLY-1')
  check('next fast request carries restored early context',(await calls()).at(-1).body.messages.some(m=>typeof m.content==='string'&&m.content.includes('Синтетический Ученик')))
  await fresh();await page.select('select[aria-label="Модель для ответов"]','gpt-6-astra');await page.select('select[aria-label="Глубина рассуждения"]','high')
  await send('Синтетический секретный контекст A');await wait('MOCK-REPLY-1');await reload();await wait('Синтетический секретный контекст A')
  check('frontier reload preserves selection and effort with no automatic request',(await calls()).length===0&&await page.$eval('select[aria-label="Модель для ответов"]',s=>s.value==='gpt-6-astra')&&await page.$eval('select[aria-label="Глубина рассуждения"]',s=>s.value==='high'))
  await send('Продолжи');await wait('MOCK-REPLY-1')
  check('frontier next request reuses opaque continuation fixture',(await calls()).at(-1).body.continuation==='MOCK_CONTINUATION_1')
  await page.evaluate(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Новый контекст'));if(!b)throw new Error('reset button missing');b.click()})
  await reload();await send('После сброса');await wait('MOCK-REPLY-1')
  check('explicit context reset survives immediate reload',!('continuation' in (await calls()).at(-1).body))
  await page.evaluate(()=>globalThis.__setFrontierUser({id:'user-b',email:'b@example.invalid'}))
  await page.waitForFunction(()=>document.querySelector('select[aria-label="Модель для ответов"]')?.value==='fast')
  check('user B cannot see A transcript',!(await text()).includes('Синтетический секретный контекст A'))
  await page.select('select[aria-label="Модель для ответов"]','gpt-6-astra');await send('Сообщение пользователя B');await wait('MOCK-REPLY-2')
  check('user B request does not inherit A continuation',!('continuation' in (await calls()).at(-1).body))
  await page.evaluate(()=>{globalThis.__frontierMode='hold'})
  await send('Ожидающий ответ B');await page.waitForFunction(()=>globalThis.__frontierCalls.length===3)
  await page.evaluate(()=>globalThis.__setFrontierUser({id:'user-c',email:'c@example.invalid'}))
  await page.waitForFunction(()=>document.querySelector('select[aria-label="Модель для ответов"]')?.value==='fast')
  await page.evaluate(()=>globalThis.__frontierPending[3]('LATE-PRIVATE-REPLY'))
  await page.waitForFunction(()=>globalThis.__frontierCalls[2].aborted)
  check('identity switch aborts pending call and hides its late reply',!(await text()).includes('LATE-PRIVATE-REPLY'))
  await fresh();await send('Контекст организации A');await wait('MOCK-REPLY-1')
  await page.evaluate(()=>{globalThis.__syntheticAccount='account-b'})
  await send('Нельзя отправить в другую организацию');await wait('Рабочее пространство изменилось')
  check('account change before send blocks the model call',(await calls()).length===1)
  await reload('account-b')
  check('same user in organization B does not restore organization A transcript',!(await text()).includes('Контекст организации A')&&(await calls()).length===0)
  await send('Сообщение организации B');await wait('MOCK-REPLY-1')
  check('organization B does not send organization A history',!(await calls()).at(-1).body.messages.some(m=>typeof m.content==='string'&&m.content.includes('Контекст организации A')))
  await fresh();await send('Сохранённый разговор рядом с документом');await wait('MOCK-REPLY-1')
  await page.evaluate(()=>localStorage.setItem('nemo.documentJobs.job.user-1.synthetic-restored',JSON.stringify({at:Date.now(),v:JSON.stringify({submissionId:'synthetic-restored',jobId:'cd55c5de-5555-4555-8555-5555555def55',kind:'docx_document',title:'Synthetic restored document',brief:'Synthetic brief',briefComplete:true})})))
  await reload();await wait('Сохранённый разговор рядом с документом');await wait('Synthetic restored document')
  await page.waitForFunction(()=>globalThis.__docCalls.some(c=>c.action==='status'))
  check('document recovery merges with restored transcript without regeneration',(await calls()).length===0&&await page.evaluate(()=>globalThis.__docCalls.every(c=>c.action!=='enqueue')))
  check('no browser runtime errors',errors.length===0)
} catch(e) { errors.push(e.stack??String(e));process.exitCode=1 }
finally {
  const after=hashes()
  if(JSON.stringify(before)!==JSON.stringify(after)){errors.push('SOURCE_CHANGED_DURING_RUN');process.exitCode=1}
  fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({mode:'offline-model-auth-factory-scope-substitutions',checks,errors,sourceBefore:before,sourceAfter:after,notCovered:['real Auth or profile scope lookup','real LLM','OS clipboard integration','trial operation states','server continuation cryptography']},null,2))
  await browser?.close()
}
