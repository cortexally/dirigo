#!/usr/bin/env bun
// Конфликт-резолютор (V2-3.5) вживую: агент мержит версии и применение проходит.
// Запуск через resolver-test.ts (ставит env).
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveConflicts } from "../src/resolver";
import { createWorktree, getWorktree, cleanupWorktree } from "../src/worktrees";
import { sessions, projects } from "../src/store";

// Каталог данных — СВОЙ (см. git-scenario.ts): сценарий сносит каталог
// целиком, а унаследованный DIRIGO_DATA в агентской сессии — это каталог
// демона с чужими сессиями.
const DATA = process.env.DIRIGO_SCENARIO_DATA
  ? resolve(process.env.DIRIGO_SCENARIO_DATA)
  : join(tmpdir(), `dirigo-resolver-scenario-${process.pid}`);
process.env.DIRIGO_DATA = DATA; // библиотека берёт каталог данных отсюда
const TMP = join(import.meta.dir, "..", ".smoke-res");
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
mkdirSync(repo, { recursive: true });
writeFileSync(join(repo, "calc.js"), "function sum(a, b) {\n  return a + b;\n}\n");
sh(["git", "init", "-q"], repo);
sh(["git", "config", "user.email", "t@t"], repo);
sh(["git", "config", "user.name", "t"], repo);
sh(["git", "add", "-A"], repo);
sh(["git", "commit", "-qm", "init"], repo);

const pid = (await projects.add("res-demo", repo)).id;
const wt = createWorktree("ses_res_demo", repo, "git");
await sessions.add({
  id: wt.sessionId, projectId: pid, agentId: "kilo", title: "res", prompt: "p", mode: "cli",
  worktree: { kind: "git", path: wt.path, baseRef: wt.baseRef, createdAt: wt.createdAt },
});

// 1) «Другой эпик» применил в проект версию с умножением
writeFileSync(join(repo, "calc.js"), "function sum(a, b) {\n  return a + b;\n}\n\nfunction mul(a, b) {\n  return a * b;\n}\n");
// 2) Наш агент в копии добавил вычитание
writeFileSync(join(wt.path, "calc.js"), "function sum(a, b) {\n  return a + b;\n}\n\nfunction sub(a, b) {\n  return a - b;\n}\n");

// конфликт: оба меняли calc.js → обычный apply refused бы (грязный проект),
// здесь project версия уже изменена — apply переносит файл копии, затирая mul.
// Резолвтор должен смерзить: sum + mul + sub.
const { agentStatus } = await import("../src/setup/manager");
const resolverAgent = "kilo";
// «Установлен» ещё не значит «может работать»: агенту нужен ключ/вход.
// Без этого проверка ждала успешного мержа от агента, который заведомо не
// запустится, и падала на свежей машине сразу после установки CLI.
const st = agentStatus(resolverAgent);
// Вход в аккаунт (OAuth) заменяет ключ: kilo с auth.json работает без KILO_API_KEY.
const resolverReady = st.state === "installed" && (!st.envVar || st.keySet === true || st.signedIn === true);

let r = await resolveConflicts(wt.sessionId, ["calc.js"], resolverAgent);
// Живой агент на бесплатной модели иногда зависает (очередь провайдера) — тогда
// резолвер честно отказывается. Для готового агента даём ещё одну попытку:
// гейт проверяет пульт, а не загрузку чужой бесплатной модели.
if (resolverReady && !r.ok) {
  console.log(`  (первая попытка мержа не удалась: ${r.detail.slice(0, 100)} — повтор)`);
  r = await resolveConflicts(wt.sessionId, ["calc.js"], resolverAgent);
}
if (!r.ok) {
  // причина отказа — в журнале сессии-хозяина; без неё провал гейта не разобрать
  const { readLogTail } = await import("../src/store");
  const why = (await readLogTail(wt.sessionId, 30)).filter((l) => /резол|resolv/i.test(l)).slice(-3).join("\n").slice(-700);
  if (why) console.log(`  журнал резолва:\n${why}`);
}
const merged = await Bun.file(join(repo, "calc.js")).text();
const fns = merged.split("\n").filter((l) => l.includes("function")).join(" | ");

if (resolverReady) {
  check("resolve: агент сёржил и применил", r.ok && r.resolved.includes("calc.js"), r.detail.slice(0, 120));
  check("в проекте есть mul (версия проекта)", merged.includes("mul"), fns);
  check("в проекте есть sub (версия копии)", merged.includes("sub"), fns);
} else {
  // Ключевая гарантия: без резолвтора НИЧЕГО не применяется и версия
  // проекта остаётся нетронутой. Молчаливая потеря правок — худший исход.
  check(`резолвтор ${resolverAgent} не готов (${st.state}${st.envVar && !st.keySet ? ", нет ключа " + st.envVar : ""}) → отказ, а не ложный успех`,
    !r.ok, r.detail.slice(0, 120));
  check("версия проекта не затёрта", merged.includes("mul"), fns);
  check("копия не применена без мержа", !merged.includes("sub"), fns);
}
check("сумма на месте", merged.includes("return a + b"), "");
// агент пишет в копию, а не туда, откуда запущен пульт (регресс PWD, 1.9.1)
check("агент не оставил файл в папке демона", !(await Bun.file(join(process.cwd(), "calc.js")).exists()));

cleanupWorktree(wt.sessionId);
await sessions.remove(wt.sessionId);
await projects.remove(pid);
rmSync(TMP, { recursive: true, force: true });
try { rmSync(DATA, { recursive: true, force: true }); } catch { /* занято */ }
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
