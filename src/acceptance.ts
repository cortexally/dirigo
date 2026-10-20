// Dirigo — приёмочные проверки на естественном языке (V2-2.5).
//
// Пользователь формулирует критерии приёмки («в API появился эндпоинт X»),
// агент проходит по ним В КОПИИ и выдаёт вердикт по каждому (PASS/FAIL + почему).
// Это «мягкая» приёмка в отличие от машинных проверок checks.ts.

import { appendLog, messages, sessions, uid } from "./store";
import { diffWorktree, getWorktree } from "./worktrees";

export interface AcceptanceOutcome {
  ok: boolean;
  run?: { criteria: string[]; results: { criterion: string; ok: boolean; note?: string }[]; ok: boolean; verdict: string; at: number };
  error?: string;
}

/** Промпт агенту-приёмщику. */
function acceptancePrompt(sessionId: string, criteria: string[]): string {
  let files: string[] = [];
  try { files = diffWorktree(sessionId).files.map((f) => `${f.path} (+${f.added} -${f.deleted})`); } catch { /* копии нет */ }
  return [
    "Ты приёмщик: проверь критерии приёмки по РЕАЛЬНЫМ файлам копии (читай их, не гадай).",
    "",
    "Критерии:",
    ...criteria.map((c, i) => `${i + 1}. ${c}`),
    "",
    `Изменения в копии:\n${files.length ? files.join("\n") : "(диффа нет)"}`,
    "",
    "Ответь СТРОГО в формате (по строке на критерий):",
    ...criteria.map((c, i) => `${i + 1}. PASS|FAIL — <почему, 1 предложение>`),
    "",
    "Последней строкой: ИТОГ: PASS или ИТОГ: FAIL.",
  ].join("\n");
}

/**
 * Прогон приёмки: агент в копии проверяет критерии, ответ парсится в
 * построчные вердикты. Идемпотентен по завершении — результат в Session.acceptance.
 */
export async function runAcceptance(sessionId: string, criteriaInput: string[], agentId?: string): Promise<AcceptanceOutcome> {
  const s = sessions.get(sessionId);
  if (!s) return { ok: false, error: "сессия не найдена" };
  const wt = getWorktree(sessionId);
  if (!wt) return { ok: false, error: "нет копии для приёмки" };
  const criteria = criteriaInput.map((c) => String(c).trim()).filter(Boolean);
  if (!criteria.length) return { ok: false, error: "критерии обязательны" };

  const prompt = acceptancePrompt(sessionId, criteria);
  const sid = uid("acc");
  await sessions.add({
    id: sid,
    projectId: s.projectId,
    agentId: agentId ?? "kilo",
    title: "[приёмка]",
    prompt,
    mode: "cli",
    worktree: { kind: wt.kind, path: wt.path, createdAt: Date.now() },
  });
  try {
    const { runner } = await import("./agents/runner");
    const { readLogTail } = await import("./store");
    await runner.runSession(sid, prompt);
    const answer = [...messages.list(sid).filter((m) => m.role === "agent").map((m) => m.text), ...(await readLogTail(sid, 120))].join("\n");
    const results = criteria.map((c, i) => {
      const re = new RegExp(`^\\s*${i + 1}\\.\\s*(PASS|FAIL)\\s*[—–:-]\\s*(.+)$`, "im");
      const m = answer.match(re);
      return { criterion: c, ok: m ? m[1]!.toUpperCase() === "PASS" : false, note: m ? m[2]!.trim().slice(0, 200) : "агент не ответил по критерию" };
    });
    const totalOk = results.every((r) => r.ok);
    const verdictMatch = answer.match(/ИТОГ:\s*(PASS|FAIL)/i);
    const verdict = verdictMatch ? `ИТОГ: ${verdictMatch[1]!.toUpperCase()}` : (totalOk ? "ИТОГ: PASS" : "ИТОГ: FAIL");
    const run = { criteria, results, ok: totalOk, verdict, at: Date.now() };
    await sessions.setAcceptance(sessionId, run);
    await appendLog(sessionId, `[dirigo] приёмка: ${verdict} (${results.filter((r) => r.ok).length}/${criteria.length})\n`);
    return { ok: true, run };
  } catch (e) {
    return { ok: false, error: String(e) };
  } finally {
    const { runner } = await import("./agents/runner");
    await runner.stopSession(sid).catch(() => {});
    await sessions.remove(sid);
  }
}
