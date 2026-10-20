// Dirigo — машины и SSH-туннели (V3-2).
//
// Реестр удалённых машин + локальный доступ к их демону через `ssh -L`
// (служба слушает 127.0.0.1, наружу не публикуется). Probe —
// health через туннель. Состояние — data/machines.json (с DIRIGO_DATA).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { appendLog, uid } from "./store";
import { sshArgs } from "./deploy";

export interface Machine {
  id: string;
  name: string;
  host: string;
  user: string;
  port?: number;
  identity?: string;
  /** порт демона на удалёнке */
  daemonPort: number;
  /** локальный порт туннеля (по умолчанию = daemonPort + 1000) */
  localPort: number;
  /** прокси для загрузок на удалёнке */
  proxy?: string;
  /** статус последней проверки */
  lastStatus?: "up" | "down" | "unknown";
  lastCheckedAt?: number;
  /** версия демона с удалёнки (из health) */
  version?: string;
  createdAt: number;
}

const DATA_DIR = (process.env.DIRIGO_DATA
  ? process.env.DIRIGO_DATA.replace(/[\\/]+$/, "") + "/"
  : new URL("../data/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const FILE = `${DATA_DIR}machines.json`;
let machines: Machine[] = [];

export function loadMachines(): void {
  try {
    if (!existsSync(FILE)) return;
    const raw = JSON.parse(readFileSync(FILE, "utf8"));
    if (Array.isArray(raw)) machines = raw;
  } catch { machines = []; }
}

function save(): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(FILE, JSON.stringify(machines, null, 2), "utf8");
  } catch { /* диск недоступен */ }
}

export function listMachines(): Machine[] { return machines; }
export function getMachine(id: string): Machine | undefined { return machines.find((m) => m.id === id); }

export function addMachine(input: Omit<Machine, "id" | "createdAt" | "localPort"> & { localPort?: number }): Machine {
  const m: Machine = {
    ...input,
    id: uid("mcn"),
    localPort: input.localPort ?? input.daemonPort + 1000,
    createdAt: Date.now(),
  };
  machines.push(m);
  save();
  return m;
}

export function removeMachine(id: string): boolean {
  const before = machines.length;
  machines = machines.filter((m) => m.id !== id);
  save();
  return machines.length < before;
}

/** Аргументы `ssh -L` для локального доступа к демону машины. */
export function tunnelArgs(m: Machine): string[] {
  return [...sshArgs({ host: m.host, user: m.user, port: m.port, identity: m.identity }), "-N", "-L", `${m.localPort}:127.0.0.1:${m.daemonPort}`];
}

/** Probe: health демона через разовый ssh-туннель (фоном, без долгого -N). */
export async function probeMachine(id: string): Promise<{ ok: boolean; version?: string; error?: string }> {
  const m = getMachine(id);
  if (!m) return { ok: false, error: "машина не найдена" };
  const args = [
    ...sshArgs({ host: m.host, user: m.user, port: m.port, identity: m.identity }),
    `curl -fsS --noproxy '*' http://127.0.0.1:${m.daemonPort}/api/health || echo DOWN`,
  ];
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  if (out.includes("DOWN") || !out.trim()) {
    m.lastStatus = "down"; m.lastCheckedAt = Date.now(); save();
    return { ok: false, error: "демон не отвечает (служба поднята? порт верный?)" };
  }
  try {
    const h = JSON.parse(out) as { ok?: boolean };
    m.lastStatus = h.ok ? "up" : "down";
    m.lastCheckedAt = Date.now();
    m.version = out.match(/uptimeMs":\s*(\d+)/) ? "up" : undefined;
    save();
    return { ok: !!h.ok };
  } catch {
    m.lastStatus = "down"; m.lastCheckedAt = Date.now(); save();
    return { ok: false, error: "не разобрал ответ health" };
  }
}

/** Открыть долгий туннель (фон): Bun.spawn ssh -N -L. Возвращает pid для стопа. */
export function openTunnel(id: string): { pid: number; localPort: number } | { error: string } {
  const m = getMachine(id);
  if (!m) return { error: "машина не найдена" };
  const proc = Bun.spawn(tunnelArgs(m), { stdout: "ignore", stderr: "ignore" });
  void appendLog("machines", `[dirigo] туннель ${m.name}: http://127.0.0.1:${m.localPort}\n`);
  return { pid: proc.pid, localPort: m.localPort };
}
