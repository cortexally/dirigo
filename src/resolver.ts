// Dirigo — конфликт-резолютор (V2-3.5).
//
// Когда два эпика/воркера задели один файл, «Применить» откажется (см.
// orchestration/swarm apply). Резолютор — агент, который получает обе версии
// файла (боевую + версию копии) и пишет смёрженный вариант В КОПИЮ, после чего
// применение повторяется. Демон сам не мержит — только собирает контекст.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { appendLog, sessions, uid } from "./store";
import { applyWorktree, diffWorktree, getWorktree } from "./worktrees";

export interface ResolveResult {
  ok: boolean;
  resolved: string[];
  detail: string;
  /** файлы, которые резолютор не смёл (мержить нечего/ошибка) */
  skipped: string[];
}

const MAX_LINES = 400;

function readCapped(p: string): string {
  try {
    const text = readFileSync(p, "utf8");
    const lines = text.split("\n");
    return lines.length > MAX_LINES ? lines.slice(0, MAX_LINES).join("\n") + `\n… (ещё ${lines.length - MAX_LINES} строк)` : text;
  } catch { return ""; }
}

/** Конфликтующие файлы копии: те, что уже применены в проект другим эпиком/воркером. */
export function conflictFiles(sessionId: string, appliedByOthers: string[]): string[] {
  if (!appliedByOthers.length) return [];
  try {
    const mine = new Set(diffWorktree(sessionId).files.map((f) => f.path));
    return appliedByOthers.filter((f) => mine.has(f));
  } catch { return []; }
}

/**
 * Резолв конфликтов копии сессии: агент мержит файлы и пишет результат в копию,
 * затем применение повторяется. agentId — агент-резолютор (по умолчанию kilo).
 */
export async function resolveConflicts(sessionId: string, files?: string[], agentId?: string): Promise<ResolveResult> {
  const wt = getWorktree(sessionId);
  if (!wt) return { ok: false, resolved: [], skipped: [], detail: "нет копии" };
  let targets = files ?? [];
  if (!targets.length) {
    try { targets = diffWorktree(sessionId).files.map((f) => f.path); } catch { targets = []; }
  }
  if (!targets.length) return { ok: false, resolved: [], skipped: [], detail: "нет файлов для резолва" };

  const agent = agentId ?? "kilo";
  const merged: string[] = [];
  const skipped: string[] = [];
  for (const rel of targets) {
    const projectVer = readCapped(join(wt.projectPath, rel));
    const copyVer = readCapped(join(wt.path, rel));
    if (!projectVer) { skipped.push(rel); continue; } // в проекте файла нет — не конфликт
    const prompt = [
      `Конфликт слияния в файле «${rel}». Две версии одного файла:`,
      "",
      "=== ВЕРСИЯ ПРОЕКТА (уже применена) ===",
      projectVer,
      "",
      "=== ВЕРСИЯ КОПИИ (твоя, ожидает применения) ===",
      copyVer,
      "",
      "Смержи ОБА намерения в один согласованный файл и запиши результат в тот же путь В ТЕКУЩЕЙ копии.",
      "Не теряй функциональность ни одной стороны. Если правки в разных местах — возьми оба.",
      "После записи ответь одной строкой: MERGED <путь>.",
    ].join("\n");
    try {
      const ok = await runResolverOnce(sessionId, agent, prompt, join(wt.path, rel), copyVer);
      if (ok) merged.push(rel);
      else skipped.push(rel);
    } catch (e) {
      await appendLog(sessionId, `[dirigo] резолв «${rel}» не удался: ${String(e)}\n`);
      skipped.push(rel);
    }
  }
  // повторное применение после мержа
  if (merged.length) {
    const r = applyWorktree(sessionId, true);
    return {
      ok: r.ok,
      resolved: merged,
      skipped,
      detail: r.ok ? `смержено ${merged.length} файл(ов) и применено: ${r.detail}` : `смержено ${merged.length}, но применение отвалилось: ${r.detail}`,
    };
  }
  return { ok: false, resolved: [], skipped, detail: "ни один файл не сёржен" };
}

/**
 * Одноразовый прогон резолвтора в копии сессии.
 *
 * Успех засчитывается только если агент И отчитался маркером MERGED с начала
 * строки, И файл в копии реально изменился. Раньше проверка искала /MERGED/ в
 * хвосте лога, куда попадает и сам промпт — а в промпте это слово есть. Любой
 * провал (например, агент не установлен) выглядел как успешный мерж, после
 * чего копия применялась поверх проекта и правки проекта молча терялись.
 */
async function runResolverOnce(
  sessionId: string,
  agentId: string,
  prompt: string,
  copyFilePath: string,
  copyBefore: string,
): Promise<boolean> {
  const wt = getWorktree(sessionId)!;
  const host = sessions.get(sessionId);
  const sid = uid("res");
  await sessions.add({
    id: sid,
    projectId: host?.projectId ?? undefined,
    agentId,
    title: "[резолютор]",
    prompt,
    mode: "cli",
    worktree: { kind: wt.kind, path: wt.path, createdAt: Date.now() },
  });
  try {
    const { runner } = await import("./agents/runner");
    const { readLogTail, messages } = await import("./store");
    await runner.runSession(sid, prompt);
    // Берём только то, что сказал агент. Лог сюда не подмешиваем: в нём лежит
    // наш же промпт с инструкцией «ответь MERGED».
    const answer = messages.list(sid).filter((m) => m.role === "agent").map((m) => m.text).join("\n");
    const reported = /^\s*MERGED\b/im.test(answer);
    if (!reported) {
      const tail = (await readLogTail(sid, 20)).join("\n").slice(-300);
      await appendLog(sessionId, `[dirigo] резолютор не подтвердил мерж (нет строки MERGED). Хвост лога: ${tail}\n`);
      return false;
    }
    // Контрольная проверка: файл в копии обязан измениться.
    const after = (() => { try { return readFileSync(copyFilePath, "utf8"); } catch { return ""; } })();
    if (after === copyBefore) {
      await appendLog(sessionId, "[dirigo] резолютор отчитался MERGED, но файл копии не изменился — считаю мерж несостоявшимся\n");
      return false;
    }
    return true;
  } finally {
    const { runner } = await import("./agents/runner");
    await runner.stopSession(sid).catch(() => {});
    await sessions.remove(sid);
  }
}
