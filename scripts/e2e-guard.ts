// Правила безопасности автонаборов (e2e): свой порт, свой каталог данных,
// уборка, которая не трогает живое состояние.
//
// Правило выросло из реального случая: набор e2e-cli сносил каталог данных,
// в котором жил агент (он же — тот, кто этот набор запускает). Агент
// продолжал работать, а его рабочая папка исчезала: «Working directory does
// not exist», правки терялись. Причина — обычный `rm -r` по каталогу данных:
// на Windows он сносит ФАЙЛЫ внутри папки, которую держит процесс (папка как
// рабочий каталог агента), и падает уже на самой папке.
//
// Здесь только правила — без сети и процессов: их проверяет быстрый регресс-тест
// (scripts/cli-e2e-isolation-test.ts), а набор (scripts/cli-e2e.ts) берёт правила
// отсюда, а не из своей копии.
//
// Правило живости — «pid известен — верим процессу» (F_VER-2) — оказалось
// неполным: у opencode `opencode-cli.exe run` — клиент, ход он отдаёт своему
// сервису и выходит, а работа идёт в сервисе. Pid клиента умирает, пока агент
// ещё работает, и уборка по одному pid сносила рабочую папку живого агента
// («Working directory does not exist», правки терялись). Поэтому pid мёртв —
// не приговор: если видно свежую активность (правки в копии, журнал сессии,
//updatedAt), сессия живая и её каталог не трогаем (F_VER-4).

import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse, resolve, sep } from "node:path";

/** Порты, закреплённые за другими наборами гейта: их не занимаем. */
export const RESERVED_PORTS = new Set([
  7171, 7279, 7280, 7283, 7284, 7286, 7287, 7288, 7290, 7291, 7292, 7293, 7294,
  7295, 7296, 7297, 7298, 7391, 7411,
]);

/** Корень песочницы наборов: <tmp>/dirigo-e2e. */
export function sandboxRoot(): string {
  return join(tmpdir(), "dirigo-e2e");
}

/** Каталог данных набора для порта. */
export function dataDirFor(port: number): string {
  return join(sandboxRoot(), `cli-e2e-${port}`);
}

/** Каталог черновика проекта для агента: «apply» переносит правки агента в
 *  проект, и в репозиторий разработчика им не место. */
export function projectDirFor(port: number): string {
  return join(sandboxRoot(), `proj-${port}`);
}

/** Каталог внутри другого? */
export function isInside(child: string, parent: string): boolean {
  const c = resolve(child).toLowerCase();
  const p = resolve(parent).toLowerCase();
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

/** Жив ли процесс? */
export function pidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * Состояние сессии для уборки.
 *
 *   live    — агент работает: не трогаем ни копию, ни каталог;
 *   dead    — агент завершён: копию и каталог убираем;
 *   unknown — состояние не узнали (демон не ответил, сессия не найдена).
 *             Это НЕ «мёртвый агент»: сносить нельзя — вдруг агент жив.
 *
 * Третье состояние — из реального случая: сессия пропала из ответа демона
 * (или демон не ответил), набор решил, что агент закончил, удалил сессию —
 * и у живого агента исчезла рабочая папка.
 */
export type SessionState = "live" | "dead" | "unknown";

export function sessionState(s: any): SessionState {
  if (!s) return "unknown";
  if (s.status === "queued" || s.status === "running") return "live";
  if (typeof s.pid === "number" && pidAlive(s.pid)) return "live";
  return "dead";
}

/**
 * Живые сессии демона в каталоге данных (агент работает — трогать нельзя).
 *
 * Статус — не единственный признак живости: у сессии может быть живой
 * процесс агента, даже когда статус врёт. Так и случилось: «send» в режиме
 * «Задача (CLI)» поднимает второй процесс, и его выход объявлял сессию
 * готовой, пока основной агент ещё работал — набор сносил копию проекта под
 * живым агентом. Поэтому смотрим и на pid.
 */
export function liveSessionsIn(dir: string): any[] {
  try {
    const db = JSON.parse(readFileSync(join(dir, "db.json"), "utf8"));
    const list = Array.isArray(db?.sessions) ? db.sessions : [];
    return list.filter((s: any) => {
      // pid известен — верим процессу: статус врёт в обе стороны. «running» с
      // мёртвым pid — это демон, который умер, не обновив статус (агент уже
      // закончил): такой каталог можно убирать, иначе песочница растёт вечно.
      if (typeof s?.pid === "number") {
        if (pidAlive(s.pid)) return true;
        // …но pid — не всегда агент. opencode отдаёт ход своему сервису
        // (`opencode-cli.exe run` — клиент, работа идёт в сервисе): клиент умер,
        // а агент ещё работает. Тогда решает активность (F_VER-4): статус тут
        // ничего не значит — «stopped» мог поставить тот же уборщик, решивший,
        // что pid мёртв ⇒ агент мёртв.
        return recentActivity(s, dir);
      }
      // pid неизвестен (сессия в очереди или pid не записан) — верим статусу.
      return s?.status === "queued" || s?.status === "running";
    });
  } catch { return []; }
}

/**
 * Окно свежести активности: пока следы работы не старше этого времени,
 * сессия считается живой.
 *
 * Сколько именно — не критично: набор ждёт агента 2 минуты, демон может
 * умереть раньше. Окно нужно, чтобы «мёртвый pid + недавняя работа» не
 * выглядели как «агент закончил».
 */
const ACTIVITY_WINDOW_MS = Number(process.env.E2E_ACTIVITY_WINDOW_MS ?? 10 * 60_000);

/** Новейшее время изменения в папке (ограниченный обход): 0 — пусто. */
function newestMtime(dir: string, depth = 3): number {
  let newest = 0;
  const walk = (d: string, level: number): void => {
    if (level > depth) return;
    let entries: any[] = [];
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(d, e.name);
      try {
        const st = statSync(p);
        if (st.mtimeMs > newest) newest = st.mtimeMs;
        if (e.isDirectory()) walk(p, level + 1);
      } catch { /* занято — пропускаем */ }
    }
  };
  walk(dir, 0);
  return newest;
}

/**
 * Решение по уборке: сносить ли сессию (а с ней и копию проекта агента).
 *
 *   keep-live    — агент работает: не трогаем ничего;
 *   keep-unknown — состояние не узнали (демон не ответил, сессия не найдена):
 *                  это НЕ «мёртвый агент», сносить нельзя;
 *   keep-busy    — формально завершена, но видно свежую активность: агент
 *                  (в сервисе агента) ещё может работать — F_VER-4;
 *   drop         — завершена и активности нет: сносим.
 *
 * Правило живёт здесь, а не в наборе, — иначе оно живёт в копии правил
 * (F_VER-5: прогон со старой копией снёс рабочую папку живого агента, а
 * набор отчитался зелёным). Здесь же оно проверяется тестом.
 */
export type CleanupPlan = "keep-live" | "keep-unknown" | "keep-busy" | "drop";

export function cleanupPlan(s: any, dir: string): CleanupPlan {
  if (!s) return "keep-unknown";
  const state = sessionState(s);
  if (state === "live") return "keep-live";
  if (state === "unknown") return "keep-unknown";
  if (recentActivity(s, dir)) return "keep-busy";
  return "drop";
}

/**
 * Свежая ли активность сессии: копию или журнал трогали недавно.
 *
 * Нужно, потому что pid сессии — не всегда агент (F_VER-4): opencode отдаёт
 * ход сервису, клиент умирает, а агент (в сервисе) работает дальше. Тогда
 * «pid мёртв» ≠ «агент умер», и уборка по одному pid сносила рабочую папку
 * живого агента («Working directory does not exist», правки терялись).
 *
 * Следы жизни: правки в копии проекта и журнал сессии (<data>/logs/<id>.log).
 */
export function recentActivity(s: any, dir: string, now = Date.now()): boolean {
  const fresh = (t: number) => t > 0 && now - t <= ACTIVITY_WINDOW_MS;
  const wt = (s as any)?.worktree?.path;
  if (typeof wt === "string") {
    try { if (fresh(statSync(wt).mtimeMs)) return true; } catch { /* копии нет */ }
    if (fresh(newestMtime(wt))) return true;
  }
  const id = (s as any)?.id;
  if (typeof id === "string") {
    try { if (fresh(statSync(join(dir, "logs", `${id}.log`)).mtimeMs)) return true; } catch { /* журнала нет */ }
  }
  // Демон трогал сессию недавно (updatedAt) — тоже след жизни.
  const upd = (s as any)?.updatedAt;
  if (typeof upd === "number" && fresh(upd)) return true;
  return false;
}

/** Реестр копий проекта (data/work/registry.json). */
export function registryEntries(dir: string): any[] {
  try {
    const raw = JSON.parse(readFileSync(join(dir, "work", "registry.json"), "utf8"));
    return Array.isArray(raw) ? raw : [];
  } catch { return []; }
}

/**
 * Рабочие папки агентов в каталоге данных (data/work/<id>) — там, где агент
 * пишет правки.
 *
 * Считаются и без реестра: демон мог не успеть (или не сумел) записать
 * метаданные, а папка агента уже есть. Такой каталог сносить нельзя — агент
 * потеряет рабочую папку («Working directory does not exist»).
 */
export function workCopiesIn(dir: string): string[] {
  try {
    return readdirSync(join(dir, "work"), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch { return []; }
}

/** Метка набора в его каталоге данных: кто им владеет. */
export interface SuiteMarker { pid: number; port: number; startedAt: number; }

export function markerFile(dir: string): string {
  return join(dir, "suite.json");
}

export function writeMarker(dir: string, marker: SuiteMarker): void {
  try { writeFileSync(markerFile(dir), JSON.stringify(marker, null, 2), "utf8"); } catch { /* метка — не критична */ }
}

export function readMarker(dir: string): SuiteMarker | null {
  try {
    const raw = JSON.parse(readFileSync(markerFile(dir), "utf8"));
    return typeof raw?.pid === "number" ? raw as SuiteMarker : null;
  } catch { return null; }
}

/**
 * Проверяет, что каталог вообще можно сносить, и объясняет, почему нельзя.
 * Это «жёсткая» часть правил: даже набор, который считает каталог своим,
 * не имеет права удалить:
 *   • корень диска или временной папки;
 *   • каталог вне временной папки;
 *   • каталог данных живого демона (DIRIGO_DATA) и его родителя;
 *   • родителя рабочего каталога набора (внутри может лежать папка агента).
 */
export function assertDisposableDataDir(dir: string, env: { tmp?: string; cwd?: string; dataDir?: string } = {}): string {
  const target = resolve(dir);
  const tmp = resolve(env.tmp ?? tmpdir());
  if (target === tmp || target === parse(target).root) return "это корень временной папки";
  if (!target.startsWith(tmp + sep)) return "каталог вне временной папки";
  const rawData = env.dataDir ?? process.env.DIRIGO_DATA;
  const data = rawData ? resolve(rawData) : undefined;
  if (data && (target === data || data.startsWith(target + sep))) return "там лежат данные dirigo (DIRIGO_DATA)";
  const cwd = resolve(env.cwd ?? process.cwd());
  if (target === cwd || cwd.startsWith(target + sep)) return "рабочий каталог лежит внутри него";
  return "";
}

/**
 * Копии, которыми уже никто не владеет: сессия мертва (pid известен и мёртв).
 *
 * Проблема (F_VER-2, 20.10): папка копии остаётся после смерти агента, и
 * правило «рабочие папки агентов» держит каталог данных навсегда — песочница
 * наборов в tmp растёт (563 каталога, 402 «живые» только из-за таких записей).
 *
 * Правило то же, что у живых сессий: pid известен — верим процессу; pid мёртв →
 * копия ничья, её можно убрать. Метаданных нет вовсе — не верим ничему и
 * держим папку (сценарий 4 регресс-набора: демон мог не успеть записать).
 *
 * Исключение (F_VER-4): pid мёртв, а по копии или журналу видно свежую
 * активность — агент (в сервисе агента) ещё работает, папка его.
 *
 * Ошибка здесь не страшна: снос всё равно идёт переименованием, а папку,
 * которую держит процесс, переименовать нельзя (Windows, EBUSY) — на Linux
 * это ловит dirHeldByProcess (/proc/<pid>/cwd). Политика может ошибиться,
 * механизм — нет.
 */
export function deadSessionCopies(dir: string): Set<string> {
  const out = new Set<string>();
  try {
    const db = JSON.parse(readFileSync(join(dir, "db.json"), "utf8"));
    const list = Array.isArray(db?.sessions) ? db.sessions : [];
    for (const s of list) {
      const p = (s as any)?.worktree?.path;
      if (typeof p !== "string") continue;
      if (typeof (s as any)?.pid !== "number") continue; // pid неизвестен — верим статусу
      if (pidAlive((s as any).pid)) continue; // живой агент — папка его
      if (recentActivity(s, dir)) continue; // F_VER-4: pid клиента мёртв, а агент (в сервисе) работает — папка его
      out.add(resolve(p).toLowerCase());
    }
  } catch { /* метаданных нет — ничего не считаем мёртвым */ }
  return out;
}

/**
 * Можно ли сносить каталог данных?
 *   • не наш (вне песочницы) — нельзя никогда;
 *   • жёсткие правила (см. assertDisposableDataDir) — нельзя никогда;
 *   • набор им ещё владеет (метка, pid жив) — нельзя: набор работает;
 *   • живая сессия (агент работает) — нельзя: её рабочая копия внутри;
 *   • неубранные копии — нельзя: папку может держать процесс, обычный
 *     `rm -r` снёс бы её файлы наполовину (как и случилось с живым агентом);
 *   • рабочие папки агентов без реестра — нельзя: метаданных демона может не
 *     быть (потерялись/не успели), а папка агента — есть; снос отнял бы у него
 *     рабочую папку. Исключение — копия сессии, чей агент умер (pid мёртв
 *     и свежей активности нет): она ничья, и из-за неё каталог живёт вечно.
 *   • pid мёртв — не значит «агент умер» (F_VER-4): у opencode pid — это
 *     клиент, а работает сервис. Если по копии или журналу видно свежую
 *     активность, сессия живая: её каталог не сносим.
 */
export function canRemoveDataDir(dir: string, opts: { ignorePid?: number; cwd?: string; dataDir?: string } = {}): { ok: boolean; reason: string } {
  if (!existsSync(dir)) return { ok: true, reason: "каталога нет" };
  if (!isInside(dir, sandboxRoot())) return { ok: false, reason: "каталог не наш" };
  const hard = assertDisposableDataDir(dir, { cwd: opts.cwd, dataDir: opts.dataDir });
  if (hard) return { ok: false, reason: hard };
  const marker = readMarker(dir);
  if (marker && marker.pid !== opts.ignorePid && pidAlive(marker.pid)) {
    return { ok: false, reason: `каталог занят набором (pid ${marker.pid})` };
  }
  const live = liveSessionsIn(dir);
  if (live.length) return { ok: false, reason: `живых сессий: ${live.length}` };
  // Копии умерших сессий — ничьи: они не держат каталог (см. deadSessionCopies).
  const dead = deadSessionCopies(dir);
  const left = registryEntries(dir).filter((e) => e?.path && existsSync(e.path) && !dead.has(resolve(e.path).toLowerCase()));
  if (left.length) return { ok: false, reason: `неубранных копий: ${left.length}` };
  const work = workCopiesIn(dir).filter((name) => !dead.has(resolve(join(dir, "work", name)).toLowerCase()));
  if (work.length) return { ok: false, reason: `рабочих папок агента: ${work.length}` };
  return { ok: true, reason: "живого нет" };
}

/**
 * Держит ли кто-то папку своим рабочим каталогом? (Linux: каталог cwd в /proc)
 *
 * На Windows это ловит переименование (см. removeTreeSafely): папку, занятую
 * процессом, переименовать нельзя (EBUSY). На Linux переименование проходит,
 * поэтому там смотрим /proc: у процесса, ушедшего в папку, ссылка cwd в
 * /proc указывает на неё.
 */
export function dirHeldByProcess(path: string): boolean {
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
 * Снести каталог, не рубя его наполовину.
 *
 * На Windows папку, которую держит процесс (рабочий каталог агента), нельзя
 * переименовать — EBUSY. Поэтому сначала атомарное переименование «в сторону»:
 * не прошло — папку не трогаем вообще (это и есть проверка «здесь кто-то
 * работает»); прошло — каталог отставлен и его можно сносить целиком.
 * Обычный `rm -r` здесь не годится: он сносит файлы внутри занятой папки и
 * падает на самой папке — агент теряет рабочую папку и правки.
 */
export function removeTreeSafely(dir: string): { ok: boolean; detail: string; movedTo?: string } {
  if (!existsSync(dir)) return { ok: true, detail: "каталога нет" };
  if (dirHeldByProcess(dir)) return { ok: false, detail: "папку держит живой процесс" };
  const aside = `${dir}.deleting-${Date.now()}`;
  try {
    renameSync(dir, aside);
  } catch (e) {
    return { ok: false, detail: `каталог держит процесс: ${String(e).slice(0, 160)}` };
  }
  try {
    rmSync(aside, { recursive: true, force: true });
  } catch (e) {
    return { ok: false, detail: `файлы держат — отложено: ${String(e).slice(0, 160)}`, movedTo: aside };
  }
  return { ok: true, detail: "" };
}

/**
 * Каталог данных набора — свой, и НЕ тот, где что-то живое.
 * Занятый каталог не трогаем: в нём может жить сессия другого демона, копия
 * чужого агента или незавершённый прошлый прогон.
 */
export function pickDataDir(port: number, pid = process.pid): string {
  const wanted = dataDirFor(port);
  if (!existsSync(wanted)) return wanted;
  const can = canRemoveDataDir(wanted);
  if (can.ok && removeTreeSafely(wanted).ok) return wanted; // от прошлого прогона, живого нет
  return `${wanted}__${pid}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Метка демона: чей это демон (F_VER-7).
 *
 * Набор e2e поднимает СВОЕГО демона и должен убедиться, что отвечает он, а не
 * тот, кто занял порт между проверкой и стартом. Прежняя проверка («в каталоге
 * данных есть logs/») этого не доказывала: logs/ создаёт store.ts при импорте,
 * ДО попытки занять порт, — её создаёт и демон, которому порт не достался.
 *
 * Теперь признак — файл daemon.json в каталоге данных: демон пишет его ПОСЛЕ
 * того, как занял порт, поэтому его создал ровно тот, кто слушает этот порт.
 * Демон, которому порт не достался, метку не пишет — набор это видит.
 *
 * Правило живёт здесь, а не в наборе: иначе оно живёт в копии правил
 * (F_VER-5: прогон со старой копией правил снёс рабочую папку живого агента, а
 * набор отчитался зелёным). Здесь же оно проверяется тестом.
 */
export const DAEMON_MARK = "daemon.json";

/** Метка демона в каталоге данных (путь). */
export function daemonMarkPath(dataDir: string): string {
  return join(dataDir, DAEMON_MARK);
}

/**
 * Демон в каталоге данных — наш?
 *
 * ok=true — метка есть и указывает на наш порт: демон, который её написал,
 * слушает именно наш порт.
 * ok=false — метки нет (демон не сумел занять порт: отвечает чужой) либо она
 * указывает на другой порт.
 */
export function ownDaemon(dataDir: string, port: number): { ok: boolean; reason: string } {
  const mark = daemonMarkPath(dataDir);
  if (!existsSync(mark)) return { ok: false, reason: "нет метки daemon.json (порт не достался нашему демону)" };
  let raw: any;
  try { raw = JSON.parse(readFileSync(mark, "utf8")); } catch { return { ok: false, reason: "метка daemon.json не читается" }; }
  if (raw?.port !== port) return { ok: false, reason: `метка указывает на порт ${raw?.port}, а набор на ${port}` };
  return { ok: true, reason: `метка нашего демона (порт ${port}, pid ${raw?.pid ?? "?"})` };
}

/**
 * Подчистить песочницу от прогонов, где ничего не живёт.
 * Свежие каталоги не трогаем: набор мог ещё не записать db.json.
 */
export function sweepSandbox(keep: string[] = [], minAgeMs = 30 * 60 * 1000): string[] {
  const root = sandboxRoot();
  if (!existsSync(root)) return [];
  const removed: string[] = [];
  let entries: string[] = [];
  try { entries = readdirSync(root); } catch { return []; }
  for (const name of entries) {
    if (!/^(cli-e2e|proj)-/.test(name)) continue;
    const dir = join(root, name);
    if (keep.some((k) => resolve(k).toLowerCase() === resolve(dir).toLowerCase())) continue;
    try { if (Date.now() - statSync(dir).mtimeMs < minAgeMs) continue; } catch { continue; }
    if (!canRemoveDataDir(dir).ok) continue; // живое — не трогаем
    if (removeTreeSafely(dir).ok) removed.push(dir);
  }
  return removed;
}

/** Порт свободен (никто не слушает)? */
export function portFree(port: number): boolean {
  try {
    const s = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {}, open() {}, close() {}, error() {} } });
    s.stop(true);
    return true;
  } catch { return false; }
}

/** Каталоги, которые при копировании проекта пропускаем. */
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", ".cache", "coverage"]);

/** Похож ли каталог на каталог данных dirigo (данные демона, копии проектов)? */
function looksLikeDataDir(dir: string): boolean {
  try {
    if (existsSync(join(dir, "work", "registry.json"))) return true;
    if (existsSync(join(dir, "db.json")) && existsSync(join(dir, "work"))) return true;
    return false;
  } catch { return false; }
}

/** Копирование проекта в черновик: без .git и node_modules (как копия демона). */
function copyProject(src: string, dst: string, depth = 0): void {
  if (depth > 40) return;
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    // .git бывает и ФАЙЛОМ — указателем на worktree («gitdir: …»). Такой
    // указатель в черновике ломает git: «fatal: not a git repository» — демон
    // не сможет создать свой репозиторий проекта, и сессия не получит копию.
    // Черновик — это копия проекта без служебных файлов git в любом виде.
    if (entry.name === ".git") continue;
    const from = join(src, entry.name);
    const to = join(dst, entry.name);
    if (entry.isDirectory()) {
      if (looksLikeDataDir(from)) continue; // каталог данных демона — в черновик не место
      copyProject(from, to, depth + 1);
    } else if (entry.isFile()) { try { writeFileSync(to, readFileSync(from)); } catch { /* занято — пропускаем */ } }
  }
}

/**
 * Черновик проекта для набора: копия проекта в песочнице.
 *
 * Именно копия, а не пустышка: живой агент должен работать с настоящим
 * проектом (иначе сценарий «агент сделал правки, набор их видит» нечего
 * проверять). Отдельная папка — чтобы «apply» переносил правки агента сюда,
 * а не в репозиторий разработчика.
 */
export function makeScratchProject(dir: string, from?: string): void {
  if (from && existsSync(from)) { copyProject(from, dir); return; }
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "README.md"), "# cli-e2e\n\nчерновик проекта набора\n", "utf8");
  writeFileSync(join(dir, "src", "app.txt"), "черновик\n", "utf8");
}

/** Свой порт демона: запрошенный, если свободен, иначе соседний свободный. */
export function pickPort(want: number): number {
  if (portFree(want)) return want;
  for (let p = want + 1; p < want + 60; p++) if (!RESERVED_PORTS.has(p) && portFree(p)) return p;
  for (let p = want - 1; p > want - 30; p--) if (!RESERVED_PORTS.has(p) && portFree(p)) return p;
  throw new Error(`нет свободного порта рядом с ${want}`);
}
