#!/usr/bin/env bun
// Флаги запуска TUI: каждый агент стартует ровно той командой, что соберёт
// пульт (ptyLaunchArgv), с выбранной моделью и уровнем рассуждений, — и живёт.
//
// Зачем живой запуск: флаги CLI-режима и TUI у агентов разные, а --help
// это не всегда показывает. opencode без подкоманды не знает --model и
// падал «Unrecognized flag», kilo на --variant печатает справку и выходит,
// minimax принимает только provider/model. Такие регрессии ловятся только так.
//
//   bun run scripts/tui-flags-test.ts            (агенты, установленные на машине)
//   DIRIGO_TUI_AGENTS=kilo,claude-code ...       только эти
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AGENTS, type AgentDef } from "../src/agents/registry";
import { ptyLaunchArgv } from "../src/agents/runner";
import { commandResolvable } from "../src/agents/availability";
import { spawnPty, ptyStatus } from "../src/agents/pty";
import { Screen } from "../src/agents/screen";
import { killAgentDaemons, killPidTree } from "../src/agents/daemons";
import { listModels } from "../src/agents/models";

const ONLY = (process.env.DIRIGO_TUI_AGENTS ?? "").split(",").map((x) => x.trim()).filter(Boolean);
const LIVE_MS = Number(process.env.DIRIGO_TUI_LIVE_MS ?? 9000);
let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  ok ? pass++ : fail++;
};

if (!(await ptyStatus()).available) {
  console.log("PASS  PTY недоступен на этой машине — проверка неприменима\n\n1/1 passed");
  process.exit(0);
}

const TMP = join(import.meta.dir, "..", `.tui-flags-${Date.now().toString(36)}`);
const REPO = join(TMP, "repo");
mkdirSync(REPO, { recursive: true });
writeFileSync(join(REPO, "README.md"), "# tui flags\n");
for (const cmd of [["git", "init", "-q", "-b", "main"], ["git", "add", "-A"], ["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]]) Bun.spawnSync(cmd, { cwd: REPO });

/** Запуск TUI на LIVE_MS: жив ли и нет ли на экране отказа от флага. */
async function launch(def: AgentDef, argv: string[]): Promise<{ alive: boolean; reason: string }> {
  const screen = new Screen(36, 120);
  let exited: number | null = null;
  let raw = "";
  const h = await spawnPty(argv[0]!, argv.slice(1), {
    cwd: REPO, cols: 120, rows: 36,
    onData: (d) => { raw += d; screen.feed(d); },
    onExit: (c) => { exited = c; },
  });
  screen.onResponse = (r) => { try { h.write(r); } catch { /* */ } };
  const started = Date.now();
  while (Date.now() - started < LIVE_MS && exited === null) await Bun.sleep(250);
  const text = screen.plain() + "\n" + raw.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  // сначала закрываем ConPTY (иначе OpenConsole.exe остаётся сиротой), потом дерево
  const pid = h.pid;
  try { h.kill(); } catch { /* */ }
  killPidTree(pid);
  killAgentDaemons(REPO);
  const refused = /unrecognized (flag|option)|unknown (flag|option|argument)|invalid (flag|option|value)|must use provider\/model|^usage:/im.exec(text);
  return {
    alive: exited === null && !refused,
    reason: exited !== null ? `вышел с кодом ${exited}: ${text.split("\n").filter((l) => /error|unrecognized|unknown|invalid|usage/i.test(l)).slice(0, 2).join(" | ").slice(0, 160)}`
      : refused ? refused[0] : "",
  };
}

for (const def of AGENTS) {
  if (!def.ptyCommand || (ONLY.length && !ONLY.includes(def.id))) continue;
  if (!commandResolvable(def.ptyCommand.command).ok) { console.log(`SKIP  ${def.id}: не установлен`); continue; }
  // 1) как в диалоге по умолчанию: без модели и уровня
  const plain = await launch(def, ptyLaunchArgv(def, {}));
  check(`${def.id}: TUI стартует с настройками по умолчанию`, plain.alive, plain.reason);
  if (!plain.alive) continue;
  // 2) с выбранной моделью — если пульт её передаёт в TUI
  if (def.ptyCommand.modelFlag) {
    const list = await listModels(def.id).catch(() => ({ models: [] as string[] }));
    const model = (list.models ?? [])[0] ?? def.defaultModel;
    if (model) {
      const r = await launch(def, ptyLaunchArgv(def, { model }));
      check(`${def.id}: TUI принимает модель (${def.ptyCommand.modelFlag} ${model})`, r.alive, r.reason);
    } else console.log(`SKIP  ${def.id}: агент не отдал список моделей`);
  } else {
    // модель в TUI не передаётся — проверяем, что пульт её и не подставит
    const argv = ptyLaunchArgv(def, { model: "some/model" });
    check(`${def.id}: модель в TUI не передаётся (флаг не поддерживается)`, !argv.includes("some/model"), argv.slice(-3).join(" "));
  }
  // 3) с уровнем рассуждений — если пульт его передаёт в TUI
  const level = (def.reasoning ?? []).includes("high") ? "high" : (def.reasoning ?? [])[0];
  if (def.ptyCommand.reasoning && level) {
    const r = await launch(def, ptyLaunchArgv(def, { reasoning: level }));
    check(`${def.id}: TUI принимает уровень (${def.reasoningFlag} ${level})`, r.alive, r.reason);
  } else if (level) {
    const argv = ptyLaunchArgv(def, { reasoning: level });
    check(`${def.id}: уровень в TUI не передаётся (флаг не поддерживается)`, !argv.includes(level), argv.slice(-3).join(" "));
  }
}

for (let i = 0; i < 5; i++) { try { rmSync(TMP, { recursive: true, force: true }); break; } catch { killAgentDaemons(REPO); await Bun.sleep(1500); } }
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
