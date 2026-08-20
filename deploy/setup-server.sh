#!/usr/bin/env bash
#
# Первоначальная настройка сервера под контур Nemo AI.
# Проверялось на Oracle Cloud Ampere (ARM64), Ubuntu 24.04 LTS.
#
# Запуск:  sudo bash deploy/setup-server.sh
#
# Скрипт ИДЕМПОТЕНТЕН: повторный запуск ничего не ломает и не дублирует правила.

set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Нужны права root: sudo bash $0" >&2
  exit 1
fi

ARCH="$(dpkg --print-architecture)"
echo "==> Архитектура: ${ARCH}, ядро $(uname -r)"

# ── 1. Пакеты ────────────────────────────────────────────────────────────────────────────────
echo "==> Обновление пакетов"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get upgrade -y -qq
apt-get install -y -qq ca-certificates curl gnupg ufw

# ── 2. Docker ────────────────────────────────────────────────────────────────────────────────
# Из официального репозитория Docker, а не из apt Ubuntu: в дистрибутивном docker.io нет плагина
# compose v2, а `docker-compose` первой версии этот файл не прочитает.
if ! command -v docker >/dev/null 2>&1; then
  echo "==> Установка Docker"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=${ARCH} signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
else
  echo "==> Docker уже установлен: $(docker --version)"
fi

systemctl enable --now docker

# Пользователь, вызвавший sudo, — в группу docker, чтобы не работать под root постоянно.
if [[ -n "${SUDO_USER:-}" && "${SUDO_USER}" != "root" ]]; then
  usermod -aG docker "${SUDO_USER}"
  echo "==> ${SUDO_USER} добавлен в группу docker (нужен повторный вход)"
fi

# ── 3. Межсетевой экран ──────────────────────────────────────────────────────────────────────
#
# ВНИМАНИЕ, ГЛАВНОЕ ПРО UFW И DOCKER.
#
# UFW НЕ ЗАКРЫВАЕТ ПОРТЫ, ОПУБЛИКОВАННЫЕ DOCKER'ОМ. Docker пишет свои правила в цепочку DOCKER-USER
# таблицы nat, и они срабатывают РАНЬШЕ правил UFW. То есть `ports: "5432:5432"` в compose делает
# базу доступной из интернета, даже когда ufw показывает «deny incoming» и выглядит настроенным.
#
# Единственная надёжная защита — НЕ публиковать порт. В docker-compose.prod.yml наружу выведен
# только Caddy; postgres и gateway портов на хост не отдают вовсе. UFW здесь закрывает то, что
# слушает САМ ХОСТ, а не контейнеры.
echo "==> Настройка UFW"
ufw --force reset >/dev/null
ufw default deny incoming
ufw default allow outgoing
ufw limit 22/tcp comment 'SSH (с ограничением частоты попыток)'
ufw allow 80/tcp comment 'HTTP — нужен для ACME, без него сертификат не продлится'
ufw allow 443/tcp comment 'HTTPS'
ufw allow 443/udp comment 'HTTP/3'
ufw --force enable
ufw status verbose

# Oracle Cloud держит СВОЙ список правил (Security List / NSG) поверх машины. Порты 80 и 443 надо
# открыть и там — иначе снаружи всё выглядит как «сервер не отвечает», а на самой машине ufw и
# Caddy при этом безупречны. На этом теряют по полдня.
cat <<'NOTE'

  ── Отдельно про Oracle Cloud ──────────────────────────────────────────────────────────────
  Откройте 80/tcp, 443/tcp и 443/udp в Security List (или NSG) подсети в веб-консоли Oracle.
  Правила самой машины на облачный фильтр не влияют: снаружи будет тишина, а изнутри — порядок.
  ───────────────────────────────────────────────────────────────────────────────────────────

NOTE

# ── 4. Системные пределы ─────────────────────────────────────────────────────────────────────
#
# Значения умеренные и рассчитаны на машину с 4–24 ГБ (бесплатный Ampere даёт до 24). Раздувать
# буферы на маленькой машине вредно: память уходит ядру, а не Postgres и не Node.
echo "==> Системные пределы"
cat > /etc/sysctl.d/99-nemo.conf <<'SYSCTL'
# Очередь принятых, но ещё не обработанных соединений. По умолчанию 4096 — при всплеске вебхуков
# ядро начинает молча отбрасывать SYN, а снаружи это выглядит как случайные таймауты.
net.core.somaxconn = 8192
net.ipv4.tcp_max_syn_backlog = 8192

# Ускоряет освобождение сокетов в TIME_WAIT при большом числе исходящих соединений (агент ходит в
# OpenRouter, Telegram, на чужие сайты). tcp_tw_recycle НЕ включаем — он сломан за NAT и удалён.
net.ipv4.tcp_tw_reuse = 1
net.ipv4.tcp_fin_timeout = 15

# Диапазон исходящих портов: воркер держит много одновременных соединений наружу.
net.ipv4.ip_local_port_range = 10240 65535

# Keepalive: разрывы между облаками случаются молча, и без этого зависшее соединение живёт часами.
net.ipv4.tcp_keepalive_time = 300
net.ipv4.tcp_keepalive_intvl = 30
net.ipv4.tcp_keepalive_probes = 5

# Postgres в контейнере: без overcommit ядро может отказать в fork при снапшоте.
vm.overcommit_memory = 1
vm.swappiness = 10

# Больше следящих за файлами дескрипторов — сборка Vite в контейнере упирается в предел по умолчанию.
fs.inotify.max_user_watches = 524288
fs.file-max = 2097152
SYSCTL
sysctl --system >/dev/null
echo "    применено: $(sysctl -n net.core.somaxconn) somaxconn"

# Предел открытых файлов для процессов — sysctl задаёт общесистемный, limits.conf пользовательский.
cat > /etc/security/limits.d/99-nemo.conf <<'LIMITS'
*  soft  nofile  65535
*  hard  nofile  65535
LIMITS

# ── 5. Итог ──────────────────────────────────────────────────────────────────────────────────
cat <<'DONE'

==> Сервер готов. Дальше:

  1. cp deploy/.env.server.example .env.server && $EDITOR .env.server
  2. Направьте A-записи nemoai.uz, app.nemoai.uz, api.nemoai.uz на IP этого сервера
     (до этого Caddy не сможет получить сертификат — проверка ACME ходит по домену)
  3. docker compose -f docker-compose.prod.yml --env-file .env.server up -d --build
  4. docker compose -f docker-compose.prod.yml ps      — все сервисы healthy
     docker compose -f docker-compose.prod.yml logs -f caddy   — выпуск сертификатов

DONE
