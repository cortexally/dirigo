// Dirigo — хранилище данных и шина событий
// JSON-файл + атомарная запись; при росте — замена на bun:sqlite (API изолирован).

import { mkdirSync, renameSync } from "node:fs";
import { appendFile, rename } from "node:fs/promises";
import type { WorktreeKind } from "./worktrees";

export type SessionStatus = "queued" | "running" | "done" | "error" | "stopped";
/** v2-режимы работы: solo (по умолчанию) / swarm / fusion / orchestrator */
export type WorkMode = "solo" | "swarm" | "fusion" | "orchestrator";

/** Снимок копии проекта, привязанной к сессии (движок — src/worktrees.ts). */
export interface SessionWorktree {
  kind: WorktreeKind;
  /** путь к копии (data/work/<sessionId>) */
  path: string;
  /** git: базовый коммит — точка возврата */
  baseRef?: string;
  createdAt: number;
}

/** Точка возврата сессии: куда откатывать «вернуть как было». */
export interface RestorePoint {
  kind: "git-base" | "copy-snapshot" | "none";
  /** git: коммит; copy: описание снимка */
  ref?: string;
  note?: string;
  createdAt: number;
}

/** Результат прогона авто-проверок проекта (V2-2.x). */
export interface CheckRun {
  command: string;
  ok: boolean;
  output: string;
  durationMs: number;
  at: number;
}

/** Приёмочная проверка на естественном языке (V2-2.5): критерий + вердикт агента. */
export interface AcceptanceResult { criterion: string; ok: boolean; note?: string; }

/** Итог приёмочной сессии по критериям. */
export interface AcceptanceRun {
  criteria: string[];
  results: AcceptanceResult[];
  ok: boolean;
  verdict: string;
  at: number;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  createdAt: number;
  /** архив: проект не удалён, но убран из активных (V5.2) */
  archived?: boolean;
  archivedAt?: number;
}

export interface Session {
  id: string;
  projectId: string;
  agentId: string;
  title: string;
  prompt: string;
  /** cli — разовая задача; web — нативный веб-интерфейс агента; persistent — живое ACP-соединение */
  mode: "cli" | "web" | "persistent" | "pty";
  /** модель агента для этой сессии (переопределяет defaultModel) */
  model?: string;
  /** V6: уровень рассуждений агента (reasoning effort) */
  reasoning?: string;
  status: SessionStatus;
  createdAt: number;
  updatedAt: number;
  exitCode: number | null;
  /** Человеческая причина падения/остановки — её показывает карточка сессии
   *  вместо голого «Error». Пишется там же, где ставится статус error. */
  failReason?: string;
  /** Что сделать, чтобы починить (ставится вместе с failReason). */
  failFix?: string;
  /** Агент показал экран входа в аккаунт: пока пользователь не авторизуется,
   *  задачи в терминал не уходят. UI показывает это состояние и ссылку. */
  authPrompt?: { label: string; url?: string; at: number };
  /** Сессия открыта только ради входа в аккаунт агента (команда login). */
  loginSession?: boolean;
  /** Агент ждёт ответа пользователя: вопрос и варианты (ACP). Пока ответа нет,
   *  агент стоит на месте — поэтому это видно прямо в ленте кнопками. */
  pendingChoice?: { id: string; question: string; options: { id: string; label: string; kind?: string }[]; at: number };
  /** Сессия убрана из списка, но не удалена (журнал и доказательства целы). */
  archived?: boolean;
  archivedAt?: number;
  /** URL веб-интерфейса (для mode=web) */
  webUrl?: string;
  /** токен/пароль веб-интерфейса, если агент его печатает */
  webToken?: string;
  /** готовая ссылка с автоподключением (?auth_token=...) — для панелей с паролем */
  webAuthUrl?: string;
  /** PID процесса агента (для очистки осиротевших процессов при рестарте сервера) */
  pid?: number;
  /** Когда процесс агента ушёл (последний запущенный процесс сессии вышел).
   *  Нужен, чтобы отличить «агент закончил» от «клиент умер, а работа идёт в
   *  сервисе агента» (F_VER-4/F_VER-5): правки в копии ПОСЛЕ этого времени —
   *  признак живого агента, и копию сносить нельзя. */
  agentExitAt?: number;
  /** одноразовая ссылка подключения к панели агента (телефон/другой браузер) */
  webPairUrl?: string;
  /** id сессии на стороне агента (если агент его сообщил) */
  externalRef?: string;
  /** persistent — живое ACP-соединение вместо одноразового spawn'а */
  persistent?: boolean;
  /** модель ACP-сессии (если переключалась) */
  acpModel?: string;
  /** v2: режим работы (solo — копия + авто-проверки; swarm/fusion/orchestrator — режимы окружения) */
  workMode?: WorkMode;
  /** v2: своя команда проверок (override детекта checks.ts; выполняется в копии) */
  verifyCommand?: string;
  /** v2: копия проекта, в которой работает агент */
  worktree?: SessionWorktree;
  /** v2: точка возврата (куда откатывать «вернуть как было») */
  restorePoint?: RestorePoint;
  /** v2: результаты авто-проверок копии (до показа результата) */
  checks?: CheckRun[];
  /** v2: приёмочные проверки на естественном языке (V2-2.5) */
  acceptance?: AcceptanceRun;
  /** v2: замечания ревью по строкам диффа */
  reviewNotes?: ReviewNote[];
}

export interface Message {
  id: string;
  sessionId: string;
  role: "user" | "agent" | "system";
  text: string;
  ts: number;
}

/** F-V6-2 (FBA): настройки Компаньона (роль/тон/модель). */
export interface CompanionSettings {
  role: "assistant" | "reviewer" | "planner" | "tutor";
  tone: "neutral" | "friendly" | "formal" | "concise";
  /** модель вида provider/model (см. providers.json); default — free-шлюз kilo */
  model: string;
}

/** F-V6-2 (FBA): запись диалога Компаньона. */
export interface CompanionMsg {
  id: string;
  role: "user" | "companion";
  text: string;
  ts: number;
  /** откуда ответ: llm (провайдер из providers.json) | local (офлайн-фолбэк) */
  source?: "llm" | "local";
}

export interface CompanionState {
  settings: CompanionSettings;
  messages: CompanionMsg[];
}

interface DB {
  projects: Project[];
  sessions: Session[];
  messages: Message[];
  /** F-V6-2 (FBA): состояние Компаньона — настройки + лог диалога. */
  companion?: CompanionState;
}

export type { DB };

// DIRIGO_DATA позволяет поднять изолированный инстанс (тесты, песочница)
// без риска для боевого data/db.json.
const DATA_DIR = (process.env.DIRIGO_DATA
  ? process.env.DIRIGO_DATA.replace(/[\\/]+$/, "") + "/"
  : new URL("../data/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const DB_FILE = DATA_DIR + "db.json";
const LOG_DIR = DATA_DIR + "logs";

const DEFAULT_COMPANION: CompanionState = {
  settings: { role: "assistant", tone: "neutral", model: "kilo/kilo-auto/free" },
  messages: [],
};

const EMPTY: DB = { projects: [], sessions: [], messages: [], companion: structuredClone(DEFAULT_COMPANION) };

function ensureDirs() {
  mkdirSync(DATA_DIR, { recursive: true });
  mkdirSync(LOG_DIR, { recursive: true });
}

async function load(): DB {
  ensureDirs();
  try {
    const raw = await Bun.file(DB_FILE).json();
    const db = { ...EMPTY, ...(raw as DB) };
    // защита от «валидного JSON, но битой формы»
    db.projects = Array.isArray(db.projects) ? db.projects : [];
    db.sessions = Array.isArray(db.sessions) ? db.sessions : [];
    db.messages = Array.isArray(db.messages) ? db.messages : [];
    // F-V6-2: форма Компаньона валидируем (битый JSON не должен валить демона)
    const c = (db.companion ?? {}) as Partial<CompanionState>;
    const s = (c.settings ?? {}) as Partial<CompanionSettings>;
    db.companion = {
      settings: {
        role: (["assistant", "reviewer", "planner", "tutor"] as string[]).includes(String(s.role))
          ? (s.role as CompanionSettings["role"])
          : DEFAULT_COMPANION.settings.role,
        tone: (["neutral", "friendly", "formal", "concise"] as string[]).includes(String(s.tone))
          ? (s.tone as CompanionSettings["tone"])
          : DEFAULT_COMPANION.settings.tone,
        model: typeof s.model === "string" && s.model.trim() ? s.model.trim() : DEFAULT_COMPANION.settings.model,
      },
      messages: Array.isArray(c.messages)
        ? c.messages
            .filter((m) => m && typeof m.text === "string" && (m.role === "user" || m.role === "companion"))
            .map((m) => ({
              id: String(typeof m.id === "string" && m.id ? m.id : uid("cmp")),
              role: m.role as CompanionMsg["role"],
              text: String(m.text),
              ts: Number(m.ts ?? Date.now()),
              ...(m.source === "llm" || m.source === "local" ? { source: m.source } : {}),
            }))
        : [],
    };
    return db;
  } catch {
    // битый db.json: не теряем — карантин и чистый старт
    const f = Bun.file(DB_FILE);
    if (await f.exists()) {
      const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
      try {
        await Bun.write(`${DB_FILE}.corrupt-${stamp}`, await f.text());
        await f.delete();
      } catch { /* не смогли сохранить копию — всё равно стартуем на чистой */ }
    }
    return structuredClone(EMPTY);
  }
}

let db: DB = await load();
let saving: Promise<void> | null = null;

/**
 * Атомарное сохранение (tmp + rename). Конкурентные вызовы coalesce:
 * ждут текущую запись, а не сбрасывают её таймер (иначе промис не резолвится
 * и обработчик запроса зависает навсегда).
 */
export function save(): Promise<void> {
  if (saving) return saving;
  saving = (async () => {
    await new Promise((r) => setTimeout(r, 120)); // небольшой дебаунс
    const tmp = DB_FILE + ".tmp";
    await Bun.write(tmp, JSON.stringify(db, null, 2));
    renameSync(tmp, DB_FILE);
  })().finally(() => { saving = null; });
  return saving;
}

export function now(): number {
  return Date.now();
}

export function uid(prefix = "id"): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
}

/* ---------------- шина событий ---------------- */

export type BusEvent =
  | { type: "session.created"; session: Session }
  | { type: "session.status"; sessionId: string; status: SessionStatus; exitCode?: number | null }
  | { type: "session.output"; sessionId: string; line: string }
  | { type: "message"; message: Message }
  /** потоковое обновление сообщения (persistent/ACP): текст дозаписывается чанками */
  | { type: "message.upsert"; sessionId: string; message: Message }
  | { type: "sessions.changed" };

type Listener = (e: BusEvent) => void;
const listeners = new Set<Listener>();

export function onEvent(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emit(e: BusEvent): void {
  for (const fn of listeners) {
    try { fn(e); } catch { /* подписчик не должен ронять шину */ }
  }
}

/* ---------------- проекты ---------------- */

export const projects = {
  list: () => db.projects.slice().sort((a, b) => b.createdAt - a.createdAt),
  get: (id: string) => db.projects.find((p) => p.id === id),
  async add(name: string, path: string): Promise<Project> {
    const p: Project = { id: uid("prj"), name, path, createdAt: now() };
    db.projects.push(p);
    await save();
    emit({ type: "sessions.changed" });
    return p;
  },
  async remove(id: string): Promise<void> {
    // сессии проекта гасим ДО удаления из БД (не оставляем живые процессы)
    for (const s of db.sessions.filter((s) => s.projectId === id)) {
      try { const m = await import("./agents/runner"); await m.stopSession(s.id); } catch { /* runner мог не подняться */ }
    }
    db.projects = db.projects.filter((p) => p.id !== id);
    db.sessions = db.sessions.filter((s) => s.projectId !== id);
    db.messages = db.messages.filter((m) => db.sessions.some((s) => s.id === m.sessionId));
    await save();
    emit({ type: "sessions.changed" });
  },
  async archive(id: string, archived = true): Promise<void> {
    const p = db.projects.find((x) => x.id === id);
    if (!p) return;
    p.archived = archived;
    p.archivedAt = archived ? Date.now() : undefined;
    await save();
    emit({ type: "sessions.changed" });
  },
};

/* ---------------- сессии ---------------- */

export const sessions = {
  list: () => db.sessions.slice().sort((a, b) => b.updatedAt - a.updatedAt),
  get: (id: string) => db.sessions.find((s) => s.id === id),
  async add(s: Omit<Session, "createdAt" | "updatedAt" | "exitCode" | "status">): Promise<Session> {
    const full: Session = { ...s, status: "queued", createdAt: now(), updatedAt: now(), exitCode: null };
    db.sessions.push(full);
    await save();
    emit({ type: "session.created", session: full });
    return full;
  },
  async setStatus(id: string, status: SessionStatus, exitCode: number | null = null, fail?: { reason: string; fix?: string }): Promise<void> {
    const s = sessions.get(id);
    if (!s) return;
    s.status = status;
    s.exitCode = exitCode;
    // Причина живёт ровно до следующего успешного запуска: иначе на перезапущенной
    // сессии останется висеть объяснение старого падения.
    if (fail) { s.failReason = fail.reason; if (fail.fix) s.failFix = fail.fix; else delete s.failFix; }
    // Повторная установка статуса «error» без причины НЕ стирает уже
    // выставленное объяснение: иначе более общий обработчик затирал то,
    // что точно знал конкретный.
    else if (status === "running" || status === "queued" || status === "done") { delete s.failReason; delete s.failFix; }
    s.updatedAt = now();
    await save();
    emit({ type: "session.status", sessionId: id, status, exitCode, failReason: s.failReason, failFix: s.failFix });
  },
  async setArchived(id: string, archived = true): Promise<void> {
    const s = sessions.get(id);
    if (!s) return;
    // Архив — не удаление: журнал, пакеты доказательств и копия остаются на
    // месте, сессия лишь уходит из активного списка.
    s.archived = archived || undefined;
    s.archivedAt = archived ? now() : undefined;
    s.updatedAt = now();
    await save();
    emit({ type: "sessions.changed" });
  },
  async setChoice(id: string, choice: Session["pendingChoice"] | null): Promise<void> {
    const s = sessions.get(id);
    if (!s) return;
    if (choice) s.pendingChoice = choice; else delete s.pendingChoice;
    s.updatedAt = now();
    await save();
    emit({ type: "session.status", sessionId: id, status: s.status, exitCode: s.exitCode, pendingChoice: s.pendingChoice });
  },
  async setAuthPrompt(id: string, p: { label: string; url?: string } | null): Promise<void> {
    const s = sessions.get(id);
    if (!s) return;
    if (p) s.authPrompt = { ...p, at: now() }; else delete s.authPrompt;
    s.updatedAt = now();
    await save();
    emit({ type: "session.status", sessionId: id, status: s.status, exitCode: s.exitCode, authPrompt: s.authPrompt });
  },
  async setWeb(id: string, webUrl: string, webToken?: string, webAuthUrl?: string): Promise<void> {
    const s = sessions.get(id);
    if (!s) return;
    s.webUrl = webUrl;
    if (webToken) s.webToken = webToken;
    if (webAuthUrl) s.webAuthUrl = webAuthUrl; else delete s.webAuthUrl;
    s.updatedAt = now();
    await save();
    emit({ type: "session.status", sessionId: id, status: s.status, exitCode: s.exitCode });
  },
  async setTitle(id: string, title: string): Promise<void> {
    const s = sessions.get(id);
    if (!s) return;
    s.title = title.slice(0, 120) || s.title;
    s.updatedAt = now();
    await save();
    emit({ type: "sessions.changed" });
  },
  async setPid(id: string, pid: number | null): Promise<void> {
    const s = sessions.get(id);
    if (!s) return;
    if (pid == null) delete s.pid; else s.pid = pid;
    s.updatedAt = now();
    await save();
  },
  /** Когда процесс агента ушёл. Пишется в момент выхода последнего процесса
   *  сессии — это опорная тория для «жив ли агент» (см. src/liveness.ts).
   *  at=0 — сброс (агент пошёл заново, старой отметки больше нет). */
  async setAgentExitAt(id: string, at: number): Promise<void> {
    const s = sessions.get(id);
    if (!s) return;
    if (!at) delete s.agentExitAt; else s.agentExitAt = at;
    await save();
  },
  async setPairUrl(id: string, pairUrl: string | null): Promise<void> {
    const s = sessions.get(id);
    if (!s) return;
    if (pairUrl) s.webPairUrl = pairUrl; else delete s.webPairUrl;
    s.updatedAt = now();
    await save();
    emit({ type: "session.status", sessionId: id, status: s.status, exitCode: s.exitCode });
  },
  async setAcpModel(id: string, model: string): Promise<void> {
    const s = sessions.get(id);
    if (!s) return;
    s.acpModel = model;
    await save();
  },
  async setExternalRef(id: string, ref: string): Promise<void> {
    const s = sessions.get(id);
    if (!s) return;
    s.externalRef = ref;
    await save();
  },
  async setWorktree(id: string, wt: SessionWorktree): Promise<void> {
    const s = sessions.get(id);
    if (!s) return;
    s.worktree = wt;
    s.updatedAt = now();
    await save();
    emit({ type: "session.status", sessionId: id, status: s.status, exitCode: s.exitCode });
  },
  async setRestorePoint(id: string, rp: RestorePoint): Promise<void> {
    const s = sessions.get(id);
    if (!s) return;
    s.restorePoint = rp;
    s.updatedAt = now();
    await save();
  },
  async addCheck(id: string, run: CheckRun): Promise<void> {
    const s = sessions.get(id);
    if (!s) return;
    s.checks = [...(s.checks ?? []).slice(-9), run]; // храним последние 10 прогонов
    s.updatedAt = now();
    await save();
    emit({ type: "sessions.changed" });
  },
  async addReviewNote(id: string, note: Omit<ReviewNote, "id" | "createdAt" | "status">): Promise<ReviewNote | null> {
    const s = sessions.get(id);
    if (!s) return null;
    const full: ReviewNote = { ...note, id: uid("note"), status: "pending", createdAt: now() };
    s.reviewNotes = [...(s.reviewNotes ?? []), full];
    s.updatedAt = now();
    await save();
    emit({ type: "sessions.changed" });
    return full;
  },
  async setReviewNote(id: string, noteId: string, patch: Partial<Pick<ReviewNote, "status" | "result">>): Promise<void> {
    const s = sessions.get(id);
    const note = s?.reviewNotes?.find((n) => n.id === noteId);
    if (!s || !note) return;
    Object.assign(note, patch);
    s.updatedAt = now();
    await save();
    emit({ type: "sessions.changed" });
  },
  async setReviewNotesBulk(id: string, noteIds: string[], patch: Partial<Pick<ReviewNote, "status" | "result">>): Promise<void> {
    const s = sessions.get(id);
    if (!s?.reviewNotes) return;
    for (const nid of noteIds) {
      const note = s.reviewNotes.find((n) => n.id === nid);
      if (note) Object.assign(note, patch);
    }
    s.updatedAt = now();
    await save();
    emit({ type: "sessions.changed" });
  },
  async setAcceptance(id: string, run: AcceptanceRun): Promise<void> {
    const s = sessions.get(id);
    if (!s) return;
    s.acceptance = run;
    s.updatedAt = now();
    await save();
    emit({ type: "sessions.changed" });
  },
  async setVerifyCommand(id: string, command: string | null): Promise<void> {
    const s = sessions.get(id);
    if (!s) return;
    if (command === null || command === "") delete s.verifyCommand;
    else s.verifyCommand = String(command).slice(0, 300);
    s.updatedAt = now();
    await save();
    emit({ type: "sessions.changed" });
  },
  async remove(id: string): Promise<void> {
    db.sessions = db.sessions.filter((s) => s.id !== id);
    db.messages = db.messages.filter((m) => m.sessionId !== id);
    const f = Bun.file(logFile(id));
    if (await f.exists()) await f.delete();
    await save();
    emit({ type: "sessions.changed" });
  },
};

/* ---------------- бэкап: экспорт/импорт ---------------- */

/** Снимок БД для выгрузки (без логов — они остаются в data/logs). */
export function exportData(): DB {
  return structuredClone(db);
}

function asArray(v: unknown): any[] {
  return Array.isArray(v) ? v.filter((x) => x && typeof x === "object") : [];
}

/**
 * Импорт снимка. mode:
 *  - "merge"   — добавить записи с новыми id (существующие не трогаем)
 *  - "replace" — полностью заменить проекты/сессии/сообщения
 * Возвращает счётчики для отчёта.
 */
export async function importData(
  data: Partial<DB> | null | undefined,
  mode: "merge" | "replace" = "merge"
): Promise<{ projects: number; sessions: number; messages: number }> {
  const projects = asArray(data?.projects);
  const sessions = asArray(data?.sessions);
  const messages = asArray(data?.messages);
  let pCount = 0;
  let sCount = 0;
  let mCount = 0;

  if (mode === "replace") {
    db.projects = projects.map((p) => ({
      id: String(p.id ?? uid("prj")),
      name: String(p.name ?? "проект"),
      path: String(p.path ?? "."),
      createdAt: Number(p.createdAt ?? now()),
    }));
    db.sessions = sessions.map((s) => ({
      id: String(s.id ?? uid("ses")),
      projectId: String(s.projectId ?? ""),
      agentId: String(s.agentId ?? ""),
      title: String(s.title ?? "сессия"),
      prompt: String(s.prompt ?? ""),
      mode: s.mode === "web" ? "web" : "cli",
      status: ["queued", "running", "done", "error", "stopped"].includes(s.status) ? s.status : "stopped",
      createdAt: Number(s.createdAt ?? now()),
      updatedAt: Number(s.updatedAt ?? now()),
      exitCode: s.exitCode == null ? null : Number(s.exitCode),
      ...(s.webUrl ? { webUrl: String(s.webUrl) } : {}),
      ...(s.webToken ? { webToken: String(s.webToken) } : {}),
      ...(s.webAuthUrl ? { webAuthUrl: String(s.webAuthUrl) } : {}),
      ...(s.externalRef ? { externalRef: String(s.externalRef) } : {}),
    }));
    db.messages = messages.map((m) => ({
      id: String(m.id ?? uid("msg")),
      sessionId: String(m.sessionId ?? ""),
      role: ["user", "agent", "system"].includes(m.role) ? m.role : "system",
      text: String(m.text ?? ""),
      ts: Number(m.ts ?? now()),
    }));
    pCount = db.projects.length;
    sCount = db.sessions.length;
    mCount = db.messages.length;
  } else {
    const haveP = new Set(db.projects.map((p) => p.id));
    const haveS = new Set(db.sessions.map((s) => s.id));
    const haveM = new Set(db.messages.map((m) => m.id));
    for (const p of projects) {
      const id = String(p.id ?? uid("prj"));
      if (haveP.has(id)) continue;
      db.projects.push({ id, name: String(p.name ?? "проект"), path: String(p.path ?? "."), createdAt: Number(p.createdAt ?? now()) });
      haveP.add(id);
      pCount++;
    }
    for (const s of sessions) {
      const id = String(s.id ?? uid("ses"));
      if (haveS.has(id)) continue;
      db.sessions.push({
        id,
        projectId: String(s.projectId ?? ""),
        agentId: String(s.agentId ?? ""),
        title: String(s.title ?? "сессия"),
        prompt: String(s.prompt ?? ""),
        mode: s.mode === "web" ? "web" : "cli",
        status: "stopped",
        createdAt: Number(s.createdAt ?? now()),
        updatedAt: now(),
        exitCode: null,
        ...(s.webUrl ? { webUrl: String(s.webUrl) } : {}),
        ...(s.webToken ? { webToken: String(s.webToken) } : {}),
        ...(s.webAuthUrl ? { webAuthUrl: String(s.webAuthUrl) } : {}),
        ...(s.externalRef ? { externalRef: String(s.externalRef) } : {}),
      });
      haveS.add(id);
      sCount++;
    }
    for (const m of messages) {
      const id = String(m.id ?? uid("msg"));
      if (haveM.has(id)) continue;
      db.messages.push({
        id,
        sessionId: String(m.sessionId ?? ""),
        role: ["user", "agent", "system"].includes(m.role) ? m.role : "system",
        text: String(m.text ?? ""),
        ts: Number(m.ts ?? now()),
      });
      haveM.add(id);
      mCount++;
    }
  }

  await save();
  emit({ type: "sessions.changed" });
  return { projects: pCount, sessions: sCount, messages: mCount };
}

/* ---------------- компаньон (F-V6-2, FBA) ---------------- */

const COMPANION_LOG_KEEP = 200; // храним последние 200 записей диалога

export const companion = {
  state: (): CompanionState => structuredClone(db.companion ?? DEFAULT_COMPANION),
  async setSettings(patch: Partial<CompanionSettings>): Promise<CompanionState> {
    db.companion = db.companion ?? structuredClone(DEFAULT_COMPANION);
    if (patch.role && ["assistant", "reviewer", "planner", "tutor"].includes(patch.role)) db.companion.settings.role = patch.role;
    if (patch.tone && ["neutral", "friendly", "formal", "concise"].includes(patch.tone)) db.companion.settings.tone = patch.tone;
    if (typeof patch.model === "string" && patch.model.trim()) db.companion.settings.model = patch.model.trim().slice(0, 120);
    await save();
    emit({ type: "sessions.changed" });
    return structuredClone(db.companion);
  },
  async addMessage(role: CompanionMsg["role"], text: string, source?: CompanionMsg["source"]): Promise<CompanionMsg> {
    db.companion = db.companion ?? structuredClone(DEFAULT_COMPANION);
    const m: CompanionMsg = { id: uid("cmp"), role, text: String(text).slice(0, 8000), ts: now(), ...(source ? { source } : {}) };
    db.companion.messages = [...db.companion.messages.slice(-(COMPANION_LOG_KEEP - 1)), m];
    await save();
    emit({ type: "sessions.changed" });
    return m;
  },
  async clear(): Promise<void> {
    db.companion = db.companion ?? structuredClone(DEFAULT_COMPANION);
    db.companion.messages = [];
    await save();
    emit({ type: "sessions.changed" });
  },
};

/* ---------------- сообщения ---------------- */

export const messages = {
  list: (sessionId: string) => db.messages.filter((m) => m.sessionId === sessionId),
  async add(sessionId: string, role: Message["role"], text: string): Promise<Message> {
    const m: Message = { id: uid("msg"), sessionId, role, text, ts: now() };
    db.messages.push(m);
    await save();
    emit({ type: "message", message: m });
    return m;
  },
  /**
   * Потоковый чанк: если сообщение с таким id уже есть — дописываем текст,
   * иначе создаём. Возвращает финальное сообщение (UI дозаписывает его).
   */
  async appendChunk(sessionId: string, messageId: string, role: Message["role"], chunk: string): Promise<Message> {
    let m = db.messages.find((x) => x.id === messageId && x.sessionId === sessionId);
    if (!m) {
      m = { id: messageId, sessionId, role, text: chunk, ts: now() };
      db.messages.push(m);
    } else {
      m.text += chunk;
    }
    await save();
    emit({ type: "message.upsert", sessionId, message: m });
    return m;
  },
};

/* ---------------- логи ---------------- */

export function logFile(sessionId: string): string {
  return LOG_DIR + `/${sessionId}.log`;
}

// Сериализация appendLog по сессии: параллельные вызовы (чанки стриминга,
// логи reconнектa) иначе читают один prev и затирают строки друг друга.
const logChains = new Map<string, Promise<void>>();

/**
 * Ротация лога сессии (V2-6.2): при превышении LOG_MAX_BYTES текущий файл
 * становится `<id>.log.1` (предыдущий архив затирается), запись начинается
 * заново. Вызывается перед добавлением текста — держит размер предсказуемым.
 */
const LOG_MAX_BYTES = Number(process.env.DIRIGO_LOG_MAX_MB ?? 2) * 1024 * 1024;

/** Известный размер лога (байты): чтобы не спрашивать ФС на каждом куске PTY. */
const logSizes = new Map<string, number>();

async function rotateIfBig(path: string): Promise<void> {
  try {
    let size = logSizes.get(path);
    if (size === undefined) {
      const f = Bun.file(path);
      size = (await f.exists()) ? f.size : 0;
      logSizes.set(path, size);
    }
    if (size < LOG_MAX_BYTES) return;
    await rename(path, `${path}.1`).catch(() => {});
    logSizes.set(path, 0);
  } catch { /* ротация не критична — логи продолжаем писать в тот же файл */ }
}

/**
 * Дозапись в лог сессии. Раньше файл читался целиком и переписывался заново
 * на каждый кусок — для терминала, который перерисовывается десятки раз в
 * секунду, это квадратичная нагрузка на диск и CPU, от которой тормозил весь
 * демон. Теперь — обычная дозапись в конец файла.
 */
export async function appendLog(sessionId: string, text: string): Promise<void> {
  const prev = logChains.get(sessionId) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(async () => {
    const path = logFile(sessionId);
    try {
      await appendFile(path, text, "utf8");
    } catch (e) {
      // Каталог логов могли удалить на ходу (уборка, тесты) — создаём заново.
      // Запись журнала не должна ронять работу агента, поэтому без throw.
      if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") return;
      try { mkdirSync(LOG_DIR, { recursive: true }); await appendFile(path, text, "utf8"); } catch { return; }
    }
    const known = logSizes.get(path);
    if (known !== undefined) logSizes.set(path, known + Buffer.byteLength(text, "utf8"));
    for (const line of text.split(/\r?\n/)) {
      if (line.trim()) emit({ type: "session.output", sessionId, line });
    }
  });
  logChains.set(sessionId, next.catch(() => {}));
  return next;
}

/** Ротирующий лог: сначала проверка размера, потом дозапись (V2-6.2). */
export async function appendLogRotated(sessionId: string, text: string): Promise<void> {
  const path = logFile(sessionId);
  // Ротация — в той же очереди, что и запись: иначе rename мог вклиниться
  // между двумя дозаписями соседнего вызова.
  const prev = logChains.get(sessionId) ?? Promise.resolve();
  logChains.set(sessionId, prev.catch(() => {}).then(() => rotateIfBig(path)));
  await appendLog(sessionId, text);
}

export async function readLogTail(sessionId: string, n = 200): Promise<string[]> {
  const f = Bun.file(logFile(sessionId));
  if (!(await f.exists())) return [];
  const lines = (await f.text()).split(/\r?\n/).filter(Boolean);
  return lines.slice(-n);
}
