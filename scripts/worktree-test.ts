// Ручная проверка движка копий (V2-1.1): git-worktree + copy-fallback,
// diff/apply/revert/cleanup. Запуск: bun run scripts/worktree-test.ts
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  applyWorktree, cleanupStale, cleanupWorktree, createWorktree, diffWorktree,
  getWorktree, isGitProject, isWorktreeIntact, lineDiff, parseUnified, repairWorktree,
  restoreProject, revertWorktree,
} from "../src/worktrees";

const RUN = Date.now().toString(36).slice(-5);
const SID_GIT = `ses_wtgit01${RUN}`;
const SID_COPY = `ses_wtcp01${RUN}`;
const SID_STALE = `ses_wtstale${RUN}`;

// Каталог данных — СВОЙ, никогда чужой.
//
// Тест вызывает cleanupStale(-1) («всё устарело»): это снос ВСЕХ копий из
// реестра каталога данных. Если каталог взят из окружения (DIRIGO_DATA
// демона), под раздачу попадает чужая живая сессия — её рабочая папка исчезает
// у живого агента («Working directory does not exist», правки теряются).
// Наблюдалось вживую: прогон worktree-test внутри агентской сессии снёс
// рабочую папку агента, которого сам набор e2e-cli и запускал. Гейт запускает
// этот набор с окружением пользователя — значит каталог может оказаться
// каталогом живой сессии.
const DATA = process.env.DIRIGO_WT_DATA_DIR
  ? resolve(process.env.DIRIGO_WT_DATA_DIR)
  : join(tmpdir(), `dirigo-wt-test-${process.pid}`);
// Чужой каталог данных (унаследованный от демона) — запоминаем ДО подмены:
// его нельзя трогать, иначе у живого агента пропадёт рабочая папка.
const AMBIENT_DATA = process.env.DIRIGO_DATA ? resolve(process.env.DIRIGO_DATA) : "";
const AMBIENT_REG = AMBIENT_DATA ? join(AMBIENT_DATA, "work", "registry.json") : "";
const AMBIENT_REG_BEFORE = AMBIENT_REG && existsSync(AMBIENT_REG) ? readFileSync(AMBIENT_REG, "utf8") : "";
process.env.DIRIGO_DATA = DATA;
mkdirSync(DATA, { recursive: true });

// Каталог фикстур. По умолчанию общий, но гейт гоняет наборы параллельно:
// два прогона этого же теста делят папку и затирают фикстуры друг друга
// (git init пропадал из-под ног → «not a git repository»). Свой каталог —
// через DIRIGO_WT_TMP.
const TMP = process.env.DIRIGO_WT_TMP
  ? join(process.env.DIRIGO_WT_TMP, ".smoke-wt")
  : join(import.meta.dir, "..", ".smoke-wt");
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

const sh = (cmd: string[], cwd: string) => {
  const r = Bun.spawnSync(cmd, { cwd });
  if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")} → ${r.stderr.toString()}`);
  return r.stdout.toString();
};

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  ok ? pass++ : fail++;
};

/* ---------- git-проект ---------- */
const gitProj = join(TMP, "gitproj");
mkdirSync(gitProj, { recursive: true });
writeFileSync(join(gitProj, "app.py"), "def main():\n    print('hello')\n    return 0\n");
writeFileSync(join(gitProj, "README.md"), "# demo\n");
sh(["git", "init", "-q"], gitProj);
sh(["git", "config", "user.email", "t@t"], gitProj);
sh(["git", "config", "user.name", "t"], gitProj);
sh(["git", "add", "-A"], gitProj);
sh(["git", "commit", "-qm", "init"], gitProj);

check("isGitProject(git)", isGitProject(gitProj));

{
  const info = createWorktree(SID_GIT, gitProj, "git");
  check("git worktree создан", info.kind === "git" && !!info.baseRef);
  // правки в копии: изменить, добавить, удалить
  writeFileSync(join(info.path, "app.py"), "def main():\n    print('hello v2')\n    return 1\n");
  writeFileSync(join(info.path, "extra.txt"), "новый файл\n");
  rmSync(join(info.path, "README.md"), { force: true });

  const d = diffWorktree(SID_GIT);
  const app = d.files.find((f) => f.path === "app.py");
  const extra = d.files.find((f) => f.path === "extra.txt");
  const readme = d.files.find((f) => f.path === "README.md");
  check("diff: 3 файла", d.files.length === 3, d.files.map((f) => f.path).join(","));
  check("diff: app.py modified", !!app && app.status === "modified" && app.added === 2 && app.deleted === 2, `+${app?.added} -${app?.deleted}`);
  check("diff: extra.txt added", !!extra && extra.status === "added", extra?.status ?? "-");
  check("diff: README deleted", !!readme && readme.status === "deleted", readme?.status ?? "-");
  check("diff: строки с номерами", !!app?.lines.some((l) => l.kind === "add" && l.newNo !== null));

  // применить в проект
  const ap = applyWorktree(SID_GIT);
  check("apply: 2 применено, 1 удалено", ap.ok && ap.applied.length === 2 && ap.removed.length === 1, ap.detail);

  // вернуть проект как было
  const rp = restoreProject(SID_GIT);
  check("restore: проект возвращён", rp.ok, rp.detail);
  const d2 = diffWorktree(SID_GIT);
  check("restore: копия не тронута", d2.files.length === 3);

  // откат копии к базе
  const rv = revertWorktree(SID_GIT);
  check("revert: копия сброшена", rv.ok, rv.detail);
  const d3 = diffWorktree(SID_GIT);
  check("revert: diff пуст", d3.files.length === 0 && d3.added === 0, `files=${d3.files.length}`);

  // cleanup
  const cl = cleanupWorktree(SID_GIT);
  check("cleanup: копия удалена", cl.ok && !getWorktree(SID_GIT), cl.detail);
}

/* ---------- copy-проект (без git) ---------- */
const plainProj = join(TMP, "plain");
mkdirSync(plainProj, { recursive: true });
mkdirSync(join(plainProj, "src"), { recursive: true });
writeFileSync(join(plainProj, "src", "main.js"), "console.log(1)\nconsole.log(2)\n");
writeFileSync(join(plainProj, "index.html"), "<h1>hi</h1>\n");

check("isGitProject(plain)=false", !isGitProject(plainProj));

{
  const info = createWorktree(SID_COPY, plainProj, "copy");
  check("copy: копия создана", info.kind === "copy");
  writeFileSync(join(info.path, "src", "main.js"), "console.log(1)\nconsole.log(3)\nconsole.log(4)\n");
  writeFileSync(join(info.path, "src", "new.js"), "export const x = 1\n");

  const d = diffWorktree(SID_COPY);
  const main = d.files.find((f) => f.path === "src/main.js");
  const added = d.files.find((f) => f.path === "src/new.js");
  check("copy diff: main.js", !!main && main.added === 2 && main.deleted === 1, `+${main?.added} -${main?.deleted}`);
  check("copy diff: new.js added", !!added && added.status === "added", added?.status ?? "-");

  const ap = applyWorktree(SID_COPY);
  check("copy apply", ap.ok && ap.applied.length === 2, ap.detail);

  const rv = revertWorktree(SID_COPY);
  check("copy revert", rv.ok, rv.detail);
  const d2 = diffWorktree(SID_COPY);
  check("copy revert: дифф пуст", d2.files.length === 0, `files=${d2.files.length}`);

  cleanupWorktree(SID_COPY);
}

/* ---------- регресс: копия, снесённая наполовину ----------
   `git worktree remove --force` выносит содержимое, но каталог, который держит
   процесс агента, снести не может. Остаётся пустая папка: для агента это
   «пустой проект», для git — «не git-репозиторий». Повторный запуск сессии
   обязан починить копию, иначе агент стартует в пустоте. */
{
  const SID_BROKEN = `ses_wtbroken${RUN}`;
  const info = createWorktree(SID_BROKEN, gitProj, "git");
  check("регресс: копия цела", isWorktreeIntact(info));
  // сносим содержимое копии, каталог оставляем — как это делает git при занятом CWD
  for (const f of readdirSync(info.path)) rmSync(join(info.path, f), { recursive: true, force: true });
  check("регресс: половинчатая копия не цела", !isWorktreeIntact(info));
  const rep = repairWorktree(SID_BROKEN);
  check("регресс: копия пересоздана", rep.ok, rep.detail);
  check("регресс: проект вернулся", existsSync(join(info.path, "app.py")), info.path);
  check("регресс: копия снова цела", isWorktreeIntact(info));
  const d3 = diffWorktree(SID_BROKEN);
  check("регресс: дифф пустой (правок не потеряно зря)", d3.files.length === 0, `files=${d3.files.length}`);
  cleanupWorktree(SID_BROKEN);
}

/* ---------- lineDiff / parseUnified юниты ---------- */
{
  const lines = lineDiff("a\nb\nc\n", "a\nx\nc\n");
  const adds = lines.filter((l) => l.kind === "add");
  const dels = lines.filter((l) => l.kind === "del");
  check("lineDiff: +1/-1", adds.length === 1 && dels.length === 1 && adds[0]!.text === "x");

  const uni = [
    "diff --git a/f.txt b/f.txt",
    "index 111..222 100644",
    "--- a/f.txt",
    "+++ b/f.txt",
    "@@ -1,2 +1,2 @@",
    " one",
    "-two",
    "+TWO",
    "+three",
  ].join("\n");
  const files = parseUnified(uni);
  check("parseUnified: файл + строки", files.length === 1 && files[0]!.added === 2 && files[0]!.deleted === 1,
    `+${files[0]?.added} -${files[0]?.deleted}`);
}

/* ---------- TTL-чистка ---------- */
{
  const staleProj = join(TMP, "stale-proj");
  mkdirSync(staleProj, { recursive: true });
  writeFileSync(join(staleProj, "a.txt"), "a\n");
  createWorktree(SID_STALE, staleProj, "copy");
  const removed = cleanupStale(-1); // всё устарело
  check("cleanupStale: удаляет все", removed.length >= 1 && !getWorktree(SID_STALE), `removed=${removed.length}`);
}

/* ---------- 0.1.0: файл с именем устройства Windows (nul) не ломает копию ---------- */
if (process.platform === "win32") {
  const resProj = join(TMP, "reserved-proj");
  mkdirSync(resProj, { recursive: true });
  writeFileSync(join(resProj, "nullable.ts"), "x\n");
  // Bun не создаёт такой файл (пишет в устройство NUL) — создаём как Git Bash/PowerShell
  const lit = ("\\\\?\\" + join(resProj, "nul")).replace(/'/g, "''");
  Bun.spawnSync(["powershell", "-NoProfile", "-NonInteractive", "-Command", `Set-Content -LiteralPath '${lit}' -Value 'x'`], { windowsHide: true });
  let ok = false, detail = "";
  try {
    const sid = `wt-reserved-${Date.now()}`;
    const info = createWorktree(sid, resProj, "copy");
    ok = existsSync(join(info.path, "nullable.ts"));
    detail = info.path;
    cleanupWorktree(sid);
  } catch (e) { detail = String(e).slice(0, 120); }
  check("копия проекта с файлом nul создаётся (nul пропущен, nullable.ts скопирован)", ok, detail);
  Bun.spawnSync(["powershell", "-NoProfile", "-NonInteractive", "-Command", `Remove-Item -LiteralPath '${lit}' -Force`], { windowsHide: true });
}

/* ---------- живой агент в копии: уборка не должна сносить его правки ----------
   Реальный случай: сессию удалили, а агент в копии ещё работает. На Windows
   `git worktree remove --force` и `rm -r` сносят ФАЙЛЫ внутри и падают на
   самой папке (EBUSY) — агент теряет всё («Working directory does not exist»).
   Значит, папку, которую держит процесс, трогать нельзя. */
for (const kind of ["copy", "git"] as const) {
  const sid = `ses_wtbusy${kind}${RUN}`;
  const proj = kind === "git" ? gitProj : join(TMP, `busy-${kind}`);
  if (kind === "copy") {
    mkdirSync(proj, { recursive: true });
    writeFileSync(join(proj, "app.py"), "print(1)\n");
  }
  const info = createWorktree(sid, proj, kind);
  writeFileSync(join(info.path, "agent-file.txt"), "правка живого агента\n");
  // «агент» работает в своей копии: его рабочий каталог — копия
  const child = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 30000)"], {
    cwd: info.path, stdout: "ignore", stderr: "ignore",
  });
  await new Promise((r) => setTimeout(r, 800));
  const busy = cleanupWorktree(sid);
  check(
    `${kind}: уборка не сносит правки живого агента`,
    !busy.ok && existsSync(join(info.path, "agent-file.txt")),
    busy.detail,
  );
  check(`${kind}: запись копии осталась в реестре (добьёт TTL)`, !!getWorktree(sid), "");
  child.kill();
  await child.exited;
  await new Promise((r) => setTimeout(r, 500)); // Windows отпускает папку не мгновенно
  const free = cleanupWorktree(sid);
  check(`${kind}: после смерти агента копия удалена`, free.ok && !existsSync(info.path), free.detail);
}
if (existsSync(gitProj)) {
  const wl = sh(["git", "worktree", "list"], gitProj);
  check("git: в реестре worktree не осталось записей", !wl.includes("wtbusygit"), wl.trim().split("\n").length + " записей");
}

/* ---------- изоляция: чужой каталог данных не тронут ---------- */
/* Регресс (наблюдалось вживую): прогон этого теста внутри агентской сессии
   наследовал DIRIGO_DATA демона, и cleanupStale(-1) сносил ВСЕ копии оттуда —
   в том числе рабочую папку живого агента («Working directory does not
   exist», правки терялись). Тест обязан работать в СВОЁМ каталоге. */
{
  check("каталог данных теста — свой (чужой не подменён)",
    !AMBIENT_DATA || resolve(DATA) !== resolve(AMBIENT_DATA), AMBIENT_DATA || "DIRIGO_DATA не задан");
  if (AMBIENT_REG) {
    const now = existsSync(AMBIENT_REG) ? readFileSync(AMBIENT_REG, "utf8") : "";
    check("чужой реестр копий не тронут", now === AMBIENT_REG_BEFORE,
      AMBIENT_REG_BEFORE === "" ? "реестра не было — не появился" : `было ${AMBIENT_REG_BEFORE.length} байт, стало ${now.length}`);
  }
}
rmSync(TMP, { recursive: true, force: true });
try { rmSync(DATA, { recursive: true, force: true }); } catch { /* папку держит процесс — добьёт следующая чистка */ }
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
