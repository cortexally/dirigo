// PTY-слой — ОПЦИОНАЛЬНЫЙ. node-pty — нативный модуль (ConPTY на Windows,
// forkpty на Unix). На чистой машине (установка по install.sh) собранного
// бинарника может не быть: демон обязан стартовать и работать без него,
// деградируя только PTY-функции. Раньше здесь стоял статический import —
// он валил ВЕСЬ сервер на Linux/macOS ещё до Bun.serve.
import { secretsEnv } from "../secrets";

export interface PtyHandle {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  pid: number;
  /** Чем на самом деле запущено: настоящий PTY или пайп-фолбэк без TTY. */
  kind: "pty" | "pipe";
  /** false — размер фиксирован при старте (script(1)): окно подстраивается под него. */
  resizable?: boolean;
}

export interface SpawnOpts {
  cwd?: string;
  cols?: number;
  rows?: number;
  env?: Record<string, string>;
  onData: (chunk: string) => void;
  onExit: (code: number) => void;
}

const WIN = process.platform === "win32";

/** Шелл-экранирование для `script -c "<команда>"` (Linux). */
function shq(parts: string[]): string {
  return parts.map((a) => `'${a.replaceAll("'", `'\''`)}'`).join(" ");
}

/**
 * Unix-провайдер PTY через `script(1)` — утилита из util-linux/BSD, которая
 * сама создаёт псевдотерминал и прокидывает его в обычные stdin/stdout.
 *
 * Зачем он вместо node-pty: под Bun нативный node-pty на Linux отдаёт первые
 * байты и тут же роняет ребёнка SIGHUP (exit {code:0, signal:1}) — TUI-агент
 * выглядит как мгновенно закрывшаяся пустая сессия. `script` работает через
 * обычный pipe-интерфейс Bun, не требует ни компилятора, ни node_modules,
 * и есть в любой базовой установке Linux/macOS.
 */
function spawnViaScript(file: string, args: string[], opts: SpawnOpts): PtyHandle {
  const cols = opts.cols ?? 160;
  const rows = opts.rows ?? 40;
  const env = { ...process.env, ...secretsEnv(opts.cwd), ...(opts.env ?? {}) } as Record<string, string>;
  if (!env.TERM || env.TERM === "dumb") env.TERM = "xterm-256color";
  if (!env.COLORTERM) env.COLORTERM = "truecolor";
  env.COLUMNS = String(cols);
  env.LINES = String(rows);

  // BSD (macOS): script [-q] file command args...   GNU: script -qfec "cmd" file
  const argv = process.platform === "darwin"
    ? ["script", "-q", "/dev/null", file, ...args]
    : ["script", "-qfec", `stty rows ${rows} cols ${cols} 2>/dev/null; ${shq([file, ...args])}`, "/dev/null"];

  const proc = Bun.spawn(argv, {
    cwd: opts.cwd ?? process.cwd(),
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const dec = new TextDecoder();
  const pump = async (stream: ReadableStream<Uint8Array> | null) => {
    if (!stream) return;
    try { for await (const chunk of stream as any) opts.onData(dec.decode(chunk)); }
    catch { /* поток закрыт вместе с процессом */ }
  };
  void pump(proc.stdout as any);
  void pump(proc.stderr as any);
  void proc.exited.then((code) => opts.onExit(code ?? 0));

  const w = proc.stdin as any;
  return {
    write: (d) => { try { w?.write(d); w?.flush?.(); } catch { /* процесс закрыт */ } },
    // Размер фиксируется при старте: внешне менять геометрию чужого pty нечем,
    // а менять её командой в stdin небезопасно — это попадёт в ввод агента.
    resize: () => { /* не поддерживается этим провайдером */ },
    kill: () => { try { proc.kill(); } catch { /* уже мёртв */ } },
    pid: proc.pid,
    kind: "pty",
    resizable: false,
  };
}

export const PTY_HINT =
  "нативный модуль node-pty не собран для этой платформы; " +
  "починить: bun install (нужны python3, make, g++/clang)";

let mod: any = null;
let loadError: string | null = null;
let tried = false;

/** Ленивая загрузка node-pty: один раз, ошибка запоминается и не бросается. */
async function loadPty(): Promise<any> {
  if (tried) return mod;
  tried = true;
  try {
    const m: any = await import("node-pty");
    mod = m?.default ?? m;
    if (typeof mod?.spawn !== "function") {
      mod = null;
      loadError = "node-pty загрузился без spawn()";
    }
  } catch (e) {
    mod = null;
    loadError = String((e as Error)?.message ?? e).split("\n")[0]!;
  }
  return mod;
}

/** Доступен ли настоящий PTY. Используется /api/health и UI (режимы агентов). */
export async function ptyStatus(): Promise<{ available: boolean; reason: string | null; provider?: string }> {
  if (!WIN && Bun.which("script")) return { available: true, reason: null, provider: "script" };
  const m = await loadPty();
  if (m) return { available: true, reason: null, provider: "node-pty" };
  return {
    available: false,
    reason: WIN ? (loadError ?? PTY_HINT) : "не найдена утилита script(1) и не собран node-pty",
  };
}

/** Запуск в настоящем PTY. Бросает понятную ошибку, если модуль недоступен. */
export async function spawnPty(file: string, args: string[], opts: SpawnOpts): Promise<PtyHandle> {
  // На Unix сначала script(1): он надёжнее под Bun (см. комментарий к
  // spawnViaScript). node-pty остаётся для Windows (ConPTY) и как запасной.
  if (!WIN && Bun.which("script")) return spawnViaScript(file, args, opts);
  const m = await loadPty();
  if (!m) throw new Error(`PTY недоступен: ${loadError ?? PTY_HINT}`);
  // Демон запускают из systemd/nohup, где TERM пуст или "dumb". Современные
  // TUI (opentui, ink) на таком терминале молча выходят с кодом 0 — именно так
  // «Терминал» и выглядел как мгновенно завершившаяся пустая сессия. Терминал
  // в пульте — полноценный xterm, поэтому и объявляем его честно.
  const env = { ...process.env, ...secretsEnv(opts.cwd), ...(opts.env ?? {}) } as Record<string, string>;
  if (!env.TERM || env.TERM === "dumb") env.TERM = "xterm-256color";
  if (!env.COLORTERM) env.COLORTERM = "truecolor";
  const base = {
    name: env.TERM,
    cols: opts.cols ?? 160,
    rows: opts.rows ?? 40,
    cwd: opts.cwd ?? process.cwd(),
    env,
  };
  // Windows: ConPTY из комплекта node-pty (OpenConsole 1.23) вместо системного.
  // Системный conhost сам перерисовывает поток TUI и глотает запросы терминала
  // (OSC 10/11 до нас не доходили, CSI 6n он отвечал по своему экрану) — агенты
  // не узнавали тему пульта, а вывод TUI местами перемешивался. Свежий ConPTY
  // работает в passthrough-режиме. Не поднялся — откатываемся на системный.
  let proc: any;
  if (WIN && process.env.DIRIGO_SYSTEM_CONPTY !== "1") {
    try { proc = m.spawn(file, args, { ...base, useConptyDll: true }); } catch { proc = null; }
  }
  proc ??= m.spawn(file, args, base);
  proc.onData(opts.onData);
  // exitCode бывает пустым (процесс снят извне) — тогда «-1», а не «код undefined»
  proc.onExit((e: { exitCode?: number; signal?: number }) => opts.onExit(typeof e?.exitCode === "number" ? e.exitCode : e?.signal ? 128 + e.signal : -1));
  return {
    write: (d) => proc.write(d),
    resize: (c, r) => { try { proc.resize(c, r); } catch { /* процесс закрыт */ } },
    kill: () => proc.kill(),
    pid: proc.pid,
    kind: "pty",
  };
}

/**
 * Фолбэк без TTY: обычный процесс с пайпами. Команды выполняются и печатают
 * вывод, но нет ни эха, ни промпта, ни курсорных последовательностей — TUI
 * (hermes --tui, devin REPL) так работать не будет, а `git status`/`bun test`
 * в терминале пульта — будет.
 */
export function spawnPipe(file: string, args: string[], opts: SpawnOpts): PtyHandle {
  const proc = Bun.spawn([file, ...args], {
    cwd: opts.cwd ?? process.cwd(),
    env: { ...process.env, ...secretsEnv(opts.cwd), ...(opts.env ?? {}) } as Record<string, string>,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const dec = new TextDecoder();
  const pump = async (stream: ReadableStream<Uint8Array> | null) => {
    if (!stream) return;
    try {
      for await (const chunk of stream as any) opts.onData(dec.decode(chunk));
    } catch { /* поток закрыт вместе с процессом */ }
  };
  void pump(proc.stdout as any);
  void pump(proc.stderr as any);
  void proc.exited.then((code) => opts.onExit(code ?? 0));
  return {
    write: (d) => {
      try {
        (proc.stdin as any)?.write(d);
        (proc.stdin as any)?.flush?.();
      } catch { /* процесс уже закрыт */ }
    },
    resize: () => { /* у пайпа нет геометрии */ },
    kill: () => { try { proc.kill(); } catch { /* уже мёртв */ } },
    pid: proc.pid,
    kind: "pipe",
  };
}

/** PTY если есть, иначе пайп. Для терминала пульта — он полезен и без TTY. */
export async function spawnTerminal(file: string, args: string[], opts: SpawnOpts): Promise<PtyHandle> {
  const m = await loadPty();
  if (m) return spawnPty(file, args, opts);
  return spawnPipe(file, args, opts);
}
