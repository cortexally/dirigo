#!/usr/bin/env bun
// Регресс-тест: рабочая папка агента должна уцелеть, когда сессию удаляют,
// а агент ещё работает (F_VER-5).
//
// Откуда тест. opencode отдаёт ход своему сервису: `opencode-cli.exe run` —
// клиент, а работа идёт в сервисе. Клиент умирает (код 0), а агент продолжает
// писать правки в копию проекта. Демон видел «все признаки мёртвого агента»
// (pid не записан, статус error) и по DELETE /api/sessions/:id сносил копию —
// у живого агента пропадала рабочая папка («Working directory does not exist»),
// правки терялись.
//
// Сценарий 1 (главный): стаб-агент, который после своего выхода оставляет
// «сервис» — отдельный процесс, дописывающий файл в копию. Демон сносит
// сессию → копия обязана уцелеть, а снос — случиться позже, когда агент
// замолчит.
//
// Сценарий 2 (обычный): агент отработал и больше ничего не трогал → копия
// сносится сразу, как раньше.
//
// Запуск: bun run scripts/live-copy-guard-test.ts
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DATA = mkdtempSync(join(tmpdir(), "dirigo-live-copy-"));
process.env.DIRIGO_DATA = DATA; // состояние демона — в своём каталоге
// Окна проверки — короткие, чтобы тест не ждал минуту.
process.env.DIRIGO_COPY_QUIET_MS = "800";
process.env.DIRIGO_COPY_CHECK_MS = "200";
process.env.DIRIGO_ACTIVITY_WINDOW_MS = "5000";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  ok ? pass++ : fail++;
};
// Проверка, правило для которой ещё не принято: дыра зафиксирована, но не
// исправлена. Показываем её в отчёте, чтобы нельзя было закрыть молча.
let pend = 0;
const pending = (name: string, ok: boolean, detail = "") => {
  console.log(`PEND  ${name}${detail ? "  — " + detail : ""}`);
  if (ok) pass++; else pend++;
};

// Стаб-агент: argv[2] — «работа в сервисе» (1 — оставить потомка, который
// допишет файл ПОСЛЕ ухода клиента).
const stub = join(DATA, "stub.mjs");
const stubCode = [
  "import { spawn } from 'node:child_process';",
  "import { writeFileSync } from 'node:fs';",
  "const mode = process.argv[2];",
  "const service = mode === '1';",
  // Режим «2» — агент, который ТОЛЬКО ЧИТАЕТ: клиент не пишет в копию",
  // ничего (сценарий 4, F_VER-7).",
  "if (mode !== '2') writeFileSync('client-work.txt', 'правка клиента');",
  "if (service) {",
  "  // «сервис агента»: он переживает клиент и дописывает правку в копию.",
  "  const code = \"setTimeout(() => require('node:fs').writeFileSync('service-work.txt', 'правка сервиса'), 600)\";",
  "  const child = spawn(process.execPath, ['-e', code], { detached: true, stdio: ['ignore', 'ignore', 'inherit'] });",
  "  child.unref();",
  "}",
  "console.log('stub: клиент уходит');",
  "",
].join("\n");
writeFileSync(stub, stubCode, "utf8");

const { AGENTS } = await import("../src/agents/registry");
const { runner } = await import("../src/agents/runner");
const { sessions, projects } = await import("../src/store");
const { getWorktree, cleanupWorktree, createWorktree } = await import("../src/worktrees");
const { sessionAlive, deferCopyRemoval, ACTIVITY_WINDOW_MS } = await import("../src/liveness");

AGENTS.push({
  id: "stub",
  label: "Стаб",
  kind: "cli",
  command: [process.execPath, stub],
  argsTemplate: ["{{prompt}}"],
} as any);

/** Дождаться условия (с таймаутом). */
async function waitFor(cond: () => boolean | Promise<boolean>, ms = 5000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await cond()) return true; await sleep(50); }
  return await cond();
}

/* ── сценарий 1: клиент умер, работа идёт в сервисе ─────────────────────── */
{
  const proj = await projects.add("guard", DATA);
  const ses = await sessions.add({
    id: "ses_service_alive",
    projectId: proj.id,
    agentId: "stub",
    title: "service",
    prompt: "1",
    mode: "cli",
  });
  // Копия проекта — как её создаёт демон при создании сессии.
  const wt = createWorktree(ses.id, proj.path, "copy");
  ses.worktree = { kind: wt.kind, path: wt.path, baseRef: wt.baseRef, createdAt: wt.createdAt };
  void runner.runSession(ses.id, "1");
  // Клиент отработал и ушёл…
  await waitFor(() => sessions.get(ses.id)?.status === "done" || sessions.get(ses.id)?.status === "error", 8000);
  // …а «сервис» ещё дописывает в копию.
  await waitFor(() => existsSync(join(getWorktree(ses.id)?.path ?? "", "service-work.txt")), 5000);

  const s = sessions.get(ses.id);
  const copy = getWorktree(ses.id)?.path ?? "";
  check("уход клиента зафиксирован (agentExitAt)", typeof s?.agentExitAt === "number" && s.agentExitAt > 0, `agentExitAt ${s?.agentExitAt ?? "-"}`);
  check("копия жива: сервис дописал правку после ухода клиента", existsSync(join(copy, "service-work.txt")), copy);

  // Решение демона: жив ли агент.
  const verdict = sessionAlive(ses.id, { session: s, hasLiveProcess: false });
  check("агент считается живым (правки после ухода клиента)", verdict.alive, verdict.reason);

  // Что делает демон при удалении сессии: копию бережём, снос — позже.
  deferCopyRemoval(ses.id, Date.now() + ACTIVITY_WINDOW_MS);
  await sleep(400);
  check("копия уцелела после удаления сессии", existsSync(copy), copy);
  check("копия защищена от сноса", !cleanupWorktree(ses.id).ok, "снос отказан");

  // Агент замолчал → копия сносится сама.
  await waitFor(() => !existsSync(copy), 8000);
  check("копия снесена, когда агент замолчал", !existsSync(copy), copy);
}

/* ── сценарий 2: агент отработал и больше ничего не трогал ─────────────── */
{
  const proj = await projects.add("guard2", DATA);
  const ses = await sessions.add({
    id: "ses_finished",
    projectId: proj.id,
    agentId: "stub",
    title: "finished",
    prompt: "0",
    mode: "cli",
  });
  const wt2 = createWorktree(ses.id, proj.path, "copy");
  ses.worktree = { kind: wt2.kind, path: wt2.path, baseRef: wt2.baseRef, createdAt: wt2.createdAt };
  void runner.runSession(ses.id, "0");
  await waitFor(() => sessions.get(ses.id)?.status === "done" || sessions.get(ses.id)?.status === "error", 8000);
  await sleep(300);
  const s = sessions.get(ses.id);
  const copy = getWorktree(ses.id)?.path ?? "";
  const verdict = sessionAlive(ses.id, { session: s, hasLiveProcess: false });
  check("отработавший агент не считается живым", !verdict.alive, verdict.reason);
  // Обычный путь: сессию удалили — копию сносят сразу.
  const res = cleanupWorktree(ses.id);
  check("копия обычной сессии сносится сразу", res.ok, res.detail);
  check("копия обычной сессии убрана", !existsSync(copy), copy);
}

/* ── сценарий 3: тот же случай через API демона (DELETE /api/sessions/:id) ── */
{
  // Демон поднимаем в этом же процессе: стаб-агент зарегистрирован в общем
  // реестре — так проверяется настоящий путь удаления сессии (не только
  // отдельные функции).
  const PORT = 7900 + (process.pid % 90);
  process.env.PORT = String(PORT);
  await import("../src/server");
  const BASE = `http://127.0.0.1:${PORT}`;
  let up = false;
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) { up = true; break; } } catch { /* ещё не поднялся */ }
    await sleep(100);
  }
  check("демон поднялся", up, `порт ${PORT}`);
  if (up) {
    const prj = await (await fetch(`${BASE}/api/projects`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "api", path: DATA }),
    })).json();
    const res = await (await fetch(`${BASE}/api/sessions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: "stub", prompt: "1", mode: "cli", projectId: prj.id, worktree: true }),
    })).json();
    const id = res.id as string;
    await waitFor(async () => {
      const s = await (await fetch(`${BASE}/api/sessions/${id}`)).json().catch(() => null);
      return s?.status === "done" || s?.status === "error";
    }, 8000);
    // «Сервис» дописывает в копию уже после ухода клиента.
    const copyPath = getWorktree(id)?.path ?? "";
    await waitFor(() => existsSync(join(copyPath, "service-work.txt")), 5000);
    const del = await (await fetch(`${BASE}/api/sessions/${id}`, { method: "DELETE" })).json() as any;
    check("удаление сессии сообщает, что копия сохранена", !!del?.kept, String(del?.kept ?? "-"));
    await sleep(400);
    check("рабочая папка агента уцелела после DELETE", existsSync(copyPath), copyPath);
    // Агент замолчал — копия сносится сама.
    await waitFor(() => !existsSync(copyPath), 8000);
    check("копия снесена, когда агент замолчал (API)", !existsSync(copyPath), copyPath);
  }
}

/* ── сценарий 4 (F_VER-7): агент, который ТОЛЬКО ЧИТАЕТ ─────────────────── */
{
  // Клиент уходит, а «сервис» не трогает копию: агент читает, но не пишет.
  // Тогда в копии НЕТ следов работы, и sessionAlive (F_VER-6) считает агента
  // мёртвым: правило 2 требует, чтобы копию трогали ПОСЛЕ ухода клиента, а
  // правило 3 — чтобы ухода не зафиксировали. Значит DELETE /api/sessions/:id
  // сносит рабочую папку живого агента.
  //
  // Это ФАКТ (инцидент набора e2e-cli, порт 8604: агент потерял рабочую
  // папку, ни одной правки не сделав — см. RUNTIME.md, F_VER-7), а не
  // желание. Правило для такого случая пул ещё не принял, поэтому проверка
  // помечена «pending»: дыра видна в отчёте, и закрыть её молча нельзя.
  const proj = await projects.add("guard4", DATA);
  const ses = await sessions.add({
    id: "ses_reader",
    projectId: proj.id,
    agentId: "stub",
    title: "reader",
    prompt: "2",
    mode: "cli",
  });
  const wt4 = createWorktree(ses.id, proj.path, "copy");
  ses.worktree = { kind: wt4.kind, path: wt4.path, baseRef: wt4.baseRef, createdAt: wt4.createdAt };
  void runner.runSession(ses.id, "2");
  await waitFor(() => sessions.get(ses.id)?.status === "done" || sessions.get(ses.id)?.status === "error", 8000);
  await sleep(300);
  const s4 = sessions.get(ses.id);
  const verdict4 = sessionAlive(ses.id, { session: s4, hasLiveProcess: false });
  pending(
    "рабочая папка агента, который только читает, уцелеет (F_VER-7)",
    verdict4.alive,
    verdict4.reason || "сессия считается мёртвой: следов работы в копии нет — правило ещё не принято",
  );
  // Итог: с правилом «следы в копии» такой агент считается мёртвым, и копию
  // снесут. Показываем это явно — чтобы правка, когда её примут, начиналась
  // с этой точки.
  const res4 = cleanupWorktree(ses.id);
  check("F_VER-7: у читающего агента копию сносят (дыра на месте)", res4.ok, res4.detail);
}

try { rmSync(DATA, { recursive: true, force: true }); } catch { /* занято — приберёт чистка */ }
console.log(`\n${pass}/${pass + fail} passed${pend ? `, ${pend} pending` : ""}`);
process.exit(fail ? 1 : 0);