#!/usr/bin/env bun
// V3-1/2/3 (деплой/машины/tunnel) — обёртка: env ДО старта процесса.
import { rmSync } from "node:fs";

const dataDir = new URL("./../.smoke-deploy-data/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const scenario = new URL("./deploy-scenario.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
rmSync(dataDir, { recursive: true, force: true });

const child = Bun.spawn({
  cmd: [process.execPath, "run", scenario],
  env: { ...process.env, DIRIGO_DATA: dataDir },
  stdout: "inherit",
  stderr: "inherit",
  stdin: "ignore",
});
const code = await child.exited;
process.exit(code);
