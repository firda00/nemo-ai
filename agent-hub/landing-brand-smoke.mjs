import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { build, preview } from 'vite'
import puppeteer from 'puppeteer'
import config from './landing-harness/vite.config.mjs'

const out = path.resolve(process.env.NEMO_LANDING_EVIDENCE_DIR ?? 'agent-hub/artifacts/auth-latency-stage')
fs.mkdirSync(out, {recursive:true})
let server, browser, passed = 0
const errors = []
const check = (name, condition) => { assert(condition, name); passed++; console.log('[OK] '+name) }
try {
  await build({ ...config, configFile: false })
  server = await preview({ ...config, configFile: false, preview: { host: '127.0.0.1', port: 0 } })
  const url = 'http://127.0.0.1:'+server.httpServer.address().port+'/agent-hub/landing-harness/index.html'
  browser = await puppeteer.launch({headless:true,args:['--no-sandbox','--proxy-server=http://127.0.0.1:9','--proxy-bypass-list=localhost;127.0.0.1','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1']})
  for (const [lang, headline, formTitle, workflow] of [['ru','Поручите задачу.','Заявка на пилот','Запись на занятие с решением владельца'],['uz','Vazifani topshiring.','Pilotga ariza','Egasi tasdiqlashi bilan darsga yozilish'],['en','Delegate the work.','Request a pilot','Book a lesson with owner approval']]) {
    const page = await browser.newPage()
    page.on('pageerror',error=>errors.push(error.message))
    await page.setViewport({width:1440,height:900})
    await page.evaluateOnNewDocument(lang=>localStorage.setItem('nemo.lang',lang),lang)
    await page.goto(url,{waitUntil:'networkidle0'})
    check(lang+' headline renders',await page.$eval('h1',(el,expected)=>el.textContent.includes(expected),headline))
    check(lang+' desktop hero is two lines and action is visible',await page.evaluate(()=>{
      const title=document.querySelector('h1'),action=document.querySelector('main section a[href="/auth/signup"]')
      return title.getBoundingClientRect().height/parseFloat(getComputedStyle(title).lineHeight)<2.2&&action.getBoundingClientRect().bottom<innerHeight
    }))
    check(lang+' footer anchors resolve',await page.evaluate(()=>[...document.querySelectorAll('footer a[href*="#"]')].every(a=>document.getElementById(a.hash.slice(1)))))
    check(lang+' generated brand asset loads',await page.$eval('img[src*="studio-v2"]',image=>image.complete&&image.naturalWidth>0))
    check(lang+' verified trial workflow is visible in the page',await page.evaluate(title=>document.body.innerText.includes(title),workflow))
    if(lang==='ru') await page.screenshot({path:path.join(out,'after-desktop.png'),fullPage:false})
    if(lang==='ru') {
      await page.$eval('#workflow',el=>el.scrollIntoView({behavior:'instant',block:'start'}))
      const workflowSection = await page.$('#workflow')
      assert(workflowSection, 'workflow section exists for visual evidence')
      await workflowSection.screenshot({path:path.join(out,'workflow-desktop.png')})
      await page.evaluate(()=>window.scrollTo(0,0))
    }
    await page.setViewport({width:390,height:844})
    check(lang+' mobile page has no horizontal overflow',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1))
    if(lang==='ru') await page.screenshot({path:path.join(out,'after-mobile.png'),fullPage:false})
    await page.click('header button[aria-controls="marketing-mobile-menu"]')
    check(lang+' mobile menu has both login and signup',await page.evaluate(()=>Boolean(document.querySelector('#marketing-mobile-menu a[href="/auth"]')&&document.querySelector('#marketing-mobile-menu a[href="/auth/signup"]'))))
    await page.setViewport({width:320,height:740})
    check(lang+' narrow mobile menu controls do not overlap',await page.evaluate(()=>[...document.querySelectorAll('#marketing-mobile-menu button, #marketing-mobile-menu a[href^="/auth"]')].every(el=>{const r=el.getBoundingClientRect();return r.width>0&&el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))})))
    await page.setViewport({width:390,height:844})
    await page.click('#marketing-mobile-menu a[href="/auth"]')
    await page.waitForSelector('input[type=password]')
    check(lang+' login exposes Google and email/password',await page.evaluate(()=>Boolean(document.querySelector('input[type=email]')&&[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Google')))))
    await page.evaluate(()=>[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Google')).click())
    await page.waitForFunction(()=>globalThis.__authCalls?.includes('google'))
    check(lang+' preview Google cannot authenticate or redirect externally',new URL(page.url()).pathname==='/auth'&&await page.evaluate(()=>document.body.innerText.includes('Local preview')))
    await page.type('input[type=email]','synthetic@example.invalid')
    await page.type('input[type=password]','Synthetic-only-password-42')
    await page.click('button[type=submit]')
    await page.waitForFunction(()=>globalThis.__authCalls?.includes('password'))
    check(lang+' password reaches only the preview adapter',new URL(page.url()).pathname==='/auth')
    if(lang==='ru')await page.screenshot({path:path.join(out,'auth-mobile.png'),fullPage:true})
    await page.goto(url,{waitUntil:'networkidle0'})
    await page.click('main section a[href="/auth/signup"]')
    await page.waitForSelector('input[type=checkbox]')
    check(lang+' main action opens registration directly',new URL(page.url()).pathname==='/auth/signup'&&await page.$eval('button[type=submit]',b=>b.disabled))
    if(lang==='ru')await page.screenshot({path:path.join(out,'signup-mobile.png'),fullPage:true})
    await page.goto(url,{waitUntil:'networkidle0'})
    await page.click('main section a[href="/waitlist"]')
    await page.waitForFunction(expected=>document.body.innerText.includes(expected),{},formTitle)
    check(lang+' waitlist action opens the localized form',new URL(page.url()).pathname==='/waitlist')
    check(lang+' pilot page retains direct login and signup',await page.evaluate(()=>Boolean(document.querySelector('a[href="/auth"]')&&document.querySelector('a[href="/auth/signup"]'))))
    await page.$eval('form',form=>form.requestSubmit())
    check(lang+' empty form never submits',await page.evaluate(()=>!(globalThis.__waitlistCalls?.length)))
    await page.type('input[type=email]','synthetic@example.invalid')
    await page.type('input[autocomplete=organization]','Synthetic Nemo QA')
    await page.evaluate(()=>globalThis.__waitlistFail=true)
    await page.click('button[type=submit]')
    await page.waitForSelector('[role=alert]')
    check(lang+' failed submission keeps input and shows error',await page.$eval('input[type=email]',input=>input.value==='synthetic@example.invalid'))
    await page.evaluate(()=>globalThis.__waitlistFail=false)
    await page.click('button[type=submit]')
    await page.waitForFunction(()=>!document.querySelector('form'))
    check(lang+' explicit retry succeeds with mocked transport only',await page.evaluate(()=>globalThis.__waitlistCalls.length===2))
    if(lang==='ru') await page.screenshot({path:path.join(out,'waitlist-result.png'),fullPage:true})
    await page.close()
  }
  check('no browser runtime errors',errors.length===0)
  fs.writeFileSync(path.join(out,'browser-result.json'),JSON.stringify({passed,errors,externalNetworkBlocked:true,authAndWaitlistTransport:'mocked'},null,2))
} finally {
  if(browser)await browser.close()
  if(server)await new Promise(resolve=>server.httpServer.close(resolve))
}
