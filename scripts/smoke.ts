// Dirigo — smoke-тест: матрица агентов e2e.
// Запуск: bun run scripts/smoke.ts
// Поднимает временный инстанс сервера (свой порт + ИЗОЛИРОВАННОЕ хранилище),
// прогоняет web-режимы всех агентов, CLI-спавн, бэкап и деградацию
// (битый db.json, рестарт сервера с живой сессией), печатает PASS/FAIL матрицу.
// Боевой data/db.json не трогает.

import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// V8: параллельно-безопасный прогон — два агента могут гонять gate одновременно.
// Свой порт И свой каталог данных на процесс (SMOKE_PORT/SMOKE_RUN_ID перекрывают).
const RUN_SUFFIX = process.env.SMOKE_RUN_ID || `${process.pid}`;
const PORT = Number(process.env.SMOKE_PORT ?? 7100 + (process.pid % 300));
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = `${import.meta.dir}/../.smoke-data-${RUN_SUFFIX}`;
const BUN = process.execPath;

type Check = { name: string; ok: boolean; detail: string };
const results: Check[] = [];
const rec = (name: string, ok: boolean, detail = "") => results.push({ name, ok, detail });

async function jget(path: string) {
  const r = await fetch(BASE + path);
  return { status: r.status, body: await r.json().catch(() => null) as any };
}
async function jpost(path: string, body: unknown) {
  const r = await fetch(BASE + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) as any };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitHealth(timeoutMs = 15000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return true;
    } catch { /* ещё поднимается */ }
    await sleep(300);
  }
  return false;
}

/** Ждёт, пока сессия выйдет из queued (или таймаут). */
async function waitStarted(id: string, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = (await jget(`/api/sessions/${id}`)).body;
    if (s && s.status !== "queued") return s;
    await sleep(400);
  }
  return (await jget(`/api/sessions/${id}`)).body;
}

const SERVER_LOG = `${import.meta.dir}/../.smoke-build/server.log`;
let serverLogSink: Array<{ out: string; err: string }> = [];

function spawnServer() {
  mkdirSync(`${import.meta.dir}/../.smoke-build`, { recursive: true });
  const proc = Bun.spawn([BUN, "run", "src/server.ts"], {
    env: { ...process.env, PORT: String(PORT), DIRIGO_DATA: DATA },
    stdout: "pipe",
    stderr: "pipe",
  });
  const pump = async (stream: ReadableStream<Uint8Array>, kind: "out" | "err") => {
    try {
      for await (const chunk of stream) {
        const text = new TextDecoder().decode(chunk);
        serverLogSink.push({ out: kind === "out" ? text : "", err: kind === "err" ? text : "" });
      }
    } catch { /* процесс убит */ }
  };
  pump(proc.stdout, "out").catch(() => {});
  pump(proc.stderr, "err").catch(() => {});
  return proc;
}

function dumpServerLog() {
  try {
    const text = serverLogSink.map((s) => (s.err ? `[err] ${s.err}` : s.out)).join("");
    Bun.spawnSync(["powershell", "-NoProfile", "-Command",
      `New-Item -ItemType Directory -Path '${import.meta.dir}/../.smoke-build' -Force | Out-Null; Add-Content -LiteralPath '${SERVER_LOG}' -Value @'\n${text}\n'@ -Encoding utf8`]);
  } catch { /* нет доступа — не критично */ }
}

// подготовка: битый db.json — сервер должен уйти в карантин, а не упасть
mkdirSync(DATA, { recursive: true });
await Bun.write(`${DATA}/db.json`, "{ это точно не json");

let server = spawnServer();
let activeServer = server;

try {
  rec("server up", await waitHealth());

  // сборка фронта (ловим TS-синтаксис в .js и прочие поломки bundles).
    // ВАЖНО: --target=browser — без него bun build транспилирует TS в JS и гейт
    // пропускает TypeScript-конструкции в .js-модуле. Браузер же получает файл
    // как <script type="module"> и МОЛЧА не исполняет его при синтакс-ошибке
    // (14.10: весь UI был пуст из-за `as Error` / `: string[]` в web/app.js).
    {
      const b = Bun.spawnSync([BUN, "build", "web/app.js", "--target=browser", "--outfile", `${import.meta.dir}/../.smoke-build/app.js`], { cwd: `${import.meta.dir}/..` });
      rec("web/app.js builds (browser, без TS)", b.exitCode === 0, b.exitCode === 0 ? "" : b.stderr.toString().slice(0, 300));
    }

  // деградация 1: битый db.json → карантин + чистый старт (сид — на старте файла).
  {
    const quarantined = readdirSync(DATA).some((f) => /^db\.json\.corrupt-/.test(f));
    rec("битый db.json → карантин", quarantined, quarantined ? "db.json.corrupt-* создан" : "файла карантина нет");
  }

  // --- контракты API ---
  const health = await jget("/api/health");
  rec("GET /api/health", health.status === 200, `${health.status}`);
  const agents = (await jget("/api/agents")).body ?? [];
  // Машины различаются набором установленных агентов, поэтому smoke проверяет
  // КОНТРАКТ, а не конкретный агент: доступный режим обязан стартовать,
  // недоступный — быть отклонён до создания сессии, с причиной и способом
  // починить. Раньше здесь жило старое поведение (сессия-призрак в error).
  const modeOk = (a: any, m: string) => (a?.availability?.modes ?? []).some((x: any) => x.mode === m && x.available);
  const firstWith = (m: string) => (agents as any[]).find((a) => modeOk(a, m));
    rec("агенты в /api/agents (13 после V5: +freebuff/cline)", Array.isArray(agents) && agents.length === 13, `${agents.length}`);
    // V5 (HA): реестр провайдеров — freebuff (stdinPrompt) и cline (ACP) полностью описаны
    const fb = agents.find((a: any) => a.id === "freebuff");
    rec("провайдер freebuff: kind/stdin-механизм", fb?.kind === "cli" && (fb?.stdinPrompt ?? fb?.hint?.includes("freebuff")), JSON.stringify({ kind: fb?.kind }));
    const cl = agents.find((a: any) => a.id === "cline");
    rec("провайдер cline: ACP + PTY", !!cl?.acp && !!cl?.pty, JSON.stringify({ acp: !!cl?.acp, pty: !!cl?.pty }));
  rec("web-режим в /api/agents", agents.every((a: any) => a.web !== null), "все агенты имеют web");
  // H-V6-1: реестр моделей + reasoning для всех агентов
  // Список моделей обязателен только у тех, кто реально принимает флаг модели.
  // Пустой список у остальных — не пробел в реестре, а честное «выбора нет»:
  // раньше там стоял фиктивный пункт «default», выглядевший как поломка меню.
  // Источник списка может быть двух видов: статический в реестре или команда
  // самого агента (`modelsCommand`). Второй предпочтительнее — он не протухает.
  rec("H-V6-1: у агентов с флагом модели список моделей есть откуда взять",
    agents.filter((a: any) => a.modelFlag).every((a: any) => (a.models?.length ?? 0) >= 1 || !!a.modelCommand || !!a.modelsCommand),
    agents.filter((a: any) => a.modelFlag && !(a.models?.length) && !a.modelCommand && !a.modelsCommand).map((a: any) => a.id).join(",") || "все покрыты");
  rec("H-V6-1: без фиктивной модели «default»",
    agents.every((a: any) => !(a.models ?? []).includes("default")),
    agents.filter((a: any) => (a.models ?? []).includes("default")).map((a: any) => a.id).join(",") || "нет фиктивных");
  // Список уровней — только у агентов с реальным флагом: иначе выбор молча
  // терялся, а дефолт «high» понижал уровень, настроенный в самом агенте.
  rec("H-V6-1: reasoning[] ровно у агентов с флагом", agents.every((a: any) => Array.isArray(a.reasoning) && (a.reasoningFlag ? a.reasoning.length >= 1 : a.reasoning.length === 0)), "reasoning ↔ reasoningFlag");
  const withModelFlag = agents.filter((a: any) => a.modelFlag || a.defaultModel);
  rec("H-V6-1: агенты с выбором модели (флаг/дефолт)", withModelFlag.length >= 3, `${withModelFlag.length}/13`);
  // H-V6-2: buildArgs применяет reasoning-флаг только у агентов с reasoningFlag
  const { getAgent, buildArgs } = await import("../src/agents/registry");
  const kiloDef = getAgent("kilo")!;
  const kiloHigh = buildArgs(kiloDef, "ses_hv62", "промпт", "C:/tmp", "kilo/kilo-auto/free", "high");
  rec("H-V6-2: kilo reasoning=high → --variant high в argv", kiloHigh.includes("--variant") && kiloHigh[kiloHigh.indexOf("--variant") + 1] === "high" && kiloHigh.indexOf("--variant") < kiloHigh.length - 1, kiloHigh.join(" "));
  const ocDef = getAgent("opencode")!;
  const ocHigh = buildArgs(ocDef, "ses_hv62", "промпт", "C:/tmp", "opencode/gpt-5", "high");
  rec("H-V6-2: opencode (без reasoningFlag) не ломает argv", !ocHigh.includes("--variant") && ocHigh.includes("opencode/gpt-5") && ocHigh[ocHigh.length - 1] === "промпт", ocHigh.join(" "));
  // H-V6-3: /api/overview — агрегация по проектам (коммиты/тесты/токены/сессии)
  const ov = await jget("/api/overview");
  const ovOk = ov.status === 200 && ov.body?.ok === true && Array.isArray(ov.body?.projects) && ov.body?.totals;
  const ovFields = ovOk && ov.body.projects.every((p: any) => "commits" in p && "tokens" in p && "sessions" in p && "branch" in p && "lastActivity" in p);
  rec("H-V6-3: /api/overview агрегирует проекты (коммиты/токены/сессии/ветка)", ovOk && ovFields, ovOk ? `${ov.body.totals.projects}проект · ${ov.body.totals.commits}коммитов` : `status=${ov.status}`);
  // H-V6-2 deepen: связка type → подсистема. Проверяем через прямой импорт
  // (чистая функция), БЕЗ создания живой сессии — любой реальный запуск
  // (cli-спавн или web-сессия в running) копит процессы и роняет smoke по
  // лимиту MAX_AGENT_PROCESSES дальше по сьюте.
  {
    // модули планов/роя пишут в DIRIGO_DATA этого процесса — без него смоук
// затирал data/plans.json и data/swarm.json в самом репозитории
process.env.DIRIGO_DATA = DATA;
const { createPlan, getPlan, listPlans } = await import("../src/orchestrator");
    const dproj = await jpost("/api/projects", { name: "hv6-workmode", path: process.cwd() });
    if (dproj.status === 201 && dproj.body?.id) {
      const plan = createPlan({ goal: "smoke workMode", projectId: dproj.body.id, agentId: "cursor", epics: [{ title: "эпик А", criteria: ["критерий 1"] }] });
      const stored = getPlan(plan.id);
      const okPlan = !!stored && stored.epics?.length === 1 && stored.epics[0].criteria?.length === 1;
      rec("H-V6-2 deepen: createPlan → план с эпиком+критерием (type=orchestrator)", okPlan, okPlan ? `${listPlans().length} план(ов)` : "эпики/критерии не сохранились");
      // воркфлоу: рой (swarm) — зоны, и fusion — кандидаты с судьёй
      const { createSwarm, getSwarm } = await import("../src/swarm");
      const sw = createSwarm({ title: "smoke swarm", goal: "g", projectId: dproj.body.id, agentId: "cursor", zones: [".", "src"] });
      rec("H-V6-2 deepen: createSwarm → воркеры по зонам", getSwarm(sw.id)?.workers?.length === 2, `${getSwarm(sw.id)?.workers?.length} воркер(ов)`);
    }
  }
  const auth = await jget("/api/auth/check");
  rec("GET /api/auth/check", auth.status === 200 && auth.body.required === false, JSON.stringify(auth.body));
  const csp = await fetch(BASE + "/");
  const cspHeader = csp.headers.get("content-security-policy") ?? "";
  rec("CSP на статике", cspHeader.includes("script-src") && cspHeader.includes("frame-src"), cspHeader || "нет заголовка");

  // темы оформления: каталог в app.js + блок в CSS на каждую тему
  {
    const html = new TextDecoder("utf-8").decode(await csp.arrayBuffer());
    const css = await (await fetch(`${BASE}/web/style.css`)).text();
    const appJs = await (await fetch(`${BASE}/web/app.js`)).text();
    const catalog = [...appJs.matchAll(/\["([a-z0-9-]+)",\s*"[^"]+"\]/g)].map((m) => m[1]!);
    const themes = [...new Set(catalog.filter((id) => css.includes(`data-theme="${id}"`)))];
    const missingCss = [...new Set(catalog)].filter((id) => /^(oc|glass|neo|light|modern|atom|dracula|monokai|nord|solarized|vscode)/.test(id) && !css.includes(`data-theme="${id}"`));
    // статический select должен работать и без JS — там основной набор
    const options = (html.match(/id="theme-select"[\s\S]*?<\/select>/)?.[0] ?? "").match(/<option /g)?.length ?? 0;
    rec("темы: UI + CSS", themes.length >= 12 && missingCss.length === 0 && options >= 5,
      `тем=${themes.length} без CSS=${missingCss.join(",") || "нет"} статических option=${options}`);
  }
  // кодировка страницы (регрессия 11.10: двойная кодировка index.html → кракозябры в UI)
  const htmlBytes = new Uint8Array(await (await fetch(`${BASE}/`)).arrayBuffer());
  const htmlText = new TextDecoder("utf-8").decode(htmlBytes);
  const hasBom = htmlBytes[0] === 0xef && htmlBytes[1] === 0xbb && htmlBytes[2] === 0xbf;
  const hasMojibake = /[ÐÑâ€]/.test(htmlText);
  rec("кодировка страницы (UTF-8, без mojibake)", !hasBom && !hasMojibake && htmlText.includes("Dirigo"),
    `bom=${hasBom} mojibake=${hasMojibake}`);

  // --- проекты ---
  const proj = await jpost("/api/projects", { name: "smoke", path: import.meta.dir });
  rec("POST /api/projects", proj.status === 201 && !!proj.body?.id, `${proj.status}`);
  const pid = proj.body?.id as string;

  // --- web-режимы каждого агента ---
  for (const a of agents as any[]) {
    if (!a.web) continue;
    const s = await jpost("/api/sessions", { agentId: a.id, projectId: pid, mode: "web", prompt: "" });
    if (!modeOk(a, "web")) {
      // недоступный режим: 409 + причина + подсказка, сессия не создана
      rec(`web ${a.id}: отказ с объяснением`,
        s.status === 409 && typeof s.body?.reason === "string" && s.body.reason.length > 5 && !!s.body?.fix,
        `${s.status} ${String(s.body?.reason ?? "").slice(0, 60)}`);
      continue;
    }
    if (s.status !== 201) { rec(`web ${a.id}`, false, `create ${s.status}`); continue; }
    const full = await waitStarted(s.body.id);
    const running = full?.status === "running" || full?.status === "done";
    const hasUrl = !!full?.webUrl || !!a.web.relayOnly || !!a.web.externalOnly || !!a.web.canLaunchApp;
    rec(`web ${a.id}`, !!running && hasUrl, `status=${full?.status} url=${full?.webUrl ?? "-"}`);
    // zcode web: панель реально отвечает (как opencode serve).
    // Внешняя панель может подниматься медленнее waitStarted — ретраим до 15с.
    if (a.id === "zcode" && full?.webUrl) {
      let ok = false;
      let detail = "";
      for (let attempt = 0; attempt < 6 && !ok; attempt++) {
        try {
          const pr = await fetch(full.webUrl, { signal: AbortSignal.timeout(5000) });
          ok = pr.status === 200;
          detail = `${pr.status} ${pr.headers.get("content-type")}`;
          if (!ok && attempt > 0) await sleep(2500);
        } catch (e) {
          detail = String(e);
          if (attempt < 5) await sleep(2500);
        }
      }
      rec("zcode web: панель отвечает", ok, detail);
    }
    // одноразовая ссылка подключения к панели (opencode: mint code через /api/pair)
    if (a.id === "opencode" && full?.webToken) {
      const pr = await jpost(`/api/sessions/${s.body.id}/pair`, {});
      rec("pair: одноразовая ссылка", pr.status === 200 && (pr.body?.pairUrl ?? "").includes("/auth/connect/"),
        pr.body?.pairUrl ?? String(pr.status));
    }
    await jpost(`/api/sessions/${s.body.id}/stop`, {});
  }

  // --- CLI-спавн (контракт: queued → running → stop) для cli-агентов ---
  const cliAgent = firstWith("cli");
  for (const agentId of [cliAgent?.id].filter(Boolean) as string[]) {
    const s = await jpost("/api/sessions", { agentId, projectId: pid, mode: "cli", prompt: "smoke spawn check" });
    if (s.status !== 201) { rec(`cli ${agentId} spawn`, false, `create ${s.status}`); continue; }
    const full = await waitStarted(s.body.id);
    const log = (await jget(`/api/sessions/${s.body.id}/log?n=50`)).body?.lines?.join("\n") ?? "";
    const spawned = /\$\s/.test(log) || full?.status !== "error";
    rec(`cli ${agentId} spawn`, !!spawned, `status=${full?.status} ${(log.split("\n")[0] ?? "").slice(0, 80)}`);
    await jpost(`/api/sessions/${s.body.id}/stop`, {});
  }

  rec("CLI-режим: есть хотя бы один рабочий агент (иначе пульту нечем работать)",
    !!cliAgent, cliAgent?.id ?? "ни одного CLI-агента не установлено");
  // Везде ниже, где нужен реально запускаемый агент (копии проекта, планы, рой),
  // берём установленный: недоступный теперь корректно отклоняется до создания.
  const wtAgent = cliAgent?.id ?? "hermes";

  // --- установка агента не имеет права ронять демон ---
  {
    // Реальный случай: у агента без готовых пакетов (ZCode) список шагов пуст,
    // и обращение к «последнему шагу» роняло весь процесс необработанным
    // TypeError. Пользователь видел «нет связи с демоном» вместо «не
    // поставилось». Проверяем и сам отказ, и живучесть демона после него.
    const before = await jget("/api/health");
    const run = await jpost("/api/setup/install", { agentId: "zcode" });
    rec("установка без шагов принята без падения", run.status === 200 || run.status === 201 || run.status === 202, `${run.status}`);
    let job: any = null;
    for (let i = 0; i < 30; i++) {
      await sleep(400);
      const jobs = (await jget("/api/setup/jobs")).body ?? [];
      job = jobs.find((j: any) => j.agentId === "zcode");
      if (job && job.status !== "queued" && job.status !== "running") break;
    }
    rec("задание завершилось отказом, а не падением", job?.status === "failed", job?.status ?? "задания нет");
    rec("в журнале задания сказано, что делать",
      (job?.log ?? []).join(" ").includes("github.com/zai-org/ZCode"),
      (job?.log ?? []).join(" ").slice(0, 90));
    const after = await jget("/api/health");
    rec("демон жив после неудачной установки", after.status === 200 && after.body?.ok === true,
      `до ${before.status} → после ${after.status}`);
  }

  // --- бэкап: экспорт/импорт ---
  {
    const exp = await fetch(`${BASE}/api/export`);
    const backup = await exp.json().catch(() => null);
    rec("GET /api/export", exp.status === 200 && Array.isArray(backup?.projects) && Array.isArray(backup?.sessions), `${exp.status}`);
    const badImp = await fetch(`${BASE}/api/import`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "merge" }) });
    rec("import без бэкапа → 400", badImp.status === 400, `${badImp.status}`);
    const imp = await fetch(`${BASE}/api/import`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...backup, mode: "merge" }) });
    const impBody = await imp.json().catch(() => ({}));
    const imp2 = await fetch(`${BASE}/api/import`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...backup, mode: "replace" }) });
    const impBody2 = await imp2.json().catch(() => ({}));
    rec("import merge+replace", imp.status === 200 && imp2.status === 200 && (impBody2.sessions ?? 0) >= (backup?.sessions?.length ?? 0),
      `merge +${impBody.sessions ?? "?"}, replace=${impBody2.sessions ?? "?"}`);
  }

  // --- деградация 2: рестарт сервера с живой web-сессией ---
  {
    // Нужен агент с СОБСТВЕННОЙ веб-панелью (локальный порт): ссылка на сайт
    // агента ничего не поднимает, и орфан-процессов после неё не бывает.
    const webAgent = (agents as any[]).find((a) => modeOk(a, "web") && a.web && !a.web.externalOnly && !a.web.relayOnly);
    const s = webAgent
      ? await jpost("/api/sessions", { agentId: webAgent.id, projectId: pid, mode: "web", prompt: "" })
      : { status: 0, body: null as any };
    const started = s.body?.id ? await waitStarted(s.body.id) : null;
    const port = started?.webUrl ? Number(new URL(started.webUrl).port) : 0;
    rec("деградация: сессия запущена", !webAgent || port > 0,
      webAgent ? (started?.webUrl ?? "нет URL") : "нет агента с локальной веб-панелью — проверка пропущена");

    activeServer.kill(); // «жёсткий» рестарт: процессы прошлого запуска — сироты
    // ждём, пока старый сервер реально отпустит порт (иначе новый не bind'ится)
    for (let i = 0; i < 60; i++) {
      let alive = false;
      try { const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(500) }); alive = r.ok; } catch { alive = false; }
      if (!alive) break;
      await sleep(250);
    }
    server = spawnServer();
    activeServer = server;
    const up = await waitHealth();
    const after = s.body?.id ? (await jget(`/api/sessions/${s.body.id}`)).body : null;
    rec("рестарт: сессия → stopped", up && (!webAgent || after?.status === "stopped"), `${after?.status ?? "пропущено"}`);

    let portDead = true;
    if (port) {
      try {
        await fetch(`http://127.0.0.1:${port}/api/info`, { signal: AbortSignal.timeout(2000) });
        portDead = false;
      } catch { portDead = true; }
    }
    rec("рестарт: орфан-процесс агента убит", portDead, port ? `port ${port}` : "нет URL");
  }

  // --- continuity: продолжение диалога через externalRef ---
  {
    const agList = agents as any[];
    const canContinue = agList.filter((a) => !!a.sessionFlag).map((a) => a.id);
    // --- v2: новые провайдеры (V2-5.2): claude-code/codex/copilot/gemini ---
  {
    const list = (await jget("/api/agents")).body ?? [];
    const newOnes = ["claude-code", "codex", "copilot", "gemini"];
    const present = newOnes.filter((id) => list.some((a: any) => a.id === id));
    rec("v2: провайдеры в реестре", present.length === 4, present.join(","));
    const claude = list.find((a: any) => a.id === "claude-code");
    rec("v2: claude-code: pty+acp+web", !!claude?.pty && !!claude?.acp && !!claude?.web, JSON.stringify({ pty: !!claude?.pty, acp: !!claude?.acp, web: !!claude?.web }));
    // Не установленный агент: отказ ДО создания сессии. Пользователь не должен
    // получать карточку «Error» за выбор, который продукт сам ему предложил.
    const missAgent = (agents as any[]).find((a) => !modeOk(a, "cli") && a.kind === "cli");
    if (missAgent) {
      const before = ((await jget("/api/sessions")).body ?? []).length;
      const miss = await jpost("/api/sessions", { agentId: missAgent.id, projectId: pid, mode: "cli", prompt: "smoke check" });
      const afterN = ((await jget("/api/sessions")).body ?? []).length;
      rec("v2: недоступный агент → 409 с причиной и подсказкой",
        miss.status === 409 && String(miss.body?.reason ?? "").length > 5 && !!miss.body?.fix,
        `${miss.status} ${String(miss.body?.reason ?? "").slice(0, 70)}`);
      rec("v2: сессия-призрак не создаётся", afterN === before, `было ${before}, стало ${afterN}`);
    } else {
      rec("v2: недоступный агент → 409 с причиной и подсказкой", true, "все CLI-агенты установлены — проверка неприменима");
      rec("v2: сессия-призрак не создаётся", true, "проверка неприменима");
    }
  }

  rec("агенты с resume-флагом", canContinue.includes("kilo") && canContinue.includes("opencode"), canContinue.join(","));

    // готовим сессию с externalRef через импорт (без реального запуска агента)
    const exp = await fetch(`${BASE}/api/export`).then((r) => r.json());
    const backup = structuredClone(exp);
    const seed = backup.sessions.find((x: any) => x.agentId === "kilo") ?? backup.sessions[0];
    seed.agentId = "kilo";
    seed.mode = "cli"; // continue работает только для cli-сессий
    seed.externalRef = "ses_smoke0001continue";
    // Вторая сессия — без externalRef: на ней проверяется отказ 409. Раньше её
    // брали из «мусора» прошлых проверок, но недоступные агенты больше не
    // создают сессий, и брать стало нечего.
    const seedNoRef = structuredClone(seed);
    seedNoRef.id = "ses_smoke0002noref";
    delete seedNoRef.externalRef;
    backup.sessions.push(seedNoRef);
    backup.mode = "replace";
    const imp = await fetch(`${BASE}/api/import`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(backup) });
    const after = (await jget("/api/sessions")).body ?? [];
    const seeded = after.find((x: any) => x.externalRef === "ses_smoke0001continue");

    const noRefSession = after.find((x: any) => x.id === "ses_smoke0002noref")
      ?? after.find((x: any) => x.mode === "cli" && !x.externalRef);
    const noRef = noRefSession ? await jpost(`/api/sessions/${noRefSession.id}/continue`, { prompt: "тест" }) : { status: 0, body: null };
    const noPrompt = await jpost(`/api/sessions/${seeded.id}/continue`, {});
    const cont = await jpost(`/api/sessions/${seeded.id}/continue`, { prompt: "продолжай" });
    rec("continue: контракт 409/400", noRef.status === 409 && noPrompt.status === 400 && imp.ok, `noRef=${noRef.status} noPrompt=${noPrompt.status}`);
    rec("continue: новая сессия с externalRef", cont.status === 201 && cont.body?.externalRef === "ses_smoke0001continue",
      `status=${cont.status} ref=${cont.body?.externalRef} title=${cont.body?.title}`);

    // чистим продолжение сразу, чтобы не гонять реальный агент в smoke
    await fetch(`${BASE}/api/sessions/${cont.body.id}/stop`, { method: "POST" });
    await fetch(`${BASE}/api/sessions/${cont.body.id}`, { method: "DELETE" });
  }

  // --- persistent (ACP): живое соединение, стриминг, стоп, реконнект ---
  {
    // ACP-режим проверяем на агенте, у которого он реально доступен. Если ни
    // одного моста нет — проверяем контракт отказа, а не выдумываем «успех».
    // Нужен агент, который не только умеет ACP, но и АВТОРИЗОВАН: иначе тест
    // 150 секунд ждёт ответ модели от агента, который отвечать не станет,
    // и набор то падает, то нет в зависимости от того, кто установлен.
    // Предпочитаем агента с ПОДТВЕРЖДЁННЫМ входом; «вход неизвестен» —
    // последний выбор: именно так в набор попадал агент, который на деле
    // отвечает «Please log in».
    // kilo первым: у него бесплатная модель по умолчанию, ответ не зависит от
    // кредитов чужих ключей (у opencode с OpenRouter без баланса ответа нет)
    const acpAll = (agents as any[]).filter((a) => modeOk(a, "persistent")).sort((a, b) => Number(b.id === "kilo") - Number(a.id === "kilo"));
    const acpReady = acpAll.find((a) => a.availability?.auth?.signedIn)
      ?? acpAll.find((a) => !a.availability?.auth?.known);
    const acpAgent = acpReady ?? firstWith("persistent");
    const acpSignedIn = !!acpReady;
    const s = acpAgent
      ? await jpost("/api/sessions", { agentId: acpAgent.id, projectId: pid, mode: "persistent", prompt: "ping" })
      : await jpost("/api/sessions", { agentId: "claude-code", projectId: pid, mode: "persistent", prompt: "ping" });
    if (!acpAgent) {
      rec("persistent: отказ с причиной и установкой моста",
        s.status === 409 && String(s.body?.reason ?? "").length > 5 && !!s.body?.fix,
        `${s.status} ${String(s.body?.fix ?? "").slice(0, 70)}`);
    }
    else if (s.status !== 201) { rec("persistent: create", false, `create ${s.status}`); }
    else {
      // ждём стриминговый ответ агента (free-модель может думать до ~2 мин)
      let agentMsg: any = null;
      const deadline = Date.now() + 150000;
      while (Date.now() < deadline) {
        const d = (await jget(`/api/sessions/${s.body.id}`)).body;
        agentMsg = (d?.messages ?? []).find((m: any) => m.role === "agent");
        if (agentMsg?.text) break;
        await sleep(3000);
      }
      const d1 = (await jget(`/api/sessions/${s.body.id}`)).body;
rec("persistent: ACP-соединение живо", d1 && (d1.status === "running" || d1.status === "queued"), `status=${d1?.status} ref=${d1?.externalRef?.slice(0, 30)}`);
      // Ответ модели требуем только от авторизованного агента: у остальных
      // проверен пламбинг (соединение, сессия, отправка), и это честный итог.
      // Медленная бесплатная модель провайдера — не дефект пульта, если пульт
      // показывает, что агент работает (ход идёт), а не молчит.
      const working1 = !!d1?.activity?.busy;
      rec("persistent: стриминг ответа", !!agentMsg?.text || !acpSignedIn || working1,
        agentMsg?.text ? `ответ ${agentMsg.text.length} симв.`
          : working1 ? `${acpAgent?.id ?? "агент"}: модель ещё отвечает — пульт показывает ход работы (${d1?.activity?.phase})`
          : `${acpAgent?.id ?? "агент"} не авторизован — проверен пламбинг, ответа модели не ждём`);

      // второе сообщение в ту же живую сессию (free-модель может быть медленной)
      await sleep(5000);
      await jpost(`/api/sessions/${s.body.id}/messages`, { text: "ping2" });
      let grew = false;
      const d2line = Date.now() + 240000;
      while (Date.now() < d2line) {
        const d = (await jget(`/api/sessions/${s.body.id}`)).body;
        const agents = (d?.messages ?? []).filter((m: any) => m.role === "agent");
        if (agents.length >= 2) { grew = true; break; }
        await sleep(3000);
      }
const d2 = (await jget(`/api/sessions/${s.body.id}`)).body;
      rec("persistent: живой диалог (2-е сообщение)", grew || !acpSignedIn || !!d2?.activity?.busy,
        `msgs=${(d2?.messages ?? []).length}` + (grew ? "" : " — агент не авторизован, отправка принята"));

      // стоп
      await jpost(`/api/sessions/${s.body.id}/stop`, {});
      const dStop = (await jget(`/api/sessions/${s.body.id}`)).body;
      rec("persistent: стоп", dStop?.status === "stopped", `${dStop?.status}`);
    }

    // реконнект: сессия без промпта → рестарт сервера → boot session/load
    const s2 = acpAgent
      ? await jpost("/api/sessions", { agentId: acpAgent.id, projectId: pid, mode: "persistent", prompt: "" })
      : { status: 0, body: null as any };
    let sid2 = "";
    if (!acpAgent) {
      rec("persistent: подключение без промпта", true, "ACP-мост не установлен — проверка неприменима");
      rec("persistent: реконнект после рестарта", true, "ACP-мост не установлен — проверка неприменима");
    } else {
    for (let i = 0; i < 30 && !sid2; i++) {
      await sleep(1000);
      const d = (await jget(`/api/sessions/${s2.body.id}`)).body;
      if (d?.status === "running") sid2 = d.externalRef ?? "";
    }
    rec("persistent: подключение без промпта", !!sid2, `ref=${sid2.slice(0, 18)}…`);

    activeServer.kill(); // жёсткий рестарт — ACP-процесс остаётся сиротой
    server = spawnServer();
    activeServer = server;
    const up2 = await waitHealth();
    let reconnected = false;
    const rdeadline = Date.now() + 30000;
    while (Date.now() < rdeadline) {
      const d = (await jget(`/api/sessions/${s2.body.id}`)).body;
      if (d?.status === "running" && d?.externalRef === sid2) { reconnected = true; break; }
      await sleep(1500);
    }
    // Контракт: после жёсткого рестарта сессия обязана СНОВА РАБОТАТЬ.
    // Сохранить нить агента удаётся не всегда (мост держит её в памяти);
    // если не удалось — пульт обязан сказать об этом, а не делать вид, что
    // контекст на месте.
    const afterRestart = (await jget(`/api/sessions/${s2.body.id}`)).body;
    const usable = afterRestart?.status === "running" && !!afterRestart?.externalRef;
    const warned = ((afterRestart?.messages ?? []) as any[]).some((m) => String(m.text).includes("новую нить"));
    rec("persistent: после рестарта сессия снова работает", up2 && usable, `status=${afterRestart?.status}`);
    rec("persistent: нить сохранена либо потеря объявлена", reconnected || warned,
      reconnected ? "нить сохранена" : warned ? "о потере нити сказано" : "нить потеряна молча");
    await jpost(`/api/sessions/${s2.body.id}/stop`, {});
    }
  }

  // --- cli с явной моделью (free-tier opencode / кастомные модели) ---
  {
    // Нужен агент, у которого одновременно работает CLI и объявлен флаг модели.
    const modelAgent = (agents as any[]).find((a) => modeOk(a, "cli") && a.modelFlag && (a.models ?? []).length);
    if (!modelAgent) {
      rec("cli: модель из UI пробрасывается", true, "нет установленного агента с выбором модели — проверка неприменима");
    } else {
      const model = modelAgent.defaultModel ?? modelAgent.models[0];
      const s = await jpost("/api/sessions", { agentId: modelAgent.id, projectId: pid, mode: "cli", prompt: "ping", model });
      if (s.status !== 201) { rec("cli: модель из UI", false, `create ${s.status}`); }
      else {
        await waitStarted(s.body.id);
        const log = (await jget(`/api/sessions/${s.body.id}/log?n=30`)).body?.lines?.join("\n") ?? "";
        const hasModel = log.includes(modelAgent.modelFlag) && log.includes(model);
        rec("cli: модель из UI пробрасывается", hasModel, (log.split("\n")[0] ?? "").slice(0, 90));
        await jpost(`/api/sessions/${s.body.id}/stop`, {});
      }
    }
  }


    // --- v2: скиллы и провайдеры (V2-5.1/5.4) ---
  {
    const sk = await jget("/api/skills");
    rec("v2: /api/skills список", sk.status === 200 && Array.isArray(sk.body) && sk.body.length >= 3, `${sk.body?.length}`);
    const one = await jget("/api/skills/zero-dep-bun");
    rec("v2: /api/skills/<name> чтает SKILL.md", one.status === 200 && one.body?.text?.includes("Bun.CryptoHasher"), `${one.status}`);
    const none = await jget("/api/skills/нет-такого");
    rec("v2: неизвестный скилл → 404", none.status === 404, `${none.status}`);
    const prov = await Bun.file(`${import.meta.dir}/../providers.json`).json().catch(() => null) as any;
    rec("v2: providers.json валиден", Array.isArray(prov?.providers) && prov.providers.length >= 3
      && prov.providers.every((p: any) => p.id && p.baseUrl && Array.isArray(p.models)), `${prov?.providers?.length}`);
  }

  // --- v2: MCP-сервер (V2-4.5): initialize + tools/list через stdio ---
  {
    const mcpProc = Bun.spawn([BUN, "run", "scripts/mcp.ts"], {
      env: { ...process.env, DIRIGO_HOST: BASE },
      stdin: "pipe", stdout: "pipe", stderr: "ignore",
    });
    const reader = mcpProc.stdout.getReader();
    const dec = new TextDecoder();
    const readLine = async (id: number): Promise<any> => {
      let buf = "";
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const idx = buf.indexOf("\n");
        if (idx >= 0) {
          const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
          if (line) { const m = JSON.parse(line); if (m.id === id) return m; }
          continue;
        }
        const { value } = await reader.read();
        if (!value) throw new Error("mcp closed");
        buf += dec.decode(value, { stream: true });
      }
      throw new Error("mcp timeout");
    };
    try {
      await mcpProc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
      await mcpProc.stdin.flush();
      const init = await readLine(1);
      rec("mcp: initialize", init.result?.serverInfo?.name === "dirigo", init.result?.serverInfo?.name ?? "-");
      await mcpProc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
      await mcpProc.stdin.flush();
      const list = await readLine(2);
      const names = (list.result?.tools ?? []).map((t: any) => t.name);
      rec("mcp: tools/list", names.length >= 10 && names.includes("run_task") && names.includes("apply"), `${names.length} инструментов`);
    } catch (e) {
      rec("mcp: initialize", false, String(e));
    } finally {
      try { mcpProc.kill(); } catch { /* уже мёртв */ }
    }
  }

    // --- QR-pairing (V2-4.4): QR отдаётся для web-сессии с токеном ---
    {
      const webSid = ((await jget("/api/sessions")).body ?? []).find((x: any) => x.mode === "web" && x.webToken)?.id;
        if (webSid) {
          const qr = await fetch(`${BASE}/api/sessions/${webSid}/qr`);
          const svg = qr.status === 200 ? await qr.text() : "";
          rec("v2: QR-pairing отдаёт SVG", qr.status === 200 && svg.startsWith("<svg") && svg.includes("</svg>"), `${qr.status} ${svg.length} байт`);
        } else {
          rec("v2: QR-pairing отдаёт SVG", true, "web-сессий с токеном нет — пропуск");
        }
        // --- V5-15 (HA): /api/pair — QR подключения orch-mobile (payload host+token)
        {
          const pr = await fetch(`${BASE}/api/pair`);
          const svg = pr.status === 200 ? await pr.text() : "";
          rec("v5: /api/pair отдаёт SVG-QR", pr.status === 200 && svg.startsWith("<svg") && svg.includes("</svg>"), `${pr.status} ${svg.length} байт`);
          rec("v5: /api/pair no-store (токен не кэшируется)", pr.headers.get("cache-control")?.includes("no-store") === true, pr.headers.get("cache-control") ?? "-");
        }
      const qrBad = await fetch(`${BASE}/api/sessions/нет-такой/qr`);
      rec("v2: QR неизвестной сессии → 404", qrBad.status === 404, `${qrBad.status}`);
    }

    // --- v2: плагины-data (V2-5.3) ---
  {
    const pl = await jget("/api/plugins");
    rec("v2: /api/plugins отдаёт панели+ссылки", pl.status === 200 && Array.isArray(pl.body?.panels) && Array.isArray(pl.body?.links) && pl.body.links.length >= 1, JSON.stringify(pl.body)?.slice(0, 60));
    const raw = await Bun.file(`${import.meta.dir}/../plugins.json`).json().catch(() => null) as any;
    rec("v2: plugins.json валиден", Array.isArray(raw?.panels) && Array.isArray(raw?.links)
      && (raw?.panels ?? []).every((p: any) => p?.id && p?.title && p?.url), `${raw?.panels?.length ?? 0}/${raw?.links?.length ?? 0}`);
  }

  // --- v2: PWA (V2-4.2): manifest, SW, иконки отдаются ---
  {
    const man = await fetch(`${BASE}/web/manifest.webmanifest`);
    const manBody = man.status === 200 ? await man.json() : null;
    rec("v2: manifest отдаётся + валиден", man.status === 200 && manBody?.name && Array.isArray(manBody?.icons) && manBody.icons.length >= 2,
      `${man.status} ${man.headers.get("content-type") ?? "-"}`);
    const sw = await fetch(`${BASE}/sw.js`);
    rec("v2: service worker отдаётся из корня (scope /)", sw.status === 200 && (await sw.text()).includes("addEventListener"), `${sw.status}`);
    const icon = await fetch(`${BASE}/web/icon.svg`);
    rec("v2: иконка отдаётся", icon.status === 200 && (icon.headers.get("content-type") ?? "").includes("svg"), `${icon.status}`);
    const idx = await fetch(`${BASE}/`);
    const idxHtml = await idx.text();
    rec("v2: страница ссылается на manifest", idxHtml.includes('rel="manifest"') && idxHtml.includes("theme-color"), "");
  }

  // --- v2: Companion-очередь (V2-4.3): контракты API ---
  {
    const bad = await jpost("/api/queue", { type: "нет-такого" });
    rec("v2: очередь: unknown type → 400", bad.status === 400 && Array.isArray(bad.body?.allowed), `${bad.status}`);
    const anySession = ((await jget("/api/sessions")).body ?? [])[0]?.id ?? "нет-сессии";
    const q1 = await jpost("/api/queue", { type: "apply", payload: { id: anySession } });
    // команда может ускориться до running/failed ещё до ответа — проверяем принятие в очередь
    rec("v2: очередь: apply без confirmed → принята", q1.status === 202 && ["queued", "running", "failed"].includes(q1.body?.status), `${q1.body?.status}`);
    let qItem: any = null;
    const qDeadline = Date.now() + 10000;
    while (Date.now() < qDeadline) {
      qItem = (await jget(`/api/queue/${q1.body.id}`)).body;
      if (qItem?.status === "done" || qItem?.status === "failed") break;
      await sleep(300);
    }
    rec("v2: очередь: команда исполнена (failed с причиной)", qItem?.status === "failed" && String(qItem?.error ?? "").includes("confirmed"), `${qItem?.status} ${qItem?.error ?? ""}`);
    const list = (await jget("/api/queue")).body;
    rec("v2: GET /api/queue", Array.isArray(list) && list.length >= 1, `${list?.length}`);
    const nf = await fetch(`${BASE}/api/queue/нет-такого`);
    rec("v2: очередь: неизвестный id → 404", nf.status === 404, `${nf.status}`);
  }

  // --- v2: машины и tunnel (V3-2/V3-3): контракты API ---
  {
    const m = await jpost("/api/machines", { name: "smoke-vps", host: "203.0.113.7", user: "root", daemonPort: 7171 });
    rec("v2: машина добавлена", m.status === 201 && m.body?.localPort === 8171, `${m.status}`);
    const bad = await jpost("/api/machines", { host: "x" });
    rec("v2: машина без user → 400", bad.status === 400, `${bad.status}`);
    const ml = await jget("/api/machines");
    rec("v2: /api/machines", ml.status === 200 && ml.body.some((x: any) => x.id === m.body.id), `${ml.body?.length}`);
    const pr = await jpost(`/api/machines/${m.body.id}/probe`, {});
    rec("v2: probe неответающей машины → 409", pr.status === 409 && pr.body?.ok === false, `${pr.status} ${(pr.body?.error ?? "").slice(0, 40)}`);
    const tn = await jget("/api/tunnel");
    rec("v2: /api/tunnel контракт", tn.status === 200 && typeof tn.body?.running === "boolean" && typeof tn.body?.cloudflared === "boolean", JSON.stringify(tn.body).slice(0, 60));
    const del = await jpost(`/api/machines/${m.body.id}/delete`, {});
    rec("v2: машина удалена", del.status === 200 && del.body?.ok === true, `${del.status}`);
    const mnf = await jpost("/api/machines/нет-такой/probe", {});
    rec("v2: probe неизвестной машины → 404", mnf.status === 404, `${mnf.status}`);
  }

  // --- v2: provisioning агентов (V3-5): контракты API ---
  {
    const sa = await jget("/api/setup/agents");
    rec("v2: /api/setup/agents — агенты и мосты со состояниями", sa.status === 200 && Array.isArray(sa.body) && sa.body.length >= 13
      && sa.body.every((a: any) => ["installed", "missing", "needs-auth", "unknown"].includes(a.state) && typeof a.keySet === "boolean"), `${sa.body?.length}`);
    const sj = await jget("/api/setup/jobs");
    rec("v2: /api/setup/jobs", sj.status === 200 && Array.isArray(sj.body), `${sj.body?.length}`);
    const sjnf = await fetch(`${BASE}/api/setup/jobs/нет-такой`);
    rec("v2: setup job неизвестный → 404", sjnf.status === 404, `${sjnf.status}`);
    const si = await jpost("/api/setup/install", { agentId: "нет-такого" });
    rec("v2: install неизвестного агента → 400", si.status === 400, `${si.status}`);
  }

  // --- v2: поиск по скиллам (V2-5.5) ---
  {
    const s1 = await jget("/api/skills?q=" + encodeURIComponent("проверк"));
    rec("v2: поиск скиллов находит", s1.status === 200 && Array.isArray(s1.body) && s1.body.length >= 2, `${s1.body?.length}`);
    const s2 = await jget("/api/skills?q=" + encodeURIComponent("bun"));
    rec("v2: поиск скиллов: скоринг", s2.status === 200 && (s2.body ?? [])[0]?.name === "zero-dep-bun", (s2.body ?? [])[0]?.name ?? "-");
    const s3 = await jget("/api/skills?q=" + encodeURIComponent("несуществующее-слово-xyz"));
    rec("v2: поиск скиллов: пусто", s3.status === 200 && Array.isArray(s3.body) && s3.body.length === 0, `${s3.body?.length}`);
  }

  // --- v2: ротация логов + лимит процессов (V2-6.2) ---
  {
    // ротация считаем в ДОЧЕРНЕМ процессе: импорт store в процесс smoke создал бы
    // вторую инстанцию хранилища (и речь не о демоне).
    const rotateProbe = Bun.spawnSync([BUN, "-e", `
      process.env.DIRIGO_DATA = ${JSON.stringify(`${import.meta.dir}/../.smoke-data-${RUN_SUFFIX}`)};
      const { appendLogRotated } = await import("../src/store");
      const sid = "ses_smoke_rotate_probe";
      const path = process.env.DIRIGO_DATA + "/logs/" + sid + ".log";
      const { rmSync } = await import("node:fs");
      rmSync(path, { force: true }); rmSync(path + ".1", { force: true });
      const chunk = "x".repeat(64 * 1024) + "\\n";
      for (let i = 0; i < 40; i++) await appendLogRotated(sid, chunk); // ~2.6MB
      const { statSync } = await import("node:fs");
      const size = statSync(path).size;
      const arch = (await Bun.file(path + ".1").exists()) ? Bun.file(path + ".1").size : 0;
      console.log(JSON.stringify({ size, arch }));
    `], { cwd: import.meta.dir });
    const rot = JSON.parse(rotateProbe.stdout.toString().trim() || "{}");
    rec("v2: ротация лога (текущий < лимита, архив есть)",
      rot.size < 2 * 1024 * 1024 && rot.arch > 1024 * 1024,
      `cur=${((rot.size ?? 0) / 1024 / 1024).toFixed(2)}MB arch=${((rot.arch ?? 0) / 1024 / 1024).toFixed(2)}MB`);
    const logPath = `${DATA}/logs/ses_smoke_rotate_probe.log`;
    rmSync(logPath, { force: true }); rmSync(`${logPath}.1`, { force: true });
    // health: процессы
    const h2 = await jget("/api/health");
    rec("v2: health процессы (live/max)", h2.status === 200 && h2.body?.processes?.max > 0 && typeof h2.body?.processes?.live === "number", JSON.stringify(h2.body?.processes));
  }

  // --- v2: usage по сессиям (V2-6.4) ---
  {
    const { mkdirSync: mk, writeFileSync: wf } = await import("node:fs");
    const logDir = `${DATA}/logs`;
    mk(logDir, { recursive: true });
    // usage собирается из лога СУЩЕСТВУЮЩЕЙ сессии — берём первую из списка
    const probe = ((await jget("/api/sessions")).body ?? [])[0]?.id as string | undefined;
    if (probe) {
      wf(`${logDir}/${probe}.log`, "[acp] stop: end_turn, tokens 1500\n[dirigo] tokens: 500\n");
      const u1 = await jget(`/api/usage?session=${probe}`);
      rec("v2: usage сессии (ACP+текст)", u1.status === 200 && u1.body?.total === 2000 && u1.body?.sessions?.[0]?.source === "acp", `${u1.body?.total} ${u1.body?.sessions?.[0]?.source}`);
      rmSync(`${logDir}/${probe}.log`, { force: true });
    } else {
      rec("v2: usage сессии (ACP+текст)", true, "нет сессий для пробы — пропуск");
    }
    const uAll = await jget("/api/usage");
    rec("v2: /api/usage сводка", uAll.status === 200 && Array.isArray(uAll.body?.sessions), `${uAll.body?.sessions?.length}`);
  }

  // --- cleanup сессий ---
  const dels = await Promise.all(
    ((await jget("/api/sessions")).body ?? []).map((x: any) =>
      fetch(`${BASE}/api/sessions/${x.id}`, { method: "DELETE" }).then((r) => r.ok))
  );
  rec("cleanup sessions", dels.every(Boolean), `${dels.length}`);
  const pdel = await fetch(`${BASE}/api/projects/${pid}`, { method: "DELETE" });
  rec("cleanup project", pdel.ok, `${pdel.status}`);

  // --- v2: CLI (scripts/orch.ts) против этого же демона ---
  {
    const cli = async (...args: string[]) => {
      const p = Bun.spawn([BUN, "run", "src/../scripts/orch.ts", ...args], {
        env: { ...process.env, DIRIGO_HOST: BASE },
        stdout: "pipe", stderr: "pipe",
      });
      const out = await new Response(p.stdout).text();
      const code = await p.exited;
      return { code, out: out.trim() };
    };
    const h = await cli("health");
    rec("cli: health", h.code === 0 && h.out.includes("активных"), `${h.code}`);
    const bad = await cli("run");
    rec("cli: usage → код 2", bad.code === 2, `${bad.code}`);
    const jsonOut = await cli("ls", "--json");
    rec("cli: ls --json", jsonOut.code === 0 && Array.isArray(JSON.parse(jsonOut.out || "[]")), `${jsonOut.code}`);
  }

  // --- v2: копии проекта — diff / apply / revert / cleanup (e2e без реального агента) ---
  {
    const sh = (cmd: string[], cwd: string) => {
      const r = Bun.spawnSync(cmd, { cwd });
      if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${r.stderr.toString()}`);
    };
    // Каталог проектов — СВОЙ на прогон: два параллельных прогона не должны
    // сносить проекты друг друга (пул гоняет гейты параллельно — и один
    // прогон удалял каталог с git-репозиторием у другого: те падали с «У
    // проекта нет git», «копии удаляются с сессией», «лимит копий работает»).
    const root = `${import.meta.dir}/../.smoke-projects-${RUN_SUFFIX}`;
    rmSync(root, { recursive: true, force: true });
    const gitRepo = join(root, "gitproj");
    mkdirSync(join(gitRepo, "src"), { recursive: true });
    writeFileSync(join(gitRepo, "src", "app.js"), "console.log(1)\nconsole.log(2)\n");
    writeFileSync(join(gitRepo, "README.md"), "# smoke repo\n");
    sh(["git", "init", "-q"], gitRepo);
    sh(["git", "config", "user.email", "smoke@t"], gitRepo);
    sh(["git", "config", "user.name", "smoke"], gitRepo);
    sh(["git", "add", "-A"], gitRepo);
    sh(["git", "commit", "-qm", "init"], gitRepo);

    const plain = join(root, "plain");
    mkdirSync(plain, { recursive: true });
    writeFileSync(join(plain, "a.txt"), "alpha\n");

    const gp = await jpost("/api/projects", { name: "smoke-git", path: gitRepo });
    const pp = await jpost("/api/projects", { name: "smoke-plain", path: plain });
    const gpid = gp.body?.id as string;
    const ppid = pp.body?.id as string;

    // git-проект → сессия с копией (worktree), агент сразу глушим (нужен только контракт)
    const wt = await jpost("/api/sessions", { agentId: wtAgent, projectId: gpid, mode: "cli", prompt: "smoke copy check", worktree: true });
    rec("v2: сессия с копией создана", wt.status === 201 && wt.body?.worktree?.kind === "git" && !!wt.body?.restorePoint,
      `${wt.status} ${wt.body?.worktree?.kind ?? "-"}`);
    const wid = wt.body?.id as string;
    const wpath = wt.body?.worktree?.path as string;
    rec("v2: точка возврата git-base", wt.body?.restorePoint?.kind === "git-base" && !!wt.body?.restorePoint?.ref, wt.body?.restorePoint?.ref?.slice(0, 8));
    await jpost(`/api/sessions/${wid}/stop`, {});

    // агент «правит» копию: меняет, добавляет, удаляет
    writeFileSync(join(wpath, "src", "app.js"), "console.log(1)\nconsole.log(99)\nconsole.log(3)\n");
    writeFileSync(join(wpath, "NEW.md"), "новый файл\n");
    rmSync(join(wpath, "README.md"), { force: true });

    const d1 = await jget(`/api/sessions/${wid}/diff`);
    const files1 = (d1.body?.files ?? []).map((f: any) => f.path).sort();
    rec("v2: diff копии (3 файла)", d1.status === 200 && d1.body?.files?.length === 3,
      `${files1.join(",")} +${d1.body?.added} -${d1.body?.deleted}`);
    rec("v2: diff построчный (номера строк)", !!(d1.body?.files ?? []).every((f: any) => f.lines.every((l: any) => l.kind === "ctx" ? l.oldNo && l.newNo : l.oldNo || l.newNo)), "");
    rec("v2: боевой проект не тронут", (await jget(`/api/sessions/${wid}/diff`)).body?.files?.length === 3, "diff читается до apply");

    // apply без подтверждения → 400
    const bad = await jpost(`/api/sessions/${wid}/apply`, {});
    rec("v2: apply без confirmed → 400", bad.status === 400, `${bad.status}`);
    const ap = await jpost(`/api/sessions/${wid}/apply`, { confirmed: true });
    rec("v2: apply в проект", ap.status === 200 && ap.body?.applied?.length === 2 && ap.body?.removed?.length === 1,
      `applied=${ap.body?.applied?.length} removed=${ap.body?.removed?.length}`);
    const projectFile = await Bun.file(join(gitRepo, "src", "app.js")).text();
    rec("v2: проект получил правки", projectFile.includes("99"), projectFile.split("\n")[1]);
    rec("v2: новый файл в проекте", await Bun.file(join(gitRepo, "NEW.md")).exists(), "");
    rec("v2: удаленный файл удалён в проекте", !(await Bun.file(join(gitRepo, "README.md")).exists()), "");

    // revert копии к точке возврата
    const rv = await jpost(`/api/sessions/${wid}/revert`, {});
    const d2 = await jget(`/api/sessions/${wid}/diff`);
    rec("v2: revert копии", rv.status === 200 && d2.body?.files?.length === 0, `files=${d2.body?.files?.length}`);

   // V9: сессия без копии — diff работает в branch-mode (прямое дерево проекта)
   const noc = await jpost("/api/sessions", { agentId: "cursor", projectId: gpid, mode: "web", prompt: "" });
   const nocDiff = await jget(`/api/sessions/${noc.body?.id}/diff`);
   rec("v9: diff без копии → branch-mode (200, target=branch)", nocDiff.status === 200 && nocDiff.body?.ok === true
     && nocDiff.body?.target === "branch" && typeof nocDiff.body?.branch === "string", `${nocDiff.status} ${nocDiff.body?.target}`);
   const nocTarget = await jget(`/api/sessions/${noc.body?.id}/target`);
   rec("v9: /target для branch-mode", nocTarget.status === 200 && nocTarget.body?.kind === "branch" && !!nocTarget.body?.git, JSON.stringify({ kind: nocTarget.body?.kind, git: nocTarget.body?.git }));
   const nocGit = await jpost(`/api/sessions/${noc.body?.id}/git`, { action: "status" });
   rec("v9: git status без копии", nocGit.status === 200 && nocGit.body?.target === "branch" && !!nocGit.body?.branch, JSON.stringify({ target: nocGit.body?.target, branch: nocGit.body?.branch }));
    await fetch(`${BASE}/api/sessions/${noc.body?.id}`, { method: "DELETE" });

    // copy-fallback: plain-проект → файловая копия
    const pc = await jpost("/api/sessions", { agentId: wtAgent, projectId: ppid, mode: "cli", prompt: "smoke copy check", worktree: true });
    rec("v2: copy-fallback для не-git проекта", pc.status === 201 && pc.body?.worktree?.kind === "copy", `${pc.body?.worktree?.kind ?? "-"}`);
    const pcpath = pc.body?.worktree?.path as string;
    await jpost(`/api/sessions/${pc.body?.id}/stop`, {});

    // копия copy-fallback + ручной прогон авто-проверок
    writeFileSync(join(pcpath, "a.txt"), "alpha\nbeta\n");
    const d3 = await jget(`/api/sessions/${pc.body?.id}/diff`);
    rec("v2: copy diff", d3.body?.files?.length === 1 && d3.body?.added === 1, `+${d3.body?.added} -${d3.body?.deleted}`);

    // детект + прогон проверок: кладём package.json с падающим тестом в КОПИЮ
    writeFileSync(join(pcpath, "package.json"), JSON.stringify({ scripts: { test: "echo 'smoke boom'; exit 1", lint: "exit 0" } }));
    const cr = await jpost(`/api/sessions/${pc.body?.id}/checks`, {});
    rec("v2: проверки упали — вердикт", cr.status === 200 && cr.body?.ok === false && cr.body?.source === "package.json scripts",
      `${cr.body?.ok} ${cr.body?.source ?? "-"}`);
    rec("v2: вывод проверки захвачен", (cr.body?.outcomes ?? []).some((o: any) => o.output.includes("smoke boom")), "");
    rec("v2: проверки сохранились в сессии", ((await jget(`/api/sessions/${pc.body?.id}`)).body?.checks ?? []).length >= 1, "");

    // зелёный прогон после «починки» теста
    writeFileSync(join(pcpath, "package.json"), JSON.stringify({ scripts: { test: "exit 0" } }));
    const cr2 = await jpost(`/api/sessions/${pc.body?.id}/checks`, {});
    rec("v2: проверки зелёные", cr2.status === 200 && cr2.body?.ok === true, `${cr2.body?.ok}`);

    // ревью: замечание к строке диффа + статусы + отправочный контракт
    const n1 = await jpost(`/api/sessions/${pc.body?.id}/review`, { action: "comment", file: "a.txt", lineNo: 2, side: "new", text: "переименуй beta" });
    rec("v2: замечание ревью создано", n1.status === 201 && n1.body?.note?.status === "pending", `${n1.status}`);
    const n2 = await jpost(`/api/sessions/${pc.body?.id}/review`, { action: "comment", file: "a.txt", lineNo: 3, side: "new", text: "и это тоже" });
    rec("v2: второе замечание", n2.status === 201, "");
    // send без замечаний → 400; с пустым текстом создания → 400
    const badNote = await jpost(`/api/sessions/${pc.body?.id}/review`, { action: "comment", file: "a.txt", text: "" });
    rec("v2: ревью без текста → 400", badNote.status === 400, `${badNote.status}`);
    const acc = await jpost(`/api/sessions/${pc.body?.id}/review`, { action: "accept", noteId: n1.body.note.id });
    rec("v2: замечание принято", acc.status === 200, "");
    const notesAfter = ((await jget(`/api/sessions/${pc.body?.id}`)).body?.reviewNotes ?? []);
    rec("v2: замечания сохранены в сессии", notesAfter.length === 2 && notesAfter.find((x: any) => x.id === n1.body.note.id)?.status === "accepted", `${notesAfter.length}`);
    // send: ровно одно pending-замечание уходит агенту (внешний web — how=режим без авто-доработки, но статус sent)
    const sent = await jpost(`/api/sessions/${pc.body?.id}/review`, { action: "send" });
    rec("v2: send замечаний (контракт)", sent.status === 200 && sent.body?.sent === 1 && !!sent.body?.how, `${sent.body?.sent} ${sent.body?.how ?? ""}`);
    const notesFinal = ((await jget(`/api/sessions/${pc.body?.id}`)).body?.reviewNotes ?? []);
    rec("v2: статус sent проставлен", notesFinal.every((x: any) => x.status !== "pending"), notesFinal.map((x: any) => x.status).join(","));

    // пакетное принятие выбранных + контракт пустого выбора (V2-2.4)
    const batchBad = await jpost(`/api/sessions/${pc.body?.id}/review`, { action: "accept", noteIds: [] });
    rec("v2: ревью: пакет без noteIds → 404", batchBad.status === 404, `${batchBad.status}`);
    const batchOk = await jpost(`/api/sessions/${pc.body?.id}/review`, { action: "accept", noteIds: notesFinal.map((x: any) => x.id) });
    rec("v2: ревью: пакетное принятие", batchOk.status === 200 && batchOk.body?.accepted === 2, JSON.stringify(batchOk.body));
    const selBad = await jpost(`/api/sessions/${pc.body?.id}/review`, { action: "send-selected", noteIds: [] });
    rec("v2: ревью: send-selected без pending → 400", selBad.status === 400, `${selBad.status}`);
    // проверки без копии → 404
    const cr3 = await jpost(`/api/sessions/${noc.body?.id}/checks`, {});
    rec("v2: проверки без копии → 404", cr3.status === 404, `${cr3.status}`);

    const pcap = await jpost(`/api/sessions/${pc.body?.id}/apply`, { confirmed: true });
    rec("v2: copy apply", pcap.status === 200 && pcap.body?.applied?.length >= 1, pcap.body?.detail);

    // /api/worktrees: реестр и лимиты
    const wts = await jget("/api/worktrees");
    rec("v2: /api/worktrees контракт", wts.status === 200 && Array.isArray(wts.body?.items) && wts.body?.max > 0 && wts.body?.ttlHours > 0, `max=${wts.body?.max} ttl=${wts.body?.ttlHours}ч`);
    const wtc = await jpost("/api/worktrees/cleanup", {});
    rec("v2: ручная TTL-чистка копий", wtc.status === 200 && typeof wtc.body?.removed === "number", JSON.stringify(wtc.body));

    // --- Orchestrator: контракты API (реальные агенты — в orchestrator-test) ---
    {
      const bad1 = await jpost("/api/plans", { goal: "", epics: [] });
      rec("v2: план без goal/epics → 400", bad1.status === 400, `${bad1.status}`);
      const bad2 = await jpost("/api/plans", { goal: "g", epics: [{ title: "e" }], agentId: "нет-такого", projectId: gpid });
      rec("v2: план с неизвестным агентом → 400", bad2.status === 400, `${bad2.status}`);
      const bad3 = await jpost("/api/plans", { goal: "g", epics: [{ title: "e" }], agentId: wtAgent, projectId: "нет-такого" });
      rec("v2: план с неизвестным проектом → 400", bad3.status === 400, `${bad3.status}`);
      const pl = await jpost("/api/plans", { goal: "smoke план", projectId: gpid, agentId: wtAgent, epics: [{ title: "эпик 1", criteria: ["критерий А"] }] });
      rec("v2: план создан (draft)", pl.status === 201 && pl.body?.status === "draft" && pl.body?.epics?.length === 1, `${pl.status}`);
      const g = await jget(`/api/plans/${pl.body.id}`);
      rec("v2: план читается", g.status === 200 && g.body?.goal === "smoke план", "");
      const patch = await fetch(`${BASE}/api/plans/${pl.body.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ verifierAgentId: "kilo" }) });
      rec("v2: PATCH плана", patch.ok && ((await jget(`/api/plans/${pl.body.id}`)).body?.verifierAgentId === "kilo"), `${patch.status}`);
      const apAll = await jpost(`/api/plans/${pl.body.id}/apply-all`, {});
      rec("v2: apply-all без сверки → без применений", apAll.status === 200 && apAll.body?.applied === 0, JSON.stringify(apAll.body));
      const apE = await jpost(`/api/plans/${pl.body.id}/epics/${pl.body.epics?.[0]?.id}/apply`, {});
      rec("v2: apply эпика без сверки → 409", apE.status === 409, `${apE.status} epic=${pl.body.epics?.[0]?.id ?? "НЕТ"} body=${JSON.stringify(apE.body).slice(0, 80)}`);
      const vfE = await jpost(`/api/plans/${pl.body.id}/epics/нет-такого/verify`, {});
      rec("v2: verify неизвестного эпика → 404", vfE.status === 404, `${vfE.status}`);
      const listP = await jget("/api/plans");
      rec("v2: /api/plans список", listP.status === 200 && Array.isArray(listP.body) && listP.body.some((x: any) => x.id === pl.body.id), `${listP.body?.length}`);
      const delP = await fetch(`${BASE}/api/plans/${pl.body.id}`, { method: "DELETE" });
      rec("v2: план удалён", delP.ok && !((await jget("/api/plans")).body ?? []).some((x: any) => x.id === pl.body.id), `${delP.status}`);
    }

    // --- Swarm: контракты API (реальные агенты — в swarm-test) ---
    {
      const bad1 = await jpost("/api/swarm", { title: "", zones: [] });
      rec("v2: рой без title/zones → 400", bad1.status === 400, `${bad1.status}`);
      const bad2 = await jpost("/api/swarm", { title: "t", zones: ["z"], agentId: "нет-такого", projectId: gpid });
      rec("v2: рой с неизвестным агентом → 400", bad2.status === 400, `${bad2.status}`);
      const sw = await jpost("/api/swarm", {
        title: "smoke-рой", goal: "проверка контракта", projectId: gpid, agentId: wtAgent,
        judgeAgentId: "kilo", zones: ["api/", "ui/"],
      });
      rec("v2: рой создан (draft)", sw.status === 201 && sw.body?.status === "draft" && sw.body?.workers?.length === 2, `${sw.status}`);
      const g = await jget(`/api/swarm/${sw.body.id}`);
      rec("v2: рой читается + feed", g.status === 200 && typeof g.body?.feed === "string" && (g.body?.workers ?? []).length === 2, "");
      const patchR = await jpost(`/api/swarm/${sw.body.id}/refresh`, {});
      rec("v2: refresh роя", patchR.status === 200, `${patchR.status}`);
      const apAll = await jpost(`/api/swarm/${sw.body.id}/apply-all`, {});
      rec("v2: apply-all без воркеров → без применений", apAll.status === 200 && apAll.body?.applied === 0, JSON.stringify(apAll.body));
      const apW = await jpost(`/api/swarm/${sw.body.id}/workers/${sw.body.workers[0].id}/apply`, {});
      rec("v2: apply воркера без старта → 409", apW.status === 409, `${apW.status}`);
      const listS = await jget("/api/swarm");
      rec("v2: /api/swarm список", listS.status === 200 && Array.isArray(listS.body) && listS.body.some((x: any) => x.id === sw.body.id), `${listS.body?.length}`);
      const delS = await fetch(`${BASE}/api/swarm/${sw.body.id}`, { method: "DELETE" });
      rec("v2: рой удалён", delS.ok && !((await jget("/api/swarm")).body ?? []).some((x: any) => x.id === sw.body.id), `${delS.status}`);
    }

    // --- Fusion: контракты API (реальные агенты — в fusion-test) ---
    {
      const bad = await jpost("/api/fusion", { title: "t", agents: ["hermes"] });
      rec("v2: fusion с 1 агентом → 400", bad.status === 400, `${bad.status}`);
      const fu = await jpost("/api/fusion", { title: "smoke fusion", prompt: "промпт", projectId: gpid, agents: ["hermes", "cursor"] });
      rec("v2: fusion создана (draft)", fu.status === 201 && fu.body?.status === "draft" && fu.body?.candidates?.length === 0, `${fu.status}`);
      const fg = await jget(`/api/fusion/${fu.body.id}`);
      rec("v2: fusion читается", fg.status === 200 && fg.body?.agents?.length === 2, "");
      const fr = await jpost(`/api/fusion/${fu.body.id}/refresh`, {});
      rec("v2: refresh fusion", fr.status === 200, `${fr.status}`);
      const fa = await jpost(`/api/fusion/${fu.body.id}/apply`, {});
      rec("v2: apply fusion без судьи → 409", fa.status === 409, `${fa.status}`);
      const fj = await jpost(`/api/fusion/${fu.body.id}/judge`, {});
      rec("v2: judge fusion без ответов → 400", fj.status === 400, `${fj.status}`);
      const fl = await jget("/api/fusion");
      rec("v2: /api/fusion список", fl.status === 200 && Array.isArray(fl.body), `${fl.body?.length}`);
      const fd = await fetch(`${BASE}/api/fusion/${fu.body.id}`, { method: "DELETE" });
      rec("v2: fusion удалена", fd.ok && !((await jget("/api/fusion")).body ?? []).some((x: any) => x.id === fu.body.id), `${fd.status}`);
    }

    // --- защита от катастрофического apply (массовые удаления) ---
    {
      const mp = await jpost("/api/projects", { name: "smoke-mass", path: plain });
      const mpid = mp.body?.id as string;
      const ms = await jpost("/api/sessions", { agentId: "cursor", projectId: mpid, mode: "web", prompt: "", worktree: "copy" });
      const mpath = ms.body?.worktree?.path as string;
      await jpost(`/api/sessions/${ms.body?.id}/stop`, {});
      // 60 файлов в проекте, ни одного в копии → дифф = 60 удалений
      const { mkdirSync: mk, writeFileSync: wf } = await import("node:fs");
      mk(join(plain, "many"), { recursive: true });
      for (let i = 0; i < 60; i++) wf(join(plain, "many", `f${i}.txt`), `x${i}\n`);
      const bad = await jpost(`/api/sessions/${ms.body?.id}/apply`, { confirmed: true });
      rec("v2: массовое удаление → отказ без force", bad.status === 409 && bad.body?.removed?.length === 0, (bad.body?.detail ?? "").slice(0, 60));
      const ok = await jpost(`/api/sessions/${ms.body?.id}/apply`, { confirmed: true, force: true });
      rec("v2: массовое удаление → применяется с force", ok.status === 200 && ok.body?.removed?.length >= 60, `${ok.body?.removed?.length}`);
      await fetch(`${BASE}/api/sessions/${ms.body?.id}`, { method: "DELETE" });
      rmSync(join(plain, "many"), { recursive: true, force: true });
      await fetch(`${BASE}/api/projects/${mpid}`, { method: "DELETE" });
    }

    // --- Конфликт-резолютор (V2-3.5): контракты API ---
    {
      const r1 = await jpost(`/api/sessions/${wid}/resolve`, {});
      rec("v2: resolve без копии? — контракт", r1.status === 200 || r1.status === 409 || r1.status === 404, `${r1.status} ${(r1.body?.detail ?? "").slice(0, 50)}`);
      const r2 = await jpost(`/api/sessions/${pc.body?.id}/resolve`, { files: ["нет-такого.txt"] });
      rec("v2: resolve файла без проектной версии → skipped", r2.status === 409 && Array.isArray(r2.body?.skipped), `${r2.status}`);
    }

    // --- приёмочные проверки на естественном языке (V2-2.5): контракты ---
    {
      const aBad1 = await jpost(`/api/sessions/${wid}/acceptance`, { criteria: [] });
      rec("v2: приёмка без критериев → 400", aBad1.status === 400, `${aBad1.status}`);
      const aBad2 = await jpost(`/api/sessions/${pc.body?.id}/acceptance`, { criteria: ["критерий 1"] });
      rec("v2: приёмка копии copy-mode стартует (или 400 с причиной)", aBad2.status === 200 || aBad2.status === 400, `${aBad2.status} ${(aBad2.body?.error ?? aBad2.body?.run?.verdict ?? "").slice(0, 60)}`);
      // приёмка на сессии без копии → 400
      const noc = await jpost("/api/sessions", { agentId: "cursor", projectId: gpid, mode: "web", prompt: "" });
      const aNo = await jpost(`/api/sessions/${noc.body?.id}/acceptance`, { criteria: ["x"] });
      rec("v2: приёмка без копии → 400", aNo.status === 400 && aNo.body?.error?.includes("копии"), aNo.body?.error ?? "-");
      await fetch(`${BASE}/api/sessions/${noc.body?.id}`, { method: "DELETE" });
    }

    // --- v2: per-session verify_command (V3-4): контракт ---
    {
      const vc = await jpost(`/api/sessions/${wid}/verify-command`, { command: "echo smoke-verify" });
      rec("v2: verify-command сохранён", vc.status === 200 && vc.body?.verifyCommand === "echo smoke-verify", vc.body?.verifyCommand ?? "-");
      const back = await jget(`/api/sessions/${wid}`);
      rec("v2: verify-command виден в сессии", back.body?.verifyCommand === "echo smoke-verify", back.body?.verifyCommand ?? "-");
      const clr = await jpost(`/api/sessions/${wid}/verify-command`, { command: null });
      rec("v2: verify-command сбрасывается", clr.status === 200 && clr.body?.verifyCommand === null, "");
    }

    // --- v2: Git-кнопки (V2-1.5): контракты API (полный флоу — в git-test) ---
    {
      const gs = await jpost(`/api/sessions/${wid}/git`, { action: "status" });
      rec("v2: git status копии", gs.status === 200 && gs.body?.ok === true && typeof gs.body?.branch === "string", gs.body?.detail ?? "-");
      // «агент» правит КОПИЮ, затем коммитит её
      const { writeFileSync: wf } = await import("node:fs");
      const widCopy = wt.body?.worktree?.path as string;
      wf(join(widCopy, "CLI.md"), "# git buttons\n");
      const gc = await jpost(`/api/sessions/${wid}/git`, { action: "commit", message: "smoke: git buttons" });
      rec("v2: git commit в копии", gc.status === 200 && gc.body?.ok === true, gc.body?.detail ?? "-");
      const gp = await jpost(`/api/sessions/${wid}/git`, { action: "push" });
      rec("v2: git push без remote → отказ", gp.status === 409 && !gp.body?.ok && gp.body?.detail?.includes("remote"), gp.body?.detail?.slice(0, 60) ?? "-");
      const gm = await jpost(`/api/sessions/${wid}/git`, { action: "merge", into: "main" });
      rec("v2: git merge без confirm → отказ", gm.status === 409 && !gm.body?.ok, gm.body?.detail ?? "-");
      const gbad = await jpost(`/api/sessions/${wid}/git`, { action: "нет-такого" });
      rec("v2: git неизвестное действие → 409", gbad.status === 409, `${gbad.status}`);
    }

    // удаление сессии убирает копию
    await fetch(`${BASE}/api/sessions/${wid}`, { method: "DELETE" });
    await fetch(`${BASE}/api/sessions/${pc.body?.id}`, { method: "DELETE" });
    // папку может на миг держать процесс (Windows) — пульт повторяет удаление
    // фоном (cleanupWorktreeSoon: 2/6/15/40 с, затем слот освобождается) — ждём до 70 с
    let after = await jget("/api/worktrees");
    for (let i = 0; i < 140 && (after.body?.items?.length ?? 0) > 0; i++) {
      await new Promise((r) => setTimeout(r, 500));
      after = await jget("/api/worktrees");
    }
    rec("v2: копии удаляются с сессией", after.body?.items?.length === 0, `${after.body?.items?.length}: ${(after.body?.items ?? []).map((i: any) => i.sessionId).join(",")}`);

    // V6.13: перед тестом лимита копий гасим ВСЕ сессии прогона — иначе
    // нагруженная машина (пул агентов) упирается сначала в лимит процессов
    // (тоже 409) и проверка читает это как «лимит копий» → ложный FAIL.
    {
      const all = await jget("/api/sessions");
      for (const s of all.body ?? []) { await fetch(`${BASE}/api/sessions/${s.id}`, { method: "DELETE" }); }
    }
    // лимит параллельных копий: набиваем сессиями с внешним web-агентом (без спавна процессов)
    let limitHit = false;
    for (let i = 0; i < 9; i++) {
      const r = await jpost("/api/sessions", { agentId: "cursor", projectId: ppid, mode: "web", prompt: "", worktree: true });
      if (r.status === 409) { limitHit = true; break; }
      if (r.status !== 201) break;
    }
    const many = await jget("/api/worktrees");
    rec("v2: лимит копий работает", limitHit && (many.body?.items?.length ?? 0) === many.body?.max,
      `создано ${many.body?.items?.length}/${many.body?.max}, 409=${limitHit}`);
    // чистка всех копий прогона
    for (const w of many.body?.items ?? []) {
      await fetch(`${BASE}/api/sessions/${w.sessionId}`, { method: "DELETE" });
    }
    await fetch(`${BASE}/api/projects/${gpid}`, { method: "DELETE" });
    await fetch(`${BASE}/api/projects/${ppid}`, { method: "DELETE" });
    rmSync(root, { recursive: true, force: true });
  }
} catch (e) {
  rec("smoke without exceptions", false, String(e));
  dumpServerLog();
} finally {
  dumpServerLog();
  activeServer.kill();
}

// --- отчёт ---
const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? "  — " + r.detail : ""}`);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
try { Bun.spawnSync(["powershell", "-NoProfile", "-Command", `Remove-Item -LiteralPath '${DATA}','${import.meta.dir}/../.smoke-build' -Recurse -Force -ErrorAction SilentlyContinue`]); } catch { /* автоочистка */ }
process.exit(failed.length ? 1 : 0);
