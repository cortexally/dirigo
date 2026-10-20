#!/usr/bin/env bun
// Git-кнопки (V2-1.5): сценарий коммит/push/pr/merge над копией сессии.
// Запуск: bun run scripts/git-test.ts
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Каталог данных — СВОЙ. Общий DIRIGO_DATA здесь опасен: сценарий сносит
// каталог ЦЕЛИКОМ, а в агентской сессии DIRIGO_DATA указывает на каталог
// демона (база, журналы и рабочие папки ВСЕХ сессий). Наблюдалось вживую:
// прямой запуск сценария из агентской сессии сносил чужое состояние.
// Свой путь — через DIRIGO_SCENARIO_DATA (обёртка git-test.ts его задаёт).
const DATA = process.env.DIRIGO_SCENARIO_DATA
  ? resolve(process.env.DIRIGO_SCENARIO_DATA)
  : join(tmpdir(), `dirigo-git-scenario-${process.pid}`);
process.env.DIRIGO_DATA = DATA; // библиотека берёт каталог данных отсюда
const TMP = join(import.meta.dir, "..", ".smoke-git");
rmSync(TMP, { recursive: true, force: true });
rmSync(DATA, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

const sh = (cmd: string[], cwd: string) => {
  const r = Bun.spawnSync(cmd, { cwd });
  if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${r.stderr.toString()}`);
};
let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  ok ? pass++ : fail++;
};

// удалённый репозиторий (фейковый origin) + рабочий
const remote = join(TMP, "remote.git");
const repo = join(TMP, "repo");
mkdirSync(remote, { recursive: true });
mkdirSync(repo, { recursive: true });
sh(["git", "init", "--bare", "-q"], remote);
writeFileSync(join(repo, "a.txt"), "one\n");
sh(["git", "init", "-q"], repo);
sh(["git", "config", "user.email", "t@t"], repo);
sh(["git", "config", "user.name", "t"], repo);
sh(["git", "add", "-A"], repo);
sh(["git", "commit", "-qm", "init"], repo);
sh(["git", "remote", "add", "origin", remote], repo);
sh(["git", "push", "-q", "-u", "origin", "HEAD:refs/heads/main"], repo);
const baseCommit = Bun.spawnSync(["git", "-C", repo, "rev-parse", "HEAD"]).stdout.toString().trim();

const { createWorktree, getWorktree, cleanupWorktree } = await import("../src/worktrees");
const { gitAction, gitStatus, sessionBranch } = await import("../src/git");
const { sessions, projects } = await import("../src/store");

const pid = (await projects.add("git-demo", repo)).id;
const wt = createWorktree("ses_git_demo", repo, "git");
await sessions.add({
  id: wt.sessionId, projectId: pid, agentId: "hermes", title: "git demo", prompt: "p",
  mode: "cli", worktree: { kind: "git", path: wt.path, baseRef: wt.baseRef, createdAt: wt.createdAt },
});
const sid = wt.sessionId;

// status: 0 изменений, detached HEAD
{
  const st = gitStatus(sid);
  check("status: копия есть", st.ok && st.branch !== "", st.detail);
}
// «агент» правит копию
writeFileSync(join(wt.path, "a.txt"), "one\ntwo\n");
writeFileSync(join(wt.path, "b.txt"), "new\n");

// commit (с detached HEAD — уходим на ветку сессии)
{
  const r = gitAction(sid, "commit", { message: "тест: правки" });
  check("commit", r.ok, r.detail);
  const head = Bun.spawnSync(["git", "-C", wt.path, "log", "--oneline", "-1"]).stdout.toString().trim();
  check("коммит в копии", head.includes("тест: правки"), head);
  const br = Bun.spawnSync(["git", "-C", wt.path, "rev-parse", "--abbrev-ref", "HEAD"]).stdout.toString().trim();
  check("ветка сессии создана", br === sessionBranch(sid), br);
}
// push в фейковый origin
{
  const r = gitAction(sid, "push");
  check("push", r.ok, r.detail);
  const ls = Bun.spawnSync(["git", "-C", repo, "ls-remote", "origin", sessionBranch(sid)]).stdout.toString().trim();
  check("ветка в remote", ls.includes(sessionBranch(sid)), ls);
}
// pr без gh → compare-URL (gh тут не авторизован)
{
  const r = gitAction(sid, "pr", { title: "тест PR" });
  check("pr без gh → compare-URL", !r.ok && typeof r.url === "string" && r.url.length > 0, `${r.detail} ${r.url ?? ""}`);
}
// merge: без подтверждения → отказ; с подтверждением → влито
{
  const noConfirm = gitAction(sid, "merge", { into: "main" });
  check("merge без confirm → отказ", !noConfirm.ok && noConfirm.detail.includes("подтверждение"), noConfirm.detail);
  const r = gitAction(sid, "merge", { into: "main", confirmed: true });
  check("merge в main", r.ok, r.detail);
  const inProject = await Bun.file(join(repo, "a.txt")).text();
  check("правки в боевом проекте", inProject.includes("two"), inProject.split("\n")[1]);
  const inProjectB = await Bun.file(join(repo, "b.txt")).text();
  check("новый файл в проекте", inProjectB.includes("new"), "");
  const head = Bun.spawnSync(["git", "-C", repo, "log", "--oneline", "-2"]).stdout.toString().trim();
  check("merge-коммит в проекте", head.includes("merge"), head.split("\n")[0]);
}
// status после merge: копия = HEAD проекта
{
  const st = gitStatus(sid);
  check("status после merge", st.ok, st.detail);
}
// merge повторно (без изменений) — git скажет already up to date, это не ошибка потока
{
  const r = gitAction(sid, "merge", { into: "main", confirmed: true });
  check("повторный merge не падает", typeof r.ok === "boolean", r.detail);
}

cleanupWorktree(sid);
await sessions.remove(sid);
await projects.remove(pid);
try { rmSync(TMP, { recursive: true, force: true }); } catch { /* Windows держит файлы — приберёт следующий прогон */ }
try { rmSync(DATA, { recursive: true, force: true }); } catch { /* Windows держит файлы — приберёт следующий прогон */ }
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
