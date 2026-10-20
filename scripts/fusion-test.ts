#!/usr/bin/env bun
// Fusion (V2-3.3) — обёртка: env ДО старта процесса, затем дочерний сценарий.
import { rmSync } from "node:fs";

const dataDir = new URL("./../.smoke-fusion-data/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const scenario = new URL("./fusion-scenario.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
rmSync(dataDir, { recursive: true, force: true });

const child = Bun.spawn({
  cmd: [process.execPath, "run", scenario],
  env: { ...process.env, DIRIGO_SCENARIO_DATA: dataDir, DIRIGO_DATA: dataDir, DIRIGO_AUTO_CHECKS: "0" },
  stdout: "inherit",
  stderr: "inherit",
  stdin: "ignore",
});
const code = await child.exited;
process.exit(code);
