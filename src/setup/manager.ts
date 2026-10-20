// Dirigo — менеджер provisioning (V3-5).
//
// Локальный исполнитель рецептов: детект установленных агентов, очередь установки
// с прогрессом и пост-проверкой (--version), статусы для UI. Работает и как
// источник команд для удалённого деплоя (deploy.ts берёт тот же рецепт).

import { existsSync } from "node:fs";
import { appendLog } from "../store";
import { RECIPES, candidatePaths, currentOs, recipeFor, type AgentRecipe, type InstallStep, type Os } from "./recipes";
import { getAgent } from "../agents/registry";
import { authState } from "../agents/availability";

/** Вход в аккаунт агента: kilo/devin/opencode работают по OAuth без ключа. */
function signedIn(id: string): boolean {
  const def = getAgent(id);
  if (!def) return false;
  try { const a = authState(def); return a.known && a.signedIn; } catch { return false; }
}
/** Дополнить статус признаком входа (и не считать «нужен вход», если он есть). */
function withAuth(st: AgentStatus): AgentStatus {
  const si = signedIn(st.id);
  return { ...st, signedIn: si, state: st.state === "needs-auth" && si ? "installed" : st.state };
}

export type AgentState = "installed" | "missing" | "needs-auth" | "unknown";

export interface AgentStatus {
  id: string;
  label: string;
  state: AgentState;
  /** найденный путь (если установлен) */
  path?: string;
  /** вывод версии */
  version?: string;
  /** переменная с ключом (если поддерживается) */
  envVar?: string;
  /** ключ задан в окружении демона? */
  keySet: boolean;
  /** вход в аккаунт агента выполнен (OAuth/подписка) — ключ тогда не нужен */
  signedIn?: boolean;
  authHint?: string;
  keyUrl?: string;
}

export interface SetupJob {
  id: string;
  agentId: string;
  label: string;
  steps: { label: string; status: "pending" | "running" | "done" | "failed"; detail?: string }[];
  status: "queued" | "running" | "done" | "failed";
  log: string[];
  startedAt: number;
  finishedAt?: number;
}

const JOBS: SetupJob[] = [];
let running = false;

/** Есть ли бинарник: which → кандидаты путей. */
function resolveBin(id: string, os: Os): { path?: string } {
  const r = recipeFor(id);
  if (!r || !r.bin) return {};
  const which = Bun.which(r.bin);
  if (which) return { path: which };
  for (const p of candidatePaths(id, os)) if (existsSync(p)) return { path: p };
  return {};
}

/** Версия агента (первая строка). Таймаут снижен: панель не должна ждать. */
function probeVersion(path: string | undefined, id: string): string | undefined {
  const r = recipeFor(id);
  if (!r || !path) return undefined;
  try {
    const p = Bun.spawnSync([path, ...(r.versionArgs ?? ["--version"])], { timeout: 8000 });
    const out = (p.stdout.toString() + p.stderr.toString()).trim().split(/\r?\n/)[0] ?? "";
    return out.slice(0, 60) || undefined;
  } catch { return undefined; }
}

/** Статус одного агента: установлен / missing / needs-auth (ключ не задан). */
export function agentStatus(id: string, os: Os = currentOs()): AgentStatus {
  const r = recipeFor(id);
  if (!r) return { id, label: id, state: "unknown", keySet: false };
  if (r.builtin) return { id, label: r.label, state: "installed", keySet: !!r.envVar && !!process.env[r.envVar], envVar: r.envVar, authHint: r.authHint, keyUrl: r.keyUrl };
  const { path } = resolveBin(id, os);
  const keySet = !!r.envVar && !!process.env[r.envVar];
  if (path) {
    const version = probeVersion(path, id);
    // агент работает, но ключ не задан и версия не отвечает — возможно нужна авторизация
    const needsAuth = !version && !keySet;
    return withAuth({ id: r.id, label: r.label, state: needsAuth ? "needs-auth" : "installed", path, version, envVar: r.envVar, keySet, authHint: r.authHint, keyUrl: r.keyUrl });
  }
  return { id: r.id, label: r.label, state: "missing", envVar: r.envVar, keySet, authHint: r.authHint, keyUrl: r.keyUrl };
}

/** Асинхронная версия одного статуса (spawnSync блокирует event loop). */
async function agentStatusAsync(id: string, os: Os): Promise<AgentStatus> {
  const r = recipeFor(id);
  if (!r) return { id, label: id, state: "unknown", keySet: false };
  if (r.builtin) return agentStatus(id, os);
  const { path } = resolveBin(id, os);
  const keySet = !!r.envVar && !!process.env[r.envVar];
  if (!path) return { id: r.id, label: r.label, state: "missing", envVar: r.envVar, keySet, authHint: r.authHint, keyUrl: r.keyUrl };
  let version: string | undefined;
  try {
    const proc = Bun.spawn([path, ...(r.versionArgs ?? ["--version"])], { stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => { try { proc.kill(); } catch { /* уже мёртв */ } }, 8000);
    const out = await new Response(proc.stdout).text();
    clearTimeout(timer);
    version = (out + (await new Response(proc.stderr).text())).trim().split(/\r?\n/)[0]?.slice(0, 60) || undefined;
  } catch { /* таймаут/ошибка */ }
  const needsAuth = !version && !keySet;
  return withAuth({ id: r.id, label: r.label, state: needsAuth ? "needs-auth" : "installed", path, version, envVar: r.envVar, keySet, authHint: r.authHint, keyUrl: r.keyUrl });
}

/* Кэш статусов: детект спавнит CLI (--version), а панель опрашивает часто —
   без кэша 11 агентов × 8с таймаута блокировали бы ответ на секунды. */
let statusCache: { at: number; items: AgentStatus[]; refreshing?: boolean } | null = null;
const STATUS_TTL_MS = 60_000;      // детект спавнит 13 CLI — кэш на минуту
/** Прогреть кэш на старте демона: первый заход в «Агенты» мгновенный. */
export function warmStatusCache(): void {
  const os = currentOs();
  void Promise.all(RECIPES.map((r) => agentStatusAsync(r.id, os)))
    .then((items) => { statusCache = { at: Date.now(), items }; })
    .catch(() => { /* холодный кэш просто не появится — ручка посчитает сама */ });
}

/** Статусы всех агентов: параллельно + кэш (для HTTP-ручки).
 *  Stale-while-revalidate: первый ответ всегда мгновенный (из кэша), свежие
 *  данные приезжают на следующем опросе — панель никогда не «виснет» на
 *  «проверяем…». */
export async function allAgentStatusesAsync(os: Os = currentOs()): Promise<AgentStatus[]> {
  if (statusCache && Date.now() - statusCache.at < STATUS_TTL_MS) return statusCache.items;
  // холодный старт: вернуть что есть (даже устаревшее), фоново обновить
  if (statusCache && !statusCache.refreshing) {
    statusCache.refreshing = true;
    void Promise.all(RECIPES.map((r) => agentStatusAsync(r.id, os)))
      .then((items) => { statusCache = { at: Date.now(), items }; })
      .catch(() => { if (statusCache) statusCache.refreshing = false; });
    return statusCache.items;
  }
  const items = await Promise.all(RECIPES.map((r) => agentStatusAsync(r.id, os)));
  statusCache = { at: Date.now(), items };
  return items;
}

/** Синхронный вариант (для тестов и локальных вызовов). */
export function allAgentStatuses(os: Os = currentOs()): AgentStatus[] {
  if (statusCache && Date.now() - statusCache.at < STATUS_TTL_MS) return statusCache.items;
  const items = RECIPES.map((r) => agentStatus(r.id, os));
  statusCache = { at: Date.now(), items };
  return items;
}

/** Сброс кэша (после установки/удаления агента). */
export function invalidateStatusCache(): void { statusCache = null; }

/** Запустить шаги установки (возвращает ok). Используется и локально, и для превью на удалёнке. */
export async function runSteps(steps: InstallStep[], os: Os, onLog?: (line: string) => void): Promise<boolean> {
  for (const step of steps) {
    const cmd = os === "linux" && step.sudo ? ["sudo", ...step.cmd] : step.cmd;
    onLog?.(`$ ${cmd.join(" ")}\n`);
    let proc: Bun.Subprocess;
    try {
      proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    } catch (e) {
      onLog?.(`запуск не удался: ${String(e)}\n`);
      return false;
    }
    const timer = setTimeout(() => { try { proc.kill(); } catch { /* уже мёртв */ } }, step.timeoutMs ?? 600_000);
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);
    if (out.trim()) onLog?.(out.trim().split("\n").slice(-20).join("\n") + "\n");
    if (err.trim()) onLog?.(err.trim().split("\n").slice(-20).join("\n") + "\n");
    if (code !== 0) { onLog?.(`шаг упал (код ${code})\n`); return false; }
  }
  return true;
}

/** Постановка агента в очередь установки. */
export function enqueueInstall(agentId: string): SetupJob {
  const r = recipeFor(agentId);
  if (!r) throw new Error(`нет рецепта для ${agentId}`);
  const os = currentOs();
  const job: SetupJob = {
    id: `setup_${Date.now().toString(36)}`,
    agentId,
    label: r.label,
    steps: r.install[os].map((s) => ({ label: s.label, status: "pending" })),
    status: "queued",
    log: [],
    startedAt: Date.now(),
  };
  JOBS.push(job);
  void processQueue();
  return job;
}

/** Исполнение очереди последовательно. */
async function processQueue(): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (true) {
      const job = JOBS.find((j) => j.status === "queued");
      if (!job) break;
      // Падение одной установки не должно останавливать очередь и тем более
      // ронять демон: ошибка остаётся внутри задания, остальные продолжаются.
      try {
        await runJob(job);
      } catch (e) {
        job.log.push(`[dirigo] установка прервана ошибкой: ${String(e)}\n`);
        job.status = "failed";
        job.finishedAt = Date.now();
      }
    }
  } finally {
    running = false;
  }
}

async function runJob(job: SetupJob): Promise<void> {
      job.status = "running";
      const r = recipeFor(job.agentId);
      const os = currentOs();
      let ok = true;

      // Агент без рецепта или без шагов установки (ZCode собирается из
      // исходников) — это не повод падать: сообщаем и идём дальше.
      if (!r) {
        job.log.push(`рецепта установки для «${job.agentId}» нет\n`);
        ok = false;
      } else if (!job.steps.length) {
        job.log.push(r.manualOnly
          ? `Автоматической установки нет. Инструкция по сборке: ${r.manualOnly}\n`
          : `Для этой системы (${os}) шаги установки не описаны\n`);
        ok = false;
      }

      for (let i = 0; ok && r && i < job.steps.length; i++) {
        const step = job.steps[i]!;
        step.status = "running";
        const cmd = r.install[os]?.[i];
        if (!cmd) { step.status = "failed"; job.log.push(`шаг ${i + 1} не описан для ${os}\n`); ok = false; break; }
        ok = await runSteps([cmd], os, (line) => { job.log.push(line); });
        step.status = ok ? "done" : "failed";
        if (!ok) break;
      }
      // пост-проверка: после установки бинарник должен находиться
      if (ok && r?.bin) {
        const { path } = resolveBin(job.agentId, os);
        job.log.push(path ? `проверка: ${r.bin} → ${path}\n` : `проверка: ${r.bin} НЕ найден после установки\n`);
        if (!path) {
          ok = false;
          // Шагов может не быть вовсе — обращение к последнему роняло демон.
          const last = job.steps[job.steps.length - 1];
          if (last) last.status = "failed";
        }
      }
      job.status = ok ? "done" : "failed";
      job.finishedAt = Date.now();
      invalidateStatusCache(); // панель увидит новое состояние Immediately
      if (ok) {
        // Реестр агентов собирается один раз при импорте: без пере-резолва
        // только что установленный агент оставался «не установлен» до
        // перезапуска демона — то есть «поставил в один клик и сразу
        // работаешь» не работало.
        const { refreshAgentCommands } = await import("../agents/registry");
        const changed = refreshAgentCommands();
        if (changed.length) job.log.push(`команды обновлены: ${changed.join(", ")}\n`);
      }
}



export function listJobs(): SetupJob[] { return JOBS.slice(-20).reverse(); }
export function getJob(id: string): SetupJob | undefined { return JOBS.find((j) => j.id === id); }

/** Удалить агента (npm-g пакет) — для удобства cleanup. */
export async function uninstallAgent(agentId: string): Promise<boolean> {
  const r = recipeFor(agentId);
  if (!r || r.builtin) return false;
  const os = currentOs();
  const step = r.install[os]![0];
  if (!step) return false;
  // npm-рецепт: вытаскиваем пакет и снимаем
  const m = step.cmd.join(" ").match(/install -g[^"]*? ([^\s"]+)/);
  const pkg = m?.[1];
  if (!pkg) return false;
  const proc = Bun.spawn(["npm", "uninstall", "-g", pkg], { stdout: "ignore", stderr: "ignore" });
  await proc.exited;
  await appendLog("setup", `[dirigo] удаление ${job_id(r)}: ${pkg}\n`);
  invalidateStatusCache();
  const { refreshAgentCommands } = await import("../agents/registry");
  refreshAgentCommands();
  return true;
}
function job_id(r: AgentRecipe): string { return r.id; }
