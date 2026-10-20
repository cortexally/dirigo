#!/usr/bin/env bun
// Регресс-тест контракта `--json` у CLI (scripts/orch.ts).
//
// Правило: с --json stdout — РОВНО один компактный JSON-документ (как `jq -c`):
// одна строка, без пробела после «:», JSON.parse разбирает целиком. Пояснения
// для человека (лог, конфликты, справка) — в stderr. Ошибки — тоже компактным
// JSON в stderr. Раньше местами stdout мешал JSON и человеческий текст впере-
// мешку (machine-deploy, run --wait, attach, apply-plan, справка) — парсер
// такого вывода ломался.
//
// Запуск: bun run scripts/orch-json-test.ts
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); ok ? pass++ : fail++; };

/** Свободный порт — демон набора не должен занять чужой. */
function freePort(): number {
  for (let p = 7860; p < 7960; p++) {
    try {
      const s = Bun.listen({ hostname: "127.0.0.1", port: p, socket: { data() {}, open() {}, close() {}, error() {} } });
      s.stop(true);
      return p;
    } catch { /* занят */ }
  }
  return 7860;
}

const PORT = freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = join(tmpdir(), `dirigo-orch-json-${PORT}`);
try { rmSync(DATA, { recursive: true, force: true }); } catch { /* занят — приберёт следующая чистка */ }
mkdirSync(DATA, { recursive: true });

const server = Bun.spawn([process.execPath, "run", "src/server.ts"], {
  cwd: ROOT, env: { ...process.env, PORT: String(PORT), DIRIGO_DATA: DATA } as Record<string, string>,
  stdout: "ignore", stderr: "ignore",
});
let up = false;
for (let i = 0; i < 50; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) { up = true; break; } } catch { /* ещё поднимается */ } await sleep(300); }
if (!up) { console.log("FAIL  демон не поднялся"); server.kill(); process.exit(1); }

const env = { ...process.env, DIRIGO_HOST: BASE, DIRIGO_DATA: DATA } as Record<string, string>;
const run = async (args: string[]) => {
  const p = Bun.spawn([process.execPath, "run", "scripts/orch.ts", ...args], { cwd: ROOT, env, stdout: "pipe", stderr: "pipe" });
  const out = (await new Response(p.stdout).text()).trim();
  const err = (await new Response(p.stderr).text()).trim();
  const code = await p.exited;
  return { code, out, err };
};

/** stdout — один компактный JSON-документ (или пусто, если ошибка ушла в stderr). */
const machine = (name: string, r: { code: number; out: string; err: string }) => {
  if (!r.out) {
    // Ошибка: stdout пуст, stderr — компактный JSON.
    let ok = false;
    try { JSON.parse(r.err); ok = true; } catch { ok = false; }
    check(name, ok && r.err.split("\n").length === 1, `код ${r.code} · stderr=${r.err.slice(0, 70)}`);
    return;
  }
  const oneLine = r.out.split("\n").length === 1;
  const compact = !/":\s/.test(r.out);
  let parsed = false;
  try { JSON.parse(r.out); parsed = true; } catch { parsed = false; }
  check(name, oneLine && compact && parsed, `код ${r.code} · одна строка=${oneLine} · компакт=${compact} · json=${parsed} :: ${r.out.slice(0, 70)}`);
};

/** stderr — компактный JSON (как die). */
const errIsJson = (name: string, r: { err: string }) => {
  let ok = false;
  try { JSON.parse(r.err); ok = true; } catch { ok = false; }
  check(name, ok && r.err.split("\n").length === 1, r.err.slice(0, 70));
};

// --- читающие команды ---
machine("health --json", await run(["health", "--json"]));
machine("ls --json", await run(["ls", "--json"]));
machine("setup --json", await run(["setup", "--json"]));
machine("setup-jobs --json", await run(["setup-jobs", "--json"]));
machine("machines --json", await run(["machines", "--json"]));
machine("plans --json", await run(["plans", "--json"]));
machine("tunnel --json", await run(["tunnel", "--json"]));

// --- машины: полный цикл ---
const ma = await run(["machine-add", "--at", "no-such-host.invalid", "--user", "root", "--name", "json-vps", "--json"]);
machine("machine-add --json", ma);
const maBody = ma.code === 0 ? JSON.parse(ma.out) as any : null;
check("machine-add — id и localPort", !!maBody?.id && maBody?.localPort === 8271, `${maBody?.localPort}`);
check("machine-add --json — значение без пробела после «:»", /"localPort":\d+/.test(ma.out), ma.out.slice(0, 80));
if (maBody) {
  machine("machines --json (после добавления)", await run(["machines", "--json"]));
  machine("machine-deploy --dry-run --json", await run(["machine-deploy", maBody.id, "--dry-run", "--json"]));
  // Реальный деплой на несуществующий хост — ошибка демона (409).
  const bad = await run(["machine-deploy", maBody.id, "--json"]);
  machine("machine-deploy --json (ошибка деплоя)", bad);
  errIsJson("machine-deploy — ошибка в stderr компактным JSON", bad);
  machine("machine-del --json", await run(["machine-del", maBody.id, "--json"]));
}

// --- ошибки демона: stdout пуст, stderr — JSON ---
const nf = await run(["plan", "plan_нет", "--json"]);
check("plan не найден → код 3", nf.code === 3, `${nf.code}`);
machine("plan (не найден) — stderr JSON", nf);
const df = await run(["diff", "ses_нет", "--json"]);
machine("diff (сессии нет) — stderr JSON", df);
const cf = await run(["checks", "ses_нет", "--json"]);
machine("checks (сессии нет) — stderr JSON", cf);

// --- справка: с --json stdout — JSON, текст — в stderr ---
const help = await run(["--json"]);
machine("справка --json — stdout JSON", help);
check("справка --json — текст в stderr", help.err.includes("orch — CLI пульта"), help.err.slice(0, 40));
const unknown = await run(["несуществующая", "--json"]);
machine("неизвестная команда --json — stdout JSON", unknown);
check("неизвестная команда → код 2", unknown.code === 2, `${unknown.code}`);

// --- usage-ошибка: die() — stderr JSON, stdout пуст ---
const usage = await run(["run", "--json"]);
check("usage → код 2", usage.code === 2, `${usage.code}`);
machine("usage (run без агента) — stderr JSON", usage);

server.kill();
try { rmSync(DATA, { recursive: true, force: true }); } catch { /* занято — приберёт следующая чистка */ }
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
