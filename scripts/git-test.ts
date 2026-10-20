#!/usr/bin/env bun
// Git-кнопки (V2-1.5) — обёртка: env ДО старта процесса, затем дочерний сценарий.
import { rmSync } from "node:fs";

const dataDir = new URL("./../.smoke-git-data/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const scenario = new URL("./git-scenario.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
rmSync(dataDir, { recursive: true, force: true });

const child = Bun.spawn({
  cmd: [process.execPath, "run", scenario],
  env: { ...process.env, DIRIGO_SCENARIO_DATA: dataDir, DIRIGO_DATA: dataDir },
  stdout: "inherit",
  stderr: "inherit",
  stdin: "ignore",
});
const code = await child.exited;
try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* занято */ }
process.exit(code);
