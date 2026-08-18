// Контракты окружения: docker-compose и Dockerfile.
//
// ЭТИ ФАЙЛЫ НЕ ЗАПУСКАЛИСЬ. Docker в среде разработки не установлен, поэтому `docker compose up` и
// `docker build` не выполнялись ни разу. Всё, что можно проверить без них, проверяется здесь — и
// проверяется РАЗБОРОМ, а не поиском подстрок: отступ на пробел меняет смысл YAML молча, а регэксп
// по тексту этого не видит.
//
// Что именно тут ловится и почему это стоит отдельного файла:
//
//   — ссылки между сервисами (сеть, том, depends_on) — опечатка в имени даёт контейнер, который
//     поднимается и не видит соседа, а выглядит это как сетевая проблема;
//   — REDIS_URL по ИМЕНИ СЕРВИСА, а не на localhost: внутри контейнера 127.0.0.1 указывает на него
//     самого, и шлюз молча уходит в режим опроса;
//   — Dragonfly не опубликован наружу: Redis-совместимые базы не требуют пароля по умолчанию, и
//     открытый порт на публичном адресе находят сканерами за часы;
//   — в образ шлюза не копируется лишнее: `COPY . .` утащил бы .secrets.local внутрь образа.

import fs from 'node:fs'
import path from 'node:path'
import { parse } from 'yaml'

const root = path.resolve(import.meta.dirname, '..')
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8')

/**
 * Dockerfile БЕЗ комментариев — для отрицательных утверждений.
 *
 * Ровно та же ловушка, что уже ловила контракты V5, и здесь она сработала в третий раз: строка
 * «npm ci, а не npm install» — это ОБЪЯСНЕНИЕ, почему install не используется, и проверка «в файле нет
 * npm install» падала на собственной документации. Отрицания обязаны смотреть на инструкции, а не на
 * прозу вокруг них.
 */
const instructions = (dockerfile) => dockerfile
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('#'))
  .join('\n')

const compose = parse(read('docker-compose.yml'))
const dockerApi = read('infra/docker/Dockerfile.api')
const dockerWorker = read('infra/docker/Dockerfile.worker')
const dockerVoice = read('infra/docker/Dockerfile.voice')
const packageJson = read('package.json')
const qualityGate = read('agent-hub/quality-gate.ps1')

const services = compose.services ?? {}
const gateway = services['nemo-api-gateway'] ?? {}
const worker = services['sdr-worker'] ?? {}
const voice = services['voice-worker'] ?? {}
const dragonfly = services.dragonfly ?? {}

/** Значение переменной окружения из списка вида ['KEY=value']. */
const envOf = (service, key) => (service.environment ?? [])
  .map(String).find((one) => one.startsWith(`${key}=`))?.slice(key.length + 1)

const cases = [
  // ── Ссылки между сервисами ────────────────────────────────────────────────────────────────────
  ['all four services exist',
    ['dragonfly', 'nemo-api-gateway', 'sdr-worker', 'voice-worker'].every((name) => name in services)],

  /*
   * Порт голосового воркера НЕ опубликован наружу.
   *
   * На него ходит FreeSWITCH, который ставится рядом. Открытый в интернет WebSocket без аутентификации
   * означает, что кто угодно может подать управляющее сообщение ANSWER и заставить систему говорить
   * от имени компании — и платить за модель.
   */
  ['the voice worker port is not published to every interface',
    (voice.ports ?? []).every((entry) => String(entry).startsWith('127.0.0.1:'))],

  /*
   * Модель Silero скачивается НА ЭТАПЕ СБОРКИ и проверяется контрольной суммой.
   *
   * Не при первом звонке: докачивать модель, когда человек уже снял трубку, значит подарить ему
   * секунды тишины. Сумма обязательна, потому что битая модель не падает — она молча выдаёт мусорные
   * вероятности, и выглядит это как «VAD плохо работает».
   */
  ['the Silero model is fetched at build time and checksum-verified',
    dockerVoice.includes('silero_vad.onnx') && dockerVoice.includes('sha256sum -c -')
    && dockerVoice.includes(read('agent-hub/telephony/vad.ts').match(/SILERO_MODEL_SHA256 = '([0-9a-f]{64})'/)[1])],

  ['every service joins the declared bridge network',
    Object.values(services).every((service) => (service.networks ?? []).every((net) => net in (compose.networks ?? {})))
    && compose.networks?.nemo_net?.driver === 'bridge'
    && Object.values(services).every((service) => (service.networks ?? []).includes('nemo_net'))],

  /*
   * Тома объявлены. Проверка через `in`, а НЕ через истинность значения.
   *
   * `dragonfly_data:` без опций разбирается как null — законное сокращение compose. Первая версия этой
   * проверки писала `!doc.volumes[name]` и объявляла объявленный том необъявленным.
   */
  ['named volumes are declared',
    Object.values(services).every((service) => (service.volumes ?? [])
      .map((entry) => String(entry).split(':')[0])
      .filter((name) => !/^[./]/.test(name))
      .every((name) => name in (compose.volumes ?? {})))
    && 'dragonfly_data' in (compose.volumes ?? {})],

  // Без service_healthy шлюз стартует раньше готовности Dragonfly, получает отказ соединения и уходит
  // в режим опроса на весь свой срок жизни — при живой очереди рядом.
  ['gateway and worker wait for a healthy Dragonfly',
    gateway.depends_on?.dragonfly?.condition === 'service_healthy'
    && worker.depends_on?.dragonfly?.condition === 'service_healthy'
    && Array.isArray(dragonfly.healthcheck?.test)],

  // Внутри своей сети контейнер видит соседа ПО ИМЕНИ. localhost указывал бы на него самого, и шлюз
  // молча работал бы без очереди.
  ['services reach Dragonfly by service name, never localhost',
    envOf(gateway, 'REDIS_URL') === 'redis://dragonfly:6379'
    && envOf(worker, 'REDIS_URL') === 'redis://dragonfly:6379'],

  /*
   * Dragonfly НЕ опубликован на все интерфейсы.
   *
   * Redis-совместимые базы по умолчанию без аутентификации. '6379:6379' на сервере с публичным адресом
   * означает базу, открытую интернету; такие находят сканерами за часы. Шлюзу и воркеру наружный порт
   * не нужен вовсе — они ходят по внутренней сети.
   */
  ['Dragonfly is not published to every interface',
    (dragonfly.ports ?? []).every((entry) => String(entry).startsWith('127.0.0.1:'))],

  // Снапшот: очередь сигнальная и её потеря не теряет задач, но перезапуск с пустой памятью дал бы
  // всплеск опроса базы всеми воркерами разом.
  ['Dragonfly persists to the mounted volume',
    String(dragonfly.command ?? '').includes('--dir /data')
    && (dragonfly.volumes ?? []).some((entry) => {
      const [source, target] = String(entry).split(':')
      // Именно ОБЪЯВЛЕННЫЙ том, а не любой путь: './tmp:/data' тоже оканчивается на ':/data', но
      // переживает перезапуск только пока цел каталог на хосте, и в другой среде его не будет вовсе.
      return target === '/data' && source in (compose.volumes ?? {})
    })
    && String(dragonfly.command ?? '').includes('--snapshot_cron')],

  // Latest означает, что пересборка через полгода поднимет другую версию базы, и выяснится это в
  // production.
  ['image versions are pinned, never latest',
    typeof dragonfly.image === 'string' && dragonfly.image.includes(':') && !dragonfly.image.endsWith(':latest')],

  // ── Секреты не зашиты ────────────────────────────────────────────────────────────────────────
  ['no secret is hardcoded in compose',
    Object.values(services).every((service) => (service.environment ?? []).map(String).every((entry) => {
      const [key, ...rest] = entry.split('=')
      const value = rest.join('=')
      const secretish = /KEY|TOKEN|SECRET|PEPPER|PASSWORD/i.test(key)
      // Значение обязано приходить подстановкой ${...}, а не лежать текстом.
      return !secretish || value === '' || value.startsWith('${')
    }))],

  // Перец обязан быть у шлюза: без него он отвечает 503 на каждый запрос и не стартует.
  ['the gateway receives the token pepper and Supabase credentials',
    envOf(gateway, 'NEMO_TOKEN_PEPPER')?.startsWith('${')
    && envOf(gateway, 'SUPABASE_URL')?.startsWith('${')
    && envOf(gateway, 'SUPABASE_SERVICE_ROLE_KEY')?.startsWith('${')],

  // ── Dockerfile: многоступенчатость и содержимое образа ───────────────────────────────────────
  ['both images are multi-stage and build on the pinned Node base',
    [dockerApi, dockerWorker].every((file) =>
      (file.match(/^FROM /gm) ?? []).length >= 2
      && file.includes('FROM node:22-alpine AS deps')
      && file.includes('FROM node:22-alpine AS runtime')
      && file.includes('COPY --from=deps /app/node_modules ./node_modules'))],

  // npm ci, а не install: ci ставит РОВНО то, что в package-lock, и падает при расхождении. install
  // молча обновил бы зависимость, и образ перестал бы соответствовать проверенному дереву.
  ['dependencies are installed reproducibly and without dev packages',
    [dockerApi, dockerWorker].every((file) =>
      file.includes('RUN npm ci --omit=dev --ignore-scripts') && !/npm install/.test(instructions(file)))],

  /*
   * Chromium не тянется в образ.
   *
   * В дереве проекта лежат playwright и puppeteer, каждый со своим Chromium. Их postinstall добавил бы
   * к образу шлюза больше полугигабайта ради кода, который там никогда не выполнится.
   */
  ['browser downloads are disabled during the image build',
    [dockerApi, dockerWorker].every((file) =>
      file.includes('PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1') && file.includes('PUPPETEER_SKIP_DOWNLOAD=1'))],

  /*
   * `COPY . .` ЗАПРЕЩЁН.
   *
   * Он утащил бы в образ .secrets.local, расширение браузера и всю историю миграций. Список копируемых
   * каталогов должен быть явным.
   */
  ['the image copies an explicit list of paths, never the whole tree',
    !/^COPY \. \.\s*$/m.test(instructions(dockerApi)) && !/^COPY \. \.\s*$/m.test(instructions(dockerWorker))
    && dockerApi.includes('COPY agent-hub/server ./agent-hub/server')
    && dockerApi.includes('COPY agent-hub/contracts ./agent-hub/contracts')],

  // Root внутри контейнера означает, что пробитая уязвимость в зависимости получает права на
  // смонтированные тома.
  ['containers run as a non-root user',
    dockerApi.includes('USER node') && dockerWorker.includes('USER node')],

  /*
   * tini как init.
   *
   * Node под PID 1 не получает обработку сигналов по умолчанию и НЕ реагирует на `docker stop`:
   * контейнер убивается по таймауту через десять секунд, обрывая запросы. Мягкая остановка в main.ts
   * без этого бесполезна — её просто некому вызвать.
   */
  ['tini reaps signals so graceful shutdown can happen at all',
    [dockerApi, dockerWorker].every((file) =>
      file.includes('apk add --no-cache tini') && file.includes('ENTRYPOINT ["/sbin/tini", "--"]'))
    && read('agent-hub/server/main.ts').includes("for (const signal of ['SIGTERM', 'SIGINT'] as const)")],

  // Проверка загрузки модулей НА ЭТАПЕ СБОРКИ: несовместимость снятия типов в Node 22 должна
  // обнаружиться при `docker build`, а не через минуту после выкатки.
  ['each image verifies its modules load during build',
    [dockerApi, dockerWorker].every((file) => instructions(file).includes('RUN node --experimental-strip-types --input-type=module'))],

  ['the gateway image exposes its port and declares a healthcheck',
    instructions(dockerApi).includes('EXPOSE 3000') && instructions(dockerApi).includes('HEALTHCHECK')
    && dockerApi.includes("CMD [\"node\", \"--experimental-strip-types\", \"agent-hub/server/main.ts\"]")],

  // Без --loop воркер разберёт одну задачу и выйдет, а restart: unless-stopped превратит это в
  // бесконечный цикл перезапусков.
  ['the worker image runs in continuous mode',
    dockerWorker.includes('agent-hub/sdr-worker.mjs", "--loop"')],

  // ── Честность про непроверенное ──────────────────────────────────────────────────────────────
  //
  // Файлы не собирались и не запускались. Пометка обязана быть в них самих, а не только в сообщении
  // коммита: тот, кто откроет Dockerfile через полгода, коммита не увидит.
  ['the unbuilt state is documented inside the files themselves',
    /НЕ ПРОВЕРЕНО|не проверено/.test(dockerApi)
    && /НЕ ПРОВЕРЕНО|не проверено/.test(dockerWorker)
    && /НЕ ПРОВЕРЕНО|не проверено/.test(read('docker-compose.yml'))],

  // ── Подключение к гейту ──────────────────────────────────────────────────────────────────────
  ['the gateway suites run in the quality gate',
    ['test:gateway', 'test:infra'].every((script) => packageJson.includes(`"${script}":`))
    && ['test:gateway', 'test:infra'].every((script) => qualityGate.includes(`{ npm run ${script} }`))],
]

let failed = 0
for (const [name, passed] of cases) {
  if (!passed) { console.log(`FAIL ${name}`); failed++ }
}
console.log(`Infrastructure contracts: ${cases.length - failed}/${cases.length}`)
if (failed) process.exit(1)
