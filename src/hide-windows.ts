// Windows: консольный процесс (git, powershell, taskkill, bun, агенты), запущенный
// демоном без своей консоли, получает НОВОЕ окно консоли — на прогоне гейта это
// сотни мигающих окон. Поэтому по умолчанию каждый spawn — windowsHide: true.
// Исключения: явно заданный windowsHide и detached-запуски (GUI: редактор, приложение
// агента — скрытие спрятало бы их окно).
// Подключается первым импортом в server.ts и через preload в bunfig.toml (скрипты/тесты).
// Регресс-тест: scripts/hide-windows-test.ts.

import * as childProcess from "node:child_process";

const FLAG = Symbol.for("dirigo.hideWindows");

function withHide(opts: any): any {
  if (opts && typeof opts === "object") {
    if (opts.windowsHide !== undefined || opts.detached) return opts;
    return { ...opts, windowsHide: true };
  }
  return { windowsHide: true };
}

/** Аргументы вызова Bun.spawn/spawnSync: (cmd[], opts?) или ({ cmd, ...opts }). */
function bunArgs(args: any[]): any[] {
  if (args.length && args[0] && typeof args[0] === "object" && !Array.isArray(args[0])) return [withHide(args[0]), ...args.slice(1)];
  return [args[0], withHide(args[1]), ...args.slice(2)];
}

/** Аргументы node child_process: опции — первый объект-не-массив после команды; иначе вставить перед колбэком. */
function nodeArgs(args: any[]): any[] {
  const out = args.slice();
  for (let i = 1; i < out.length; i++) {
    const a = out[i];
    if (a && typeof a === "object" && !Array.isArray(a)) { out[i] = withHide(a); return out; }
  }
  while (out.length > 1 && (out[out.length - 1] === undefined || out[out.length - 1] === null)) out.pop();
  const cb = out.length > 1 && typeof out[out.length - 1] === "function" ? out.pop() : undefined;
  out.push(withHide(undefined));
  if (cb) out.push(cb);
  return out;
}

export function installHideWindows(force = false): boolean {
  if (process.platform !== "win32" && !force) return false;
  const g = globalThis as any;
  if (g[FLAG]) return true;
  g[FLAG] = true;
  const B = Bun as any;
  const spawn = B.spawn, spawnSync = B.spawnSync;
  B.spawn = (...a: any[]) => spawn.apply(B, bunArgs(a));
  B.spawnSync = (...a: any[]) => spawnSync.apply(B, bunArgs(a));
  const cp = childProcess as any;
  const mod = (cp.default ?? cp) as any;
  for (const name of ["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync"]) {
    const orig = mod[name];
    if (typeof orig !== "function") continue;
    try { mod[name] = (...a: any[]) => orig.apply(mod, nodeArgs(a)); } catch { /* модуль заморожен — остаются явные windowsHide */ }
  }
  return true;
}

/** Для теста: то, что будет передано в spawn после подстановки. */
export const _test = { bunArgs, nodeArgs, withHide };

installHideWindows();
