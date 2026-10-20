#!/usr/bin/env bun
// UI-аудит пульта: структура, живые клики, лента сессии,
// панель «Изменения», дерево файлов, История, Статистика, ⌘K, темы.
// Запуск: bun run ui-audit (или DIRIGO_PORT=xxxx). Свой демон — свой порт.
import { chromium } from "playwright";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

// Без явного DIRIGO_PORT — свободный порт и свой демон. Раньше по умолчанию
// бралось 7171: если там работал боевой Dirigo, тест гонялся на реальных
// данных пользователя (создавал проекты и сессии в его списке).
const PORT = process.env.DIRIGO_PORT ? Number(process.env.DIRIGO_PORT) : (() => {
  const srv = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {}, open() {}, close() {}, error() {} } });
  const p = srv.port; srv.stop(true); return p;
})();
const BASE = `http://127.0.0.1:${PORT}`;

// Раньше аудит молча требовал уже запущенный демон на 7171 и на чистой машине
// падал с ERR_CONNECTION_REFUSED. Теперь: если никого нет — поднимаем свой,
// с изолированным хранилищем, и гасим в конце.
const BUN = process.execPath;
const OWN_DATA = join(process.cwd(), `.ui-audit-data-${Date.now().toString(36)}`);
let ownServer: ReturnType<typeof Bun.spawn> | null = null;

async function daemonAlive(): Promise<boolean> {
  try { return (await fetch(`${BASE}/api/health`)).ok; } catch { return false; }
}

if (!(await daemonAlive())) {
  console.log(`[ui-audit] демона на ${PORT} нет — поднимаю свой (данные: ${OWN_DATA})`);
  mkdirSync(OWN_DATA, { recursive: true });
  ownServer = Bun.spawn([BUN, "run", "src/server.ts"], {
    env: { ...process.env, PORT: String(PORT), DIRIGO_DATA: OWN_DATA },
    stdout: "ignore", stderr: "ignore",
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && !(await daemonAlive())) await Bun.sleep(300);
  if (!(await daemonAlive())) { console.error("[ui-audit] демон не поднялся"); process.exit(1); }
}

function stopOwnServer(): void {
  if (!ownServer) return;
  try {
    if (process.platform === "win32") Bun.spawnSync(["taskkill", "/PID", String(ownServer.pid), "/T", "/F"]);
    else process.kill(ownServer.pid, "SIGKILL");
  } catch { /* уже мёртв */ }
  try { rmSync(OWN_DATA, { recursive: true, force: true }); } catch { /* занято — переживём */ }
  ownServer = null;
}
process.on("exit", stopOwnServer);

const browser = await chromium.launch();
const page = await browser.newPage();
const jsErrors: string[] = [];
page.on("pageerror", (e) => jsErrors.push(String(e.stack ?? e)));
page.on("console", (m) => { if (m.type() === "error" && !/frame-ancestors|favicon|serviceWorker|icon-maskable/i.test(m.text())) jsErrors.push(m.text().slice(0, 160)); });
const httpErr: string[] = [];
page.on("response", (r) => {
  if (r.status() >= 400 && !/favicon|icon/.test(r.url())) httpErr.push(`${r.status()} ${r.request().method()} ${r.url().replace(/^https?:\/\/[^/]+/, "").slice(0, 90)}`);
  if (r.status() === 404 && !/favicon|icon/.test(r.url())) jsErrors.push("404 " + r.url().slice(0, 90));
});

await page.goto(BASE, { waitUntil: "commit" });
await page.waitForSelector("header.topbar, .oc-side", { timeout: 20000 });

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? "  — " + detail : ""}`);
  ok ? pass++ : fail++;
};
/** Открыть сессию в UI: таб, вид «Разговор», вкладка «Изменения». */
const openAuditSession = async (page: import("playwright").Page, id: string) => {
  await page.evaluate((sid) => {
    document.querySelector(`.oc-session[data-ses="${sid}"]`)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  }, id);
  await page.click("#rtab-changes");
  await page.waitForSelector("#rp-branch .oc-chip", { timeout: 10000 }).catch(async () => {
    const t = (await page.textContent("#toasts")) ?? "";
    const chip = (await page.textContent("#rp-branch")) ?? "";
    const panel = await page.evaluate(() => document.getElementById("right-panel")?.className ?? "нет");
    const tabCount = await page.locator(".oc-tab").count();
    throw new Error(`chip not visible. panel="${panel}" tabs=${tabCount} chip="${chip}" toasts: ${t.slice(0, 150)}`);
  });
};

// ── каркас клона ──
const shell = await page.evaluate(() => ({
  side: !!document.getElementById("sidebar"),
  brand: document.querySelector(".oc-brand__name")?.textContent ?? "",
  navs: [...document.querySelectorAll(".oc-side__nav .oc-navitem, .oc-side__foot .oc-navitem")].map((el) => el.textContent.trim()),
  tabs: !!document.getElementById("session-tabs"),
  right: !!document.getElementById("right-panel"),
  hero: !!document.getElementById("view-empty"),
  composer: !!document.getElementById("composer"),
  cmdk: !!document.getElementById("cmdk"),
}));
console.log("SHELL:", JSON.stringify(shell));
check("каркас: sidebar/табы/правая панель/composer", shell.side && shell.tabs && shell.right && shell.composer);
check("бренд: Dirigo", shell.brand === "Dirigo", shell.brand);
check("навигация: все 8 пунктов", shell.navs.join(",") === "Обзор,Создать,Разговор,Доска,Доказательства,История,Статистика,Настройки", shell.navs.join(","));
check("пустой вид-герой на старте", shell.hero);

// ── ⌘K ──
await page.keyboard.press("Control+k");
await page.waitForSelector("#cmdk:not(.hidden)", { timeout: 3000 });
const cmdkItems = await page.locator("#cmdk-list .oc-cmdk__item").count();
check("⌘K: палитра открывается с командами", cmdkItems >= 5, `${cmdkItems}`);
await page.keyboard.press("Escape");
check("⌘K: закрывается по Escape", await page.evaluate(() => document.getElementById("cmdk").classList.contains("hidden")));

// ── своя git-копия проекта ──
const gitRoot = join(import.meta.dir, "../.ui-audit-git");
rmSync(gitRoot, { recursive: true, force: true });
mkdirSync(gitRoot, { recursive: true });
execSync("git init -b main .", { cwd: gitRoot });
writeFileSync(join(gitRoot, "a.txt"), "one\n");
mkdirSync(join(gitRoot, "src"), { recursive: true });
writeFileSync(join(gitRoot, "src", "app.ts"), "export const a = 1;\n");
execSync("git add -A && git -c user.email=a@b -c user.name=t commit -m init", { cwd: gitRoot });

const reg = await page.evaluate(async (path: string) => {
  const r = await (await fetch("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "ui-audit", path }) })).json();
  return r.id as string;
}, gitRoot);
check("проект зарегистрирован", !!reg, reg);

// ── создание сессии через UI: читаемый список агентов + запуск ──
await page.keyboard.press("Control+k");
await page.fill("#cmdk-input", "Новая сессия");
await page.click("#cmdk-list .oc-cmdk__item >> nth=0");
await page.waitForSelector("#new-session-modal", { timeout: 4000 });
const agentBtns = await page.locator("[data-ns-agent]").count();
const firstName = await page.locator("[data-ns-agent] .oc-ns__agent-name").first().textContent();
check("создание: список агентов читаем (13 с именами)", agentBtns >= 12 && (firstName ?? "").trim().length > 2, `${agentBtns}, первым «${firstName}»`);
const agentHint = (await page.textContent("#ns-agent-hint")) ?? "";
check("создание: подсказка выбранного агента", agentHint.trim().length > 3, agentHint.slice(0, 60));

// ── слой доступности: UI не предлагает того, что не запустится ──
const avail = await page.evaluate(async () => {
  const r = await fetch("/api/agents"); const list = await r.json();
  return list.map((a: any) => ({ id: a.id, usable: !!a.usable, modes: a.availability?.modes ?? [] }));
});
check("доступность: API отдаёт режимы по каждому агенту",
  avail.length > 0 && avail.every((a: any) => a.modes.length === 4),
  `агентов ${avail.length}`);
check("доступность: у каждого недоступного режима есть причина",
  avail.every((a: any) => a.modes.every((m: any) => m.available || (m.reason ?? "").length > 5)),
  "причина заполнена везде");
// первым в списке должен стоять работоспособный агент (если такой есть)
const firstUsable = await page.evaluate(() => {
  const el = document.querySelector("[data-ns-agent]") as HTMLElement | null;
  return el ? { id: el.dataset.nsAgent, off: el.classList.contains("oc-ns__agent--off") } : null;
});
check("создание: первым предложен работающий агент",
  !avail.some((a: any) => a.usable) || (firstUsable && !firstUsable.off),
  JSON.stringify(firstUsable));
// в селекте режимов недоступные помечены disabled, а не предлагаются молча
const modeOpts = await page.evaluate(() => {
  const sel = document.getElementById("ns-mode") as HTMLSelectElement | null;
  return [...(sel?.options ?? [])].map((o) => ({ v: o.value, dis: o.disabled, t: o.textContent ?? "" }));
});
check("создание: недоступные режимы нельзя выбрать",
  modeOpts.length > 0 && modeOpts.every((o) => !o.dis || /недоступен/.test(o.t)),
  modeOpts.map((o) => `${o.v}${o.dis ? "✗" : "✓"}`).join(" "));
await page.selectOption("#ns-project", reg);
// CLI требует текст задачи — флоу проверки ошибки и happy path
await page.click("#ns-go");
const errText = ((await page.textContent("#ns-err")) ?? "").trim();
check("создание: без задачи — внятная ошибка (не зависает)",
  errText.includes("Опишите задачу") || errText.includes("недоступ") || errText.includes("нет доступных"),
  errText.slice(0, 80));
await page.fill("#ns-prompt", "проверка ui-аудита: создай readme");
await page.click("#ns-go");
await page.waitForSelector("#view-chat:not(.hidden)", { timeout: 15000 });
const tabCount = await page.locator(".oc-tab").count();
check("сессия: таб открылся, лента видна", tabCount >= 1, `${tabCount}`);

// ── терминальная сессия: экран рисуется, а не поток ESC-кодов ──
{
  const ptyAgent = await page.evaluate(async () => {
    const r = await fetch("/api/agents"); const list = await r.json();
    return list.find((a: any) => (a.availability?.modes ?? []).some((m: any) => m.mode === "pty" && m.available))?.id ?? null;
  });
  if (!ptyAgent) {
    check("терминал сессии: экран рисуется", true, "режим PTY недоступен на этой машине — проверка неприменима");
  } else {
    const sid = await page.evaluate(async ([agentId, projectId]) => {
      const r = await fetch("/api/sessions", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId, projectId, mode: "pty", worktree: false }) });
      return r.ok ? (await r.json()).id : null;
    }, [ptyAgent, reg]);
    if (!sid) check("терминал сессии: экран рисуется", false, "сессия не создалась");
    else {
      await page.reload({ waitUntil: "commit" });
      await page.waitForSelector(`[data-ses="${sid}"]`, { timeout: 15000 });
      await page.click(`[data-ses="${sid}"]`);
      // экран рисует xterm.js (настоящий эмулятор) из потока PTY
      await page.waitForSelector("#pty-term .xterm-screen", { timeout: 10000 });
      await page.waitForTimeout(4000);
      const term = await page.evaluate(() => {
        const rows = [...document.querySelectorAll("#pty-term .xterm-rows > div")] as HTMLElement[];
        return { lines: rows.length, text: rows.map((r) => r.innerText).join("\n") };
      });
      check("терминал сессии: экран нарисован сеткой", term.lines >= 10, `${term.lines} строк`);
      check("терминал сессии: без сырых ESC-кодов", !/\x1b|\[\?1049h|\[0m/.test(term.text), term.text.slice(0, 60).replace(/\s+/g, " "));
      // клавиатура уходит в агента
      await page.click("#pty-term");
      await page.keyboard.press("Enter");
      await page.waitForTimeout(2500);
      const after = await page.evaluate(() => (document.querySelector("#pty-term .xterm-rows") as HTMLElement | null)?.innerText ?? "");
      check("терминал сессии: ввод принимается", after.trim().length > 0);
      // модель агента и единственное понятное место для ввода
      const bar = await page.evaluate(() => ({
        model: document.getElementById("pty-model")?.textContent ?? "",
        hint: document.querySelector(".oc-termbar__spacer")?.textContent ?? "",
        placeholder: (document.getElementById("prompt") as HTMLTextAreaElement | null)?.placeholder ?? "",
      }));
      check("терминал: подпись поля ввода объясняет, куда писать",
        /терминал|terminal/i.test(bar.placeholder), bar.placeholder);
      check("терминал: сказано, что оба поля — один терминал",
        bar.hint.length > 10, bar.hint.slice(0, 60));
      // английский интерфейс не должен показывать полупереведённые фразы
      await page.evaluate(() => {
        const sel = document.querySelector("#lang-select, [data-lang]") as HTMLSelectElement | null;
        if (sel) { sel.value = "en"; sel.dispatchEvent(new Event("change", { bubbles: true })); }
      });
      await page.waitForTimeout(800);
      // Проверяем СВОИ подписи: в них не должно остаться русских слов рядом с
      // английскими — так выглядел «Agent ждёт входа» и «в terminale».
      // Данные пользователя (заголовки сессий, вывод агента) не трогаем.
      const mixed = await page.evaluate(() => {
        const sel = ".oc-termbar__spacer, .oc-authbar__why, .oc-authbar__fix, .oc-ns__hint, .oc-fail__fix, #pty-hint";
        const bad: string[] = [];
        for (const el of document.querySelectorAll(sel)) {
          const t = (el.textContent ?? "").trim();
          if (t.length > 6 && /[А-Яа-яЁё]/.test(t) && /[A-Za-z]{3}/.test(t)) bad.push(t.slice(0, 60));
        }
        const ph = (document.getElementById("prompt") as HTMLTextAreaElement | null)?.placeholder ?? "";
        if (/[А-Яа-яЁё]/.test(ph) && /[A-Za-z]{3}/.test(ph)) bad.push("placeholder: " + ph);
        return bad.slice(0, 4);
      });
      check("английский интерфейс: нет полупереведённых подписей", mixed.length === 0, mixed.join(" | "));
      await page.evaluate(() => {
        const sel = document.querySelector("#lang-select, [data-lang]") as HTMLSelectElement | null;
        if (sel) { sel.value = "ru"; sel.dispatchEvent(new Event("change", { bubbles: true })); }
      });
      await page.evaluate((id) => fetch(`/api/sessions/${id}/stop`, { method: "POST" }), sid);
    }
  }
}

// ── лента: цель, шаги, composer ──
// Возвращаемся к CLI-сессии с задачей: у пустого терминала карточки «Цель» нет
// намеренно (заголовок там — имя режима, а не задача).
{
  const cliId = await page.evaluate(async () => ((await (await fetch("/api/sessions")).json()) as any[]).find((x) => x.mode === "cli")?.id ?? "");
  if (cliId) await page.click(`[data-ses="${cliId}"]`).catch(() => {});
}
await page.waitForTimeout(1200);
const feed = await page.evaluate(() => ({
  goal: !!document.querySelector("#feed .oc-card--goal"),
  composerAgent: (document.getElementById("composer-agent")?.textContent ?? "").trim(),
}));
check("лента: карточка «Цель»", feed.goal, feed.goal ? "" : await page.evaluate(() => `tabs=${document.querySelectorAll(".oc-tab[data-tab]").length} active=${document.querySelector(".oc-tab--active")?.textContent?.trim().slice(0, 40)} chatHidden=${document.getElementById("view-chat")?.classList.contains("hidden")} feed=${(document.getElementById("feed")?.innerHTML ?? "").slice(0, 160)}`));
// чип агента: любое реальное имя агента (по умолчанию первый CLI — OpenCode)
check("composer: чип агента с моделью", /·/.test(feed.composerAgent) && feed.composerAgent.length > 4, feed.composerAgent);

// ── правая панель: Изменения + Файлы ──
await page.waitForSelector("#rp-branch .oc-chip", { timeout: 6000 });
const rp = await page.evaluate(() => ({
  branch: (document.getElementById("rp-branch")?.textContent ?? "").trim(),
  editorBtn: !!document.getElementById("btn-open-editor"),
  commitBtn: !!document.getElementById("btn-commit"),
  gitRow: ["btn-push", "btn-pr", "btn-merge"].every((id) => !!document.getElementById(id)),
  noBrowser: !document.body.textContent!.includes("Браузер"),
}));
console.log("RIGHT:", JSON.stringify(rp));
// цель сессии: копия (worktree) либо бранч проекта — оба режима из макета
check("правая панель: чип цели (копия/бранч)", /копия|бранч/.test(rp.branch), rp.branch);
check("«Открыть в редакторе» есть", rp.editorBtn);
check("git-кнопки: Commit/Push/PR/Merge", rp.commitBtn && rp.gitRow);
check("кнопки «Браузер» нет", rp.noBrowser);

// дерево файлов
await page.click("#rtab-files");
await page.waitForSelector("#file-tree .oc-ft-row", { timeout: 6000 });
const tree = await page.evaluate(() => ({
  rows: document.querySelectorAll("#file-tree .oc-ft-row").length,
  fileNames: [...document.querySelectorAll("#file-tree [data-open]")].map((el) => (el as HTMLElement).dataset.open),
}));
console.log("TREE:", JSON.stringify(tree).slice(0, 200));
check("дерево файлов: показывает содержимое проекта", tree.rows >= 3, `${tree.rows}`);
const appFile = tree.fileNames.find((f) => f?.endsWith("app.ts"));
check("дерево файлов: src/app.ts найден", !!appFile);

// клик по файлу → содержимое по ЦЕНТРУ (оверлей), дерево остаётся на месте
if (appFile) {
  await page.click(`[data-open="${appFile}"]`);
  await page.waitForSelector("#view-file:not(.hidden)", { timeout: 5000 });
  const code = (await page.textContent("#file-modal-code")) ?? "";
  const treeStill = await page.locator("#file-tree .oc-ft-row").count();
  check("файл: содержимое открывается по центру (отдельный вид)", code.includes("export const a = 1;"), code.slice(0, 60));
  check("файл: дерево осталось на месте (не уезжает)", treeStill >= 3, `${treeStill}`);
  // открываем другой файл — подменяется без закрытия
  const other = tree.fileNames.find((f) => f !== appFile && f?.endsWith(".txt"));
  if (other) {
    await page.click(`[data-open="${other}"]`);
    await page.waitForFunction(() => document.getElementById("file-modal-name")?.textContent?.includes("a.txt"), null, { timeout: 5000 });
    check("файл: переключение без закрытия предыдущего", true);
  }
  await page.click("#file-modal-close");
  check("файл: вид закрывается — возврат в разговор", await page.evaluate(() => document.getElementById("view-file").classList.contains("hidden")));
}

// ── История ──
await page.click("#nav-history");
await page.waitForSelector("#view-history:not(.hidden)", { timeout: 4000 });
await page.selectOption("#history-project", { label: "ui-audit" });
await page.waitForSelector("#history-pane .oc-hist__row", { timeout: 6000 });
const hist = await page.evaluate(() => ({
  rows: document.querySelectorAll("#history-pane .oc-hist__row").length,
  hasSha: !!document.querySelector("#history-pane .oc-hist__sha"),
  hasBranch: !!document.querySelector("#history-pane .oc-hist__branch"),
  hasTime: /назад|только что/.test(document.getElementById("history-pane")?.textContent ?? ""),
}));
console.log("HISTORY:", JSON.stringify(hist));
check("история: коммиты со sha/веткой/временем", hist.rows >= 1 && hist.hasSha && hist.hasBranch && hist.hasTime);

// раскрытие коммита → подробности
await page.click("#history-pane .oc-hist__row >> nth=0");
const histDetail = await page.evaluate(() => ({
  detail: !!document.querySelector("#history-pane .oc-hist__detail"),
  restore: !!document.querySelector("[data-act='restore']"),
}));
check("история: раскрытие даёт «вернуть к версии»", histDetail.detail && histDetail.restore);

// ── Статистика ──
await page.click("#nav-stats");
await page.waitForSelector("#view-stats:not(.hidden)", { timeout: 4000 });
await page.waitForSelector("#stats-pane .oc-stat", { timeout: 6000 });
const statsText = await page.textContent("#stats-pane");
check("статистика: панель расхода рендерится", /токен|Расход/.test(statsText ?? ""), (statsText ?? "").slice(0, 60));

// ── Настройки ──
await page.click("#nav-settings");
await page.waitForSelector("#view-settings:not(.hidden)", { timeout: 4000 });
await page.waitForSelector("#settings-pane .oc-themedot", { timeout: 6000 });
const setts = await page.evaluate(() => ({
  themes: document.querySelectorAll("#settings-pane .oc-themedot").length,
  keys: !!document.getElementById("settings-pane")?.textContent?.includes("Ключи"),
  importExport: document.getElementById("btn-export") !== null,
}));
console.log("SETTINGS:", JSON.stringify(setts));
check("настройки: темы + ключи + импорт/экспорт", setts.themes >= 2 && setts.keys && setts.importExport);

// ── Доска ──
await page.click("#nav-board");
await page.waitForSelector("#view-board:not(.hidden)", { timeout: 4000 });
await page.waitForSelector("#board-cols .oc-col", { timeout: 6000 });
const cols = await page.locator("#board-cols .oc-col").count();
check("доска: 4 колонки", cols === 4, `${cols}`);

// ── Настройки: реальное содержимое всех шагов (регрессия: было пусто) ──
await page.click("#nav-settings");
await page.waitForSelector("#view-settings:not(.hidden)", { timeout: 4000 });
// шаг 1 «Среда»
await page.waitForSelector("#env-check .env-row", { timeout: 8000 });
const envRows = await page.locator("#env-check .env-row").count();
check("настройки: среда показывает компоненты (bun/git/npm/ssh/cloudflared)", envRows >= 5, `${envRows}`);
// шаг 2 «Агенты»
await page.click('.setup-step[data-step="agents"]');
await page.waitForSelector("#setup-agents .setup-agent", { timeout: 8000 });
const agentRows = await page.locator("#setup-agents .setup-agent").count();
check("настройки: агенты — список с состояниями", agentRows >= 10, `${agentRows}`);
// шаг 3 «Ключи»
await page.click('.setup-step[data-step="keys"]');
await page.waitForSelector("#setup-keys .key-row, #setup-keys .oc-empty", { timeout: 8000 });
check("настройки: шаг ключей рендерится", (await page.locator("#setup-keys .key-row").count()) >= 0);
// шаг 4 «Удалёнка»
await page.click('.setup-step[data-step="remote"]');
await page.waitForSelector("#machines-list", { timeout: 8000 });
const remoteForm = await page.evaluate(() => ["m-name", "m-host", "m-user", "m-daemon", "m-add"].every((id) => !!document.getElementById(id)));
const tunnelBtn = await page.evaluate(() => !!document.getElementById("tunnel-start"));
check("настройки: удалёнка — форма машин + туннель", remoteForm && tunnelBtn);

// ── сворачивание групп проектов в sidebar (V5.2) ──
const firstGroupSessions = () => page.locator(".oc-group").first().locator(".oc-session:visible").count();
const beforeCollapse = await firstGroupSessions();
await page.click(`.oc-group__head >> nth=0`);
const afterCollapse = await firstGroupSessions();
check("sidebar: группа сворачивается", beforeCollapse > 0 && afterCollapse === 0, `${beforeCollapse} → ${afterCollapse}`);
await page.click(`.oc-group__head >> nth=0`);
const reExpanded = await firstGroupSessions();
check("sidebar: группа разворачивается", reExpanded === beforeCollapse, `${reExpanded}`);

// ── действия проекта: архив и возврат (V5.2) ──
// идемпотентная подготовка: снять архив со всех (возможны остатки прошлых прогонов)
for (let k = 0; k < 6; k++) {
  const archCount = await page.locator(".oc-group--archived").count();
  if (archCount === 0) break;
  await page.click(".oc-group--archived [data-proj-archive] >> nth=0").catch(() => {});
  await page.waitForTimeout(700);
}

const firstGroupName = (await page.locator(".oc-group__name").first().textContent()) ?? "";
const archivedOf = (name: string) => {
  const g = [...document.querySelectorAll(".oc-group")].find((el) => (el.querySelector(".oc-group__name")?.textContent ?? "") === name);
  return g ? g.classList.contains("oc-group--archived") : false;
};
await page.click("[data-proj-archive] >> nth=0");
await page.waitForSelector(".oc-group--archived", { timeout: 6000 });
check("sidebar: архив проекта (группа помечена)", true);
await page.click(`.oc-group--archived [data-proj-archive] >> nth=0`);
let restored = false;
for (let i = 0; i < 12; i++) {
  await page.waitForTimeout(400);
  restored = await page.evaluate((name) => {
    const g = [...document.querySelectorAll(".oc-group")].find((el) => (el.querySelector(".oc-group__name")?.textContent ?? "") === name);
    return g ? !g.classList.contains("oc-group--archived") : true;
  }, firstGroupName);
  if (restored) break;
}
check("sidebar: возврат из архива", restored);

// ── добавление проекта через UI с выбором папки (V5.2) ──
await page.click("#add-project");
await page.waitForSelector("#project-modal", { timeout: 4000 });
const pmPath = `${process.cwd().replace(/\\/g, "/")}/.smoke-ui-newproj-${Date.now().toString(36)}`;
await page.fill("#pm-name", "proj-ui");
await page.fill("#pm-path", pmPath);
// кнопка папки открывает браузер каталогов (серверный листинг)
await page.click("#pm-browse");
await page.waitForSelector("#pm-browser:not(.hidden)", { timeout: 5000 });
await page.waitForSelector("#pm-dirs .oc-browser__row", { timeout: 8000 });
const dirRows = await page.locator("#pm-dirs .oc-browser__row").count();
check("проект: браузер папок листает каталоги", dirRows >= 1, `${dirRows}`);
const curDir = (await page.textContent("#pm-cur"))?.trim() ?? "";
await page.click("#pm-pick");
const picked = (await page.inputValue("#pm-path")) ?? "";
check(
  "проект: путь подставлен из браузера",
  picked.length > 1 && picked.replace(/[\\/]+$/, "") === curDir.replace(/[\\/]+$/, ""),
  `поле=${picked} браузер=${curDir}`,
);
await page.fill("#pm-path", pmPath);
await page.waitForSelector("#pm-go:not([disabled])", { timeout: 5000 });
await page.click("#pm-go");
// жём либо успех (проект в API), либо видимую ошибку в модалке
let projViaUi = false;
let pmErrText = "";
for (let i = 0; i < 20; i++) {
  await page.waitForTimeout(400);
  projViaUi = await page.evaluate(async () => {
    const ps = await (await fetch("/api/projects")).json();
    return (ps ?? []).some((p) => (p.path ?? "").toLowerCase().includes("smoke-ui-newproj"));
  });
  pmErrText = await page.evaluate(() => document.getElementById("pm-err")?.textContent ?? "");
  if (projViaUi || pmErrText) break;
}
check("проект: добавление через UI работает", projViaUi, `pm-err: ${pmErrText} | toasts: ${(await page.textContent("#toasts"))?.slice(0, 120)}`);
// ── панель «Изменения»: сворачивание + дифф файла по центру (V5.2) ──
// Берём сессию с копией, пишем в неё правку и открываем её в UI
const copyForDiff = await page.evaluate(async () => {
  const s = await (await fetch("/api/sessions")).json();
  const withWt = s.find((x: { worktree?: { path: string } }) => x.worktree);
  return withWt?.id ?? null;
});
console.log("DBG copyForDiff:", copyForDiff, "| card exists:", copyForDiff ? await page.locator(`.oc-session[data-ses="${copyForDiff}"]`).count() : 0);
if (copyForDiff) {
  // содержимое копии пишем из теста (fs в браузере недоступен)
  const copyPath = await page.evaluate(async (id) => {
    const s = await (await fetch(`/api/sessions/${id}`)).json();
    return s.worktree?.path as string | undefined;
  }, copyForDiff);
  if (copyPath) {
    await Bun.write(copyPath + "/a.txt", "one\nCHANGED-LINE\nthree\n");
    await openAuditSession(page, copyForDiff);
    console.log("COPY:", copyForDiff, "| chip:", (await page.textContent("#rp-branch"))?.trim());
    await page.waitForSelector("#rp-staged .oc-file", { timeout: 15000 });
  // группы «Изменения» сворачиваются
  const changesRowsBefore = await page.locator("#rp-staged .oc-file:visible").count();
  await page.click("[data-cgroup='changes']");
  await page.waitForTimeout(300);
  const changesRowsAfter = await page.locator("#rp-staged .oc-file:visible").count();
  check("изменения: группа сворачивается", changesRowsBefore > 0 && changesRowsAfter === 0, `${changesRowsBefore} → ${changesRowsAfter}`);
  await page.click("[data-cgroup='changes']");
  await page.waitForTimeout(300);
  // клик по файлу → предпросмотр диффа по центру с подсветкой (с ретраями: список живёт поллингом)
  let opened = false;
  for (let k = 0; k < 4 && !opened; k++) {
    await page.click("#rp-staged .oc-file:has-text(\"a.txt\") >> nth=0").catch(() => page.click("#rp-staged .oc-file >> nth=0").catch(() => {}));
    opened = await page.waitForSelector("#view-file:not(.hidden)", { timeout: 4000 }).then(() => true).catch(() => false);
  }
  const diffCenter = await page.evaluate(() => ({
    add: document.querySelectorAll("#file-modal-code .diff-line.add").length,
    del: document.querySelectorAll("#file-modal-code .diff-line.del").length,
    text: (document.getElementById("file-modal-code")?.textContent ?? "").includes("CHANGED-LINE"),
  }));
  check("изменения: дифф файла по центру (было/стало)", diffCenter.add >= 1 && diffCenter.text, JSON.stringify(diffCenter));
  await page.click("#file-modal-close");
  }
}

// ── история: «Показать дифф» открывает предпросмотр коммита (V5.2) ──
await page.click("#nav-history");
await page.selectOption("#history-project", { label: "proj-ui" }).catch(() => {});
await page.click("#nav-chat");
await page.click("#nav-board");
await page.waitForSelector("#board-cols .oc-col", { timeout: 8000 });
const planCard = await page.evaluate(async () => {
  const ps = await (await fetch("/api/projects")).json();
  const p = ps.find((x) => x.path?.includes("smoke-ui-newproj")) ?? ps[0];
  const r = await fetch("/api/plans", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: p.id, goal: "доска-проверка", agentId: "cursor", epics: [{ title: "Epic A" }] }) });
  return r.status;
});
check("доска: план создан через API", planCard === 201, String(planCard));
// повторный вход в вид перечитывает доску (как и живой поллинг 5с)
await page.click("#nav-stats");
await page.waitForTimeout(400);
await page.click("#nav-board");
await page.waitForSelector("#board-cols .oc-card-task", { timeout: 8000 });
const boardState = await page.evaluate(() => {
  const cols = [...document.querySelectorAll("#board-cols .oc-col")];
  const byTitle: Record<string, number> = {};
  for (const c of cols) {
    const title = (c.querySelector(".oc-col__head")?.textContent ?? "").replace(/[0-9\s]+$/, "");
    byTitle[title] = Number(c.querySelector(".oc-col__count")?.textContent ?? 0);
  }
  return byTitle;
});
console.log("BOARD:", JSON.stringify(boardState));
check("доска: план виден в колонке «Ожидают»", (boardState["Ожидают"] ?? 0) >= 1, JSON.stringify(boardState));

// ── темы (12+) ──
const themeOpts = await page.locator("#theme-select option").count();
check("темы: 14 вариантов в селекте", themeOpts >= 12, `${themeOpts}`);
await page.selectOption("#theme-select", "oc-violet");
const themeApplied = await page.evaluate(() => document.documentElement.dataset.theme);
check("тема применяется сразу", themeApplied === "oc-violet", themeApplied);
await page.selectOption("#theme-select", "oc-dark");

// ── Обзор: дашборд по проектам (V6-9) ──
await page.click("#nav-overview");
await page.waitForSelector("#view-overview:not(.hidden)", { timeout: 5000 });
await page.waitForSelector("#ov-cards .oc-ovcard", { timeout: 8000 });
const ovCards = await page.locator("#ov-cards .oc-ovcard").count();
check("обзор: карточки проектов с веткой/коммитами/токенами", ovCards >= 1, `${ovCards}`);
const ovTotals = (await page.textContent("#ov-totals")) ?? "";
check("обзор: сводка (проекты/сессии/коммиты/токены)", /проектов:/.test(ovTotals), ovTotals.slice(0, 80));
const ovGraphs = await page.evaluate(() => ({
  days: document.querySelectorAll("#ov-days .oc-bars__bar").length,
  agents: document.querySelectorAll("#ov-agents .oc-usage-bar__seg").length,
  commits: document.querySelectorAll("#ov-commits .oc-bars__bar").length,
}));
check("обзор: графики (дни/агенты/коммиты)", ovGraphs.days >= 5, JSON.stringify(ovGraphs));
// клик по карточке ведёт в Историю проекта
await page.click("#ov-cards .oc-ovcard >> nth=0");
await page.waitForSelector("#view-history:not(.hidden)", { timeout: 5000 });
check("обзор: клик по проекту → его история", true);
await page.click("#nav-chat");

// ── Терминал: окно по центру табом + список справа-снизу (V6-5) ──
await page.click("#rtab-term");
await page.click("#term-add");
await page.waitForSelector("#view-term:not(.hidden)", { timeout: 6000 });
check("терминал: окно открылось по центру", true);
await page.waitForSelector("[data-termtab]", { timeout: 6000 });
check("терминал: таб в таб-баре", await page.locator("[data-termtab]").count() >= 1);
check("терминал: список справа-снизу", await page.locator("#term-list .oc-termrow").count() >= 1);
// ввод — прямо в окне терминала (xterm.js), как в обычной консоли
await page.waitForSelector("#term-xterm .xterm-screen", { timeout: 6000 });
await page.waitForTimeout(1500);                 // оболочка печатает приглашение
await page.click("#term-xterm");
await page.keyboard.type("echo TERMINAL-UI-OK", { delay: 5 });
await page.keyboard.press("Enter");
let termOut = "";
for (let i = 0; i < 20; i++) {
  await page.waitForTimeout(500);
  termOut = (await page.evaluate(() => (document.querySelector("#term-xterm .xterm-rows") as HTMLElement | null)?.innerText ?? "")).replace(/\u00a0/g, " ");
  if ((termOut.match(/TERMINAL-UI-OK/g) ?? []).length >= 2) break;
}
check("терминал: команда выполняется и вывод виден", termOut.includes("TERMINAL-UI-OK"), termOut.slice(-60));
// скрыть раздел
await page.click("#term-hide");
check("терминал: раздел скрывается", await page.evaluate(() => document.getElementById("rpane-term").classList.contains("hidden")));
// закрытие терминала
await page.click("#rtab-term");
await page.click("#term-list .oc-termrow [data-term-kill]");
await page.waitForTimeout(500);
check("терминал: закрытие из списка", await page.locator("[data-termtab]").count() === 0);
await page.click("#nav-chat");

// ── Статус работы + композер: контекст и голос (V6-6/8) ──
// (открываем сессию заново — терминал мог увести вид; только видимые карточки)
const visibleSession = await page.evaluate(() => {
  const el = [...document.querySelectorAll(".oc-session")].find((e) => (e as HTMLElement).offsetParent !== null);
  if (el) { (el as HTMLElement).click(); return (el as HTMLElement).dataset.ses ?? null; }
  return null;
});
await page.waitForSelector("#right-panel:not(.hidden)", { timeout: 8000 });
await page.click("#rtab-changes");
await page.waitForSelector("#rp-status .oc-status", { timeout: 8000 });
const statusText = (await page.textContent("#rp-status")) ?? "";
check("статус: блок работы в правой панели", statusText.trim().length > 0, `${visibleSession} | ${statusText.trim().slice(0, 60)}`);
await page.fill("#prompt", "проверка контекста");
const ctxText = (await page.textContent("#ctx-meter")) ?? "";
check("композер: индикатор контекста считает", /k|\d/.test(ctxText), ctxText.trim().slice(0, 40));
check("композер: кнопка голосового ввода", await page.evaluate(() => !!document.getElementById("mic-btn")));

// ── языки (V6-10) ──
await page.click("#nav-settings");
await page.waitForSelector("#view-settings:not(.hidden)", { timeout: 4000 });
const langSel = await page.locator("#lang-select").count();
check("настройки: переключатель языка присутствует", langSel === 1, `${langSel}`);

// ── мобильный вид (скрытие sidebar) ──
await page.setViewportSize({ width: 800, height: 900 });
const mobileNav = await page.evaluate(() => getComputedStyle(document.getElementById("sidebar")!).width);
check("мобильный вид: sidebar сжимается", mobileNav === "56px", mobileNav);
await page.setViewportSize({ width: 1440, height: 900 });

// ── ошибки JS ──
if (httpErr.length) console.log("HTTP>=400:", [...new Set(httpErr)].join(" | "));
check("нет необработанных JS-ошибок", jsErrors.length === 0, jsErrors.join("\\n---\\n"));

// ── демон недоступен: пульт обязан объяснить это по-человечески ──
// Регрессия 16.10: fetch падал с сырым «Failed to fetch», и этот текст
// браузера расходился по всем панелям, а оболочку в это время показывал
// service worker из кэша — выглядело как поломка пульта.
// Проверка идёт последней: она намеренно глушит API.
await page.route("**/api/**", (r) => r.abort());
await page.click("#nav-overview");
await page.waitForTimeout(1200);
const offlineBar = await page.isVisible("#offline-bar");
const bodyText = (await page.textContent("body")) ?? "";
check("демон недоступен: показана полоса связи", offlineBar, String(offlineBar));
check("демон недоступен: нет сырого «Failed to fetch»", !/Failed to fetch/i.test(bodyText), bodyText.slice(0, 120));
check("демон недоступен: причина названа по-человечески", /Демон не отвечает/.test(bodyText), bodyText.slice(0, 120));
await page.unroute("**/api/**");
await page.click("#offline-retry");
await page.waitForTimeout(1500);
check("связь восстановилась: полоса убралась", !(await page.isVisible("#offline-bar")), "");


await browser.close();
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
