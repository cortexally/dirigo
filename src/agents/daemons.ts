// Фоновые процессы, которые агенты оставляют после себя.
//
// Некоторые CLI при запуске поднимают отвязанный демон и не гасят его на
// выходе. cline: `cline.exe --cline-hub-daemon --cwd <папка> --port …` живёт
// дальше сам по себе. На Windows процесс держит свою рабочую папку, поэтому
// копия проекта после cline-сессии не удалялась («resource busy»), а такие
// демоны копились по одному на каждую сессию.
//
// Гасим их адресно: только известные демоны и только привязанные к папке
// этой сессии — чужие процессы пользователя не трогаем.

/** Признаки отвязанных демонов агентов в командной строке. */
const DAEMON_MARKERS = ["--cline-hub-daemon"];

/** Варианты написания пути в командной строке: C:\a\b, C:/a/b. */
function pathForms(dir: string): string[] {
  const back = dir.replace(/\//g, "\\").replace(/\\+$/, "");
  const fwd = back.replace(/\\/g, "/");
  return [...new Set([back, fwd])];
}

/** Агенты, за которыми остаются отвязанные демоны. */
export const AGENTS_WITH_DAEMONS = new Set(["cline", "freebuff"]);

/**
 * Процесс-помощник БЕЗ блокировки цикла событий. Демон однопоточный: синхронный
 * `powershell Get-CimInstance` (обычно 1–3 с, на нагруженной машине — десятки)
 * замораживал весь пульт на каждой остановке и удалении сессии и при старте.
 */
async function runAsync(cmd: string[], timeoutMs: number): Promise<{ code: number | null; out: string }> {
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    const timer = setTimeout(() => { try { proc.kill(); } catch { /* уже вышел */ } }, timeoutMs);
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    clearTimeout(timer);
    return { code, out };
  } catch { return { code: null, out: "" }; }
}

function killScriptWin(dir: string): string {
  const forms = pathForms(dir).map((p) => p.toLowerCase().replace(/'/g, "''"));
  const markers = DAEMON_MARKERS.map((m) => `$c.Contains('${m.toLowerCase()}')`).join(" -or ");
  const paths = forms.map((p) => `$c.Contains('${p}')`).join(" -or ");
  return "$k = @(Get-CimInstance Win32_Process | Where-Object { $c = ([string]$_.CommandLine).ToLower(); " +
    `$_.ProcessId -ne $PID -and (${markers}) -and (${paths}) }); foreach ($p in $k) { try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop } catch {} }; $k.Count`;
}

/** Погасить демоны агентов папки dir — асинхронно (для пульта: API, остановка, удаление). */
export async function killAgentDaemonsAsync(dir: string): Promise<number> {
  if (!dir) return 0;
  if (process.platform === "win32") {
    const r = await runAsync(["powershell", "-NoProfile", "-NonInteractive", "-Command", killScriptWin(dir)], 15_000);
    return Number(r.out.trim()) || 0;
  }
  let n = 0;
  for (const form of pathForms(dir)) {
    for (const m of DAEMON_MARKERS) {
      const r = await runAsync(["pkill", "-f", `${m}.*--cwd ${form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`], 5_000);
      if (r.code === 0) n++;
    }
  }
  return n;
}

/** Погасить демоны агентов, привязанные к папке dir. Синхронно, с таймаутом. */
export function killAgentDaemons(dir: string): number {
  if (!dir) return 0;
  try {
    if (process.platform === "win32") {
      // сам этот powershell содержит в командной строке и маркер, и путь — исключён по $PID
      const r = Bun.spawnSync(["powershell", "-NoProfile", "-NonInteractive", "-Command", killScriptWin(dir)], { stdout: "pipe", stderr: "ignore", timeout: 15_000 });
      return Number(r.stdout.toString().trim()) || 0;
    }
    let n = 0;
    for (const form of pathForms(dir)) {
      for (const m of DAEMON_MARKERS) {
        const r = Bun.spawnSync(["pkill", "-f", `${m}.*--cwd ${form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`], { stdout: "ignore", stderr: "ignore", timeout: 5_000 });
        if (r.exitCode === 0) n++;
      }
    }
    return n;
  } catch {
    return 0;  // уборка — не повод ронять остановку сессии
  }
}

/**
 * Уборка сирот, которые агенты оставляют, если их сессию закрыли не штатно
 * (демон остановлен снаружи, обновление, перезагрузка пульта):
 *  • хабы cline, привязанные к копиям проектов этого демона (data/work);
 *  • сторожа freebuff (`codebuff-watchdog-disarm-<pid>`), чей freebuff уже
 *    мёртв: такой сторож пытается писать в закрытую консоль и висит вечно.
 * Живые процессы пользователя не трогаем: хаб — только в нашей папке копий,
 * сторож — только если его freebuff больше не существует.
 */
function sweepScriptWin(workDir: string): string {
  const roots = pathForms(workDir).map((p) => p.toLowerCase().replace(/'/g, "''"));
  const inWork = roots.map((p) => `$c.Contains('--cwd ${p}')`).join(" -or ");
  return "$k = @(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $(" +
    "$c = ([string]$_.CommandLine).ToLower(); " +
    `($c.Contains('--cline-hub-daemon') -and (${inWork})) -or ` +
    "($c -match 'codebuff-watchdog-disarm-(\\d+)' -and -not (Get-Process -Id ([int]$Matches[1]) -ErrorAction SilentlyContinue))" +
    ") }); foreach ($p in $k) { try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop } catch {} }; $k.Count";
}

/** Уборка сирот — асинхронно (пульт: старт, остановка сессии). */
export async function sweepAgentOrphansAsync(workDir: string): Promise<number> {
  if (process.platform !== "win32") {
    let n = 0;
    for (const form of pathForms(workDir)) {
      const r = await runAsync(["pkill", "-f", `--cline-hub-daemon.*--cwd ${form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`], 5_000);
      if (r.code === 0) n++;
    }
    return n;
  }
  const r = await runAsync(["powershell", "-NoProfile", "-NonInteractive", "-Command", sweepScriptWin(workDir)], 20_000);
  return Number(r.out.trim()) || 0;
}

/** Убить дерево процесса — асинхронно. */
export async function killPidTreeAsync(pid: number | null | undefined): Promise<void> {
  if (!pid) return;
  if (process.platform === "win32") { await runAsync(["taskkill", "/PID", String(pid), "/T", "/F"], 10_000); return; }
  try { process.kill(pid, "SIGTERM"); } catch { /* уже мёртв */ }
}

export function sweepAgentOrphans(workDir: string): number {
  if (process.platform !== "win32") {
    let n = 0;
    for (const form of pathForms(workDir)) {
      const r = Bun.spawnSync(["pkill", "-f", `--cline-hub-daemon.*--cwd ${form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`], { stdout: "ignore", stderr: "ignore", timeout: 5_000 });
      if (r.exitCode === 0) n++;
    }
    return n;
  }
  try {
    const roots = pathForms(workDir).map((p) => p.toLowerCase().replace(/'/g, "''"));
    const inWork = roots.map((p) => `$c.Contains('--cwd ${p}')`).join(" -or ");
    const script =
      "$k = @(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $(" +
      "$c = ([string]$_.CommandLine).ToLower(); " +
      `($c.Contains('--cline-hub-daemon') -and (${inWork})) -or ` +
      "($c -match 'codebuff-watchdog-disarm-(\\d+)' -and -not (Get-Process -Id ([int]$Matches[1]) -ErrorAction SilentlyContinue))" +
      ") }); foreach ($p in $k) { try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop } catch {} }; $k.Count";
    const r = Bun.spawnSync(["powershell", "-NoProfile", "-NonInteractive", "-Command", script], { stdout: "pipe", stderr: "ignore", timeout: 20_000 });
    return Number(r.stdout.toString().trim()) || 0;
  } catch { return 0; }
}

/** Убить процесс вместе с деревом потомков (Windows: taskkill /T). */
export function killPidTree(pid: number | null | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === "win32") Bun.spawnSync(["taskkill", "/PID", String(pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore", timeout: 10_000 });
    else process.kill(pid, "SIGTERM");
  } catch { /* уже мёртв */ }
}
