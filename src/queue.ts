// Dirigo — Companion-очередь (V2-4.3): команды с телефона/скриптов в демон.
//
// Поток: клиент (iPhone Shortcuts, curl, CLI) → POST /api/queue → демон
// исполняет последовательно → GET /api/queue/:id (статус/результат).
// Прогресс освежается через общий SSE-поток (queue.changed) и поллинг.
//
// Типы команд: run (задача агенту), send (сообщение), apply, diff, checks,
// approve (приёмка: отметить замечание принятым), rework (вернуть на доработку).

import { appendLog, sessions, uid } from "./store";
import { applyWorktree, diffWorktree, revertWorktree, worktreeStats } from "./worktrees";
import { runChecks } from "./checks";
import { runner } from "./agents/runner";

/** V2-6.2: лимит живых агентских процессов (как в server.ts). */
const MAX_AGENT_PROCESSES = Number(process.env.DIRIGO_MAX_PROCESSES ?? 12);
const liveProcesses = () => sessions.list().filter((s) => s.status === "running" || s.status === "queued").length;

export type QueueType = "run" | "send" | "apply" | "diff" | "checks" | "revert" | "approve" | "rework";
export type QueueStatus = "queued" | "running" | "done" | "failed";

export interface QueueItem {
  id: string;
  type: QueueType;
  payload: Record<string, unknown>;
  status: QueueStatus;
  result?: unknown;
  error?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
}

const HISTORY = 50;
let items: QueueItem[] = [];
let processing = false;

export function listQueue(): QueueItem[] { return items; }
export function getQueueItem(id: string): QueueItem | undefined { return items.find((i) => i.id === id); }

export function enqueue(type: QueueType, payload: Record<string, unknown>): QueueItem {
  const item: QueueItem = { id: uid("q"), type, payload, status: "queued", createdAt: Date.now() };
  items = [...items.slice(-(HISTORY - 1)), item];
  void processQueue();
  return item;
}

/** Удалить старые завершённые (для UI/памяти). */
export function trimQueue(): number {
  const before = items.length;
  items = items.filter((i) => i.status === "queued" || i.status === "running" || Date.now() - (i.finishedAt ?? i.createdAt) < 3600_000);
  return before - items.length;
}

async function processQueue(): Promise<void> {
  if (processing) return; // строго последовательно
  processing = true;
  try {
    while (true) {
      const next = items.find((i) => i.status === "queued");
      if (!next) break;
      next.status = "running";
      next.startedAt = Date.now();
      try {
        next.result = await execute(next);
        next.status = "done";
      } catch (e) {
        next.error = String(e);
        next.status = "failed";
      }
      next.finishedAt = Date.now();
    }
  } finally {
    processing = false;
  }
}

/** Исполнение одной команды очереди. */
async function execute(item: QueueItem): Promise<unknown> {
  const p = item.payload as Record<string, any>;
  switch (item.type) {
    case "run": {
      const agentId = String(p.agentId ?? "");
      const prompt = String(p.prompt ?? "");
      const projectId = String(p.projectId ?? "");
      if (!agentId || !prompt || !projectId) throw new Error("нужны agentId, prompt, projectId");
      if (liveProcesses() >= MAX_AGENT_PROCESSES) throw new Error(`лимит запущенных агентов (${MAX_AGENT_PROCESSES}) исчерпан`);
      const { createWorktree } = await import("./worktrees");
      const { projects } = await import("./store");
      const project = projects.get(projectId);
      if (!project) throw new Error("проект не найден");
      const wt = createWorktree(uid("ses"), project.path, p.worktree === false ? "copy" : isGitPath(project.path) ? "git" : "copy");
      const s = await sessions.add({
        id: wt.sessionId,
        projectId,
        agentId,
        title: String(p.title ?? prompt).slice(0, 80) + " [очередь]",
        prompt,
        mode: String(p.mode ?? "cli"),
        worktree: { kind: wt.kind, path: wt.path, baseRef: wt.baseRef, createdAt: wt.createdAt },
        restorePoint: { kind: wt.kind === "git" ? "git-base" : "copy-snapshot", ref: wt.baseRef, note: "queue", createdAt: wt.createdAt },
      });
      runner.runSession(s.id, prompt).catch(async (e) => {
        await appendLog(s.id, `[dirigo] очередь: запуск не удался: ${String(e)}\n`);
        await sessions.setStatus(s.id, "error", -1);
      });
      return { sessionId: s.id, worktree: wt.kind, status: s.status };
    }
    case "send": {
      const id = String(p.id ?? "");
      if (!sessions.get(id)) throw new Error("сессия не найдена");
      const s = sessions.get(id)!;
      if (s.persistent) { await runner.sendPersistentMessage(id, String(p.text ?? "")); return { sent: "acp" }; }
      if (s.mode === "pty") { return { sent: runner.writePty(id, String(p.text ?? "") + "\n") ? "pty" : "no-pty" }; }
      throw new Error("сессия не в живом режиме — примени /continue");
    }
    case "apply": {
      const id = String(p.id ?? "");
      if (p.confirmed !== true) throw new Error("требуется confirmed=true");
      const wt = worktreeStats(id);
      if (!wt) throw new Error("нет копии для сессии");
      return applyWorktree(id, p.force === true);
    }
    case "diff": {
      const id = String(p.id ?? "");
      const d = diffWorktree(id);
      return { files: d.files.length, added: d.added, deleted: d.deleted, paths: d.files.map((f) => f.path) };
    }
    case "checks": {
      const id = String(p.id ?? "");
      const st = worktreeStats(id);
      if (!st) throw new Error("нет копии для сессии");
      const { getWorktree } = await import("./worktrees");
      const r = await runChecks(getWorktree(id)!.path);
      return { ok: r.ok, source: r.source, outcomes: r.outcomes.map((o) => ({ command: o.command, ok: o.ok })) };
    }
    case "revert": {
      const id = String(p.id ?? "");
      if (!worktreeStats(id)) throw new Error("нет копии для сессии");
      return revertWorktree(id);
    }
    case "approve":
    case "rework": {
      const id = String(p.id ?? "");
      const s = sessions.get(id);
      if (!s) throw new Error("сессия не найдена");
      const notes = (s.reviewNotes ?? []).filter((n) => item.type === "approve" ? true : n.status === "pending");
      if (item.type === "approve") {
        const { setReviewNotesBulk } = await import("./store");
        await setReviewNotesBulk(id, notes.map((n) => n.id), { status: "accepted" });
        return { accepted: notes.length };
      }
      const text = String(p.text ?? "");
      if (!text) throw new Error("нужен text замечания");
      const prompt = `Замечание ревью с телефона: ${text}\nИсправь в файлах копии и напиши итог.`;
      if (s.persistent) { await runner.sendPersistentMessage(id, prompt); return { sent: "acp" }; }
      if (s.mode === "cli") { runner.runSession(id, prompt).catch(() => {}); return { sent: "cli" }; }
      if (s.mode === "pty") { runner.writePty(id, prompt + "\n"); return { sent: "pty" }; }
      throw new Error("режим без авто-доработки");
    }
    default:
      throw new Error(`неизвестный тип: ${item.type}`);
  }
}

function isGitPath(p: string): boolean {
  const { isGitProject } = require("./worktrees") as typeof import("./worktrees");
  return isGitProject(p);
}
