#!/usr/bin/env bun
// Swarm (V2-3.2) — обёртка прогона: env ДО старта процесса (Bun кэширует
// окружение на загрузке модулей), затем дочерний процесс сценария.
import { rmSync } from "node:fs";

const dataDir = new URL("./../.smoke-swarm-data/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const scenario = new URL("./swarm-scenario.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
rmSync(dataDir, { recursive: true, force: true });

const child = Bun.spawn({
  cmd: [process.execPath, "run", scenario],
  env: { ...process.env, DIRIGO_DATA: dataDir, DIRIGO_AUTO_CHECKS: "0" },
  stdout: "inherit",
  stderr: "inherit",
  stdin: "ignore",
});
const code = await child.exited;
process.exit(code);
