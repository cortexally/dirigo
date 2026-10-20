#!/usr/bin/env bun
// Конфликт-резолютор (V2-3.5) — обёртка: env ДО старта процесса.
import { rmSync } from "node:fs";

const dataDir = new URL("./../.smoke-res-data/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const scenario = new URL("./resolver-scenario.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
rmSync(dataDir, { recursive: true, force: true });

const child = Bun.spawn({
  cmd: [process.execPath, "run", scenario],
  env: { ...process.env, DIRIGO_SCENARIO_DATA: dataDir, DIRIGO_DATA: dataDir },
  stdout: "inherit",
  stderr: "inherit",
  stdin: "ignore",
});
const code = await child.exited;
process.exit(code);
