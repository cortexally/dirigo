#!/bin/bash
# dirigo — УДАЛЁННАЯ ПОЛОВИНА УСТАНОВКИ (V3-1): всё, что выполняется НА VPS.
#
# Вызывается с клиента по ssh (`bash -s`) после scp кода.
# Переменные окружения (задаёт deploy.ts):
#   DIRIGO_HOST_DIR   куда разложен код (по умолчанию /opt/dirigo)
#   DIRIGO_SERVICE_USER  сервисный пользователь (по умолчанию dirigo)
#   DIRIGO_PORT       порт демона (по умолчанию 7271)
#   DIRIGO_PROXY      HTTP-прокси для загрузок (пусто = напрямую)
#   DIRIGO_ENGINES    какие движки ставить (по одному в строке, пусто = все)
#   DIRIGO_INSTALL_BUN  1 = ставить Bun (0 = только если нужен)
#
# НАРУЖУ СЕРВЕР НЕ ПУБЛИКУЕТСЯ: служба слушает 127.0.0.1, доступ — через
# SSH-туннель (machines) или cloudflare quick tunnel (tunnel.ts).
#
# Поддерживается Debian 11+ / Ubuntu 20.04+ (apt + systemd). Остальное — честный отказ.
set -euo pipefail

HOST_DIR="${DIRIGO_HOST_DIR:-/opt/dirigo}"
SERVICE_USER="${DIRIGO_SERVICE_USER:-dirigo}"
PORT="${DIRIGO_PORT:-7271}"
DIRIGO_PROXY="${DIRIGO_PROXY:-}"
ENGINES_DIR="${ENGINES_DIR:-/opt/dirigo-engines}"
DATA_DIR="/home/$SERVICE_USER/.local/share/dirigo"
PROJECTS_DIR="/home/$SERVICE_USER/projects"
ENV_FILE=/etc/dirigo-server.env
INSTALL_BUN="${DIRIGO_INSTALL_BUN:-1}"

step() { echo "==> $*"; }
fail() { echo "ОШИБКА: $*" >&2; exit 1; }

# прокси действует на саму установку: без него из РФ не скачаются ни Bun, ни движки
if [ -n "$DIRIGO_PROXY" ]; then
  export http_proxy="$DIRIGO_PROXY" https_proxy="$DIRIGO_PROXY"
  export HTTP_PROXY="$DIRIGO_PROXY" HTTPS_PROXY="$DIRIGO_PROXY"
  export no_proxy="127.0.0.1,localhost,::1" NO_PROXY="127.0.0.1,localhost,::1"
  step "Прокси: ${DIRIGO_PROXY%%:*}://•••"
fi

# -- что за машина -----------------------------------------------------------
[ "$(id -u)" = "0" ] || fail "скрипт должен выполняться от root."
command -v systemctl >/dev/null 2>&1 || fail "на машине нет systemd — поддерживаются Debian 11+ и Ubuntu 20.04+."
command -v apt-get >/dev/null 2>&1 || fail "на машине нет apt — поддерживаются Debian 11+ и Ubuntu 20.04+."
[ -d "$HOST_DIR" ] || fail "каталог $HOST_DIR пуст — код демона не загружен (scp)."

export DEBIAN_FRONTEND=noninteractive

# -- системные пакеты ----------------------------------------------------------
# build-essential+python3: нативная сборка better-sqlite3/node-pty; git/ripgrep — самим агентам.
step "Системные пакеты"
apt-get update -qq >/dev/null 2>&1 || echo "ВНИМАНИЕ: apt-get update не прошёл — ставим из кэша." >&2
apt-get install -y --no-install-recommends \
  build-essential python3 git ripgrep ca-certificates curl xz-utils unzip >/dev/null 2>&1 ||
  echo "ВНИМАНИЕ: не все базовые пакеты установились." >&2

# -- Bun ------------------------------------------------------------------------
# Наш демон работает на Bun (zero-dep, node-pty опционален). Ставим в /usr/local/bin.
if ! command -v bun >/dev/null 2>&1 || [ "${INSTALL_BUN}" = "1" -a "${BUN_FORCE:-0}" = "1" ]; then
  if [ "$INSTALL_BUN" = "1" ]; then
    step "Bun"
    arch="$(uname -m)"
    case "$arch" in
      x86_64|amd64) bunarch="x64" ;;
      aarch64|arm64) bunarch="aarch64" ;;
      *) echo "ВНИМАНИЕ: неизвестная архитектура $arch — Bun нужен вручную." >&2; bunarch="" ;;
    esac
    if [ -n "$bunarch" ]; then
      BUN_INSTALL=/usr/local bash -c 'curl -fsSL https://bun.sh/install | bash' >/dev/null 2>&1 ||
        echo "ВНИМАНИЕ: Bun не встал через bun.sh — нужен вручную." >&2
    fi
  fi
fi
command -v bun >/dev/null 2>&1 || fail "Bun не найден — без него демон не запустится (DIRIGO_INSTALL_BUN=1 или поставь вручную)."
echo "bun $(bun --version)"

# -- сервисный пользователь ------------------------------------------------------
# ПОЧЕМУ НЕ ROOT: бэкенд запускает CLI-агентов, те выполняют произвольный код
# в каталогах проектов — худший случай под отдельным пользователем — потерянные
# рабочие копии, а не потерянный сервер.
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash "$SERVICE_USER"
  step "создан пользователь $SERVICE_USER"
fi
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 700 "$DATA_DIR"
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 755 "$PROJECTS_DIR"

# -- зависимости демона ------------------------------------------------------------
step "Зависимости демона (bun install)"
cd "$HOST_DIR"
[ -f package.json ] || fail "рядом с кодом нет package.json — нечего устанавливать."
if command -v sudo >/dev/null 2>&1 && [ "$(id -u)" != "0" ]; then :; fi
sudo -u "$SERVICE_USER" bun install --production >/dev/null 2>&1 ||
  runuser -u "$SERVICE_USER" -- bun install --production >/dev/null 2>&1 ||
  { echo "ВНИМАНИЕ: bun install от сервисного пользователя не прошёл — ставим от root." >&2; bun install --production >/dev/null 2>&1; }
chown -R "$SERVICE_USER:$SERVICE_USER" "$HOST_DIR"

# -- движки (CLI-агенты) -------------------------------------------------------------
# БЕЗ ЭТОГО ШАГА СЕРВЕР БЕСПОЛЕЗЕН: сессии падают с «не установлен».
# Движки — в СВОЙ каталог ($ENGINES_DIR), первым в PATH службы: сервис живёт с
# урезанным окружением (никакого профиля), а глобальный /usr закрыт ProtectSystem.
ENGINE_TIMEOUT="${ENGINE_TIMEOUT:-600}"
OLD_NPM_PREFIX="$(npm config get prefix 2>/dev/null || true)"
mkdir -p "$ENGINES_DIR/bin"
chown -R "$SERVICE_USER:$SERVICE_USER" "$ENGINES_DIR"
export npm_config_prefix="$ENGINES_DIR"
export PATH="$ENGINES_DIR/bin:$PATH"

# рецепты (bin → npm-пакет): claude, codex, copilot, gemini, opencode, kilo, minimax, devin
install_engine() {
  local bin="$1" pkg="$2"
  if [ -x "$ENGINES_DIR/bin/$bin" ]; then echo "  $bin: уже стоит"; return 0; fi
  if command -v timeout >/dev/null 2>&1; then
    timeout "$ENGINE_TIMEOUT" npm install -g --no-audit --no-fund --loglevel=error --allow-scripts="$pkg" "$pkg" >/dev/null 2>&1 ||
      echo "ВНИМАНИЕ: $pkg не встал за ${ENGINE_TIMEOUT}с — почти всегда это прокси. Остальные движки ставятся дальше." >&2
  else
    npm install -g --no-audit --no-fund --loglevel=error --allow-scripts="$pkg" "$pkg" >/dev/null 2>&1 ||
      echo "ВНИМАНИЕ: не удалось поставить $pkg." >&2
  fi
  chown -R "$SERVICE_USER:$SERVICE_USER" "$ENGINES_DIR"
  # старая копия из глобального префикса удаляется ТОЛЬКО после успеха новой
  if [ -n "$OLD_NPM_PREFIX" ] && [ "$OLD_NPM_PREFIX" != "$ENGINES_DIR" ] &&
     [ -d "$OLD_NPM_PREFIX/lib/node_modules/$pkg" ]; then
    npm uninstall -g --prefix "$OLD_NPM_PREFIX" --loglevel=error --allow-scripts="$pkg" "$pkg" >/dev/null 2>&1 ||
      echo "  $bin: старая копия в $OLD_NPM_PREFIX осталась (её всё равно не мог обновить никто)." >&2
  fi
  return 0
}

step "Движки"
# по умолчанию — npm-движки из recipes.ts (нативные установщики на удалёнке не гоняем)
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

# node рядом с движками: шимы npm-движков имеют `#!/usr/bin/env node`
for tool in node npm npx; do
  src="$(command -v "$tool" 2>/dev/null || true)"
  [ -n "$src" ] || continue
  src="$(readlink -f "$src" 2>/dev/null || echo "$src")"
  [ "$src" = "$ENGINES_DIR/bin/$tool" ] && continue
  ln -sfn "$src" "$ENGINES_DIR/bin/$tool"
done
# bun тоже кладём ссылкой — некоторые шимы зовут bun
if command -v bun >/dev/null 2>&1; then
  ln -sfn "$(readlink -f "$(command -v bun)")" "$ENGINES_DIR/bin/bun"
fi

# -- проверка от имени службы -----------------------------------------------------------
# «--version от root ничего не доказывает»: служба живёт с урезанным PATH.
SERVICE_PATH="$ENGINES_DIR/bin:/home/$SERVICE_USER/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
as_service() {
  if command -v runuser >/dev/null 2>&1; then
    runuser -u "$SERVICE_USER" -- env -i PATH="$SERVICE_PATH" HOME="/home/$SERVICE_USER" sh -c 'cd "$HOME" && exec "$@"' sh "$@"
  else
    su -s /bin/sh "$SERVICE_USER" -c 'service_path=$1; service_home=$2; shift 2; cd "$service_home" && exec env -i PATH="$service_path" HOME="$service_home" "$@"' sh "$SERVICE_PATH" "/home/$SERVICE_USER" "$@"
  fi
}
step "Проверка окружения службы"
for tool in bun node git; do
  if as_service sh -c "command -v $tool >/dev/null 2>&1"; then echo "  $tool: виден службе"; else echo "ВНИМАНИЕ: $tool не виден службе." >&2; fi
done
for bin in claude codex copilot gemini opencode kilo mcode; do
  [ -e "$ENGINES_DIR/bin/$bin" ] || [ -L "$ENGINES_DIR/bin/$bin" ] || continue
  out="$(as_service timeout -k 5 30 "$ENGINES_DIR/bin/$bin" --version 2>&1)" && rc=0 || rc=$?
  if [ "$rc" = 0 ]; then echo "  $bin: запускается от службы ($(printf '%s' "$out" | head -n 1))";
  else echo "ВНИМАНИЕ: $bin от имени службы не запускается (код $rc)." >&2; fi
done

# -- окружение (переустановка НЕ перезаписывает) ------------------------------------------
if [ ! -f "$ENV_FILE" ]; then
  TOKEN="$(bun -e 'console.log(crypto.randomUUID().replace(/-/g,""))')"
  cat > "$ENV_FILE" <<ENV
NODE_ENV=production
DIRIGO_SERVER_MODE=1
DIRIGO_PORT=$PORT
# Только loopback: наружу не публикуется, доступ через SSH-туннель или cloudflare.
DIRIGO_BIND_HOST=127.0.0.1
DIRIGO_DATA_DIR=$DATA_DIR
DIRIGO_PROJECTS_DIR=$PROJECTS_DIR
# Токен доступа. Демон читает его при подключении (ssh), в UI/CLI — как DIRIGO_TOKEN.
DIRIGO_TOKEN=$TOKEN
# Ключи провайдеров (если работаете по API, а не по подписке CLI):
# ANTHROPIC_API_KEY=
# OPENAI_API_KEY=
ENV
  chmod 640 "$ENV_FILE"
  chown "root:$SERVICE_USER" "$ENV_FILE"
  step "создан $ENV_FILE"
fi
set_env_var() { sed -i "/^${1}=/d" "$ENV_FILE"; [ -n "$2" ] && printf '%s=%s\n' "$1" "$2" >> "$ENV_FILE"; return 0; }
set_env_var DIRIGO_PROXY "$DIRIGO_PROXY"

# -- служба -----------------------------------------------------------------------------------
step "Служба systemd"
cat > /etc/systemd/system/dirigo-server.service <<UNIT
[Unit]
Description=dirigo (серверный режим: агенты работают без ноутбука)
After=network.target

[Service]
WorkingDirectory=$HOST_DIR
ExecStart=$(command -v bun) run src/server.ts
EnvironmentFile=$ENV_FILE
Environment=PATH=$SERVICE_PATH
Environment=HOME=/home/$SERVICE_USER
Environment=NPM_CONFIG_PREFIX=$ENGINES_DIR
User=$SERVICE_USER
Group=$SERVICE_USER
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=full
PrivateTmp=true
ReadWritePaths=/home/$SERVICE_USER $ENGINES_DIR

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now dirigo-server >/dev/null 2>&1 || true
if ! systemctl restart dirigo-server; then
  echo "── journalctl -u dirigo-server (последнее) ──" >&2
  journalctl -u dirigo-server -n 30 --no-pager >&2 2>/dev/null || true
  fail "служба dirigo-server не запустилась — причина выше, в её журнале."
fi
step "служба dirigo-server перезапущена"

# -- проверка -----------------------------------------------------------------------------------
step "Проверка"
HEALTH=""
for _ in $(seq 1 30); do
  HEALTH="$(curl -fsS --noproxy '*' "http://127.0.0.1:$PORT/api/health" 2>/dev/null || true)"
  [ -n "$HEALTH" ] && break
  sleep 1
done
[ -n "$HEALTH" ] || fail "служба не отвечает на /api/health — смотрите journalctl -u dirigo-server."
echo "$HEALTH"

echo ""
echo "─────────────────────────────────────────────"
echo "Каталог проектов на сервере: $PROJECTS_DIR"
echo "Наружу порт не открыт: доступ — SSH-туннелем (v2 machines) или cloudflare (v2 tunnel)."
echo "DIRIGO_RESULT_PORT=$PORT"
echo "DIRIGO_RESULT_TOKEN=$(grep '^DIRIGO_TOKEN=' "$ENV_FILE" | cut -d= -f2)"
