#!/usr/bin/env bun
// Оркестратор (V2-3.4) — обёртка прогона.
// ВАЖНО: DIRIGO_DATA должен быть выставлен ДО старта процесса — установка env
// внутри entry-модуля не всегда доходит до статических импортов (проверено на
// Bun 1.4.3: динамический import внутри entry видел старое окружение). Поэтому
// перезапускаем сценарий дочерним процессом с правильным env.
import { rmSync } from "node:fs";

const dataDir = new URL("./../.smoke-orch-data/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const scenario = new URL("./orchestrator-scenario.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
rmSync(dataDir, { recursive: true, force: true });

const child = Bun.spawn({
  cmd: [process.execPath, "run", scenario],
  // авто-проверки выключены: сценарий тестирует план/конфликты, а не ревью-поток
  // (иначе checksAfterRun перезапускает агента с фидбеком и держит каталог копии)
  env: { ...process.env, DIRIGO_DATA: dataDir, DIRIGO_AUTO_CHECKS: "0" },
  stdout: "inherit",
  stderr: "inherit",
  stdin: "ignore",
});
const code = await child.exited;
process.exit(code);
