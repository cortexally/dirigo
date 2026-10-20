/* ── сценарий 7: статус врёт, процесс жив — каталог набора не сносим ─────── */
{
  // Реальный случай: агент работал, а статус сессии был «done» (в режиме
  // «Задача (CLI)» выход второго процесса объявляет сессию готовой, пока
  // основной агент ещё работает). Набор видел «живых сессий нет» — и сносил
  // каталог данных, а вместе с ним рабочую папку агента: агент падал с
  // «Working directory does not exist», правки терялись.
  // Теперь живость смотрится и по pid: статус врёт, процесс жив → живой.
  const port = freePort(7960);
  const data = join(tmpdir(), "dirigo-e2e", `cli-e2e-${port}`); // путь набора: песочница наборов
  const copy = join(data, "work", "ses_lie");
  if (existsSync(data)) rmDir(data);
  mkdirSync(copy, { recursive: true });
  writeFileSync(join(copy, "agent-file.txt"), "правка живого агента\n", "utf8");
  // Статус — «done» (врёт), pid — живой (этот тест).
  writeFileSync(join(data, "db.json"), JSON.stringify({
    projects: [{ id: "prj_lie", name: "lie", path: ROOT, createdAt: Date.now() }],
    sessions: [{ id: "ses_lie", projectId: "prj_lie", agentId: "opencode", title: "lie", prompt: "p", mode: "cli", status: "done", pid: process.pid, createdAt: Date.now(), updatedAt: Date.now(), exitCode: null }],
    messages: [],
    companion: { settings: { role: "assistant", tone: "neutral", model: "" }, messages: [] },
  }, null, 2), "utf8");
  writeFileSync(join(data, "work", "registry.json"), JSON.stringify([
    { sessionId: "ses_lie", kind: "copy", path: copy, projectPath: ROOT, createdAt: Date.now() },
  ], null, 2), "utf8");

  const r = await runSuite(port);
  check("набор прошёл (статус врёт, процесс жив)", r.code === 0, `код ${r.code}`);
  check("набор взял другой каталог данных", /каталог данных свой/.test(r.out), r.out.split("\n").find((l) => l.includes("каталог данных"))?.slice(0, 120) ?? "-");
  check("рабочая папка агента уцелела (статус врёт, pid жив)", existsSync(join(copy, "agent-file.txt")), copy);
  let kept = false;
  try { kept = JSON.parse(await Bun.file(join(data, "db.json")).text()).sessions?.some((s: any) => s.id === "ses_lie") === true; } catch { /* нет файла */ }
  check("сессия с врущим статусом уцелела", kept, data);
  rmDir(data);
}

/* ── сценарий 8: проект набора — черновик, репозиторий разработчика цел ──── */
{
  // «apply» переносит правки агента в проект, «revert» откатывает проект
  // целиком (в git-режиме — `git checkout` + `git clean` по всему дереву).
  // Если бы проектом набора был репозиторий разработчика, набор сносил бы там
  // чужие правки: незакоммиченные изменения и untracked-файлы. Поэтому набор
  // работает с черновиком проекта в песочнице — а репозиторий не трогает.
  const port = freePort(7980);
  // Канарейка: untracked-файл в репозитории. `git clean -fd` в репозитории
  // его бы удалил — то есть тест поймал бы набор, работающий с репозиторием.
  const canary = join(ROOT, `.e2e-canary-${process.pid}.txt`);
  writeFileSync(canary, "канарейка\n", "utf8");
  const licenseBefore = await Bun.file(join(ROOT, "LICENSE")).text();

  const r = await runSuite(port);
  check("набор прошёл (черновик проекта)", r.code === 0, `код ${r.code}`);
  const live = r.out.split("\n").find((l) => l.startsWith("LIVE ")) ?? "";
  const m = live.match(/данные=(.+?)\s+сессия=(\S+)/);
  if (m) {
    const [, ldata] = m;
    let projects: any[] = [];
    try { projects = JSON.parse(await Bun.file(join(ldata, "db.json")).text()).projects ?? []; } catch { /* нет базы */ }
    const p = projects[0];
    const inSandbox = !!p?.path && isInside(p.path, sandboxRoot());
    const notRepo = !!p?.path && !isInside(p.path, ROOT) && p.path !== ROOT;
    check("проект набора — черновик в песочнице", inSandbox && notRepo, p?.path ?? "-");
    rmDir(ldata);
  } else {
    check("проект набора — черновик в песочнице", false, "нет строки LIVE");
  }
  check("канарейка в репозитории уцелела (репозиторий не чистили)", existsSync(canary), canary);
  const licenseAfter = await Bun.file(join(ROOT, "LICENSE")).text();
  check("отслеживаемый файл репозитория не тронут", licenseBefore === licenseAfter, "");
  try { rmSync(canary, { force: true }); } catch { /* занят */ }
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
