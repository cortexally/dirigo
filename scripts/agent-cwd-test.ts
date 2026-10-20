#!/usr/bin/env bun
// Рабочая папка агента = папка сессии, во ВСЕХ способах запуска.
//
// Регресс 18.10 (1.9.1): агенты на Bun/Node (kilo, opencode) берут рабочую
// папку из переменной PWD, а не из cwd процесса. Демон передавал свой PWD —
// kilo писал файлы туда, откуда запущен пульт (в гейте — в каталог пульта),
// а копия сессии оставалась нетронутой. ACP-процесс вообще стартовал без cwd.
// Отсюда «агент сказал, что добавил, а в диффе пусто/удалено».
//
//   bun run scripts/agent-cwd-test.ts
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  ok ? pass++ : fail++;
};
const DIR = join(tmpdir(), `dirigo-cwd-${Date.now().toString(36)}`);
mkdirSync(DIR, { recursive: true });
const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
const node = Bun.which("node") ?? process.execPath;
const probe = "console.error('CWD=' + process.cwd() + '|PWD=' + process.env.PWD); console.log('CWD=' + process.cwd() + '|PWD=' + process.env.PWD); setTimeout(()=>{}, 800)";
const parse = (text: string) => {
  const m = /CWD=([^|\r\n]*)\|PWD=([^\r\n]*)/.exec(text);
  return m ? { cwd: norm(m[1]!), pwd: norm(m[2]!.trim()) } : null;
};

// 1) окружение агента
const { secretsEnv } = await import("../src/secrets");
check("secretsEnv(cwd) ставит PWD папки агента", secretsEnv(DIR).PWD === DIR, String(secretsEnv(DIR).PWD));
check("без cwd PWD не подменяется", secretsEnv().PWD === process.env.PWD);

// 2) ACP: процесс агента в папке сессии
const { AcpClient } = await import("../src/agents/acp");
{
  let err = "";
  const c = new AcpClient([node, "-e", probe], DIR);
  c.onStderr = (t) => { err += t; };
  await Bun.sleep(1200);
  const got = parse(err + (c.stderrTail ?? []).join("\n"));
  check("ACP: cwd процесса = папка сессии", got?.cwd === norm(DIR), got?.cwd ?? "нет вывода");
  check("ACP: PWD = папка сессии", got?.pwd === norm(DIR), got?.pwd ?? "нет вывода");
  try { (c as any).proc?.kill(); } catch { /* */ }
}

// 3) PTY (терминал агента и оболочки)
const { spawnPty, ptyStatus } = await import("../src/agents/pty");
if ((await ptyStatus()).available) {
  // ConPTY шлёт экран с управляющими последовательностями — читаем через тот же Screen, что демон
  const { Screen } = await import("../src/agents/screen");
  const screen = new Screen(10, 240);
  const h = await spawnPty(node, ["-e", probe], { cwd: DIR, cols: 240, rows: 10, onData: (d) => screen.feed(d), onExit: () => {} });
  screen.onResponse = (r) => { try { h.write(r); } catch { /* */ } };
  let got: ReturnType<typeof parse> = null;
  for (let i = 0; i < 20 && !got; i++) { await Bun.sleep(250); got = parse(screen.plain()); }
  const out = screen.plain();
  try { h.kill(); } catch { /* */ }
  check("PTY: cwd = папка сессии", got?.cwd === norm(DIR), got?.cwd ?? out.slice(0, 80));
  check("PTY: PWD = папка сессии", got?.pwd === norm(DIR), got?.pwd ?? "");
} else console.log("SKIP  PTY недоступен");

// 4) все запуски агентов передают папку (статическая страховка от нового spawn без неё)
const src = (f: string) => readFileSync(join(import.meta.dir, "..", "src", "agents", f), "utf8");
check("runner: Bun.spawn агентов — с secretsEnv(cwd)", !/Bun\.spawn\([^)]*secretsEnv\(\)/.test(src("runner.ts")));
check("acp: процесс с cwd", /new AcpClient\(def\.acp\.command, cwd\)/.test(src("runner.ts")) && /secretsEnv\(cwd\)/.test(src("acp.ts")));
check("pty: окружение с PWD", !/secretsEnv\(\)/.test(src("pty.ts")));

for (let i = 0; i < 5; i++) { try { rmSync(DIR, { recursive: true, force: true }); break; } catch { await Bun.sleep(500); } }
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
