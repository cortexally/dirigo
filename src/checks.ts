// Dirigo — авто-проверки проекта (ревью-первый поток, V2-2.1/2.2).
//
// Детект команд проверок проекта (package.json / Makefile / pytest / cargo / just / go)
// и прогон их в КОПИИ проекта до показа результата пользователю. Фейл → возврат агенту.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface DetectedChecks {
  /** команды для запуска (argv) */
  commands: string[][];
  /** откуда взялись (для UI/логов) */
  source: string;
  /** пакетный менеджер проекта */
  pm: "bun" | "npm" | "pnpm" | "yarn";
}

const MAX_COMMANDS = 3;

/**
 * Пакетный менеджер по lock-файлу. Дефолт — bun: демон сам работает на Bun,
 * а npm на Windows тянет cmd.exe, где кавычки/exit-коды живут по другим
 * правилам (проверка может «пройти» ложно). npm берём только по его lock-файлу.
 */
function detectPm(dir: string): DetectedChecks["pm"] {
  if (existsSync(join(dir, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(dir, "yarn.lock"))) return "yarn";
  if (existsSync(join(dir, "package-lock.json"))) return "npm";
  return "bun";
}

/** Приоритетные npm-скрипты проверок. */
const SCRIPT_PRIORITY = ["test", "lint", "typecheck", "check", "build"];

function detectPackageJson(dir: string): string[][] | null {
  const pkgPath = join(dir, "package.json");
  if (!existsSync(pkgPath)) return null;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, string>; packageManager?: string };
    const pm = pkg.packageManager?.startsWith("pnpm") ? "pnpm"
      : pkg.packageManager?.startsWith("yarn") ? "yarn"
      : pkg.packageManager?.startsWith("npm") ? "npm"
      : detectPm(dir);
    const bin = pm === "npm" ? "npm" : pm; // bun/pnpm/yarn — прямой вызов
    const cmds: string[][] = [];
    for (const name of SCRIPT_PRIORITY) {
      if (pkg.scripts?.[name]) cmds.push([bin, "run", name]);
      if (cmds.length >= MAX_COMMANDS) break;
    }
    return cmds.length ? cmds : null;
  } catch { return null; }
}

/** Цели Makefile: строки вида `test:` / `check:` в начале строки. */
function detectMakefile(dir: string): string[][] | null {
  for (const name of ["Makefile", "makefile", "GNUmakefile"]) {
    const p = join(dir, name);
    if (!existsSync(p)) continue;
    const text = readFileSync(p, "utf8");
    const cmds: string[][] = [];
    for (const target of ["test", "check", "lint"]) {
      if (new RegExp(`^${target}\\s*:`, "m").test(text)) cmds.push(["make", target]);
    }
    if (cmds.length) return cmds;
  }
  return null;
}

/** pytest: ini/toml-секция/каталог tests. */
function detectPytest(dir: string): string[][] | null {
  if (existsSync(join(dir, "pytest.ini")) || existsSync(join(dir, "tox.ini"))) return [["python", "-m", "pytest", "-q"]];
  const pyproject = join(dir, "pyproject.toml");
  if (existsSync(pyproject)) {
    const text = readFileSync(pyproject, "utf8");
    if (/\[tool\.pytest/.test(text) || /\[tool\.poetry/.test(text)) return [["python", "-m", "pytest", "-q"]];
  }
  if (existsSync(join(dir, "tests")) || existsSync(join(dir, "test"))) return [["python", "-m", "pytest", "-q"]];
  return null;
}

function detectCargo(dir: string): string[][] | null {
  return existsSync(join(dir, "Cargo.toml")) ? [["cargo", "test"]] : null;
}

function detectJust(dir: string): string[][] | null {
  for (const name of ["justfile", "Justfile", ".justfile"]) {
    const p = join(dir, name);
    if (!existsSync(p)) continue;
    const text = readFileSync(p, "utf8");
    const cmds: string[][] = [];
    for (const recipe of ["test", "check"]) {
      if (new RegExp(`^${recipe}\\s*:`, "m").test(text)) cmds.push(["just", recipe]);
    }
    if (cmds.length) return cmds;
  }
  return null;
}

function detectGo(dir: string): string[][] | null {
  return existsSync(join(dir, "go.mod")) ? [["go", "test", "./..."]] : null;
}

/**
 * Что проверять в проекте. Порядок: package.json → Makefile → just → cargo →
 * pytest → go. Первый совпавший источник даёт до 3 команд.
 */
export function detectChecks(dir: string): DetectedChecks | null {
  const detectors: [string, (d: string) => string[][] | null][] = [
    ["package.json scripts", detectPackageJson],
    ["Makefile", detectMakefile],
    ["justfile", detectJust],
    ["Cargo.toml", detectCargo],
    ["pytest", detectPytest],
    ["go.mod", detectGo],
  ];
  for (const [source, fn] of detectors) {
    const cmds = fn(dir);
    if (cmds?.length) return { commands: cmds.slice(0, MAX_COMMANDS), source, pm: detectPm(dir) };
  }
  return null;
}

/* ---------------- прогон ---------------- */

export interface CheckOutcome {
  command: string;
  ok: boolean;
  output: string;   // хвост вывода (до 60 строк)
  durationMs: number;
}

export interface ChecksReport {
  ok: boolean;
  outcomes: CheckOutcome[];
  source: string | null;
}

const TAIL_LINES = 60;

function tail(text: string): string {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  return lines.slice(-TAIL_LINES).join("\n");
}

/** Один запуск с таймаутом. */
async function runOne(cmd: string[], cwd: string, timeoutMs: number): Promise<CheckOutcome> {
  const started = Date.now();
  try {
    const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const timer = setTimeout(() => { try { proc.kill(); } catch { /* уже мёртв */ } }, timeoutMs);
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);
    return {
      command: cmd.join(" "),
      ok: code === 0,
      output: tail((out + "\n" + err).trim()),
      durationMs: Date.now() - started,
    };
  } catch (e) {
    return { command: cmd.join(" "), ok: false, output: `запуск не удался: ${String(e)}`, durationMs: Date.now() - started };
  }
}

/**
 * Прогон всех обнаруженных проверок в копии. Последовательно (ресурсы),
 * до первой неудачи не останавливаемся — пользователю нужен полный отчёт.
 */
export async function runChecks(dir: string, timeoutMs = 180_000): Promise<ChecksReport> {
  const detected = detectChecks(dir);
  // Нечего проверять — это не провал: возвращать агенту нечего, результат
  // (дифф) можно показывать. Иначе пустой отчёт уходил агенту без деталей.
  if (!detected) return { ok: true, outcomes: [], source: null };
  const outcomes: CheckOutcome[] = [];
  for (const cmd of detected.commands) {
    outcomes.push(await runOne(cmd, dir, timeoutMs));
  }
  return { ok: outcomes.every((o) => o.ok), outcomes, source: detected.source };
}

/**
 * v2: проверка с override — если у сессии задана своя команда (V3-4),
 * гоняем её (через shell ОС) вместо детекта. Пустая команда → как обычно.
 */
export async function runChecksOverride(dir: string, command?: string | null, timeoutMs = 180_000): Promise<ChecksReport> {
  const cmd = command?.trim();
  if (!cmd) return runChecks(dir, timeoutMs);
  const argv = process.platform === "win32" ? ["cmd", "/d", "/s", "/c", cmd] : ["bash", "-lc", cmd];
  const outcome = await runOne(argv, dir, timeoutMs);
  return { ok: outcome.ok, outcomes: [outcome], source: `session: ${cmd}`.slice(0, 80) };
}

/** Формат отчёта для промпта агенту (возврат на доработку). */
export function checksFeedbackPrompt(report: ChecksReport): string {
  const failed = report.outcomes.filter((o) => !o.ok);
  const lines = failed.map((o) => `$ ${o.command}\n${o.output.slice(-2000)}`).join("\n\n---\n\n");
  return [
    "Авто-проверки проекта упали — результат ещё НЕ показан пользователю.",
    "Исправь причину в файлах копии и не меняй подход без необходимости.",
    "",
    lines,
  ].join("\n");
}
