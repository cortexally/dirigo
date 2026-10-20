#!/usr/bin/env bun
// Fusion (V2-3.3): гонка агентов + судья. Запуск через fusion-test.ts (ставит env).
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  applyFusion, createFusion, deleteFusion, getFusion, judgeFusion,
  listFusions, loadFusions, markCandidateFinished, refreshFusion, startFusion,
} from "../src/fusion";
import { sessions, projects } from "../src/store";
import { getWorktree } from "../src/worktrees";

// Каталог данных — СВОЙ (см. git-scenario.ts): сценарий сносит каталог
// целиком, а унаследованный DIRIGO_DATA в агентской сессии — это каталог
// демона с чужими сессиями.
const DATA = process.env.DIRIGO_SCENARIO_DATA
  ? resolve(process.env.DIRIGO_SCENARIO_DATA)
  : join(tmpdir(), `dirigo-fusion-scenario-${process.pid}`);
process.env.DIRIGO_DATA = DATA; // библиотека берёт каталог данных отсюда
const TMP = join(import.meta.dir, "..", ".smoke-fusion");
rmSync(TMP, { recursive: true, force: true });
try { rmSync(DATA, { recursive: true, force: true }); } catch { /* файлы заняты — приберёт следующая чистка */ }
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

const repo = join(TMP, "repo");
mkdirSync(repo, { recursive: true });
writeFileSync(join(repo, "app.js"), "console.log(1)\n");
sh(["git", "init", "-q"], repo);
sh(["git", "config", "user.email", "t@t"], repo);
sh(["git", "config", "user.name", "t"], repo);
sh(["git", "add", "-A"], repo);
sh(["git", "commit", "-qm", "init"], repo);

loadFusions();
const pid = (await projects.add("fusion-demo", repo)).id;
const run = createFusion({
  title: "гонка", prompt: "сделай X", projectId: pid,
  agents: ["hermes", "cursor", "devin"], judgeAgentId: "kilo",
});
check("fusion создана (draft, 3 кандидата)", run.status === "draft" && run.agents.length === 3, run.id);
check("fusion в списке", listFusions().some((r) => r.id === run.id));

const { runner } = await import("../src/agents/runner");
const started = await startFusion(run.id);
check("startFusion: 3 кандидата запущены", started.ok && started.started === 3, `started=${started.started}`);
check("кандидаты имеют копии", run.candidates.every((c) => getWorktree(c.sessionId!)), "");
check("fusion → running", getFusion(run.id)!.status === "running");
const again = await startFusion(run.id);
check("повторный старт не дублирует", !again.ok, `${again.started}`);

// гасим агентные процессы
for (const c of run.candidates) await runner.stopSession(c.sessionId!);
await new Promise((r) => setTimeout(r, 1200));

// «ответы» кандидатов: в лог двух кладём ответы
const c0 = run.candidates[0]!, c1 = run.candidates[1]!;
const { messages } = await import("../src/store");
await messages.add(c0.sessionId!, "agent", "WINNER: hermes — решение через кэш");
// c1 без ответа → failed
await markCandidateFinished(c0.sessionId!);
await markCandidateFinished(c1.sessionId!);
check("кандидат 0 → done с ответом", c0.status === "done" && (c0.answer ?? "").includes("WINNER"), c0.status);
check("кандидат 1 без ответа → failed", c1.status === "failed", c1.status);

// refresh: пересчёт нетерминальных
const rf = refreshFusion(run.id);
check("refreshFusion", rf.ok, JSON.stringify(rf));

// judge: без готовых к судейству (c2 ещё running?) — контракт
{
  const ghost = createFusion({ title: "g", prompt: "p", projectId: pid, agents: ["hermes", "cursor"] });
  const jr = await judgeFusion(ghost.id);
  check("judge без ответов → отказ", !jr.ok, jr.error ?? "");
  deleteFusion(ghost.id);
}

// применение без победителя → отказ
{
  const ar = applyFusion(run.id);
  check("apply без победителя → отказ", !ar.ok, ar.detail);
}

// правка копии победителя + применение (имитируем вердикт судьи)
writeFileSync(join(getWorktree(c0.sessionId!)!.path, "app.js"), "console.log(1)\nconsole.log(2)\n");
getFusion(run.id)!.winnerId = c0.id;
getFusion(run.id)!.verdict = "WINNER: hermes — решение через кэш";
{
  const ar = applyFusion(run.id);
  check("apply победителя", ar.ok, ar.detail);
  const inProject = await Bun.file(join(repo, "app.js")).text();
  check("правка победителя в проекте", inProject.includes("console.log(2)"), inProject.split("\n")[1]);
  check("fusion → applied", getFusion(run.id)!.status === "applied");
}

// удаление убирает копии
deleteFusion(run.id);
check("deleteFusion убирает копии", !getWorktree(c0.sessionId!) && listFusions().length === 0, "");
for (const c of run.candidates) await sessions.remove(c.sessionId!).catch(() => {});
await projects.remove(pid);

try { rmSync(TMP, { recursive: true, force: true }); } catch { /* Windows держит файлы — приберёт следующий прогон */ }
try { rmSync(DATA, { recursive: true, force: true }); } catch { /* файлы заняты — приберёт следующая чистка */ }
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
