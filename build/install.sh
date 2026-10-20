#!/usr/bin/env bash
# Dirigo — установка одной командой (macOS/Linux).
#
#   curl -fsSL https://dirigo.cortexally.ai/install.sh | bash
#
# Что делает:
#   1. Проверяет/ставит Bun (если нет).
#   2. Скачивает бандл dirigo-<ver>.tar.gz с BASE_URL.
#   3. Проверяет SHA256 (если доступен SHA256SUMS).
#   4. Распаковывает в ~/.dirigo (или DIRIGO_INSTALL_DIR).
#   5. Запускает демон → http://127.0.0.1:7171 (мастер первого запуска).
#
# Безопасность: sha256-проверка обязательна (пропуск — только DIRIGO_SKIP_VERIFY=1
# осознанно); бандл качается только по https; каталог установки — только в
# домашней директории; ничего не пишет в систему.
set -euo pipefail

# ─── конфигурация (переопределяется через env) ───
BASE_URL="${DIRIGO_BASE_URL:-https://dirigo.cortexally.ai}"   # где лежат бандлы
VERSION="${DIRIGO_VERSION:-latest}"
INSTALL_DIR="${DIRIGO_INSTALL_DIR:-$HOME/.dirigo}"
PORT="${PORT:-7171}"

# ─── цвета (если терминал поддерживает) ───
if [ -t 1 ]; then C_CYAN=$'\033[36m'; C_GREEN=$'\033[32m'; C_RED=$'\033[31m'; C_DIM=$'\033[2m'; C_OFF=$'\033[0m'; else C_CYAN=""; C_GREEN=""; C_RED=""; C_DIM=""; C_OFF=""; fi

say()  { printf '%s\n' "$*"; }
step() { printf '%s▶%s %s\n' "$C_CYAN" "$C_OFF" "$*"; }
ok()   { printf '%s✓%s %s\n' "$C_GREEN" "$C_OFF" "$*"; }
die()  { printf '%s✗%s %s\n' "$C_RED" "$C_OFF" "$*" >&2; exit 1; }

[ "$(id -u)" = "0" ] && die "Не запускай от root — установка идёт в \$HOME."

# ─── охрана: https обязателен (кроме loopback — для локальной проверки) ───
case "$BASE_URL" in
  https://*) ;;
  http://127.0.0.1:*|http://localhost:*|http://[::1]:*) ;;
  *) die "DIRIGO_BASE_URL должен быть https:// (получен: $BASE_URL) — иначе бандл можно подменить по пути" ;;
esac

# ─── 0. Платформа ───
# Ставим только туда, где реально проверено. Windows — через install.ps1.
check_platform() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$os" in
    Linux|Darwin) ;;
    *) die "ОС $os не поддерживается этим установщиком. Windows → install.ps1" ;;
  esac
  case "$arch" in
    x86_64|amd64|arm64|aarch64) ;;
    *) say "${C_DIM}! архитектура $arch не проверялась — продолжаю, но возможны сюрпризы${C_OFF}" ;;
  esac
  for tool in curl tar; do
    command -v "$tool" >/dev/null 2>&1 || die "нужен $tool — поставь его и повтори"
  done
  ok "платформа: $os/$arch"
}

# ─── 1. Bun ───
ensure_bun() {
  if command -v bun >/dev/null 2>&1; then
    ok "bun найден: $(bun --version)"
    return
  fi
  step "Bun не найден — устанавливаю (официальный установщик)"
  curl -fsSL https://bun.sh/install | bash
  export BUN_INSTALL="$HOME/.bun"
  export PATH="$BUN_INSTALL/bin:$PATH"
  command -v bun >/dev/null 2>&1 || die "bun не установился — проверь сеть"
  ok "bun установлен: $(bun --version)"
}

# ─── 2. Скачивание бандла ───
download_bundle() {
  # Артефакты релиза лежат в $BASE_URL/releases/; корень — запасной вариант
  # для старой раскладки. DIRIGO_RELEASES_URL — явный путь.
  local candidates manifest="" c
  # CDN (Cloudflare) может отдать старую копию файла, перевыложенного под тем же именем:
  # манифест и суммы — с уникальным query (мимо кэша), бандл — с ожидаемым SHA256 в адресе
  # (новый бандл = новый ключ кэша; бандл и SHA256SUMS не могут оказаться из разных сборок).
  NOCACHE="?t=$(date +%s)$$"
  if [ -n "${DIRIGO_RELEASES_URL:-}" ]; then candidates="${DIRIGO_RELEASES_URL%/}"; else candidates="$BASE_URL/releases $BASE_URL"; fi
  REL_URL=""
  for c in $candidates; do
    case "$c" in
      https://*|http://127.0.0.1:*|http://localhost:*|http://\[::1\]:*) ;;
      *) die "адрес релизов должен быть https:// (получен: $c)" ;;
    esac
    # манифест версий: <releases>/latest.json → {"version":"2.3"}
    if manifest="$(curl -fsSL "$c/latest.json$NOCACHE" 2>/dev/null)"; then REL_URL="$c"; break; fi
  done
  [ -z "$REL_URL" ] && die "не удалось найти latest.json ($candidates)"
  if [ "$VERSION" = "latest" ]; then
    VERSION="$(printf '%s' "$manifest" | grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | cut -d'"' -f4 || true)"
    [ -z "$VERSION" ] && die "latest.json без поля version: $REL_URL/latest.json"
  fi
  ok "версия: $VERSION ($REL_URL)"
  BUNDLE="$REL_URL/dirigo-$VERSION.tar.gz"
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT

  # sha256: сначала суммы (обязательны, пока явно не разрешили пропустить: DIRIGO_SKIP_VERIFY=1)
  SUMS="$TMP/SHA256SUMS"
  expected=""
  if curl -fsSL "$REL_URL/SHA256SUMS$NOCACHE" -o "$SUMS" 2>/dev/null; then
    expected="$(grep "dirigo-$VERSION\.tar\.gz" "$SUMS" | head -1 | awk '{print $1}' | tr 'A-F' 'a-f')"
    [ -z "$expected" ] && die "SHA256SUMS не содержит dirigo-$VERSION.tar.gz — установка остановлена."
  elif [ "${DIRIGO_SKIP_VERIFY:-0}" != "1" ]; then
    die "контрольная сумма недоступна — установка остановлена. Повторите позже или DIRIGO_SKIP_VERIFY=1 (на свой риск)."
  fi
  if [ -n "$expected" ]; then QUERY="?sha256=$expected"; else QUERY="$NOCACHE"; fi

  step "Скачиваю $BUNDLE"
  # качаем под НАСТОЯЩИМ именем из SHA256SUMS — иначе sha256sum -c не найдёт файл
  BUNDLE_FILE="$TMP/$(basename "$BUNDLE")"
  curl -fsSL "$BUNDLE$QUERY" -o "$BUNDLE_FILE" || die "не скачался бандл: $BUNDLE"
  ok "скачано: $(wc -c < "$BUNDLE_FILE") байт"

  if [ -n "$expected" ]; then
    step "Проверяю контрольную сумму SHA256"
    # sha256sum — Linux, shasum -a 256 — macOS (там sha256sum нет из коробки)
    if command -v sha256sum >/dev/null 2>&1; then actual="$(sha256sum "$BUNDLE_FILE" | awk '{print $1}')"
    elif command -v shasum >/dev/null 2>&1; then actual="$(shasum -a 256 "$BUNDLE_FILE" | awk '{print $1}')"
    else die "нечем проверить SHA256 (нет sha256sum и shasum) — установка остановлена."; fi
    [ "$actual" = "$expected" ] || die "SHA256 не совпал — бандл повреждён или подменён. Установка остановлена. Ожидалось: $expected Получено: $actual"
    ok "контрольная сумма совпала"
  else
    say "${C_DIM}! DIRIGO_SKIP_VERIFY=1 — проверка пропущена по вашему решению (риск подмены)${C_OFF}"
  fi
}

# ─── 3. Распаковка ───
unpack() {
  step "Распаковываю в $INSTALL_DIR"
  mkdir -p "$INSTALL_DIR"
  # распаковка во временный слой, затем атомарная замена
  UNPACK="$INSTALL_DIR/.unpack-$$"
  rm -rf "$UNPACK"
  mkdir -p "$UNPACK"
  tar -xzf "$TMP/$(basename "$BUNDLE")" -C "$UNPACK"
  # в архиве лежит папка dirigo-<ver> или dirigo
  SRC="$(find "$UNPACK" -maxdepth 1 -mindepth 1 -type d | head -1)"
  [ -z "$SRC" ] && die "в архиве нет каталога"
  # атомарная замена через rename
  OLD="$INSTALL_DIR/.old-$$"
  rm -rf "$OLD" 2>/dev/null || true
  if [ -d "$INSTALL_DIR/current" ]; then mv "$INSTALL_DIR/current" "$OLD"; fi
  mv "$SRC" "$INSTALL_DIR/current"
  rm -rf "$UNPACK"
  # Данные пользователя (data: проекты, сессии, ключи, копии) живут в
  # current/data. Раньше обновление удаляло старый current вместе с ними.
  local keep_old=0
  if [ -d "$OLD/data" ]; then
    if rm -rf "$INSTALL_DIR/current/data" && mv "$OLD/data" "$INSTALL_DIR/current/data"; then
      ok "данные сохранены: проекты, сессии, ключи"
    else
      keep_old=1
      say "${C_DIM}! данные не перенеслись автоматически — они целы в $OLD/data, перенесите их в $INSTALL_DIR/current/data${C_OFF}"
    fi
  fi
  [ "$keep_old" = "0" ] && rm -rf "$OLD"
  ok "установлено: $INSTALL_DIR/current"
}

# ─── 2.5. Уже запущенный Dirigo ───
# Обновление поверх работающего демона: новая версия упала бы на занятом порту.
# Останавливаем только Dirigo (проверка по /api/health).
stop_running() {
  curl -fsS --max-time 3 "http://127.0.0.1:$PORT/api/health" 2>/dev/null | grep -q '"agents"' || return 0
  local pids=""
  if command -v lsof >/dev/null 2>&1; then pids="$(lsof -ti "tcp:$PORT" -sTCP:LISTEN 2>/dev/null || true)"
  elif command -v fuser >/dev/null 2>&1; then pids="$(fuser "$PORT/tcp" 2>/dev/null || true)"; fi
  [ -z "$pids" ] && die "на порту $PORT уже работает Dirigo, но его процесс не найден — остановите его и повторите"
  step "Останавливаю работающий Dirigo (pid $pids) — обновление"
  kill $pids 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    curl -fsS --max-time 1 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 || return 0
    sleep 0.5
  done
  kill -9 $pids 2>/dev/null || true
}

# ─── 3.5. Зависимости (опциональные) ───
# В бандле есть package.json с optionalDependencies: node-pty. Он нативный и
# собирается не везде. Демон обязан работать и без него (PTY-режим деградирует),
# поэтому провал установки зависимостей — ПРЕДУПРЕЖДЕНИЕ, а не ошибка.
install_deps() {
  [ -f "$INSTALL_DIR/current/package.json" ] || return 0
  step "Ставлю опциональные зависимости (PTY-терминал)"
  if (cd "$INSTALL_DIR/current" && bun install --production --silent >/dev/null 2>&1); then
    ok "зависимости готовы"
  else
    say "${C_DIM}! node-pty не собрался. Пульт работает полностью, недоступен только режим «Терминал (TUI)».${C_OFF}"
    say "${C_DIM}  Чтобы включить: поставь python3, make, g++/clang и выполни bun install в $INSTALL_DIR/current${C_OFF}"
  fi
}

# ─── 4. Запуск ───
launch() {
  step "Запускаю демон на порту $PORT"
  cd "$INSTALL_DIR/current"
  export PORT
  # открыть браузер (best-effort)
  (open "http://127.0.0.1:$PORT" 2>/dev/null || xdg-open "http://127.0.0.1:$PORT" 2>/dev/null) || true
  say ""
  say "${C_GREEN}Dirigo v$VERSION установлен и запущен.${C_OFF}"
  say "  Пульт:  http://127.0.0.1:$PORT"
  say "  Каталог: $INSTALL_DIR/current"
  say "  Обновление: DIRIGO_VERSION=<новая> $0"
  say "  Остановить: Ctrl+C (демон работает в этом окне)"
  say "  Другой порт: PORT=7272 $0"
  say ""
  exec bun run src/server.ts
}

# ─── main ───
say "${C_CYAN}Dirigo — установщик${C_OFF}"
check_platform
ensure_bun
download_bundle
stop_running
unpack
install_deps
launch

say ""
say "${C_OK}Как запускать:${C_OFF}"
say "  cd \"$INSTALL_DIR/current\" && ./run.sh      # поднять пульт (и открыть браузер)"
say "  ./stop.sh                                   # остановить всё"
say "${C_DIM}Повторный ./run.sh подключится к уже работающему пульту, второй не поднимет.${C_OFF}"
