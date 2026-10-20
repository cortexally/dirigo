#!/usr/bin/env bun
// Регресс-тест изоляции набора e2e-cli: набор НЕ должен трогать чужое
// состояние — живая сессия демона, её рабочую папку и каталог данных.
//
// Сценарий 1. В каталоге данных, который набор забрал бы себе (тот же путь
//   при том же порту), живёт сессия в статусе running и копия проекта. Набор
//   обязан взять другой каталог и не тронуть её файлы.
//   (До правки набор сносил этот каталог: агент оставался работать, а его
//   рабочая папка исчезала — «Working directory does not exist».)
// Сценарий 2. На запрошенном порту уже отвечает живой демон: набор берёт
//   свободный порт рядом и не создаёт в чужом демоне ни проектов, ни сессий.
// Сценарий 3. Сессия самого набора жива (web-режим, без процесса агента):
//   набор не удаляет сессию, её копию и каталог данных.
// Сценарий 4. Рабочая папка агента БЕЗ метаданных демона (нет ни db.json, ни
//   реестра): набор всё равно не должен её сносить — демон мог не успеть
//   записать метаданные, а папка агента уже есть.
// Сценарий 5. Состояние сессии — три исхода, а не два: живая, мёртвая и
//   «не узнали». «Не узнали» (демон не ответил, сессия не найдена) — это не
//   «мёртвый агент»: тогда набор ничего не сносит, иначе у живого агента
//   пропадёт рабочая папка.
// Сценарий 6. Сами правила изоляции (unit-уровень): если правила перестанут
//   видеть рабочую папку агента, защита выключится молча.
// Сценарий 7. Статус сессии врёт («done»), а процесс агента жив: набор не
//   сносит каталог данных — иначе у живого агента пропадает рабочая папка.
// Сценарий 8. Проект набора — черновик в песочнице, а не репозиторий
//   разработчика: «apply»/«revert» не должны трогать чужое рабочее дерево.
//
// Параллельные прогоны: пул гоняет наборы одновременно, поэтому порт
// «закрепляется» claim-файлом (с живым pid) — два прогона не берут один
// порт и не делят каталоги. Диапазон портов на сценарий — свой: иначе
// сценарии мешают друг другу (порт занят чужим демоном — истина с другой
// стороны) и прогон получается нестабильным.
//
// Запуск: bun run scripts/cli-e2e-isolation-test.ts
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canRemoveDataDir, cleanupPlan, dataDirFor, isInside, liveSessionsIn, ownDaemon, recentActivity, removeTreeSafely, sandboxRoot, sessionState, workCopiesIn } from "./e2e-guard";

const ROOT = join(import.meta.dir, "..");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); ok ? pass++ : fail++; };

/** Жив ли процесс? */
function pidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Занят ли порт другим прогоном этого теста? (claim-файл с живым pid) */
function claimedByOther(port: number): boolean {
  try {
    const raw = JSON.parse(readFileSync(join(tmpdir(), "dirigo-e2e", `claim-${port}`), "utf8"));
    return typeof raw?.pid === "number" && raw.pid !== process.pid && pidAlive(raw.pid);
  } catch { return false; }
}

/** Закрепить порт за этим прогоном. Эксклюзивно: файл claim создаётся с
 *  флагом «wx» — если он уже есть, порт держит другой прогон (две параллельные
 *  копии теста не должны брать один порт и делить каталоги). */
function claim(port: number): boolean {
  const dir = join(tmpdir(), "dirigo-e2e");
  const file = join(dir, `claim-${port}`);
  try { mkdirSync(dir, { recursive: true }); } catch { /* уже есть */ }
  const mine = JSON.stringify({ pid: process.pid, port });
  try {
    writeFileSync(file, mine, { encoding: "utf8", flag: "wx" });
    return true;
  } catch {
    // файл есть: если владелец мёртв — забираем порт себе, иначе он чужой
    try {
      const raw = JSON.parse(readFileSync(file, "utf8"));
      if (typeof raw?.pid === "number" && raw.pid !== process.pid && pidAlive(raw.pid)) return false;
    } catch { /* битый claim — забираем */ }
    try { writeFileSync(file, mine, "utf8"); return true; } catch { return false; }
  }
}

/** В корне tmp есть песощница агента с таким портом? (её не трогаем) */
function agentSandboxAt(port: number): boolean {
  try {
    for (const name of readdirSync(tmpdir())) {
      if (name.startsWith("dirigo-") && name.endsWith(`-${port}`)) return true;
    }
  } catch { /* нет доступа */ }
  // Каталог данных набора с этим портом: если в нём что-то живое (сессия,
  // копия агента, метка набора) — порт не наш, его не берём. Песочница агента
  // лежит на уровень глубже корня tmp («<tmp>/dirigo-e2e/cli-e2e-<порт>»), и
  // раньше проверка смотрела только корень tmp — набор с портом 7971 сносил
  // песочницу агента на 7971: у агента исчезала рабочая папка и правки.
  const dir = dataDirFor(port);
  if (existsSync(dir) && !canRemoveDataDir(dir).ok) return true;
  return false;
}

/** Свободный порт (демон набора не должен занять чужой). Свой диапазон на сценарий:
 *  иначе сценарии мешают друг другу (порт занят чужим демоном — истина с
 *  другой стороны) и прогон получается нестабильным. */
function freePort(base: number): number {
  for (let p = base; p < base + 40; p++) {
    if (claimedByOther(p)) continue; // порт уже занят другим прогоном
    if (agentSandboxAt(p)) continue; // песочница агента — не трогаем
    try {
      const s = Bun.listen({ hostname: "127.0.0.1", port: p, socket: { data() {}, open() {}, close() {}, error() {} } });
      s.stop(true);
      if (!claim(p)) continue; // порт забрал другой прогон — берём следующий
      return p;
    } catch { /* занят */ }
  }
  return base;
}

/**
 * Каталоги, которые создал сам тест: их убираем без оглядки на чужие.
 * Всё остальное — не наше: там может жить чужой агент.
 */
const ownDirs = new Set<string>();

/** Снять фальшивое «живое» состояние каталога, который создал тест. */
function dropFakeState(dir: string): void {
  for (const f of ["db.json", join("work", "registry.json")]) {
    try { rmSync(join(dir, f), { force: true }); } catch { /* нет файла */ }
  }
}

/**
 * Снести каталог — так, чтобы не задел чужую рабочую папку.
 *
 * Обычный `rm -r` по Windows сносит ФАЙЛЫ внутри папки, которую держит процесс,
 * и падает на самой папке: агент теряет рабочую папку и правки («Working
 * directory does not exist»). Именно так набор-тест сносил песочницу живого
 * агента: каталог оставался, а файлы в нём исчезали. Поэтому:
 *   • чужой каталог с живым состоянием — не трогаем вовсе;
 *   • свой — сносим переименованием «в сторону»: не переименовалось (папку
 *     держит процесс) — не трогаем ничего.
 */
function rmDir(dir: string): void {
  if (!existsSync(dir)) return;
  if (ownDirs.has(dir)) {
    dropFakeState(dir);
  } else {
    const verdict = canRemoveDataDir(dir);
    if (!verdict.ok) {
      console.log(`каталог не тронут (${verdict.reason}): ${dir}`);
      return;
    }
  }
  const r = removeTreeSafely(dir);
  if (!r.ok) console.log(`каталог оставлен (${r.detail}): ${dir}`);
}

/** Прогон набора e2e-cli как отдельного процесса. */
async function runSuite(port: number, extraEnv: Record<string, string> = {}): Promise<{ code: number; out: string }> {
  const env = { ...process.env, E2E_CLI_PORT: String(port), E2E_CLI_SKIP_AGENT: "1", ...extraEnv } as Record<string, string>;
  delete env.DIRIGO_DATA; // каталог набора — его собственный, не задан извне
  const p = Bun.spawn([process.execPath, "run", "scripts/cli-e2e.ts"], { cwd: ROOT, env, stdout: "pipe", stderr: "pipe" });
  const out = (await new Response(p.stdout).text()) + (await new Response(p.stderr).text());
  const code = await p.exited;
  return { code, out: out.trim() };
}

/**
 * Диагностика провала набора: какие ИМЕННО проверки набора не прошли.
 *
 * Раньше тест писал только «код 1» — и по этому ничего не понять: код
 * выхода набора может быть любым из тридцати с лишним проверок. Теперь видно
 * строку «N/M passed» и все «FAIL» набора.
 */
function suiteDetail(r: { code: number; out: string }): string {
  const lines = r.out.split("\n");
  const fails = lines.filter((l) => l.startsWith("FAIL"));
  const summary = lines.find((l) => /^\d+\/\d+ passed$/.test(l.trim())) ?? "";
  return [`код ${r.code}`, summary, ...fails].filter(Boolean).join(" · ").slice(0, 400);
}

/* ── сценарий 1: живая сессия в «своём» каталоге набора ─────────────────── */
{
  const port = freePort(7800);
  // Ровно тот путь, что набор берёт себе: песочница наборов. В корне tmp имя
  // «dirigo-<метка>-<порт>» занимают рабочие песочницы агентов — такой каталог
  // тест не трогает никогда (иначе сносил бы чужую рабочую папку).
  const data = join(tmpdir(), "dirigo-e2e", `cli-e2e-${port}`);
  const copy = join(data, "work", "ses_live");
  if (existsSync(data)) rmDir(data); // каталог набора — его песочница, не песочница агента
  ownDirs.add(data);
  mkdirSync(copy, { recursive: true });
  writeFileSync(join(copy, "agent-file.txt"), "правка живого агента\n", "utf8");
  writeFileSync(join(data, "db.json"), JSON.stringify({
    projects: [{ id: "prj_live", name: "live", path: ROOT, createdAt: Date.now() }],
    sessions: [{ id: "ses_live", projectId: "prj_live", agentId: "opencode", title: "live", prompt: "p", mode: "cli", status: "running", createdAt: Date.now(), updatedAt: Date.now(), exitCode: null }],
    messages: [],
    companion: { settings: { role: "assistant", tone: "neutral", model: "" }, messages: [] },
  }, null, 2), "utf8");
  writeFileSync(join(data, "work", "registry.json"), JSON.stringify([
    { sessionId: "ses_live", kind: "copy", path: copy, projectPath: ROOT, createdAt: Date.now() },
  ], null, 2), "utf8");

  const r = await runSuite(port);
  check("набор прошёл (без агента)", r.code === 0, suiteDetail(r));
  check("набор взял другой каталог данных", /каталог данных свой/.test(r.out), r.out.split("\n").find((l) => l.includes("каталог данных"))?.slice(0, 120) ?? "-");
  check("рабочая папка живой сессии уцелела", existsSync(join(copy, "agent-file.txt")), copy);
  let liveKept = false;
  try { liveKept = JSON.parse(await Bun.file(join(data, "db.json")).text()).sessions?.some((s: any) => s.id === "ses_live" && s.status === "running") === true; } catch { /* нет файла */ }
  check("живая сессия в каталоге демона уцелела", liveKept, data);
  let regKept = false;
  try { regKept = JSON.parse(await Bun.file(join(data, "work", "registry.json")).text()).length === 1; } catch { /* нет файла */ }
  check("реестр копий не тронут", regKept, "");
  rmDir(data);
}

/* ── сценарий 2: порт занят живым демоном ───────────────────────────────── */
{
  const port = freePort(7840);
  const data = join(tmpdir(), `dirigo-isolation-live-${port}-${process.pid}`);
  const copy = join(data, "work", "ses_outer");
  ownDirs.add(data);
  rmDir(data);
  mkdirSync(copy, { recursive: true });
  writeFileSync(join(copy, "outer.txt"), "рабочий файл чужого демона\n", "utf8");
  writeFileSync(join(data, "db.json"), JSON.stringify({
    projects: [{ id: "prj_outer", name: "outer", path: ROOT, createdAt: Date.now() }],
    sessions: [], messages: [], companion: { settings: { role: "assistant", tone: "neutral", model: "" }, messages: [] },
  }, null, 2), "utf8");

  // живой демон на занятом порту
  const daemon = Bun.spawn([process.execPath, "run", "src/server.ts"], {
    cwd: ROOT, env: { ...process.env, PORT: String(port), DIRIGO_DATA: data } as Record<string, string>,
    stdout: "ignore", stderr: "ignore",
  });
  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 40; i++) { try { if ((await fetch(`${base}/api/health`)).ok) { up = true; break; } } catch { /* ещё поднимается */ } await sleep(250); }
  check("живой демон поднялся на занятом порту", up, `порт ${port}`);

  const r = await runSuite(port);
  check("набор прошёл (порт занят)", r.code === 0, suiteDetail(r));
  const portLine = r.out.split("\n").find((l) => l.includes("демон набора — свой")) ?? "";
  check("набор не говорил с чужим демоном", /демон набора — свой/.test(portLine) && !portLine.includes(`порт ${port}`), portLine.slice(0, 120));
  const stillUp = await fetch(`${base}/api/health`).then((x) => x.ok).catch(() => false);
  check("чужой демон жив и не тронут", stillUp, `порт ${port}`);
  const sessions = await fetch(`${base}/api/sessions`).then((x) => x.json() as any[]).catch(() => [] as any[]);
  const projects = await fetch(`${base}/api/projects`).then((x) => x.json() as any[]).catch(() => [] as any[]);
  check("в чужом демоне не появилось сессий набора", (sessions ?? []).length === 0, `сессий ${(sessions ?? []).length}`);
  check("в чужом демоне не появилось проектов набора", (projects ?? []).length === 1, `проектов ${(projects ?? []).length}`);
  check("рабочая папка чужой копии уцелела", existsSync(join(copy, "outer.txt")), copy);

  daemon.kill();
  await sleep(300);
  rmDir(data);
}

/* ── сценарий 3: своя живая сессия — данные и копия остаются ────────────── */
{
  const port = freePort(7880);
  const r = await runSuite(port); // E2E_CLI_SKIP_AGENT=1 → сессия без процесса агента
  const live = r.out.split("\n").find((l) => l.startsWith("LIVE ")) ?? "";
  check("набор оставил живую сессию (не убрал за собой)", !!live, live.slice(0, 140) || r.out.split("\n").slice(-3).join(" | "));
  const m = live.match(/данные=(.+?)\s+сессия=(\S+)/);
  if (m) {
    const [, ldata, lsid] = m;
    check("каталог данных живой сессии остался", existsSync(ldata), ldata);
    check("копия проекта живой сессии осталась", existsSync(join(ldata, "work", lsid)), join(ldata, "work", lsid));
    let sesKept = false;
    try { sesKept = JSON.parse(await Bun.file(join(ldata, "db.json")).text()).sessions?.some((s: any) => s.id === lsid) === true; } catch { /* нет файла */ }
    check("сессия набора не удалена из базы", sesKept, lsid);
    ownDirs.add(ldata); // каталог создал набор этого прогона — тест убирает свой мусор
    rmDir(ldata);
  } else {
    check("детали живой сессии получены", false, "нет строки LIVE");
  }
}

/* ── сценарий 4: рабочая папка агента без метаданных демона ────────────── */
{
  const port = freePort(7920);
  const data = join(tmpdir(), "dirigo-e2e", `cli-e2e-${port}`); // путь набора: песочница наборов
  const copy = join(data, "work", "ses_orphan");
  if (existsSync(data)) rmDir(data);
  ownDirs.add(data);
  mkdirSync(copy, { recursive: true });
  writeFileSync(join(copy, "agent-file.txt"), "правка агента\n", "utf8");
  // Ни db.json, ни work/registry.json: демон не успел (или потерял) метаданные,
  // а рабочая папка агента уже есть. Единственный признак — сама папка.

  const r = await runSuite(port);
  check("набор прошёл (каталог без метаданных)", r.code === 0, suiteDetail(r));
  check("набор взял другой каталог данных", /каталог данных свой/.test(r.out), r.out.split("\n").find((l) => l.includes("каталог данных"))?.slice(0, 120) ?? "-");
  check("рабочая папка агента уцелела (без реестра)", existsSync(join(copy, "agent-file.txt")), copy);
  rmDir(data);
}

/* ── сценарий 5: состояние сессии — три исхода, а не два ─────────────────── */
{
  // Статус врёт, процесс жив → сессия живая (набор не сносит её копию).
  check("статус не running, но процесс жив — сессия живая", sessionState({ status: "done", pid: process.pid }) === "live", `pid ${process.pid}`);
  check("очевидно мёртвая сессия — dead", sessionState({ status: "done", pid: 999999 }) === "dead", "");
  // Состояние не узнали (демон не ответил, сессия не найдена) — это НЕ
  // «мёртвый агент»: тогда набор ничего не сносит.
  check("неизвестное состояние — unknown", sessionState(null) === "unknown", "");

  // Статус «running», а процесса нет: демон умер, не обновив статус. Такая
  // сессия не живая — иначе её каталог никогда не уберётся (песочница растёт).
  const stale = mkdtempSync(join(tmpdir(), "dirigo-stale-session-"));
  writeFileSync(join(stale, "db.json"), JSON.stringify({
    projects: [],
    sessions: [
      // Демон умер давно: сессия осталась «running», pid мёртв, и следов жизни
      // (правок, журнала) нет — такой каталог убирать можно.
      { id: "ses_stale", status: "running", pid: 999999, updatedAt: Date.now() - 60 * 60_000 },
      { id: "ses_queued", status: "queued" },
    ],
    messages: [],
  }), "utf8");
  const live = liveSessionsIn(stale);
  check("статус running, но pid мёртв — не живая (каталог можно убрать)",
    live.length === 1 && live[0]?.id === "ses_queued", live.map((x: any) => x?.id).join(",") || "-");
  rmSync(stale, { recursive: true, force: true });
}

/* ── сценарий 6: сами правила изоляции (а не только набор) ───────────────── */
{
  // Правила — в scripts/e2e-guard.ts, набор берёт их оттуда. Если правила
  // перестанут видеть рабочие папки агента, защита выключится МОЛЧА: набор
  // решит, что каталог пуст, и снесёт чужую рабочую папку. Проверяем сами
  // правила — unit-уровень, без набора.
  const dir = join(tmpdir(), "dirigo-e2e", `guard-unit-${process.pid}`);
  const copy = join(dir, "work", "ses_unit");
  ownDirs.add(dir);
  rmDir(dir);
  mkdirSync(copy, { recursive: true });
  writeFileSync(join(copy, "agent-file.txt"), "правка агента\n", "utf8");
  check("правила видят рабочую папку агента (без реестра)", workCopiesIn(dir).includes("ses_unit"), dir);
  const verdict = canRemoveDataDir(dir);
  check("каталог с рабочей папкой сносить нельзя", !verdict.ok, verdict.reason);

  const empty = join(tmpdir(), "dirigo-e2e", `guard-empty-${process.pid}`);
  ownDirs.add(empty);
  rmDir(empty);
  mkdirSync(empty, { recursive: true });
  const emptyVerdict = canRemoveDataDir(empty);
  check("пустой каталог сносить можно", emptyVerdict.ok, emptyVerdict.reason);
  rmDir(empty);

  // Каталог вне песочницы наборов — не наш: сносить его нельзя никогда.
  const outside = join(tmpdir(), `dirigo-guard-outside-${process.pid}`);
  ownDirs.add(outside);
  rmDir(outside);
  mkdirSync(outside, { recursive: true });
  const outsideVerdict = canRemoveDataDir(outside);
  check("каталог вне песочницы сносить нельзя", !outsideVerdict.ok, outsideVerdict.reason);
  rmDir(outside);

  // Копия УМЕРШЕЙ сессии (pid известен и мёртв) — ничья: каталог можно убрать.
  // Иначе песочница наборов растёт вечно: папка копии остаётся после смерти
  // агента, а правило «рабочие папки агентов» держит каталог из-за неё
  // (F_VER-2: 563 каталога в песочнице, 402 «живые» только из-за таких).
  const staleCopyDir = join(tmpdir(), "dirigo-e2e", `guard-stale-${process.pid}`);
  ownDirs.add(staleCopyDir);
  rmDir(staleCopyDir);
  const staleCopy = join(staleCopyDir, "work", "ses_dead");
  mkdirSync(staleCopy, { recursive: true });
  writeFileSync(join(staleCopy, "agent-file.txt"), "правка умершего агента\n", "utf8");
  // Копия давно брошенная: агент умер не вчера (свежая копия — другая
  // проверка, ниже: там pid тоже мёртв, но агент ещё работает).
  const longAgo = new Date(Date.now() - 60 * 60_000);
  utimesSync(staleCopy, longAgo, longAgo);
  utimesSync(join(staleCopy, "agent-file.txt"), longAgo, longAgo);
  writeFileSync(join(staleCopyDir, "db.json"), JSON.stringify({
    projects: [],
    sessions: [{ id: "ses_dead", status: "running", pid: 999999, worktree: { kind: "copy", path: staleCopy, createdAt: Date.now() } }],
    messages: [],
  }), "utf8");
  const staleVerdict = canRemoveDataDir(staleCopyDir);
  check("каталог с копией умершей сессии сносить можно", staleVerdict.ok, staleVerdict.reason);
  check("старая активность не выдаёт себя за свежую",
    !recentActivity({ id: "ses_dead", status: "running", pid: 999999, worktree: { path: staleCopy } }, staleCopyDir), "");
  rmDir(staleCopyDir);

  // F_VER-4: pid мёртв, а агент ещё работает. opencode отдаёт ход своему
  // сервису (`opencode-cli.exe run` — клиент, а работа идёт в сервисе): pid
  // клиента умер, а сессия жива. Правило «pid известен — верим процессу»
  // (F_VER-2) считало такую сессию мёртвой → уборка сносила каталог данных, а
  // с ним рабочую папку агента: агент падал с «Working directory does not
  // exist», правки терялись. След жизни — свежая активность (правки в копии,
  // журнал сессии).
  const freshDir = join(tmpdir(), "dirigo-e2e", `guard-fresh-${process.pid}`);
  ownDirs.add(freshDir);
  rmDir(freshDir);
  const freshCopy = join(freshDir, "work", "ses_fresh");
  mkdirSync(freshCopy, { recursive: true });
  writeFileSync(join(freshCopy, "agent-file.txt"), "правка живого агента\n", "utf8");
  writeFileSync(join(freshDir, "db.json"), JSON.stringify({
    projects: [],
    sessions: [{ id: "ses_fresh", status: "running", pid: 999999, worktree: { kind: "copy", path: freshCopy, createdAt: Date.now() } }],
    messages: [],
  }), "utf8");
  const freshVerdict = canRemoveDataDir(freshDir);
  check("каталог с живой по активности сессией сносить нельзя (pid мёртв)", !freshVerdict.ok, freshVerdict.reason);
  check("свежая активность видна (правки в копии)",
    recentActivity({ id: "ses_fresh", status: "running", pid: 999999, worktree: { path: freshCopy } }, freshDir), "");
  rmDir(freshDir);

  // А живая сессия (даже со врущим статусом) — папку держим.
  const aliveDir = join(tmpdir(), "dirigo-e2e", `guard-alive-${process.pid}`);
  ownDirs.add(aliveDir);
  rmDir(aliveDir);
  const aliveCopy = join(aliveDir, "work", "ses_alive");
  mkdirSync(aliveCopy, { recursive: true });
  writeFileSync(join(aliveCopy, "agent-file.txt"), "правка живого агента\n", "utf8");
  writeFileSync(join(aliveDir, "db.json"), JSON.stringify({
    projects: [],
    sessions: [{ id: "ses_alive", status: "done", pid: process.pid, worktree: { kind: "copy", path: aliveCopy, createdAt: Date.now() } }],
    messages: [],
  }), "utf8");
  const aliveVerdict = canRemoveDataDir(aliveDir);
  check("каталог с копией живой сессии сносить нельзя", !aliveVerdict.ok, aliveVerdict.reason);
  rmDir(aliveDir);
  rmDir(dir);
}

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
  ownDirs.add(data);
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
  check("набор прошёл (статус врёт, процесс жив)", r.code === 0, suiteDetail(r));
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
  check("набор прошёл (черновик проекта)", r.code === 0, suiteDetail(r));
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
    ownDirs.add(ldata); // каталог создал набор этого прогона — тест убирает свой мусор
    rmDir(ldata);
  } else {
    check("проект набора — черновик в песочнице", false, "нет строки LIVE");
  }
  check("канарейка в репозитории уцелела (репозиторий не чистили)", existsSync(canary), canary);
  const licenseAfter = await Bun.file(join(ROOT, "LICENSE")).text();
  check("отслеживаемый файл репозитория не тронут", licenseBefore === licenseAfter, "");
  try { rmSync(canary, { force: true }); } catch { /* занят */ }
}

/* ── сценарий 9: песочница живого агента внутри песочницы наборов ────────── */
{
  // Реальный случай, из-за которого агент потерял рабочую папку: песочница
  // агента лежит В ПЕСОЧНИЦЕ НАБОРОВ («<tmp>/dirigo-e2e/cli-e2e-<порт>»), а
  // проверка «песочница агента» смотрела только корень tmp. Набор-тест выбрал
  // этот порт и снёс каталог обычным rm -r: каталог остался, а ФАЙЛЫ внутри
  // исчезли — у живого агента пропала рабочая папка и правки.
  // Порот — за пределами диапазонов остальных сценариев, чтобы не мешать им.
  const port = 8020;
  const data = dataDirFor(port);
  const copy = join(data, "work", "ses_agent");
  mkdirSync(copy, { recursive: true });
  writeFileSync(join(copy, "agent-file.txt"), "правка живого агента\n", "utf8");
  writeFileSync(join(data, "db.json"), JSON.stringify({
    projects: [{ id: "prj_agent", name: "agent", path: ROOT, createdAt: Date.now() }],
    sessions: [{ id: "ses_agent", projectId: "prj_agent", agentId: "opencode", title: "agent", prompt: "p", mode: "cli", status: "running", createdAt: Date.now(), updatedAt: Date.now(), exitCode: null }],
    messages: [],
    companion: { settings: { role: "assistant", tone: "neutral", model: "" }, messages: [] },
  }, null, 2), "utf8");

  check("порт с песочницей живого агента виден как занятый", agentSandboxAt(port), `порт ${port}`);
  const chosen = freePort(port);
  check("порт с песочницей живого агента не выбирается", chosen !== port, `выбран ${chosen}`);

  // Уборка теста чужую песочницу не сносит.
  rmDir(data);
  check("рабочая папка живого агента уцелела (песочница в песочнице наборов)", existsSync(join(copy, "agent-file.txt")), copy);
  check("база живого демона уцелела", existsSync(join(data, "db.json")), data);

  // Свою песочницу убираем — после снятия фальшивого состояния.
  ownDirs.add(data);
  rmDir(data);
  check("своя песочница убрана", !existsSync(data), data);
}

/* ── сценарий 10: решение по уборке — одно правило (F_VER-5) ───────────────── */
{
  // Реальный случай (первая рука): живой агент потерял рабочую папку. Сессия
  // к моменту уборки: pid НЕ записан (opencode отдал ход сервису, клиент умер),
  // status «error» (обрыв транспорта), updatedAt свежий — то есть «все признаки
  // мёртвого агента», а агент работает. Набор счёл сессию мёртвой, удалил её
  // через API (сервер снёс копию) — «Working directory does not exist».
  //
  // Теперь решение по уборке — одно правило (scripts/e2e-guard.ts,
  // cleanupPlan), и оно проверяется здесь: раньше ветка «свежая активность» в
  // наборе не была покрыта ни одной проверкой, и её можно было выкинуть
  // рефакторингом — тихо, до следующего уничтоженного агента.
  const dir = join(tmpdir(), "dirigo-e2e", `plan-${process.pid}`);
  ownDirs.add(dir);
  rmDir(dir);
  const copy = join(dir, "work", "ses_nopid");
  mkdirSync(copy, { recursive: true });
  writeFileSync(join(copy, "agent-file.txt"), "правка агента\n", "utf8");
  mkdirSync(join(dir, "logs"), { recursive: true });
  // pid не записан — как в реальном случае (ход у сервиса, клиент умер).
  const session = {
    id: "ses_nopid", status: "error", exitCode: 1, pid: undefined,
    createdAt: Date.now() - 8 * 60_000, updatedAt: Date.now() - 2 * 60_000,
    worktree: { kind: "git", path: copy, createdAt: Date.now() - 8 * 60_000 },
  };
  writeFileSync(join(dir, "db.json"), JSON.stringify({ projects: [], sessions: [session], messages: [] }), "utf8");
  writeFileSync(join(dir, "work", "registry.json"), JSON.stringify([
    { sessionId: "ses_nopid", kind: "git", path: copy, projectPath: ROOT, createdAt: Date.now() },
  ]), "utf8");

  check("сессия без pid, статус error, свежая активность — не сносим",
    cleanupPlan(session, dir) === "keep-busy", cleanupPlan(session, dir));
  check("каталог с такой сессией сносить нельзя", !canRemoveDataDir(dir).ok, canRemoveDataDir(dir).reason);

  // Обратная сторона: та же сессия, но следов жизни нет давно — тогда сносим.
  // Иначе правило «живое не трогать» превратится в «никогда ничего не убирать»
  // и песочница наборов вырастет (F_VER-2).
  const old = Date.now() - 60 * 60_000;
  const oldSession = { ...session, updatedAt: old };
  const oldCopy = join(dir, "work", "ses_nopid_old");
  mkdirSync(oldCopy, { recursive: true });
  writeFileSync(join(oldCopy, "agent-file.txt"), "давно\n", "utf8");
  utimesSync(oldCopy, new Date(old), new Date(old));
  utimesSync(join(oldCopy, "agent-file.txt"), new Date(old), new Date(old));
  const oldPlan = cleanupPlan({ ...oldSession, worktree: { ...session.worktree, path: oldCopy } }, dir);
  check("сессия без pid, давно без активности — сносим", oldPlan === "drop", oldPlan);

  // Остальные исходы — те же, что у набора.
  check("живая сессия — не сносим", cleanupPlan({ status: "running", pid: process.pid }, dir) === "keep-live", "");
  check("состояние неизвестно — не сносим", cleanupPlan(null, dir) === "keep-unknown", "");
  rmDir(dir);
}

/* ── сценарий 11: набор не говорит с чужим демоном (F_VER-7) ───────────────── */
{
  // Дефект (проверен на старом коде): набор поднимает своего демона и хочет
  // убедиться, что отвечает ИМЕННО он. Проверка была такой:
  //   (3) «процесс демона умер»  → server.exitCode !== null
  //   (4) «в каталоге данных есть logs/»
  // Обе — не признак «демон наш»:
  //   • logs/ создаёт store.ts при импорте, ДО попытки занять порт, — её
  //     создаёт и демон, которому порт не достался;
  //   • exitCode Bun заполняет только после «сбора» процесса, до того он
  //     остаётся null — умерший демон выглядит живым.
  // Итог: если порт заняли между проверкой и стартом, набор уходил работать с
  // ЧУЖИМ демоном — создавал в нём проекты и сессии, а на уборке удалял
  // сессию (сервер сносит копию проекта агента).
  //
  // Теперь признак — метка daemon.json: её пишет демон ПОСЛЕ того, как занял
  // порт, поэтому её создал ровно тот, кто слушает этот порт.
  const dir = join(tmpdir(), "dirigo-e2e", `own-${process.pid}`);
  ownDirs.add(dir);
  rmDir(dir);
  mkdirSync(dir, { recursive: true });

  // Демон, которому порт не достался, метки не оставил — набор это видит.
  mkdirSync(join(dir, "logs"), { recursive: true }); // store.ts создаёт logs/ при импорте
  check("демон без метки — не наш (даже если создал logs/)", !ownDaemon(dir, 8123).ok, ownDaemon(dir, 8123).reason);

  // Метка от чужого порта — тоже не наш.
  writeFileSync(join(dir, "daemon.json"), JSON.stringify({ pid: 1, port: 9999, startedAt: Date.now() }), "utf8");
  check("метка с чужим портом — не наш", !ownDaemon(dir, 8123).ok, ownDaemon(dir, 8123).reason);

  // Метка нашего порта — наш.
  writeFileSync(join(dir, "daemon.json"), JSON.stringify({ pid: process.pid, port: 8123, startedAt: Date.now() }), "utf8");
  check("метка на нашем порту — наш демон", ownDaemon(dir, 8123).ok, ownDaemon(dir, 8123).reason);

  // Битая метка — не «наш»: набор не должен верить мусору.
  writeFileSync(join(dir, "daemon.json"), "{ не json", "utf8");
  check("битая метка — не наш", !ownDaemon(dir, 8123).ok, ownDaemon(dir, 8123).reason);
  rmDir(dir);
}

/* ── сценарий 12: демон, которому порт не достался, метки не оставляет ─────── */
{
  // Ключевая предпосылка сценария 11: метку пишет только демон, ЗАНЯВШИЙ
  // порт. Проверяем на живом демоне: поднимаем «занимателя» порта, потом
  // поднимаем своего демона на том же порту — он обязан упасть и НЕ оставить
  // метки. Иначе набор отличил бы своего демона от чужого по написанной
  // метке — а она писалась бы ещё до bind, и проверка снова стала бы
  // «проходит всегда».
  const port = freePort(8040);
  const data = join(tmpdir(), `dirigo-isolation-live-${port}-${process.pid}`);
  ownDirs.add(data);
  rmDir(data);
  mkdirSync(data, { recursive: true });

  // Заниматель порта — отдельным файлом (не `bun run -e`: тот не стартует).
  const holderFile = join(data, "holder.ts");
  writeFileSync(holderFile, `
Bun.serve({ port: ${port}, hostname: "127.0.0.1", fetch: () => new Response("holder") });
setTimeout(() => process.exit(0), 30000);
`, "utf8");
  const holder = Bun.spawn([process.execPath, "run", holderFile], { cwd: ROOT, stdout: "ignore", stderr: "ignore" });
  let holderUp = false;
  for (let i = 0; i < 40; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) { holderUp = true; break; } } catch { /* */ } await sleep(250); }
  check("порт занят посторонним процессом", holderUp, `порт ${port}`);

  // Наш демон на том же порту: порт ему не достался.
  const ours = Bun.spawn([process.execPath, "run", "src/server.ts"], {
    cwd: ROOT, env: { ...process.env, PORT: String(port), DIRIGO_DATA: data } as Record<string, string>,
    stdout: "ignore", stderr: "ignore",
  });
  await sleep(4000);
  const exited = ours.exitCode !== null;
  const markExists = existsSync(join(data, "daemon.json"));
  check("демон, которому порт не достался, умер", exited, `exitCode ${ours.exitCode}`);
  check("демон, которому порт не достался, метки не оставил", !markExists, data);
  // Прежний признак «logs/» обесценивается: павший демон папку создал.
  check("прежний признак (logs/) обесценивается — он есть у павшего демона", existsSync(join(data, "logs")), data);

  ours.kill(); holder.kill();
  await sleep(300);
  rmDir(data);
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
