// Dirigo — cloudflare quick tunnel (V3-3).
//
// Публичный URL демона в два клика, БЕЗ SSH-ключа и аккаунта Cloudflare —
// наше отличие от десктопных аналогов, где удалёнка только по SSH.
// Использует `cloudflared tunnel --url http://127.0.0.1:<port>` (quick tunnel):
// URL печатается в stderr и живёт до остановки процесса.

import { appendLog } from "./store";

export interface TunnelInfo {
  running: boolean;
  url?: string;
  pid?: number;
  error?: string;
  startedAt?: number;
}

let proc: Bun.Subprocess | null = null;
let url: string | undefined;
let startedAt: number | undefined;

/** cloudflared установлен? */
export function cloudflaredAvailable(): boolean {
  return !!Bun.which("cloudflared");
}

/** Текущее состояние туннеля. */
export function tunnelInfo(): TunnelInfo {
  return { running: !!proc, url, pid: proc?.pid, startedAt };
}

/**
 * Старт quick tunnel. port — локальный порт демона (по умолчанию PORT/7271).
 * Готовность — когда в stderr появится https://…trycloudflare.com (до 30с).
 */
export async function startTunnel(port = Number(process.env.PORT ?? process.env.DIRIGO_PORT ?? 7171)): Promise<TunnelInfo> {
  if (proc) return tunnelInfo();
  if (!cloudflaredAvailable()) {
    const how = process.platform === "win32"
      ? "winget install Cloudflare.cloudflared"
      : process.platform === "darwin"
        ? "brew install cloudflared"
        : "см. pkg.cloudflare.com (deb/rpm) или github.com/cloudflare/cloudflared/releases";
    return { running: false, error: `cloudflared не установлен — ${how}` };
  }
  try {
    proc = Bun.spawn(["cloudflared", "tunnel", "--url", `http://127.0.0.1:${port}`, "--no-autoupdate"], {
      stdout: "ignore",
      stderr: "pipe",
    });
    startedAt = Date.now();
    const deadline = Date.now() + 30_000;
    const reader = proc.stderr.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const m = buf.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m) {
        url = m[0];
        void appendLog("tunnel", `[dirigo] tunnel: ${url} → 127.0.0.1:${port}\n`);
        reader.releaseLock();
        return tunnelInfo();
      }
      if (!proc) break;
    }
    reader.releaseLock();
    return { running: true, error: "URL не получен за 30с — смотри лог cloudflared", pid: proc.pid };
  } catch (e) {
    proc = null;
    return { running: false, error: String(e) };
  }
}

/** Остановить туннель. */
export function stopTunnel(): TunnelInfo {
  if (proc) { try { proc.kill(); } catch { /* уже мёртв */ } }
  proc = null; url = undefined; startedAt = undefined;
  void appendLog("tunnel", "[dirigo] tunnel остановлен\n");
  return { running: false };
}
