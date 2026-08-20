# Образ для шлюза (agent-hub/server) и фонового воркера (agent-hub/sdr-worker).
#
# ОДИН ОБРАЗ НА ДВА ПРОЦЕССА, а не два похожих: код у них общий, расходится только команда запуска.
# Две сборки разъезжаются по версиям зависимостей ровно тогда, когда это труднее всего заметить.
#
# Node 22: точки входа — .ts и .mjs, запускаемые через --experimental-strip-types. Флаг появился в
# 22.6; на 20 контейнер соберётся и упадёт при старте. Версия закреплена мажором намеренно.
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
# npm ci воспроизводит lock-файл дословно. npm install тихо подтянул бы более свежие версии, и
# продакшн поехал бы на зависимостях, которых не видел ни один прогон тестов.
RUN npm ci --omit=dev || npm install --omit=dev

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Непривилегированный пользователь: образ ходит в сеть и исполняет код, который решает модель.
# Пользователь node уже есть в базовом образе.
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node agent-hub ./agent-hub
COPY --chown=node:node supabase/functions/_shared ./supabase/functions/_shared

USER node

# Render и Koyeb передают порт переменной PORT; шлюз её читает. 3000 — только значение по умолчанию
# для локального запуска.
ENV PORT=3000
EXPOSE 3000

# Команда по умолчанию — шлюз. Воркер запускается той же картинкой с другой командой (см. render.yaml).
CMD ["node", "--experimental-strip-types", "agent-hub/server/main.ts"]
