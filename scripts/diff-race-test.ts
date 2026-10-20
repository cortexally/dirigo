#!/usr/bin/env bun
// Регресс: diff по живой копии не должен падать, когда агент правит файлы.
//
// Агент пишет в копию прямо сейчас: папка/файл может исчезнуть между
// «прочитали список» и «зашли внутрь». Раньше обход падал на этом, сервер
// отдавал 404, а CLI писал «сессия не найдена» (код 3) — хотя сессия есть.
//
// Запуск: bun run scripts/diff-race-test.ts
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const PORT = Number(process.env.DIFF_RACE_PORT ?? 7993);
const DATA = join(tmpdir(), `dirigo-diff-race-${PORT}`);
const PROJ = join(tmpdir(), `dirigo-diff-race-proj-${PORT}`);
const FILES = Number(process.env.DIFF_RACE_FILES ?? 600);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

rmSync(DATA, { recursive: true, force: true });
rmSync(PROJ, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });
mkdirSync(PROJ, { recursive: true });
// Проект с файлами: копия получится такой же, и её будут править под ногами.
for (let i = 0; i < FILES; i++) {
  const d = join(PROJ, `d${i % 20}`);
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  writeFileSync(join(d, `f${i}.txt`), `строка ${i}\n`.repeat(20), "utf8");
}

const server = Bun.spawn([process.execPath, "run", "src/server.ts"], {
  cwd: ROOT, env: { ...process.env, PORT: String(PORT), DIRIGO_DATA: DATA }, stdout: "ignore", stderr: "ignore",
});
const base = `http://127.0.0.1:${PORT}`;
let up = false;
for (let i = 0; i < 60; i++) { try { if ((await fetch(`${base}/api/health`)).ok) { up = true; break; } } catch { /* ждём */ } await sleep(250); }
if (!up) { console.log("FAIL  демон не поднялся"); server.kill(); process.exit(1); }

const prj = await (await fetch(`${base}/api/projects`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ name: "race", path: PROJ }),
})).json() as any;
const ses = await (await fetch(`${base}/api/sessions`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ projectId: prj.id, agentId: "minimax", prompt: "race", mode: "web", worktree: "copy" }),
})).json() as any;
const copy = ses?.worktree?.path ?? "";
console.log(`сессия ${ses?.id} · копия ${copy}`);

// «Агент» и разработчик правят файлы: в копии и в самом проекте (diff сравнивает
// оба дерева). Файлы и папки исчезают прямо во время обхода.
let stop = false;
const churn = (async () => {
  let n = 0;
  while (!stop) {
    for (const root of [copy, PROJ]) {
      const d = join(root, `d${n % 20}`);
      const f = join(d, `f${(n * 7) % FILES}.txt`);
      try { rmSync(f, { force: true }); } catch { /* занят */ }
      if (n % 37 === 0) { try { rmSync(d, { recursive: true, force: true }); } catch { /* занято */ } }
    }
    n++;
    await sleep(1);
  }
})();

let ok = 0, bad = 0;
let lastErr = "";
for (let i = 0; i < 12; i++) {
  const r = await fetch(`${base}/api/sessions/${ses.id}/diff`);
  if (r.status === 200) ok++;
  else { bad++; lastErr = `${r.status} ${(await r.text()).slice(0, 160)}`; }
}
stop = true;
await churn;

console.log(`${bad === 0 ? "PASS" : "FAIL"}  diff по живой копии не падает  — ок ${ok}, ошибок ${bad}${lastErr ? " · " + lastErr : ""}`);

server.kill();
await sleep(300);
rmSync(DATA, { recursive: true, force: true });
rmSync(PROJ, { recursive: true, force: true });
process.exit(bad === 0 ? 0 : 1);
