#!/usr/bin/env bash
#
# Установка Nemo CLI на macOS, Linux и WSL.
#
#   curl -fsSL https://nemo-ai-swart.vercel.app/install.sh | bash
#
# Репозиторий приватный, поэтому установщик берёт собранный пакет с публичного домена Nemo.
# Голое имя `nemo-ai` использовать нельзя: в npm оно принадлежит постороннему пакету.

set -euo pipefail

PACKAGE_URL="https://nemo-ai-swart.vercel.app/nemo-cli.tgz"
NODE_MIN_MAJOR=20
NODE_MIN_MINOR=6

say()  { printf '%s\n' "$*"; }
fail() { printf '\n  ✖ %s\n\n' "$*" >&2; exit 1; }

say ""
say "  Nemo CLI — установка"
say ""

# ── Node ────────────────────────────────────────────────────────────────────────────────────
if ! command -v node >/dev/null 2>&1; then
  say "  Node.js не найден. Он нужен: Nemo CLI на нём и работает."
  say ""
  say "    macOS:   brew install node"
  say "    Ubuntu:  sudo apt install nodejs npm"
  say "    Иначе:   https://nodejs.org — версия 20.6 или новее"
  say ""
  fail "установка остановлена"
fi

NODE_VERSION="$(node --version | sed 's/^v//')"
NODE_MAJOR="${NODE_VERSION%%.*}"
NODE_REST="${NODE_VERSION#*.}"
NODE_MINOR="${NODE_REST%%.*}"

# Проверяется и МЛАДШАЯ цифра: --experimental-strip-types появился в 20.6, и на 20.0 CLI
# соберётся, установится и упадёт при первом запуске — то есть отказ будет отложенным и непонятным.
if [ "$NODE_MAJOR" -lt "$NODE_MIN_MAJOR" ] ||
   { [ "$NODE_MAJOR" -eq "$NODE_MIN_MAJOR" ] && [ "$NODE_MINOR" -lt "$NODE_MIN_MINOR" ]; }; then
  fail "нужен Node.js ${NODE_MIN_MAJOR}.${NODE_MIN_MINOR} или новее, установлен ${NODE_VERSION}"
fi
say "  Node.js ${NODE_VERSION} — годится"

command -v npm >/dev/null 2>&1 || fail "npm не найден: обычно он идёт вместе с Node.js"

# ── Установка ───────────────────────────────────────────────────────────────────────────────
say "  Скачиваю официальный пакет Nemo…"
say ""

if ! npm install -g "$PACKAGE_URL" --no-audit --no-fund; then
  say ""
  say "  Установка не прошла. Чаще всего это права на глобальный каталог npm."
  say ""
  say "    вариант 1:  sudo npm install -g ${PACKAGE_URL}"
  say "    вариант 2:  npm config set prefix ~/.npm-global   и добавить ~/.npm-global/bin в PATH"
  say ""
  fail "остановлено"
fi

# ── Проверка ────────────────────────────────────────────────────────────────────────────────
#
# Проверяем не «npm сказал ok», а НАХОДИТСЯ ЛИ КОМАНДА. Каталог глобальных пакетов npm бывает вне
# PATH — тогда установка проходит успешно, а `nemo` отвечает «command not found», и человек
# считает, что сломан установщик.
if command -v nemo >/dev/null 2>&1; then
  say ""
  say "  ✦ Nemo CLI успешно установлен! Запустите: nemo"
  say ""
  exit 0
fi

NPM_BIN="$(npm bin -g 2>/dev/null || npm prefix -g 2>/dev/null)/bin"
say ""
say "  Пакет установлен, но команда nemo не найдена в PATH."
say "  Каталог с ней: ${NPM_BIN}"
say ""
say "  Добавьте строку в ~/.zshrc или ~/.bashrc и откройте новый терминал:"
say ""
say "    export PATH=\"${NPM_BIN}:\$PATH\""
say ""
# PATH правится РУКАМИ, а не скриптом. Автоматическая дописка в чужой файл настроек — это
# изменение, о котором человек не просил и о котором забудет; при следующей установке строк станет
# две. Показать команду честнее, чем молча поправить.
exit 1
