#!/bin/bash
# dirigo — УДАЛЁННАЯ УСТАНОВКА НА macOS (V4-3): launchd вместо systemd.
# Переменные и логика — как у linux-версии (remote-install.sh).
#
# Переменные (передаёт deploy.ts):
#   DIRIGO_HOST_DIR      куда разложен код (/opt/dirigo → на mac лучше ~/dirigo)
#   DIRIGO_PORT          порт демона (7271)
#   DIRIGO_PROXY         прокси для загрузок
#   DIRIGO_INSTALL_BUN   1 = ставить Bun
#   DIRIGO_ENGINES       "bin pkg" по строкам

set -euo pipefail

HOST_DIR="${DIRIGO_HOST_DIR:-$HOME/dirigo}"
PORT="${DIRIGO_PORT:-7271}"
DIRIGO_PROXY="${DIRIGO_PROXY:-}"
ENGINES_DIR="${ENGINES_DIR:-$HOME/.dirigo-engines}"
DATA_DIR="$HOME/.local/share/dirigo"
PROJECTS_DIR="$HOME/dirigo-projects"
ENV_FILE="$HOST_DIR/dirigo-server.env"
PLIST="$HOME/Library/LaunchAgents/dev.dirigo.server.plist"
LABEL="dev.dirigo.server"
INSTALL_BUN="${DIRIGO_INSTALL_BUN:-1}"

step() { echo "==> $*"; }
fail() { echo "ОШИБКА: $*" >&2; exit 1; }

[ -d "$HOST_DIR" ] || fail "каталог $HOST_DIR пуст — код не загружен (scp)."
export HOMEBREW_NO_AUTO_UPDATE=1

[ -n "$DIRIGO_PROXY" ] && {
  export http_proxy="$DIRIGO_PROXY" https_proxy="$DIRIGO_PROXY"
  export HTTP_PROXY="$DIRIGO_PROXY" HTTPS_PROXY="$DIRIGO_PROXY"
  export no_proxy="127.0.0.1,localhost,::1" NO_PROXY="127.0.0.1,localhost,::1"
  step "Прокси: ${DIRIGO_PROXY%%:*}://•••"
}

# --- Bun ---
if ! command -v bun >/dev/null 2>&1; then
  if [ "$INSTALL_BUN" = "1" ]; then
    step "Bun"
    bash -c 'curl -fsSL https://bun.sh/install | bash' >/dev/null 2>&1 ||
      echo "ВНИМАНИЕ: bun не встал — нужен вручную (bun.sh)." >&2
    export PATH="$HOME/.bun/bin:$PATH"
  fi
fi
command -v bun >/dev/null 2>&1 || fail "Bun не найден — без него демон не запустится."
echo "bun $(bun --version)"

# --- git (нужен агентам для worktree) ---
command -v git >/dev/null 2>&1 || echo "ВНИМАНИЕ: git не установлен — поставь Xcode CLT (xcode-select --install)." >&2

# --- зависимости демона ---
step "Зависимости демона (bun install)"
cd "$HOST_DIR"
[ -f package.json ] || fail "рядом с кодом нет package.json."
bun install --production >/dev/null 2>&1 || fail "bun install не прошёл."

# --- движки ---
ENGINE_TIMEOUT="${ENGINE_TIMEOUT:-600}"
mkdir -p "$ENGINES_DIR/bin"
export npm_config_prefix="$ENGINES_DIR"
export PATH="$ENGINES_DIR/bin:$PATH"

install_engine() {
  local bin="$1" pkg="$2"
  if [ -x "$ENGINES_DIR/bin/$bin" ] || command -v "$bin" >/dev/null 2>&1; then echo "  $bin: уже стоит"; return 0; fi
  if command -v timeout >/dev/null 2>&1; then
    timeout "$ENGINE_TIMEOUT" npm install -g --no-audit --no-fund --loglevel=error --allow-scripts="$pkg" "$pkg" >/dev/null 2>&1 ||
      echo "ВНИМАНИЕ: $pkg не встал — почти всегда это прокси." >&2
  else
    npm install -g --no-audit --no-fund --loglevel=error --allow-scripts="$pkg" "$pkg" >/dev/null 2>&1 ||
      echo "ВНИМАНИЕ: не удалось поставить $pkg." >&2
  fi
  return 0
}

step "Движки"
if [ -z "${DIRIGO_ENGINES:-}" ]; then
  DIRIGO_ENGINES="claude @anthropic-ai/claude-code
codex @openai/codex
copilot @github/copilot
gemini @google/gemini-cli
opencode opencode-ai
kilo @kilocode/cli
mcode @minimax-ai/code"
fi
echo "$DIRIGO_ENGINES" | while read -r bin pkg; do
  [ -n "${bin:-}" ] && [ -n "${pkg:-}" ] || continue
  install_engine "$bin" "$pkg"
done
for bin in claude codex copilot gemini opencode kilo mcode; do
  if command -v "$bin" >/dev/null 2>&1; then echo "  $bin: есть"; else echo "  $bin: НЕТ"; fi
done

# --- окружение ---
if [ ! -f "$ENV_FILE" ]; then
  TOKEN="$(bun -e 'console.log(crypto.randomUUID().replace(/-/g,""))')"
  cat > "$ENV_FILE" <<ENV
NODE_ENV=production
DIRIGO_SERVER_MODE=1
DIRIGO_PORT=$PORT
# Только loopback: доступ через SSH-туннель или cloudflare.
DIRIGO_BIND_HOST=127.0.0.1
DIRIGO_DATA_DIR=$DATA_DIR
DIRIGO_PROJECTS_DIR=$PROJECTS_DIR
DIRIGO_TOKEN=$TOKEN
ENV
  step "создан $ENV_FILE"
fi

# --- служба: launchd ---
step "Служба launchd"
BUN_BIN="$(command -v bun)"
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$BUN_BIN</string><string>run</string><string>src/server.ts</string></array>
  <key>WorkingDirectory</key><string>$HOST_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$ENGINES_DIR/bin:$HOME/.local/bin:$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key><string>$HOME</string>
    <key>NPM_CONFIG_PREFIX</key><string>$ENGINES_DIR</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
PLIST
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST" 2>/dev/null || true

# --- проверка ---
step "Проверка"
HEALTH=""
for _ in $(seq 1 30); do
  HEALTH="$(curl -fsS --noproxy '*' "http://127.0.0.1:$PORT/api/health" 2>/dev/null || true)"
  [ -n "$HEALTH" ] && break
  sleep 1
done
[ -n "$HEALTH" ] || fail "служба не отвечает на /api/health — смотри launchctl list $LABEL."
echo "$HEALTH"
echo ""
echo "Каталог проектов: $PROJECTS_DIR"
echo "Наружу порт не открыт: доступ — SSH-туннелем или cloudflare."
echo "DIRIGO_RESULT_PORT=$PORT"
echo "DIRIGO_RESULT_TOKEN=$(grep '^DIRIGO_TOKEN=' "$ENV_FILE" | cut -d= -f2)"
