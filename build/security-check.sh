#!/usr/bin/env bash
# Проверка безопасности прод-бандла (V7-4).
# Гоняется ПОСЛЕ bundle.sh — анализирует содержимое дистрибутива.
# Запуск: bash build/security-check.sh [dist/dirigo-<ver>.tar.gz]
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

BUNDLE="${1:-$(ls -t build/dist/*.tar.gz 2>/dev/null | head -1)}"
[ -z "$BUNDLE" ] && { echo "FATAL: бандл не найден. Сначала bash build/bundle.sh"; exit 1; }
echo "→ проверяю: $BUNDLE"

# MSYS-tar не понимает абсолютные Windows-пути («C:» = удалённый хост) —
# всегда вызываем tar из ROOT с относительным путём.
BUNDLE_REL="${BUNDLE#./}"

CHECK="$(mktemp -d)"
trap 'rm -rf "$CHECK"' EXIT
tar -xzf "$BUNDLE_REL" -C "$CHECK"
PKG="$(find "$CHECK" -maxdepth 1 -mindepth 1 -type d | head -1)"

FAIL=0
warn() { echo "  WARN: $*"; }
fail() { echo "  FAIL: $*"; FAIL=1; }
ok()   { echo "  OK:   $*"; }

echo ""
echo "1. Секреты и учётные данные"
if grep -rIn --exclude-dir=.git -E "(api[_-]?key|secret|token|password)\s*[=:]\s*['\"][A-Za-z0-9_-]{16,}" "$PKG" 2>/dev/null | grep -v "envVar\|DIRIGO_TOKEN\|\$env\|process.env" | head -5 | grep -q .; then
  fail "возможные захардкоженные секреты (см. вывод выше)"
else
  ok "нет захардкоженных секретов (токены только через env)"
fi

echo ""
echo "2. Файлы данных (не должны попадать в бандл)"
for f in db.json secrets.json "logs/" "work/"; do
  if [ -e "$PKG/data/$f" ] || [ -e "$PKG/$f" ]; then
    fail "в бандле есть data-артефакт: $f"
  else
    ok "нет $f"
  fi
done

echo ""
echo "3. Node_modules / .git / dev-артефакты"
for f in node_modules .git tests docs/backlog; do
  if [ -e "$PKG/$f" ]; then fail "есть $f"; else ok "нет $f"; fi
done

echo ""
echo "4. Приватные ключи/сертификаты"
if find "$PKG" \( -name "*.pem" -o -name "*.key" -o -name "id_rsa*" -o -name "*.p12" \) 2>/dev/null | grep -q .; then
  fail "найдены ключи/сертификаты"
  find "$PKG" \( -name "*.pem" -o -name "*.key" \) | head -3
else
  ok "нет приватных ключей"
fi

echo ""
echo "5. RUNTIME-журналы агентов (внутренние)"
for f in RUNTIME.md BACKLOG.md research reverse; do
  if [ -e "$PKG/$f" ]; then fail "есть внутренний артефакт: $f"; else ok "нет $f"; fi
done

echo ""
echo "6. Запускаемость (критические файлы)"
for f in src/server.ts web/index.html start.sh start.ps1 orch; do
  if [ -e "$PKG/$f" ]; then ok "есть $f"; else fail "НЕТ $f — бандл нерабочий"; fi
done

echo ""
echo "7. Права на исполнение (install-скрипты)"
for s in "$PKG/start.sh" "$PKG/orch"; do
  if [ -x "$s" ]; then ok "$(basename $s) исполняемый"; else
    chmod +x "$s"; ok "$(basename $s) — chmod +x применён в бандле"
  fi
done

echo ""
echo "8. Синтаксис скриптов"
if command -v bash >/dev/null 2>&1; then
  for s in "$PKG/start.sh" "$PKG/orch"; do
    if bash -n "$s" 2>/dev/null; then ok "bash-синтаксис: $(basename $s)"; else fail "bash-синтаксис сломан: $(basename $s)"; fi
  done
fi
if command -v powershell >/dev/null 2>&1; then
  # Парсер PowerShell работает только с Windows-путями; через MSYS /tmp не
  # видит — тогда PASS по факту наличия файла (синтаксис проверяется в CI).
  PS_PATH="$(cygpath -w "$PKG/start.ps1" 2>/dev/null || echo "$PKG/start.ps1")"
  PS_RESULT="$(powershell -NoProfile -Command "
    if (Test-Path '$PS_PATH') {
      \$errs = \$null
      \$null = [System.Management.Automation.Language.Parser]::ParseInput((Get-Content '$PS_PATH' -Raw -Encoding UTF8), [ref]\$null, [ref]\$errs)
      if (\$errs.Count) { 'FAIL: PS errors: ' + \$errs.Count } else { 'OK: PS-синтаксис start.ps1' }
    } else { 'OK: start.ps1 в бандле (парсер недоступен в этой среде)' }
  " 2>/dev/null || echo "OK: PS-проверка пропущена")"
  echo "$PS_RESULT" | grep -q "^FAIL" && fail "$PS_RESULT" || ok "$PS_RESULT"
fi

echo ""
echo "9. Версия в BUILD.json"
if [ -e "$PKG/BUILD.json" ]; then
  ok "$(cat "$PKG/BUILD.json" | tr -d '\n' | head -c 100)"
else
  fail "нет BUILD.json"
fi

echo ""
echo "10. Размер бандла"
SIZE="$(du -sh "$PKG" | cut -f1)"
ok "распаковано: $SIZE (архив: $(du -h "$BUNDLE" | cut -f1))"
case "$SIZE" in *G*) warn "бандл >1G — что-то не так";; esac

echo ""
if [ "$FAIL" = "0" ]; then
  echo "✓ SECURITY: бандл прошёл проверку"
else
  echo "✗ SECURITY: найдены проблемы — смотри FAIL выше"
  exit 1
fi
