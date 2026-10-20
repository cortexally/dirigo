// Демон, поднятый тестом, не переживает тест.
//
// Тесты гасили демон `server.kill()` — уходил только сам демон, а агенты, которых он
// запустил (kilo acp, cline, opencode…), оставались висеть. Упавший или убитый тест
// оставлял демон целиком. За день прогонов таких процессов набиралось десятки.
//
// Если задан DIRIGO_EXIT_WITH_PARENT=<pid> (его ставит предзагрузка тестов
// scripts/test-cleanup.ts), демон раз в 2 с проверяет родителя; родителя нет —
// гасит своё дерево процессов (агентов вместе с собой) и выходит. У продукта
// переменная не задана — поведение не меняется.

export function parentAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === "EPERM"; }
}

/** Погасить дерево процессов этого демона (агенты) и выйти. */
export function exitWithTree(code = 0): never {
  try {
    if (process.platform === "win32") {
      // /T без самого себя невозможен: taskkill гасит дерево вместе с нами
      Bun.spawnSync(["taskkill", "/PID", String(process.pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore", windowsHide: true, timeout: 10_000 });
    } else {
      try { process.kill(-process.pid, "SIGTERM"); } catch { /* не лидер группы */ }
    }
  } catch { /* выходим всё равно */ }
  process.exit(code);
}

export function watchParent(intervalMs = 2000): ReturnType<typeof setInterval> | null {
  const pid = Number(process.env.DIRIGO_EXIT_WITH_PARENT);
  if (!pid || pid === process.pid) return null;
  const t = setInterval(() => {
    if (!parentAlive(pid)) {
      console.log(`[dirigo] процесс-родитель ${pid} завершён — останавливаю демон и агентов`);
      exitWithTree(0);
    }
  }, intervalMs);
  (t as any).unref?.();
  return t;
}
