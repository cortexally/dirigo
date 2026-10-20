#!/usr/bin/env bun
// Браузерная регрессия терминала и навигации пульта.
//
//   DIRIGO_URL=http://127.0.0.1:7399 DIRIGO_E2E_PROJECT=<путь к git-репо> \
//     DIRIGO_E2E_AGENT=claude-code bun run scripts/e2e-terminal.ts
//
// Что проверяем (каждое — реальный баг, найденный на Windows 17.10):
//   • тема по умолчанию — Modern Light;
//   • вкладки (Настройки, Доска, …) не выкидывают на главную, пока агент
//     работает и шлёт события;
//   • режим «Терминал (TUI)» рисует настоящий xterm.js из потока PTY, экран
//     не дублируется, ввод доходит до агента, размер подстраивается под окно;
//   • вставка картинки превращается в файл в папке сессии и путь в терминале.
// Скриншоты — в DIRIGO_E2E_SHOTS (по умолчанию ./e2e-shots).
import { chromium } from "playwright";
import { detectAuthPrompt } from "../src/agents/runner";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Без DIRIGO_URL — свой демон на свободном порту с изолированными данными;
// без проекта — временный git-репозиторий; без агента — первый с рабочим PTY.
const OWN = !process.env.DIRIGO_URL && !process.env.DIRIGO_PORT;
const PORT = process.env.DIRIGO_PORT ? Number(process.env.DIRIGO_PORT) : (() => {
  const srv = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {}, open() {}, close() {}, error() {} } });
  const p = srv.port; srv.stop(true); return p;
})();
const BASE = process.env.DIRIGO_URL ?? `http://127.0.0.1:${PORT}`;
const TMP = join(import.meta.dir, "..", `.e2e-term-${Date.now().toString(36)}`);
let ownServer: Bun.Subprocess | null = null;
if (OWN) {
  mkdirSync(join(TMP, "data"), { recursive: true });
  ownServer = Bun.spawn([process.execPath, "run", "src/server.ts"], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, PORT: String(PORT), DIRIGO_DATA: join(TMP, "data") },
    stdout: "ignore", stderr: "ignore",
  });
  for (let i = 0; i < 120; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* поднимается */ } await Bun.sleep(250); }
}
let PROJECT = process.env.DIRIGO_E2E_PROJECT ?? "";
if (!PROJECT) {
  PROJECT = join(TMP, "repo");
  mkdirSync(PROJECT, { recursive: true });
  writeFileSync(join(PROJECT, "README.md"), "# e2e\n");
  for (const cmd of [["git", "init", "-q", "-b", "main"], ["git", "add", "-A"], ["git", "-c", "user.email=e2e@dirigo", "-c", "user.name=e2e", "commit", "-qm", "init"]]) Bun.spawnSync(cmd, { cwd: PROJECT });
}
let AGENT = process.env.DIRIGO_E2E_AGENT ?? "";
if (!AGENT) {
  const list = await (await fetch(`${BASE}/api/agents`)).json() as any[];
  const ok = (a: any) => (a.availability?.modes ?? []).some((m: any) => m.mode === "pty" && m.available);
  AGENT = (list.find((a) => ok(a) && a.availability?.auth?.signedIn) ?? list.find(ok))?.id ?? "";
}
if (!AGENT) {
  console.log("PASS  терминал: на машине нет агента с режимом «Терминал» — проверка неприменима\n\n1/1 passed");
  ownServer?.kill();
  process.exit(0);
}
console.log(`[e2e-terminal] агент: ${AGENT}, демон: ${BASE}`);
// скриншоты — во временный каталог ОС, а не в дерево репозитория
const SHOTS = process.env.DIRIGO_E2E_SHOTS ?? join(tmpdir(), "dirigo-e2e-shots");
mkdirSync(SHOTS, { recursive: true });

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  ok ? pass++ : fail++;
};
const api = async (path: string, init?: { method?: string; body?: unknown }) => {
  const r = await fetch(BASE + "/api" + path, {
    method: init?.method ?? "GET",
    headers: { "content-type": "application/json" },
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  return r.json() as Promise<any>;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));


const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const consoleErrors: string[] = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
page.on("pageerror", (e) => consoleErrors.push(String(e)));
const http404: string[] = [];
page.on("response", (r) => { if (r.status() >= 400) http404.push(`${r.status()} ${r.request().method()} ${r.url().replace(BASE, "")}`); });

// журнал кадров потока терминала — печатается при провале проверок экрана
await page.addInitScript(() => {
  const ES = window.EventSource; (window as any).__frames = [];
  (window as any).EventSource = function (u: string) {
    const es = new ES(u);
    if (u.includes("/stream")) {
      es.addEventListener("message", (e: any) => { try { const m = JSON.parse(e.data); (window as any).__frames.push(m.t === "init" ? `init ${m.cols}x${m.rows}/${m.data?.length}` : m.t); } catch { /* */ } });
      es.addEventListener("error", () => (window as any).__frames.push("ES-ERROR"));
    }
    return es;
  } as any;
});
const frames = async () => (await page.evaluate(() => (window as any).__frames as string[])).slice(-12).join(" ");
await page.goto(BASE + "/");
await page.waitForSelector("#nav-settings");

/* ── тема по умолчанию ── */
check("тема по умолчанию — modern-light", (await page.evaluate(() => document.documentElement.dataset.theme)) === "modern-light");
check("xterm.js загружен", await page.evaluate(() => typeof (window as any).Terminal === "function" && typeof (window as any).FitAddon?.FitAddon === "function"));

/* ── проект + терминальная сессия агента ── */
const projects = await api("/projects");
let proj = projects.find((p: any) => p.path === PROJECT);
if (!proj) proj = await api("/projects", { method: "POST", body: { name: "e2e-demo", path: PROJECT } });
const ses = await api("/sessions", { method: "POST", body: { agentId: AGENT, projectId: proj.id, mode: "pty", prompt: "" } });
check("PTY-сессия создана", !!ses.id, ses.error ?? "");
await page.reload();
await page.waitForSelector(`[data-ses="${ses.id}"]`, { timeout: 10_000 });
await page.click(`[data-ses="${ses.id}"]`);
await page.waitForSelector("#pty-term .xterm-screen", { timeout: 10_000 });
check("терминал — настоящий xterm.js", true);

// дождаться, пока агент нарисует интерфейс
const screenText = () => page.evaluate(() => {
  const rows = document.querySelectorAll("#pty-term .xterm-rows > div");
  return [...rows].map((r) => (r as HTMLElement).innerText.replace(/ /g, " ").trimEnd()).join("\n");
});
let txt = "";
for (let i = 0; i < 60; i++) { txt = await screenText(); if (txt.replace(/\s/g, "").length > 40) break; await sleep(500); }
check("агент нарисовал экран", txt.replace(/\s/g, "").length > 40, JSON.stringify(txt.slice(0, 160)));
await sleep(2500);
await page.screenshot({ path: join(SHOTS, `term-${AGENT}-1.png`) });

// размер PTY = размер окна эмулятора (а не 160×40)
const dims = await page.evaluate(() => {
  const el = document.querySelector("#pty-term .xterm-screen") as HTMLElement;
  return { w: el?.clientWidth ?? 0, h: el?.clientHeight ?? 0 };
});
const meta = await api(`/sessions/${ses.id}/screen`);
check("PTY подстроен под окно", meta.cols !== 160 && meta.cols >= 40 && meta.rows >= 10, `${meta.cols}x${meta.rows}, экран ${dims.w}x${dims.h}`);

// экран в браузере совпадает с экраном демона (ничего не задвоилось)
const browserLines = (await screenText()).split("\n").map((l) => l.trimEnd());
const daemonLines = (meta.lines as any[]).map((l) => String(l.text).trimEnd());
const same = daemonLines.filter((l, i) => l === (browserLines[i] ?? "")).length;
check("экран браузера = экран демона", same >= daemonLines.length - 2, `совпало ${same}/${daemonLines.length}`);

// повторные строки — признак «вывод повторяется и перемешивается»
// разделители (───) и рамки повторяются легитимно — считаем только строки с текстом
const nonEmpty = browserLines.filter((l) => l.trim().length > 12 && /[\p{L}\p{N}]{3}/u.test(l));
const dup = nonEmpty.length - new Set(nonEmpty).size;
check("нет задвоенных строк", dup <= 1, `дублей ${dup}`);

/* ── ввод доходит до агента ── */
// Фокус — без клика мышью: TUI с отслеживанием мыши (cline) получил бы клик.
const focusTerm = () => page.focus("#pty-term textarea");
await focusTerm();
// Стартовые диалоги агентов: «доверяете папке?» (claude, devin, cursor),
// «переключить тему?» (devin). Идём стрелками к пункту «да/доверяю» от
// текущего указателя и жмём Enter — заодно проверка, что стрелки и Enter
// доходят до TUI как VT-коды.
const DIALOG = /Do you trust|trust this folder|Trust Required|Detected (light|dark) theme|Switch theme\?|Switch\?/i;
let dialogs = 0, dialogOk = true;
// «вопрос активен» — то же правило, что в пульте (старое окно выше экрана не в счёт)
const activeDialog = async () => DIALOG.test(await screenText()) && detectAuthPrompt(await screenText())?.kind === "choice";
for (let round = 0; round < 4 && await activeDialog(); round++) {
  const lines = (await screenText()).split("\n").map((l) => l.replace(/[│┃]/g, " "));
  const sel = lines.findIndex((l) => /^\s*[❯›▶❭>]\s*\S/.test(l));
  // пункт «да» — строка, которая САМА начинается с yes/trust ([a], «1.», маркер),
  // а не вопрос «…one you trust?» над пунктами
  const yes = lines.findIndex((l, i) => Math.abs(i - (sel < 0 ? i : sel)) <= 8
    && /^\s*([❯›▶❭>]\s*)?(\d+[.)]?\s*)?(\[\w\]\s*)?(yes\b|trust\b)/i.test(l) && !/\bno\b|quit|exit|don.t/i.test(l));
  if (sel >= 0 && yes >= 0) {
    const key = yes > sel ? "ArrowDown" : "ArrowUp";
    for (let k = 0; k < Math.abs(yes - sel); k++) { await page.keyboard.press(key); await sleep(150); }
  }
  const before = await screenText();
  await page.keyboard.press("Enter");
  let moved = false;
  for (let i = 0; i < 30 && !moved; i++) { await sleep(400); moved = (await screenText()) !== before; }
  dialogs++;
  dialogOk &&= moved;
}
if (dialogs) check(`стрелки и Enter доходят до TUI (пройдено диалогов: ${dialogs})`, dialogOk);
// Ждём, пока TUI перестанет перерисовываться: ввод в ещё не поднятый интерфейс
// агент вправе выбросить, и это не ошибка пульта.
{
  let prev = "", stable = 0;
  // агент после ответа на вопрос перезагружает интерфейс («Trusting workspace…»)
  // и выбрасывает набранное в эти секунды — ждём, пока он поднимется
  for (let i = 0; i < 80 && stable < 6; i++) { await sleep(500); const t = await screenText(); stable = t === prev && !/Trusting|Loading|Starting|Initializ/i.test(t) ? stable + 1 : 0; prev = t; }
}
await page.keyboard.type("dirigo-e2e-ввод", { delay: 15 });
let typed = false;
for (let i = 0; i < 20 && !typed; i++) { await sleep(300); typed = (await screenText()).includes("dirigo-e2e-ввод"); }
check("набор с клавиатуры виден в TUI", typed);
await page.screenshot({ path: join(SHOTS, `term-${AGENT}-2-typed.png`) });

/* ── вставка картинки ── */
const pngB64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPj/HwADAgH/eL9GtQAAAABJRU5ErkJggg==";
await page.evaluate((b64) => {
  const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const file = new File([bin], "shot.png", { type: "image/png" });
  const dt = new DataTransfer();
  dt.items.add(file);
  const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
  (document.querySelector("#pty-term textarea") ?? document.querySelector("#pty-term"))!.dispatchEvent(ev);
}, pngB64);
let pasted = false;
for (let i = 0; i < 20 && !pasted; i++) { await sleep(300); // форматы у агентов разные: [Image #1] (claude), [Image 1] (opencode),
  // [[ Image 1 ]] (hermes), плашка-вложение «paste-2026-….png» (freebuff)
  pasted = /paste-\d{4}|\[\[?\s*Image #?\s*\d+\s*\]?\]|\.dirigo/.test(await screenText()); }
check("картинка из буфера дошла до агента", pasted, (await screenText()).split("\n").filter((l) => /png|Image|dirigo/.test(l)).join(" | ").slice(0, 200));
await page.screenshot({ path: join(SHOTS, `term-${AGENT}-3-pasted.png`) });
{
  const after = (await screenText()).split("\n").map((l) => l.trimEnd()).filter((l) => l.trim().length > 12 && /[\p{L}\p{N}]{3}/u.test(l));
  const d2 = after.length - new Set(after).size;
  check("после набора и вставки строки не задвоились", d2 === 0, `дублей ${d2}`);
  const m2 = await api(`/sessions/${ses.id}/screen`);
  const dl = (m2.lines as any[]).map((l) => String(l.text).trimEnd());
  const bl = (await screenText()).split("\n").map((l) => l.trimEnd());
  const eq = dl.filter((l, i) => l === (bl[i] ?? "")).length;
  check("после ввода экран браузера = экран демона", eq >= dl.length - 1, `совпало ${eq}/${dl.length}`);
}

/* ── resize: окно меньше → PTY меньше ── */
await page.setViewportSize({ width: 1000, height: 700 });
await sleep(1200);
const meta2 = await api(`/sessions/${ses.id}/screen?meta=1`);
const full2 = await api(`/sessions/${ses.id}/screen`);
check("resize окна меняет размер PTY", full2.cols < meta.cols, `${meta.cols} → ${full2.cols}`);
void meta2;
await page.setViewportSize({ width: 1440, height: 900 });
await sleep(800);

/* ── вкладки не выкидывают на главную, пока агент шлёт события ── */
for (const [nav, view] of [["nav-settings", "view-settings"], ["nav-board", "view-board"], ["nav-history", "view-history"], ["nav-stats", "view-stats"], ["nav-overview", "view-overview"]] as const) {
  await page.click(`#${nav}`);
  // события сессии: статус меняется — раньше это и выбрасывало из вкладки
  await api(`/sessions/${ses.id}/rename`, { method: "POST", body: { title: `e2e ${nav} ${Date.now()}` } }).catch(() => {});
  await sleep(6500);
  const st = await page.evaluate((v) => ({
    target: !document.getElementById(v)?.classList.contains("hidden"),
    chat: !document.getElementById("view-chat")?.classList.contains("hidden"),
    empty: !document.getElementById("view-empty")?.classList.contains("hidden"),
  }), view);
  check(`«${view}» остаётся открытой 6.5 с`, st.target && !st.chat && !st.empty, JSON.stringify(st));
}
await page.click("#nav-settings");
await page.screenshot({ path: join(SHOTS, "settings.png") });

/* ── назад в разговор: экран восстанавливается из снимка ── */
await page.click(`[data-ses="${ses.id}"]`);
await page.waitForSelector("#pty-term .xterm-screen", { timeout: 10_000 });
await sleep(1500);
{
  const back = await screenText();
  const st = await api(`/sessions/${ses.id}`);
  const daemon = ((await api(`/sessions/${ses.id}/screen`)).lines ?? []).map((l: any) => l.text).join(" ");
  // экран пульта после возврата = экран агента (агент вправе очистить свой экран)
  check("после возврата экран восстановлен", back.replace(/\s/g, "").length > 40 || daemon.replace(/\s/g, "").length < 40,
    `${st.status} ${st.failReason ?? ""} | пульт: ${back.replace(/\s+/g, " ").slice(0, 80)} | агент: ${daemon.replace(/\s+/g, " ").slice(0, 80)} | кадры: ${await frames()}`);
}

/* ── терминал оболочки (вкладка «Терминал» справа): тот же xterm.js ── */
await page.click("#rtab-term");
await page.click("#term-add");
await page.waitForSelector("#term-xterm .xterm-screen", { timeout: 10_000 });
const shellText = () => page.evaluate(() =>
  [...document.querySelectorAll("#term-xterm .xterm-rows > div")].map((r) => (r as HTMLElement).innerText.replace(/ /g, " ").trimEnd()).join("\n"));
let shellReady = false;
for (let i = 0; i < 40 && !shellReady; i++) { await sleep(400); shellReady = /PS [A-Z]:\\|[$#] ?$|❯/m.test(await shellText()); }
check("оболочка показала приглашение", shellReady, JSON.stringify((await shellText()).slice(0, 120)));
await page.click("#term-xterm");
await page.keyboard.type("echo dirigo-shell-ok", { delay: 10 });
await page.keyboard.press("Enter");
let shellOut = false;
for (let i = 0; i < 30 && !shellOut; i++) { await sleep(300); shellOut = ((await shellText()).match(/dirigo-shell-ok/g) ?? []).length >= 2; }
check("команда в оболочке выполнилась (ввод и вывод видны)", shellOut);
check("в оболочке нет сырых ESC-кодов", !/\x1b|\[\?\d+[hl]|\[\d+;\d+H/.test(await shellText()));
await page.screenshot({ path: join(SHOTS, "shell.png") });
// закрываем, как пользователь, — кнопкой в окне терминала
await page.click("#term-kill");
await sleep(800);
check("терминал закрыт кнопкой «Закрыть»", ((await api("/terminals")).terminals ?? []).length === 0);
await page.click(`[data-ses="${ses.id}"]`);
await sleep(500);

/* ── сессию удалили извне: пульт закрывает её, а не долбит 404 ── */
await api(`/sessions/${ses.id}/stop`, { method: "POST" });
await sleep(800);
await api(`/sessions/${ses.id}`, { method: "DELETE" }).catch(() => {});
await sleep(1500);
const before = http404.filter((x) => x.includes(ses.id)).length;
await sleep(6000);
const after = http404.filter((x) => x.includes(ses.id)).length;
check("удалённая сессия больше не опрашивается", after === before, `404 до ${before}, после ${after}`);
check("после удаления — пустой экран, без ленты", await page.evaluate(() => document.getElementById("view-chat")?.classList.contains("hidden") ?? false));
for (let i = http404.length - 1; i >= 0; i--) if (http404[i]!.includes(ses.id)) http404.splice(i, 1);
if (http404.length) console.log("HTTP>=400:", [...new Set(http404)].join(" | "));
const errs = consoleErrors.filter((e) => !/favicon|ERR_ABORTED|EventSource|Failed to load resource/i.test(e)).concat(http404);
check("нет ошибок в консоли браузера", errs.length === 0, errs.slice(0, 3).join(" | "));
await browser.close();
if (ownServer) {
  if (process.platform === "win32") Bun.spawnSync(["taskkill", "/PID", String(ownServer.pid), "/T", "/F"]);
  else ownServer.kill();
  for (let i = 0; i < 5; i++) { try { rmSync(TMP, { recursive: true, force: true }); break; } catch { await Bun.sleep(1000); } }
}
console.log(`\n${pass}/${pass + fail} passed  (скриншоты: ${SHOTS})`);
process.exit(fail ? 1 : 0);
