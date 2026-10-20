#!/usr/bin/env bun
// H-V7: подкаталог чужого git-репо (монорепо) — git работает как git status.
// Раньше dirigo считала подкаталог «без git» (isGitProject=true только для
// корня) → diff показывал 0 файлов, хотя git status видит изменения. Теперь
// diff/status/commit работают в подкаталоге, worktree — только из корня.
// Запуск: bun run scripts/monorepo-subdir-test.ts (свой порт 7297).
import { join } from "node:path";
import { rmSync, mkdirSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const PORT = Number(process.env.MONOREPO_PORT ?? 7297);
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = new URL("./../.smoke-monorepo/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(join(ROOT, "sub"), { recursive: true });

// git-репо-родитель с подкаталогом sub/ (как proj/ → dirigo/)
const git = (args: string) => execSync(`git ${args}`, { cwd: ROOT, stdio: "pipe" }).toString();
git("init -q -b main");
git('config user.email t@t'); git('config user.name t');
writeFileSync(join(ROOT, "root.txt"), "root\n");
writeFileSync(join(ROOT, "sub", "a.txt"), "a\n");
git("add -A"); git('commit -qm init');
// изменения в подкаталоге (как git status в dirigo)
writeFileSync(join(ROOT, "sub", "a.txt"), "a modified\n");
writeFileSync(join(ROOT, "sub", "b.txt"), "new file\n");
writeFileSync(join(ROOT, "root.txt"), "root modified\n"); // вне подкаталога — не должно попасть в diff sub

const DATA = `${ROOT}data`;
mkdirSync(DATA, { recursive: true });
const server = Bun.spawn([process.execPath, "run", "src/server.ts"], {
  cwd: join(import.meta.dir, ".."),
  env: { ...process.env, PORT: String(PORT), DIRIGO_DATA: DATA },
  stdout: "ignore", stderr: "ignore",
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jpost = async (p: string, b: unknown) => {
  const r = await fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
  return { status: r.status, body: await r.json().catch(() => null) as any };
};
const jget = async (p: string) => (await fetch(BASE + p)).json() as any;

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  ok ? pass++ : fail++;
};

try {
  // ждём демон
  let up = false;
  for (let i = 0; i < 40; i++) { await sleep(250); try { if ((await fetch(`${BASE}/api/health`)).ok) { up = true; break; } } catch {} }
  check("демон поднялся", up);
  if (!up) throw new Error("no server");

  // проект = подкаталог монорепо
  const proj = await jpost("/api/projects", { name: "monorepo-sub", path: join(ROOT, "sub") });
  check("проект (подкаталог) создан", proj.status === 201 && !!proj.body?.id);
  const pid = proj.body.id;

  // сессия branch-mode (без копии) на подкаталоге
  // Агент — по реальной доступности PTY на этой машине (см. scripts/pick-agent.ts).
  const { pickAgent } = await import("./pick-agent");
  const ptyId = await pickAgent(BASE, "pty") ?? await pickAgent(BASE, "cli");
  const s = await jpost("/api/sessions", { agentId: ptyId, projectId: pid, mode: ptyId && await pickAgent(BASE, "pty") ? "pty" : "cli", prompt: "проверка подкаталога" });
  check("сессия branch-mode создана", s.status === 201 && !!s.body?.id);
  const sid = s.body.id;

  // target: git=true, subdir=sub, монорепо
  const t = await jget(`/api/sessions/${sid}/target`);
  check("target: git работает в подкаталоге", t.git === true && t.subdirOfRepo === "sub", `git=${t.git} subdir=${t.subdirOfRepo}`);

  // diff: только файлы подкаталога (a.txt, b.txt), НЕ root.txt; пути относительные от sub
  const d = await jget(`/api/sessions/${sid}/diff`);
  const paths = (d.files ?? []).map((f: any) => f.path).sort();
  check("diff: изменения подкаталога видны (a.txt modified, b.txt new)", paths.includes("a.txt") && paths.includes("b.txt"), paths.join(", "));
  check("diff: файлы вне подкаталога НЕ попадают (root.txt исключён)", !paths.includes("root.txt") && !paths.some((p: string) => p.startsWith("..")), paths.join(", "));

  // git status API
  const st = await jpost(`/api/sessions/${sid}/git`, { action: "status" });
  check("git status: ok в подкаталоге", st.body?.ok === true && st.body?.branch === "main", JSON.stringify(st.body).slice(0, 80));

  // 1.9.1: коммит из подкаталога ушёл бы в ЧУЖОЙ (родительский) репозиторий —
  // так правки проектов попадали в репо самого пульта. Теперь отказ 409 с
  // needsGitInit и кнопкой «Создать git проекта»; родительский репо не трогается.
  const t2 = await jget(`/api/sessions/${sid}/target`);
  check("target: проект не владеет репозиторием (projectOwnRepo=false, указан родитель)", t2.projectOwnRepo === false && !!t2.projectInsideRepo, JSON.stringify({ own: t2.projectOwnRepo, inside: t2.projectInsideRepo }));
  const headBefore = execSync("git -C " + ROOT + " rev-parse HEAD", { encoding: "utf8" }).trim();
  const gc = await jpost(`/api/sessions/${sid}/git`, { action: "commit", message: "sub commit" });
  check("git commit в подкаталоге чужого репо — 409 needsGitInit", gc.status === 409 && gc.body?.needsGitInit === true, `${gc.status} ${gc.body?.detail ?? ""}`);
  const headAfter = execSync("git -C " + ROOT + " rev-parse HEAD", { encoding: "utf8" }).trim();
  check("родительский репо не получил коммит", headBefore === headAfter);
  for (const act of ["push", "merge"]) {
    const r = await jpost(`/api/sessions/${sid}/git`, { action: act, into: "main", confirmed: true });
    check(`git ${act} тоже отказывает (409)`, r.status === 409 && r.body?.needsGitInit === true, String(r.status));
  }
  // создать собственный репо проекта → коммит идёт туда, не в родителя
  const gi = await jpost(`/api/projects/${pid}/git-init`, {});
  check("git-init: у проекта свой репозиторий", gi.status === 200 && gi.body?.ok === true, gi.body?.detail ?? String(gi.status));
  const t3 = await jget(`/api/sessions/${sid}/target`);
  check("target после init: projectOwnRepo=true", t3.projectOwnRepo === true);
  writeFileSync(join(ROOT, "sub", "c.txt"), "after init\n");
  const gc2 = await jpost(`/api/sessions/${sid}/git`, { action: "commit", message: "own commit" });
  check("commit после init — ok", gc2.body?.ok === true, gc2.body?.detail ?? String(gc2.status));
  const ownLog = execSync("git -C " + join(ROOT, "sub") + " log --format=%s", { encoding: "utf8" });
  check("коммит в собственном репо проекта", /own commit/.test(ownLog), ownLog.split("\n")[0]);
  const parentHead = execSync("git -C " + ROOT + " rev-parse HEAD", { encoding: "utf8" }).trim();
  check("родительский репо по-прежнему без новых коммитов", parentHead === headBefore);
  const gi2 = await jpost(`/api/projects/${pid}/git-init`, {});
  check("повторный git-init идемпотентен", gi2.status === 200 && /уже/.test(gi2.body?.detail ?? ""), gi2.body?.detail);

  // чистим
  await fetch(`${BASE}/api/sessions/${sid}`, { method: "DELETE" });
} catch (e) {
  check("без исключений", false, String(e).slice(0, 200));
} finally {
  server.kill();
  try { rmSync(ROOT, { recursive: true, force: true }); } catch {}
}
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
