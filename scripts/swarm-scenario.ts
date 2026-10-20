#!/usr/bin/env bun
// Сценарий проверки режима Swarm (V2-3.2). Запуск через swarm-test.ts (ставит env).
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  applySwarm, applyWorker, commonFeed, createSwarm, deleteSwarm, getSwarm,
  getWorker, judgeSwarm, listSwarms, loadSwarms, markWorkerFinished, startSwarm,
} from "../src/swarm";
import { sessions, projects } from "../src/store";
import { getWorktree } from "../src/worktrees";

const DATA = process.env.DIRIGO_DATA!;
const TMP = join(import.meta.dir, "..", ".smoke-swarm");
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

const repo = join(TMP, "repo");
mkdirSync(join(repo, "api"), { recursive: true });
mkdirSync(join(repo, "ui"), { recursive: true });
writeFileSync(join(repo, "api", "a.py"), "x = 1\n");
writeFileSync(join(repo, "ui", "b.js"), "let a = 1\n");
sh(["git", "init", "-q"], repo);
sh(["git", "config", "user.email", "t@t"], repo);
sh(["git", "config", "user.name", "t"], repo);
sh(["git", "add", "-A"], repo);
sh(["git", "commit", "-qm", "init"], repo);

loadSwarms();
const pid = (await projects.add("swarm-demo", repo)).id;
const task = createSwarm({
  title: "рефакторинг", goal: "обновить оба модуля",
  projectId: pid, agentId: "hermes",
  zones: ["api/a.py", "ui/b.js", "shared/no-such.txt"],
});
check("рой создан (draft, 3 участка)", task.status === "draft" && task.workers.length === 3, task.id);
check("рой в списке", listSwarms().some((t) => t.id === task.id));

// старт: копия + агент на каждый участок
const { runner } = await import("../src/agents/runner");
const started = await startSwarm(task.id);
check("startSwarm: 3 воркера запущены", started.ok && started.started === 3, `started=${started.started}`);
check("воркеры имеют копии", task.workers.every((w) => getWorktree(w.sessionId!)), "");
check("рой → running", getSwarm(task.id)!.status === "running");
const again = await startSwarm(task.id);
check("повторный старт не дублирует", again.started === 0 && !again.ok, `${again.started}`);

// гасим агентные процессы и даём авто-хуку отработать
for (const w of task.workers) await runner.stopSession(w.sessionId!);
await new Promise((r) => setTimeout(r, 1500));

// воркеры «правят» свои копии
const w0 = task.workers[0]!, w1 = task.workers[1]!, w2 = task.workers[2]!;
writeFileSync(join(getWorktree(w0.sessionId!)!.path, "api", "a.py"), "x = 2\n");
writeFileSync(join(getWorktree(w1.sessionId!)!.path, "ui", "b.js"), "let a = 2\nlet b = 3\n");

// хук: пересчитываем статусы (воркер 1 помечаем блокером)
{
  const { messages } = await import("../src/store");
  await messages.add(w1.sessionId!, "agent", "BLOCKED: нужен доступ к чужому участку");
}
await markWorkerFinished(w0.sessionId!);
await markWorkerFinished(w1.sessionId!);
check("воркер 0 → done", w0.status === "done", w0.status);
check("воркер 1 → blocked", w1.status === "blocked", w1.status);
check("рой → review после отработки", getSwarm(task.id)!.status === "review", getSwarm(task.id)!.status);
check("общая лента содержит участки", commonFeed(getSwarm(task.id)!).includes("api/a.py") && commonFeed(getSwarm(task.id)!).includes("blocked"), "");

// судья по дедлоку: вердикт SKIP для blocked (имитируем ответ агента нельзя —
// проверяем контракт ошибки: судья без копии → skip)
{
  const ghost = createSwarm({ title: "g", goal: "g", projectId: pid, agentId: "hermes", zones: ["z1"] });
  ghost.workers[0]!.status = "blocked";
  const r = await judgeSwarm(ghost.id);
  check("judge: контракт (без копии → skip)", r.ok && r.judged === 0, JSON.stringify(r));
  deleteSwarm(ghost.id);
}

// применение: done-воркера
const a0 = applyWorker(task.id, w0.id);
check("apply воркера 0", a0.ok && (getWorker(task.id, w0.id)!.status === "applied"), a0.detail);
check("правка в проекте", (await Bun.file(join(repo, "api", "a.py")).text()).includes("x = 2"));
const a1 = applyWorker(task.id, w1.id);
check("apply blocked-воркера → отказ", !a1.ok, a1.detail);
// вторая копия того же файла → конфликт по файлам: симулируем вторым done-воркером,
// который трогает УЖЕ применённый api/a.py — для этого воркер 2 правит свою копию
writeFileSync(join(getWorktree(w2.sessionId!)!.path, "api", "a.py"), "x = 99\n");
w2.status = "done";
const a2 = applyWorker(task.id, w2.id);
check("apply воркера с уже применённым файлом → конфликт", !a2.ok && a2.detail.includes("api/a.py"), a2.detail);

// apply-all: применённых больше нет
const all = applySwarm(task.id);
check("applySwarm: новых применений нет", all.applied === 0, JSON.stringify(all));

// удаление роя убирает копии
deleteSwarm(task.id);
check("deleteSwarm убирает копии", !getWorktree(w0.sessionId!) && listSwarms().length === 0, "");
for (const w of task.workers) await sessions.remove(w.sessionId!).catch(() => {});
await projects.remove(pid);

rmSync(TMP, { recursive: true, force: true });
rmSync(DATA, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
