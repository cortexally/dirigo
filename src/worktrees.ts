// Dirigo — движок копий проекта (worktrees).
//
// Два способа изолировать агента от боевого проекта:
//   1. `git worktree add` — если проект под git (быстро, дешёво, есть база для diff/apply);
//   2. файловая копия (fs-copy) — универсальный fallback (проект без git).
//
// Копия живёт в data/work/<sessionId>. Точка возврата: baseRef (git) либо снимок
// файлов проекта на момент создания (copy). Все операции — через Bun.spawn("git")
// и node:fs; runtime-зависимостей нет.

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { killAgentDaemonsAsync } from "./agents/daemons";
import { resolve } from "node:path";
import { join, relative, sep } from "node:path";

export type WorktreeKind = "git" | "copy";

export interface WorktreeInfo {
  /** id сессии-владельца */
  sessionId: string;
  kind: WorktreeKind;
  /** абсолютный путь к копии */
  path: string;
  /** абсолютный путь к проекту */
  projectPath: string;
  /** git: базовый коммит (точка возврата) */
  baseRef?: string;
  createdAt: number;
  /** До какого момента копию бережём (F_VER-5): агент мог ещё работать —
   *  клиент opencode умер, а ход ушёл в сервис, и правки идут в копию.
   *  До этого времени копию не сносим (ни уборкой, ни TTL, ни сиротской чисткой). */
  protectedUntil?: number;
}

export interface WorktreeStats {
  files: number;
  added: number;
  deleted: number;
}

let gitChecked: boolean | null = null;

/** git доступен? (проверяем один раз) */
export function gitAvailable(): boolean {
  if (gitChecked === null) {
    const r = Bun.spawnSync(["git", "--version"]);
    gitChecked = r.exitCode === 0;
  }
  return gitChecked;
}

/**
 * Путь к каталогу копий (data/work) — рядом с data/db.json.
 * Уважает DIRIGO_DATA (изоляция тестов/песочниц), как и store.ts.
 */
/**
 * Каталог данных демона (db.json, logs, work). В копию проекта он попадать
 * не должен ни при каких условиях: это не код пользователя, а состояние пульта.
 */
export function dataDir(): string {
  const dir = process.env.DIRIGO_DATA
    ? process.env.DIRIGO_DATA.replace(/[\\/]+$/, "")
    : new URL("../data/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  return resolve(dir);
}

export function workDir(): string {
  const dir = process.env.DIRIGO_DATA
    ? process.env.DIRIGO_DATA.replace(/[\\/]+$/, "") + "/work"
    : new URL("../data/work/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  mkdirSync(dir, { recursive: true });
  // ВАЖНО: абсолютный путь. DIRIGO_DATA часто задают относительным
  // (".smoke-queue"), и тогда защита от рекурсии в copyTree сравнивала
  // абсолютный путь файла с относительным корнем копий, не срабатывала,
  // и проект копировал сам себя уровень за уровнем — пока путь не упирался
  // в лимит ОС (ENAMETOOLONG на Linux, мусор на диске на Windows).
  return resolve(dir);
}

export function run(cmd: string[], cwd?: string): { ok: boolean; out: string; err: string } {
  const r = Bun.spawnSync(cmd, cwd ? { cwd } : undefined);
  return { ok: r.exitCode === 0, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
}

/*
 * Кэш чтения метаданных git (ветка, HEAD, корень репо) для GET-панели сессии.
 * Вид «Разговор» зовёт /target, /diff и /files разом, и каждый заново определял
 * цель — до 11 синхронных git на запрос (на Windows ~30 мс каждый): демон стоял
 * по 0,8–1,2 с (e2e-stability). Кэш действует только внутри withGitReadCache и
 * живёт 2 с; изменяющие запросы его сбрасывают (clearGitReadCache), сам дифф
 * (add -N, diff) не кэшируется никогда.
 */
const GIT_READ_TTL_MS = 2000;
const gitReadCache = new Map<string, { at: number; r: { ok: boolean; out: string; err: string } }>();
let gitReadDepth = 0;
export function withGitReadCache<T>(fn: () => T): T {
  gitReadDepth++;
  try { return fn(); } finally { gitReadDepth--; }
}
export function clearGitReadCache(): void { gitReadCache.clear(); }
/** run() для команд только на чтение: внутри withGitReadCache — из кэша. */
export function runRead(cmd: string[], cwd?: string): { ok: boolean; out: string; err: string } {
  if (gitReadDepth === 0) return run(cmd, cwd);
  const key = (cwd ?? "") + "\u0000" + cmd.join("\u0000");
  const hit = gitReadCache.get(key);
  if (hit && Date.now() - hit.at < GIT_READ_TTL_MS) return hit.r;
  const r = run(cmd, cwd);
  if (gitReadCache.size > 500) gitReadCache.clear();
  gitReadCache.set(key, { at: Date.now(), r });
  return r;
}

/**
 * Проект — корень git-repo? Подкаталог чужого репо не считаем КОРНЕМ:
 * worktree можно сделать только из корня (иначе получим worktree родителя).
 * Для diff/status/commit подкаталог — валиден (git -C работает), см. gitRepoInfo.
 */
export function isGitProject(projectPath: string): boolean {
  return gitRepoInfo(projectPath).isRoot;
}

export interface GitRepoInfo {
  /** путь внутри любого git-репо (git -C работает: status/diff/commit) */
  insideWorkTree: boolean;
  /** путь == корень своего git-репо (можно делать git worktree отсюда) */
  isRoot: boolean;
  /** относительный путь от корня репо до projectPath (для подкаталога монорепо) */
  relFromRoot?: string;
  /** корень репо */
  repoRoot?: string;
}

/**
 * Полная картина git для пути: внутри репо? корень? подкаталог?
 * Разделяет «git работает здесь» (insideWorkTree) и «можно делать worktree» (isRoot).
 */
export function gitRepoInfo(projectPath: string): GitRepoInfo {
  if (!existsSync(projectPath)) return { insideWorkTree: false, isRoot: false };
  const inside = runRead(["git", "-C", projectPath, "rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok || inside.out !== "true") return { insideWorkTree: false, isRoot: false };
  const top = runRead(["git", "-C", projectPath, "rev-parse", "--show-toplevel"]);
  if (!top.ok) return { insideWorkTree: true, isRoot: false };
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const isRoot = norm(top.out) === norm(projectPath);
  let rel: string | undefined;
  if (!isRoot) {
    rel = relative(top.out, projectPath).replace(/\\/g, "/");
  }
  return { insideWorkTree: true, isRoot, relFromRoot: rel, repoRoot: top.out };
}

/**
 * Собственный git-репозиторий проекта: init + коммит-снимок текущего состояния.
 * Без git у сессии нет ни честного диффа (копия сравнивалась бы с меняющимся
 * оригиналом), ни отката, ни коммитов — «копия без git, Changes 0, кнопки 409».
 * Работает и для папки внутри чужого репо: проект получает СВОЙ репозиторий,
 * и коммиты больше не уходят в родительский (например, в репо самого пульта).
 */
export function initProjectRepo(projectPath: string): { ok: boolean; detail: string } {
  if (!existsSync(projectPath)) return { ok: false, detail: "папка проекта не найдена" };
  if (gitRepoInfo(projectPath).isRoot) return { ok: true, detail: "у проекта уже есть свой git" };
  const steps: string[][] = [
    ["git", "-C", projectPath, "init", "-q", "-b", "main"],
    ["git", "-C", projectPath, "config", "user.name", "dirigo"],
    ["git", "-C", projectPath, "config", "user.email", "dirigo@localhost"],
    ["git", "-C", projectPath, "add", "-A"],
    ["git", "-C", projectPath, "commit", "-q", "--allow-empty", "-m", "dirigo: снимок проекта до первой сессии"],
  ];
  for (const cmd of steps) {
    const r = run(cmd);
    if (!r.ok) return { ok: false, detail: `${cmd.slice(3).join(" ")}: ${(r.err || r.out).slice(0, 200)}` };
  }
  return { ok: true, detail: "создан git-репозиторий проекта (ветка main, коммит-снимок)" };
}

function shortId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9]/g, "").slice(-8) || "wt";
}

/** Максимальная вложенность копирования — страховка от любой рекурсии. */
const COPY_MAX_DEPTH = 40;

/** Копирование дерева с исключениями (node_modules/.git/артефакты/сам workDir). */
/**
 * Похоже ли это на каталог данных Dirigo (чей угодно, не только текущего демона).
 *
 * Исключать только свой DIRIGO_DATA оказалось мало: тестовые прогоны оставляют
 * в проекте каталоги вроде `.smoke-vf-data/`, внутри которых лежат копии
 * проекта — а в них снова копии. Копирование по имени каталога такое не ловит,
 * поэтому распознаём по содержимому. Именно эта рекурсия раздувала копии до
 * гигабайтов и делала архив проекта нераспаковываемым.
 */
function looksLikeDataDir(dir: string): boolean {
  try {
    if (existsSync(join(dir, "work", "registry.json"))) return true;
    if (existsSync(join(dir, "registry.json")) && existsSync(join(dir, "..", "db.json"))) return true;
    return existsSync(join(dir, "db.json")) && existsSync(join(dir, "work"));
  } catch { return false; }
}

function copyTree(src: string, dst: string, depth = 0, budget?: { files: number; bytes: number }): void {
  if (depth > COPY_MAX_DEPTH) {
    throw new Error(`копирование прервано: вложенность больше ${COPY_MAX_DEPTH} (${dst})`);
  }
  const cap = budget ?? { files: 0, bytes: 0 };
  const workRoot = resolve(workDir()).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const dataRoot = dataDir().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    if (GIT_IGNORE_DIRS.has(entry.name)) continue;
    const from = join(src, entry.name);
    // защита от рекурсии: если data/work лежит ВНУТРИ проекта — не копируем его
    const normFrom = resolve(from).replace(/\\/g, "/").toLowerCase();
    if (normFrom === workRoot || normFrom.startsWith(workRoot + "/")) continue;
    // и сам каталог данных демона тоже: db.json/logs/секреты не место в копии
    if (normFrom === dataRoot || normFrom.startsWith(dataRoot + "/")) continue;
    const to = join(dst, entry.name);
    if (entry.isDirectory()) {
      if (looksLikeDataDir(from)) continue;            // чужой каталог данных пульта
      copyTree(from, to, depth + 1, cap);
    } else if (entry.isFile()) {
      if (COPY_SKIP_SUFFIX.some((s) => entry.name.endsWith(s))) continue;
      if (WIN_RESERVED.test(entry.name)) continue;
      // Бюджет копии: лучше честно отказать, чем молча занять диск и
      // потом уронить diff нехваткой памяти.
      let size = 0;
      try { size = statSync(from).size; } catch { size = 0; }
      if (size > COPY_MAX_FILE_BYTES) continue;        // одиночный гигантский файл агенту не нужен
      cap.files += 1;
      cap.bytes += size;
      if (cap.files > COPY_MAX_FILES || cap.bytes > COPY_MAX_BYTES) {
        throw new Error(
          `проект слишком большой для копии (${cap.files} файлов, ${(cap.bytes / 1e9).toFixed(1)} ГБ). ` +
          `Добавьте тяжёлые каталоги в .gitignore или запустите сессию без копии.`);
      }
      cpSync(from, to);
    }
  }
}

/**
 * Создаёт копию проекта для сессии.
 * kind "git" — обязательно git worktree (если проект не под git — бросает);
 * kind "copy" — файловая копия проекта.
 */
export function createWorktree(sessionId: string, projectPath: string, kind: WorktreeKind = "git"): WorktreeInfo {
  const root = join(workDir(), sessionId);
  if (existsSync(root)) throw new Error(`копия уже существует: ${root}`);
  const createdAt = Date.now();

  if (kind === "git") {
    if (!gitAvailable()) throw new Error("git не установлен");
    if (!isGitProject(projectPath)) throw new Error("проект не под git — используй kind=copy");
    const base = run(["git", "-C", projectPath, "rev-parse", "HEAD"]);
    if (!base.ok) {
      // Репо только что инициализировано (git init) — коммитов ещё нет.
      // Пустой worktree невозможен, поэтому делаем файловую копию: она и
      // есть «копия проекта», набор кнопок тот же (branch-mode возьёт проект).
      copyTree(projectPath, root);
      const info: WorktreeInfo = { sessionId, kind: "copy", path: root, projectPath, createdAt };
      saveRegistry(info);
      return info;
    }
    // detached worktree: копия на базовом коммите, без собственной ветки.
    // Запоминаем ветку-источник: UI покажет «копия · main», а не «копия · HEAD».
    const srcBranch = run(["git", "-C", projectPath, "rev-parse", "--abbrev-ref", "HEAD"]);
    const add = run(["git", "-C", projectPath, "worktree", "add", "--detach", root, base.out]);
    if (!add.ok) throw new Error(`git worktree add failed: ${add.err || add.out}`);
    if (srcBranch.ok && srcBranch.out && srcBranch.out !== "HEAD") {
      run(["git", "-C", root, "config", "dirigo.baseBranch", srcBranch.out]);
    }
    const info: WorktreeInfo = { sessionId, kind: "git", path: root, projectPath, baseRef: base.out, createdAt };
    saveRegistry(info);
    return info;
  }

  copyTree(projectPath, root);
  const info: WorktreeInfo = { sessionId, kind: "copy", path: root, projectPath, createdAt };
  saveRegistry(info);
  return info;
}

/* ---------------- реестр копий ---------------- */

interface RegistryEntry { sessionId: string; kind: WorktreeKind; path: string; projectPath: string; baseRef?: string; createdAt: number; lastError?: string; protectedUntil?: number; }
const registryFile = () => join(workDir(), "registry.json");

function readRegistry(): RegistryEntry[] {
  try {
    const f = registryFile();
    if (!existsSync(f)) return [];
    const raw = JSON.parse(readFileSync(f, "utf8"));
    return Array.isArray(raw) ? raw : [];
  } catch { return []; }
}

function saveRegistry(info: WorktreeInfo): void {
  const all = readRegistry().filter((e) => e.sessionId !== info.sessionId);
  all.push({
    sessionId: info.sessionId, kind: info.kind, path: info.path,
    projectPath: info.projectPath, baseRef: info.baseRef, createdAt: info.createdAt,
  });
  // синхронная запись: реестр читается сразу после создания копии
  writeFileSync(registryFile(), JSON.stringify(all, null, 2), "utf8");
}

function dropFromRegistry(sessionId: string, keepWithError?: string): void {
  const rest = readRegistry().filter((e) => e.sessionId !== sessionId);
  if (keepWithError) {
    const entry = readRegistry().find((e) => e.sessionId === sessionId);
    if (entry) rest.push({ ...entry, lastError: keepWithError });
  }
  writeFileSync(registryFile(), JSON.stringify(rest, null, 2), "utf8");
}

/**
 * Беречь копию: агент мог ещё работать (F_VER-5).
 *
 * opencode отдаёт ход своему сервису: клиент умирает, а работа продолжается.
 * Если в этот момент снести копию, живой агент теряет рабочую папку
 * («Working directory does not exist»), и правки пропадают. Поэтому копию
 * помечаем защищённой — до этого времени её не сносит ни уборка, ни TTL,
 * ни сиротская чистка.
 */
export function protectWorktree(sessionId: string, until: number): boolean {
  const all = readRegistry();
  const i = all.findIndex((e) => e.sessionId === sessionId);
  if (i < 0) return false;
  all[i] = { ...all[i], protectedUntil: until };
  writeFileSync(registryFile(), JSON.stringify(all, null, 2), "utf8");
  return true;
}

/** Снять защиту (агент замолчал — копию можно сносить). */
export function unprotectWorktree(sessionId: string): void {
  const all = readRegistry();
  const i = all.findIndex((e) => e.sessionId === sessionId);
  if (i < 0 || !all[i]!.protectedUntil) return;
  delete all[i]!.protectedUntil;
  writeFileSync(registryFile(), JSON.stringify(all, null, 2), "utf8");
}

/** Защищена ли копия прямо сейчас. */
export function isProtected(sessionId: string, now = Date.now()): boolean {
  const e = readRegistry().find((x) => x.sessionId === sessionId);
  return !!e?.protectedUntil && e.protectedUntil > now;
}

/* ── копии, которые сейчас не удалить (папку держит процесс) ──
   Раньше такая копия-сирота оставалась в реестре и занимала слот лимита:
   «лимит копий исчерпан», хотя удалять уже нечего. Теперь слот освобождается
   сразу, а папка уходит в список «удалить позже»: повторы фоном и при старте. */
function trashFile(): string { return join(dataDir(), "work-trash.json"); }
function readTrash(): string[] {
  try { const raw = JSON.parse(readFileSync(trashFile(), "utf8")); return Array.isArray(raw) ? raw.map(String) : []; } catch { return []; }
}
function writeTrash(list: string[]): void {
  try { writeFileSync(trashFile(), JSON.stringify([...new Set(list)], null, 2), "utf8"); } catch { /* не критично */ }
}

/** Освободить слот копии, даже если её папку пока не удалить. Возвращает путь. */
export function releaseWorktreeSlot(sessionId: string): string | null {
  const entry = readRegistry().find((e) => e.sessionId === sessionId);
  if (!entry) return null;
  dropFromRegistry(sessionId);
  if (existsSync(entry.path)) writeTrash([...readTrash(), entry.path]);
  if (entry.kind === "git" && existsSync(entry.projectPath)) run(["git", "-C", entry.projectPath, "worktree", "prune"]);
  return entry.path;
}

/** Попробовать удалить отложенные папки. Возвращает, сколько ещё осталось. */
export function purgeTrash(): number {
  const left: string[] = [];
  for (const dir of readTrash()) {
    if (!existsSync(dir)) continue;
    // Папку может держать живой агент (он в ней работает): сносим только если
    // она отвелась, иначе — на потом. Правки агента при этом целы.
    const r = removeTreeSafely(dir);
    if (!r.ok) left.push(r.movedTo ?? dir);
  }
  writeTrash(left);
  return left.length;
}

/** Папки «удалить позже» (для ответа API и тестов). */
export function trashedWorktrees(): string[] { return readTrash().filter((d) => existsSync(d)); }

export function listWorktrees(): WorktreeInfo[] {
  return readRegistry()
    .filter((e) => existsSync(e.path))
    .map((e) => ({
      sessionId: e.sessionId, kind: e.kind, path: e.path,
      projectPath: e.projectPath, baseRef: e.baseRef, createdAt: e.createdAt,
      ...(e.protectedUntil ? { protectedUntil: e.protectedUntil } : {}),
    }));
}

export function getWorktree(sessionId: string): WorktreeInfo | undefined {
  return listWorktrees().find((w) => w.sessionId === sessionId);
}

/**
 * Копия цела?
 *
 * Копию можно снести НАПОЛОВИНУ: `git worktree remove --force` выносит
 * содержимое, но каталог, который держит процесс агента (Windows: папка
 * занята как CWD), снести не может. Остаётся пустая папка — и она уже не
 * копия: git-рабочая копия без служебного файла .git для агента выглядит
 * как пустой проект («git status: not a git repository»).
 *
 * Признак целой копии: git — служебный файл .git внутри неё; copy — папка
 * на месте (содержимое файловой копии сносится только вместе с папкой).
 */
export function isWorktreeIntact(info: { kind: WorktreeKind; path: string }): boolean {
  if (!existsSync(info.path)) return false;
  if (info.kind === "git") return existsSync(join(info.path, ".git"));
  return true;
}

/**
 * Починить копию: папка на месте, а копии внутри нет → пересоздать её.
 *
 * Нужно перед повторным запуском агента в той же сессии. Без этого агент
 * стартует в пустой папке, не видит проект и «работает» в никуда: правки
 * нечего собирать, дифф пустой, а сессия выглядит живой.
 */
export function repairWorktree(sessionId: string): { ok: boolean; detail: string } {
  const entry = readRegistry().find((e) => e.sessionId === sessionId);
  if (!entry) return { ok: true, detail: "копии нет" };
  if (isWorktreeIntact(entry)) return { ok: true, detail: "копия цела" };
  if (!existsSync(entry.projectPath)) return { ok: false, detail: `проект недоступен: ${entry.projectPath}` };
  try {
    // Остатки копии сносим безопасно: папку может держать живой агент, а
    // прямой rm -r уничтожил бы его файлы и упал бы на самой папке (EBUSY).
    const gone = removeTreeSafely(entry.path);
    if (!gone.ok) return { ok: false, detail: gone.detail };
  } catch (e) {
    // папку держит процесс — пересоздать на том же месте нельзя
    return { ok: false, detail: `остатки копии не удалены: ${String(e).slice(0, 200)}` };
  }
  if (entry.kind === "git") {
    const base = entry.baseRef ?? "HEAD";
    // запись о прежней копии в .git/worktrees — снять, иначе add скажет «уже есть»
    run(["git", "-C", entry.projectPath, "worktree", "prune", "--expire", "now"]);
    const add = run(["git", "-C", entry.projectPath, "worktree", "add", "--detach", entry.path, base]);
    if (!add.ok) {
      run(["git", "-C", entry.projectPath, "worktree", "prune"]);
      return { ok: false, detail: `копия не пересоздана: ${add.err || add.out}`.slice(0, 200) };
    }
    return { ok: true, detail: "копия пересоздана" };
  }
  try {
    copyTree(entry.projectPath, entry.path);
  } catch (e) {
    return { ok: false, detail: `копия не пересоздана: ${String(e).slice(0, 200)}` };
  }
  return { ok: true, detail: "копия пересоздана" };
}

/** Простая синхронная пауза (для ретрая удаления копии). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Держит ли кто-то папку своим рабочим каталогом? (Linux: /proc/<pid>/cwd)
 *
 * На Windows это ловит переименование (см. removeTreeSafely), на Linux
 * переименование папки, занятой процессом, проходит — поэтому там смотрим
 * /proc: у процесса, ушедшего в папку, /proc/<pid>/cwd указывает на неё.
 */
function dirHeldByProcess(path: string): boolean {
  if (process.platform !== "linux") return false;
  let target = "";
  try { target = realpathSync(path); } catch { return false; }
  let pids: string[] = [];
  try { pids = readdirSync("/proc"); } catch { return false; }
  for (const pid of pids) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      if (realpathSync(`/proc/${pid}/cwd`) === target) return true;
    } catch { /* процесс умер или нет прав */ }
  }
  return false;
}

/**
 * Снести папку, не разрушая содержимое, пока её держит живой процесс.
 *
 * Почему нельзя просто `rm -r`: на Windows папка, которая у процесса в рабочем
 * каталоге, удаляется «наполовину» — файлы внутри сносятся, а сама папка падает
 * с EBUSY. То же делает `git worktree remove --force`: файлы удаляет, а на
 * папке получает «Permission denied». Агент, который в этой папке работает,
 * теряет все правки («Working directory does not exist»).
 *
 * Поэтому сначала атомарное переименование: Windows не даёт переименовать
 * папку, занятую процессом, — это безопасная проверка «здесь кто-то работает».
 * Не прошло — папку не трогаем вообще (вернём «занято», добьёт ретрай/TTL).
 * Прошло — папка отставлена в сторону, её можно сносить.
 */
function removeTreeSafely(path: string): { ok: boolean; detail: string; movedTo?: string } {
  if (!existsSync(path)) return { ok: true, detail: "папки нет" };
  const aside = `${path}.deleting-${Date.now()}`;
  try {
    renameSync(path, aside);
  } catch (e) {
    return { ok: false, detail: `папку держит процесс: ${String(e).slice(0, 200)}` };
  }
  try {
    rmSync(aside, { recursive: true, force: true });
  } catch (e) {
    // файлы внутри всё ещё держат — отложенное удаление
    return { ok: false, detail: `файлы держат — отложено: ${String(e).slice(0, 200)}`, movedTo: aside };
  }
  return { ok: true, detail: "" };
}

/**
 * Удаление копии сессии. Никогда не бросает: если папку держит живой процесс
 * (Windows-локи), запись остаётся в реестре с lastError — её добьёт
 * TTL/orphan-чистка, а правки агента остаются целыми.
 * Порядок: сначала проба «занята ли папка» (переименование), потом снос;
 * git: worktree prune по сдвинутой папке; copy: rm -rf отведённой папки.
 */
export function cleanupWorktree(sessionId: string): { ok: boolean; detail: string } {
  const info = getWorktree(sessionId);
  if (!info) {
    // возможна «битая» запись без каталога — просто убираем из реестра
    const had = readRegistry().some((e) => e.sessionId === sessionId);
    if (had) dropFromRegistry(sessionId);
    return { ok: true, detail: had ? "запись без каталога убрана" : "копии нет" };
  }
  // Защищённая копия (F_VER-5): агент мог ещё работать — сносить нельзя.
  // Проверка тут, в самой точке сноса: иначе её обошёл бы любой вызывающий
  // (уборка, TTL, сиротская чистка) — а снос копии у живого агента отнимает
  // у него рабочую папку.
  if (info.protectedUntil && info.protectedUntil > Date.now()) {
    return { ok: false, detail: "копия защищена: агент мог ещё работать" };
  }
  const attempt = (): string | null => {
    try {
      // Пока папку держит живой процесс, удалять её нельзя: и `git worktree
      // remove --force`, и `rm -r` на Windows сносят ФАЙЛЫ внутри и падают на
      // саму папку (EBUSY / Permission denied) — агент теряет правки, его
      // рабочая папка исчезает («Working directory does not exist»).
      // Поэтому сначала проба «занята ли папка» (переименование), и только
      // потом снос; не прошло — не трогаем ничего.
      if (dirHeldByProcess(info.path)) return "папку держит живой процесс";
      const aside = `${info.path}.deleting-${Date.now()}`;
      try {
        renameSync(info.path, aside);
      } catch (e) {
        return `папку держит процесс: ${String(e).slice(0, 200)}`;
      }
      if (info.kind === "git" && existsSync(info.projectPath)) {
        // Метаданные worktree: путь уже не существует, но обычный prune
        // ждёт «протухания» (gc.worktreePruneExpire, по умолчанию 2 недели) —
        // с --expire now запись уходит сразу, иначе git держит папку проекта.
        run(["git", "-C", info.projectPath, "worktree", "prune", "--expire", "now"]);
      }
      try {
        rmSync(aside, { recursive: true, force: true });
      } catch (e) {
        writeTrash([...readTrash(), aside]);
        return `файлы держат — отложено: ${String(e).slice(0, 200)}`;
      }
      return null;
    } catch (e) {
      return String(e).slice(0, 300); // файлы заняты процессом — повторим
    }
  };
  let err = attempt();
  if (err) {
    // Папку держит процесс: агент ещё не отпустил файлы или за ним остался
    // отвязанный демон (cline hub с --cwd этой копии). Гасим такие демоны —
    // только привязанные к этой папке — и пробуем снова.
    // асинхронно и без sleepSync: синхронная уборка замораживала демон на
    // каждом удалении; повтор удаления идёт фоном (cleanupWorktreeSoon/TTL)
    void killAgentDaemonsAsync(info.path).catch(() => { /* уборка не критична */ });
  }
  if (err) {
    dropFromRegistry(sessionId, err); // запись остаётся (каталог тоже) — TTL добьёт
    return { ok: false, detail: err };
  }
  dropFromRegistry(sessionId);
  return { ok: true, detail: "" };
}

/** TTL-чистка устаревших копий (задача 1.6; вызывается планировщиком). */
export function cleanupStale(maxAgeMs: number): WorktreeInfo[] {
  const now = Date.now();
  const removed: WorktreeInfo[] = [];
  for (const w of listWorktrees()) {
    if (now - w.createdAt <= maxAgeMs) continue;
    // Защищённую копию (F_VER-5) TTL не трогает: агент мог ещё работать.
    if (cleanupWorktree(w.sessionId).ok) removed.push(w);
  }
  return removed;
}

/* ---------------- точка возврата ---------------- */

/** «Вернуть как было»: сброс копии к базовому состоянию. */
export function revertWorktree(sessionId: string): { ok: boolean; detail: string } {
  const info = getWorktree(sessionId);
  if (!info) return { ok: false, detail: "копии нет" };
  if (info.kind === "git") {
    const a = run(["git", "-C", info.path, "reset", "--hard", info.baseRef ?? "HEAD"]);
    const b = run(["git", "-C", info.path, "clean", "-fd"]);
    return { ok: a.ok && b.ok, detail: a.err || b.err || "reset+clean выполнены" };
  }
  // copy-mode: свертка диффа «копия → проект» для файлов, которых агент касался
  const { changed, added } = diffTrees(info.projectPath, info.path);
  let reverted = 0;
  for (const rel of changed) {
    const target = join(info.projectPath, rel);
    if (existsSync(target)) { cpSync(target, join(info.path, rel)); reverted++; }
  }
  for (const rel of added) rmSync(join(info.path, rel), { force: true });
  return { ok: true, detail: `copy-revert: восстановлено ${reverted}, удалено новых ${added.length}` };
}

/* ---------------- diff ---------------- */

export type LineKind = "ctx" | "add" | "del";

export interface DiffLine { kind: LineKind; text: string; oldNo: number | null; newNo: number | null; }

export interface DiffFile {
  path: string;
  status: "modified" | "added" | "deleted";
  lines: DiffLine[];
  added: number;
  deleted: number;
}

export interface DiffResult {
  files: DiffFile[];
  added: number;
  deleted: number;
}

/** Каталоги-исключения при обходе/копировании. */
const GIT_IGNORE_DIRS = new Set(["node_modules", ".venv", "venv", "__pycache__", "dist", "build", ".next", "target", ".cache"]);
const COPY_SKIP_SUFFIX = [".tmp", ".log"];
/** Имена устройств Windows (nul, con, com1…): такой файл (обычно след `> nul` из Git Bash)
 *  не копируется — EINVAL ронял создание всей копии. */
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.[^.]*)?$/i;
/** Потолки файловой копии: отказ с объяснением вместо забитого диска и OOM. */
const COPY_MAX_FILES = Number(process.env.DIRIGO_COPY_MAX_FILES ?? 60_000);
const COPY_MAX_BYTES = Number(process.env.DIRIGO_COPY_MAX_BYTES ?? 2_000_000_000);
const COPY_MAX_FILE_BYTES = Number(process.env.DIRIGO_COPY_MAX_FILE_BYTES ?? 50_000_000);
/** Потолки диффа: панель «Изменения» обязана отвечать, а не падать по памяти. */
const DIFF_MAX_FILES = Number(process.env.DIRIGO_DIFF_MAX_FILES ?? 2_000);
const DIFF_MAX_FILE_BYTES = Number(process.env.DIRIGO_DIFF_MAX_FILE_BYTES ?? 2_000_000);

function hashFile(p: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(readFileSync(p));
  return hasher.digest("hex");
}

/** Обход дерева: относительные пути файлов. */
function walkFiles(root: string): string[] {
  const out: string[] = [];
  const step = (dir: string) => {
    if (out.length > DIFF_MAX_FILES) return;
    // Агент правит копию прямо сейчас: папка/файл может исчезнуть между
    // «прочитали список» и «зашли внутрь». Обход не должен на этом падать —
    // иначе diff живой копии отвечает 404 («сессия не найдена»), хотя она есть.
    let entries: ReturnType<typeof readdirSync>;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (GIT_IGNORE_DIRS.has(entry.name) || entry.name === ".git") continue;
      const p = join(dir, entry.name);
      // Чужой каталог данных пульта внутри проекта в дифф не попадает: там
      // лежат копии сессий, и обход уходил вглубь до нехватки памяти.
      if (entry.isDirectory()) { if (!looksLikeDataDir(p)) step(p); }
      else if (entry.isFile()) out.push(relative(root, p).split(sep).join("/"));
    }
  };
  if (existsSync(root)) step(root);
  return out;
}

/** Сравнение двух деревьев по хешам (copy-mode). */
function diffTrees(a: string, b: string): { changed: string[]; added: string[]; deleted: string[] } {
  const fa = new Set(walkFiles(a));
  const fb = new Set(walkFiles(b));
  const changed: string[] = [];
  const added: string[] = [];
  const deleted: string[] = [];
  for (const rel of fb) {
    if (!fa.has(rel)) { added.push(rel); continue; }
    const pa = join(a, rel), pb = join(b, rel);
    try {
      if (hashFile(pa) !== hashFile(pb)) changed.push(rel);
    } catch { changed.push(rel); }
  }
  for (const rel of fa) if (!fb.has(rel)) deleted.push(rel);
  return { changed, added, deleted };
}

/** Порог полного LCS: на нём DP-матрица (n×m) даёт OOM на больших файлах (находка HA, docs/promo/INTEGRATION.md §11). */
const LCS_FULL_LIMIT = 3000;

/** Эвристика для больших файлов: общий префикс/суффикс + «середина заменена целиком». O(n) памяти. */
function lineDiffHuge(a: string[], b: string[], oldNo: number, newNo: number): DiffLine[] {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const lines: DiffLine[] = [];
  let o = oldNo, n = newNo;
  for (let i = 0; i < p; i++) lines.push({ kind: "ctx", text: a[i]!, oldNo: o++, newNo: n++ });
  for (let i = p; i < a.length - s; i++) lines.push({ kind: "del", text: a[i]!, oldNo: o++, newNo: null });
  for (let j = p; j < b.length - s; j++) lines.push({ kind: "add", text: b[j]!, oldNo: null, newNo: n++ });
  for (let k = 0; k < s; k++) lines.push({ kind: "ctx", text: a[a.length - s + k]!, oldNo: o++, newNo: n++ });
  return lines;
}

/** Построчный diff (LCS для файлов ≤3000 строк, эвристика — для больших). */
export function lineDiff(oldText: string, newText: string): DiffLine[] {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const n = a.length, m = b.length;
  if (n > LCS_FULL_LIMIT || m > LCS_FULL_LIMIT) {
    // approximate: один del-хук + один add-хук; корректные номера строк сохраняются
    return lineDiffHuge(a, b, 1, 1);
  }
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const lines: DiffLine[] = [];
  let i = 0, j = 0, oldNo = 1, newNo = 1;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      lines.push({ kind: "ctx", text: a[i]!, oldNo: oldNo++, newNo: newNo++ });
      i++; j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      lines.push({ kind: "del", text: a[i]!, oldNo: oldNo++, newNo: null });
      i++;
    } else {
      lines.push({ kind: "add", text: b[j]!, oldNo: null, newNo: newNo++ });
      j++;
    }
  }
  while (i < n) { lines.push({ kind: "del", text: a[i]!, oldNo: oldNo++, newNo: null }); i++; }
  while (j < m) { lines.push({ kind: "add", text: b[j]!, oldNo: null, newNo: newNo++ }); j++; }
  return lines;
}

function countKinds(lines: DiffLine[]): { added: number; deleted: number } {
  let added = 0, deleted = 0;
  for (const l of lines) { if (l.kind === "add") added++; else if (l.kind === "del") deleted++; }
  return { added, deleted };
}

/**
 * Полный дифф «копия → проект».
 * git-mode: `git add -A -N` (untracked в индекс) + `git diff --cached baseRef` → парсинг unified.
 * copy-mode: сверка хешей + lineDiff по файлам.
 */
export function diffWorktree(sessionId: string): DiffResult {
  const info = getWorktree(sessionId);
  if (!info) throw new Error("нет копии для сессии");

  if (info.kind === "git") {
    // untracked тоже должны попадать: -N добавляет их в индекс без контента,
    // после чего обычный `git diff baseRef` показывает их как new file с содержимым
    run(["git", "-C", info.path, "add", "-A", "-N"]);
    // НЕ --cached: правки живут в рабочем дереве, --cached показал бы только индекс
    // core.quotePath=false: иначе git экранирует не-ASCII пути («\320\275...»),
    // и разбор такого заголовка молча терял файл целиком.
    const patch = run(["git", "-C", info.path, "-c", "core.quotePath=false", "diff", "--no-color", info.baseRef ?? "HEAD"]);
    const files = parseUnified(patch.out);
    let added = 0, deleted = 0;
    for (const f of files) { added += f.added; deleted += f.deleted; }
    return { files, added, deleted };
  }

  const { changed, added, deleted } = diffTrees(info.projectPath, info.path);
  const files: DiffFile[] = [];
  // Файл, который не прочитать как текст (бинарь) или который слишком велик,
  // показываем строкой-пометкой. Раньше такой файл читался целиком в память —
  // на большом проекте это заканчивалось «RangeError: Out of memory».
  const readText = (p: string): string | null => {
    try {
      if (statSync(p).size > DIFF_MAX_FILE_BYTES) return null;
      const t = readFileSync(p, "utf8");
      return t.includes("\u0000") ? null : t;
    } catch { return null; }
  };
  const note = (rel: string, status: DiffFile["status"]): DiffFile =>
    ({ path: rel, status, lines: [{ kind: "ctx", text: "файл слишком большой или бинарный — показан без содержимого", oldNo: null, newNo: null }], added: 0, deleted: 0 });

  for (const rel of changed.slice(0, DIFF_MAX_FILES)) {
    const before = readText(join(info.projectPath, rel));
    const after = readText(join(info.path, rel));
    if (before === null || after === null) { files.push(note(rel, "modified")); continue; }
    const lines = lineDiff(before, after);
    const c = countKinds(lines);
    files.push({ path: rel, status: "modified", lines, ...c });
  }
  for (const rel of added.slice(0, DIFF_MAX_FILES)) {
    const after = readText(join(info.path, rel));
    if (after === null) { files.push(note(rel, "added")); continue; }
    const lines = lineDiff("", after);
    const c = countKinds(lines);
    files.push({ path: rel, status: "added", lines, ...c });
  }
  for (const rel of deleted.slice(0, DIFF_MAX_FILES)) {
    const before = existsSync(join(info.projectPath, rel)) ? readText(join(info.projectPath, rel)) : "";
    if (before === null) { files.push(note(rel, "deleted")); continue; }
    const lines = lineDiff(before, "");
    const c = countKinds(lines);
    files.push({ path: rel, status: "deleted", lines, ...c });
  }
  let addedN = 0, deletedN = 0;
  for (const f of files) { addedN += f.added; deletedN += f.deleted; }
  return { files, added: addedN, deleted: deletedN };
}

/**
 * Раскодировать путь, который git закавычил (core.quotePath).
 *
 * По умолчанию git экранирует не-ASCII в путях: вместо «новый файл.txt» в
 * diff приходит "a/\320\275\320\276 \321\204\320\260\320\271\320\273.txt".
 * Такую форму разбор заголовка не узнавал — и файл выпадал из диффа целиком.
 * Возвращаем настоящее имя файла (в кавычках — C-экранирование: \320 — это
 * байт, «\n» — перевод строки).
 */
export function unquoteGitPath(p: string): string {
  if (p.length < 2 || !p.startsWith('"') || !p.endsWith('"')) return p;
  const inner = p.slice(1, -1);
  const bytes: number[] = [];
  const oct = (c: string) => c >= "0" && c <= "7";
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]!;
    if (c === "\\" && i + 3 < inner.length && oct(inner[i + 1]!) && oct(inner[i + 2]!) && oct(inner[i + 3]!)) {
      bytes.push(parseInt(inner.slice(i + 1, i + 4), 8));
      i += 3;
      continue;
    }
    if (c === "\\" && i + 1 < inner.length) {
      const esc: Record<string, number> = { n: 10, t: 9, r: 13, f: 12, b: 8, v: 11, a: 7, "\\": 92, '"': 34 };
      const code = esc[inner[i + 1]!];
      if (code !== undefined) { bytes.push(code); i += 1; continue; }
    }
    for (const b of new TextEncoder().encode(c)) bytes.push(b);
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** Заголовок «diff --git a/путь b/путь» → путь файла (и закавыченная форма). */
function gitHeaderPath(raw: string): string | null {
  const plain = raw.match(/^diff --git a\/(.+?) b\/(.+)$/);
  if (plain) return plain[2]!;
  const quoted = raw.match(/^diff --git "a\/(.+?)" "b\/(.+?)"$/);
  if (quoted) return unquoteGitPath(`"${quoted[2]}"`);
  return null;
}

/** Парсер unified diff → построчная структура. */
export function parseUnified(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let cur: DiffFile | null = null;
  let oldNo = 0, newNo = 0;
  for (const raw of text.split(/\r?\n/)) {
    const headerPath = gitHeaderPath(raw);
    if (headerPath !== null) {
      cur = { path: headerPath, status: "modified", lines: [], added: 0, deleted: 0 };
      files.push(cur);
      continue;
    }
    if (raw.startsWith("new file mode")) { if (cur) cur.status = "added"; continue; }
    if (raw.startsWith("deleted file mode")) { if (cur) cur.status = "deleted"; continue; }
    if (
      raw.startsWith("index ") || raw.startsWith("old mode") || raw.startsWith("new mode") ||
      raw.startsWith("similarity ") || raw.startsWith("rename ") || raw.startsWith("copy ") ||
      raw.startsWith("--- ") || raw.startsWith("+++ ") || raw.startsWith("Binary files")
    ) continue;
    const hunk = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      if (!cur) continue;
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      continue;
    }
    if (!cur) continue;
    if (raw.startsWith("+")) {
      cur.lines.push({ kind: "add", text: raw.slice(1), oldNo: null, newNo: newNo++ });
      cur.added++;
    } else if (raw.startsWith("-")) {
      cur.lines.push({ kind: "del", text: raw.slice(1), oldNo: oldNo++, newNo: null });
      cur.deleted++;
    } else if (raw.startsWith("\\")) {
      continue; // "\ No newline at end of file"
    } else {
      cur.lines.push({ kind: "ctx", text: raw.startsWith(" ") ? raw.slice(1) : raw, oldNo: oldNo++, newNo: newNo++ });
    }
  }
  return files;
}

/* ---------------- apply / revert в проект ---------------- */

export interface ApplyResult {
  ok: boolean;
  applied: string[];
  removed: string[];
  conflicts: string[];
  detail: string;
}

/**
 * «Применить в проект»: переносит изменения копии в боевой проект.
 * git-mode: проверяем, что проект не уехал от baseRef (иначе — конфликт);
 * затем файловый перенос (эквивалент патча для контента).
 *
 * Защита от катастрофы: если дифф удаляет подозрительно много файлов
 * (>MASS_DELETE_LIMIT) — применяем только с force (в UI это второе
 * подтверждение). Молча удалить сотни файлов боевого проекта нельзя.
 */
export const MASS_DELETE_LIMIT = 50;

export function applyWorktree(sessionId: string, force = false): ApplyResult {
  const info = getWorktree(sessionId);
  if (!info) return { ok: false, applied: [], removed: [], conflicts: [], detail: "копии нет" };
  const diff = diffWorktree(sessionId);

  if (!force && diff.files.length > MASS_DELETE_LIMIT && diff.deleted > diff.added) {
    return {
      ok: false, applied: [], removed: [], conflicts: [],
      detail: `дифф удаляет ${diff.deleted} строк(файлов) при ${diff.added} добавленных — похоже на сбой сверки; применяй с force=true`,
    };
  }

  const conflicts: string[] = [];
  if (info.kind === "git" && info.baseRef) {
    const head = run(["git", "-C", info.projectPath, "rev-parse", "HEAD"]);
    if (head.out && head.out !== info.baseRef) {
      const dirty = run(["git", "-C", info.projectPath, "status", "--porcelain"]);
      if (dirty.out) conflicts.push(`проект изменён после создания копии: ${dirty.out.split("\n").slice(0, 5).join("; ")}`);
    }
  }

  const applied: string[] = [];
  const removed: string[] = [];
  for (const f of diff.files) {
    const target = join(info.projectPath, f.path);
    if (f.status === "deleted") {
      if (existsSync(target)) { rmSync(target, { force: true }); removed.push(f.path); }
      continue;
    }
    mkdirSync(join(target, ".."), { recursive: true });
    cpSync(join(info.path, f.path), target);
    applied.push(f.path);
  }
  return {
    ok: conflicts.length === 0,
    applied,
    removed,
    conflicts,
    detail: conflicts.length ? "применено с конфликтами — проверь" : `применено файлов: ${applied.length}, удалено: ${removed.length}`,
  };
}

/** Откат применённых изменений в проекте — «вернуть как было». */
export function restoreProject(sessionId: string): ApplyResult {
  const info = getWorktree(sessionId);
  if (!info) return { ok: false, applied: [], removed: [], conflicts: [], detail: "копии нет" };
  if (info.kind === "git" && info.baseRef) {
    const co = run(["git", "-C", info.projectPath, "checkout", info.baseRef, "--", "."]);
    const clean = run(["git", "-C", info.projectPath, "clean", "-fd"]);
    return { ok: co.ok && clean.ok, applied: [], removed: [], conflicts: [], detail: co.err || clean.err || "проект возвращён к baseRef" };
  }
  // copy-mode: убираем файлы, созданные агентом в проекте (изменённые — не откатываем: нет точки отсчёта)
  const diff = diffWorktree(sessionId);
  const removed: string[] = [];
  const applied: string[] = [];
  for (const f of diff.files) {
    const target = join(info.projectPath, f.path);
    if (f.status === "added") {
      if (existsSync(target)) { rmSync(target, { force: true }); removed.push(f.path); }
    } else {
      applied.push(f.path);
    }
  }
  return { ok: true, applied, removed, conflicts: [], detail: "copy-restore: новые файлы убраны" };
}

/** Статистика копии для UI/health. */
export function worktreeStats(sessionId: string): WorktreeStats | null {
  try {
    const d = diffWorktree(sessionId);
    return { files: d.files.length, added: d.added, deleted: d.deleted };
  } catch { return null; }
}
