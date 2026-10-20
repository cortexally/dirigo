#!/usr/bin/env bun
// Верификация пользовательских флоу: devin CLI + PTY (баги от OCA) + остальные режимы.
// Запуск против живого демона: bun run scripts/verify-flows.ts
import { execSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";

// Без явного DIRIGO_PORT — свободный порт и свой демон. Раньше по умолчанию
// бралось 7171: если там работал боевой Dirigo, тест гонялся на реальных
// данных пользователя (создавал проекты и сессии в его списке).
const PORT = process.env.DIRIGO_PORT ? Number(process.env.DIRIGO_PORT) : (() => {
  const srv = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {}, open() {}, close() {}, error() {} } });
  const p = srv.port; srv.stop(true); return p;
})();
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  ok ? pass++ : fail++;
};

const jpost = async (p: string, b: unknown = {}) => {
  const r = await fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
  return { status: r.status, body: await r.json().catch(() => null) as any };
};
const jget = async (p: string) => {
  const r = await fetch(BASE + p);
  return { status: r.status, body: await r.json().catch(() => null) as any };
};

// Сценарий не должен зависеть от того, запустил ли кто-то демон руками:
// в гейте это выглядело как падение продукта, а на деле просто не было сервера.
const daemonAlive = async () => {
  try { return (await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(900) })).ok; } catch { return false; }
};
let ownServer: Bun.Subprocess | null = null;
if (!(await daemonAlive())) {
  const OWN_DATA = `${import.meta.dir}/../.verify-flows-data-${Math.random().toString(36).slice(2, 10)}`;
  console.log(`[verify-flows] демона на ${PORT} нет — поднимаю свой (данные: ${OWN_DATA})`);
  mkdirSync(OWN_DATA, { recursive: true });
  ownServer = Bun.spawn([process.execPath, "run", "src/server.ts"], {
    cwd: `${import.meta.dir}/..`,
    env: { ...process.env, PORT: String(PORT), DIRIGO_DATA: OWN_DATA },
    stdout: "ignore", stderr: "ignore",
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && !(await daemonAlive())) await Bun.sleep(300);
  if (!(await daemonAlive())) { console.error("[verify-flows] демон не поднялся"); process.exit(1); }
  process.on("exit", () => {
    try { process.kill(ownServer!.pid, "SIGKILL"); } catch { /* уже мёртв */ }
    try { rmSync(OWN_DATA, { recursive: true, force: true }); } catch { /* занято */ }
  });
}

/** Удаление с ретраями: на Windows PTY прошлых прогонов может держать каталог (EBUSY). */
function safeRm(p: string) {
  for (let i = 0; i < 12; i++) {
    try { rmSync(p, { recursive: true, force: true }); return; } catch { /* busy */ }
    Bun.sleepSync(800);
  }
  try { rmSync(p, { recursive: true, force: true }); } catch { /* оставляем — тест пересоздаст */ }
}

try {
  // проект для тестов: свой маленький git-репозиторий (быстрая копия)
  const wt = new URL(`./../.smoke-oc-git-${Date.now().toString(36)}/`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  safeRm(wt); // V6.13: EBUSY-устойчивое удаление (прошлые прогоны могли оставить хэндлы)
  mkdirSync(wt, { recursive: true });
  writeFileSync(wt + "app.ts", "export const port = 1;\n");
  execSync(`git init -b main . && git add -A && git -c user.email=a@b -c user.name=t commit -m init`, { cwd: wt, shell: true });
  const proj = await jpost("/api/projects", { name: "verify-flows", path: wt });
  const pid = proj.body?.id;
  check("проект создан", !!pid, String(pid));

  // Агентов берём по реальной доступности режима: сценарий проверяет продукт,
  // а не то, какой именно CLI установлен на конкретной машине.
  const { pickAgent } = await import("./pick-agent");
  const cliId = await pickAgent(BASE, "cli");
  const ptyId = await pickAgent(BASE, "pty");
  const webId = await pickAgent(BASE, "web");
  check("есть агент с рабочим CLI", !!cliId, cliId ?? "ни одного");

  // --- БАГ 1: CLI-агент — spawn без ENOENT ---
  const devin = cliId ? await jpost("/api/sessions", {
    agentId: cliId, projectId: pid, mode: "cli",
    prompt: "проверь git есть ли какие то незакомиченые изменения и что именно",
  }) : { status: 0, body: null as any };
  check("CLI: сессия создана", !cliId || devin.status === 201, `${devin.status}`);
  if (devin.status === 201) {
    let st = "";
    let logText = "";
    for (let i = 0; i < 80; i++) {      // 40с (80×500мс): devin CLI может тормозить под нагрузкой
      await sleep(500);
      const d = await jget(`/api/sessions/${devin.body.id}`);
      st = d.body?.status ?? "";
      logText = ((await jget(`/api/sessions/${devin.body.id}/log?n=all`)).body?.lines ?? []).join("\n");
      if (st !== "queued" && st !== "running") break;
    }
    // ВАЖНО: OCA добавил INFO-строку про детекцию ENOENT — она НЕ ошибка.
    // Ошибка — это реальный "spawn failed: Error: ENOENT ... uv_spawn".
    const spawnErr = /spawn failed/.test(logText) || /uv_spawn/.test(logText);
    const refErr = /ReferenceError|is not defined/.test(logText);
    check("CLI: без ENOENT/spawn failed", !spawnErr, spawnErr ? logText.split("\n").filter((l) => /spawn failed|uv_spawn/.test(l))[0]?.slice(0, 90) ?? "" : `status=${st}`);
    check("CLI: без ReferenceError", !refErr, refErr ? "ReferenceError в логе" : "");
    console.log(`  [cli ${cliId}] финальный статус: ${st}`);
  }

  // --- БАГ 2: PTY (secretsEnv ReferenceError) — devin имеет PTY ---
  const pty = ptyId ? await jpost("/api/sessions", {
    agentId: ptyId, projectId: pid, mode: "pty", prompt: "",
  }) : { status: 0, body: null as any };
  check("pty: сессия создана", !ptyId || pty.status === 201, ptyId ? `${pty.status} ${pty.body?.error ?? ""}` : "режим PTY недоступен на этой машине");
  if (pty.status === 201) {
    await sleep(6000);
    const d = await jget(`/api/sessions/${pty.body.id}`);
    const logText = ((await jget(`/api/sessions/${pty.body.id}/log?n=all`)).body?.lines ?? []).join("\n");
    const refErr = /ReferenceError|secretsEnv is not defined/.test(logText);
    check("pty: без secretsEnv ReferenceError", !refErr, refErr ? logText.split("\n").filter((l) => /ReferenceError/.test(l))[0]?.slice(0, 90) ?? "" : `status=${d.body?.status}`);
    console.log(`  [pty] финальный статус: ${d.body?.status}`);
    await jpost(`/api/sessions/${pty.body.id}/stop`, {});
  }

  // --- остальные PTY-агенты (регрессия secretsEnv) ---
  for (const aid of ["hermes", "claude-code", "codex", "copilot", "gemini", "freebuff", "cline"]) {
    const installed = (await jget("/api/setup/agents")).body?.find((a: any) => a.id === aid);
    if (!installed || installed.state !== "installed") continue;
    const p = await jpost("/api/sessions", { agentId: aid, projectId: pid, mode: "pty", prompt: "" });
    if (p.status !== 201) { check(`pty ${aid}: сессия создана`, false, `${p.status} ${p.body?.error ?? ""}`); continue; }
    await sleep(4000);
    const d = await jget(`/api/sessions/${p.body.id}`);
    const logText = ((await jget(`/api/sessions/${p.body.id}/log?n=all`)).body?.lines ?? []).join("\n");
    const bad = /ReferenceError|spawn failed/.test(logText);
    check(`pty ${aid}: без ReferenceError/spawn-failed`, !bad && (d.body?.status === "running" || d.body?.status === "done"), `status=${d.body?.status}`);
    await jpost(`/api/sessions/${p.body.id}/stop`, {});
  }

  // деградация: сессия с копией (git-mode) — флоу пользователя №1
  const wtSession = webId
    ? await jpost("/api/sessions", { agentId: webId, projectId: pid, mode: "web", prompt: "", worktree: true })
    : { status: 0, body: null as any };
  check("копия: сессия с копией", !webId || (wtSession.status === 201 && !!wtSession.body?.worktree), `${wtSession.status}`);
  if (wtSession.status === 201) {
  const target = jget(`/api/sessions/${wtSession.body.id}/worktree`);
  void target;
  await jpost(`/api/sessions/${wtSession.body.id}/stop`, {});
  await fetch(`${BASE}/api/sessions/${wtSession.body.id}`, { method: "DELETE" });
  }

  // Недоступный режим — отказ ДО создания сессии, с причиной и подсказкой.
  const { pickUnavailableAgent } = await import("./pick-agent");
  const missId = await pickUnavailableAgent(BASE, "cli");
  if (missId) {
    const miss = await jpost("/api/sessions", { agentId: missId, projectId: pid, mode: "cli", prompt: "тест" });
    check("недоступный агент: 409 с причиной и подсказкой",
      miss.status === 409 && String(miss.body?.reason ?? "").length > 5 && !!miss.body?.fix,
      `${miss.status} ${String(miss.body?.reason ?? "").slice(0, 70)}`);
  }

  // прочие сессии-артефакты: power shell запущенный агент остаётся в procs — стоп
  const list = await jget("/api/sessions");
  for (const s of (list.body ?? []).filter((x: any) => x.status === "running" || x.status === "queued")) {
    await jpost(`/api/sessions/${s.id}/stop`, {});
  }
} catch (e) {
  check("verify without exceptions", false, String(e).slice(0, 200));
  // исключение могло оставить живые сессии — гасим, чтобы не копить процессы
  try {
    const list = await jget("/api/sessions");
    for (const s of (list.body ?? []).filter((x: any) => x.status === "running" || x.status === "queued")) {
      await jpost(`/api/sessions/${s.id}/stop`, {});
    }
  } catch { /* демон уже мёртв */ }
}
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
