// Dirigo — HTTP-сервер (Bun.serve, без зависимостей)
//
// Совместимость: продукт раньше назывался Orchestra. scan-ok. Старые переменные
// окружения ORCHESTRA_* продолжают работать — нормализуем их в DIRIGO_* ДО
// того, как любой модуль их прочитает.
for (const [k, v] of Object.entries(process.env)) {
  if (k.startsWith("ORCHESTRA_") && v !== undefined) {
    const next = "DIRIGO_" + k.slice("ORCHESTRA_".length);
    if (process.env[next] === undefined) process.env[next] = v;
  }
}
// Демон часто запускают из терминала, где уже работает Claude Code (или
// другой агент). Его служебные маркеры наследуются всеми агентами пульта:
// Claude в терминале сессии считал себя вложенным («Transcript saving is
// off — inherited CLAUDE_CODE_CHILD_SESSION»), а адрес и токен канала
// сообщений чужого сеанса уходили каждому дочернему процессу. Вычищаем.
for (const k of Object.keys(process.env)) {
  if (/^(CLAUDECODE|CLAUDE_PID|CLAUDE_CODE_(CHILD_SESSION|ENTRYPOINT|MESSAGING_SOCKET|MESSAGING_TOKEN|SESSION_ATTENDED|SESSION_ID|SSE_PORT))$/.test(k)) delete process.env[k];
}
import "./hide-windows"; // первым: скрыть окна консольных процессов (Windows)
import { readdirSync, statSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { sessionTitleFor } from "./session-title";
import { watchParent } from "./parent-watch";
import { execFileSync } from "node:child_process";
import { join, dirname, isAbsolute } from "node:path";
import { AGENTS, getAgent } from "./agents/registry";
import { runner, sessionCwd } from "./agents/runner";
import {
  sessions,
  projects,
  messages,
  onEvent,
  emit,
  uid,
  readLogTail,
  appendLog,
  exportData,
  importData,
  type BusEvent,
  type Session,
} from "./store";
import {
  applyWorktree,
  cleanupStale,
  dataDir,
  releaseWorktreeSlot,
  purgeTrash,
  cleanupWorktree,
  createWorktree,
  diffWorktree,
  getWorktree,
  gitRepoInfo,
  initProjectRepo,
  isGitProject,
  listWorktrees,
  revertWorktree,
  workDir,
  worktreeStats,
  withGitReadCache,
  clearGitReadCache,
  type WorktreeKind,
} from "./worktrees";
import { ACTIVITY_WINDOW_MS, deferCopyRemoval, sessionAlive } from "./liveness";
import { runChecksOverride } from "./checks";
import { branchDiff, describeTarget, resolveTarget, type BranchTarget } from "./branch";
import { deleteSecret, hasSecret, loadSecrets, secretValue, secretsEnv, secretsSummary, setSecret } from "./secrets";
import { qrSvg } from "./qr";
import type { PtyHandle } from "./agents/pty";
import { Screen } from "./agents/screen";
import { loadPlugins } from "./plugins";
import {
  addMachine, listMachines, loadMachines, openTunnel, probeMachine, removeMachine, tunnelArgs,
} from "./machines";
import { startTunnel, stopTunnel, tunnelInfo, cloudflaredAvailable } from "./tunnel";
import { deployDaemon, parseMarkers, sshArgs } from "./deploy";
import { enqueue, getQueueItem, listQueue, trimQueue } from "./queue";
import { gitAction } from "./git";
import { listSkills, readSkill } from "./skills";
import {
  applyEpic,
  applyPlan,
  createPlan,
  deletePlan,
  getEpic,
  getPlan,
  listPlans,
  loadPlans,
  planSummary,
  startPlan,
  updatePlan,
  verifyEpic,
} from "./orchestrator";
import {
  applySwarm, applyWorker, commonFeed, createSwarm, deleteSwarm,
  getSwarm, getWorker, judgeSwarm, listSwarms, loadSwarms, refreshSwarm, startSwarm, swarmSummary,
} from "./swarm";
import {
  applyFusion, createFusion, deleteFusion, fusionSummary, getFusion,
  judgeFusion, listFusions, loadFusions, refreshFusion, startFusion,
} from "./fusion";

/** v2: сколько копий держим одновременно (лимит параллелей). */
const MAX_WORKTREES = Number(process.env.DIRIGO_MAX_WORKTREES ?? 8);
/**
 * V2-6.2: лимит одновременно запущенных агентов (процессы+PTY+ACP).
 * Считаем живые сессии (running/queued) — новый запуск сверх лимита → 409.
 */
const MAX_AGENT_PROCESSES = Number(process.env.DIRIGO_MAX_PROCESSES ?? 12);
/** Живых агентских процессов сейчас (для лимита и health). */
function liveProcesses(): number {
  return sessions.list().filter((s) => s.status === "running" || s.status === "queued").length;
}
/** v2: TTL неиспользуемых копий (по умолчанию 24 ч) — чистка при старте и по расписанию. */
const WORKTREE_TTL_MS = Number(process.env.DIRIGO_WORKTREE_TTL_HOURS ?? 24) * 3600 * 1000;
import { apiLimiter, clientIp, loginLimiter, safeEqual } from "./security/ratelimit";

// Порт: PORT — исторический, DIRIGO_PORT — документированный в .env.example
// и install-скриптах. Принимаем оба, иначе DIRIGO_PORT молча игнорировался.
const PORT = Number(process.env.PORT ?? process.env.DIRIGO_PORT ?? 7171); // v1: 7171
const HOST = process.env.HOST ?? "127.0.0.1";
const TOKEN = process.env.DIRIGO_TOKEN ?? ""; // если задан — требуем Bearer

const WEB = new URL("../web/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

// CSP: единственный inline-скрипт (тема до First Paint в index.html) допускается
// по хешу — вычисляем из файла при старте (браузер нормализует CRLF→LF перед
// хешированием, поэтому и мы), чтобы правка темы не ломала политику.
const INLINE_SCRIPT_HASH = (() => {
  try {
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const html = readFileSync(new URL("../web/index.html", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "utf8");
    const m = html.match(/<script>([\s\S]*?)<\/script>/);
    if (!m) return "";
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(m[1]!.replace(/\r\n/g, "\n"));
    return `'sha256-${hasher.digest("base64")}'`;
  } catch { return ""; }
})();

function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
      // V5: orch-mobile (PWA на другом порту) обращается к API кросс-доменно.
      // Разрешаем любой Origin (loopback-only режим сам защищает: без токена
      // доступен только 127.0.0.1; с токеном — только Bearer/кука). Креды не
      // отдаём (Authorization-заголовок клиент ставит вручную) — credentials:omit.
      "access-control-allow-origin": "*",
      ...extra,
    },
  });
}

function authed(req: Request): boolean {
  if (!TOKEN) return true; // loopback-only режим
  if (safeEqual(req.headers.get("authorization") ?? "", `Bearer ${TOKEN}`)) return true;
  // Cookie — для EventSource (/api/events), который не умеет заголовки
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const eq = part.trim().indexOf("=");
    if (eq > 0 && safeEqual(part.trim().slice(0, eq), "dirigo_token")
      && safeEqual(part.trim().slice(eq + 1), TOKEN)) return true;
  }
  return false;
}

function withSecurity(res: Response): Response {
  res.headers.set("content-security-policy",
    `default-src 'self'; script-src 'self' ${INLINE_SCRIPT_HASH}; style-src 'self' 'unsafe-inline'; ` +
    "img-src 'self' data:; frame-src http: https:; connect-src 'self'");
  res.headers.set("x-content-type-options", "nosniff");
  return res;
}

async function body(req: Request): Promise<any> {
  try { return await req.json(); } catch { return {}; }
}

/* ---------------- SSE ---------------- */

const sseClients = new Map<ReadableStreamDefaultController<Uint8Array>, ReturnType<typeof setInterval>>();
const encoder = new TextEncoder();

onEvent((e: BusEvent) => {
  if (e.type === "session.output") return; // вывод идёт через лог, трансляция только состояний
  const frame = encoder.encode(`data: ${JSON.stringify(e)}\n\n`);
  for (const [c] of sseClients) {
    try { c.enqueue(frame); } catch { /* закрытый поток */ }
  }
});

function sseStream(): Response {
  const res = new Response(
    new ReadableStream({
      start(controller) {
        const hb = setInterval(() => {
          try { controller.enqueue(encoder.encode(": ping\n\n")); } catch { /* noop */ }
        }, 15000);
        sseClients.set(controller, hb);
        try { controller.enqueue(encoder.encode(": connected\n\n")); } catch { /* noop */ }
      },
      cancel(controller) {
        const hb = sseClients.get(controller);
        if (hb) clearInterval(hb);
        sseClients.delete(controller);
      },
    }),
    {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        // V5: SSE из orch-mobile (PWA на другом порту) — кросс-доменный поток.
        "access-control-allow-origin": "*",
      },
    },
  );
  return res;
}

/* ---------------- статика ---------------- */

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

async function serveStatic(pathname: string): Promise<Response | null> {
  const rel = (pathname === "/" ? "index.html" : pathname.replace(/^\/web\//, "")).replace(/^\//, "");
  if (rel.includes("..")) return null;
  const file = Bun.file(WEB + rel);
  if (!(await file.exists())) return null;
  const ext = rel.slice(rel.lastIndexOf("."));
  return withSecurity(new Response(file, { headers: { "content-type": MIME[ext] ?? "application/octet-stream" } }));
}

/** v2: BOOT_AT для uptime в health. */
const BOOT_AT = Date.now();

/**
 * Пульт не имеет права умирать от ошибки в фоновой задаче.
 *
 * Установка агента уронила весь демон необработанным TypeError — и пользователь
 * получил «нет связи с демоном» вместо «этот агент не поставился». Панель
 * управления обязана переживать любую такую ошибку: мы её записываем и
 * продолжаем обслуживать запросы.
 */
function guardProcess(): void {
  const note = (kind: string, e: unknown) => {
    const text = `[dirigo] ${kind}: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`;
    console.error(text);
    void appendLog("daemon", text);
  };
  process.on("uncaughtException", (e) => note("необработанное исключение", e));
  process.on("unhandledRejection", (e) => note("необработанный отказ промиса", e));
}
guardProcess();



/** v2: примерный размер каталога копий (для метрик; рекурсивно, с лимитом). */
function worktreeDiskBytes(root = workDir(), depth = 0): number {
  if (depth > 4) return 0;
  try {
    let total = 0;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const p = join(root, entry.name);
      if (entry.isDirectory()) total += worktreeDiskBytes(p, depth + 1);
      else if (entry.isFile()) total += statSync(p).size;
    }
    return total;
  } catch { return 0; }
}

/** Версия демона — отдаётся в health и показывается в шапке UI (единый источник правды). */
export const APP_VERSION = "0.1.0";

/* ── происхождение изменений: журнал на сессию + пакет доказательств ── */

/** Открыть журнал сессии: агент, модель, режим, хеш задачи. */
async function openProvenance(
  s: Session,
  prompt: string,
  scan?: import("./policy").ScanResult,
): Promise<void> {
  try {
    const { record, sha256 } = await import("./provenance");
    record(s.id, "session.created", { projectId: s.projectId, title: s.title, worktree: s.worktree?.kind ?? null });
    record(s.id, "agent.started", {
      agentId: s.agentId, model: s.model ?? null, reasoning: s.reasoning ?? null,
      mode: s.mode, workMode: s.workMode ?? "solo",
    });
    if (prompt) record(s.id, "prompt.submitted", { sha256: sha256(prompt), chars: prompt.length });
    // Шлюз персональных данных: в журнал идут только типы и количество находок,
    // сами значения не сохраняются нигде.
    if (scan && scan.mode !== "off") {
      record(s.id, "policy.scan", {
        target: "prompt", mode: scan.mode,
        findings: scan.findings.length, kinds: Object.keys(scan.byKind),
        blocked: scan.blocked, redacted: scan.mode === "redact" && scan.findings.length > 0,
      });
    }
  } catch { /* журнал не должен мешать запуску задачи */ }
}

/**
 * Шлюз PII для изменений агента (перед «Применить» и коммитом): в журнал —
 * тип и количество находок, файлы и номера строк; значения не пишутся.
 * Возвращает ответ-отказ, если политика block и пользователь не подтвердил
 * исключение (allowPii=true — тоже записывается в журнал).
 */
async function policyGateChanges(
  sessionId: string, action: string,
  files: Array<{ path: string; status?: string; lines?: Array<{ kind: string; text: string; newNo: number | null }> }>,
  allowPii: boolean,
): Promise<Response | null> {
  try {
    const { scanChanges } = await import("./policy");
    const scan = scanChanges(files);
    if (scan.mode === "off") return null;
    const { record } = await import("./provenance");
    record(sessionId, "policy.scan", {
      target: "changes", action, mode: scan.mode,
      findings: scan.findings, kinds: Object.keys(scan.byKind),
      files: scan.files.map((f) => ({ path: f.path, kinds: f.kinds, lines: f.lines })),
      blocked: scan.blocked && !allowPii, overridden: scan.blocked && allowPii,
    });
    const policy = { mode: scan.mode, findings: scan.findings, kinds: Object.keys(scan.byKind), files: scan.files, summary: scan.summary };
    if (scan.blocked && !allowPii) {
      return json({ ok: false, error: scan.summary, policy, needsPiiOverride: true, applied: [], removed: [], conflicts: [] }, 409);
    }
    return null;
  } catch { return null; /* сбой проверки не должен терять работу агента */ }
}

/** Собрать, подписать и сохранить пакет доказательств для применённых изменений. */
async function writeEvidence(
  sessionId: string,
  ctx: {
    approvedBy?: string; files?: Array<{ path: string; added?: number; deleted?: number; status?: string }>; applied?: string[]; removed?: string[];
    /** committed — пакет за коммит (сессия без копии тоже получает доказательства) */
    event?: "applied" | "committed"; repoPath?: string; commitMessage?: string;
  },
): Promise<import("./provenance").EvidencePack | null> {
  try {
    const { record, buildEvidencePack, savePack } = await import("./provenance");
    const s = sessions.get(sessionId);
    const project = s ? projects.get(s.projectId) : undefined;
    const wt = s?.worktree;
    let commit: string | null = null;
    try {
      const where = ctx.repoPath ?? wt?.path;
      if (where) {
        const r = Bun.spawnSync(["git", "-C", where, "rev-parse", "HEAD"]);
        if (r.exitCode === 0) commit = r.stdout.toString().trim() || null;
      }
    } catch { /* не git-проект — коммита просто не будет */ }

    record(sessionId, ctx.event === "committed" ? "change.committed" : "change.applied", {
      files: (ctx.files ?? []).map((f) => f.path),
      applied: ctx.applied?.length ?? 0,
      removed: ctx.removed?.length ?? 0,
      approvedBy: ctx.approvedBy ?? null,
      commit,
      ...(ctx.commitMessage ? { message: ctx.commitMessage.slice(0, 200) } : {}),
    });

    const pack = buildEvidencePack(sessionId, {
      project: { name: project?.name, path: project?.path, branch: undefined },
      task: { title: s?.title, prompt: s?.prompt },
      isolation: { kind: wt?.kind, worktree: wt?.path, baseRef: wt?.baseRef },
      approvedBy: ctx.approvedBy,
      files: ctx.files,
      applied: ctx.applied,
      removed: ctx.removed,
      commit,
      version: APP_VERSION,
      trigger: ctx.event === "committed" ? "committed" : "applied",
    });
    savePack(pack);

    // База знаний компании: запись о задаче уходит только если интеграция
    // включена, и только через шлюз персональных данных.
    try {
      const { loadKnowledge, entryFromPack, pushEntry } = await import("./knowledge");
      const kcfg = loadKnowledge();
      if (kcfg.enabled) {
        const entry = entryFromPack(pack, kcfg.project);
        const res = await pushEntry(entry, kcfg, pack.project.path);
        record(sessionId, "knowledge.pushed", {
          ok: res.ok, status: res.status ?? null,
          skipped: res.skipped ?? null, scrubbed: res.scrubbed ?? 0,
          target: kcfg.url.replace(/\/\/[^/]*@/, "//"),
        });
      }
    } catch { /* база знаний недоступна — задача всё равно применена */ }

    return pack;
  } catch {
    return null;
  }
}

/**
 * Удалить копию проекта, а если её ещё держат уходящие процессы агента —
 * повторить чуть позже. Раньше неудачная попытка оставляла запись в реестре,
 * она занимала лимит копий, и после восьми удалённых сессий новые не
 * создавались («лимит копий исчерпан»).
 *
 * keepUntil (F_VER-5): если задан, копию сейчас не сносим — агент мог ещё
 * работать (клиент opencode умер, а ход ушёл в сервис: правки идут в копию).
 * Снос — когда агент замолчит или срок выйдет.
 */
function cleanupWorktreeSoon(id: string, delays = [2000, 6000, 15000, 40000], keepUntil = 0): void {
  if (keepUntil > Date.now()) { deferCopyRemoval(id, keepUntil); return; }
  // первая попытка — сразу (обычно копия свободна), повторы — фоном
  if (cleanupWorktree(id).ok) return;
  const retry = (left: number[]) => {
    const [d, ...rest] = left;
    if (d === undefined) return;
    setTimeout(() => {
      if (cleanupWorktree(id).ok) return;
      // повторы кончились — слот не держим, папка уйдёт в «удалить позже»
      if (!rest.length) { releaseWorktreeSlot(id); scheduleTrashPurge(); return; }
      retry(rest);
    }, d);
  };
  retry(delays);
}

/** Копия под защитой (F_VER-5): агент мог ещё работать — сносить нельзя. */
const isProtectedCopy = (w: { protectedUntil?: number }): boolean =>
  !!w.protectedUntil && w.protectedUntil > Date.now();

/** Отложенные папки копий — повторить удаление через 10 с, минуту, 5 минут. */
let trashTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleTrashPurge(delays = [10_000, 60_000, 300_000]): void {
  if (trashTimer || !delays.length) return;
  const [d, ...rest] = delays;
  trashTimer = setTimeout(() => { trashTimer = null; if (purgeTrash() > 0) scheduleTrashPurge(rest); }, d);
  (trashTimer as any).unref?.();
}

/* ── V6-5: терминалы (PTY) — окно по центру табом, список справа-снизу ── */
interface TermHandle {
  id: string; name: string; dir: string; handle: PtyHandle; buf: string; createdAt: number; mode: "pty" | "pipe";
  /** экран терминала (эмулятор VT) и подписчики живого потока — как у PTY-сессий агентов */
  screen: Screen; subs: Set<(e: unknown) => void>; alive: boolean;
}
const terminals = new Map<string, TermHandle>();

/** SSE-ответ поверх подписки: attach шлёт события, возвращает отписку (null — нечего слушать). */
function sseOf(attach: (send: (e: unknown) => void) => (() => void) | null): Response {
  let detach: (() => void) | null = null;
  let hb: ReturnType<typeof setInterval> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (e: unknown) => {
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`)); } catch { /* закрыт */ }
      };
      detach = attach(send);
      if (!detach) { send({ t: "none" }); try { controller.close(); } catch { /* */ } return; }
      hb = setInterval(() => { try { controller.enqueue(encoder.encode(": ping\n\n")); } catch { /* */ } }, 15000);
    },
    cancel() { detach?.(); if (hb) clearInterval(hb); },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
  });
}

function termName(dir: string): string {
  const base = dir.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "term";
  return base.length > 22 ? base.slice(0, 21) + "…" : base;
}

async function createTerminal(dir: string): Promise<TermHandle> {
  const { spawnTerminal } = await import("./agents/pty");
  // встроенный интерпретатор ОС: Windows → PowerShell, macOS → zsh, Linux → bash
  const shell = process.platform === "win32" ? "powershell.exe" : process.platform === "darwin" ? "/bin/zsh" : "/bin/bash";
  // Windows: кодировку UTF-8 включаем аргументом запуска (-NoExit -Command),
  // а не набором в терминал — раньше эта строка видна была первой в каждом окне.
  const shellArgs = process.platform === "win32"
    ? ["-NoLogo", "-NoProfile", "-NoExit", "-Command", "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $OutputEncoding=[System.Text.Encoding]::UTF8; chcp 65001 > $null"]
    : [];
  const id = `trm_${Math.random().toString(36).slice(2, 8)}`;
  const buf: string[] = [];
  const screen = new Screen(30, 120);
  const subs = new Set<(e: unknown) => void>();
  const send = (e: unknown) => { for (const fn of subs) { try { fn(e); } catch { /* закрытый поток */ } } };
  let live: PtyHandle | null = null;
  screen.onResponse = (r) => { try { live?.write(r); } catch { /* закрыт */ } };
  const handle = await spawnTerminal(shell, shellArgs, {
    cwd: existsSync(dir) && statSync(dir).isDirectory() ? dir : process.cwd(),
    cols: 120, rows: 30,
    env: {
      ...process.env,
      // UTF-8 в терминале: кириллица/git-вывод без кракозябр. PowerShell 5.1 по
      // умолчанию в OEM (cp437/866) — git-логи/диффы с русским текстом ломались.
      ...(process.platform === "win32" ? { LANG: "ru_RU.UTF-8", LC_ALL: "ru_RU.UTF-8" } : {}),
      // git: не экранировать не-ASCII в путях, UTF-8 для логов
      LC_ALL: "C.UTF-8",
    } as Record<string, string>,
    onData: (chunk) => {
      buf.push(chunk);
      if (buf.length > 4000) buf.splice(0, buf.length - 4000);
      screen.feed(chunk);
      send({ t: "d", data: chunk });
      emit({ type: "terminal.data", terminalId: id, chunk } as BusEvent);
    },
    onExit: (code) => {
      send({ t: "exit", code });
      emit({ type: "terminal.exit", terminalId: id } as BusEvent);
      const t = terminals.get(id);
      if (t) t.alive = false;
      terminals.delete(id);
    },
  });
  live = handle;
  const t: TermHandle = { id, name: termName(dir), dir, handle, buf: "", createdAt: Date.now(), mode: handle.kind, screen, subs, alive: true };
  if (handle.kind === "pipe") {
    // Без TTY нет ни промпта, ни эха — честно предупреждаем в самом терминале.
    const warn = "[dirigo] PTY недоступен — терминал работает через пайпы: " +
      "команды выполняются, но без промпта, эха и TUI.\r\n";
    buf.push(warn);
    screen.feed(warn);
    send({ t: "d", data: warn });
    emit({ type: "terminal.data", terminalId: id, chunk: warn } as BusEvent);
  }
  terminals.set(id, t);
  emit({ type: "terminals.changed" } as BusEvent);
  return t;
}

function killTerminal(id: string): void {
  const t = terminals.get(id);
  if (!t) return;
  try { t.handle.kill(); } catch { /* уже мёртв */ }
  terminals.delete(id);
  emit({ type: "terminals.changed" } as any);
}

function terminalsSummary() {
  return [...terminals.values()].map((t) => ({ id: t.id, name: t.name, dir: t.dir, createdAt: t.createdAt, mode: t.mode, tail: "" }));
}

/** V3-2: найти машину по id (локальная обёртка, чтобы не тянуть import в hot-path). */
function getMachineSafe(id: string) {
  return listMachines().find((m) => m.id === id);
}

/** Сброс кэша статусов агентов (после установки/ключей). */
async function invalidateStatusCacheSafe(): Promise<void> {
  try { const { invalidateStatusCache } = await import("./setup/manager"); invalidateStatusCache(); } catch { /* менеджер не загружен */ }
}

function bunVersion(): string | null {
  try {
    const r = Bun.spawnSync(["bun", "--version"]);
    return r.exitCode === 0 ? r.stdout.toString().trim() : null;
  } catch { return null; }
}

/* ---------------- установка окружения через UI (V4-1) ---------------- */
interface EnvJob { id: string; what: string; status: "queued" | "running" | "done" | "failed"; log: string[]; startedAt: number; finishedAt?: number; }
const ENV_JOBS: EnvJob[] = [];

function enqueueEnvJob(what: string): EnvJob {
  const job: EnvJob = { id: `env_${Date.now().toString(36)}`, what, status: "queued", log: [], startedAt: Date.now() };
  ENV_JOBS.push(job);
  void runEnvJob(job);
  return job;
}

async function runEnvJob(job: EnvJob): Promise<void> {
  job.status = "running";
  const say = (l: string) => { job.log.push(l); void appendLog("setup", l); };
  const cmds: Record<string, string[][]> = {
    bun: process.platform === "win32"
      ? [["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "irm bun.sh/install | iex"]]
      : [["bash", "-c", "curl -fsSL https://bun.sh/install | bash"]],
    cloudflared: process.platform === "win32"
      ? [["winget", "install", "--id", "Cloudflare.cloudflared", "-e", "--accept-source-agreements", "--accept-package-agreements"]]
      : process.platform === "darwin"
        ? [["brew", "install", "cloudflared"]]
        : [["bash", "-c", "curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /usr/local/bin/cloudflared && chmod +x /usr/local/bin/cloudflared"]],
  };
  const steps = cmds[job.what];
  if (!steps) { job.status = "failed"; job.finishedAt = Date.now(); job.log.push(`неизвестный компонент: ${job.what}\n`); return; }
  try {
    for (const cmd of steps) {
      say(`$ ${cmd.join(" ")}\n`);
      const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
      const timer = setTimeout(() => { try { proc.kill(); } catch { /* уже мёртв */ } }, 600_000);
      const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      clearTimeout(timer);
      const tail = (out + err).trim().split("\n").slice(-15).join("\n");
      if (tail) say(tail + "\n");
      if (code !== 0) { say(`шаг упал (код ${code})\n`); job.status = "failed"; job.finishedAt = Date.now(); return; }
    }
    say("готово — перезапусти демон, чтобы PATH подхватился\n");
    job.status = "done";
  } catch (e) {
    say(`ошибка: ${String(e)}\n`);
    job.status = "failed";
  }
  job.finishedAt = Date.now();
}

function listEnvJobs(): EnvJob[] { return ENV_JOBS.slice(-10).reverse(); }

/* ---------------- маршруты ---------------- */

/** Промпт доработки по замечаниям ревью (файл:строка + текст). */
function reviewPrompt(notes: { file: string; lineNo: number | null; text: string }[]): string {
  const lines = notes.map((n) => `• ${n.file}${n.lineNo ? `:${n.lineNo}` : ""} — ${n.text}`);
  return [
    "Замечания ревью по твоим правкам в копии проекта — исправь каждый пункт:",
    "",
    ...lines,
    "",
    "Не меняй файлы вне этих замечаний. После правки кратко напиши, что сделано.",
  ].join("\n");
}

/** Доотправка ревью агенту в его режиме. */
async function reviewFollowUp(sessionId: string, text: string): Promise<string> {
  const cur = sessions.get(sessionId);
  if (!cur) return "нет сессии";
  if (cur.persistent) {
    await runner.sendPersistentMessage(sessionId, text);
    return "ACP follow-up";
  }
  if (cur.mode === "pty") {
    runner.writePty(sessionId, text + "\n");
    return "PTY-ввод";
  }
  if (cur.mode === "cli") {
    runner.runSession(sessionId, text).catch(async (e) => {
      await appendLog(sessionId, `[dirigo] доработка по ревью не запустилась: ${String(e)}\n`);
    });
    return "cli-перезапуск";
  }
  return "режим без авто-доработки";
}

/**
 * Старт сессии по её режиму (cli/persistent/pty/web). Вынесено из POST /api/sessions,
 * чтобы запускать и сессии-копии (v2), и обычные. cli: сообщение пользователя
 * фиксируется ДО ответа API (порядок важен для UI), дальше — запуск без ожидания.
 */
/* ── V6-4: запуск подсистемы по типу сессии (solo/swarm/fusion/orchestrator).
   Сессия остаётся «дирижёром»: она создаёт задачу соответствующего режима и
   стартует её — воркеры/кандидаты/эпики появляются на Доске. */
async function startWorkMode(sessionId: string, workMode: "swarm" | "fusion" | "orchestrator", prompt: string): Promise<void> {
  const s = sessions.get(sessionId);
  if (!s) return;
  const project = projects.get(s.projectId);
  if (!project) return;
  const goal = s.prompt?.trim() || prompt || s.title;
  try {
    if (workMode === "swarm") {
      const zones = ["."];
      const task = createSwarm({ title: goal.slice(0, 120), goal, projectId: project.id, agentId: s.agentId, zones });
      await appendLog(sessionId, `[dirigo] рой ${task.id}: ${zones.length} зон(ы)\n`);
      const r = await startSwarm(task.id);
      await appendLog(sessionId, r.ok ? `[dirigo] рой запущен: ${r.started} воркер(ов)\n` : `[dirigo] рой не стартовал: ${r.error}\n`);
      return;
    }
    if (workMode === "fusion") {
      // кандидаты: выбранный агент + до двух других CLI-агентов (разные модели)
      const others = listAgents().filter((a) => a.kind === "cli" && a.id !== s.agentId).slice(0, 2).map((a) => a.id);
      const agents = [s.agentId, ...others];
      const run = createFusion({ title: goal.slice(0, 120), prompt: goal, projectId: project.id, agents });
      await appendLog(sessionId, `[dirigo] fusion ${run.id}: ${agents.length} кандидат(ов)\n`);
      const r = await startFusion(run.id);
      await appendLog(sessionId, r.ok ? `[dirigo] fusion запущен: ${r.started} кандидат(ов)\n` : `[dirigo] fusion не стартовал: ${r.error}\n`);
      return;
    }
    if (workMode === "orchestrator") {
      const plan = createPlan({
        goal,
        projectId: project.id,
        agentId: s.agentId,
        epics: [{ title: goal.slice(0, 160) }],
      });
      await appendLog(sessionId, `[dirigo] план ${plan.id}: 1 эпик, агент ${s.agentId}\n`);
      const r = await startPlan(plan.id);
      await appendLog(sessionId, r.ok ? `[dirigo] план запущен (${r.started ?? 0} эпик(ов))\n` : `[dirigo] план не стартовал: ${r.error}\n`);
    }
  } catch (e) {
    await appendLog(sessionId, `[dirigo] ${workMode}: ${String(e)}\n`);
  }
}

function startSessionByMode(s: Session, prompt: string, model?: string): void {
  // Последний рубеж: если ни один конкретный обработчик не назвал причину,
  // её называем здесь. Сессия со статусом «Ошибка» и пустым объяснением —
  // это тот самый «Error» без подсказки, с которого всё начиналось.
  const fail = async (e: unknown) => {
    await appendLog(s.id, `[dirigo] ${String(e)}\n`);
    if (sessions.get(s.id)?.failReason) { await sessions.setStatus(s.id, "error", -1); return; }
    const label = getAgent(s.agentId)?.label ?? s.agentId;
    await sessions.setStatus(s.id, "error", -1, {
      reason: `${label} не запустился: ${String(e).replace(/^Error:\s*/, "").slice(0, 160)}`,
      fix: "Откройте журнал сессии — там полный вывод агента",
    });
  };
  if (s.mode === "cli") {
    void messages.add(s.id, "user", prompt);
    runner.runSession(s.id, prompt).catch(fail);
  } else if (s.mode === "persistent") {
    // первое сообщение видно сразу, а не после рукопожатия ACP (до десятков секунд)
    if (prompt) void messages.add(s.id, "user", prompt);
    runner.startPersistent(s.id, { resume: false, model, firstPrompt: !!prompt })
      .then(async () => {
        if (prompt) await runner.sendPersistentMessage(s.id, prompt, { recorded: true }).catch(fail);
      })
      .catch(fail);
  } else if (s.mode === "pty") {
    runner.startPty(s.id).catch(fail);
  } else if (s.mode === "web") {
    runner.runSession(s.id, prompt).catch(fail);
  }
}

/* ---------------- очистка после рестарта ---------------- */

// При старте: агентные процессы прошлого запуска — сироты (родитель умер).
// Гасим по сохранённому PID и переводим сессии в stopped, чтобы UI не врал.
// bootReady резолвится по завершении — /api/health ждёт его, чтобы не отдавать
// «running» по сессиям, которые вот-вот станут stopped.
const bootReady = (async () => {
  const stale = sessions.list().filter((s) => (s.status === "running" || s.status === "queued") && s.pid);
  for (const s of stale) {
    // Снос осиротевшего процесса агента: taskkill — только Windows,
    // на Unix его нет вовсе (раньше сирота просто оставался жить).
    try {
      if (process.platform === "win32") Bun.spawnSync(["taskkill", "/PID", String(s.pid), "/T", "/F"]);
      else process.kill(-s.pid!, "SIGKILL"); // группа процессов, иначе дети выживают
    } catch {
      try { process.kill(s.pid!, "SIGKILL"); } catch { /* процесс уже мёртв */ }
    }
    if (!s.persistent) await appendLog(s.id, "[dirigo] сервер был перезапущен — процесс агента остановлен\n");
  }
  const ghosts = sessions.list().filter((s) => (s.status === "running" || s.status === "queued") && !s.pid);
  for (const s of [...stale, ...ghosts]) {
    if (s.persistent) continue; // persistent переподключаем ниже, а не гасим
    await sessions.setStatus(s.id, "stopped");
  }
  if (stale.length + ghosts.length) console.log(`cleanup: ${stale.length + ghosts.length} осиротевших сессий переведено в stopped`);

  // Persistent (ACP): автоматическое переподключение живых сессий через session/load.
  const live = sessions.list().filter((s) => s.persistent && (s.status === "running" || s.status === "queued"));
  for (const s of live) {
    await runner.startPersistent(s.id, { resume: true }).catch((e) =>
      console.log(`reconnect ${s.id} failed: ${String(e)}`));
  }
  if (live.length) console.log(`reconnect: ${live.length} persistent-сессий к переподключению`);

  // v2: TTL-чистка копий проекта — осиротевшие (сессии уже нет) удаляем всегда,
  // старые неиспользуемые — по возрасту.
  try {
    const staleWts = cleanupStale(WORKTREE_TTL_MS);
    if (staleWts.length) console.log(`worktrees: TTL-чистка удалила ${staleWts.length} копий`);
    const orphans = listWorktrees().filter((w) => !sessions.get(w.sessionId));
    for (const w of orphans) {
      // Защищённая копия (F_VER-5): агент мог ещё работать — не сносим.
      if (isProtectedCopy(w)) { console.log(`worktrees: копия ${w.sessionId} защищена (агент мог ещё работать) — не трогаем`); continue; }
      if (cleanupWorktree(w.sessionId).ok) console.log(`worktrees: копия ${w.sessionId} без сессии — удалена`);
      else { releaseWorktreeSlot(w.sessionId); console.log(`worktrees: копия ${w.sessionId} занята процессом — слот освобождён, папка удалится позже`); }
    }
    purgeTrash();
  } catch (e) { console.log(`worktrees: cleanup failed — ${String(e)}`); }

  // v2: восстановление планов, роёв, fusion и машин из данных
  try { loadPlans(); loadSwarms(); loadFusions(); loadMachines(); loadSecrets(); invalidateStatusCacheSafe(); } catch { /* данные недоступны */ }

  // v4: прогреваем кэш статусов агентов в фоне — панель «Настройка» откроется мгновенно
  import("./setup/manager")
    .then((m) => { void m.allAgentStatusesAsync(); })
    .catch(() => { /* менеджер недоступен — кэш прогреется при первом запросе */ });

  // v2: периодический проход TTL-чистки (раз в час) — копии не копятся вечно
  setInterval(() => {
    try { cleanupStale(WORKTREE_TTL_MS); } catch { /* не критично */ }
  }, 3600_000).unref?.();
})();
const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  idleTimeout: 255,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    // изменяющий запрос — кэш чтения git (ветка/HEAD) больше не верен
    if (req.method !== "GET" && req.method !== "HEAD") clearGitReadCache();

    // --- rate-limit (V2-6.1): общий потолок /api/* с IP, если включен env'ом ---
    if (apiLimiter.enabled && path.startsWith("/api/")) {
      const rl = apiLimiter.check(clientIp(req));
      if (!rl.ok) {
        return json({ error: "rate limited", retryAfterMs: rl.retryAfterMs }, 429,
          { "retry-after": String(Math.ceil(rl.retryAfterMs / 1000)) });
      }
    }

    // Публичные ручки: статика (UI должен загрузиться) и авторизация.
    // /sw.js — service worker из корня (PWA, V2-4.2): браузер запрашивает его
    // без наших заголовков авторизации, поэтому он обязан быть публичным.
    const isStaticPath = (p: string) => req.method === "GET" && (p === "/" || p.startsWith("/web/") || p === "/sw.js");
    const isPublic =
      isStaticPath(path) ||
      path === "/api/auth/check" || path === "/api/auth/login" || path === "/api/auth/logout";

    // V5: CORS-preflight для orch-mobile (PWA на другом порту). Разрешаем
    // методы API и Bearer-заголовок; origin не проверяем — защита на токене.
    if (req.method === "OPTIONS" && path.startsWith("/api/")) {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
          "access-control-allow-headers": "content-type,authorization",
          "access-control-max-age": "600",
        },
      });
    }
    if (!isPublic && !authed(req)) return json({ error: "unauthorized" }, 401);

    // --- статика и события ---
    if (isStaticPath(path)) {
      return (await serveStatic(path)) ?? new Response("not found", { status: 404 });
    }
    // --- авторизация (работает всегда: UI должен уметь показать экран входа) ---
    if (req.method === "GET" && path === "/api/auth/check") {
      return json({ required: !!TOKEN, authenticated: authed(req) });
    }
    if (req.method === "POST" && path === "/api/auth/login") {
      // V2-6.1: защита от перебора токена — не чаще N попыток с IP в окне
      const rl = loginLimiter.check(clientIp(req));
      if (!rl.ok) {
        return json({ error: "too many attempts", retryAfterMs: rl.retryAfterMs }, 429,
          { "retry-after": String(Math.ceil(rl.retryAfterMs / 1000)) });
      }
      const b = await body(req);
      if (!TOKEN || !safeEqual(String(b.token ?? ""), TOKEN)) return json({ error: "invalid token" }, 401);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "set-cookie": `dirigo_token=${TOKEN}; Path=/; SameSite=Strict; HttpOnly`,
        },
      });
    }
    if (req.method === "POST" && path === "/api/auth/logout") {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "set-cookie": "dirigo_token=; Path=/; Max-Age=0",
        },
      });
    }
    if (req.method === "GET" && path === "/api/events") return sseStream();
    if (req.method === "GET" && path === "/api/pair") {
      // V5-15: QR-подключение orch-mobile к демону. Payload несёт host+token
      // (токен — только если задан). orch-mobile сканирует → автозаполнение
      // экрана «Связь». Токен в QR осознанно: QR показывается локально
      // (loopback/tunnel), пользователь сам решает, кому его показывать.
      const hostHeader = req.headers.get("host") ?? `127.0.0.1:${PORT}`;
      const proto = hostHeader.includes("trycloudflare") ? "https" : "http";
      const pairPayload = JSON.stringify({
        v: 1,
        host: `${proto}://${hostHeader}`,
        token: TOKEN ?? "",
      });
      return new Response(qrSvg(pairPayload, { scale: 6 }), {
        headers: { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "no-store" },
      });
    }
    if (req.method === "GET" && path === "/api/health") {
      await bootReady; // не отвечаем, пока не дочищены сироты после рестарта
      const all = sessions.list();
      const perAgent: Record<string, { running: number; queued: number; done: number; error: number; stopped: number; total: number }> = {};
      for (const a of AGENTS) perAgent[a.id] = { running: 0, queued: 0, done: 0, error: 0, stopped: 0, total: 0 };
      for (const s of all) {
        const p = perAgent[s.agentId];
        if (!p) continue;
        p[s.status]++;
        p.total++;
      }
      // v2: метрики копий, проверок и планов — для ops-наблюдения (V2-6.5)
      const copies = listWorktrees();
      const copiesWithSession = copies.filter((w) => sessions.get(w.sessionId));
      const withChecks = all.filter((s) => s.checks?.length);
      const failedChecks = withChecks.filter((s) => s.checks!.at(-1)!.ok === false).length;
      const plans = listPlans();
      const epics = plans.flatMap((p) => p.epics);
      // Платформенные возможности: PTY — нативный модуль, его может не быть.
      const { ptyStatus } = await import("./agents/pty");
      const pty = await ptyStatus();
      return json({
        ok: true, version: APP_VERSION,
        platform: { os: process.platform, arch: process.arch, bun: Bun.version },
        capabilities: { pty: pty.available, ptyReason: pty.reason },
        agents: AGENTS.map((a) => a.id),
        running: all.filter((s) => s.status === "running").length,
        perAgent,
        worktrees: {
          active: copiesWithSession.length,
          orphans: copies.length - copiesWithSession.length,
          max: MAX_WORKTREES,
          bytes: worktreeDiskBytes(),
        },
        checks: { sessions: withChecks.length, failing: failedChecks },
        processes: { live: liveProcesses(), max: MAX_AGENT_PROCESSES },
        orchestrator: { plans: plans.length, epics: epics.length, applied: epics.filter((e) => e.status === "applied").length, conflicts: epics.filter((e) => e.status === "conflict").length },
        uptimeMs: Date.now() - BOOT_AT,
      });
    }

    // --- агенты ---
    if (req.method === "GET" && path === "/api/agents") {
      // Продукт не предлагает того, что не запустится: к описанию агента
      // прикладываем реальную доступность каждого режима (бинарь на диске,
      // ACP-мост, собран ли node-pty) вместе с причиной и способом починить.
      const { allAvailability } = await import("./agents/availability");
      const avail = await allAvailability();
      const availById = new Map(avail.map((a) => [a.id, a]));
      return json(AGENTS.map((a) => ({
        id: a.id, label: a.label, kind: a.kind, hint: a.hint,
        sessionFlag: a.sessionFlag ?? null,
        defaultModel: a.defaultModel ?? null,
        models: a.models ?? [],
        modelCommand: a.modelCommand ?? null,
        modelsCommand: a.modelsCommand?.length ? true : false,
        reasoning: a.reasoning ?? [],
        modelFlag: a.modelFlag ?? null,
        reasoningFlag: a.reasoningFlag ?? null,
        acp: a.acp ? { defaultModel: a.acp.defaultModel ?? null } : null,
    pty: a.ptyCommand ? { label: a.ptyCommand.label, hint: a.ptyCommand.hint ?? null } : null,
        web: a.web ? {
          label: a.web.label, hint: a.web.hint, relayOnly: !!a.web.relayOnly,
          externalOnly: !!a.web.externalOnly, externalUrl: a.web.externalUrl,
          canLaunchApp: !!a.web.launchApp,
        } : null,
        availability: availById.get(a.id) ?? null,
        installed: availById.get(a.id)?.installed ?? false,
        usable: availById.get(a.id)?.usable ?? false,
      })));
    }

    // Реальные модели агента: спрашиваем его же командой (kilo — 314 штук,
    // opencode — 10), с кэшем. Зашитый список в коде протухает и показывает
    // модели, которых у пользователя нет.
    {
      const mm = path.match(/^\/api\/agents\/([\w-]+)\/models$/);
      if (mm && req.method === "GET") {
        const { listModels } = await import("./agents/models");
        const force = new URL(req.url).searchParams.get("refresh") === "1";
        return json(await listModels(mm[1]!, force));
      }
    }

    // --- проекты ---
    if (req.method === "GET" && path === "/api/projects") return json(projects.list());
    if (req.method === "POST" && path === "/api/projects") {
      const b = await body(req);
      if (!b.name || !b.path) return json({ error: "name and path required" }, 400);
      // Путь — абсолютный; папку создаём всегда (форма это обещает): раньше без
      // галочки git проект заводился на несуществующий путь и сессии падали.
      if (!isAbsolute(String(b.path))) return json({ error: "укажите полный путь к папке (например C:\\Users\\вы\\project или /home/вы/project)" }, 400);
      try { if (!existsSync(String(b.path))) mkdirSync(String(b.path), { recursive: true }); }
      catch (e) { return json({ error: `папку не создать: ${String((e as Error).message ?? e)}` }, 400); }
      if (!statSync(String(b.path)).isDirectory()) return json({ error: "по этому пути лежит файл, а не папка" }, 400);
      // V5.1/V1.1-F8: создание проекта с инициализацией git — ветка main и
      // автор (dirigo <dirigo@localhost>), либо подхват существующего репо.
      // Начальный коммит делаем сразу: без HEAD git worktree add невозможен,
      // поэтому «копия проекта» будет полноценной (а не файловым снимком).
      if (b.gitInit === true) {
        try {
          mkdirSync(String(b.path), { recursive: true });
          if (!existsSync(join(String(b.path), ".git"))) {
            const cfg: [string, string][] = [["user.name", "dirigo"], ["user.email", "dirigo@localhost"]];
            execFileSync("git", ["init", "-b", "main", "."], { cwd: String(b.path), windowsHide: true });
            for (const [k, v] of cfg) execFileSync("git", ["config", k, v], { cwd: String(b.path), windowsHide: true });
            // README + .gitignore, чтобы проект не был пустым и не мусорил
            const readme = join(String(b.path), "README.md");
            if (!existsSync(readme)) writeFileSync(readme, `# ${String(b.name)}\n\nПроект под управлением Dirigo.\n`, "utf8");
            const gi = join(String(b.path), ".gitignore");
            if (!existsSync(gi)) writeFileSync(gi, "node_modules/\ndist/\n.env\n.DS_Store\n", "utf8");
            execFileSync("git", ["add", "-A"], { cwd: String(b.path), windowsHide: true });
            execFileSync("git", ["commit", "-m", "init: проект создан через Dirigo"], { cwd: String(b.path), windowsHide: true });
          }
        } catch (e) {
          return json({ error: `git init failed: ${String(e)}` }, 500);
        }
      }
      return json(await projects.add(String(b.name), String(b.path)), 201);
    }
    if (req.method === "DELETE" && path.startsWith("/api/projects/")) {
      await projects.remove(path.split("/").pop()!);
      return json({ ok: true });
    }
    // Собственный git проекта (кнопка в правой панели): для папки без git или
    // внутри чужого репо — чтобы коммиты шли в репозиторий проекта, а не туда.
    {
      const gi = path.match(/^\/api\/projects\/([\w-]+)\/git-init$/);
      if (req.method === "POST" && gi) {
        const project = projects.get(gi[1]!);
        if (!project) return json({ error: "project not found" }, 404);
        const r = initProjectRepo(project.path);
        return json(r, r.ok ? 200 : 409);
      }
    }
    // архив проектов (V5.2): визуальный перенос в «Архив» без удаления
    const projAct = path.match(/^\/api\/projects\/([\w-]+)\/(archive|unarchive)$/);
    if (req.method === "POST" && projAct) {
      const project = projects.get(projAct[1]!);
      if (!project) return json({ error: "project not found" }, 404);
      await projects.archive(project.id, projAct[2] === "archive");
      return json({ ok: true, archived: projAct[2] === "archive" });
    }
    // выбор папки проекта (V5.2): список подкаталогов для диалога
    if (req.method === "GET" && path === "/api/fs/dirs") {
      const dir = String(url.searchParams.get("path") ?? "");
      // V6.13: дефолт — король проекта демона (не process.cwd: у запущенного через
      // schtasks/службу демона cwd = system32, и браузер папок показывал мусор)
      // Старт — домашняя папка пользователя: у установленного продукта корень
      // демона — это ~/.dirigo/current, и выбор проекта начинался в самой программе.
      const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
      const serverRoot = home && existsSync(home) ? home : new URL(`./../`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
      const root = existsSync(dir) && statSync(dir).isDirectory() ? dir : serverRoot;
      try {
        const entries = readdirSync(root, { withFileTypes: true })
          .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !["node_modules", "$RECYCLE.BIN", "System Volume Information"].includes(e.name))
          .map((e) => ({ name: e.name, path: join(root, e.name) }))
          .sort((a, b) => a.name.localeCompare(b.name))
          .slice(0, 60);
        const parent = dirname(root);
        return json({ ok: true, path: root, parent: parent !== root ? parent : null, dirs: entries });
      } catch (e) { return json({ ok: false, error: String(e), path: root, dirs: [] }); }
    }

    // --- сессии ---
    if (req.method === "GET" && path === "/api/sessions") {
      return json(sessions.list().map((s) => ({ ...s, messages: messages.list(s.id).length })));
    }
        if (req.method === "POST" && path === "/api/sessions") {
          const b = await body(req);
          const def = getAgent(String(b.agentId));
          if (!def) return json({ error: "unknown agent" }, 400);
          const pid = String(b.projectId ?? "");
          if (!projects.get(pid)) return json({ error: "unknown project" }, 400);
          const promptRaw = String(b.prompt ?? "").trim();
          // Шлюз PII: проверяем ДО создания сессии. В режиме block задача наружу
          // не уходит вовсе; в redact агент получает текст с заменами.
          const { scanText } = await import("./policy");
          const promptScan = scanText(promptRaw);
          if (promptScan.blocked) {
            return json({
              error: "задача содержит персональные данные и заблокирована политикой",
              policy: { mode: promptScan.mode, findings: promptScan.findings.length, kinds: Object.keys(promptScan.byKind), summary: promptScan.summary },
            }, 409);
          }
          const prompt = promptScan.text;
          const modeRaw = String(b.mode ?? "cli");
          // UI шлёт «acp» — на сервере это persistent-режим (ACP-протокол).
          const norm = modeRaw === "acp" ? "persistent" : modeRaw;
          const mode = norm === "web" ? "web" : norm === "persistent" ? "persistent" : norm === "pty" ? "pty" : "cli";
          // V6-4: тип работы (solo|swarm|fusion|orchestrator) и уровень рассуждений
          const workMode = ["solo", "swarm", "fusion", "orchestrator"].includes(String(b.type))
            ? (String(b.type) as "solo" | "swarm" | "fusion" | "orchestrator")
            : "solo";
          // Уровень — только из списка самого агента; пусто = как настроено в агенте.
          const reasoning = (def.reasoning ?? []).includes(String(b.reasoning)) ? String(b.reasoning) : undefined;
          if (mode === "cli" && !prompt) return json({ error: "prompt required" }, 400);
          // Единая проверка «можно ли это вообще запустить» — ДО создания сессии.
          // Иначе в доске появляется карточка со словом «Error» и без объяснений:
          // раньше так падали ACP без моста, web без бинаря и PTY без node-pty.
          const { canStart } = await import("./agents/availability");
          const login = b.login === true;
          const gate = await canStart(def.id, mode);
          if (!gate.available) {
            return json({
              error: gate.reason ?? `режим «${gate.label}» недоступен для ${gate.agentLabel}`,
              reason: gate.reason ?? null,
              fix: gate.fix ?? null,
              agent: def.id,
              agentLabel: gate.agentLabel,
              mode,
              modeLabel: gate.label,
            }, 409);
          }
          // V2-6.2: лимит одновременно живых агентских процессов
          if (liveProcesses() >= MAX_AGENT_PROCESSES) {
            return json({ error: `лимит запущенных агентов (${MAX_AGENT_PROCESSES}) исчерпан — останови лишние сессии` }, 409);
          }

      // v2: копия проекта (git-worktree либо файловая копия) — агент работает только в ней
      const wantCopy = b.worktree === true || b.worktree === "git" || b.worktree === "copy";
      if (wantCopy) {
        const active = listWorktrees().length;
        if (active >= MAX_WORKTREES) return json({ error: `лимит копий (${MAX_WORKTREES}) исчерпан — примени или удали существующие` }, 409);
        const project = projects.get(pid)!;
        const requested: WorktreeKind | undefined = b.worktree === "git" || b.worktree === "copy" ? b.worktree : undefined;
        // git-worktree возможен ТОЛЬКО из корня репо. Подкаталог монорепо (git
        // работает, но это не корень) → файловая копия (copy): worktree родителя
        // создать нельзя. diff/status/commit для копии идут через родительский репо.
        let repoInfo = gitRepoInfo(project.path);
        // Проект вне любого git: делаем ему собственный репозиторий (снимок
        // состояния) — копия станет git-worktree с честным диффом и коммитами.
        if (!repoInfo.insideWorkTree && b.worktree !== "copy") {
          const ini = initProjectRepo(project.path);
          if (ini.ok) repoInfo = gitRepoInfo(project.path);
        }
        const wtKind: WorktreeKind = requested ?? (repoInfo.isRoot ? "git" : "copy");
        const wtId = uid("ses");
        try {
          const wt = createWorktree(wtId, project.path, wtKind);
          const created = await sessions.add({
        id: wtId,
        projectId: pid,
        agentId: def.id,
        title: sessionTitleFor(mode, def, project.name, prompt, login, b.title) + " [копия]",
        prompt: mode === "web" ? def.web!.label : prompt,
        mode,
        persistent: mode === "persistent" ? true : undefined,
        loginSession: login ? true : undefined,
        model: b.model ? String(b.model) : undefined,
        workMode,
        reasoning,
        worktree: { kind: wt.kind, path: wt.path, baseRef: wt.baseRef, createdAt: wt.createdAt },
        restorePoint: {
          kind: wt.kind === "git" ? "git-base" : "copy-snapshot",
          ref: wt.baseRef,
          note: wt.kind === "git" ? `base ${wt.baseRef?.slice(0, 8)}` : "снимок файлов проекта",
          createdAt: wt.createdAt,
        },
      });
      // старт уже созданной сессии-копии (id сессии = каталог data/work)
      await openProvenance(created, prompt, promptScan);
      startSessionByMode(created, prompt, b.model ? String(b.model) : undefined);
      if (workMode !== "solo") startWorkMode(created.id, workMode, prompt).catch(() => {});
      return json(created, 201);
        } catch (e) {
          cleanupWorktree(wtId); // частично созданная копия не остаётся в реестре
          return json({ error: `копия не создана: ${String(e)}` }, 500);
        }
      }

      const s = await sessions.add({
        id: uid("ses"),
        projectId: pid,
        agentId: def.id,
        title: sessionTitleFor(mode, def, projects.get(pid)?.name ?? "", prompt, login, b.title),
        prompt: mode === "web" ? def.web!.label : prompt,
        mode,
        persistent: mode === "persistent" ? true : undefined,
        loginSession: login ? true : undefined,
        model: b.model ? String(b.model) : undefined,
        workMode,
        reasoning,
      });
      await openProvenance(s, prompt, promptScan);
      startSessionByMode(s, prompt, b.model ? String(b.model) : undefined);
      // V6-4: не-solo типы поднимают соответствующую подсистему (доскап/рой/fusion)
      if (workMode !== "solo") startWorkMode(s.id, workMode, prompt).catch(() => {});
      return json(s, 201);
    }
    // Цвета темы пульта для терминалов агентов (OSC 10/11, COLORFGBG): агент
    // выбирает по ним светлую или тёмную палитру своего TUI.
    if (req.method === "POST" && path === "/api/terminal-theme") {
      const b = await body(req);
      return json({ ok: true, colors: runner.setTermColors({ fg: b.fg, bg: b.bg }) });
    }
    const sesMatch = path.match(/^\/api\/sessions\/([\w-]+)(\/(stop|messages|log|restart|rename|launch|continue|pair|qr|input|screen|stream|resize|paste|model|choice|archive|unarchive|diff|apply|revert|worktree|checks|review|resolve|acceptance|verify-command|git|target|files|file|evidence))?$/);
    if (sesMatch) {
      const id = sesMatch[1]!;
      const s = sessions.get(id);
      if (!s) return json({ error: "session not found" }, 404);

      if (req.method === "GET" && !sesMatch[2]) {
        // Живой диалог: ход работы агента, его модели и команды — для ленты и «/model»
        const live = s.mode === "persistent" || s.persistent
          ? { activity: runner.getAcpActivity(id), acpModels: runner.acpModelOptions(id), acpCommands: runner.acpCommands(id) }
          : {};
        return json({ ...s, messages: messages.list(id), ...live });
      }
      if (req.method === "POST" && sesMatch[2] === "/model") {
        // Смена модели в живом диалоге (ACP configOption «model»)
        const b = await body(req);
        const model = String(b.model ?? "").trim();
        if (!model) return json({ error: "model required" }, 400);
        if (!(s.mode === "persistent" || s.persistent)) return json({ error: "модель меняется так только в живом диалоге" }, 409);
        try {
          await runner.setAcpModel(id, model);
          await messages.add(id, "system", `Модель: ${model}`);
          return json({ ok: true, model });
        } catch (e) { return json({ error: String((e as Error).message ?? e) }, 409); }
      }

      // журнал происхождения и пакеты по этой сессии
      if (req.method === "GET" && sesMatch[2] === "/evidence") {
        const { readLedger, verifyLedger, listPacks } = await import("./provenance");
        return json({
          ok: true,
          ledger: readLedger(id),
          verdict: verifyLedger(id),
          packs: listPacks().filter((p) => p.sessionId === id),
        });
      }
      if (req.method === "POST" && (sesMatch[2] === "/archive" || sesMatch[2] === "/unarchive")) {
        // Архив сессии вернулся как отдельное действие: удалять ради уборки
        // списка неправильно — вместе с сессией уходят журнал и доказательства.
        const on = sesMatch[2] === "/archive";
        if (on && runner.isRunning(id)) await runner.stopSession(id).catch(() => {});
        await sessions.setArchived(id, on);
        return json({ ok: true, archived: on });
      }
      if (req.method === "DELETE" && !sesMatch[2]) {
        // Живой диалог гасится своим путём: stopSession его не трогал, и
        // ACP-процесс агента жил дальше, держа папку копии.
        //
        // F_VER-5: сперва гасим агента, ПОТОМ решаем, жив ли он. opencode
        // отдаёт ход своему сервису: клиент умирает с кодом 0, а работа идёт
        // дальше. Снос копии в такой момент отнимает у живого агента рабочую
        // папку («Working directory does not exist»), правки теряются.
        //
        // Порядок важен: решение — ПОСЛЕ остановки. Пока агент жив, его копию
        // удалять нельзя; остановили — решили по следам работы: если копию
        // трогали после ухода клиента (работа в сервисе), копию бережём.
        if (s.persistent || s.mode === "persistent") await runner.stopPersistent(id).catch(() => {});
        await runner.stopSession(id);
        const alive = sessionAlive(id, { session: s, hasLiveProcess: runner.isRunning(id) });
        await sessions.remove(id);
        if (alive.alive) {
          // Рабочую папку бережём: снос — когда агент замолчит (deferCopyRemoval).
          cleanupWorktreeSoon(id, undefined, Date.now() + ACTIVITY_WINDOW_MS);
          return json({ ok: true, kept: `рабочая папка сохранена: ${alive.reason}` });
        }
        cleanupWorktreeSoon(id); // копия проекта живёт ровно до жизни сессии
        return json({ ok: true });
      }
      if (req.method === "POST" && sesMatch[2] === "/stop") {
        if (s.persistent) await runner.stopPersistent(id);
        else await runner.stopSession(id);
        return json({ ok: true });
      }
      if (req.method === "POST" && sesMatch[2] === "/restart") {
        if (s.persistent) {
          await runner.stopPersistent(id);
          // stopPersistent ставит «stopped», а startPersistent не поднимает статус
          // поверх stopped (защита от стопа во время рукопожатия) — без этого
          // рестарт отвечал ok, агент подключался, а сессия навсегда оставалась
          // «остановлена». Рестарт — явное «запусти снова».
          await sessions.setStatus(id, "queued");
          await runner.startPersistent(id, { resume: true }).catch(async (e) => {
            await appendLog(id, `[dirigo] ${String(e)}\n`);
            await sessions.setStatus(id, "error", -1);
          });
        } else {
          await runner.restartSession(id);
        }
        return json({ ok: true });
      }
      if (req.method === "POST" && sesMatch[2] === "/launch") {
        // «Открыть» для desktop-агентов (zcode): запускаем само приложение
        const def = getAgent(s.agentId);
        const appPath = def?.web?.launchApp;
        if (!appPath) return json({ error: "agent has no desktop app" }, 400);
        try {
          Bun.spawn([appPath], { detached: true, stdio: ["ignore", "ignore", "ignore"] });
          await appendLog(id, `[dirigo] приложение запущено: ${appPath}\n`);
          return json({ ok: true });
        } catch (e) {
          return json({ error: String(e) }, 500);
        }
      }
      if (req.method === "POST" && sesMatch[2] === "/continue") {
        // продолжение диалога агента: новая сессия с тем же внешним session id
        if (s.mode !== "cli") return json({ error: "продолжение доступно только для cli-сессий" }, 409);
        if (!s.externalRef) return json({ error: "у сессии нет ID сессии агента — продолжение недоступно" }, 409);
        const b = await body(req);
        const prompt = String(b.prompt ?? "").trim();
        if (!prompt) return json({ error: "prompt required" }, 400);
        const def = getAgent(s.agentId);
        if (!def?.sessionFlag) return json({ error: "агент не умеет продолжать сессии" }, 409);
        const ns = await sessions.add({
          id: uid("ses"),
          projectId: s.projectId,
          agentId: s.agentId,
          title: `↻ ${s.title}`.slice(0, 120),
          prompt,
          mode: "cli",
          externalRef: s.externalRef,
        });
        await messages.add(ns.id, "user", prompt);
        runner.runSession(ns.id, prompt).catch(async (e) => {
          await appendLog(ns.id, `[dirigo] ${String(e)}\n`);
          await sessions.setStatus(ns.id, "error", -1);
        });
        return json(ns, 201);
      }
      if (req.method === "POST" && sesMatch[2] === "/pair") {
        // одноразовая ссылка подключения к панели агента (для телефона/другого браузера)
        const def = getAgent(s.agentId);
        const user = def?.web?.authTokenUser;
        if (!s.webUrl || !s.webToken || !user) {
          return json({ error: "агент не поддерживает одноразовые ссылки" }, 409);
        }
        const basic = Buffer.from(`${user}:${s.webToken}`, "utf8").toString("base64");
        const r = await fetch(`${s.webUrl}/api/pair`, {
          method: "POST",
          headers: { Authorization: `Basic ${basic}` },
        });
        if (!r.ok) return json({ error: `agent pair failed: ${r.status}` }, 502);
        const j = await r.json() as { code?: string };
        if (!j.code) return json({ error: "no code in agent response" }, 502);
        const pairUrl = `${s.webUrl}/auth/connect/${j.code}`;
        await sessions.setPairUrl(id, pairUrl);
        return json({ ok: true, pairUrl, expiresIn: j.expires_in ?? 300, qr: qrSvg(pairUrl, { scale: 4 }) });
      }
      if (req.method === "GET" && sesMatch[2] === "/qr") {
        // QR-pairing (V2-4.4): SVG одноразовой/текущей ссылки подключения к панели агента
        const def = getAgent(s.agentId);
        const user = def?.web?.authTokenUser;
        if (!s.webUrl || !s.webToken || !user) {
          return json({ error: "агент не поддерживает ссылки подключения" }, 409);
        }
        const url = s.webPairUrl ?? (() => {
          const basic = Buffer.from(`${user}:${s.webToken}`, "utf8").toString("base64");
          const hostHeader = req.headers.get("host") ?? `127.0.0.1:${PORT}`;
          return `http://${hostHeader}/?auth_token=${encodeURIComponent(basic)}`;
        })();
        return new Response(qrSvg(url, { scale: 6 }), { headers: { "content-type": "image/svg+xml; charset=utf-8" } });
      }
      if (req.method === "PATCH" && sesMatch[2] === "/rename") {
        const b = await body(req);
        await sessions.setTitle(id, String(b.title ?? ""));
        return json({ ok: true });
      }
      // --- v2: диффы и применение изменений копии ---
      if (req.method === "GET" && sesMatch[2] === "/worktree") {
        const wt = getWorktree(id) ?? (s.worktree ? { ...s.worktree, sessionId: id, projectPath: projects.get(s.projectId)?.path ?? "" } : null);
        const stats = wt ? worktreeStats(id) : null;
        return json({ worktree: wt, stats });
      }
      if (req.method === "POST" && sesMatch[2] === "/verify-command") {
        // V3-4: per-session команда проверок (override детекта)
        const b = await body(req);
        await sessions.setVerifyCommand(id, b.command === null || b.command === "" ? null : String(b.command ?? ""));
        return json({ ok: true, verifyCommand: sessions.get(id)?.verifyCommand ?? null });
      }
      if (req.method === "GET" && sesMatch[2] === "/target") {
        // V9: цель панели управления — копия (worktree) или бранч (прямое дерево)
        const cur = sessions.get(id);
        if (!cur) return json({ error: "session not found" }, 404);
        const project = projects.get(cur.projectId);
        const target = withGitReadCache(() => resolveTarget(project?.path ?? process.cwd(), cur.worktree?.path));
        // Может ли панель коммитить: только в собственный репозиторий проекта.
        // Файловая копия (без git) сравнивается с ТЕКУЩИМ проектом — панель это говорит.
        const pinfo = withGitReadCache(() => gitRepoInfo(project?.path ?? ""));
        return json({
          ...target, describe: describeTarget(target),
          copyKind: cur.worktree?.kind ?? null,
          projectId: project?.id ?? null,
          projectOwnRepo: pinfo.isRoot,
          projectInsideRepo: pinfo.insideWorkTree && !pinfo.isRoot ? pinfo.repoRoot ?? null : null,
        });
      }
      if (req.method === "GET" && sesMatch[2] === "/diff") {
        // V9: дифф работает и для копии, и для прямого бранча проекта
        const cur = sessions.get(id);
        if (!cur) return json({ error: "session not found" }, 404);
        const project = projects.get(cur.projectId);
        const target = withGitReadCache(() => resolveTarget(project?.path ?? process.cwd(), cur.worktree?.path));
        try {
          const d = target.kind === "branch" ? branchDiff(target) : diffWorktree(id);
          // Находки шлюза по добавленным строкам — сразу в панели «Изменения»,
          // до коммита: раньше о них можно было узнать только из журнала.
          let pii: Record<string, { kinds: Record<string, number>; lines: number[] }> = {};
          try {
            const { scanChanges } = await import("./policy");
            const sc = scanChanges(d.files);
            for (const f of sc.files) pii[f.path] = { kinds: f.kinds, lines: f.lines };
          } catch { pii = {}; }
          return json({ ok: true, target: target.kind, branch: target.branch, ...d, pii });
        } catch (e) {
          return json({ ok: false, error: String(e), files: [], added: 0, deleted: 0 }, 404);
        }
      }
      if (req.method === "POST" && sesMatch[2] === "/apply") {
        // «Применить в проект»: b.confirmed=true обязателен (необратимая операция).
        // b.force=true — второе подтверждение для диффов с массовыми удалениями.
        const b = await body(req);
        if (b.confirmed !== true) return json({ ok: false, error: "требуется подтверждение (confirmed=true)" }, 400);
        try {
          // дифф снимаем ДО применения: после него копия и проект совпадут
          let changedFiles: Array<{ path: string; added?: number; deleted?: number; status?: string }> = [];
          let fullDiff: import("./worktrees").DiffFile[] = [];
          try {
            fullDiff = diffWorktree(id).files;
            changedFiles = fullDiff.map((f) => ({
              path: f.path, added: f.added, deleted: f.deleted, status: f.status,
            }));
          } catch { /* дифф не снялся — пакет соберётся без списка файлов */ }
          const denied = await policyGateChanges(id, "apply", fullDiff, b.allowPii === true);
          if (denied) return denied;

          const r = applyWorktree(id, b.force === true);
          if (r.ok) await appendLog(id, `[dirigo] применение в проект: ${r.detail}\n`);
          if (r.ok) {
            const pack = await writeEvidence(id, {
              approvedBy: String(b.approvedBy ?? "").trim() || undefined,
              files: changedFiles,
              applied: r.applied,
              removed: r.removed,
            });
            if (pack) return json({ ...r, evidence: { packId: pack.packId, ledgerHead: pack.ledger.head, checks: pack.checks.length, returnedToAgent: pack.returnedToAgent } }, 200);
          }
          return json(r, r.ok ? 200 : 409);
        } catch (e) {
          return json({ ok: false, error: String(e), applied: [], removed: [], conflicts: [] }, 500);
        }
      }
      if (req.method === "POST" && sesMatch[2] === "/revert") {
        // «Вернуть как было»: сброс копии к точке возврата
        try {
          const r = revertWorktree(id);
          if (r.ok) await appendLog(id, `[dirigo] копия возвращена к точке восстановления: ${r.detail}\n`);
          if (r.ok) {
            try {
              const { record } = await import("./provenance");
              record(id, "change.reverted", { detail: r.detail });
            } catch { /* см. комментарий у writeEvidence */ }
          }
          return json(r, r.ok ? 200 : 404);
        } catch (e) {
          return json({ ok: false, error: String(e) }, 500);
        }
      }
      if (req.method === "POST" && sesMatch[2] === "/git") {
        // Git-кнопки (V2-1.5/V9): commit/push/pr/merge/status. merge требует confirmed.
        // V9: без копии те же кнопки работают в прямом дереве проекта (branch-mode).
        const b = await body(req);
        const action = String(b.action ?? "status");
        try {
          if (action === "status") {
            const cur0 = sessions.get(id);
            const project0 = projects.get(cur0?.projectId ?? "");
            const target0 = resolveTarget(project0?.path ?? process.cwd(), cur0?.worktree?.path);
            return json({
              ok: true, action, target: target0.kind, branch: target0.branch, ahead: target0.ahead,
              path: target0.path,
              detail: target0.kind === "copy" ? "копия сессии" : `прямое дерево: ${target0.branch ?? "?"}`,
            });
          }
          // Коммит/push/merge — только в СОБСТВЕННЫЙ репозиторий проекта. Папка
          // внутри чужого репо (например, projects/* внутри репо самого пульта)
          // иначе коммитилась бы в него; без git — честный отказ с кнопкой.
          {
            const cur1 = sessions.get(id);
            const proj1 = projects.get(cur1?.projectId ?? "");
            const info1 = gitRepoInfo(proj1?.path ?? "");
            if (!info1.isRoot) {
              return json({
                ok: false, action, needsGitInit: true, projectId: proj1?.id ?? null,
                detail: info1.insideWorkTree
                  ? `Проект лежит внутри другого репозитория (${info1.repoRoot}) — коммит ушёл бы туда. Создайте отдельный репозиторий проекта`
                  : "У проекта нет git — создайте репозиторий проекта (кнопка «Создать git проекта»)",
              }, 409);
            }
          }
          // Коммит фиксирует незакоммиченное — проверяем, что агент туда добавил.
          let commitFiles: import("./worktrees").DiffFile[] = [];
          let commitRepo: string | undefined;
          let commitDirect = false;
          if (action === "commit") {
            const cur2 = sessions.get(id);
            const proj2 = projects.get(cur2?.projectId ?? "");
            try {
              const t2 = resolveTarget(proj2?.path ?? process.cwd(), cur2?.worktree?.path);
              commitRepo = t2.path;
              commitDirect = t2.kind === "branch";
              commitFiles = t2.kind === "branch" ? branchDiff(t2).files : diffWorktree(id).files;
            } catch { /* нет диффа — нечего проверять */ }
            const denied = await policyGateChanges(id, "commit", commitFiles, b.allowPii === true);
            if (denied) return denied;
          }
          const r = gitAction(id, action, {
            message: b.message ? String(b.message) : undefined,
            remote: b.remote ? String(b.remote) : undefined,
            into: b.into ? String(b.into) : undefined,
            base: b.base ? String(b.base) : undefined,
            title: b.title ? String(b.title) : undefined,
            confirmed: b.confirmed === true,
          });
          if (r.ok) await appendLog(id, `[dirigo] git ${r.action}: ${r.detail}\n`);
          // Сессия без копии (агент правит проект напрямую): «Применить» нет, и
          // решение человека — это коммит. Раньше такие сессии на экране
          // «Доказательства» не появлялись вовсе. У копии пакет — при «Применить».
          if (r.ok && action === "commit" && commitDirect && commitFiles.length) {
            const pack = await writeEvidence(id, {
              event: "committed", repoPath: commitRepo, commitMessage: b.message ? String(b.message) : undefined,
              approvedBy: String(b.approvedBy ?? "").trim() || undefined,
              files: commitFiles.map((f) => ({ path: f.path, added: f.added, deleted: f.deleted, status: f.status })),
              applied: commitFiles.map((f) => f.path),
            });
            if (pack) return json({ ...r, evidence: { packId: pack.packId, ledgerHead: pack.ledger.head, pii: pack.policy } }, 200);
          }
          return json(r, r.ok ? 200 : 409);
        } catch (e) {
          return json({ ok: false, error: String(e), action }, 500);
        }
      }
      if (req.method === "POST" && sesMatch[2] === "/resolve") {
        // Конфликт-резолютор (V2-3.5): агент мержит файлы копии с боевыми версиями
        const b = await body(req);
        const files = Array.isArray(b.files) ? b.files.map((x: unknown) => String(x)) : undefined;
        try {
          const { resolveConflicts } = await import("./resolver");
          const r = await resolveConflicts(id, files, b.agentId ? String(b.agentId) : undefined);
          if (r.ok) await appendLog(id, `[dirigo] резолв: ${r.detail}\n`);
          return json(r, r.ok ? 200 : 409);
        } catch (e) {
          return json({ ok: false, error: String(e), resolved: [], skipped: [] }, 500);
        }
      }
      if (req.method === "POST" && sesMatch[2] === "/review") {
        // Замечание ревью к строке диффа: comment — сохранить, rework — отправить агенту,
        // accept — отметить принятым (одно или пакетом noteIds), send — все pending разом,
        // send-selected — выбранные пакетом.
        const b = await body(req);
        const action = String(b.action ?? "comment");
        const noteIdsOf = (raw: unknown): string[] => Array.isArray(raw) ? raw.map((x) => String(x)) : [];
        if (action === "send") {
          const pending = (s.reviewNotes ?? []).filter((n) => n.status === "pending");
          if (!pending.length) return json({ ok: false, error: "нет замечаний в ожидании" }, 400);
          const prompt = reviewPrompt(pending);
          const how = await reviewFollowUp(id, prompt);
          await sessions.setReviewNotesBulk(id, pending.map((n) => n.id), { status: "sent", result: how });
          await appendLog(id, `[dirigo] ревью: ${pending.length} замечаний отправлено агенту (${how})\n`);
          return json({ ok: true, sent: pending.length, how });
        }
        if (action === "send-selected") {
          const wanted = new Set(noteIdsOf(b.noteIds));
          const picked = (s.reviewNotes ?? []).filter((n) => wanted.has(n.id) && n.status === "pending");
          if (!picked.length) return json({ ok: false, error: "нет выбранных замечаний в ожидании" }, 400);
          const how = await reviewFollowUp(id, reviewPrompt(picked));
          await sessions.setReviewNotesBulk(id, picked.map((n) => n.id), { status: "sent", result: how });
          await appendLog(id, `[dirigo] ревью: пакет из ${picked.length} замечаний → агенту (${how})\n`);
          return json({ ok: true, sent: picked.length, how });
        }
        if (action === "accept") {
          // пакетный или одиночный accept
          const wanted = new Set([...noteIdsOf(b.noteIds), ...(b.noteId ? [String(b.noteId)] : [])]);
          const picked = (s.reviewNotes ?? []).filter((n) => wanted.has(n.id));
          if (!picked.length) return json({ ok: false, error: "замечания не найдены" }, 404);
          await sessions.setReviewNotesBulk(id, picked.map((n) => n.id), { status: "accepted" });
          return json({ ok: true, accepted: picked.length });
        }
        if (action === "comment" || action === "rework") {
          const file = String(b.file ?? "");
          const text = String(b.text ?? "").trim();
          if (!file || !text) return json({ error: "file и text обязательны" }, 400);
          const note = await sessions.addReviewNote(id, {
            file,
            lineNo: b.lineNo == null ? null : Number(b.lineNo),
            side: b.side === "old" ? "old" : "new",
            text,
          });
          if (!note) return json({ error: "session not found" }, 404);
          if (action === "rework") {
            const how = await reviewFollowUp(id, reviewPrompt([note]));
            await sessions.setReviewNote(id, note.id, { status: "sent", result: how });
          }
          return json({ ok: true, note }, 201);
        }
        return json({ error: `неизвестное действие: ${action}` }, 400);
      }
      if (req.method === "POST" && sesMatch[2] === "/acceptance") {
        // Приёмочные проверки на естественном языке (V2-2.5)
        const b = await body(req);
        const criteria = Array.isArray(b.criteria) ? b.criteria.map((x: unknown) => String(x)) : [];
        try {
          const { runAcceptance } = await import("./acceptance");
          const r = await runAcceptance(id, criteria, b.agentId ? String(b.agentId) : undefined);
          return json(r, r.ok ? 200 : 400);
        } catch (e) {
          return json({ ok: false, error: String(e) }, 500);
        }
      }
      if (req.method === "POST" && sesMatch[2] === "/checks") {
        // V3-5/V9: прогон проверок — в копии или прямо в проекте (branch-mode)
        const cur0 = sessions.get(id);
        const project0 = projects.get(cur0?.projectId ?? "");
        const target0 = resolveTarget(project0?.path ?? process.cwd(), cur0?.worktree?.path);
        try {
        const report = await runChecksOverride(target0.path, cur0?.verifyCommand);
          await sessions.addCheck(id, {
            command: report.source ? `${report.source}: ${report.outcomes.map((o) => o.command).join("; ")}` : "проверки не обнаружены",
            ok: report.ok,
            output: report.outcomes.map((o) => `$ ${o.command}\n${o.output}`).join("\n\n") || "нет команд проверок в проекте",
            durationMs: report.outcomes.reduce((a, o) => a + o.durationMs, 0),
            at: Date.now(),
          });
          await appendLog(id, `[dirigo] проверки (ручной прогон): ${!report.source ? "не обнаружены" : report.ok ? "пройдены" : "упали"}\n`);
          return json({ ok: report.ok, ...report });
        } catch (e) {
          return json({ ok: false, error: String(e) }, 500);
        }
      }
      if (req.method === "GET" && sesMatch[2] === "/log") {
        const n = Number(new URL(req.url).searchParams.get("n") ?? 200);
        return json({ lines: await readLogTail(id, n) });
      }
      if (req.method === "GET" && sesMatch[2] === "/screen") {
        // Экран терминала: разобранная сетка вместо сырых ESC-последовательностей.
        // Без этого режим «Терминал (TUI)» нечем показать — пользователь видел
        // в ленте кашу из управляющих кодов и считал, что агент молчит.
        const { ptyScreen, ptyScreenText, detectAuthPrompt } = await import("./agents/runner");
        const screen = ptyScreen(id);
        if (!screen) return json({ error: "у сессии нет терминала" }, 404);
        // Вошёл ли пользователь: экран перестал просить авторизацию — снимаем метку.
        const auth = detectAuthPrompt(ptyScreenText(id));
        const cur = sessions.get(id);
        if (!auth && cur?.authPrompt) await sessions.setAuthPrompt(id, null);
        // Ссылка входа появляется не сразу (у freebuff — только после Enter),
        // поэтому метку обновляем, а не ставим один раз.
        else if (auth && (!cur?.authPrompt || cur.authPrompt.url !== auth.url || cur.authPrompt.label !== auth.label)) {
          await sessions.setAuthPrompt(id, auth);
        }
        // Модель агента: TUI печатает её в подвале экрана. Достаём оттуда —
        // у таких агентов её неоткуда взять, кроме как с их собственного экрана.
        const { screenModelForTest: screenModel } = await import("./server-model");
        const model = screenModel(ptyScreenText(id));
        // meta=1: пульт рисует экран из потока /stream, ему нужны только метки
        if (url.searchParams.get("meta") === "1") return json({ auth: auth ?? null, model, live: runner.isRunning(id), rev: screen.rev });
        return json({ ...screen, auth: auth ?? null, model, live: runner.isRunning(id) });
      }
      if (req.method === "GET" && sesMatch[2] === "/stream") {
        // Живой экран терминала для xterm.js в пульте: снимок кадра + куски вывода.
        return sseOf((send) => runner.ptyAttach(id, send));
      }
      if (req.method === "POST" && sesMatch[2] === "/resize") {
        const b = await body(req);
        const size = runner.ptyResize(id, Number(b.cols), Number(b.rows));
        return size ? json({ ok: true, ...size }) : json({ error: "у сессии нет терминала" }, 404);
      }
      if (req.method === "POST" && sesMatch[2] === "/paste") {
        // Картинка из буфера обмена → файл в папке сессии, путь — агенту.
        // Путь к картинке понимают все TUI-агенты (claude, opencode, freebuff…),
        // а сам буфер обмена браузера агенту на этой машине недоступен.
        const b = await body(req);
        const mime = String(b.mime ?? "");
        const ext = ({ "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" } as Record<string, string>)[mime];
        if (!ext) return json({ error: "поддерживаются png, jpeg, gif, webp" }, 400);
        const data = Buffer.from(String(b.data ?? ""), "base64");
        if (!data.length || data.length > 20 * 1024 * 1024) return json({ error: "картинка пустая или больше 20 МБ" }, 400);
        const { sessionCwd: sessionCwdFor } = await import("./agents/runner");
        const dir = join(sessionCwdFor(s), ".dirigo", "paste");
        mkdirSync(dir, { recursive: true });
        // .dirigo/ не должен попадать в дифф и коммиты проекта
        const gi = join(sessionCwdFor(s), ".dirigo", ".gitignore");
        if (!existsSync(gi)) writeFileSync(gi, "*\n", "utf8");
        const file = join(dir, `paste-${new Date().toISOString().replace(/[:.]/g, "-")}.${ext}`);
        writeFileSync(file, data);
        return json({ ok: true, path: file });
      }
      if (req.method === "POST" && sesMatch[2] === "/choice") {
        // Ответ человека на вопрос агента: без него агент стоит и ждёт.
        const b = await body(req);
        const choiceId = String(b.choiceId ?? s.pendingChoice?.id ?? "");
        const optionId = String(b.optionId ?? "");
        if (!choiceId || !optionId) return json({ error: "нужны choiceId и optionId" }, 400);
        const ok = runner.answerChoice(choiceId, optionId);
        return ok ? json({ ok: true }, 202) : json({ error: "вопрос уже закрыт или истёк" }, 409);
      }
      if (req.method === "POST" && sesMatch[2] === "/input") {
        // PTY-терминал: строка ввода → в процесс агента
        const b = await body(req);
        const text = String(b.text ?? "");
        if (!text) return json({ error: "empty input" }, 400);
        const ok = b.raw ? runner.writePty(id, text) : await runner.writePtyLine(id, text);
        return ok ? json({ ok: true }, 202) : json({ error: "not a pty session" }, 409);
      }
      if (req.method === "POST" && sesMatch[2] === "/messages") {
        const b = await body(req);
        const rawText = String(b.text ?? "").trim();
        if (!rawText) return json({ error: "empty message" }, 400);
        // Шлюз PII и для продолжения разговора: раньше проверялась только первая
        // задача, а всё, что писали агенту потом, уходило без проверки.
        const { scanText } = await import("./policy");
        const msgScan = scanText(rawText);
        if (msgScan.mode !== "off" && msgScan.findings.length) {
          try {
            const { record } = await import("./provenance");
            record(id, "policy.scan", {
              target: "message", mode: msgScan.mode, findings: msgScan.findings.length,
              kinds: Object.keys(msgScan.byKind), blocked: msgScan.blocked,
              redacted: msgScan.mode === "redact",
            });
          } catch { /* журнал не мешает разговору */ }
        }
        if (msgScan.blocked) {
          return json({
            error: "сообщение содержит персональные данные и заблокировано политикой",
            policy: { mode: msgScan.mode, findings: msgScan.findings.length, kinds: Object.keys(msgScan.byKind), summary: msgScan.summary },
          }, 409);
        }
        const text = msgScan.text;
        if (s.mode === "pty") {
          // Агент задал вопрос-выбор (доверие к папке, тема): Enter из нижнего
          // поля выбрал бы подсвеченный пункт — у Claude это «No, exit», и
          // агент закрывался. Сначала ответ в терминале, потом текст.
          const { ptyScreenText, detectAuthPrompt } = await import("./agents/runner");
          if (detectAuthPrompt(ptyScreenText(id))?.kind === "choice") {
            return json({ error: "Агент ждёт ответа на вопрос в терминале — ответьте в окне терминала (стрелки и Enter), затем отправьте текст", reason: "choice" }, 409);
          }
          // Набор + Enter двумя записями (см. writePtyLine): одной записью TUI
          // считает это вставкой, и сообщение остаётся висеть в поле ввода.
          const ok = await runner.writePtyLine(id, text);
          await messages.add(id, "user", text);
          return ok ? json({ ok: true }, 202) : json({ error: "pty not running" }, 409);
        }
        if (s.persistent) {
          // «/model» — команда пульта, если сам агент такой не объявил: раньше
          // она уходила модели обычным текстом, и ход заканчивался тишиной.
          const mm = /^\/model(?:\s+(.+))?$/i.exec(text);
          if (mm && !runner.acpCommands(id).some((c) => c.name.replace(/^\//, "").toLowerCase() === "model")) {
            const want = mm[1]?.trim();
            const opts = runner.acpModelOptions(id);
            if (!want) return json({ error: "выберите модель", pickModel: true, models: opts?.options ?? [], current: opts?.current ?? null }, 409);
            try {
              await runner.setAcpModel(id, want);
              await messages.add(id, "system", `Модель: ${want}`);
              return json({ ok: true, model: want });
            } catch (e) { return json({ error: String((e as Error).message ?? e) }, 409); }
          }
          runner.sendPersistentMessage(id, text).catch(async (e) => {
            await appendLog(id, `[dirigo] ${String(e)}\n`);
            await sessions.setStatus(id, "error", -1, {
              reason: `Сообщение не доставлено: ${String(e).replace(/^Error:\s*/, "").slice(0, 160)}`,
              fix: "Нажмите «Перезапустить» — соединение поднимется заново, текст сохранён в ленте",
            });
          });
          return json({ ok: true }, 202);
        }
        await messages.add(id, "user", text);
        runner.runSession(id, text).catch(async (e) => {
          await appendLog(id, `[dirigo] ${String(e)}\n`);
          await sessions.setStatus(id, "error", -1);
        });
        return json({ ok: true }, 202);
      }
    }

    // --- v2: плагины-data (V2-5.3): панели и ссылки из plugins.json ---
    if (req.method === "GET" && path === "/api/plugins") {
      return json(loadPlugins());
    }

    // --- v2: usage по сессиям (V2-6.4) ---
    if (req.method === "GET" && path === "/api/usage") {
      const { collectAllUsage, collectUsage } = await import("./usage");
      const qs = new URL(req.url).searchParams;
      const only = qs.get("session");
      if (only) {
        const u = await collectUsage(only);
        return u ? json({ total: u.tokens, sessions: [u] }) : json({ error: "сессия не найдена" }, 404);
      }
      const u = await collectAllUsage();
      return json({ total: u.total, sessions: u.sessions });
    }

    // --- F-V6-2 (FBA): Компаньон — настройки, диалог, LLM через providers.json ---
    if (req.method === "GET" && path === "/api/companion") {
      const { companionInfo } = await import("./companion");
      return json(companionInfo());
    }
    if (req.method === "DELETE" && path === "/api/companion") {
      const { companion } = await import("./store");
      await companion.clear();
      return json({ ok: true });
    }
    if (req.method === "POST" && path === "/api/companion") {
      const b = await body(req);
      if (b.action === "clear") {
        const { companion } = await import("./store");
        await companion.clear();
        return json({ ok: true });
      }
      if (b.settings && typeof b.settings === "object") {
        const { companion } = await import("./store");
        const state = await companion.setSettings(b.settings as Record<string, unknown>);
        return json({ ok: true, settings: state.settings });
      }
      const text = String(b.text ?? "").trim();
      if (text) {
        const { companionReply, companionInfo } = await import("./companion");
        const { reply, source } = await companionReply(text);
        return json({ ok: true, reply, source, info: companionInfo() });
      }
      return json({ error: "пустой запрос (settings | text | action=clear)" }, 400);
    }

    // --- v2: provisioning агентов (V3-5): статусы, установка, ключи ---
    if (req.method === "GET" && path === "/api/setup/agents") {
      const { allAgentStatusesAsync } = await import("./setup/manager");
      const { allAvailability } = await import("./agents/availability");
      const [items, avail] = await Promise.all([allAgentStatusesAsync(), allAvailability()]);
      const byId = new Map(avail.map((a) => [a.id, a]));
      // V4-2: статус ключа берём из secrets (а не из env демона)
      // Плюс разбивка по режимам: экран установки — единственное место, где
      // видно, ЧЕГО не хватает именно для PTY или ACP, а не «агента вообще».
      return json(items.map((a) => ({
        ...(a.envVar ? { ...a, keySet: hasSecret(a.envVar) } : a),
        modes: byId.get(a.id)?.modes ?? [],
      })));
    }
    if (req.method === "GET" && path === "/api/setup/keys") {
      return json(secretsSummary());
    }
    if (req.method === "POST" && path === "/api/setup/keys") {
      const b = await body(req);
      const envVar = String(b.envVar ?? "").trim();
      const value = String(b.value ?? "");
      if (!envVar) return json({ error: "envVar обязателен" }, 400);
      if (!value) return json({ error: "пустое значение — используй DELETE для удаления" }, 400);
      setSecret(envVar, value);
      await invalidateStatusCacheSafe();
      try { (await import("./agents/models")).invalidateModels(); } catch { /* модуль не поднят */ }
      await appendLog("setup", `[dirigo] ключ ${envVar} сохранён (через UI)\n`);
      return json({ ok: true }, 201);
    }
    if (req.method === "DELETE" && /^\/api\/setup\/keys\/[\w-]+$/.test(path)) {
      const envVar = decodeURIComponent(path.split("/").pop()!);
      deleteSecret(envVar);
      await invalidateStatusCacheSafe();
      return json({ ok: true });
    }
    if (req.method === "GET" && /^\/api\/setup\/env\/jobs\/[\w-]+$/.test(path)) {
      const id = path.split("/").pop()!;
      const j = listEnvJobs().find((x) => x.id === id);
      return j ? json(j) : json({ error: "задача не найдена" }, 404);
    }
    if (req.method === "POST" && path === "/api/setup/install") {
      const b = await body(req);
      const id = String(b.agentId ?? "");
      try {
        const { enqueueInstall } = await import("./setup/manager");
        const job = enqueueInstall(id);
        await appendLog("setup", `[dirigo] установка агента ${id} — задача ${job.id}\n`);
        return json(job, 202);
      } catch (e) {
        return json({ ok: false, error: String(e) }, 400);
      }
    }
    if (req.method === "GET" && path === "/api/setup/jobs") {
      const { listJobs } = await import("./setup/manager");
      return json(listJobs());
    }
    const setupJobMatch = path.match(/^\/api\/setup\/jobs\/([\w-]+)$/);
    if (setupJobMatch && req.method === "GET") {
      const { getJob } = await import("./setup/manager");
      const job = getJob(setupJobMatch[1]!);
      return job ? json(job) : json({ error: "задача не найдена" }, 404);
    }

    // --- v2: машины и SSH-туннели (V3-2) ---
    if (req.method === "GET" && path === "/api/machines") {
      return json(listMachines());
    }
    if (req.method === "POST" && path === "/api/machines") {
      const b = await body(req);
      const host = String(b.host ?? "").trim();
      const user = String(b.user ?? "").trim();
      if (!host || !user) return json({ error: "host и user обязательны" }, 400);
      const m = addMachine({
        name: String(b.name ?? `${user}@${host}`).slice(0, 80),
        host, user,
        port: b.port ? Number(b.port) : undefined,
        identity: b.identity ? String(b.identity) : undefined,
        daemonPort: b.daemonPort ? Number(b.daemonPort) : 7271,
        localPort: b.localPort ? Number(b.localPort) : undefined,
        proxy: b.proxy ? String(b.proxy) : undefined,
      });
      return json(m, 201);
    }
    const machineMatch = path.match(/^\/api\/machines\/([\w-]+)\/(probe|tunnel|deploy|delete)$/);
    if (machineMatch) {
      const m = getMachineSafe(machineMatch[1]!);
      if (!m) return json({ error: "машина не найдена" }, 404);
      if (req.method === "POST" && machineMatch[2] === "probe") {
        const r = await probeMachine(m.id);
        return json(r, r.ok ? 200 : 409);
      }
      if (req.method === "POST" && machineMatch[2] === "tunnel") {
        const t = openTunnel(m.id);
        return "pid" in t ? json({ ok: true, ...t }) : json({ ok: false, error: t.error }, 409);
      }
      if (req.method === "POST" && machineMatch[2] === "deploy") {
        // Деплой демона на машину (V3-1). Тело: {port?, targetDir?, engines?, installBun?, proxy?, dryRun?}
        const b = await body(req);
        const r = await deployDaemon(
          { host: m.host, user: m.user, port: m.port, identity: m.identity, proxy: m.proxy },
          {
            port: m.daemonPort, targetDir: b.targetDir ? String(b.targetDir) : undefined,
            engines: Array.isArray(b.engines) ? b.engines.map((x: unknown) => String(x)) : undefined,
            installBun: b.installBun !== false, proxy: b.proxy ? String(b.proxy) : m.proxy,
            dryRun: b.dryRun === true,
          },
        );
        return json(r, r.ok ? 200 : 409);
      }
      if (req.method === "POST" && machineMatch[2] === "delete") {
        return json({ ok: removeMachine(m.id) });
      }
      return json({ error: "метод не поддержан" }, 405);
    }

    // --- v2: cloudflare quick tunnel (V3-3) ---
    if (req.method === "GET" && path === "/api/tunnel") {
      return json({ ...tunnelInfo(), cloudflared: cloudflaredAvailable() });
    }
    if (req.method === "POST" && path === "/api/tunnel") {
      const b = await body(req);
      const action = String(b.action ?? "start");
      if (action === "stop") return json(stopTunnel());
      const r = await startTunnel(b.port ? Number(b.port) : Number(process.env.PORT ?? 7271));
      return json({ ...r, cloudflared: true }, r.running ? 200 : 409);
    }

    // --- v2: среда первого запуска (V4-1): проба Bun/git/npm + установка ---
    if (req.method === "GET" && path === "/api/setup/env") {
      const which = (n: string) => !!Bun.which(n);
      return json({
        bun: { ok: which("bun"), path: Bun.which("bun") ?? null, version: bunVersion() },
        git: { ok: which("git"), path: Bun.which("git") ?? null },
        npm: { ok: which("npm"), path: Bun.which("npm") ?? null },
        ssh: { ok: which("ssh"), path: Bun.which("ssh") ?? null },
        cloudflared: { ok: which("cloudflared"), path: Bun.which("cloudflared") ?? null },
        os: process.platform,
      });
    }
    if (req.method === "POST" && path === "/api/setup/env") {
      // Установка окружения через UI (V4-1): bun / cloudflared. Джоб с логом.
      const b = await body(req);
      const what = String(b.what ?? "bun");
      const job = enqueueEnvJob(what);
      return json(job, 202);
    }

    // --- библиотека скиллов (V2-5.4) ---
    if (req.method === "GET" && path === "/api/skills") {
      const q = new URL(req.url).searchParams.get("q");
      if (q && q.trim()) {
        const { searchSkills } = await import("./skills");
        return json(searchSkills(q.trim()));
      }
      return json(listSkills().map(({ path, ...meta }) => meta));
    }
    if (req.method === "GET" && /^\/api\/skills\/[\w-]+$/.test(path)) {
      const text = readSkill(path.split("/").pop()!);
      return text ? json({ ok: true, text }) : json({ error: "скилл не найден" }, 404);
    }

    // --- v2: режим Orchestrator — планы и эпики ---
    if (req.method === "GET" && path === "/api/plans") {
      return json(listPlans().map(planSummary));
    }
    if (req.method === "POST" && path === "/api/plans") {
      const b = await body(req);
      const goal = String(b.goal ?? "").trim();
      const epics = Array.isArray(b.epics) ? b.epics : [];
      const agentId = String(b.agentId ?? "");
      if (!goal || !epics.length) return json({ error: "goal и epics обязательны" }, 400);
      if (!getAgent(agentId) || !AGENTS.some((a) => a.id === agentId)) return json({ error: "неизвестный агент" }, 400);
      const pid = String(b.projectId ?? "");
      if (!projects.get(pid)) return json({ error: "проект не найден" }, 400);
      const plan = createPlan({
        goal, projectId: pid, agentId,
        verifierAgentId: b.verifierAgentId ? String(b.verifierAgentId) : undefined,
        epics: epics.map((e: any) => ({
          title: String(e.title ?? e ?? ""),
          criteria: Array.isArray(e.criteria) ? e.criteria.map((c: unknown) => String(c)) : [],
        })),
      });
      return json(getPlan(plan.id), 201);
    }
    const planMatch = path.match(/^\/api\/plans\/([\w-]+)(\/(start|epics\/([\w-]+)(\/(verify|apply))?|apply-all))?$/);
    if (planMatch) {
      const planId = planMatch[1]!;
      const plan = getPlan(planId);
      if (!plan) return json({ error: "план не найден" }, 404);
      if (req.method === "GET" && !planMatch[2]) return json(plan);
      if (req.method === "DELETE" && !planMatch[2]) {
        deletePlan(planId);
        return json({ ok: true });
      }
      if (req.method === "PATCH" && !planMatch[2]) {
        const b = await body(req);
        const patch: Record<string, unknown> = {};
        if (typeof b.goal === "string") patch.goal = String(b.goal);
        if (typeof b.verifierAgentId === "string") patch.verifierAgentId = String(b.verifierAgentId);
        return json(updatePlan(planId, patch));
      }
      if (req.method === "POST" && planMatch[2] === "/start") {
        const r = await startPlan(planId);
        return json(r, r.ok ? 200 : 409);
      }
      if (req.method === "POST" && planMatch[2] === "/apply-all") {
        const r = applyPlan(planId);
        return json(r, r.ok ? 200 : r.applied ? 409 : 400);
      }
      // группы регекспа: [1] план, [4] id эпика, [6] verify|apply
      if (planMatch[4] && planMatch[6]) {
        const epic = getEpic(planId, planMatch[4]);
        if (!epic) return json({ error: "эпик не найден" }, 404);
        if (req.method === "POST" && planMatch[6] === "verify") {
          const r = await verifyEpic(planId, planMatch[4]);
          return json(r, r.ok ? 200 : 400);
        }
        if (req.method === "POST" && planMatch[6] === "apply") {
          const r = applyEpic(planId, planMatch[4]);
          return json(r, r.ok ? 200 : 409);
        }
      }
      return json({ error: "метод не поддержан" }, 405);
    }

    // --- v2: Companion-очередь (V2-4.3): команды с телефона/скриптов ---
    if (req.method === "POST" && path === "/api/queue") {
      const b = await body(req);
      const type = String(b.type ?? "");
      const allowed = ["run", "send", "apply", "diff", "checks", "revert", "approve", "rework"];
      if (!allowed.includes(type)) return json({ error: `unknown type: ${type}`, allowed }, 400);
      const item = enqueue(type as any, (b.payload ?? b) as Record<string, unknown>);
      trimQueue();
      return json(item, 202);
    }
    if (req.method === "GET" && path === "/api/queue") {
      return json(listQueue().slice().reverse());
    }
    const qMatch = path.match(/^\/api\/queue\/([\w-]+)$/);
    if (qMatch && req.method === "GET") {
      const item = getQueueItem(qMatch[1]!);
      return item ? json(item) : json({ error: "не найдено" }, 404);
    }

    // --- v2: режим Swarm — рои с участками ---
    if (req.method === "GET" && path === "/api/swarm") {
      return json(listSwarms().map(swarmSummary));
    }
    if (req.method === "POST" && path === "/api/swarm") {
      const b = await body(req);
      const title = String(b.title ?? b.goal ?? "").trim();
      const zones = Array.isArray(b.zones) ? b.zones.map((z: unknown) => String(z)) : [];
      const agentId = String(b.agentId ?? "");
      const pid = String(b.projectId ?? "");
      if (!title || !zones.length) return json({ error: "title и zones обязательны" }, 400);
      if (!AGENTS.some((a) => a.id === agentId)) return json({ error: "неизвестный агент" }, 400);
      if (!projects.get(pid)) return json({ error: "проект не найден" }, 400);
      const t = createSwarm({
        title, goal: String(b.goal ?? ""), projectId: pid, agentId,
        judgeAgentId: b.judgeAgentId ? String(b.judgeAgentId) : undefined,
        zones,
      });
      return json(getSwarm(t.id), 201);
    }
    const swarmMatch = path.match(/^\/api\/swarm\/([\w-]+)(\/(start|judge|apply-all|refresh|workers\/([\w-]+)\/(apply)))?$/);
    if (swarmMatch) {
      const swarmId = swarmMatch[1]!;
      const t = getSwarm(swarmId);
      if (!t) return json({ error: "рой не найден" }, 404);
      if (req.method === "GET" && !swarmMatch[2]) {
        return json({ ...t, feed: commonFeed(t) });
      }
      if (req.method === "DELETE" && !swarmMatch[2]) {
        deleteSwarm(swarmId);
        return json({ ok: true });
      }
      if (req.method === "POST" && swarmMatch[2] === "/start") {
        const r = await startSwarm(swarmId);
        return json(r, r.ok ? 200 : 409);
      }
      if (req.method === "POST" && swarmMatch[2] === "/judge") {
        const r = await judgeSwarm(swarmId);
        return json(r, r.ok ? 200 : 400);
      }
      if (req.method === "POST" && swarmMatch[2] === "/refresh") {
        const r = refreshSwarm(swarmId);
        return json(r, r.ok ? 200 : 404);
      }
      if (req.method === "POST" && swarmMatch[2] === "/apply-all") {
        const r = applySwarm(swarmId);
        return json(r, r.ok ? 200 : r.applied ? 409 : 400);
      }
      if (swarmMatch[4] && swarmMatch[5]) {
        const w = getWorker(swarmId, swarmMatch[4]);
        if (!w) return json({ error: "воркер не найден" }, 404);
        if (req.method === "POST" && swarmMatch[5] === "apply") {
          const r = applyWorker(swarmId, swarmMatch[4]);
          return json(r, r.ok ? 200 : 409);
        }
      }
      return json({ error: "метод не поддержан" }, 405);
    }

    // --- v2: режим Fusion — параллельные кандидаты + судья ---
    if (req.method === "GET" && path === "/api/fusion") {
      return json(listFusions().map(fusionSummary));
    }
    if (req.method === "POST" && path === "/api/fusion") {
      const b = await body(req);
      const title = String(b.title ?? b.prompt ?? "").trim();
      const agents = Array.isArray(b.agents) ? b.agents.map((x: unknown) => String(x)) : [];
      const pid = String(b.projectId ?? "");
      if (!title || agents.length < 2) return json({ error: "title/prompt и минимум 2 агента" }, 400);
      if (!agents.every((a) => AGENTS.some((x) => x.id === a))) return json({ error: "неизвестный агент в списке" }, 400);
      if (!projects.get(pid)) return json({ error: "проект не найден" }, 400);
      const r = createFusion({
        title, prompt: String(b.prompt ?? title), projectId: pid, agents,
        judgeAgentId: b.judgeAgentId ? String(b.judgeAgentId) : undefined,
      });
      return json(getFusion(r.id), 201);
    }
    const fusMatch = path.match(/^\/api\/fusion\/([\w-]+)(\/(start|judge|refresh|apply))?$/);
    if (fusMatch) {
      const fusId = fusMatch[1]!;
      const r = getFusion(fusId);
      if (!r) return json({ error: "fusion не найден" }, 404);
      if (req.method === "GET" && !fusMatch[2]) return json(r);
      if (req.method === "DELETE" && !fusMatch[2]) { deleteFusion(fusId); return json({ ok: true }); }
      if (req.method === "POST" && fusMatch[2] === "/start") {
        const res = await startFusion(fusId);
        return json(res, res.ok ? 200 : 409);
      }
      if (req.method === "POST" && fusMatch[2] === "/refresh") {
        const res = refreshFusion(fusId);
        return json(res, res.ok ? 200 : 404);
      }
      if (req.method === "POST" && fusMatch[2] === "/judge") {
        const res = await judgeFusion(fusId);
        return json(res, res.ok ? 200 : 400);
      }
      if (req.method === "POST" && fusMatch[2] === "/apply") {
        const res = applyFusion(fusId);
        return json(res, res.ok ? 200 : 409);
      }
      return json({ error: "метод не поддержан" }, 405);
    }

    // --- бэкап: экспорт/импорт ---
    if (req.method === "GET" && path === "/api/worktrees") {
      const active = new Set(listWorktrees().map((w) => w.sessionId));
      return json({
        max: MAX_WORKTREES,
        ttlHours: Math.round(WORKTREE_TTL_MS / 3600_000),
        items: listWorktrees().map((w) => ({
          ...w,
          session: sessions.get(w.sessionId) ? { title: sessions.get(w.sessionId)!.title, status: sessions.get(w.sessionId)!.status } : null,
          stats: worktreeStats(w.sessionId),
        })),
        active: active.size,
      });
    }
    if (req.method === "POST" && path === "/api/worktrees/cleanup") {
      // Ручная чистка: устаревшие по TTL + осиротевшие копии
      const stale = cleanupStale(WORKTREE_TTL_MS);
      const orphans = listWorktrees().filter((w) => !sessions.get(w.sessionId));
      // Честный счёт: раньше сирота считалась «удалённой», даже если её папку
      // держал процесс, — и продолжала занимать слот лимита копий.
      let removedOrphans = 0, released = 0;
      for (const w of orphans) {
        // Защищённая копия (F_VER-5): агент мог ещё работать — не сносим.
        if (isProtectedCopy(w)) continue;
        if (cleanupWorktree(w.sessionId).ok) { removedOrphans++; continue; }
        if (releaseWorktreeSlot(w.sessionId)) released++;
      }
      const pending = purgeTrash();
      scheduleTrashPurge();
      return json({
        ok: true, removed: stale.length + removedOrphans, released, pending,
        stale: stale.length, orphans: orphans.length, remaining: listWorktrees().length,
        detail: released ? `${released} копи(й) держит процесс: слот освобождён, папка удалится, когда процесс её отпустит` : "",
      });
    }
    if (req.method === "GET" && path === "/api/export") {
      const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
      return new Response(JSON.stringify(exportData(), null, 2), {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "content-disposition": `attachment; filename="dirigo-backup-${stamp}.json"`,
        },
      });
    }
    if (req.method === "POST" && path === "/api/import") {
      const b = await body(req);
      if (!b || typeof b !== "object" || !Array.isArray(b.sessions ?? b.projects)) {
        return json({ error: "expected backup json with projects/sessions arrays" }, 400);
      }
      const mode = b.mode === "replace" ? "replace" : "merge";
      const counts = await importData(b, mode);
      return json({ ok: true, mode, ...counts });
    }

    // ── История версий проекта: дерево/ветки/теги/время ──
    if (req.method === "GET" && path === "/api/history") {
      const projectPath = String(url.searchParams.get("project") ?? "");
      if (!projectPath) return json({ error: "project required" }, 400);
      try {
        const { historyOf } = await import("./history");
        return json(historyOf(projectPath));
      } catch (e) { return json({ ok: false, error: String(e) }, 500); }
    }
    if (req.method === "POST" && path === "/api/history/restore") {
      const b = await body(req);
      const projectPath = String(b.project ?? "");
      const sha = String(b.sha ?? "");
      if (!projectPath || !sha) return json({ error: "project and sha required" }, 400);
      try {
        const { restoreTo } = await import("./history");
        return json(restoreTo(projectPath, sha));
      } catch (e) { return json({ ok: false, error: String(e) }, 500); }
    }
    // ── V6-5: терминалы ──
    if (req.method === "POST" && path === "/api/terminals") {
      const b = await body(req);
      const cur = b.sessionId ? sessions.get(String(b.sessionId)) : null;
      const project = cur ? projects.get(cur.projectId) : null;
      const dir = String(b.dir ?? cur?.worktree?.path ?? project?.path ?? process.cwd());
      try {
        const t = await createTerminal(dir);
        return json({ ok: true, id: t.id, name: t.name, dir: t.dir, mode: t.mode }, 201);
      } catch (e) { return json({ ok: false, error: String(e) }, 500); }
    }
    if (req.method === "GET" && path === "/api/terminals") {
      return json({ ok: true, terminals: terminalsSummary() });
    }
    const termMatch = path.match(/^\/api\/terminals\/([\w-]+)(\/(input|kill|stream|resize))?$/);
    if (termMatch) {
      const id = termMatch[1]!;
      if (req.method === "DELETE") { killTerminal(id); return json({ ok: true }); }
      if (req.method === "GET" && termMatch[2] === "/stream") {
        // Живой экран терминала для xterm.js: снимок кадра + куски вывода.
        return sseOf((sendEv) => {
          const t = terminals.get(id);
          if (!t) return null;
          sendEv({ t: "init", cols: t.screen.cols, rows: t.screen.rows, data: t.screen.serialize(), live: t.alive });
          t.subs.add(sendEv);
          return () => { t.subs.delete(sendEv); };
        });
      }
      if (req.method === "POST" && termMatch[2] === "/resize") {
        const t = terminals.get(id);
        if (!t) return json({ error: "terminal not found" }, 404);
        const b = await body(req);
        const c = Math.max(20, Math.min(400, Math.floor(Number(b.cols) || 0)));
        const r = Math.max(5, Math.min(200, Math.floor(Number(b.rows) || 0)));
        if (t.handle.kind === "pty" && t.handle.resizable !== false && (t.screen.cols !== c || t.screen.rows !== r)) {
          try { t.handle.resize(c, r); } catch { /* закрыт */ }
          t.screen.resize(r, c);
          // кадр в новом размере — от демона (см. ptyResize у сессий агентов)
          const init = { t: "init", cols: t.screen.cols, rows: t.screen.rows, data: t.screen.serialize(), live: t.alive };
          for (const fn of t.subs) { try { fn(init); } catch { /* */ } }
        }
        return json({ ok: true, cols: t.screen.cols, rows: t.screen.rows });
      }
      if (req.method === "POST" && termMatch[2] === "/input") {
        const t = terminals.get(id);
        if (!t) return json({ error: "terminal not found" }, 404);
        const b = await body(req);
        const text = String(b.text ?? "");
        if (!text) return json({ error: "text required" }, 400);
        // raw: клавиши из эмулятора как есть (стрелки, Ctrl+C, Tab) — без \n
        if (b.raw === true && t.mode === "pty") {
          try { t.handle.write(text); } catch (e) { return json({ ok: false, error: String(e) }); }
          return json({ ok: true });
        }
        try {
          // В пайп-режиме нет эха: печатаем введённую строку сами, иначе в
          // окне терминала виден только вывод без самой команды.
          if (t.mode === "pipe") {
            const echo = "\u276f " + text.replace(/\n+$/, "") + "\n";
            emit({ type: "terminal.data", terminalId: id, chunk: echo } as BusEvent);
          }
          t.handle.write(text.endsWith("\n") ? text : text + "\n");
        } catch (e) { return json({ ok: false, error: String(e) }); }
        return json({ ok: true });
      }
      if (req.method === "POST" && termMatch[2] === "/kill") { killTerminal(id); return json({ ok: true }); }
    }
    // ── Шлюз персональных данных ──
    if (req.method === "GET" && path === "/api/policy") {
      const { loadPolicy } = await import("./policy");
      return json({ ok: true, policy: loadPolicy() });
    }
    if (req.method === "POST" && path === "/api/policy") {
      const { savePolicy } = await import("./policy");
      const b = await body(req);
      return json({ ok: true, policy: savePolicy(b as Record<string, unknown>) });
    }
    if (req.method === "POST" && path === "/api/policy/scan") {
      const { scanText, loadPolicy } = await import("./policy");
      const b = await body(req);
      const text = String(b.text ?? "");
      const cfg = loadPolicy();
      const r = scanText(text, b.mode ? { ...cfg, mode: String(b.mode) as import("./policy").PolicyMode } : cfg);
      // наружу — сводка и (для redact) очищенный текст, но не сами находки
      return json({
        ok: true, mode: r.mode, findings: r.findings.length, byKind: r.byKind,
        blocked: r.blocked, summary: r.summary,
        text: r.mode === "redact" ? r.text : undefined,
      });
    }

    // ── База знаний компании ──
    if (req.method === "GET" && path === "/api/knowledge") {
      const { loadKnowledge } = await import("./knowledge");
      const k = loadKnowledge();
      // ключ наружу не отдаём, только факт его наличия
      return json({ ok: true, knowledge: { ...k, apiKey: k.apiKey ? "set" : "" } });
    }
    if (req.method === "POST" && path === "/api/knowledge") {
      const { saveKnowledge } = await import("./knowledge");
      const b = await body(req);
      const k = saveKnowledge(b as Record<string, unknown>);
      return json({ ok: true, knowledge: { ...k, apiKey: k.apiKey ? "set" : "" } });
    }
    if (req.method === "POST" && path === "/api/knowledge/test") {
      const { loadKnowledge, pushEntry, isMcpUrl, testConnection } = await import("./knowledge");
      const cfg = loadKnowledge();
      // MCP (CoAlly): рукопожатие и список инструментов, без тестовых записей в базе
      if (isMcpUrl(cfg.url)) return json({ ok: true, result: await testConnection(cfg) });
      const probe = {
        schema: "dirigo.knowledge/1" as const,
        project: cfg.project, sessionId: "probe", title: "проверка связи с базой знаний",
        author: "dirigo", model: null,
        summary: "Тестовая запись: проверка доступности приёмника.",
        decisions: [], modules: [], checks: { total: 0, passed: 0, returnedToAgent: 0 },
        approvedBy: null, commit: null, evidencePackId: "probe", at: Date.now(),
      };
      return json({ ok: true, result: await pushEntry(probe, cfg) });
    }
    // Подключить базу знаний к агентам машины (их пользовательские конфиги MCP)
    if (path === "/api/knowledge/agents" && (req.method === "GET" || req.method === "POST")) {
      const { loadKnowledge, saveKnowledge, isMcpUrl } = await import("./knowledge");
      const am = await import("./agent-mcp");
      const k = loadKnowledge();
      const NAME = "coally-nexus";
      if (req.method === "GET") {
        const agents = am.mcpStatusForAgents(NAME);
        // подключали до 1.9.2 или вручную: сервер уже в конфигах — считаем подключённым
        // (иначе minimax в живом диалоге остался бы без базы знаний)
        if (!k.linkAgents && agents.some((a) => a.state === "present")) saveKnowledge({ linkAgents: true });
        return json({ ok: true, linked: k.linkAgents || agents.some((a) => a.state === "present"), agents });
      }
      const b = await body(req);
      if (b.action === "remove") {
        const res = await am.removeMcpFromAgents(NAME);
        saveKnowledge({ linkAgents: false });
        return json({ ok: !res.some((r) => r.state === "error"), agents: res });
      }
      if (!k.url || !isMcpUrl(k.url)) return json({ ok: false, error: "сначала укажите адрес CoAlly (…/mcp) и сохраните" }, 400);
      if (!k.apiKey) return json({ ok: false, error: "сначала укажите ключ CoAlly (cnx_…) и сохраните" }, 400);
      const res = await am.installMcpForAgents(am.coallySpec(k.url, k.apiKey, NAME));
      saveKnowledge({ linkAgents: true });
      return json({ ok: !res.some((r) => r.state === "error"), agents: res });
    }
    if (req.method === "POST" && path === "/api/knowledge/search") {
      const { searchKnowledge } = await import("./knowledge");
      const b = await body(req);
      const query = String(b.query ?? "").trim();
      if (!query) return json({ ok: false, detail: "пустой запрос" }, 400);
      // проект для поиска: явно выбранный, иначе — проект последней сессии
      const latest = [...sessions.list()].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
      const proj = projects.get(String(b.projectId ?? "")) ?? projects.get(latest?.projectId ?? "");
      return json(await searchKnowledge(query, undefined, 5, proj ? { name: proj.name, path: proj.path } : undefined));
    }

    // ── Доказательства происхождения изменений ──
    if (req.method === "GET" && path === "/api/evidence") {
      const { listPacks } = await import("./provenance");
      const from = Number(url.searchParams.get("from") ?? 0) || undefined;
      const to = Number(url.searchParams.get("to") ?? 0) || undefined;
      const packs = listPacks(from, to).map((p) => ({
        packId: p.packId, sessionId: p.sessionId, producedAt: p.producedAt,
        project: p.project.name ?? null, task: p.task.title ?? null,
        agent: p.agent.id ?? null, model: p.agent.model ?? null,
        checks: p.checks.length, checksOk: p.checks.filter((c) => c.ok).length,
        returnedToAgent: p.returnedToAgent, files: p.review.files.length,
        approvedBy: p.review.approvedBy ?? null, commit: p.result.commit,
        ledgerIntact: p.ledger.intact, signed: !!p.signature,
        pii: p.policy ?? null,
        trigger: p.result.trigger ?? "applied",
      }));
      return json({ ok: true, packs });
    }
    if (req.method === "GET" && path === "/api/evidence/key") {
      const { publicKeyInfo } = await import("./provenance");
      return json({ ok: true, ...publicKeyInfo() });
    }
    if (req.method === "GET" && path === "/api/evidence/bundle") {
      const { exportBundle } = await import("./provenance");
      const from = Number(url.searchParams.get("from") ?? 0) || undefined;
      const to = Number(url.searchParams.get("to") ?? 0) || undefined;
      const bundle = exportBundle(from, to);
      return new Response(JSON.stringify(bundle, null, 2), {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "content-disposition": `attachment; filename="dirigo-evidence-${new Date().toISOString().slice(0, 10)}.json"`,
          "cache-control": "no-store",
        },
      });
    }
    if (req.method === "GET" && path === "/api/evidence/verify") {
      const { verifyLedger, listPacks, verifySignature, publicKeyInfo } = await import("./provenance");
      const sid = String(url.searchParams.get("session") ?? "");
      if (sid) return json({ ok: true, session: sid, ledger: verifyLedger(sid) });
      // без параметра — сводка по всем пакетам
      const key = publicKeyInfo();
      const packs = listPacks();
      const bad = packs.filter((p) => !p.signature || !verifySignature({ ...p, signature: undefined }, p.signature, key.publicKeyPem));
      const broken = packs.filter((p) => !verifyLedger(p.sessionId).ok);
      return json({
        ok: bad.length === 0 && broken.length === 0,
        packs: packs.length,
        badSignatures: bad.map((p) => p.packId),
        brokenLedgers: broken.map((p) => p.sessionId),
      });
    }

    // ── V6: «Обзор» — агрегация по проектам для дашборда ──
    if (req.method === "GET" && path === "/api/overview") {
      try {
        const [{ overview }, { collectAllUsage }] = await Promise.all([
          import("./overview"),
          import("./usage"),
        ]);
        // токены сессий в сторe не хранятся — собираем из логов (usage.ts)
        // и подмешиваем в набор, иначе в «Обзоре» всегда 0 (баг 14.10).
        const usage = await collectAllUsage();
        const tokensById = new Map(usage.sessions.map((u) => [u.sessionId, u.tokens]));
        const list = sessions.list().map((s) => ({ ...s, tokens: tokensById.get(s.id) ?? 0 }));
        return json(overview(projects.list(), list));
      } catch (e) { return json({ ok: false, error: String(e) }); }
    }
    // V5.2: предпросмотр диффа коммита (История → «Показать дифф»)
    if (req.method === "GET" && path === "/api/history/commit") {
      const projectPath = String(url.searchParams.get("project") ?? "");
      const sha = String(url.searchParams.get("sha") ?? "");
      if (!projectPath || !sha) return json({ error: "project and sha required" }, 400);
      try {
        const { commitDiff } = await import("./history");
        return json(commitDiff(projectPath, sha));
      } catch (e) { return json({ ok: false, error: String(e), files: [] }, 500); }
    }
    // ── V5: дерево файлов и содержимое (правая панель клона) ──
    if (req.method === "GET" && sesMatch && sesMatch[2] === "/files") {
      const cur = sessions.get(sesMatch[1]);
      if (!cur) return json({ error: "session not found" }, 404);
      const project = projects.get(cur.projectId);
      const target = withGitReadCache(() => resolveTarget(project?.path ?? process.cwd(), cur.worktree?.path));
      try {
        const { listFiles } = await import("./files");
        return json({ ok: true, path: target.path, files: listFiles(target.path) });
      } catch (e) { return json({ ok: false, error: String(e), files: [] }, 500); }
    }
    if (req.method === "GET" && sesMatch && sesMatch[2] === "/file") {
      const cur = sessions.get(sesMatch[1]);
      if (!cur) return json({ error: "session not found" }, 404);
      const project = projects.get(cur.projectId);
      const target = resolveTarget(project?.path ?? process.cwd(), cur.worktree?.path);
      const rel = String(url.searchParams.get("path") ?? "");
      try {
        const { readProjectFile } = await import("./files");
        const r = readProjectFile(target.path, rel);
        if (!r) return json({ error: "not a file inside project" }, 400);
        return json({ ok: true, path: rel, content: r.content, truncated: r.truncated, size: r.size });
      } catch (e) { return json({ ok: false, error: String(e) }, 500); }
    }
    // ── V5-9: «Открыть в редакторе» — папка копии/проекта в system (без «Браузера») ──
    if (req.method === "POST" && path === "/api/open-editor") {
      try {
        const b = await body(req);
        const cur = b.sessionId ? sessions.get(String(b.sessionId)) : null;
        let dir = "";
        if (cur) {
          const project = projects.get(cur.projectId);
          dir = cur.worktree?.path ?? project?.path ?? "";
        }
        if (!dir) return json({ ok: false, detail: "откройте сессию или добавьте проект" });
        const { openInEditor } = await import("./open-editor");
        const r = await openInEditor(dir);
        // 200 даже при ошибке открытия — UI покажет понятный тост, а не «HTTP 500»
        return json({ ...r, dir });
      } catch (e) { return json({ ok: false, error: String(e) }); }
    }

    return json({ error: "not found" }, 404);
  },
});

console.log(`dirigo listening on http://${HOST}:${PORT}`);
console.log(`agents: ${AGENTS.map((a) => a.id).join(", ")}`);
// тестовый демон гаснет вместе с тестом (DIRIGO_EXIT_WITH_PARENT) — см. parent-watch.ts
watchParent();
// Метка «это тот самый демон» (F_VER-7).
//
// Запуск e2e-cli поднимает СВОЕГО демона и должен убедиться, что отвечает
// именно он, а не тот, кто занял порт между проверкой и стартом. Прежняя
// проверка («в каталоге данных есть logs/») этого не доказывала: папку logs/
// создаёт store.ts при импорте — ДО попытки занять порт, то есть её
// создаёт и демон, которому порт не достался. Проверка проходила, и набор
// уходил работать с чужим демоном: создавал в нём проекты и сессии, а на
// уборке удалял сессию (сервер сносит копию проекта агента).
//
// Метка пишется ПОСЛЕ того, как порт занят: значит её создал именно тот
// демон, который слушает этот порт. Пишем её атомарно (tmp + rename) —
// читатель не увидит наполовину записанный файл.
try {
  const mark = join(dataDir(), "daemon.json");
  const tmp = `${mark}.tmp`;
  writeFileSync(tmp, JSON.stringify({ pid: process.pid, port: PORT, host: HOST, startedAt: Date.now() }));
  renameSync(tmp, mark);
} catch { /* метка — не критична: демон работает и без неё */ }
// V1.1/F4: прогреть кэш статусов агентов — панель «Настройки → Агенты»
// отвечает мгновенно, а не висит на «проверяем…» (13 CLI --version ~3с).
import("./setup/manager").then((m) => m.warmStatusCache()).catch(() => { /* ручка посчитает сама */ });
// Вход в аккаунты агентов, которые сообщают его только командой (opencode 2.x,
// devin): к первому открытию диалога «Новая сессия» ответ уже готов.
import("./agents/availability").then((m) => m.warmAuthStatus()).catch(() => { /* решит файл учётных данных */ });
// Сироты агентов от прошлого запуска (демон гасили снаружи): хабы cline на
// наших копиях и зависшие сторожа freebuff. Без этого они копились и держали папки.
setTimeout(() => {
  // асинхронно: синхронный powershell при старте замораживал демон на секунды
  void Promise.all([import("./agents/daemons"), import("./worktrees")])
    .then(([d, w]) => d.sweepAgentOrphansAsync(w.workDir()))
    .then((n) => { if (n) console.log(`[dirigo] убрано сирот агентов от прошлого запуска: ${n}`); })
    .catch(() => { /* уборка не критична */ });
}, 3000);
