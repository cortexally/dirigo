// Проба пути «сессия → правка агента → diff → apply → revert» на ЧЕРНОВИКЕ
// проекта: правка должна попасть в черновик, а репозиторий разработчика —
// остаться нетронутым.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = join(import.meta.dir, "..");
const PORT = Number(process.env.PROBE_PORT ?? 9921);
const DATA = join(tmpdir(), "dirigo-e2e", `probe-${PORT}`);
const SCRATCH = join(tmpdir(), "dirigo-e2e", `probe-proj-${PORT}`);
const BASE = `http://127.0.0.1:${PORT}`;

mkdirSync(DATA, { recursive: true });
mkdirSync(SCRATCH, { recursive: true });
// Мини-проект в песочнице: свой git-репозиторий (как черновик набора).
writeFileSync(join(SCRATCH, "app.txt"), "было\n", "utf8");
writeFileSync(join(SCRATCH, "tracked.txt"), "строка\n", "utf8");
const git = (args: string[]) => Bun.$`git -C ${SCRATCH} ${args}`.quiet();
await git(["init", "-q", "-b", "main"]);
await git(["config", "user.name", "dirigo"]);
await git(["config", "user.email", "dirigo@localhost"]);
await git(["add", "-A"]);
await git(["commit", "-q", "-m", "снимок"]);

const server = Bun.spawn([process.execPath, "run", "src/server.ts"], {
  cwd: ROOT, env: { ...process.env, PORT: String(PORT), DIRIGO_DATA: DATA }, stdout: "ignore", stderr: "ignore",
});
for (let i = 0; i < 50; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* ждём */ } await Bun.sleep(200); }

const env = { ...process.env, DIRIGO_HOST: BASE, DIRIGO_DATA: DATA };
const cli = async (args: string[]) => {
  const p = Bun.spawn([process.execPath, "run", "scripts/orch.ts", ...args], { cwd: ROOT, env, stdout: "pipe", stderr: "pipe" });
  const out = (await new Response(p.stdout).text()).trim();
  const err = (await new Response(p.stderr).text()).trim();
  return { code: await p.exited, out, err };
};

const pr = await fetch(`${BASE}/api/projects`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "probe", path: SCRATCH }) });
const pid = ((await pr.json()) as any).id as string;
console.log("проект:", pid, SCRATCH);

// Сессия в web-режиме с git-копией: агент не поднимается, но копия — как у живого.
const run = await cli(["run", "minimax", "проба", "--mode", "web", "--wt", "git", "--project", pid, "--json"]);
console.log("run:", run.code, run.out.slice(0, 200), run.err.slice(0, 200));
let sid = "";
try { sid = (JSON.parse(run.out) as any).id; } catch { /* пусто */ }
if (!sid) { console.log("сессия не создана — стоп"); server.kill(); process.exit(1); }

const ses = await fetch(`${BASE}/api/sessions/${sid}`).then((r) => r.json() as any);
const wt = ses?.worktree?.path as string;
console.log("копия:", wt, "kind:", ses?.worktree?.kind);

// Правка «агента» в копии.
writeFileSync(join(wt, "app.txt"), "стало\n", "utf8");
writeFileSync(join(wt, "новый-файл.txt"), "новое\n", "utf8");

const d = await cli(["diff", sid, "--json"]);
console.log("diff:", d.code, d.out.slice(0, 400), d.err.slice(0, 200));
const a = await cli(["apply", sid]);
console.log("apply:", a.code, a.out.slice(0, 300), a.err.slice(0, 200));
console.log("черновик после apply:", readFileSync(join(SCRATCH, "app.txt"), "utf8").trim(), "| новый файл:", existsSync(join(SCRATCH, "новый-файл.txt")));
const rv = await cli(["revert", sid]);
console.log("revert:", rv.code, rv.out.slice(0, 200), rv.err.slice(0, 200));
console.log("копия после revert:", readFileSync(join(wt, "app.txt"), "utf8").trim(), "| новый файл в копии:", existsSync(join(wt, "новый-файл.txt")));

server.kill();
await Bun.sleep(300);
console.log("ГОТОВО");
