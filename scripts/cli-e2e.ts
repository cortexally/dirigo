// e2e CLI (V2-4.1): живой демон + реальные вызовы v2.ts.
//
// НАБОР НЕ ПОРТИТ ЧУЖОЕ СОСТОЯНИЕ. Правило появилось из реального случая:
// набор сносил каталог данных, в котором жил агент (он же — тот, кто этот
// набор запускает). Агент продолжал работать, но его рабочая папка исчезала:
// «Working directory does not exist», правки терялись.
//
//   • порт — свой: если на запрошенном порту уже отвечает демон, набор берёт
//     свободный рядом и НЕ говорит с чужим демоном (иначе уборка снесла бы
//     его каталог данных);
//   • каталог данных — свой: вытирается только когда там нет живых сессий и
//     живых копий, он не содержит рабочую папку самого набора и не задан
//     извне через DIRIGO_DATA;
//   • уборка — в правильном порядке: сперва сессия гасится через API (сервер
//     сам убирает копию агента — с ретраями под Windows), потом каталог;
//     живая сессия остаётся вместе с каталогом: её рабочая папка
//     неприкосновенна, и агент может дописать правки.
//
// E2E_CLI_SKIP_AGENT=1 — режим без процесса агента: сессия создаётся в
// web-режиме (ссылка, ничего не поднимается) — для проверки изоляции и
// быстрых прогонов.
// E2E_CLI_WAIT_MS — сколько ждать агента (по умолчанию 120 с). Пока агент
// работает, демон держит журнал сессии: ответ агента должен попасть в лог.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
// Правила изоляции — ОТТУДА, а не своей копией: регресс-набор проверяет
// именно e2e-guard, и своя копия правил в наборе рано или поздно с ней
// разойдётся (так и вышло: правила усилили в guard, а набор продолжал
// сносить каталоги по старым).
import {
  canRemoveDataDir, cleanupPlan, daemonMarkPath, makeScratchProject, ownDaemon, pickDataDir,
  pidAlive, projectDirFor, removeTreeSafely, sessionState, sweepSandbox, writeMarker,
} from "./e2e-guard";

const PORT_REQ = Number(process.env.E2E_CLI_PORT ?? 7289); // V6.13: динамический порт — гейты пула не конфликтуют
const SKIP_AGENT = process.env.E2E_CLI_SKIP_AGENT === "1";
const WAIT_MS = Number(process.env.E2E_CLI_WAIT_MS ?? 120_000);
const ROOT = join(import.meta.dir, ".."); // корень набора: демон и CLI запускаем отсюда
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ── изоляция: свой порт, свой каталог данных ────────────────────────────── */

/** Отвечает ли по этому адресу демон? */
async function daemonAt(base: string): Promise<boolean> {
  try {
    const r = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch { return false; }
}

/**
 * Порт занят другим прогоном набора? (claim-файл с живым pid)
 *
 * Гонка была реальной: пул гоняет наборы одновременно, оба брали один порт —
 * и один набор говорил с демоном другого (чужие проекты, чужие сессии, а
 * уборка била по чужому каталогу).
 */
function claimedByOther(port: number): boolean {
  try {
    const raw = JSON.parse(readFileSync(join(tmpdir(), "dirigo-e2e", `claim-${port}`), "utf8"));
    return typeof raw?.pid === "number" && raw.pid !== process.pid && pidAlive(raw.pid);
  } catch { return false; }
}

/** Закрепить порт за этим прогоном (эксклюзивно: файл claim — «wx»). */
function claimPort(port: number): boolean {
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

/** Свой порт демона: незанятый живым демоном, не закреплённый за другим
 *  прогоном набора и закрепляемый за собой. */
async function pickPort(want: number): Promise<number> {
  for (let p = want; p < want + 50; p++) {
    if (claimedByOther(p)) continue; // порт держит другой прогон набора
    if (await daemonAt(`http://127.0.0.1:${p}`)) continue; // там уже отвечает демон
    try {
      const s = Bun.listen({ hostname: "127.0.0.1", port: p, socket: { data() {}, open() {}, close() {}, error() {} } });
      s.stop(true);
      if (!claimPort(p)) continue; // порт забрал другой прогон
      return p;
    } catch { /* порт занят — берём следующий */ }
  }
  throw new Error(`нет свободного порта рядом с ${want}`);
}

/**
 * Каталог данных набора — можно ли его снести?
 *
 * Правила живут в scripts/e2e-guard.ts: их и проверяет регресс-набор
 * scripts/cli-e2e-isolation-test.ts. Своя копия правил здесь — это вторая
 * правда: правила усилили в guard, а набор продолжал сносить каталоги по
 * старым (так у живого агента пропадала рабочая папка).
 *
 * own=true — каталог нашего прогона: его метку (suite.json с живым pid) мы
 * игнорируем, остальные проверки остаются в силе.
 */
const canRemove = (dir: string, own = false): boolean =>
  canRemoveDataDir(dir, { cwd: ROOT, ignorePid: own ? process.pid : undefined }).ok;

// Порт: занятый живым демоном или другим прогоном набора не трогаем.
const PORT = await pickPort(PORT_REQ);
const BASE = `http://127.0.0.1:${PORT}`;

// Каталог данных — в ПЕСОЧНИЦЕ НАБОРОВ (<tmp>/dirigo-e2e). Имя «dirigo-<метка>-<порт>»
// в корне tmp занимают рабочие песочницы агентов: набор с таким именем сносил
// ЧУЖУЮ рабочую папку — агент падал с «Working directory does not exist», правки
// терялись. Здесь имя набора не совпадает ни с чьим.
const DATA_HOME = join(tmpdir(), "dirigo-e2e", `cli-e2e-${PORT}`);
// Свой каталог — через pickDataDir: прошлый прогон вытирается переименованием
// (папку, которую держит процесс, сносить нельзя: rm -r снёс бы её файлы
// наполовину, и агент потерял бы правки), а занятый каталог обходится новым
// именем. Метка suite.json с живым pid: чужой прогон такой каталог не тронет.
const DATA = pickDataDir(PORT);
mkdirSync(DATA, { recursive: true });
writeMarker(DATA, { pid: process.pid, port: PORT, startedAt: Date.now() });

const server = Bun.spawn([process.execPath, "run", "src/server.ts"], { cwd: join(import.meta.dir, ".."), env: { ...process.env, PORT: String(PORT), DIRIGO_DATA: DATA }, stdout: "ignore", stderr: "ignore" });
for (let i = 0; i < 50; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch {} await sleep(300); }
// Демон набора должен быть НАШ: если процесс умер (порт заняли), набор говорил бы
// с чужим демоном и уборкой снёс бы чужой каталог данных.
//
// Проверка «процесс умер» по server.exitCode сама по себе ненадёжна: Bun
// заполняет это поле только после того, как процесс «собран» (reaped), а до
// того остаётся null — то есть умерший демон выглядит живым. Поэтому главный
// признак — метка daemon.json.
//
// Признак нашего — метка daemon.json: её пишет демон ПОСЛЕ того, как занял
// порт, поэтому её создал ровно тот, кто слушает этот порт.
//
// Прежняя проверка (папка logs/ в своём каталоге данных) этого не доказывала:
// logs/ создаёт store.ts при импорте, ДО попытки занять порт, — то есть её
// создаёт и демон, которому порт не достался. Проверка проходила, и набор
// уходил работать с чужим демоном: создавал в нём проекты и сессии, а на
// уборке удалял сессию (сервер сносит копию проекта агента).
// Ждём метку: демон пишет её сразу после bind, но на всякий случай даём
// ему время (и прекращаем ждать, если демон умер — порт не достался).
for (let i = 0; i < 50; i++) {
  if (existsSync(daemonMarkPath(DATA))) break;
  if (server.exitCode !== null) break;
  await sleep(100);
}
const own = ownDaemon(DATA, PORT);
if (!own.ok) {
  console.log(`FAIL  нам ответил не наш демон: ${own.reason} — набор прерван: ${DATA}`);
  server.kill();
  removeTreeSafely(DATA);
  process.exit(1);
}
const env = { ...process.env, DIRIGO_HOST: BASE, DIRIGO_DATA: DATA };
/** stderr последней упавшей команды — попадёт в строку FAIL, если деталь не дана. */
let lastErr = "";
const run = async (args: string[]) => {
  // cwd — корень набора: иначе «scripts/orch.ts» ищется в каталоге, откуда
  // запустили набор, и набор падает с «Module not found» (а проект при этом
  // всё равно берётся из process.cwd() — путаница двух разных папок).
  const p = Bun.spawn([process.execPath, "run", "scripts/orch.ts", ...args], { cwd: ROOT, env, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  const err = await new Response(p.stderr).text();
  const code = await p.exited;
  // Причина сбоя — в stderr команды: набор покажет её в строке FAIL.
  // Раньше упавшая команда давала пустой FAIL («— » без текста), и причину
  // приходилось угадывать по месту в наборе.
  lastErr = code === 0 ? "" : err.trim();
  return { code, out: out.trim(), err: err.trim() };
};
let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  // Упавшая проверка: сначала причина из stderr CLI, потом деталь проверки.
  const d = !ok && lastErr ? `ошибка CLI: ${lastErr.slice(0, 200)}${detail ? ` (${detail})` : ""}` : detail;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${d ? "  — " + d : ""}`);
  ok ? pass++ : fail++;
};
const skip = (name: string, detail = "") => console.log(`SKIP  ${name}${detail ? "  — " + detail : ""}`);
/** Сессия набора: состояние из API. */
const session = async (id: string): Promise<any> => {
  try { const r = await fetch(`${BASE}/api/sessions/${id}`); return r.ok ? await r.json() : null; } catch { return null; }
};
/**
 * Жива ли сессия (агент работает)?
 *
 * Одного статуса мало: он врёт. «send» в режиме «Задача (CLI)» поднимает
 * второй процесс, и его выход объявлял сессию готовой, пока основной агент
 * ещё работал. Набор верил статусу и сносил копию проекта — у живого агента
 * пропадала рабочая папка («Working directory does not exist»), а с ней правки.
 * Поэтому смотрим и на живой процесс агента (pid).
 */
const isLive = (s: any) => sessionState(s) === "live";
/** Агент точно закончил (только тогда можно сносить копию и каталог). */
const isDead = (s: any) => sessionState(s) === "dead";
/**
 * Проект набора — ЧЕРНОВИК в песочнице, а не рабочий репозиторий разработчика.
 *
 * «apply» переносит правки агента в проект, а «revert» откатывает проект
 * целиком (в git-режиме — `git checkout` + `git clean` по всему дереву). С
 * репозиторием разработчика это снесло бы чужие правки: незакоммиченные
 * изменения и untracked-файлы. Поэтому набор работает с копией проекта в
 * песочнице — её и убирать не жалко.
 */
let SCRATCH = projectDirFor(PORT);
// Занятый черновик (живой агент прошлого прогона) обходим новым именем.
if (existsSync(SCRATCH) && !removeTreeSafely(SCRATCH).ok) SCRATCH = `${projectDirFor(PORT)}-${process.pid}`;
makeScratchProject(SCRATCH, ROOT);
// Метка с живым pid: пока набор работает, черновик никто не снесёт (в том числе
// чистка песочницы — см. sweepSandbox в e2e-guard).
writeMarker(SCRATCH, { pid: process.pid, port: PORT, startedAt: Date.now() });
// Мусор прошлых прогонов в песочнице — только то, что никто не держит.
// Свежие каталоги (меньше получаса) не трогаем: набор мог ещё не дописать
// db.json, и мы снесли бы его каталог из-под ног.
sweepSandbox([DATA, SCRATCH]);

/** Проект набора (черновик) — регистрируется один раз. */
const projectId = async (): Promise<string> => {
  const r = await fetch(`${BASE}/api/projects`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "cli", path: SCRATCH }) });
  return ((await r.json()) as any).id as string;
};

/* ── откуда запущен набор (F_VER-5) ───────────────────────────────────────── */

/**
 * Корень репозитория над набором — или null, если набор запущен из копии.
 *
 * Набор копирует проект из своей рабочей копии (снимок сессии агента, а не
 * репозиторий). Правила изоляции живут в коде набора — и в снимке они могут
 * быть СТАРЫМИ: прогон со снимком выглядит как проверка репозитория, а
 * проверяет не репозиторий. Именно так повторился инцидент F_VER-5: набор
 * без правок F_VER-4 снёс рабочую папку живого агента и отчитался зелёным.
 */
function findRepoRoot(from: string): string | null {
  let dir = resolve(from);
  for (let i = 0; i < 20; i++) {
    if (existsSync(join(dir, ".git"))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/** Актуальны ли правила набора в этой копии (F_VER-4/F_VER-5)? */
function rulesAreCurrent(root: string): boolean {
  try {
    const src = readFileSync(join(root, "scripts", "e2e-guard.ts"), "utf8");
    return src.includes("recentActivity") && src.includes("cleanupPlan");
  } catch { return false; }
}

const REPO_ROOT = findRepoRoot(ROOT);
const STALE_RULES = !REPO_ROOT || !rulesAreCurrent(ROOT);
const gitSha = (() => {
  if (!REPO_ROOT) return "-";
  try {
    const p = Bun.spawnSync(["git", "-C", REPO_ROOT, "rev-parse", "--short", "HEAD"]);
    return p.exitCode === 0 ? String(p.stdout.toString()).trim() : "?";
  } catch { return "?"; }
})();
console.log(`набор запущен из: ${REPO_ROOT ? `репозитория ${REPO_ROOT} (${gitSha})` : `КОПИИ-СНИМКА ${ROOT}`}`);
if (STALE_RULES) {
  // Из снимка удалять нечего: правила могут быть старыми, а агент — живым.
  console.log("ВНИМАНИЕ: набор запущен не из репозитория (или правила в копии старые) — уборку пропускаем: живое не сносим");
}

const h = await run(["health"]);
check("health", h.code === 0 && h.out.includes("активных"), `${h.code} ${h.out.slice(0, 60)}`);
check("демон набора — свой (порт не занят живым)", server.exitCode === null, `порт ${PORT}`);
// «own» — метка (suite.json) самого набора не считается чужим состоянием.
check("каталог данных свой: чужой не тронут", DATA !== DATA_HOME || canRemove(DATA_HOME, true), DATA);
const none = await run(["ls"]);
check("ls пустой", none.code === 0, `${none.code} ${none.out.slice(0, 40)}`);
const bad = await run(["run"]);
check("usage-код 2", bad.code === 2, `${bad.code}`);

let sid = "";
if (SKIP_AGENT) {
  // Сессия без процесса агента: web-режим внешнего агента (только ссылка) —
  // ничего не поднимается, сессия остаётся живой. Так проверяется путь
  // уборки «живое не трогаем» без живых агентов и без токенов.
  console.log("режим набора: E2E_CLI_SKIP_AGENT=1 — web-сессия, процесса агента нет");
  const w = await run(["run", "minimax", "cli-e2e", "--mode", "web", "--wt", "copy", "--project", await projectId(), "--json"]);
  let wbody: any = null; try { wbody = w.out ? JSON.parse(w.out) : null; } catch { wbody = null; }
  check("сессия без агента создана", w.code === 0 && !!wbody?.id, `${w.code} ${w.out.slice(0, 60)} ${w.err.slice(0, 60)}`);
  sid = wbody?.id ?? "";
  skip("живой агент", "E2E_CLI_SKIP_AGENT=1 — процесс агента не поднимается");
} else {
  // Агент — по реальной доступности CLI на этой машине (см. scripts/pick-agent.ts).
  const { pickAgent } = await import("./pick-agent");
  const cliAgent = await pickAgent(BASE, "cli");
  const webAgent = cliAgent ? null : await pickAgent(BASE, "web");
  const cliAgentId = cliAgent ?? webAgent ?? "cursor";
  // Какой путь набор реально проверяет — печатаем: иначе «19/19 зелёных» означают
  // разные вещи в зависимости от того, нашёлся ли CLI-агент на этой машине, и
  // прогон молча вырождается в проверку web-сессии.
  console.log(`режим набора: агент ${cliAgentId} (${cliAgent ? "CLI — живой агент" : webAgent ? "web — без процесса агента" : "по умолчанию"})`);
  if (!cliAgent) {
    skip("живой агент (путь CLI)", `CLI-агент на машине недоступен — взят web-агент ${cliAgentId}: путь «живой агент» этим прогоном НЕ проверяется`);
  }
  const r = await run(["run", cliAgentId, "cli-e2e", "--project", await projectId(), "--copy", "--json"]);
  let runBody: any = null;
  try { runBody = r.out ? JSON.parse(r.out) : null; } catch { runBody = null; }
  check("run --copy --json", r.code === 0 && !!runBody?.worktree && !!runBody.restorePoint, `${r.code} out=${r.out.slice(0, 100)} err=${r.err.slice(0, 100)}`);
  if (!runBody) { console.log("run не удался — остальные проверки бессмысленны"); server.kill(); process.exit(1); }
  sid = runBody.id as string;
  const l = await run(["ls", "--json"]);
  check("ls --json", l.code === 0 && JSON.parse(l.out).some((s: any) => s.id === sid), "");
  const s = await run(["send", sid, "привет"]);
  check("send", s.code === 0, `${s.code} ${s.err.slice(0, 60)}`);
  // Ждём агента (ограниченно): пока он работает, демон держит журнал сессии —
  // ответ агента должен попасть в лог, а не потеряться вместе с демоном.
  if (WAIT_MS > 0) {
    const t0 = Date.now();
    let state = "?";
    while (Date.now() - t0 < WAIT_MS) {
      const cur = await session(sid);
      state = cur?.status ?? "?";
      if (!isLive(cur)) break;
      await sleep(1000);
    }
    const waited = Math.round((Date.now() - t0) / 1000);
    if (isLive({ status: state })) skip("агент закончил работу", `через ${waited} с ещё работает (${state}) — данные и копия остаются`);
    else check("агент закончил работу", true, `${state} за ${waited} с`);
  }
  // Ответ агента должен попасть в журнал — но ОТВЕТ, а не текст ошибки
  // (F_VER-5, пункт 5): у уничтоженного агента «последнее сообщение» — это
  // ошибка, и она есть в журнале. Проверка «ответ есть в журнале» на таком
  // тексте зеленеет — гейт показывает «всё хорошо» поверх мёртвого агента.
  {
    const sesFull = await session(sid);
    const agentMsgs: string[] = (sesFull?.messages ?? [])
      .filter((m: any) => m?.role === "agent")
      .map((m: any) => String(m?.text ?? ""));
    const isErrorText = (t: string) => !t.trim()
      || /^(error|ошибка|exception|traceback|fatal)/i.test(t.trim())
      || /working directory does not exist/i.test(t)
      || /\b(exited with code|exit code)\b/i.test(t);
    const answers = agentMsgs.filter((t) => !isErrorText(t));
    if (isLive(sesFull)) {
      // Агент ещё работает: ответа пока нет — судить не о чем.
      skip("ответ агента попал в журнал", "агент ещё работает — ответа пока нет");
    } else if (!answers.length) {
      // Ответа нет: упавший агент — это не «зелёный» гейт (F_VER-5).
      const why = sesFull?.failReason
        ? `агент упал: ${String(sesFull.failReason).slice(0, 120)}`
        : agentMsgs.length ? "последнее сообщение агента — текст ошибки, а не ответ" : "агент не оставил ответа";
      check("ответ агента попал в журнал", false, why);
    } else {
      const lg = await fetch(`${BASE}/api/sessions/${sid}/log?n=100000`).then((r) => r.json() as any).catch(() => null);
      const logLines: string[] = lg?.lines ?? [];
      const norm = (t: string) => t.replace(/\x1B\[[0-9;]*[A-Za-z]/g, "").replace(/\s+/g, " ").trim();
      const needle = norm(answers[answers.length - 1]!);
      const hay = norm(logLines.join("\n"));
      check("ответ агента попал в журнал", !!needle && hay.includes(needle), needle.slice(0, 70));
    }
  }
  const d = await run(["diff", sid, "--json"]);
  const diffBody = (() => { try { return JSON.parse(d.out); } catch { return null; } })();
  check("diff --json", d.code === 0 && !!diffBody && typeof diffBody.files !== "undefined", `${d.code}`);
  // apply/revert не должны наступить на работу живого агента: если агент уже
  // что-то менял, а сессия ещё жива — не трогаем копию (иначе теряем правки).
  const sesNow = await session(sid);
  const diffFiles: any[] = diffBody?.files ?? [];
  if (!isDead(sesNow) && diffFiles.length) {
    skip("apply/revert", `сессия жива (${sesNow?.status ?? "состояние неизвестно"}) и агент уже менял ${diffFiles.length} файл(ов) — не наступаем на его работу`);
  } else {
    const a = await run(["apply", sid]);
    check("apply", a.code === 0, `${a.code} ${a.out.slice(0, 80)}`);
    const rv = await run(["revert", sid]);
    check("revert", rv.code === 0, `${rv.code}`);
  }
  const ck = await run(["checks", sid, "--json"]);
  check("checks (нет проверок — не 4xx)", ck.code !== 4, `${ck.code} ${ck.out.slice(0, 60)}`);
}
const pl = await run(["plans"]);
check("plans пустой", pl.code === 0, `${pl.code}`);
const nf = await run(["plan", "plan_нет"]);
check("plan не найден → 3", nf.code === 3, `${nf.code}`);

/* «Не найдено» — один код на все команды (3): демон отвечает 404, значит
 * и CLI должен говорить «не найдено», а не «отказ демона» (4). Раньше
 * часть команд отдавала 4 (start/apply-plan/apply/attach), а machine-probe
 * для несуществующей машины — 1. Набор это стережёт: контракт кодов должен
 * быть один и тот же для всех «несуществующих» id.
 */
for (const [args, name] of [
  [["start", "plan_нет"], "start не найден → 3"],
  [["apply-plan", "plan_нет"], "apply-plan не найден → 3"],
  [["apply", "ses_нет"], "apply не найден → 3"],
  [["attach", "ses_нет"], "attach не найден → 3"],
  [["machine-probe", "m_нет"], "machine-probe не найден → 3"],
] as [string[], string][]) {
  const r = await run(args);
  check(name, r.code === 3, `${r.code} ${r.err.slice(0, 60)}`);
}

// --- V3-5/1/2/3: setup / machines / tunnel через CLI ---
const st = await run(["setup", "--json"]);
const stBody = st.code === 0 ? JSON.parse(st.out || "[]") : [];
check("cli: setup — агенты и мосты со статусами", st.code === 0 && stBody.length >= 13 && stBody.every((a: any) => !!a.state), `${stBody.length}`);
const badst = await run(["setup-install", "нет-такого"]);
check("cli: setup-install неизвестного → 3/4", badst.code === 3 || badst.code === 4, `${badst.code}`);
const sj = await run(["setup-jobs"]);
check("cli: setup-jobs", sj.code === 0, `${sj.code}`);
const ma = await run(["machine-add", "--at", "203.0.113.42", "--user", "root", "--name", "e2e-vps", "--json"]);
const maBody = ma.code === 0 ? JSON.parse(ma.out || "null") : null;
check("cli: machine-add", ma.code === 0 && !!maBody?.id, ma.out.slice(0, 80));
if (maBody) {
  check("cli: machine localPort", maBody.localPort === 8271, `${maBody.localPort}`);
  const ml = await run(["machines", "--json"]);
  check("cli: machines список", ml.code === 0 && JSON.parse(ml.out).some((m: any) => m.id === maBody.id), "");
  const mp = await run(["machine-probe", maBody.id]);
  check("cli: machine-probe (недоступна → код 1)", mp.code === 1, `${mp.code} ${mp.out.slice(0, 60)}`);
  const md = await run(["machine-deploy", maBody.id, "--dry-run", "--json"]);
  const mdBody = md.code === 0 ? JSON.parse(md.out || "null") : null;
  check("cli: machine-deploy --dry-run", md.code === 0 && mdBody?.ok === true && (mdBody?.log ?? []).some((l: string) => l.includes("dry-run")), md.out.slice(0, 80));
  const mdel = await run(["machine-del", maBody.id]);
  check("cli: machine-del", mdel.code === 0, `${mdel.code}`);
}
const tn = await run(["tunnel"]);
check("cli: tunnel status", tn.code === 0 && /туннель|остановлен/.test(tn.out), tn.out.slice(0, 80));

/* ── уборка: сперва сессия через API, потом каталог; живое — не трогаем ── */
const sesEnd = sid ? await session(sid) : null;
// Решение — по общему правилу (scripts/e2e-guard.ts, cleanupPlan), а не
// «как получится» на месте: правило одно, проверяется тестом и не может
// разъехаться между набором и регрессом (F_VER-5).
//
//   keep-live    — агент работает;
//   keep-unknown — состояние не узнали: это не «мёртвый агент», сносить нельзя;
//   keep-busy    — формально завершена, но видно свежую активность: агент
//                  (в сервисе агента) ещё может работать — F_VER-4;
//   drop         — завершена и активности нет.
const plan = cleanupPlan(sesEnd, DATA);
const unknown = plan === "keep-unknown";
const busy = plan === "keep-busy";
if (plan === "keep-live") {
  // Агент ещё работает: его копия проекта и каталог данных — его рабочее
  // место. Раньше набор сносил их, и агент падал с «Working directory does
  // not exist», теряя правки. Сессию не удаляем и каталог не трогаем: демон
  // погасится вместе с набором, но журнал, база и копия останутся на диске.
  const wt = (sesEnd.worktree?.path as string) ?? "";
  check("уборка не тронула рабочую папку живого агента", !wt || existsSync(wt), wt || "-");
  console.log(`\nсессия ${sid} жива (${sesEnd.status}) — данные и копия оставлены: ${DATA}`);
  console.log(`  журнал: ${join(DATA, "logs", `${sid}.log`)} · база: ${join(DATA, "db.json")}`);
  // Демон погаснет вместе с набором — через API остановить агента будет нечем,
  // а порт из подсказки уже не отвечает. Печатаем pid: остановить можно
  // напрямую, не теряя правки агента.
  if (sesEnd.pid) console.log(`  агент живой (pid ${sesEnd.pid}) — остановить: taskkill /PID ${sesEnd.pid} /T /F`);
  console.log(`LIVE  порт=${PORT} данные=${DATA} сессия=${sid}`);
} else if (unknown) {
  console.log(`\nсостояние сессии ${sid} неизвестно — ничего не сносим: ${DATA}`);
  console.log(`LIVE  порт=${PORT} данные=${DATA} сессия=${sid}`);
} else if (busy) {
  // Формально сессия завершена, но следы работы свежие: агент (в сервисе
  // агента) ещё может работать. Ничего не сносим — иначе он потеряет рабочую
  // папку (F_VER-4).
  console.log(`\nсессия ${sid} формально завершена, но видно свежую активность — ничего не сносим: ${DATA}`);
  console.log(`LIVE  порт=${PORT} данные=${DATA} сессия=${sid}`);
} else if (sid) {
  // Сессия завершена: гасим и удаляем её через API — сервер убирает копию
  // агента сам (ретраи под Windows), и только потом сносим каталог данных.
  if (STALE_RULES) {
    console.log(`\nнабор запущен не из репозитория — сессию ${sid} не удаляем, каталог данных не сносим: ${DATA}`);
    console.log(`LIVE  порт=${PORT} данные=${DATA} сессия=${sid}`);
  } else {
    await fetch(`${BASE}/api/sessions/${sid}`, { method: "DELETE" }).catch(() => {});
  }
  // Копию сервер убирает с ретраями (папку может держать процесс агента) —
  // ждём освобождения, иначе в tmp остаётся мусор на каждый прогон.
  const wt = (sesEnd?.worktree?.path as string) ?? "";
  for (let i = 0; i < 20; i++) {
    if (!wt || !existsSync(wt)) break;
    await sleep(500);
  }
  if (wt && existsSync(wt) && !STALE_RULES) {
    // Переименованием, а не rm -r: обычный rm на Windows сносит ФАЙЛЫ внутри
    // папки, которую держит процесс агента, и падает на самой папке — агент
    // теряет рабочую папку и правки («Working directory does not exist»).
    // Не переименовалось — папка занята процессом: не трогаем её вовсе.
    if (!removeTreeSafely(wt).ok) console.log(`рабочая папка агента занята процессом — оставлена: ${wt}`);
  }
}
server.kill();
if (STALE_RULES) {
  // Из копии-снимка уборку не делаем: правила могут быть старыми, а агент —
  // живым (F_VER-5). Каталог и копия останутся на диске.
  console.log("каталог данных оставлен (набор запущен не из репозитория — уборка пропущена)");
} else if (sid && plan !== "drop") {
  console.log("каталог данных оставлен (живая сессия, неизвестное состояние или свежая активность) — уберёт следующая чистка");
} else if (canRemove(DATA, true)) {
  // Переименованием, а не rm -r: папку, которую держит процесс агента, снести
  // нельзя — обычный rm снёс бы её файлы и уронил работу агента.
  if (!removeTreeSafely(DATA).ok) console.log(`каталог данных оставлен (держит процесс): ${DATA}`);
  // Черновик проекта — тоже мусор: копия в песочнице, её не жалко. Убираем
  // только вместе с каталогом данных: пока агент жив, репозиторий черновика
  // ему нужен (в нём идёт его работа).
  if (!removeTreeSafely(SCRATCH).ok) console.log(`черновик проекта оставлен: ${SCRATCH}`);
} else console.log(`каталог данных оставлен (занят): ${DATA}`);
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
