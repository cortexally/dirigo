#!/usr/bin/env bun
// Регресс-тест живости сессии: сессия не должна выглядеть завершённой, пока
// жив её агент.
//
// Откуда тест. Набор e2e-cli решает по статусу сессии, можно ли сносить её
// копию проекта. Статус врал, когда в сессии ДВА запуска агента: «send» в
// режиме «Задача (CLI)» поднимает второй процесс, и его выход ставит сессии
// «готово», хотя первый агент ещё работает. Набор видел «неживую» сессию,
// удалял её — и у живого агента пропадала рабочая папка
// («Working directory does not exist»), а вместе с ней и правки.
//
// Сценарий: запускаем стаб-агента (спит заданное число мс), поверх него —
// короткий второй запуск («сообщение»). Пока жив первый:
//   • статус сессии не терминальный;
//   • сессия считается живой;
//   • pid сессии принадлежит живому процессу;
//   • «Стоп» гасит все запуски сессии.
//
// Запуск: bun run scripts/live-session-test.ts
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DATA = mkdtempSync(join(tmpdir(), "dirigo-live-session-"));
process.env.DIRIGO_DATA = DATA; // состояние демона — в своём каталоге
// Служебные переменные прогона — в окружении демона (он унаследовал их от
// набора e2e). Агенту они доезжать не должны: иначе набор, запущенный изнутри
// агентской сессии, молча меняет поведение (вживую: E2E_CLI_SKIP_AGENT=1 от
// чужого прогона — и набор «зелёный», хотя агент не поднимался).
process.env.E2E_CLI_SKIP_AGENT = "1";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); ok ? pass++ : fail++; };

/** Жив ли процесс? (на Windows process.kill(pid, 0) бросает на мёртвом) */
function alive(pid: number | undefined): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === "EPERM"; }
}

/** Дождаться условия (с таймаутом). */
async function waitFor(cond: () => boolean | Promise<boolean>, ms = 5000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await cond()) return true; await sleep(50); }
  return await cond();
}

// Стаб-агент: первый аргумент — сколько спать, второй — метка запуска.
const stub = join(DATA, "stub.mjs");
writeFileSync(stub,
  "const ms = Number(process.argv[2] ?? 0);\n" +
  "console.log('stub: старт ' + (process.argv[3] ?? ''));\n" +
  "console.log('stub: E2E=[' + Object.keys(process.env).filter((k) => k.startsWith('E2E_')).join(',') + ']');\n" +
  "await new Promise((r) => setTimeout(r, ms));\n" +
  "console.log('stub: конец ' + (process.argv[3] ?? ''));\n", "utf8");

const { AGENTS } = await import("../src/agents/registry");
const { runner } = await import("../src/agents/runner");
const { sessions, projects, readLogTail } = await import("../src/store");

AGENTS.push({
  id: "stub",
  label: "Стаб",
  kind: "cli",
  command: [process.execPath, stub],
  argsTemplate: ["{{prompt}}"],
} as any);

const proj = await projects.add("live", DATA);
const ses = await sessions.add({
  id: "ses_live_test",
  projectId: proj.id,
  agentId: "stub",
  title: "live",
  prompt: "8000",
  mode: "cli",
});

/** Сколько запусков сессии уже отработало (по журналу). */
const exited = async () => (await readLogTail(ses.id, 200)).filter((l) => l.includes("exited with code")).length;

// Первый запуск — длинный (8 с): это «агент, который работает».
void runner.runSession(ses.id, "8000");
await waitFor(() => runner.isRunning(ses.id));

// Второй запуск — короткий (0.2 с): это «сообщение в живой агент».
// Раньше он перетирал первый процесс в реестре и по своему выходу ставил
// сессии «готово» — хотя первый агент ещё работал.
void runner.runSession(ses.id, "200");
await waitFor(async () => await exited() >= 1, 3000); // короткий запуск отработал
await sleep(200);

const s1 = sessions.get(ses.id);
check("короткий запуск отработал, длинный ещё жив", await exited() === 1 && runner.isRunning(ses.id), `отработало ${await exited()}`);
check("статус не терминальный, пока жив первый запуск", s1?.status === "running", `статус ${s1?.status}`);
check("сессия считается живой", runner.isRunning(ses.id));
check("pid сессии — живой процесс", alive(s1?.pid), `pid ${s1?.pid ?? "-"}`);

// Агент не должен видеть служебные переменные прогона: набор, запущенный из
// агентской сессии, иначе незаметно превращается в прогон без агента.
await waitFor(async () => (await readLogTail(ses.id, 200)).some((l) => l.includes("stub: E2E=")), 3000);
const agentEnv = (await readLogTail(ses.id, 200)).find((l) => l.includes("stub: E2E=")) ?? "";
check("служебные переменные прогона не доехали до агента", /E2E=\[\]/.test(agentEnv), agentEnv.trim().slice(0, 120) || "нет строки в журнале");

// «Стоп» должен гасить ВСЕ запуски сессии, а не только последний.
await runner.stopSession(ses.id);
await sleep(300);
check("после «Стоп» статус stopped", sessions.get(ses.id)?.status === "stopped", `статус ${sessions.get(ses.id)?.status}`);
check("после «Стоп» процессов не осталось", !runner.isRunning(ses.id));
check("после «Стоп» pid снят", !alive(sessions.get(ses.id)?.pid), `pid ${sessions.get(ses.id)?.pid ?? "-"}`);

try { rmSync(DATA, { recursive: true, force: true }); } catch { /* занято — приберёт чистка */ }
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
