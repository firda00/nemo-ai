// Сборка постов для Instagram из настоящих токенов бренда и настоящих скриншотов продукта.
//
// ПОЧЕМУ HTML + PLAYWRIGHT, А НЕ ГЕНЕРАЦИЯ КАРТИНОК МОДЕЛЬЮ.
//
//   1. Цвета и шрифт берутся из tailwind.config.js — те же, что в продукте. Сгенерированная
//      картинка «в фиолетовых тонах» каждый раз другая, и лента расползается по оттенкам.
//   2. Текст в макете — настоящий текст, а не то, что модель нарисовала похожим на буквы. На
//      узбекском и русском генераторы картинок врут в диакритике особенно охотно.
//   3. Это повторяемо и бесплатно: поправил строку — пересобрал всю ленту за секунды.
//
// ОБЕЩАНИЕ ОДНО НА ВСЕ ПОСТЫ: закрытая бета, запись в очередь. Оно обязано совпадать с тем, что
// человек увидит, перейдя по ссылке, — иначе весь трафик упирается в чужое обещание и уходит.
import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'

const OUT = path.resolve('content/posts')
const SHOTS = path.resolve('content/shots')

/* Токены — из tailwind.config.js, не «на глаз». */
const T = {
  bg: '#0A0D1C',
  panel: '#10162E',
  violet: '#8B7CF8',
  blue: '#5B7CF6',
  cyan: '#22D3EE',
  text: '#E6EAF2',
  muted: '#8A93A6',
}

/** Общая обвязка макета: фон, свечение, шрифт, нижняя плашка с призывом. */
const shell = (body, { cta = true, center = false } = {}) => `
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap');
  * { margin:0; padding:0; box-sizing:border-box; }
  body {
    width:1080px; height:1350px; background:${T.bg}; color:${T.text};
    font-family:Inter,'Segoe UI',system-ui,sans-serif; -webkit-font-smoothing:antialiased;
    display:flex; flex-direction:column; position:relative; overflow:hidden;
  }
  /* Мягкое свечение из фирменного градиента — то же, что на лендинге. */
  body::before {
    content:''; position:absolute; top:-380px; right:-280px; width:900px; height:900px;
    background:radial-gradient(circle, ${T.violet}33 0%, ${T.cyan}14 45%, transparent 70%);
  }
  body::after {
    content:''; position:absolute; bottom:-300px; left:-260px; width:760px; height:760px;
    background:radial-gradient(circle, ${T.cyan}1f 0%, transparent 68%);
  }
  .wrap { position:relative; z-index:1; flex:1; display:flex; flex-direction:column; padding:82px 78px; }
  .kicker { font-size:26px; font-weight:700; letter-spacing:.16em; text-transform:uppercase; color:${T.cyan}; }
  h1 { font-size:104px; line-height:.97; font-weight:800; letter-spacing:-.035em; margin-top:30px; }
  h1.small { font-size:82px; }
  .grad { background:linear-gradient(96deg, ${T.violet}, ${T.blue} 52%, ${T.cyan});
          -webkit-background-clip:text; background-clip:text; color:transparent; }
  .sub { font-size:35px; line-height:1.42; color:${T.muted}; margin-top:34px; max-width:820px; }
  .spacer { flex:1; }
  .cta { display:flex; align-items:center; gap:22px; padding-top:34px;
         border-top:1px solid ${T.text}1f; }
  .badge { font-size:24px; font-weight:800; letter-spacing:.1em; text-transform:uppercase;
           color:${T.bg}; background:linear-gradient(96deg, ${T.violet}, ${T.cyan});
           padding:13px 22px; border-radius:999px; }
  .cta-text { font-size:30px; color:${T.muted}; font-weight:500; }
  .logo { display:flex; align-items:center; gap:16px; }
  .logo-mark { width:52px; height:52px; border-radius:15px;
               background:linear-gradient(140deg, ${T.violet}, ${T.cyan}); }
  .logo-text { font-size:40px; font-weight:800; letter-spacing:-.02em; }
  .logo-text span { color:${T.cyan}; }
  .rows { display:flex; flex-direction:column; gap:22px; margin-top:52px; }
  .row { display:flex; align-items:center; gap:26px; background:${T.panel}cc;
         border:1px solid ${T.text}14; border-radius:22px; padding:30px 34px; }
  .num { width:56px; height:56px; flex:none; border-radius:16px; display:grid; place-items:center;
         font-size:28px; font-weight:800; color:${T.bg};
         background:linear-gradient(140deg, ${T.violet}, ${T.cyan}); }
  .row-text { font-size:33px; font-weight:600; }
  .row-sub { font-size:26px; color:${T.muted}; margin-top:7px; font-weight:400; }
  .shot { margin-top:44px; max-height:470px; border-radius:26px; overflow:hidden;
          border:1px solid ${T.text}1a; box-shadow:0 40px 90px #00000080; }
  .shot img { width:100%; display:block; }
  .chips { display:flex; flex-wrap:wrap; gap:18px; margin-top:52px; }
  .chip { font-size:31px; font-weight:600; padding:20px 32px; border-radius:999px;
          background:${T.panel}cc; border:1px solid ${T.text}1a; }
</style>
<div class="wrap">
  <div class="logo"><div class="logo-mark"></div><div class="logo-text">Nemo <span>AI</span></div></div>
  ${center ? '<div class="spacer"></div>' : ''}
  ${body}
  <div class="spacer"></div>
  ${cta ? `<div class="cta">
    <div class="badge">Yopiq beta</div>
    <div class="cta-text">Navbatga yozilish — nemoai.uz</div>
  </div>` : ''}
</div>`

/*
 * Посты. Узбекский — основной: у продукта это язык по умолчанию, и аудитория в Узбекистане.
 * Русские подписи идут в тексте поста, а не на картинке: две надписи на одном макете читаются хуже
 * одной, а перевод в подписи ничего не теряет.
 */
const POSTS = [
  {
    name: '01-nima',
    center: true,
    body: `
      <div class="kicker" style="margin-top:64px">AI-jamoa · kodsiz</div>
      <h1>Bitta jumla —<br><span class="grad">butun jamoa</span></h1>
      <div class="sub">Maqsadni yozing. Nemo uni subagentlarga bo‘lib, o‘zi bajaradi:
      tadqiqotchi, yozuvchi, tekshiruvchi.</div>`,
  },
  {
    name: '02-korinadi',
    body: `
      <div class="kicker" style="margin-top:64px">Farqi shunda</div>
      <h1 class="small">Kim nima qilganini<br><span class="grad">ko‘rasiz</span></h1>
      <div class="sub">Har bir subagent va har bir qadam — ochiq. Javob qayerdan
      kelganini taxmin qilish shart emas.</div>
      <div class="shot"><img src="../shots/11-trace-only.png"></div>`,
  },
  {
    name: '03-qadamlar',
    body: `
      <div class="kicker" style="margin-top:64px">To‘rt qadam</div>
      <h1 class="small">Qanday <span class="grad">ishlaydi</span></h1>
      <div class="rows">
        <div class="row"><div class="num">1</div><div><div class="row-text">Maqsadni yozing</div>
          <div class="row-sub">Nima kerakligini oddiy tilda ayting</div></div></div>
        <div class="row"><div class="num">2</div><div><div class="row-text">Jamoani tuzing</div>
          <div class="row-sub">Nemo rollar va vazifalarni o‘zi taklif qiladi</div></div></div>
        <div class="row"><div class="num">3</div><div><div class="row-text">Bilim va kanallarni ulang</div>
          <div class="row-sub">Fayllar, FAQ, Telegram, WhatsApp, Instagram</div></div></div>
        <div class="row"><div class="num">4</div><div><div class="row-text">Ishga tushiring</div>
          <div class="row-sub">Natijani ko‘ring va tuzating</div></div></div>
      </div>`,
  },
  {
    name: '04-kanallar',
    center: true,
    body: `
      <div class="kicker" style="margin-top:64px">Mijoz qayerda bo‘lsa</div>
      <h1 class="small">Jamoa <span class="grad">o‘sha yerda</span></h1>
      <div class="sub">Bitta jamoa — barcha kanallarda. Yozishmalar bir joyda to‘planadi.</div>
      <div class="chips">
        <div class="chip">Telegram</div><div class="chip">WhatsApp</div>
        <div class="chip">Instagram</div><div class="chip">Sayt vidjeti</div>
      </div>`,
  },
  {
    name: '05-navbat',
    center: true,
    body: `
      <div class="kicker" style="margin-top:64px">Hozircha yopiq</div>
      <h1 class="small">Navbatga <span class="grad">yoziling</span></h1>
      <div class="sub">Taklif kodi yo‘q bo‘lsa — email qoldiring. Joy ochilganda birinchi
      bo‘lib xabar beramiz. UZ / RU.</div>`,
  },
]

const browser = await chromium.launch()
await fs.mkdir(OUT, { recursive: true })
const made = []

for (const post of POSTS) {
  const html = shell(post.body, { center: post.center })
  // Файл кладётся РЯДОМ со снимками, чтобы относительная ссылка ../shots работала: Chromium не
  // читает file:// из другой папки без явного пути.
  const page$ = path.join(OUT, `${post.name}.html`)
  await fs.writeFile(page$, html)

  const context = await browser.newContext({ viewport: { width: 1080, height: 1350 }, deviceScaleFactor: 1 })
  const page = await context.newPage()
  await page.goto(`file://${page$.replace(/\\/g, '/')}`, { waitUntil: 'networkidle', timeout: 30_000 })
  // Шрифт подгружается с Google Fonts; без ожидания первый кадр уходит системным шрифтом.
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(400)

  const file = path.join(OUT, `${post.name}.png`)
  await page.screenshot({ path: file })
  await fs.unlink(page$)
  const { size } = await fs.stat(file)
  made.push(`${post.name}.png  1080×1350  ${Math.round(size / 1024)} КБ`)
  await context.close()
}

await browser.close()
console.log(made.join('\n'))
console.log(`\nПапка: ${OUT}`)
console.log(`Снимки продукта: ${SHOTS}`)
