// Хаб cline под присмотром пульта (Windows).
//
// cline при первом запуске поднимает фоновый хаб `cline.exe --cline-hub-daemon`
// ОТВЯЗАННЫМ процессом (detached): у хаба нет консоли, и каждый процесс, который он
// запускает (оболочка, коннекторы), открывает новое окно терминала. Хаб переживает
// сессию и пульт — окна продолжали появляться и после остановки bun.exe. А с рабочей
// папкой = копией сессии он ещё и держал копию («resource busy»).
//
// Поэтому перед запуском cline пульт сам поднимает хаб: дочерним процессом со скрытой
// консолью (её наследуют все процессы хаба — окон нет), в нейтральной папке (копии не
// держит), и хаб завершается вместе с пультом. cline находит его через файл
// обнаружения (~/.cline/data/locks/hub/production.json) и свой хаб не запускает.
// Живой хаб пользователя (уже записан в файле обнаружения) не трогаем.

import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { dataDir } from "../worktrees";
import { secretsEnv } from "../secrets";

let hub: ReturnType<typeof Bun.spawn> | null = null;
let starting: Promise<boolean> | null = null;

export function clineDiscoveryFile(): string {
  return process.env.CLINE_HUB_DISCOVERY_PATH?.trim() || join(homedir(), ".cline", "data", "locks", "hub", "production.json");
}

/** pid из файла обнаружения, если процесс жив. */
export function liveHubPid(file = clineDiscoveryFile()): number | null {
  try {
    const pid = Number(JSON.parse(readFileSync(file, "utf8")).pid);
    if (!pid) return null;
    process.kill(pid, 0);
    return pid;
  } catch { return null; }
}

/** Порт 0: свободный порт (запишется в файл обнаружения). Фиксированный 25463 занят
 *  любым другим хабом — второй хаб падал с EADDRINUSE. */
const HUB_FLAGS = (cwd: string) => ["--cline-hub-daemon", "--cwd", cwd, "--host", "127.0.0.1", "--port", "0", "--pathname", "/hub"];

/** argv хаба: платформенный cline.exe рядом с npm-обёрткой, иначе — сама обёртка. */
export function hubArgv(command: string[], cwd: string): string[] {
  const script = command.find((a) => /[\\/]cline[\\/]bin[\\/]cline(\.js)?$/i.test(a));
  if (script) {
    const scoped = join(dirname(dirname(script)), "node_modules", "@cline");
    try {
      for (const d of readdirSync(scoped)) {
        const exe = join(scoped, d, "bin", process.platform === "win32" ? "cline.exe" : "cline");
        if (d.startsWith("cli-") && existsSync(exe)) return [exe, ...HUB_FLAGS(cwd)];
      }
    } catch { /* нет платформенного пакета — через обёртку */ }
  }
  return [...command, ...HUB_FLAGS(cwd)];
}

/**
 * Хаб cline готов (свой или уже живой). Только Windows: на macOS/Linux отвязанный
 * процесс окон не открывает. Не бросает: без хаба cline поднимет свой, как раньше.
 */
export async function ensureClineHub(command: string[], waitMs = 8000): Promise<boolean> {
  if (process.platform !== "win32" || process.env.DIRIGO_CLINE_HUB === "0") return false;
  if (hub && hub.exitCode === null && liveHubPid() === hub.pid) return true;
  if (liveHubPid()) return true; // хаб пользователя или прошлый — не трогаем
  if (starting) return starting;
  starting = (async () => {
    try {
      const dir = join(dataDir(), "cline-hub");
      mkdirSync(dir, { recursive: true });
      hub = Bun.spawn(hubArgv(command, dir), {
        cwd: dir, stdin: "ignore", stdout: "ignore", stderr: "ignore", windowsHide: true,
        env: { ...secretsEnv(dir), CLINE_NO_INTERACTIVE: "1", CLINE_RUN_AS_HUB_DAEMON: "1" },
      });
      process.once("exit", stopClineHub);
      const until = Date.now() + waitMs;
      while (Date.now() < until) {
        if (hub.exitCode !== null) return false;
        if (liveHubPid() === hub.pid) return true;
        await Bun.sleep(150);
      }
      return liveHubPid() === hub.pid;
    } catch { return false; } finally { starting = null; }
  })();
  return starting;
}

/** pid хаба, который поднял пульт (для тестов и уборки). */
export function ownHubPid(): number | null { return hub && hub.exitCode === null ? hub.pid : null; }

export function stopClineHub(): void {
  try { hub?.kill(); } catch { /* уже завершён */ }
  hub = null;
}
