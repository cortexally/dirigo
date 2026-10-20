// Dirigo — режим Orchestrator (V2-3.4).
//
// Цель → эпики с критериями приёмки → копия-сессия на эпик → сверяющий агент →
// применение с контролем конфликтов. Демон сам модель не вызывает: планирование
// правит пользователь (UI), исполнение и сверка — обычными агентами в копиях.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { appendLog, projects, readLogTail, sessions, uid } from "./store";
import { applyWorktree, cleanupWorktree, createWorktree, diffWorktree, isGitProject, type DiffFile } from "./worktrees";

export type EpicStatus = "pending" | "running" | "review" | "verifying" | "done" | "failed" | "applied" | "conflict";
export type PlanStatus = "draft" | "running" | "review" | "done" | "conflict";

export interface OrchEpic {
  id: string;
  title: string;
  /** критерии приёмки (проверяет сверяющий агент) */
  criteria: string[];
  /** сессия-копия эпика */
  sessionId?: string;
  status: EpicStatus;
  /** вердикт сверяющего агента */
  verdict?: string;
  /** файлы, применённые в проект */
  applied?: string[];
  /** какие файлы эпик задел (для конфликт-резолюшена) */
  touched?: string[];
  createdAt: number;
}

export interface OrchPlan {
  id: string;
  goal: string;
  projectId: string;
  /** агент-исполнитель эпиков */
  agentId: string;
  /** агент-сверщик (по умолчанию — исполнитель) */
  verifierAgentId?: string;
  epics: OrchEpic[];
  status: PlanStatus;
  createdAt: number;
}

/* ---------------- персистентность ---------------- */

// Изоляция как в store.ts/worktrees.ts: тесты и песочницы не трогают боевые данные.
const DATA_DIR = (process.env.DIRIGO_DATA
  ? process.env.DIRIGO_DATA.replace(/[\\/]+$/, "") + "/"
  : new URL("../data/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const PLANS_FILE = `${DATA_DIR}plans.json`;
let plans: OrchPlan[] = [];

export function loadPlans(): void {
  try {
    if (!existsSync(PLANS_FILE)) return;
    const raw = JSON.parse(readFileSync(PLANS_FILE, "utf8"));
    if (Array.isArray(raw)) plans = raw;
  } catch { plans = []; }
}

function savePlans(): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(PLANS_FILE, JSON.stringify(plans, null, 2), "utf8");
  } catch { /* диск недоступен — план живёт в памяти до перезапуска */ }
}

export function listPlans(): OrchPlan[] { return plans; }
export function getPlan(id: string): OrchPlan | undefined { return plans.find((p) => p.id === id); }
export function getEpic(planId: string, epicId: string): OrchEpic | undefined {
  return getPlan(planId)?.epics.find((e) => e.id === epicId);
}

export function createPlan(input: {
  goal: string; projectId: string; agentId: string; verifierAgentId?: string;
  epics: { title: string; criteria?: string[] }[];
}): OrchPlan {
  const plan: OrchPlan = {
    id: uid("plan"),
    goal: String(input.goal ?? "").slice(0, 500),
    projectId: input.projectId,
    agentId: input.agentId,
    verifierAgentId: input.verifierAgentId || undefined,
    epics: input.epics.filter((e) => e.title?.trim()).map((e) => ({
      id: uid("epic"),
      title: String(e.title).slice(0, 200),
      criteria: (e.criteria ?? []).filter(Boolean).map((c) => String(c).slice(0, 300)),
      status: "pending" as EpicStatus,
      createdAt: Date.now(),
    })),
    status: "draft",
    createdAt: Date.now(),
  };
  plans.push(plan);
  savePlans();
  return plan;
}

export function updatePlan(id: string, patch: Partial<Pick<OrchPlan, "goal" | "status" | "verifierAgentId">>): OrchPlan | undefined {
  const plan = getPlan(id);
  if (!plan) return undefined;
  Object.assign(plan, patch);
  savePlans();
  return plan;
}

export function deletePlan(id: string): boolean {
  const plan = getPlan(id);
  if (!plan) return false;
  for (const e of plan.epics) if (e.sessionId) cleanupWorktree(e.sessionId);
  plans = plans.filter((p) => p.id !== id);
  savePlans();
  return true;
}

/** Промпт исполнителю эпика. */
function epicPrompt(plan: OrchPlan, epic: OrchEpic): string {
  return [
    `Эпик плана «${plan.goal}»: ${epic.title}`,
    "",
    "Критерии приёмки:",
    ...epic.criteria.map((c) => `• ${c}`),
    "",
    "Работай ТОЛЬКО в этой копии проекта — боевые файлы не трогай.",
  ].join("\n");
}

function projectPath(plan: OrchPlan): string {
  return projects.get(plan.projectId)?.path ?? process.cwd();
}

/**
 * Старт плана: на каждый эпик — своя копия-сессия с агентом-исполнителем.
 * git-проект → worktree, иначе файловая копия.
 */
export async function startPlan(planId: string): Promise<{ ok: boolean; started: number; error?: string }> {
  const plan = getPlan(planId);
  if (!plan) return { ok: false, started: 0, error: "план не найден" };
  if (plan.status !== "draft" && plan.status !== "conflict") return { ok: false, started: 0, error: `план уже ${plan.status}` };
  if (!plan.epics.length) return { ok: false, started: 0, error: "нет эпиков" };

  const { runner } = await import("./agents/runner");
  const project = projectPath(plan);
  const kind = isGitProject(project) ? "git" : "copy";
  let started = 0;
  for (const epic of plan.epics) {
    if (epic.sessionId) continue;
    try {
      const wt = createWorktree(uid("ses"), project, kind);
      const created = await sessions.add({
        id: wt.sessionId,
        projectId: plan.projectId,
        agentId: plan.agentId,
        title: `[эпик] ${epic.title}`.slice(0, 80),
        prompt: epicPrompt(plan, epic),
        mode: "cli",
        workMode: "orchestrator",
        worktree: { kind: wt.kind, path: wt.path, baseRef: wt.baseRef, createdAt: wt.createdAt },
        restorePoint: { kind: wt.kind === "git" ? "git-base" : "copy-snapshot", ref: wt.baseRef, note: `эпик ${epic.id}`, createdAt: wt.createdAt },
      });
      epic.sessionId = created.id;
      epic.status = "running";
      started++;
      runner.runSession(created.id, epicPrompt(plan, epic)).catch(async (e) => {
        await appendLog(created.id, `[dirigo] эпик не запустился: ${String(e)}\n`);
        await sessions.setStatus(created.id, "error", -1);
        epic.status = "failed";
        savePlans();
      });
    } catch (e) {
      epic.status = "failed";
      epic.verdict = `копия не создана: ${String(e)}`;
    }
  }
  plan.status = "running";
  savePlans();
  return { ok: true, started };
}

/**
 * Хук из runner'а: сессия-эпик отработала → статус «review» (готов к сверке).
 * Пишем в лог копии, чтобы в UI было видно переход.
 */
export async function markEpicSessionFinished(sessionId: string): Promise<void> {
  for (const plan of plans) {
    const epic = plan.epics.find((e) => e.sessionId === sessionId);
    if (!epic) continue;
    if (epic.status === "running") {
      epic.status = "review";
      savePlans();
      await appendLog(sessionId, `[dirigo] эпик «${epic.title}» отработал — готов к сверке (кнопка «Сверить»)\n`);
    }
    return;
  }
}

/** Промпт сверяющему агенту. */
function verifierPrompt(epic: OrchEpic, diffBrief: string): string {  return [
    `Сверь результат эпика «${epic.title}» с критериями приёмки. ТОЛЬКО читай файлы — НЕ меняй их.`,
    "",
    "Критерии:",
    ...epic.criteria.map((c) => `• ${c}`),
    "",
    "Изменения в копии:",
    diffBrief,
    "",
    "Ответь СТРОГО в формате: PASS — <почему> или FAIL — <что не так>.",
  ].join("\n");
}

/**
 * Сверка эпика: легковесная сессия (без своей копии — работает В копии эпика),
 * вердикт забираем из ответа агента. Файлы не трогает.
 */
export async function verifyEpic(planId: string, epicId: string): Promise<{ ok: boolean; verdict?: string; error?: string }> {
  const plan = getPlan(planId);
  const epic = plan?.epics.find((e) => e.id === epicId);
  if (!plan || !epic) return { ok: false, error: "эпик не найден" };
  if (!epic.sessionId) return { ok: false, error: "эпик не запущен" };

  const session = sessions.get(epic.sessionId);
  if (!session?.worktree) return { ok: false, error: "нет копии эпика" };

  let files: DiffFile[] = [];
  try { files = diffWorktree(epic.sessionId).files; } catch { /* копия исчезла */ }
  const diffBrief = files.map((f) => `${f.path} (+${f.added} -${f.deleted})`).join("\n") || "(изменений нет)";

  epic.status = "verifying";
  savePlans();

  const { runner } = await import("./agents/runner");
  const agentId = plan.verifierAgentId ?? plan.agentId;
  const sid = uid("vfy");
  try {
    // сессия работаeт В копии эпика, но в реестре копий не Significant — своя копия не нужна
    await sessions.add({
      id: sid,
      projectId: session.projectId,
      agentId,
      title: `[сверка] ${epic.title}`.slice(0, 80),
      prompt: verifierPrompt(epic, diffBrief),
      mode: "cli",
      workMode: "orchestrator",
      worktree: { kind: session.worktree.kind, path: session.worktree.path, createdAt: Date.now() },
    });
    await runner.runSession(sid, verifierPrompt(epic, diffBrief));
    const answer = await agentAnswer(sid);
    const m = answer.match(/(PASS|FAIL)\s*[—–:-]\s*([\s\S]{0,400})/i);
    epic.verdict = m
      ? `${m[1]!.toUpperCase()} — ${m[2]!.trim().replace(/\s+/g, " ").slice(0, 300)}`
      : "FAIL — сверяющий агент не дал чёткого вердикта (PASS/FAIL)";
  } catch (e) {
    epic.verdict = `FAIL — сверка не удалась: ${String(e)}`;
  }
  epic.touched = files.map((f) => f.path);
  epic.status = epic.verdict.startsWith("PASS") ? "done" : "failed";
  savePlans();
  await appendLog(epic.sessionId, `[dirigo] сверка эпика «${epic.title}»: ${epic.verdict.split("\n")[0]}\n`);
  await sessions.remove(sid);
  return { ok: true, verdict: epic.verdict };
}

/** Последний ответ агента в сессии (тот же алгоритм, что в runner). */
async function agentAnswer(sessionId: string): Promise<string> {
  const { messages } = await import("./store");
  const list = messages.list(sessionId);
  const agent = list.filter((m) => m.role === "agent").at(-1);
  if (agent?.text) return agent.text;
  return (await readLogTail(sessionId, 120)).join("\n");
}

/** Применение эпика в проект с контролем конфликтов по файлам. */
export function applyEpic(planId: string, epicId: string): { ok: boolean; detail: string } {
  const plan = getPlan(planId);
  const epic = plan?.epics.find((e) => e.id === epicId);
  if (!plan || !epic) return { ok: false, detail: "эпик не найден" };
  if (epic.status !== "done" && epic.status !== "applied") return { ok: false, detail: `эпик в статусе ${epic.status} — применяем только проверенные (done)` };
  if (!epic.sessionId) return { ok: false, detail: "нет копии эпика" };

  const appliedByOthers = new Set<string>();
  for (const other of plan.epics) {
    if (other.id === epic.id) continue;
    for (const f of other.applied ?? []) appliedByOthers.add(f);
  }
  let touched: string[] = [];
  try { touched = diffWorktree(epic.sessionId).files.map((f) => f.path); } catch { /* нет копии */ }
  const clash = touched.filter((f) => appliedByOthers.has(f));

  const r = applyWorktree(epic.sessionId);
  if (!r.ok) {
    epic.status = "conflict";
    savePlans();
    return { ok: false, detail: `конфликт применения: ${r.conflicts.join("; ") || r.detail}` };
  }
  if (clash.length) {
    epic.status = "conflict";
    savePlans();
    return { ok: false, detail: `файлы уже применены другим эпиком: ${clash.join(", ")} — нужен конфликт-резолютор` };
  }
  epic.applied = [...r.applied, ...r.removed];
  epic.status = "applied";
  savePlans();
  return { ok: true, detail: r.detail };
}

/** Применить все проверенные эпики плана по очереди. */
export function applyPlan(planId: string): { ok: boolean; applied: number; conflicts: string[] } {
  const plan = getPlan(planId);
  if (!plan) return { ok: false, applied: 0, conflicts: ["план не найден"] };
  let applied = 0;
  const conflicts: string[] = [];
  for (const epic of plan.epics) {
    if (epic.status !== "done") continue;
    const r = applyEpic(planId, epic.id);
    if (r.ok) applied++;
    else conflicts.push(`${epic.title}: ${r.detail}`);
  }
  if (conflicts.length) plan.status = "conflict";
  else if (applied) plan.status = "done";
  savePlans();
  return { ok: !conflicts.length, applied, conflicts };
}

/** Сводка плана для доски. */
export function planSummary(plan: OrchPlan) {
  const by = (s: EpicStatus) => plan.epics.filter((e) => e.status === s).length;
  return {
    id: plan.id, goal: plan.goal, status: plan.status, agentId: plan.agentId, verifierAgentId: plan.verifierAgentId,
    epics: plan.epics.length, done: by("done"), applied: by("applied"), failed: by("failed"),
    conflict: by("conflict"), running: by("running") + by("verifying"),
  };
}
