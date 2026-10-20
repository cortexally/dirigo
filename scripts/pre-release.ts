#!/usr/bin/env bun
// V9: pre-release валидация — единый гейт перед публикацией версии.
// Гоняет все сьюты + проверки артефактов бандла, фиксирует отчёт.
// Запуск: bun run scripts/pre-release.ts [--quick]
//
// Quick-mode: только критические проверки (smoke + install-security-review +
// verify-flows + бандл-bundle-check) — для горячих фиксов.

import { existsSync, mkdirSync, rmSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const QUICK = process.argv.includes("--quick");
const LIVE_SUITES = new Set(["verify-flows (реальные флоу)", "ui-audit", "e2e-diff"]);

interface Suite { name: string; cmd: string[]; critical: boolean; }
const SUITES: Suite[] = [
  { name: "smoke (API, агенты, копии, ревью)", cmd: ["run", "scripts/smoke.ts"], critical: true },
  { name: "verify-flows (реальные флоу)", cmd: ["run", "scripts/verify-flows.ts"], critical: true },
  { name: "install-security-review", cmd: ["run", "scripts/install-security-review.ts"], critical: true },
  { name: "worktrees", cmd: ["run", "scripts/worktree-test.ts"], critical: false },
  { name: "diff-race (diff по живой копии не падает)", cmd: ["run", "scripts/diff-race-test.ts"], critical: false },
  { name: "checks", cmd: ["run", "scripts/checks-test.ts"], critical: false },
  { name: "orchestrator", cmd: ["run", "scripts/orchestrator-test.ts"], critical: false },
  { name: "swarm", cmd: ["run", "scripts/swarm-test.ts"], critical: false },
  { name: "fusion", cmd: ["run", "scripts/fusion-test.ts"], critical: false },
  { name: "git buttons", cmd: ["run", "scripts/git-test.ts"], critical: false },
  { name: "resolver", cmd: ["run", "scripts/resolver-test.ts"], critical: false },
  { name: "экран терминала (PTY) и детект входа", cmd: ["run", "scripts/screen-test.ts"], critical: true },
  { name: "разбор ошибок агентов в подсказки", cmd: ["run", "scripts/diagnose-test.ts"], critical: true },
  { name: "лаунчеры run/stop", cmd: ["run", "scripts/launcher-test.ts"], critical: true },
  { name: "install-win (установщик Windows: ярлыки, запуск, остановка)", cmd: ["run", "scripts/install-win-e2e.ts"], critical: true },
  // Полный проход по всем агентам и всем режимам: доступный режим обязан
  // стартовать, недоступный — отказать с причиной. Именно здесь ловятся
  // «opencode не запускается» и «у kilo пропадают сообщения».
  { name: "матрица агент × режим (все агенты)", cmd: ["run", "scripts/agent-matrix.ts"], critical: true },
  { name: "setup/provisioning", cmd: ["run", "scripts/setup-test.ts"], critical: false },
  { name: "deploy", cmd: ["run", "scripts/deploy-test.ts"], critical: false },
  { name: "qr", cmd: ["run", "scripts/qr-test.ts"], critical: false },
  { name: "smoke-security", cmd: ["run", "scripts/smoke-security.ts"], critical: false },
  { name: "e2e-diff", cmd: ["run", "scripts/e2e-diff.ts"], critical: false },
  { name: "e2e-rightpanel (свернуть, рельс, кнопки, git проекта)", cmd: ["run", "scripts/e2e-rightpanel.ts"], critical: true },
  { name: "e2e-stability (экран не мигает: нет перерисовок без изменений)", cmd: ["run", "scripts/e2e-stability.ts"], critical: true },
  { name: "e2e-fps (плавность: blur не съедает кадры)", cmd: ["run", "scripts/e2e-fps.ts"], critical: true },
  { name: "e2e-board", cmd: ["run", "scripts/e2e-board.ts"], critical: false },
  { name: "monorepo-subdir (монорепо)", cmd: ["run", "scripts/monorepo-subdir-test.ts"], critical: true },
  // 1.9.1: проект без git → свой репо; копия/дифф/редактор/коммит согласованы
  { name: "git-policy (копия, дифф, редактор, коммит в репо проекта)", cmd: ["run", "scripts/git-policy-test.ts"], critical: true },
  { name: "ui-audit", cmd: ["run", "scripts/ui-audit.ts"], critical: false },
  { name: "e2e-i18n (английский интерфейс без русских строк)", cmd: ["run", "scripts/e2e-i18n.ts"], critical: true },
  // Терминал агента в браузере: xterm.js, поток PTY, ввод, вставка картинок,
  // размер окна, вкладки не выкидывают на главную, терминал оболочки.
  { name: "e2e-terminal (терминал агента)", cmd: ["run", "scripts/e2e-terminal.ts"], critical: true },
  { name: "e2e-xterm-race (снимок экрана и поток под нагрузкой)", cmd: ["run", "scripts/e2e-xterm-race.ts"], critical: true },
  // Контракты реестра и сборки команд: флаги TUI, уровни, модели, окружение редактора.
  { name: "registry (контракты агентов)", cmd: ["run", "scripts/registry-test.ts"], critical: true },
  // Уборка процессов, которые агенты оставляют после себя (хабы cline, сторожа freebuff).
  { name: "daemons (сироты агентов)", cmd: ["run", "scripts/daemons-test.ts"], critical: true },
  { name: "hide-windows (нет окон консоли у процессов демона и тестов)", cmd: ["run", "scripts/hide-windows-test.ts"], critical: true },
  { name: "cline-hub (хаб cline под пультом: без окон, без сирот, копию не держит)", cmd: ["run", "scripts/cline-hub-test.ts"], critical: true },
  { name: "test-cleanup (тесты не оставляют процессов: выход, жёсткое убийство, .kill() дерева)", cmd: ["run", "scripts/test-cleanup-test.ts"], critical: true },
  // 1.9.1: рабочая папка агента (cwd + PWD) = папка сессии во всех режимах
  { name: "agent-cwd (папка агента = копия: CLI, ACP, PTY)", cmd: ["run", "scripts/agent-cwd-test.ts"], critical: true },
  // Живой запуск каждого TUI той командой, что соберёт пульт, с моделью и уровнем.
  { name: "tui-flags (флаги TUI, живой запуск)", cmd: ["run", "scripts/tui-flags-test.ts"], critical: true },
  // Сценарии человека: сессии через диалог с настройками по умолчанию, задача
  // и нижнее поле доходят до каждого TUI, изоляция сессий, ход живого диалога.
  { name: "e2e-scenarios (сценарии пользователя)", cmd: ["run", "scripts/e2e-scenarios.ts"], critical: true },
  { name: "e2e-cli", cmd: ["run", "scripts/cli-e2e.ts"], critical: false },
  // Набор не должен сносить чужое состояние (живая сессия, чужой демон) —
  // иначе прогон пула уносит рабочие папки чужих агентов. Критично: защита
  // чужих правок важнее «красного» релиза — красный гейт виден, а снесённая
  // рабочая папка агента не восстанавливается.
  { name: "e2e-cli-isolation (набор не сносит чужое состояние)", cmd: ["run", "scripts/cli-e2e-isolation-test.ts"], critical: true },
  // Вызов node:fs/node:path/node:os без импорта: ошибка глохлась try/catch,
  // и защита молча выключалась (набор сносил чужую рабочую папку агента).
  { name: "imports-lint (node:* без импорта)", cmd: ["run", "scripts/imports-lint.ts"], critical: true },
  { name: "live-session (статус сессии не «готово», пока жив агент)", cmd: ["run", "scripts/live-session-test.ts"], critical: false },
  { name: "orch-json (машинный вывод CLI — один компактный JSON)", cmd: ["run", "scripts/orch-json-test.ts"], critical: false },
  { name: "e2e-mcp", cmd: ["run", "scripts/e2e-mcp.ts"], critical: false },
  { name: "e2e-sdk", cmd: ["run", "scripts/e2e-sdk.ts"], critical: false },
  { name: "e2e-queue", cmd: ["run", "scripts/e2e-queue.ts"], critical: false },
  { name: "acp-turn (ответы ACP не теряются после переподключения)", cmd: ["run", "scripts/acp-turn-test.ts"], critical: true },
  { name: "promo-fixes (заголовки, сироты-копии, claude -p, итог гейта)", cmd: ["run", "scripts/promo-fixes-test.ts"], critical: true },
  { name: "e2e-acp-reconnect (живой агент: переподключение без дублей и потерь)", cmd: ["run", "scripts/e2e-acp-reconnect.ts"], critical: true },
  // происхождение изменений — ядро позиционирования, потому critical
  { name: "provenance (журнал и подпись)", cmd: ["run", "scripts/provenance-test.ts"], critical: true },
  { name: "policy (шлюз персональных данных)", cmd: ["run", "scripts/policy-test.ts"], critical: true },
  { name: "pii-changes (PII в сообщениях и изменениях агента, целостность)", cmd: ["run", "scripts/pii-changes-test.ts"], critical: true },
  { name: "e2e-pii-flow (PII через UI: без копии, коммит, block, копия, свои слова)", cmd: ["run", "scripts/e2e-pii-flow.ts"], critical: true },
  { name: "knowledge (база знаний)", cmd: ["run", "scripts/knowledge-test.ts"], critical: false },
  { name: "agent-mcp (CoAlly в конфигах агентов: слияние, копия, удаление)", cmd: ["run", "scripts/agent-mcp-test.ts"], critical: true },
  { name: "coally-mcp (CoAlly по MCP: связь, запись, поиск, PII, экран настроек)", cmd: ["run", "scripts/coally-mcp-test.ts"], critical: true },
  { name: "e2e-evidence (сквозной путь доказательств)", cmd: ["run", "scripts/e2e-evidence.ts"], critical: true },
];

const results: { name: string; ok: boolean; ms: number; detail: string }[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Набор не может висеть вечно: по таймауту — дерево процессов набора убивается, набор FAIL.
const SUITE_TIMEOUT_MS = Number(process.env.DIRIGO_SUITE_TIMEOUT_MS ?? 20 * 60_000);
const GATE_STARTED = new Date();

function killTree(pid: number): void {
  try {
    if (process.platform === "win32") Bun.spawnSync(["taskkill", "/PID", String(pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore", timeout: 10_000, windowsHide: true });
    else process.kill(-pid, "SIGKILL");
  } catch { /* уже завершён */ }
}

/**
 * Сироты прогона (Windows): процессы, созданные после старта гейта, чей родитель уже
 * завершён, — демоны и агенты, которые набор не убрал. Раньше они переживали гейт
 * и продолжали запускать процессы. Живой демон пользователя (~/.dirigo) не трогаем.
 */
async function sweepGateOrphans(keep: number[]): Promise<number> {
  if (process.platform !== "win32") return 0;
  const since = GATE_STARTED.toISOString();
  const script = `$since=[datetime]::Parse('${since}').ToLocalTime(); $all=Get-CimInstance Win32_Process; $alive=@{}; foreach($p in $all){$alive[[int]$p.ProcessId]=1}; $all | Where-Object { $_.Name -match '^(bun|node|powershell|pwsh|cmd|git|bash)\.exe$' -and $_.CreationDate -ge $since -and -not $alive.ContainsKey([int]$_.ParentProcessId) -and $_.CommandLine -notmatch '\.dirigo' } | ForEach-Object { $_.ProcessId }`;
  const proc = Bun.spawn(["powershell", "-NoProfile", "-NonInteractive", "-Command", script], { stdout: "pipe", stderr: "ignore", stdin: "ignore", windowsHide: true });
  const timer = setTimeout(() => proc.kill(), 30_000);
  const out = await new Response(proc.stdout).text();
  clearTimeout(timer);
  const pids = out.split(/\s+/).map(Number).filter((n) => n > 0 && n !== process.pid && !keep.includes(n));
  for (const pid of pids) killTree(pid);
  return pids.length;
}

async function runSuite(s: Suite, livePort?: number): Promise<void> {
  const started = Date.now();
  const env = { ...process.env } as Record<string, string>;
  if (livePort && LIVE_SUITES.has(s.name)) env.DIRIGO_PORT = String(livePort);
  const proc = Bun.spawn([process.execPath, ...s.cmd], { cwd: ROOT, stdout: "pipe", stderr: "pipe", env });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; killTree(proc.pid); }, SUITE_TIMEOUT_MS);
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const exit = await proc.exited;
  clearTimeout(timer);
  const code = timedOut ? 124 : exit;
  const text = out + "\n" + err + (timedOut ? `\nТАЙМАУТ набора: ${SUITE_TIMEOUT_MS / 60_000} мин` : "");
  // Вывод упавшего набора сохраняем целиком: без него «116/117» ничего не
  // говорит, а воспроизвести живой прогон агентов стоит минут.
  if (code !== 0) {
    try {
      const dir = `${ROOT}/build`;
      mkdirSync(dir, { recursive: true });
      writeFileSync(`${dir}/fail-${s.name.replace(/[^\w]+/g, "-").slice(0, 40)}.log`, text);
    } catch { /* не критично */ }
  }
  const m = text.match(/(\d+)\s*\/\s*(\d+)\s*passed/);
  const detail = m ? `${m[1]}/${m[2]}` : code === 0 ? "ok" : text.trim().split("\n").slice(-2).join(" | ").slice(0, 120);
  // V6.13: полный вывод сьюта — в build/suite-<name>.log (диагностика падений)
  if (code !== 0) { try { await Bun.write(join(ROOT, "build", `suite-${s.name.replace(/[^\w.-]+/g, "_")}.log`), text); } catch { /* */ } }
  results.push({ name: s.name, ok: code === 0, ms: Date.now() - started, detail });
  const mark = code === 0 ? "✓" : "✗";
  console.log(`${mark} ${s.name.padEnd(38)} ${detail.padEnd(16)} ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

/** Поднять изолированный демон для «живых» сьютов на свободном порту. */
async function ensureLiveDaemon(): Promise<{ pid: number; port: number } | null> {
  // Берём свободный порт рядом с продовым (7171) — не мешаем живому демону
  const srv = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {}, open() {}, close() {}, error() {} } });
  const port = srv.port;
  srv.stop(true);
  const base = `http://127.0.0.1:${port}`;
  const data = join(ROOT, ".smoke-pre-data");
  rmSync(data, { recursive: true, force: true });
  mkdirSync(data, { recursive: true });
  const proc = Bun.spawn([process.execPath, "run", "src/server.ts"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), DIRIGO_DATA: data },
    stdout: "ignore",
    stderr: "ignore",
  });
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    try { if ((await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) })).ok) return { pid: proc.pid, port }; } catch { /* ещё поднимается */ }
  }
  proc.kill();
  return null;
}

// tar из MSYS не понимает абсолютные Windows-пути («C:» = удалённый хост) —
// всегда вызываем с cwd=ROOT и относительным путём. Иначе tar падает с
// «Cannot connect to C: resolve failed», а гейт видит пустой бандл.
function tarList(relPath: string): string[] {
  const r = Bun.spawnSync(["tar", "-tzf", relPath], { cwd: ROOT });
  if (r.exitCode !== 0) return [];
  return r.stdout.toString().split(/\r?\n/).map((f) => f.trim()).filter(Boolean);
}
function tarExtract(relPath: string, member: string): string {
  const r = Bun.spawnSync(["tar", "-xzOf", relPath, member], { cwd: ROOT });
  return r.stdout.toString();
}

async function checkBundle(): Promise<{ ok: boolean; detail: string }> {
  // V1: проверка релизного дерева (без бандла): сборка, отсутствие секретов,
  // pty-import на месте, версия 1.1, PWA-файлы отдаются.
  const problems: string[] = [];

  // 1. сервер собирается (все модули и импорты на месте)
  try {
    const out = Bun.spawnSync([process.execPath, "build", "src/server.ts", "--target=bun", "--outfile", join(ROOT, "build", ".release-check.js")], { cwd: ROOT });
    if (out.exitCode !== 0) problems.push("сборка падает: " + out.stderr.toString().slice(0, 120));
    else rmSync(join(ROOT, "build", ".release-check.js"), { force: true });
  } catch (e) { problems.push("сборка: " + String(e)); }

  // 2. нет секретов и служебного мусора в релизном дереве
  const walkFiles = (dir: string): string[] => {
    const out: string[] = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) out.push(...walkFiles(full));
      else out.push(full);
    }
    return out;
  };
  const tree = [...walkFiles(join(ROOT, "src")), ...walkFiles(join(ROOT, "web"))];
  const secrets = tree.filter((f) => /secrets\.json|data\/db\.json/.test(f));
  if (secrets.length) problems.push(`секреты/данные в дереве: ${secrets.slice(0, 2).join(", ")}`);

  // 3. pty.ts с secretsEnv (регрессия V8-5)
  const pty = await Bun.file(join(ROOT, "src", "agents", "pty.ts")).text();
  if (!pty.includes('import { secretsEnv }')) problems.push("pty.ts без secretsEnv — баг V8-5");

  // 4. версия релиза
  const srv = await Bun.file(join(ROOT, "src", "server.ts")).text();
  const ver = srv.match(/APP_VERSION = "([\d.]+)"/)?.[1];
  // Сверяем версию демона с собранным бандлом, а не с вшитым числом:
  // раньше здесь стояло «1.5» и гейт блокировал любой следующий релиз.
  if (!ver) problems.push("не найден APP_VERSION в src/server.ts");
  else if (!existsSync(join(ROOT, "build", "dist", `dirigo-${ver}.tar.gz`))) {
    problems.push(`бандл dirigo-${ver}.tar.gz не собран (bun run scripts/bundle-native.ts)`);
  }

  // 4b. версия UI синхронна версии демона
  const appJs = await Bun.file(join(ROOT, "web", "app.js")).text();
  const uiBuild = appJs.match(/UI_BUILD = "([\d.]+)"/)?.[1] ?? "";
  // та же нормализация, что в web/app.js (1.9 == 1.9.0); усечение до двух чисел
  // ломалось на версиях вида 1.9.1
  const norm = (v: string) => { const p = v.split(".").map((x) => Number(x) || 0); while (p.length < 3) p.push(0); return p.slice(0, 3).join("."); };
  if (ver && norm(uiBuild) !== norm(ver)) {
    problems.push(`UI_BUILD ${uiBuild} рассинхронен с APP_VERSION ${ver} — каждый первый заход будет перезагружать страницу`);
  }

  // 5. PWA-файлы клона на месте
  for (const f of ["web/index.html", "web/app.js", "web/style.css", "web/manifest.webmanifest", "web/sw.js", "web/icon.svg"]) {
    if (!existsSync(join(ROOT, f))) problems.push(`нет ${f}`);
  }

  // 6. функционал истории/файлов/редактора подключён
  for (const f of ["src/history.ts", "src/files.ts", "src/open-editor.ts"]) {
    if (!existsSync(join(ROOT, f))) problems.push(`нет ${f}`);
  }
  const index = await Bun.file(join(ROOT, "web", "index.html")).text();
  for (const id of ["sidebar", "session-tabs", "right-panel", "view-history", "view-stats", "cmdk"]) {
    if (!index.includes(`id="${id}"`)) problems.push(`index.html без #${id}`);
  }

  const ok = problems.length === 0;
  return { ok, detail: ok ? "дерево релиза: сборка ок, секретов нет, pty-import ок, PWA + VF-модули на месте" : problems.slice(0, 3).join("; ") };
}
async function main(): Promise<void> {
  console.log(`\n=== pre-release валидация (${QUICK ? "quick" : "full"}) ===\n`);
  const active = QUICK ? SUITES.filter((s) => s.critical) : SUITES;

  // Живые тесты (verify-flows/ui-audit/e2e-diff) дерутся с демоном — поднимаем свой.
  const needsLive = active.some((s) => LIVE_SUITES.has(s.name));
  let daemon: { pid: number; port: number } | null = null;
  if (needsLive) {
    daemon = await ensureLiveDaemon();
    if (daemon) console.log(`↗ демон для живых тестов: PID ${daemon.pid} :${daemon.port}\n`);
  }

  // V6.13: уникальные порты на прогон — сьюты пула не делят фиксированные 7292/7296
  const suffix = String(7300 + (Date.now() % 300)); // 7300..7599 — валидный диапазон, уникален на прогон
  process.env.E2E_DIFF_PORT = suffix;
  process.env.E2E_BOARD_PORT = String(Number(suffix) + 1);
  process.env.E2E_CLI_PORT = String(Number(suffix) + 2);
  let orphans = 0;
  for (const s of active) {
    await runSuite(s, daemon?.port);
    const n = await sweepGateOrphans(daemon ? [daemon.pid] : []);
    if (n) { orphans += n; console.log(`  ↳ убрано осиротевших процессов после набора: ${n}`); }
  }

  if (daemon) {
    killTree(daemon.pid);
    rmSync(join(ROOT, ".smoke-pre-data"), { recursive: true, force: true });
  }
  orphans += await sweepGateOrphans([]);
  if (orphans) console.log(`\nосиротевших процессов за прогон: ${orphans} (убраны)`);

  const bundle = await checkBundle();
  results.push({ name: "bundle artifacts", ok: bundle.ok, ms: 0, detail: bundle.detail });
  console.log(`${bundle.ok ? "✓" : "✗"} bundle artifacts`.padEnd(48) + bundle.detail);

  const failed = results.filter((r) => !r.ok);
  // только записи вида «прошло/всего»: у «bundle artifacts» текстовое описание,
  // и Number("дерево…") давал «~NaN проверок» — число уходило в маркетинг
  const counted = results.map((r) => /^(\d+)\/(\d+)$/.exec(r.detail)).filter((m): m is RegExpExecArray => !!m);
  const passed = counted.reduce((a, m) => a + Number(m[1]), 0);
  const total = counted.reduce((a, m) => a + Number(m[2]), 0);
  const suites = results.length;
  const report = [
    `# pre-release report (${new Date().toISOString()})`,
    "",
    ...results.map((r) => `- ${r.ok ? "OK" : "FAIL"} ${r.name} — ${r.detail}`),
    "",
    failed.length ? `**ИТОГ: ${failed.length} сьют(ов) упали — релиз ЗАБЛОКИРОВАН**` : `**ИТОГ: все зелёные — ${suites} наборов, ${passed} из ${total} проверок — релиз разрешён**`,
  ].join("\n");
  await Bun.write(join(ROOT, "build", "pre-release-report.md"), report);

  console.log(`\n${failed.length === 0 ? `✓ РЕЛИЗ РАЗРЕШЁН — ${suites} наборов, ${passed} из ${total} проверок` : `✗ РЕЛИЗ ЗАБЛОКИРОВАН (${failed.length})`}`);
  for (const f of failed) console.log(`  FAIL: ${f.name} — ${f.detail}`);
  console.log(`отчёт: build/pre-release-report.md`);
  process.exit(failed.length ? 1 : 0);
}

await main();
