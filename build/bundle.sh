#!/usr/bin/env bash
# Dirigo — упаковка прод-бандла (V7-2).
#
# Собирает `build/dirigo-<ver>.tar.gz` и `.zip` + `SHA256SUMS`:
#   src/ web/ scripts/orch.ts scripts/mcp.ts sdk/ skills/ providers.json
#   plugins.json start.ps1 start.sh orch.cmd orch LICENSE README.md
#   .env.example Dockerfile docker-compose.yml
#
# НЕ включает (dev-only): node_modules, tests, data, docs (кроме LICENSE),
# research, .git, RUNTIME.md, бэкапы, логи.
#
# Запуск: из корня dirigo:  bash build/bundle.sh
# Результат: build/dist/dirigo-<ver>.tar.gz + .zip + SHA256SUMS
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# ─── версия из src/server.ts (единственный источник правды) ───
VERSION="$(grep -oP 'APP_VERSION = "\K[^"]+' src/server.ts | head -1)"
[ -z "$VERSION" ] && { echo "FATAL: не найдена APP_VERSION в src/server.ts"; exit 1; }
echo "→ версия: $VERSION"

OUT="build/dist"
STAGE="build/.stage"
rm -rf "$OUT" "$STAGE"
mkdir -p "$OUT" "$STAGE/dirigo"

# ─── что попадает в бандл (whitelist — всё явно) ───
INCLUDE=(
  src
  web
  scripts/orch.ts
  scripts/mcp.ts
  scripts/sdk-contracts.ts
  sdk
  skills
  providers.json
  plugins.json
  start.ps1
  start.sh
  orch.cmd
  orch
  LICENSE
  README.md
  .env.example
  Dockerfile
  docker-compose.yml
)

# ─── защита: чего точно не должно быть (denylist — проверка после копирования) ───
DENY_PATTERNS=(
  "node_modules"
  "data/db.json"
  "data/secrets.json"
  "data/logs"
  "data/work"
  ".git"
  "tests"
  "*.pem"
  "*.key"
  "*.log"
  "RUNTIME.md"
  "BACKLOG.md"
)

copy_include() {
  for item in "${INCLUDE[@]}"; do
    if [ -e "$item" ]; then
      mkdir -p "$STAGE/dirigo/$(dirname "$item")"
      cp -r "$item" "$STAGE/dirigo/$item"
      echo "  + $item"
    else
      echo "  ! пропущен (нет): $item"
    fi
  done
}

echo "→ staging прод-файлов"
copy_include

# Лаунчеры лежат в корне репозитория (на уровень выше), но в дистрибутиве они
# обязаны быть рядом с продуктом: пользователь после установки запускает
# ./run.sh, а не ищет инструкцию.
echo "→ лаунчеры run/stop"
for l in run.sh run.bat stop.sh stop.bat; do
  if [ -e "../$l" ]; then
    cp "../$l" "$STAGE/dirigo/$l"
    # В дистрибутиве продукт лежит одним каталогом, без подкаталога
    # приложения: переписываем путь, который лаунчеры ждут в дев-дереве.
    # scan-ok: имя каталога дев-дерева — часть подстановки, а не текста.
    sed -i.bak 's|APP="$ROOT/orchestra"|APP="$ROOT"|; s|APP=%ROOT%\\orchestra|APP=%ROOT%|' "$STAGE/dirigo/$l" 2>/dev/null || true
    rm -f "$STAGE/dirigo/$l.bak"
    chmod +x "$STAGE/dirigo/$l" 2>/dev/null || true
    echo "  + $l"
  else
    echo "  ! пропущен (нет): $l"
  fi
done

# ─── проверка denylist: если что-то запрещённое попало — падаем ───
echo "→ проверка denylist (секреты/мусор не должны попасть)"
for pat in "${DENY_PATTERNS[@]}"; do
  if find "$STAGE/dirigo" -name "$pat" 2>/dev/null | grep -q .; then
    echo "FATAL: в бандл попал запрещённый артефакт: $pat"
    find "$STAGE/dirigo" -name "$pat" | head -5
    exit 1
  fi
done

# ─── версия и дата сборки в метаданных бандла ───
cat > "$STAGE/dirigo/BUILD.json" <<EOF
{
  "product": "dirigo",
  "version": "$VERSION",
  "built": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "bundle": "production (no dev artifacts)"
}
EOF

# ─── упаковка: tar.gz + zip ───
NAME="dirigo-$VERSION"
cd "$STAGE"
tar -czf "$ROOT/$OUT/$NAME.tar.gz" dirigo
# zip: если есть zip — используем, иначе пропускаем с предупреждением
if command -v zip >/dev/null 2>&1; then
  zip -qr "$ROOT/$OUT/$NAME.zip" dirigo
else
  echo "  ! zip не установлен — только tar.gz"
fi
cd "$ROOT"

# ─── контрольные суммы ───
cd "$OUT"
sha256sum "$NAME.tar.gz" "$NAME.zip" 2>/dev/null > SHA256SUMS || sha256sum "$NAME.tar.gz" > SHA256SUMS
# манифест версий — рядом с бандлами: установщик читает $BASE_URL/latest.json
cat > latest.json <<EOF
{
  "version": "$VERSION"
}
EOF
cd "$ROOT"

# ─── итог ───
echo ""
echo "✓ бандл собран:"
ls -lh "$OUT"
echo ""
echo "SHA256:"
cat "$OUT/SHA256SUMS"
