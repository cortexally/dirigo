#!/usr/bin/env bun
// Контракты реестра агентов и сборки командной строки — без запуска агентов.
// Каждая проверка здесь — реальный дефект, найденный у пользователя.
import { AGENTS, getAgent, buildArgs } from "../src/agents/registry";
import { ptyLaunchArgv } from "../src/agents/runner";
import { parseModelLines } from "../src/agents/models";
import { editorEnv } from "../src/open-editor";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  ok ? pass++ : fail++;
};

/* ── TUI получает только проверенные флаги (живая проверка — tui-flags-test) ── */
const oc = getAgent("opencode")!;
check("opencode TUI: модель не передаётся (TUI не знает --model)", !ptyLaunchArgv(oc, { model: "opencode/beam-free" }).includes("--model"));
const kilo = getAgent("kilo")!;
check("kilo TUI: --variant не передаётся (печатает справку и выходит)", !ptyLaunchArgv(kilo, { reasoning: "high" }).includes("--variant"));
check("kilo TUI: модель передаётся", ptyLaunchArgv(kilo, { model: "kilo/kilo-auto/free" }).includes("--model"));
const claude = getAgent("claude-code")!;
check("claude TUI: --model и --effort передаются", ["--model", "--effort"].every((f) => ptyLaunchArgv(claude, { model: "opus", reasoning: "high" }).includes(f)));
check("TUI без выбора — без флагов модели/уровня", AGENTS.filter((a) => a.ptyCommand).every((a) => ptyLaunchArgv(a, {}).length === a.ptyCommand!.command.length));
check("вход в аккаунт — команда входа, без флагов модели", (() => { const fb = getAgent("freebuff")!; const v = ptyLaunchArgv(fb, { loginSession: true, model: "x" }); return v.includes("login") && !v.includes("x"); })());

/* ── уровни рассуждений — только у агентов с флагом ── */
check("reasoning[] только у агентов с флагом", AGENTS.every((a) => (a.reasoningFlag ? (a.reasoning ?? []).length > 0 : (a.reasoning ?? []).length === 0)));
check("CLI: неизвестный уровень не уходит агенту", !buildArgs(claude, "s", "p", ".", undefined, "extra").includes("extra"));
const hermes = getAgent("hermes")!;
const hz = buildArgs(hermes, "s", "задача", ".", "nous/x", "high");
check("hermes CLI: флаги не разрывают пару -z <задача>", hz[hz.indexOf("-z") + 1] === "задача", hz.join(" "));

/* ── модели: формат и разбор ── */
const mm = getAgent("minimax")!;
check("minimax: нет моделей в чужом формате (нужен provider/model)", (mm.models ?? []).every((m) => m.includes("/")), JSON.stringify(mm.models));
const devinOut = `Available models (55 families)

Adaptive (adaptive)
  adaptive                                       Adaptive  [$0.5 / 1M Input · $0.1 / 1M Cached input · $2 / 1M Output]

SWE-2 (swe-2)
  aliases: swe
  swe-2-high                                     SWE-2 High
  swe-2-medium                                   SWE-2 Medium
`;
const dm = parseModelLines(devinOut);
check("модели devin: таблица по семействам разбирается", dm.join(",") === "adaptive,swe-2-high,swe-2-medium", dm.join(","));
check("модели kilo/opencode: по одной в строке", parseModelLines("kilo/a/b\nopencode/x-y\nINFO started\n").join(",") === "kilo/a/b,opencode/x-y");

/* ── «Открыть в редакторе»: окружение Electron-редактора ── */
process.env.ELECTRON_RUN_AS_NODE = "1";
process.env.NODE_OPTIONS = "--inspect";
const env = editorEnv();
check("редактор: ELECTRON_RUN_AS_NODE не наследуется (иначе окно не открывается)", !("ELECTRON_RUN_AS_NODE" in env) && !("NODE_OPTIONS" in env) && !!env.PATH || !!env.Path);
delete process.env.ELECTRON_RUN_AS_NODE; delete process.env.NODE_OPTIONS;

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
