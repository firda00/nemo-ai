// Actual React dashboard + styles + client/normalizer/engine. All auth/model/transport are
// injected locally; Chrome has a dead external proxy and localhost is the only bypass.
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { build, preview } from 'vite'
import react from '@vitejs/plugin-react'
import puppeteer from 'puppeteer'

const root=process.cwd(),out=path.resolve('agent-hub/artifacts/cashflow-period-stage/browser')
fs.mkdirSync(out,{recursive:true})
const csv=path.join(out,'cashflow.csv'),bad=path.join(out,'invalid-date.csv')
fs.writeFileSync(csv,'date;type;amount;status;description;account;fromaccount;toaccount\n2026-08-01;income;100.01;posted;REAL_INCOME;main;;\n2026-08-02;expense;10.02;posted;REAL_EXPENSE;main;;\n2026-07-31;income;9999;posted;OUTSIDE_MARKER;main;;\n2026-08-03;expense;800;pending;PENDING_MARKER;main;;\n2026-08-04;expense;500;reversed;REVERSED_MARKER;main;;\n2026-08-20;transfer;25;posted;REAL_TRANSFER;;main;reserve')
fs.writeFileSync(bad,'date;type;amount\n2026-02-30;income;999')
const config={root,configFile:false,envFile:false,cacheDir:path.join(out,'vite-cache'),plugins:[react(),{name:'finance-mocks',enforce:'pre',resolveId(source,importer){
  if(!importer||!source.startsWith('.'))return
  const target=path.resolve(path.dirname(importer.split('?')[0]),source).replaceAll('\\','/')
  if(['src/lib/supabase','src/context/AuthContext','src/store/useAgentStore','src/components/finance/ProductMarginPanel'].some(p=>target===path.join(root,p).replaceAll('\\','/')))return path.join(root,'agent-hub/finance-harness/mocks.tsx')
},load(id){if(id.replaceAll('\\','/')===path.join(root,'src/index.css').replaceAll('\\','/'))return fs.readFileSync(id,'utf8').replace(/^@import url\([^\n]+\);\r?\n/m,'')}}],build:{outDir:path.join(out,'build'),emptyOutDir:true,rollupOptions:{input:path.join(root,'agent-hub/finance-harness/index.html')}},preview:{host:'127.0.0.1',port:0}}
let browser,server,page,passed=0
const runtime=[]
const check=(name,condition)=>{assert(condition,name);passed++;console.log('[OK] '+name)}
try{
  await build(config)
  server=await preview(config)
  const port=server.httpServer.address().port
  browser=await puppeteer.launch({headless:true,args:['--no-sandbox','--proxy-server=http://127.0.0.1:9','--proxy-bypass-list=localhost;127.0.0.1','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1']})
  page=await browser.newPage();await page.setViewport({width:1280,height:1000});await page.emulateTimezone('America/Los_Angeles')
  page.on('pageerror',error=>runtime.push(error.message))
  await page.goto(`http://127.0.0.1:${port}/agent-hub/finance-harness/index.html`)
  await page.waitForFunction(()=>globalThis.__financeReady)
  await page.evaluate(()=>{localStorage.setItem('nemo.lang','ru');globalThis.__mountFinance()})
  const waitText=text=>page.waitForFunction(value=>document.body.innerText.includes(value),{},text)
  const body=()=>page.evaluate(()=>document.body.innerText)
  const set=async(selector,value)=>{await page.$eval(selector,(el,value)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}))},value)}
  const click=async text=>{await page.evaluate(text=>{const button=[...document.querySelectorAll('button')].find(b=>b.textContent.includes(text));if(!button)throw new Error('Missing button '+text);button.click()},text)}
  const upload=async file=>{await (await page.$('input[type=file]')).uploadFile(file);await waitText(path.basename(file))}
  await waitText('Демо-данные')
  await set('input[type=month]','2026-08');await upload(csv);await click('Проанализировать');await waitText('REAL_INCOME')
  check('server-selected rows replace preview and exclude pending/reversed/outside sources',!(await body()).includes('Atlas Learning')&&!(await body()).includes('OUTSIDE_MARKER')&&!(await body()).includes('PENDING_MARKER')&&!(await body()).includes('REVERSED_MARKER'))
  check('monthly request uses explicit Tashkent boundaries in a Los Angeles browser',await page.evaluate(()=>{const p=globalThis.__financeCalls.at(-1).input.period;return p.from==='2026-08-01T00:00:00+05:00'&&p.to==='2026-09-01T00:00:00+05:00'}))
  check('actual rows retain minor-unit precision and internal transfers are distinct',(await body()).includes('100,01')&&(await body()).includes('10,02')&&(await body()).includes('↔'))
  check('selection explains all six source rows',(await body()).includes('Включено: 3/6')&&(await body()).includes('Вне периода: 1')&&(await body()).includes('Ожидают проведения: 1')&&(await body()).includes('Отменены: 1'))
  await page.screenshot({path:path.join(out,'monthly-desktop.png'),fullPage:true})
  await page.select('select','day');await set('input[type=date]','2026-08-02');await set('input[inputmode=decimal]','123,45')
  check('changed inputs visibly mark the old result',(await body()).includes('Показан предыдущий результат'))
  await click('Проанализировать');await page.waitForFunction(()=>document.body.innerText.includes('Включено: 1/6')&&!document.body.innerText.includes('Показан предыдущий результат'))
  check('daily report uses exact opening balance and shows only the chosen day',await page.evaluate(()=>{const input=globalThis.__financeCalls.at(-1).input;return input.opening_balance_minor===12345&&input.period.from==='2026-08-02T00:00:00+05:00'&&input.period.to==='2026-08-03T00:00:00+05:00'&&!document.body.innerText.includes('REAL_INCOME')}))
  await page.setViewport({width:390,height:844});await page.screenshot({path:path.join(out,'daily-mobile.png'),fullPage:true})
  check('mobile layout contains overflow inside the transaction table',await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+2))
  await page.setViewport({width:1280,height:1000})
  await page.evaluate(()=>globalThis.__financeMode='hold');await click('Проанализировать');await page.waitForFunction(()=>globalThis.__financeHeld.length===1)
  await set('input[type=date]','2026-08-03');await page.evaluate(()=>globalThis.__financeHeld.shift()())
  await page.waitForFunction(()=>document.body.innerText.includes('Показан предыдущий результат'))
  check('late response cannot apply after the selected period changes',await page.evaluate(()=>document.querySelector('input[type=date]').value==='2026-08-03'&&globalThis.__financeCalls.at(-1).signal.aborted))
  await page.evaluate(()=>globalThis.__financeMode='normal');await upload(bad);await click('Проанализировать');await waitText('Источник прочитан не полностью')
  check('bad source prevents a partial result with a visible repair message',(await body()).includes('INVALID_DATE'))
  await page.screenshot({path:path.join(out,'invalid-source.png'),fullPage:true})
  await page.evaluate(()=>{globalThis.__setFinanceUser('u2');globalThis.__financeMode='normal'})
  await waitText('Демо-данные');check('identity switch clears source files and prior live rows',!(await body()).includes('cashflow.csv')&&!(await body()).includes('REAL_EXPENSE'))
  await upload(csv);await set('input[type=month]','2026-08');await page.evaluate(()=>globalThis.__financeMode='hold');await click('Проанализировать');await page.waitForFunction(()=>globalThis.__financeHeld.length===1)
  await page.evaluate(()=>globalThis.__setFinanceUser('u1'));await waitText('Демо-данные');await page.evaluate(()=>globalThis.__financeHeld.shift()())
  check('late result cannot repopulate another session',!(await body()).includes('REAL_INCOME')&&!(await body()).includes('cashflow.csv'))
  await page.evaluate(()=>{globalThis.__holdFinanceRead=true;globalThis.__financeMode='normal'})
  await (await page.$('input[type=file]')).uploadFile(csv);await page.waitForFunction(()=>globalThis.__financeHeldReads.length===1)
  await click('Сбросить демо');await page.evaluate(async()=>{globalThis.__holdFinanceRead=false;await globalThis.__financeHeldReads.shift()()})
  check('late file reading cannot repopulate a reset draft',!(await body()).includes('cashflow.csv'))
  for(const[lang,title,scopeText]of[['uz','Pul oqimi','Toshkent vaqti'],['en','Cash flow','Tashkent time']]){
    await page.evaluate(lang=>{localStorage.setItem('nemo.lang',lang);globalThis.__mountFinance()},lang);await waitText(title);check(lang+' period explanations render',(await body()).includes(scopeText))
  }
  check('no runtime errors',runtime.length===0)
  fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({passed,runtimeErrors:runtime,mocks:true,externalNetworkBlocked:true},null,2)+'\n')
}finally{if(browser)await browser.close();if(server)await new Promise(resolve=>server.httpServer.close(resolve))}
