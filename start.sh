# Dirigo — запуск демона (macOS/Linux).
# Требуется bun (если нет — install-скрипт поставит).
# Использование: ./start.sh  →  http://127.0.0.1:7171
set -e
cd "$(dirname "$0")"

# Bun в PATH?
if ! command -v bun >/dev/null 2>&1; then
  for shim in "$HOME/.bun/bin/bun" /usr/local/bin/bun /opt/homebrew/bin/bun; do
    [ -x "$shim" ] && export PATH="$(dirname "$shim"):$PATH" && break
  done
fi
command -v bun >/dev/null 2>&1 || { echo "bun не найден. Установи: curl -fsSL https://bun.sh/install | bash"; exit 1; }

export PORT="${PORT:-7171}"
echo "Dirigo: http://127.0.0.1:$PORT"
# открыть браузер (best-effort: macOS/Linux различаются)
(open "http://127.0.0.1:$PORT" 2>/dev/null || xdg-open "http://127.0.0.1:$PORT" 2>/dev/null) || true
exec bun run src/server.ts
