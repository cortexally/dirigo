// Dirigo — SSH-деплой демона на удалённую машину (V3-1).
//
// Клиентская половина: собирает ssh-команды, гоняет установщик
// (`scripts/remote-install.sh`) по ssh и печатает поток. Runner инжектится —
// в тестах подменяется моком, в проде — Bun.spawn("ssh").
//
// Поток деплоя демона на удалённую машину:
//   scp кода демона → ssh "bash -s" < remote-install.sh → машинные маркеры
//   DIRIGO_RESULT_PORT / DIRIGO_RESULT_TOKEN.

import { appendLog } from "./store";

export interface SshTarget {
  host: string;
  user: string;
  port?: number;
  /** путь к приватному ключу (или ssh-agent по умолчанию) */
  identity?: string;
  /** строка для sshpass (НЕ хранится в логах) */
  password?: string;
  /** прокси для загрузок на удалёнке */
  proxy?: string;
}

export type LineSink = (line: string) => void;

/** Исполнитель shell-команд (инжектируется для тестов). */
export type Runner = (cmd: string[], opts?: { stdin?: string }) => Promise<{ code: number; out: string; err: string }>;

/** Просе-раннер через Bun.spawn (прод). */
export const sshRunner: Runner = async (cmd, opts) => {
  const proc = Bun.spawn(cmd, {
    stdin: opts?.stdin ? new TextEncoder().encode(opts.stdin) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out, err };
};

/** Сборка базовых ssh-аргументов. */
export function sshArgs(t: SshTarget): string[] {
  const args = ["ssh", "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=15"];
  if (t.port) args.push("-p", String(t.port));
  if (t.identity) args.push("-i", t.identity);
  args.push(`${t.user}@${t.host}`);
  return args;
}

/** Сборка scp-аргументов (рекурсивно). */
export function scpArgs(t: SshTarget, from: string, to: string): string[] {
  const args = ["scp", "-r", "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=15"];
  if (t.port) args.push("-P", String(t.port));
  if (t.identity) args.push("-i", t.identity);
  args.push(from, `${t.user}@${t.host}:${to}`);
  return args;
}

export interface DeployOptions {
  /** порт демона на удалёнке */
  port?: number;
  /** куда разложить код (по умолчанию /opt/dirigo) */
  targetDir?: string;
  /** какие движки ставить: "claude codex" — имена бинарников; по умолчанию все npm */
  engines?: string[];
  /** ставить ли Bun (по умолчанию да) */
  installBun?: boolean;
  /** локальный путь кода демона (по умолчанию — корень проекта, где лежит server.ts) */
  localDir?: string;
  dryRun?: boolean;
}

export interface DeployResult {
  ok: boolean;
  port?: number;
  token?: string;
  log: string[];
  error?: string;
}

/** Машинные маркеры из потока установщика. */
export function parseMarkers(text: string): { port?: number; token?: string } {
  const port = text.match(/DIRIGO_RESULT_PORT=(\d+)/)?.[1];
  const token = text.match(/DIRIGO_RESULT_TOKEN=([\w-]+)/)?.[1];
  return { port: port ? Number(port) : undefined, token };
}

export type RemoteOs = "linux" | "darwin" | "windows" | "unknown";

/** Определение ОС удалёнки: `uname -s` (lin/mac) → `cmd /c ver` (win). */
export async function probeRemoteOs(t: SshTarget, run: Runner = sshRunner): Promise<RemoteOs> {
  try {
    const r = await run([...sshArgs(t), "uname", "-s"], {});
    if (r.out.trim()) return classifyOs(r.out);
  } catch { /* не unix — пробуем windows */ }
  try {
    const r = await run([...sshArgs(t), "cmd", "/c", "ver"], {});
    if (r.out.trim()) return classifyOs(r.out);
  } catch { /* нет доступа */ }
  return "unknown";
}

export function classifyOs(text: string): RemoteOs {
  const s = text.toLowerCase();
  if (s.includes("darwin")) return "darwin";
  if (s.includes("linux")) return "linux";
  if (s.includes("windows") || s.includes("microsoft")) return "windows";
  return "unknown";
}

/** Файл установщика для ОС удалёнки. */
export function installerFor(os: RemoteOs): string {
  if (os === "windows") return "remote-install.ps1";
  if (os === "darwin") return "remote-install-macos.sh";
  return "remote-install.sh";
}

/**
 * Деплой: scp кода → `bash -s` с установщиком по ssh → маркеры.
 * Пароль (если задан) идёт через sshpass-обёртку и не пишется в лог.
 */
export async function deployDaemon(t: SshTarget, opts: DeployOptions = {}, runner: Runner = sshRunner): Promise<DeployResult> {
  const port = opts.port ?? 7271;
  const targetDir = opts.targetDir ?? "/opt/dirigo";
  const localDir = opts.localDir ?? new URL("../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  const log: string[] = [];
  const say: LineSink = (l) => { log.push(l); void appendLog("deploy", l); };

  const mkCmd = (base: string[]): string[] => {
    if (!t.password) return base;
    return ["sshpass", "-e", ...base]; // пароль через env SSHPASS
  };
  const env = t.password ? { ...process.env, SSHPASS: t.password } : undefined;

  // обёртка runner с env (sshpass)
  const run: Runner = async (cmd, o) => {
    if (t.password) {
      const proc = Bun.spawn(mkCmd(cmd), {
        env: { ...env, ...(o?.stdin ? {} : {}) },
        stdin: o?.stdin ? new TextEncoder().encode(o.stdin) : "ignore",
        stdout: "pipe", stderr: "pipe",
      });
      const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      return { code, out, err };
    }
    return runner(cmd, o);
  };

  try {
    say(`== деплой на ${t.user}@${t.host}: ${localDir} → ${targetDir}\n`);
    if (opts.dryRun) {
      const scpCmd = scpArgs(t, localDir, targetDir);
      const shCmd = sshArgs(t);
      say(`[dry-run] ${scpCmd.join(" ")}\n`);
      say(`[dry-run] ${shCmd.join(" ")} bash -s < remote-install.sh\n`);
      return { ok: true, log };
    }

    const remoteOs = await probeRemoteOs(t, run);
    const installer = installerFor(remoteOs);
    say(`OS: ${remoteOs} -> ${installer}\n`);

    // 1) готовим каталог на удалёнке
    say("[1/3] подготовка каталога\n");
    const pre = await run([...mkCmd(sshArgs(t)), "bash", "-s"], {
      stdin: `set -e\nmkdir -p ${targetDir}\ncommand -v rsync >/dev/null 2>&1 || apt-get install -y --no-install-recommends rsync >/dev/null 2>&1 || true\necho ok\n`,
    });
    if (pre.code !== 0) return { ok: false, log, error: `подготовка: ${pre.err.trim().slice(0, 300)}` };

    // 2) scp кода (пути — прямыми слэшами: scp на windows их принимает)
    say("[2/3] загрузка кода (scp)\n");
    const base = localDir.replace(/\\/g, "/").replace(/\/+$/, "");
    const files = ["src", "web", "scripts", "package.json", "plugins.json", "providers.json"];
    const dest = remoteOs === "windows" ? targetDir.replace(/\//g, "\\") : targetDir + "/";
    const scp = await run(scpArgs(t, files.map((f) => `${base}/${f}`).join(" "), targetDir + "/"));
    if (scp.code !== 0) return { ok: false, log, error: `scp: ${scp.err.trim().slice(0, 300)}` };

    // 3) установщик по ssh
    say(`[3/3] install (${installer} over ssh)\n`);
    const script = await Bun.file(new URL(`../scripts/${installer}`, import.meta.url)).text();
    const envLines = [
      `DIRIGO_PORT=${port}`,
      `DIRIGO_HOST_DIR=${targetDir}`,
      `DIRIGO_INSTALL_BUN=${opts.installBun === false ? "0" : "1"}`,
      `DIRIGO_ENGINES=${(opts.engines ?? []).join(" ")}`,
      opts.proxy ? `DIRIGO_PROXY=${opts.proxy}` : "DIRIGO_PROXY=",
    ].join("\n");
    const runCmd = remoteOs === "windows"
      ? ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "-"]
      : ["bash", "-s"];
    const inst = await run([...sshArgs(t), ...runCmd], { stdin: `${envLines}\n${script}` });
    for (const line of (inst.out + "\n" + inst.err).split(/\r?\n/)) if (line.trim()) say("  " + line + "\n");
    const markers = parseMarkers(inst.out + "\n" + inst.err);
    if (inst.code !== 0) return { ok: false, port: markers.port, token: markers.token, log, error: `установщик вернул код ${inst.code}` };
    say(`\n== готово: порт ${markers.port ?? port}\n`);
    return { ok: true, port: markers.port ?? port, token: markers.token, log };
  } catch (e) {
    return { ok: false, log, error: String(e) };
  }
}
