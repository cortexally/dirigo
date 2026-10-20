// Сценарий проверки режима Orchestrator (V2-3.4): план → эпики → копии →
// конфликты → применение. Запуск через orchestrator-test.ts (он ставит env).
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyEpic, applyPlan, createPlan, deletePlan, getEpic, getPlan, listPlans,
  loadPlans, markEpicSessionFinished, planSummary, startPlan, updatePlan, verifyEpic,
} from "../src/orchestrator";
import { sessions, projects } from "../src/store";
import { getWorktree } from "../src/worktrees";

const DATA = process.env.DIRIGO_DATA!;
const TMP = join(import.meta.dir, "..", ".smoke-orch");
const TRACE = join(import.meta.dir, "..", ".smoke-orch-trace.log");
const trace = (msg: string) => appendFileSync(TRACE, `${new Date().toISOString()} ${msg}\n`);
rmSync(TMP, { recursive: true, force: true });
rmSync(DATA, { recursive: true, force: true });
rmSync(TRACE, { force: true });
mkdirSync(TMP, { recursive: true });
trace("setup done");

const sh = (cmd: string[], cwd: string) => {
  const r = Bun.spawnSync(cmd, { cwd });
  if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${r.stderr.toString()}`);
};

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  trace(`check: ${name} = ${ok} ${detail}`);
  ok ? pass++ : fail++;
};

// git-проект планирования
const repo = join(TMP, "repo");
mkdirSync(repo, { recursive: true });
writeFileSync(join(repo, "app.js"), "console.log(1)\n");
writeFileSync(join(repo, "readme.md"), "# demo\n");
sh(["git", "init", "-q"], repo);
sh(["git", "config", "user.email", "t@t"], repo);
sh(["git", "config", "user.name", "t"], repo);
sh(["git", "add", "-A"], repo);
sh(["git", "commit", "-qm", "init"], repo);

loadPlans();
const pid = (await projects.add("orch-demo", repo)).id;
trace(`project add: pid=${pid} path=${projects.get(pid)?.path ?? "MISS"} repo=${repo}`);
const plan = createPlan({
  goal: "запустить подписки в приложении",
  projectId: pid,
  agentId: "hermes",
  epics: [
    { title: "Модель подписки", criteria: ["файл billing.md создан"] },
    { title: "UI экрана подписки", criteria: ["app.js изменён"] },
  ],
});
check("план создан (draft, 2 эпика)", plan.status === "draft" && plan.epics.length === 2, plan.id);
check("план в списке", listPlans().some((p) => p.id === plan.id));

// правка цели
updatePlan(plan.id, { goal: "запустить подписки v2" });
check("PATCH цели", getPlan(plan.id)!.goal === "запустить подписки v2");

// старт плана: на каждый эпик — реальная копия + сессия hermes
trace("before runner import");
const { runner } = await import("../src/agents/runner");
trace("runner imported");
const started = await startPlan(plan.id);
trace("startPlan done: " + JSON.stringify(started));
check("startPlan: 2 эпика запущены", started.ok && started.started === 2, `started=${started.started}`);
const epic1 = plan.epics[0]!, epic2 = plan.epics[1]!;
check("эпики имеют копии", !!getWorktree(epic1.sessionId!) && !!getWorktree(epic2.sessionId!), epic1.sessionId ?? "-");
check("план → running", getPlan(plan.id)!.status === "running");

// повторный старт не дублирует
const again = await startPlan(plan.id);
check("повторный startPlan не дублирует", again.started === 0 && !again.ok, `started=${again.started} ok=${again.ok}`);

// сразу гасим агентные процессы (one-shot не всегда сам завершается)
for (const sid of [epic1.sessionId!, epic2.sessionId!]) await runner.stopSession(sid);

// «агент» правит копии эпиков
const w1 = getWorktree(epic1.sessionId!)!.path;
const w2 = getWorktree(epic2.sessionId!)!.path;
writeFileSync(join(w1, "billing.md"), "# Billing\n");
writeFileSync(join(w2, "app.js"), "console.log(1)\nconsole.log(2)\n");

// хук завершения: эпик → review
await markEpicSessionFinished(epic1.sessionId!);
check("эпик → review после работы", epic1.status === "review", epic1.status);

// контракт ошибок сверки
{
  const r1 = await verifyEpic(plan.id, "epic_nope");
  check("verify неизвестного эпика → ошибка", !r1.ok, r1.error ?? "");
  const ghost = createPlan({ goal: "g", projectId: pid, agentId: "hermes", epics: [{ title: "не запущен" }] });
  const r2 = await verifyEpic(ghost.id, ghost.epics[0]!.id);
  check("verify незапущенного эпика → ошибка", !r2.ok, r2.error ?? "");
  deletePlan(ghost.id);
}

// имитируем вердикты PASS → done
epic1.status = "done";
epic1.verdict = "PASS — billing.md создан";
epic1.touched = ["billing.md"];
epic2.status = "done";
epic2.verdict = "PASS — app.js изменён";
epic2.touched = ["app.js"];
// третий эпик пересечётся с первым по файлу — с НАСТОЯЩЕЙ копией
{
  const { createWorktree } = await import("../src/worktrees");
  const wt3 = createWorktree("ses_epic3_dbg", repo, "git");
  await sessions.add({
    id: wt3.sessionId,
    projectId: pid,
    agentId: "hermes",
    title: "[эпик] Конфликтующий",
    prompt: "тест",
    mode: "cli",
    workMode: "orchestrator",
    worktree: { kind: wt3.kind, path: wt3.path, baseRef: wt3.baseRef, createdAt: wt3.createdAt },
  });
  writeFileSync(join(wt3.path, "billing.md"), "# Conflicting billing\n");
  getPlan(plan.id)!.epics.push({
    id: "epic_conflict_test", title: "Конфликтующий", criteria: [], status: "done",
    verdict: "PASS — тест", touched: ["billing.md"], sessionId: wt3.sessionId, createdAt: Date.now(),
  });
}

// применение эпика 1
{
  const { diffWorktree } = await import("../src/worktrees");
  const d0 = diffWorktree(epic1.sessionId!);
  trace(`epic1 diff: files=${d0.files.length} +${d0.added} -${d0.deleted} paths=${d0.files.slice(0, 6).map((f) => `${f.path}(${f.status},+${f.added},-${f.deleted})`).join(",")}`);
  const w = getWorktree(epic1.sessionId!)!;
  trace(`epic1 copy path: ${w.path} kind=${w.kind} project=${w.projectPath}`);
}
const a1 = applyEpic(plan.id, epic1.id);
check("apply эпика 1", a1.ok && (getEpic(plan.id, epic1.id)!.applied ?? []).includes("billing.md"), a1.detail);
check("файл в проекте", Bun.file(join(repo, "billing.md")).size > 0);

// эпик 2 — без пересечений
const a2 = applyEpic(plan.id, epic2.id);
check("apply эпика 2 (без конфликта)", a2.ok, a2.detail);

// эпик 3 пересекается по файлу → конфликт
const a3 = applyEpic(plan.id, "epic_conflict_test");
check("apply эпика 3 → конфликт файлов", !a3.ok && a3.detail.includes("billing.md"), a3.detail);
check("эпик 3 → status conflict", getEpic(plan.id, "epic_conflict_test")!.status === "conflict");

// pending-эпик не применяется
const pendingPlan = createPlan({ goal: "g2", projectId: pid, agentId: "hermes", epics: [{ title: "в ожидании" }] });
const a4 = applyEpic(pendingPlan.id, pendingPlan.epics[0]!.id);
check("apply pending-эпика → отказ", !a4.ok, a4.detail);

// сводка плана
const sum = planSummary(getPlan(plan.id)!);
check("сводка плана", sum.epics === 3 && sum.applied === 2 && sum.conflict === 1, JSON.stringify(sum));

// применение всех готовых эпиков одним вызовом (уже применены → 0)
const all = applyPlan(plan.id);
check("applyPlan идемпотентен", all.applied === 0 && all.ok, JSON.stringify(all));

// удаление плана убирает копии
deletePlan(plan.id);
deletePlan(pendingPlan.id);
trace(`after delete: wt1=${getWorktree(epic1.sessionId!) ? "есть" : "нет"} wt2=${getWorktree(epic2.sessionId!) ? "есть" : "нет"} wt3=${getWorktree("ses_epic3_dbg") ? "есть" : "нет"} plans=${listPlans().length}`);
check("deletePlan убирает копии", !getWorktree(epic1.sessionId!) && listPlans().length === 0, "");

// чистка сессий эпиков
for (const sid of [epic1.sessionId!, epic2.sessionId!, "ses_epic3_dbg"]) await sessions.remove(sid);
await projects.remove(pid);

try { rmSync(TMP, { recursive: true, force: true }); } catch { /* Windows держит файлы — приберёт следующий прогон */ }
try { rmSync(DATA, { recursive: true, force: true }); } catch { /* Windows держит файлы — приберёт следующий прогон */ }
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
