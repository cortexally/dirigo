#!/usr/bin/env bash
# e2e установки из бандла (V7-5) — безопасная изолированная проверка.
#
# Не скачивает из интернета: берёт локальный build/dist бандл, распаковывает
# в DIRIGO_E2E_DIR (по умолчанию в TMPDIR), запускает демон на отдельном порту
# и проверяет health. Текущий демон/дерево не затрагиваются.
#
# Запуск: bash build/e2e-install.sh
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

BUNDLE="$(ls -t build/dist/*.tar.gz 2>/dev/null | head -1)"
[ -z "$BUNDLE" ] && { echo "FATAL: нет бандла. Сначала bash build/bundle.sh"; exit 1; }

E2E_DIR="${DIRIGO_E2E_DIR:-${TMPDIR:-/tmp}/orch-e2e-$$}"
E2E_PORT="${DIRIGO_E2E_PORT:-7299}"
E2E_DATA="$E2E_DIR/data"

echo "→ e2e-установка: $BUNDLE"
echo "  каталог: $E2E_DIR (порт $E2E_PORT)"

cleanup() {
  echo ""
  echo "→ cleanup"
  [ -n "${DAEMON_PID:-}" ] && kill "$DAEMON_PID" 2>/dev/null || true
  sleep 1
  [ -n "${DAEMON_PID:-}" ] && kill -9 "$DAEMON_PID" 2>/dev/null || true
  rm -rf "$E2E_DIR"
  echo "  удалено: $E2E_DIR"
}
trap cleanup EXIT

# ─── 1. Распаковка (как install-скрипт) ───
rm -rf "$E2E_DIR"
mkdir -p "$E2E_DIR"
tar -xzf "$BUNDLE" -C "$E2E_DIR"
PKG="$(find "$E2E_DIR" -maxdepth 1 -mindepth 1 -type d | head -1)"
echo "→ распаковано: $PKG"

# ─── 2. Проверка sha256 (как install-скрипт) ───
EXPECTED="$(awk '/dirigo-.*\.tar\.gz/ {print $1}' build/dist/SHA256SUMS)"
ACTUAL="$(sha256sum "$BUNDLE" | awk '{print $1}')"
if [ "$EXPECTED" = "$ACTUAL" ]; then
  echo "→ SHA256 совпал: ${ACTUAL:0:16}..."
else
  echo "FATAL: SHA256 не совпал"; exit 1
fi

# ─── 3. Bun ───
command -v bun >/dev/null 2>&1 || { echo "FATAL: bun не найден (на этой машине)"; exit 1; }
echo "→ bun: $(bun --version)"

# ─── 4. Запуск демона на отдельном порту и изолированным DATA ───
cd "$PKG"
export PORT="$E2E_PORT"
export DIRIGO_DATA="$E2E_DATA"
export DIRIGO_TOKEN=""   # e2e без токена — только health
bun run src/server.ts > "$E2E_DIR/daemon.log" 2>&1 &
DAEMON_PID=$!
echo "→ демон запущен (pid $DAEMON_PID), жду health..."

# ─── 5. Ожидание health ───
HEALTH=""
for i in $(seq 1 30); do
  sleep 1
  HEALTH="$(curl -s "http://127.0.0.1:$E2E_PORT/api/health" -m 2 2>/dev/null || true)"
  if [ -n "$HEALTH" ]; then break; fi
done
if [ -z "$HEALTH" ]; then
  echo "FATAL: демон не ответил за 30с"
  echo "--- daemon.log (tail) ---"
  tail -20 "$E2E_DIR/daemon.log" 2>/dev/null || true
  exit 1
fi

# ─── 6. Проверки здоровья ───
echo ""
echo "→ health:"
echo "$HEALTH" | head -c 200
echo ""

OK=0
check() { # name ok extra
  local name="$1"; local ok="$2"; local extra="${3:-}"
  if [ "$ok" = "1" ]; then echo "  ✓ $name${extra:+ ($extra)}"; OK=$((OK+1)); else echo "  ✗ $name${extra:+ ($extra)}"; fi
}

echo "$HEALTH" | grep -q '"ok":true' && check "health ok" 1 || check "health ok" 0
VERSION="$(echo "$HEALTH" | grep -o '"version":"[^"]*"' | cut -d'"' -f4)"
if [ -n "$VERSION" ]; then check "версия" 1 "$VERSION"; else check "версия" 0; fi
if echo "$HEALTH" | grep -q '"agents":\['; then check "агенты в реестре" 1; else check "агенты в реестре" 0; fi

# web-UI (200 ожидаем; 000 = curl не достучался)
# NB: pipefail + set -e — команда в $(...) с пайпом может дать ненулевой
# код от tail, если curl закрыл соединение; | tail трактуем как успех.
UI_CODE="$(curl -s -o /dev/null -w '%{http_code}' -m 3 "http://127.0.0.1:$E2E_PORT/" 2>/dev/null | tail -c 3 || true)"
[ -z "$UI_CODE" ] && UI_CODE="000"
if [ "$UI_CODE" = "200" ]; then check "web-UI" 1 "200"; else check "web-UI" 0 "$UI_CODE"; fi

# SSE доступен (поток — не разрываем, просто проверяем статус)
SSE_CODE="$(curl -s -o /dev/null -w '%{http_code}' -m 2 "http://127.0.0.1:$E2E_PORT/api/events" 2>/dev/null | tail -c 3 || true)"
[ -z "$SSE_CODE" ] && SSE_CODE="000"
if [ "$SSE_CODE" = "200" ]; then check "SSE /api/events" 1 "200"; else check "SSE /api/events" 0 "$SSE_CODE"; fi

# CORS (V5-1)
CORS="$(curl -s -D - -o /dev/null -m 2 "http://127.0.0.1:$E2E_PORT/api/health" 2>/dev/null | grep -i "access-control-allow-origin" | head -1 | tr -d '\r' || true)"
if [ -n "$CORS" ]; then check "CORS" 1 "$CORS"; else check "CORS" 0; fi

# /api/pair (V5-15)
PAIR="$(curl -s -m 2 "http://127.0.0.1:$E2E_PORT/api/pair" 2>/dev/null | head -c 20 || true)"
if echo "$PAIR" | grep -q "<svg"; then check "/api/pair QR" 1; else check "/api/pair QR" 0; fi

# API-контракт: sessions
SESS_CODE="$(curl -s -o /dev/null -w '%{http_code}' -m 2 "http://127.0.0.1:$E2E_PORT/api/sessions" 2>/dev/null | tail -c 3 || true)"
[ -z "$SESS_CODE" ] && SESS_CODE="000"
if [ "$SESS_CODE" = "200" ]; then check "API /api/sessions" 1 "200"; else check "API /api/sessions" 0 "$SESS_CODE"; fi

# CLI в бандле
if [ -x "$PKG/orch" ]; then check "CLI orch исполняемый" 1; else check "CLI orch исполняемый" 0; fi

if "$PKG/orch" --host "http://127.0.0.1:$E2E_PORT" health > "$E2E_DIR/cli.out" 2>&1; then
  check "orch health через CLI" 1
else
  check "orch health через CLI" 0 "$(head -c 60 "$E2E_DIR/cli.out" 2>/dev/null)"
fi

echo ""
if [ "$OK" -ge 9 ]; then
  echo "✓ E2E: установка из бандла работает ($OK/10 проверок)"
else
  echo "✗ E2E: $OK/10 проверок — смотри выше"
  exit 1
fi
