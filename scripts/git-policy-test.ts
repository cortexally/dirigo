#!/usr/bin/env bun
// Git-политика 1.9.1: предсказуемая связка «проект ↔ копия ↔ дифф ↔ редактор ↔ коммит».
//
// Регрессии, которые ловит (все — из жалоб владельца 18.10):
//  • проект без git + «работать в копии» → «копия без git, Changes 0», кнопки 409;
//    теперь при старте проекту создаётся СОБСТВЕННЫЙ репозиторий (снимок),
//    копия — git-worktree на этом снимке;
//  • правка в копии видна в диффе как добавленная (зелёная), оригинал не тронут;
//    раньше живой диалог (ACP) писал в оригинал, а дифф смотрел копию → «удалено»;
//  • «Открыть в редакторе» открывает именно копию сессии;
//  • коммит уходит в репозиторий проекта, а не в родительский
//    (projects/* внутри репо пульта — см. monorepo-subdir-test).
//
//   bun run scripts/git-policy-test.ts       (свой порт 7298, свой DIRIGO_DATA)
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

const PORT = Number(process.env.GITPOLICY_PORT ?? 7298);
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = join(import.meta.dir, "..", ".smoke-gitpolicy");
// Проект вне любого репозитория: внутри дерева пульта он оказался бы в его git,
// поэтому кладём во временную папку ОС.
const OUTSIDE = join(process.env.TEMP ?? process.env.TMPDIR ?? "/tmp", `dirigo-gitpolicy-${Date.now().toString(36)}`);
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });
mkdirSync(OUTSIDE, { recursive: true });
writeFileSync(join(OUTSIDE, "loan.py"), "def pay(x):\n    return x\n");

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  ok ? pass++ : fail++;
};
const insideRepo = (p: string) => { try { return execSync(`git -C "${p}" rev-parse --is-inside-work-tree`, { stdio: "pipe" }).toString().trim() === "true"; } catch { return false; } };
if (insideRepo(OUTSIDE)) {
  console.log("PASS  временная папка ОС сама внутри git — сценарий неприменим\n\n1/1 passed");
  rmSync(OUTSIDE, { recursive: true, force: true });
  process.exit(0);
}

const server = Bun.spawn([process.execPath, "run", "src/server.ts"], {
  cwd: join(import.meta.dir, ".."),
  env: { ...process.env, PORT: String(PORT), DIRIGO_DATA: join(ROOT, "data"), DIRIGO_EDITOR_DRYRUN: "1" },
  stdout: "ignore", stderr: "ignore",
});
const jpost = async (p: string, b: unknown) => {
  const r = await fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
  return { status: r.status, body: await r.json().catch(() => null) as any };
};
const jget = async (p: string) => (await fetch(BASE + p)).json() as any;

let sid = "";
try {
  let up = false;
  for (let i = 0; i < 60; i++) { await Bun.sleep(250); try { if ((await fetch(`${BASE}/api/health`)).ok) { up = true; break; } } catch { /* */ } }
  check("демон поднялся", up);
  if (!up) throw new Error("no server");

  const proj = await jpost("/api/projects", { name: "no-git", path: OUTSIDE });
  check("проект без git добавлен", proj.status === 201 && !!proj.body?.id, String(proj.status));
  const pid = proj.body.id;
  check("до сессии у проекта git нет", !insideRepo(OUTSIDE));

  const { pickAgent } = await import("./pick-agent");
  const agent = await pickAgent(BASE, "cli") ?? await pickAgent(BASE, "persistent");
  if (!agent) throw new Error("нет ни одного агента с режимом cli/persistent");
  const mode = (await pickAgent(BASE, "cli")) ? "cli" : "persistent";
  // задача без правок: агента сразу останавливаем, «правку агента» делаем сами —
  // проверяем связку пульта, а не модель
  const s = await jpost("/api/sessions", { agentId: agent, projectId: pid, mode, worktree: true, prompt: "ничего не меняй, ответь ok" });
  check("сессия «в копии» создана", s.status === 201 && !!s.body?.id, `${s.status} ${s.body?.error ?? ""}`);
  sid = s.body.id;
  await jpost(`/api/sessions/${sid}/stop`, {});

  check("при старте проекту создан СОБСТВЕННЫЙ git", existsSync(join(OUTSIDE, ".git")));
  const t = await jget(`/api/sessions/${sid}/target`);
  check("копия — git-worktree (не файловая)", t.kind === "copy" && t.copyKind === "git" && t.git === true, JSON.stringify({ kind: t.kind, copyKind: t.copyKind, git: t.git }));
  check("ветка копии названа (main), не «без git»", t.branch === "main", String(t.branch));
  check("панель знает, что коммитить можно (projectOwnRepo)", t.projectOwnRepo === true);
  const copyDir: string = t.path;
  check("копия — не папка проекта", !!copyDir && copyDir.replace(/\\/g, "/").toLowerCase() !== OUTSIDE.replace(/\\/g, "/").toLowerCase(), copyDir);

  // «агент добавил персональные данные» — в копии
  writeFileSync(join(copyDir, "loan.py"), "def pay(x):\n    return x\n\nCLIENT = 'Ivan Petrov, ivan@example.com'\n");
  writeFileSync(join(copyDir, "pii.txt"), "passport 1234 567890\n");
  const d = await jget(`/api/sessions/${sid}/diff`);
  const files = (d.files ?? []) as any[];
  const loan = files.find((f) => f.path === "loan.py");
  check("дифф видит изменённый и новый файл", !!loan && files.some((f) => f.path === "pii.txt"), files.map((f) => f.path).join(", "));
  check("добавленное — добавлено (зелёное), а не удалено", loan?.added >= 2 && loan?.deleted === 0, `+${loan?.added} −${loan?.deleted}`);
  check("оригинал проекта не тронут", !readFileSync(join(OUTSIDE, "loan.py"), "utf8").includes("CLIENT") && !existsSync(join(OUTSIDE, "pii.txt")));

  const ed = await jpost("/api/open-editor", { sessionId: sid });
  check("«Открыть в редакторе» открывает копию сессии", ed.body?.ok === true && ed.body?.dir === copyDir, String(ed.body?.dir));

  // коммит — в репозиторий проекта (ветка копии), main проекта не трогается до merge
  const headMain = execSync(`git -C "${OUTSIDE}" rev-parse main`).toString().trim();
  const gc = await jpost(`/api/sessions/${sid}/git`, { action: "commit", message: "agent: pii" });
  check("коммит копии проходит", gc.body?.ok === true, gc.body?.detail ?? String(gc.status));
  const log = execSync(`git -C "${OUTSIDE}" log --all --format=%s`).toString();
  check("коммит лежит в репозитории проекта", /agent: pii/.test(log));
  check("main проекта не сдвинулся без merge", execSync(`git -C "${OUTSIDE}" rev-parse main`).toString().trim() === headMain);
  check("оригинал по-прежнему без правок", !existsSync(join(OUTSIDE, "pii.txt")));

  // явная файловая копия: честно помечена, git-кнопки объясняют
  const s2 = await jpost("/api/sessions", { agentId: agent, projectId: pid, mode, worktree: "copy", prompt: "ok" });
  if (s2.status === 201) {
    await jpost(`/api/sessions/${s2.body.id}/stop`, {});
    const t2 = await jget(`/api/sessions/${s2.body.id}/target`);
    check("явная файловая копия помечена copyKind=copy", t2.copyKind === "copy", String(t2.copyKind));
    await fetch(`${BASE}/api/sessions/${s2.body.id}`, { method: "DELETE" });
  }

  // UI: кнопка «Создать git проекта» и разбор 409 на месте
  const app = readFileSync(join(import.meta.dir, "..", "web", "app.js"), "utf8");
  const html = readFileSync(join(import.meta.dir, "..", "web", "index.html"), "utf8");
  check("UI: блок rp-gitinit есть в панели", html.includes('id="rp-gitinit"'));
  check("UI: кнопка вызывает /projects/:id/git-init", /git-init`/.test(app) && app.includes("gitInitProject"));
  check("UI: текст отказа сервера (detail) не теряется — не «HTTP 409»", app.includes("data.error ?? data.detail"));
  // Все режимы запуска (cli, живой диалог, терминал) работают в папке сессии.
  // Регресс 18.10: startPersistent брал project.path — ACP правил оригинал.
  const runner = readFileSync(join(import.meta.dir, "..", "src", "agents", "runner.ts"), "utf8");
  check("runner: агенты не запускаются в папке проекта мимо копии", !/project\??\.path\s*\|\|\s*process\.cwd\(\)/.test(runner) && (runner.match(/sessionCwd\(/g) ?? []).length >= 5);
} catch (e) {
  check("без исключений", false, String(e).slice(0, 200));
} finally {
  if (sid) await fetch(`${BASE}/api/sessions/${sid}`, { method: "DELETE" }).catch(() => null);
  server.kill();
  await Bun.sleep(500);
  for (let i = 0; i < 5; i++) { try { rmSync(ROOT, { recursive: true, force: true }); rmSync(OUTSIDE, { recursive: true, force: true }); break; } catch { await Bun.sleep(1000); } }
}
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
