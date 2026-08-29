# Установка Nemo CLI в Windows PowerShell.
#
#   irm https://nemo-ai-swart.vercel.app/install.ps1 | iex
#
# Репозиторий приватный, поэтому установщик берёт собранный пакет с публичного домена Nemo.
# Голое имя `nemo-ai` использовать нельзя: в npm оно принадлежит постороннему пакету.

$ErrorActionPreference = 'Stop'

$PackageUrl = 'https://nemo-ai-swart.vercel.app/nemo-cli.tgz'
$NodeMinMajor = 20
$NodeMinMinor = 6

function Say($text) { Write-Host $text }
function Fail($text) {
  Write-Host ''
  Write-Host "  x $text" -ForegroundColor Red
  Write-Host ''
  exit 1
}

Say ''
Say '  Nemo CLI - установка'
Say ''

# ── Node ────────────────────────────────────────────────────────────────────────────────────
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Say '  Node.js не найден. Он нужен: Nemo CLI на нём и работает.'
  Say ''
  Say '    winget install OpenJS.NodeJS.LTS'
  Say '    или https://nodejs.org - версия 20.6 или новее'
  Say ''
  Fail 'установка остановлена'
}

$nodeVersion = (node --version).TrimStart('v')
$parts = $nodeVersion.Split('.')
$major = [int]$parts[0]
$minor = [int]$parts[1]

# Младшая цифра проверяется тоже: --experimental-strip-types появился в 20.6, и на 20.0 CLI
# установится и упадёт при первом запуске - отказ будет отложенным и непонятным.
if ($major -lt $NodeMinMajor -or ($major -eq $NodeMinMajor -and $minor -lt $NodeMinMinor)) {
  Fail "нужен Node.js $NodeMinMajor.$NodeMinMinor или новее, установлен $nodeVersion"
}
Say "  Node.js $nodeVersion - годится"

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  Fail 'npm не найден: обычно он идёт вместе с Node.js'
}

# ── Установка ───────────────────────────────────────────────────────────────────────────────
Say '  Скачиваю официальный пакет Nemo...'
Say ''

# 2>&1 к native-команде в PowerShell 5.1 оборачивает каждую строку stderr в ошибку и сбивает $?,
# поэтому поток НЕ перенаправляется, а результат проверяется по $LASTEXITCODE.
npm install -g $PackageUrl --no-audit --no-fund
if ($LASTEXITCODE -ne 0) {
  Say ''
  Say '  Установка не прошла. Чаще всего это права на каталог глобальных пакетов npm.'
  Say '  Откройте PowerShell от имени администратора и повторите.'
  Fail 'остановлено'
}

# ── Проверка в ТЕКУЩЕЙ сессии ───────────────────────────────────────────────────────────────
#
# PowerShell читает PATH при запуске: после первой установки npm команда бывает недоступна в уже
# открытом окне, хотя установлена. Молчаливое «command not found» человек относит к установщику,
# поэтому сначала обновляем PATH процесса из реестра, а потом честно говорим, что вышло.
$env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
            [Environment]::GetEnvironmentVariable('Path', 'User')

if (Get-Command nemo -ErrorAction SilentlyContinue) {
  Say ''
  Write-Host '  * Nemo CLI успешно установлен! Запустите: nemo' -ForegroundColor Green
  Say ''
  exit 0
}

$npmPrefix = (npm prefix -g)
Say ''
Say '  Пакет установлен, но команда nemo не видна в этой сессии.'
Say "  Каталог с ней: $npmPrefix"
Say ''
Say '  Закройте это окно PowerShell и откройте новое - PATH перечитается.'
Say ''
exit 1
