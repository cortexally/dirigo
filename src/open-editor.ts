// Dirigo v1.3 — «Открыть в редакторе» (V5-9).
//
// Открывает папку копии/проекта там, где пользователь привык: VS Code (если
// команда code найдена через PATH — без обхода через shell, который даёт
// ложные срабатывания), иначе — проводник/Finder/файловый менеджер.
// Кнопки «Браузер» намеренно НЕТ (по заданию).

import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

/** Команда реально доступна? Резолвим через PATH, а не через shell. */
function hasBin(cmd: string): boolean {
  if (Bun.which(cmd)) return true;
  // Windows: типичные места установки (npm-глобал, Local Programs)
  const win = process.platform === "win32";
  if (!win) return false;
  const appdata = process.env.APPDATA ?? "";
  const local = process.env.LOCALAPPDATA ?? "";
  const guesses = [
    appdata && `${appdata}\\npm\\${cmd}.cmd`,
    local && `${local}\\Programs\\Microsoft VS Code\\bin\\${cmd}.cmd`,
    local && `${local}\\Programs\\Microsoft VS Code\\Code.exe`,
  ].filter(Boolean) as string[];
  return guesses.some((p) => existsSync(p));
}

const WIN_EDITORS = [
  { label: "VS Code", cmd: "code", exe: "Code.exe", dirs: ["%LOCALAPPDATA%\\Programs\\Microsoft VS Code", "%ProgramFiles%\\Microsoft VS Code"] },
  { label: "Cursor", cmd: "cursor", exe: "Cursor.exe", dirs: ["%LOCALAPPDATA%\\Programs\\cursor", "%ProgramFiles%\\Cursor"] },
];

/** .exe редактора: от .cmd в PATH вверх по каталогам, затем типовые места. */
function winEditorExe(cmd: string, exe: string, dirs: string[]): string | null {
  const env = (p: string) => p.replace(/%([A-Za-z0-9_]+)%/g, (_, k) => process.env[k] ?? "");
  const viaPath = Bun.which(cmd);
  if (viaPath) {
    if (/\.exe$/i.test(viaPath)) return viaPath;
    let d = dirname(viaPath);
    for (let i = 0; i < 4; i++) {
      const cand = join(d, exe);
      if (existsSync(cand)) return cand;
      d = dirname(d);
    }
  }
  for (const base of dirs) {
    const cand = join(env(base), exe);
    if (existsSync(cand)) return cand;
  }
  return null;
}

/** Окружение для GUI-редактора без переменных, ломающих Electron. Если демон
 *  запущен из терминала/задачи VS Code или Cursor, ELECTRON_RUN_AS_NODE=1
 *  превращал Cursor.exe в node: окно не открывалось вовсе, а пульт отвечал «открыто». */
export function editorEnv(): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  for (const k of Object.keys(env)) {
    if (/^(ELECTRON_RUN_AS_NODE|ELECTRON_NO_ATTACH_CONSOLE|NODE_OPTIONS|VSCODE_DEV|VSCODE_IPC_HOOK_CLI|VSCODE_PID|VSCODE_CWD|VSCODE_NLS_CONFIG|VSCODE_HANDLES_UNCAUGHT_ERRORS)$/.test(k)) delete env[k];
  }
  return env;
}

/** Спавн без ожидания: процесс переживает демон, ошибку логируем в detail. */
function spawnDetached(file: string, args: string[], gui = false): { ok: boolean; detail?: string } {
  try {
    // GUI-приложению windowsHide не нужен (он для консольных); окружение — чистое
    const p = spawn(file, args, gui
      ? { detached: true, stdio: "ignore", env: editorEnv() }
      : { detached: true, stdio: "ignore", windowsHide: true });
    p.on("error", (e) => { /* доставлено через unref-поток; detail ниже */ });
    p.unref();
    return { ok: true };
  } catch (e) {
    return { ok: false, detail: String(e instanceof Error ? e.message : e) };
  }
}

/** Открыть папку в редакторе/проводнике. */
export async function openInEditor(dir: string): Promise<{ ok: boolean; detail: string }> {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return { ok: false, detail: "папка не найдена" };
  // тесты проверяют, КАКУЮ папку открыли бы, не открывая окно редактора
  if (process.env.DIRIGO_EDITOR_DRYRUN === "1") return { ok: true, detail: "dry-run" };
  const win = process.platform === "win32";
  const mac = process.platform === "darwin";

  if (win) {
    // VS Code / Cursor. Их команды на Windows — .cmd-обёртки, а spawn без
    // shell .cmd не запускает: ошибка приходила асинхронно, и пульт отвечал
    // «открыто в VS Code», хотя не открывалось ничего. Запускаем сам .exe.
    for (const ed of WIN_EDITORS) {
      const exe = winEditorExe(ed.cmd, ed.exe, ed.dirs);
      if (!exe) continue;
      const r = spawnDetached(exe, [dir], true);
      // холодный старт Electron-редактора — 5–15 с (дольше при первом запуске
      // после загрузки ОС): говорим это прямо, иначе кажется, что ничего не произошло
      if (r.ok) return { ok: true, detail: `${ed.label} открывается — окно появится через несколько секунд` };
    }
    // иначе — проводник (показывает папку всегда)
    const r = spawnDetached("explorer", [dir]);
    return r.ok ? { ok: true, detail: "открыто в проводнике (VS Code и Cursor не найдены)" } : { ok: false, detail: r.detail ?? "не удалось открыть" };
  }
  if (mac) {
    if (hasBin("code")) {
      const r = spawnDetached("code", [dir], true);
      if (r.ok) return { ok: true, detail: "VS Code открывается — окно появится через несколько секунд" };
    }
    const r = spawnDetached("open", [dir]);
    return r.ok ? { ok: true, detail: "открыто в Finder" } : { ok: false, detail: r.detail ?? "не удалось открыть" };
  }
  const r = spawnDetached("xdg-open", [dir]);
  return r.ok ? { ok: true, detail: "открыто в файловом менеджере" } : { ok: false, detail: r.detail ?? "не удалось открыть" };
}
