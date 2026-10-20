// Dirigo — «жив ли агент на самом деле» (F_VER-4/F_VER-5).
//
// По всем признакам демона сессия может выглядеть мёртвой, а агент — живым:
// opencode отдаёт ход своему сервису (`opencode-cli.exe run` — клиент, работа
// идёт в сервисе), клиент умирает с кодом 0, а агент продолжает работать и
// писать правки в копию проекта. Тогда:
//   • pid сессии не записан (или мёртв), статус «error» — «все признаки мёртвого»;
//   • удаление сессии сносит копию — у живого агента пропадает рабочая папка
//     («Working directory does not exist»), правки теряются.
//
// Поэтому «жив ли агент» решается не по pid, а по СЛЕДАМ работы:
//
//   1. процессы агента, которые демон знает (runner.isRunning) — живой агент;
//   2. копию трогали ПОСЛЕ ухода клиента агента — работа продолжается в сервисе
//      (это и есть признак «клиент умер, агент жив»);
//   3. ухода агента не зафиксировано, а копия свежая и сессия числится
//      работающей — на всякий случай считаем живым.
//
// Пока агент жив, копию сносить нельзя: ждём, пока он замолчит.

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { cleanupWorktree, getWorktree, protectWorktree, unprotectWorktree } from "./worktrees";

/**
 * Окно свежести активности: сколько времени следы работы считаются «свежими».
 *
 * По умолчанию 10 минут. Агент, который только читает (правок в копии нет),
 * следа не оставляет — его защита держится на времени ухода клиента и на
 * сообщениях демона (см. sessionAlive).
 */
export const ACTIVITY_WINDOW_MS = Number(process.env.DIRIGO_ACTIVITY_WINDOW_MS ?? 10 * 60_000);

/** Новейшее время изменения в папке (ограниченный обход): 0 — пусто. */
export function newestMtime(dir: string, depth = 3): number {
  let newest = 0;
  const walk = (d: string, level: number): void => {
    if (level > depth) return;
    let entries: any[] = [];
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(d, e.name);
      try {
        const st = statSync(p);
        if (st.mtimeMs > newest) newest = st.mtimeMs;
        if (e.isDirectory()) walk(p, level + 1);
      } catch { /* занято — пропускаем */ }
    }
  };
  walk(dir, 0);
  return newest;
}

/** Когда последний раз трогали копию (сама папка и её содержимое): 0 — нет. */
export function copyTouchedAt(path: string | undefined | null): number {
  if (!path) return 0;
  let newest = 0;
  try { newest = statSync(path).mtimeMs; } catch { return 0; }
  const inner = newestMtime(path);
  return inner > newest ? inner : newest;
}

/** Вердикт «жив ли агент» и почему. */
export interface AliveVerdict {
  alive: boolean;
  reason: string;
}

const DEAD: AliveVerdict = { alive: false, reason: "" };

/**
 * Жив ли агент сессии — по следам работы, а не только по pid.
 *
 * @param id        id сессии
 * @param opts.session снимок сессии (до её удаления): статус, worktree, agentExitAt
 * @param opts.hasLiveProcess  демон знает живые процессы агента (runner.isRunning)
 */
export function sessionAlive(
  id: string,
  opts: { session?: any; hasLiveProcess?: boolean; now?: number } = {},
): AliveVerdict {
  const now = opts.now ?? Date.now();
  const s = opts.session;
  // 1. Процессы демона живы — агент работает (или ещё не умер).
  if (opts.hasLiveProcess) return { alive: true, reason: "процесс агента ещё жив" };

  const wtPath: string | undefined = s?.worktree?.path ?? getWorktree(id)?.path;
  const touched = copyTouchedAt(wtPath);
  const exitedAt = typeof s?.agentExitAt === "number" ? s.agentExitAt : 0;

  // 2. Копию трогали после ухода клиента — работа продолжается в сервисе
  //    агента (F_VER-4: клиент умер, ход ушёл сервису).
  if (exitedAt > 0 && touched > exitedAt) {
    return { alive: true, reason: "копию трогали после ухода клиента агента — работа продолжается" };
  }

  // 3. Ухода не зафиксировано, сессия числится работающей, копия свежая —
  //    на всякий случай считаем живым.
  if (!exitedAt && touched > 0 && now - touched <= ACTIVITY_WINDOW_MS) {
    const status = String(s?.status ?? "");
    if (status === "running" || status === "queued") {
      return { alive: true, reason: "свежая активность в копии, ухода агента не зафиксировано" };
    }
  }
  return DEAD;
}

/** Сколько тишины в копии считать «агент закончил». */
export const COPY_QUIET_MS = Number(process.env.DIRIGO_COPY_QUIET_MS ?? 60_000);

/** Как часто проверять, замолчал ли агент. */
export const COPY_CHECK_MS = Number(process.env.DIRIGO_COPY_CHECK_MS ?? 30_000);

/** Копии, снос которых отложен (агент мог ещё работать). */
const deferred = new Set<string>();

/** Отложен ли снос копии (для диагностики). */
export function deferredCopies(): string[] { return [...deferred]; }

/**
 * Отложенный снос копии: ждём, пока агент замолчит (F_VER-5).
 *
 * Пока копию трогают — агент работает (в сервисе), сносить нельзя: у него
 * пропала бы рабочая папка. Замолчал (тишина в копии) или истёк срок — копию
 * сносим, защиту снимаем.
 */
export function deferCopyRemoval(id: string, until: number): void {
  protectWorktree(id, until);
  if (deferred.has(id)) return;
  deferred.add(id);
  const tick = (): void => {
    if (!deferred.has(id)) return;
    const entry = getWorktree(id);
    if (!entry) { deferred.delete(id); return; }
    const quiet = Date.now() - copyTouchedAt(entry.path) > COPY_QUIET_MS;
    if (quiet || Date.now() >= until) {
      deferred.delete(id);
      unprotectWorktree(id);
      cleanupWorktree(id);
      return;
    }
    setTimeout(tick, COPY_CHECK_MS).unref?.();
  };
  setTimeout(tick, COPY_CHECK_MS).unref?.();
}

/** Отложен ли снос копии (для тестов и ответа API). */
export function deferredCopies(): string[] { return [...deferred]; }
