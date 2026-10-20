// Dirigo — режим Swarm (V2-3.2).
//
// N копий проекта одновременно: задача делится на «участки» (zones), каждый
// воркер работает ТОЛЬКО в своём участке своей копии, общая лента собирает
// ход работ, дедлоки (упавшие проверки/блокеры) разбирает судья-агент.
//
// Демон сам модель не вызывает: промпты воркерам/судье формируются здесь,
// запускаются обычные агенты (runner). Состояние — data/swarm.json
// (с уважением к DIRIGO_DATA, как store.ts).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { appendLog, messages, projects, sessions, uid } from "./store";
import { applyWorktree, cleanupWorktree, createWorktree, diffWorktree, isGitProject } from "./worktrees";

export type WorkerStatus = "pending" | "running" | "done" | "failed" | "blocked" | "skipped" | "applied";
export type SwarmStatus = "draft" | "running" | "review" | "judging" | "done" | "conflict";

export interface SwarmWorker {
  id: string;
  /** участок: путь/файл/область, которую воркер имеет право менять */
  zone: string;
  sessionId?: string;
  status: WorkerStatus;
  /** последнее сообщение воркера (для общей ленты) */
  lastNote?: string;
  /** вердикт судьи по дедлоку */
  judge?: string;
  verdictAt?: number;
  createdAt: number;
}

export interface SwarmTask {
  id: string;
  title: string;
  /** общая задача для всех воркеров */
  goal: string;
  projectId: string;
  /** агент-исполнитель воркеров */
  agentId: string;
  /** агент-судья (по умолчанию — исполнитель) */
  judgeAgentId?: string;
  workers: SwarmWorker[];
  status: SwarmStatus;
  createdAt: number;
}

/* ---------------- персистентность ---------------- */

const DATA_DIR = (process.env.DIRIGO_DATA
  ? process.env.DIRIGO_DATA.replace(/[\\/]+$/, "") + "/"
  : new URL("../data/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const FILE = `${DATA_DIR}swarm.json`;
let tasks: SwarmTask[] = [];

export function loadSwarms(): void {
  try {
    if (!existsSync(FILE)) return;
    const raw = JSON.parse(readFileSync(FILE, "utf8"));
    if (Array.isArray(raw)) tasks = raw;
  } catch { tasks = []; }
}

function save(): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(FILE, JSON.stringify(tasks, null, 2), "utf8");
  } catch { /* диск недоступен — живёт в памяти */ }
}

export function listSwarms(): SwarmTask[] { return tasks; }
export function getSwarm(id: string): SwarmTask | undefined { return tasks.find((t) => t.id === id); }
export function getWorker(swarmId: string, workerId: string): SwarmWorker | undefined {
  return getSwarm(swarmId)?.workers.find((w) => w.id === workerId);
}

export function createSwarm(input: {
  title: string; goal: string; projectId: string; agentId: string;
  judgeAgentId?: string; zones: string[];
}): SwarmTask {
  const task: SwarmTask = {
    id: uid("swarm"),
    title: String(input.title ?? input.goal).slice(0, 200),
    goal: String(input.goal ?? "").slice(0, 1000),
    projectId: input.projectId,
    agentId: input.agentId,
    judgeAgentId: input.judgeAgentId || undefined,
    workers: (input.zones ?? []).filter((z) => z.trim()).map((z) => ({
      id: uid("wrk"),
      zone: String(z).slice(0, 200),
      status: "pending" as WorkerStatus,
      createdAt: Date.now(),
    })),
    status: "draft",
    createdAt: Date.now(),
  };
  tasks.push(task);
  save();
  return task;
}

export function deleteSwarm(id: string): boolean {
  const t = getSwarm(id);
  if (!t) return false;
  for (const w of t.workers) if (w.sessionId) cleanupWorktree(w.sessionId);
  tasks = tasks.filter((x) => x.id !== id);
  save();
  return true;
}

function workerPrompt(task: SwarmTask, zone: string): string {
  return [
    `Swarm-задача: ${task.title}`,
    task.goal ? `\nОбщая цель: ${task.goal}` : "",
    `\nТВОЙ УЧАСТОК: ${zone}`,
    "",
    "Правила роя:",
    "• Меняй ТОЛЬКО файлы своего участка — чужие участки трогают другие воркеры.",
    "• Ты работаешь в изолированной копии проекта (worktree). Боевые файлы не трогай.",
    "• Завершив — коротко напиши итог (1–3 предложения): что сделано и что осталось.",
    "• Если упёрся в блокер (не хватает правок из чужого участка) — напиши BLOCKED: <причина>, не подделывай результат.",
  ].join("\n");
}

/** Старт роя: копия + агент на каждый участок. */
export async function startSwarm(id: string): Promise<{ ok: boolean; started: number; error?: string }> {
  const task = getSwarm(id);
  if (!task) return { ok: false, started: 0, error: "рой не найден" };
  if (task.status !== "draft") return { ok: false, started: 0, error: `рой уже ${task.status}` };
  if (!task.workers.length) return { ok: false, started: 0, error: "нет участков" };
  const { runner } = await import("./agents/runner");
  const project = projects.get(task.projectId)?.path ?? process.cwd();
  const kind = isGitProject(project) ? "git" : "copy";
  let started = 0;
  for (const w of task.workers) {
    if (w.sessionId) continue;
    try {
      const wt = createWorktree(uid("ses"), project, kind);
      const s = await sessions.add({
        id: wt.sessionId,
        projectId: task.projectId,
        agentId: task.agentId,
        title: `[рой] ${w.zone}`.slice(0, 80),
        prompt: workerPrompt(task, w.zone),
        mode: "cli",
        workMode: "swarm",
        worktree: { kind: wt.kind, path: wt.path, baseRef: wt.baseRef, createdAt: wt.createdAt },
        restorePoint: { kind: wt.kind === "git" ? "git-base" : "copy-snapshot", ref: wt.baseRef, note: `swarm ${task.id}`, createdAt: wt.createdAt },
      });
      w.sessionId = s.id;
      w.status = "running";
      started++;
      runner.runSession(s.id, workerPrompt(task, w.zone)).catch(async (e) => {
        await appendLog(s.id, `[dirigo] воркер не запустился: ${String(e)}\n`);
        w.status = "failed";
        save();
      });
    } catch (e) {
      w.status = "failed";
      w.lastNote = `копия не создана: ${String(e)}`;
    }
  }
  task.status = "running";
  save();
  return { ok: true, started };
}

/**
 * Хук из runner'а: воркер отработал → done/blocked. Безопасно вызывать
 * повторно (refresh): терминальные статусы (applied/skipped) не трогаем,
 * остальные пересчитываем по последнему сообщению агента — ответ агента
 * может прийти в лог чуть позже события выхода.
 */
export async function markWorkerFinished(sessionId: string): Promise<void> {
  for (const t of tasks) {
    const w = t.workers.find((x) => x.sessionId === sessionId);
    if (!w) continue;
    if (w.status === "applied" || w.status === "skipped") return; // терминальные
    const last = messages.list(sessionId).filter((m) => m.role === "agent").at(-1);
    const text = (last?.text ?? "").slice(0, 500);
    if (text) w.lastNote = text;
    // BLOCKED — только как маркер в начале строки: в промпте формат
    // описан текстом, и агент может его процитировать в объяснении.
    const blocked = /^\s*BLOCKED\s*[:\-–]/m.test(text) || /^\s*BLOCKED\s*$/m.test(text);
    w.status = blocked ? "blocked" : "done";
    // весь рой отработал/заблокирован → на-review
    const pending = t.workers.filter((x) => x.status === "running" || x.status === "pending").length;
    if (pending === 0 && t.status === "running") t.status = "review";
    save();
    return;
  }
}

/** Пересчитать статусы всех нетерминальных воркеров (для UI и после поздних ответов). */
export function refreshSwarm(id: string): { ok: boolean; refreshed: number } {
  const t = getSwarm(id);
  if (!t) return { ok: false, refreshed: 0 };
  let n = 0;
  for (const w of t.workers) {
    if (w.status === "applied" || w.status === "skipped" || !w.sessionId) continue;
    const before = w.status;
    markWorkerFinishedSync(w);
    if (w.status !== before) n++;
  }
  save();
  return { ok: true, refreshed: n };
}

/** Синхронная версия пересчета одного воркера (общая логика с markWorkerFinished). */
function markWorkerFinishedSync(w: SwarmWorker): void {
  if (!w.sessionId || w.status === "applied" || w.status === "skipped") return;
  const last = messages.list(w.sessionId).filter((m) => m.role === "agent").at(-1);
  const text = (last?.text ?? "").slice(0, 500);
  if (text) w.lastNote = text;
  const blocked = /^\s*BLOCKED\s*[:\-–]/m.test(text) || /^\s*BLOCKED\s*$/m.test(text);
  w.status = blocked ? "blocked" : "done";
}

/**
 * Судья по дедлокам: агент читает положение.blocked'ного воркера + общую ленту
 * и решает: CONTINUE (снять блокer и дать доработку), RETRY (перезапустить),
 * SKIP (исключить участок из применения).
 */
export async function judgeSwarm(id: string): Promise<{ ok: boolean; judged: number; error?: string }> {
  const task = getSwarm(id);
  if (!task) return { ok: false, judged: 0, error: "рой не найден" };
  const stuck = task.workers.filter((w) => w.status === "blocked" || w.status === "failed");
  if (!stuck.length) return { ok: true, judged: 0 };
  const { runner } = await import("./agents/runner");
  const judgeAgent = task.judgeAgentId ?? task.agentId;
  task.status = "judging";
  save();
  let judged = 0;
  for (const w of stuck) {
    if (!w.sessionId) { w.status = "skipped"; save(); continue; }
    const feed = commonFeed(task).slice(-4000);
    const prompt = [
      `Ты судья роя «${task.title}». Воркер участка «${w.zone}» в дедлоке (${w.status}).`,
      w.lastNote ? `\nЕго последнее сообщение:\n${w.lastNote}` : "",
      `\nОбщая лента роя:\n${feed}`,
      "",
      "Реши СТРОГО одним словом и причиной: CONTINUE — <что доделать самому> · RETRY — <почему перезапуск поможет> · SKIP — <почему участок не нужен>.",
      "Если CONTINUE — опиши konkретную задачу воркеру (1–3 предложения).",
    ].join("\n");
    try {
      const verdict = await runJudge(judgeAgent, w.sessionId, prompt);
      w.judge = verdict;
      w.verdictAt = Date.now();
      const v = verdict.toUpperCase();
      if (v.startsWith("SKIP")) w.status = "skipped";
      else if (v.startsWith("RETRY")) {
        w.status = "running";
        runner.runSession(w.sessionId, workerPrompt(task, w.zone) + `\n\nСудья: ${verdict}`).catch(() => {});
      } else {
        // CONTINUE: доработка по вердикту
        w.status = "running";
        runner.runSession(w.sessionId, `Судья роя вернул тебя на доработку: ${verdict}\nДоделай в своём участке и напиши итог.`).catch(() => {});
      }
      judged++;
    } catch (e) {
      w.judge = `судья не справился: ${String(e)}`;
    }
    save();
  }
  task.status = "review";
  save();
  return { ok: true, judged };
}

/** Одноразовый прогон судьи в копии воркера; ответ — последний блок лога. */
async function runJudge(judgeAgentId: string, inCopyOf: string, prompt: string): Promise<string> {
  const host = sessions.get(inCopyOf);
  if (!host?.worktree) return "SKIP — нет копии воркера";
  const sid = uid("judge");
  await sessions.add({
    id: sid,
    projectId: host.projectId,
    agentId: judgeAgentId,
    title: "[судья] роя",
    prompt,
    mode: "cli",
    workMode: "swarm",
    worktree: { kind: host.worktree.kind, path: host.worktree.path, createdAt: Date.now() },
  });
  try {
    const { runner } = await import("./agents/runner");
    await runner.runSession(sid, prompt);
    const { readLogTail } = await import("./store");
    const answer = (await readLogTail(sid, 120)).join("\n");
    const m = answer.match(/(CONTINUE|RETRY|SKIP)\s*[—–:-]\s*([\s\S]{0,300})/i);
    return m ? `${m[1]!.toUpperCase()} — ${m[2]!.trim().replace(/\s+/g, " ").slice(0, 250)}` : "SKIP — судья не дал чёткого вердикта";
  } finally {
    const { runner } = await import("./agents/runner");
    await runner.stopSession(sid).catch(() => {});
    await sessions.remove(sid);
  }
}

/** Общая лента роя: по каждому воркеру — участок, статус, последняя заметка. */
export function commonFeed(task: SwarmTask): string {
  return task.workers.map((w) => {
    const head = `[${w.status}] ${w.zone}`;
    const note = w.lastNote ? `: ${w.lastNote.trim().split("\n").slice(0, 3).join(" / ")}` : "";
    return head + note;
  }).join("\n");
}

/** Применить одного воркера (проверенного) в проект. */
export function applyWorker(swarmId: string, workerId: string): { ok: boolean; detail: string } {
  const task = getSwarm(swarmId);
  const w = task?.workers.find((x) => x.id === workerId);
  if (!task || !w) return { ok: false, detail: "воркер не найден" };
  if (w.status !== "done" && w.status !== "applied") return { ok: false, detail: `воркер в статусе ${w.status} — применяем только done` };
  if (!w.sessionId) return { ok: false, detail: "нет копии воркера" };
  const clash = task.workers
    .filter((o) => o.id !== w.id && o.status === "applied")
    .flatMap((o) => appliedFilesOf(o))
    .filter((f) => touchedFilesOf(w).includes(f));
  const r = applyWorktree(w.sessionId);
  if (!r.ok) { w.status = "failed"; save(); return { ok: false, detail: r.detail }; }
  if (clash.length) { w.status = "failed"; save(); return { ok: false, detail: `файлы уже применены другим воркером: ${clash.join(", ")}` }; }
  w.status = "applied";
  save();
  return { ok: true, detail: r.detail };
}

function touchedFilesOf(w: SwarmWorker): string[] {
  if (!w.sessionId) return [];
  try { return diffWorktree(w.sessionId).files.map((f) => f.path); } catch { return []; }
}
function appliedFilesOf(w: SwarmWorker): string[] {
  if (!w.sessionId || w.status !== "applied") return [];
  try {
    // применённые файлы = всё, что копия теперь содержит сверх базы + изменения
    return diffWorktree(w.sessionId).files.map((f) => f.path);
  } catch { return []; }
}

/** Применить всех готовых воркеров по очереди. */
export function applySwarm(swarmId: string): { ok: boolean; applied: number; conflicts: string[] } {
  const t = getSwarm(swarmId);
  if (!t) return { ok: false, applied: 0, conflicts: ["рой не найден"] };
  let applied = 0;
  const conflicts: string[] = [];
  for (const w of t.workers) {
    if (w.status !== "done") continue;
    const r = applyWorker(swarmId, w.id);
    if (r.ok) applied++;
    else conflicts.push(`${w.zone}: ${r.detail}`);
  }
  t.status = conflicts.length ? "conflict" : applied ? "done" : t.status;
  save();
  return { ok: !conflicts.length, applied, conflicts };
}

/** Сводка для доски/UI. */
export function swarmSummary(t: SwarmTask) {
  const by = (s: WorkerStatus) => t.workers.filter((w) => w.status === s).length;
  return {
    id: t.id, title: t.title, goal: t.goal, status: t.status, agentId: t.agentId,
    judgeAgentId: t.judgeAgentId, projectId: t.projectId,
    workers: t.workers.length, done: by("done"), applied: by("applied"),
    failed: by("failed"), blocked: by("blocked"), running: by("running"),
  };
}
