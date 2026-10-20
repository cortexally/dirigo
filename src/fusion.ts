// Dirigo — режим Fusion (V2-3.3).
//
// Один вопрос → N агентов параллельно, каждый в своей копии проекта →
// судья читает ответы и выбирает победителя (или синтез) → применение победителя.
// Демон сам модель не вызывает: кандидаты и судья — обычные агенты в копиях.

import { appendLog, messages, projects, sessions, uid } from "./store";
import { applyWorktree, cleanupWorktree, createWorktree, isGitProject } from "./worktrees";

export type CandidateStatus = "pending" | "running" | "done" | "failed";
export type FusionStatus = "draft" | "running" | "review" | "applied" | "conflict";

export interface FusionCandidate {
  id: string;
  agentId: string;
  sessionId?: string;
  status: CandidateStatus;
  /** ответ кандидата (последнее сообщение агента) */
  answer?: string;
  createdAt: number;
}

export interface FusionRun {
  id: string;
  title: string;
  prompt: string;
  projectId: string;
  /** агенты-кандидаты (2+) */
  agents: string[];
  /** судья (по умолчанию — первый кандидат) */
  judgeAgentId?: string;
  candidates: FusionCandidate[];
  status: FusionStatus;
  /** вердикт судьи */
  verdict?: string;
  /** кого выбрал судья (id кандидата) */
  winnerId?: string;
  createdAt: number;
}

/* ---------------- персистентность ---------------- */

const DATA_DIR = (process.env.DIRIGO_DATA
  ? process.env.DIRIGO_DATA.replace(/[\\/]+$/, "") + "/"
  : new URL("../data/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const FILE = `${DATA_DIR}fusion.json`;
let runs: FusionRun[] = [];

export function loadFusions(): void {
  try {
    if (!existsSyncSafe(FILE)) return;
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const raw = JSON.parse(readFileSync(FILE, "utf8"));
    if (Array.isArray(raw)) runs = raw;
  } catch { runs = []; }
}
function existsSyncSafe(p: string): boolean {
  try { const { existsSync } = require("node:fs") as typeof import("node:fs"); return existsSync(p); } catch { return false; }
}
function save(): void {
  try {
    const { mkdirSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(FILE, JSON.stringify(runs, null, 2), "utf8");
  } catch { /* диск недоступен */ }
}

export function listFusions(): FusionRun[] { return runs; }
export function getFusion(id: string): FusionRun | undefined { return runs.find((r) => r.id === id); }

export function createFusion(input: {
  title: string; prompt: string; projectId: string; agents: string[]; judgeAgentId?: string;
}): FusionRun {
  const run: FusionRun = {
    id: uid("fus"),
    title: String(input.title ?? input.prompt).slice(0, 200),
    prompt: String(input.prompt ?? "").slice(0, 2000),
    projectId: input.projectId,
    agents: (input.agents ?? []).slice(0, 5),
    judgeAgentId: input.judgeAgentId || undefined,
    candidates: [],
    status: "draft",
    createdAt: Date.now(),
  };
  runs.push(run);
  save();
  return run;
}

export function deleteFusion(id: string): boolean {
  const r = getFusion(id);
  if (!r) return false;
  for (const c of r.candidates) if (c.sessionId) cleanupWorktree(c.sessionId);
  runs = runs.filter((x) => x.id !== id);
  save();
  return true;
}

/** Старт: копия + агент на каждого кандидата (параллельно). */
export async function startFusion(id: string): Promise<{ ok: boolean; started: number; error?: string }> {
  const run = getFusion(id);
  if (!run) return { ok: false, started: 0, error: "fusion не найден" };
  if (run.status !== "draft") return { ok: false, started: 0, error: `уже ${run.status}` };
  if (run.agents.length < 2) return { ok: false, started: 0, error: "нужно минимум 2 агента" };
  const { runner } = await import("./agents/runner");
  const project = projects.get(run.projectId)?.path ?? process.cwd();
  const kind = isGitProject(project) ? "git" : "copy";
  run.candidates = [];
  for (const agentId of run.agents) {
    const c: FusionCandidate = { id: uid("cnd"), agentId, status: "pending", createdAt: Date.now() };
    run.candidates.push(c);
    try {
      const wt = createWorktree(uid("ses"), project, kind);
      const s = await sessions.add({
        id: wt.sessionId,
        projectId: run.projectId,
        agentId,
        title: `[fusion] ${agentId}`.slice(0, 80),
        prompt: run.prompt,
        mode: "cli",
        workMode: "fusion",
        worktree: { kind: wt.kind, path: wt.path, baseRef: wt.baseRef, createdAt: wt.createdAt },
        restorePoint: { kind: wt.kind === "git" ? "git-base" : "copy-snapshot", ref: wt.baseRef, note: `fusion ${run.id}`, createdAt: wt.createdAt },
      });
      c.sessionId = s.id;
      c.status = "running";
      runner.runSession(s.id, run.prompt).catch(async (e) => {
        await appendLog(s.id, `[dirigo] кандидат не запустился: ${String(e)}\n`);
        c.status = "failed";
        save();
      });
    } catch (e) {
      c.status = "failed";
      c.answer = `копия не создана: ${String(e)}`;
    }
  }
  run.status = "running";
  save();
  return { ok: true, started: run.candidates.length };
}

/** Пересчёт одного кандидата по последнему сообщению агента. */
function recomputeCandidate(c: FusionCandidate): void {
  if (!c.sessionId) { c.status = "failed"; return; }
  const last = messages.list(c.sessionId).filter((m) => m.role === "agent").at(-1);
  const text = last?.text ?? "";
  if (text) c.answer = text.slice(0, 3000);
  c.status = text ? "done" : "failed";
}

/** Хук из runner'а: кандидат ответил. Безопасно вызывать повторно. */
export async function markCandidateFinished(sessionId: string): Promise<void> {
  for (const r of runs) {
    const c = r.candidates.find((x) => x.sessionId === sessionId);
    if (!c) continue;
    recomputeCandidate(c);
    const pending = r.candidates.filter((x) => x.status === "running" || x.status === "pending").length;
    if (pending === 0 && r.status === "running") r.status = "review";
    save();
    return;
  }
}

/** Пересчитать ответы кандидатов (поздние ответы агентов). */
export function refreshFusion(id: string): { ok: boolean; refreshed: number } {
  const r = getFusion(id);
  if (!r) return { ok: false, refreshed: 0 };
  let n = 0;
  for (const c of r.candidates) {
    if (!c.sessionId) continue;
    const before = c.status;
    recomputeCandidate(c);
    if (c.status !== before) n++;
  }
  const pending = r.candidates.filter((x) => x.status === "running" || x.status === "pending").length;
  if (pending === 0 && r.status === "running") r.status = "review";
  save();
  return { ok: true, refreshed: n };
}

/**
 * Судья: читает задачу и все ответы кандидатов, выбирает победителя.
 * Формат ответа: WINNER: <agentId> — <почему> или SYNTH: <что синтезировать>.
 */
export async function judgeFusion(id: string): Promise<{ ok: boolean; verdict?: string; winnerId?: string; error?: string }> {
  const run = getFusion(id);
  if (!run) return { ok: false, error: "fusion не найден" };
  refreshFusion(id);
  const ready = run.candidates.filter((c) => c.status === "done" && c.answer);
  if (!ready.length) return { ok: false, error: "нет ответов кандидатов для судейства" };
  const judgeAgent = run.judgeAgentId ?? ready[0]!.agentId;
  const prompt = [
    `Ты судья Fusion-сессии «${run.title}». Задача: ${run.prompt}`,
    "",
    "Ответы кандидатов:",
    ...ready.map((c) => `\n--- ${c.agentId} ---\n${c.answer!.slice(0, 2500)}`),
    "",
    "Выбери победителя СТРОГО в формате: WINNER: <agentId> — <почему, 1-3 предложения>.",
    "Если лучший ответ — синтез нескольких: WINNER: <agentId самого близкого> — <что ещё подтянуть>.",
  ].join("\n");
  const verdict = await runJudgeOnce(judgeAgent, run, ready[0]!, prompt);
  run.verdict = verdict;
  const m = verdict.match(/WINNER:\s*([\w.-]+)/i);
  const winner = m ? run.candidates.find((c) => c.agentId.toLowerCase() === m[1]!.toLowerCase()) : undefined;
  run.winnerId = winner?.id;
  save();
  await appendLog(ready[0]!.sessionId!, `[dirigo] судья fusion: ${verdict.split("\n")[0]}\n`);
  return { ok: true, verdict, winnerId: run.winnerId };
}

async function runJudgeOnce(judgeAgentId: string, run: FusionRun, host: FusionCandidate, prompt: string): Promise<string> {
  if (!host.sessionId) return "WINNER: — ошибка судейства";
  const hostSession = sessions.get(host.sessionId);
  if (!hostSession?.worktree) return "WINNER: — нет копии для судьи";
  const sid = uid("jdg");
  await sessions.add({
    id: sid,
    projectId: hostSession.projectId,
    agentId: judgeAgentId,
    title: `[судья fusion] ${run.title}`.slice(0, 80),
    prompt,
    mode: "cli",
    workMode: "fusion",
    worktree: { kind: hostSession.worktree.kind, path: hostSession.worktree.path, createdAt: Date.now() },
  });
  try {
    const { runner } = await import("./agents/runner");
    const { readLogTail } = await import("./store");
    await runner.runSession(sid, prompt);
    const tail = (await readLogTail(sid, 120)).join("\n");
    const m = tail.match(/WINNER:\s*([\w.-]+)\s*[—–:-]\s*([\s\S]{0,300})/i);
    return m ? `WINNER: ${m[1]} — ${m[2]!.trim().replace(/\s+/g, " ").slice(0, 240)}` : "WINNER: — судья не дал вердикт";
  } finally {
    const { runner } = await import("./agents/runner");
    await runner.stopSession(sid).catch(() => {});
    await sessions.remove(sid);
  }
}

/** Применить победителя (после судейства) в проект. */
export function applyFusion(id: string): { ok: boolean; detail: string } {
  const run = getFusion(id);
  if (!run) return { ok: false, detail: "fusion не найден" };
  if (!run.winnerId || !run.verdict) return { ok: false, detail: "судья ещё не выбрал победителя" };
  const winner = run.candidates.find((c) => c.id === run.winnerId);
  if (!winner?.sessionId) return { ok: false, detail: "нет копии победителя" };
  const r = applyWorktree(winner.sessionId);
  if (!r.ok) { run.status = "conflict"; save(); return { ok: false, detail: r.detail }; }
  run.status = "applied";
  save();
  return { ok: true, detail: r.detail };
}

/** Сводка для доски. */
export function fusionSummary(r: FusionRun) {
  return {
    id: r.id, title: r.title, status: r.status, projectId: r.projectId,
    agents: r.agents, judgeAgentId: r.judgeAgentId, winnerId: r.winnerId,
    candidates: r.candidates.length,
    done: r.candidates.filter((c) => c.status === "done").length,
    failed: r.candidates.filter((c) => c.status === "failed").length,
    verdict: r.verdict,
  };
}
