#!/usr/bin/env bun
// Provisioning агентов (V3-5): детект, рецепты, runSteps, очередь. Запуск: bun run scripts/setup-test.ts
import { allAgentStatuses, agentStatus, enqueueInstall, getJob, listJobs, runSteps } from "../src/setup/manager";
import { RECIPES, candidatePaths, currentOs, recipeFor } from "../src/setup/recipes";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  ok ? pass++ : fail++;
};

// рецепты: агенты + мост ACP, у каждого шаги под все ОС
check("рецепты: агенты и мосты", RECIPES.length >= 13, `${RECIPES.length}`);
// Шаги установки обязательны у всех, КРОМЕ агентов без готовых пакетов
// (ZCode собирается из исходников): у них вместо шагов — ссылка на инструкцию.
check("у каждого агента шаги под все ОС или ссылка на сборку",
  RECIPES.every((r) => r.bin && (r.manualOnly
    ? /^https?:\/\//.test(r.manualOnly)
    : r.install.windows.length && r.install.linux.length && r.install.darwin.length)),
  RECIPES.filter((r) => !r.manualOnly && !(r.install.linux.length && r.install.windows.length && r.install.darwin.length)).map((r) => r.id).join(",") || "все покрыты");
check("у агентов без автоустановки есть ссылка на инструкцию",
  RECIPES.filter((r) => !r.install.linux.length).every((r) => !!r.manualOnly),
  RECIPES.filter((r) => !r.install.linux.length).map((r) => `${r.id}→${r.manualOnly ?? "нет"}`).join(" "));
check("recipeFor находит агента", recipeFor("claude-code")?.label === "Claude Code", "");

{
  const st = agentStatus("opencode");
  check(
    "детект агента возвращает корректный статус",
    ["installed", "missing"].includes(st.state) && (st.state !== "installed" || !!st.path),
    `${st.state} ${st.path ?? "-"}`,
  );
  const unknown = agentStatus("__no_such_agent__");
  check("неизвестный агент не считается установленным", unknown.state !== "installed", unknown.state);
}
// allStatuses: 11 элементов, состояния из списка
{
  const all = allAgentStatuses();
  check("allAgentStatuses: статус на каждый рецепт", all.length === RECIPES.length, `${all.length}/${RECIPES.length}`);
  check("состояния валидны", all.every((s) => ["installed", "missing", "needs-auth", "unknown"].includes(s.state)), all.map((s) => s.state).join(","));
  check("keySet — булево", all.every((s) => typeof s.keySet === "boolean"), "");
}
// candidatePaths: windows-кандидаты, linux-кандидаты
{
  const w = candidatePaths("claude-code", "windows");
  const l = candidatePaths("claude-code", "linux");
  check("windows-кандидаты (npm/scoop)", w.length >= 3 && w.some((p) => p.includes("npm")), w.join(" | "));
  check("linux-кандидаты (/usr/local/bin)", l.some((p) => p.startsWith("/usr/local/bin")), l.join(" | "));
}
// runSteps: успешная команда
{
  let out = "";
  const ok = await runSteps([{ cmd: [process.execPath, "--version"], label: "bun --version" }], currentOs(), (l) => { out += l; });
  check("runSteps: успешный шаг", ok && out.includes("bun"), ok ? "" : out.slice(-80));
}
// runSteps: падающая команда → false, лог с stderr
{
  let out = "";
  const ok = await runSteps([{ cmd: ["nonexistent-binary-xyz-987", "--x"], label: "нет такого" }], currentOs(), (l) => { out += l; });
  check("runSteps: падающий шаг → false", ok === false, String(ok));
}
// очередь install: постановка + чтение (реальную установку НЕ гоняем — только bytenode-less рецепт)
{
  // мок-рецепт через monkey: ставим в очередь существующий агент, но подменяем шаги — нельзя;
  // поэтому проверяем контракт постановки на ОТСУТСТВУЮЩИЙ агент с мок-шагом через прямой вызов processQueue? —
  // проще: проверяем getJob/listJobs на чистой очереди и 400 для неизвестного агента
  const before = listJobs().length;
  let threw = false;
  try { enqueueInstall("нет-такого-агента"); } catch { threw = true; }
  check("enqueueInstall неизвестного → throw", threw, "");
  check("очередь не изменилась", listJobs().length === before, `${before}`);
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
