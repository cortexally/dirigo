// Тест не оставляет после себя процессы (предзагрузка из bunfig.toml, только для scripts/).
//
// Раньше за день прогонов висели десятки bun/агентов: тест гасил демон `server.kill()` —
// уходил только демон, его агенты оставались; упавший тест оставлял демон целиком.
//  1) DIRIGO_EXIT_WITH_PARENT=<pid теста> наследуют все дети: демон сам гаснет вместе
//     с агентами, если тест завершился любым способом (src/parent-watch.ts);
//  2) .kill() у процесса из Bun.spawn на Windows гасит всё дерево (taskkill /T);
//  3) на выходе теста гасятся деревья всех его ещё живых детей.
// Для демона и продукта ничего не меняется: включается, только если главный файл — в scripts/.
// Регресс-тест: scripts/test-cleanup-test.ts.

import { sep } from "node:path";

const FLAG = Symbol.for("dirigo.testCleanup");

export function isTestMain(main = Bun.main): boolean {
  return process.env.DIRIGO_TEST_CLEANUP === "1" || main.replace(/[\\/]/g, sep).includes(`${sep}scripts${sep}`);
}

function killTree(pid: number): void {
  try {
    if (process.platform === "win32") Bun.spawnSync(["taskkill", "/PID", String(pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore", windowsHide: true, timeout: 10_000 });
    else process.kill(pid, "SIGKILL");
  } catch { /* уже завершён */ }
}

export function installTestCleanup(): boolean {
  const g = globalThis as any;
  if (g[FLAG] || !isTestMain()) return false;
  g[FLAG] = true;
  process.env.DIRIGO_EXIT_WITH_PARENT = String(process.pid);
  const live = new Set<any>();
  const B = Bun as any;
  const spawn = B.spawn;
  B.spawn = (...a: any[]) => {
    const proc = spawn.apply(B, a);
    live.add(proc);
    void proc.exited.then(() => live.delete(proc), () => live.delete(proc));
    if (process.platform === "win32") {
      const orig = proc.kill.bind(proc);
      try {
        proc.kill = (sig?: any) => { if (proc.exitCode === null) killTree(proc.pid); return orig(sig); };
      } catch { /* свойство не перезаписать — останется уборка на выходе */ }
    }
    return proc;
  };
  process.on("exit", () => {
    for (const p of live) if (p.exitCode === null) killTree(p.pid);
  });
  return true;
}

installTestCleanup();
