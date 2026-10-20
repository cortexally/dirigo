#!/usr/bin/env bun
// CLA: диагностика вкладки «Настройка» + «Создать» + «Статистика» в живом UI.
import { chromium } from "playwright";
const PORT2 = process.env.CLA_PORT ?? "7391";
const BASE = `http://127.0.0.1:${PORT2}`;
const DATA = `${import.meta.dir}/../.smoke-cla-diag`;
const proc = Bun.spawn(["bun", "run", "src/server.ts"], {
  cwd: import.meta.dir + "/..",
  env: { ...process.env, PORT: PORT2, DIRIGO_PORT: PORT2, DIRIGO_DATA: DATA },
  stdout: "pipe", stderr: "pipe",
});
const pump = async (s: ReadableStream<Uint8Array>, tag: string) => {
  try {
    for await (const chunk of s) {
      const t = new TextDecoder().decode(chunk);
      if (/error|Error|EADDRINUSE|panic/i.test(t)) console.log(`SERVER[${tag}]: ${t.trim().slice(0, 300)}`);
    }
  } catch { /* убит */ }
};
pump(proc.stdout, "out").catch(() => {});
pump(proc.stderr, "err").catch(() => {});
let up = false;
for (let i = 0; i < 80; i++) {
  try { const r = await fetch(`${BASE}/api/health`); if (r.ok) { up = true; break; } } catch { /* ещё поднимается */ }
  await new Promise((r) => setTimeout(r, 300));
}
if (!up) {
  console.log("SERVER NOT UP — exit code: " + JSON.stringify(await Promise.race([proc.exited, Promise.resolve("still running")])));
}

const errors = [];
try {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  await page.goto(BASE, { waitUntil: "networkidle" });

  // ── Настройки: 4 шага ──
  await page.click("#nav-settings");
  await page.waitForSelector("#view-settings:not(.hidden)", { timeout: 4000 });
  for (const step of ["env", "agents", "keys", "remote"]) {
    await page.click(`.setup-step[data-step="${step}"]`);
    await page.waitForTimeout(4200);   // детект 13 CLI ~3с — ждём реального результата
    const txt = await page.evaluate((s) => {
      const pane = document.querySelector(`.setup-pane[data-pane="${s}"]`);
      return (pane?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 320);
    }, step);
    console.log(`SETUP[${step}]: ${txt || "(ПУСТО)"}`);
  }

  // ── Статистика ──
  await page.click("#nav-stats");
  await page.waitForTimeout(900);
  console.log("STATS: " + (await page.textContent("#stats-pane")).replace(/\s+/g, " ").trim().slice(0, 240));

  // ── Создать: без проектов должен открыться диалог проекта (F5) ──
  await page.click("#nav-chat");
  await page.waitForTimeout(300);
  await page.click("#nav-new");
  await page.waitForTimeout(800);
  const modal = await page.evaluate(() => {
    const el = document.getElementById("new-session-modal") ?? document.getElementById("project-modal");
    if (!el) return "нет модалки";
    return el.textContent.replace(/\s+/g, " ").trim().slice(0, 400);
  });
  console.log("NEWMODAL: " + modal);
  // ── F5: создаём проект и проверяем, что сессия открывается (happy path) ──
  await page.click("#pm-go");
  await page.waitForTimeout(2500);
  const after = await page.evaluate(() => ({
    projModal: !!document.getElementById("project-modal"),
    nsModal: !!document.getElementById("new-session-modal"),
    err: document.getElementById("pm-err")?.textContent ?? "",
    sessions: document.querySelectorAll("#sessions-scroll .oc-session").length,
  }));
  console.log("AFTERPROJECT: " + JSON.stringify(after));
  if (after.nsModal) {
    const agents = await page.locator("[data-ns-agent]").count();
    console.log("NSAGENTS: " + agents);
    // выбираем агента, умеющего CLI (первый), пишем задачу и запускаем
    await page.click("[data-ns-agent]");
    await page.selectOption("#ns-mode", "cli");
    await page.fill("#ns-prompt", "скажи ок");
    // ── флоу ошибки: пустая задача должна объясниться, а не молчать ──
    await page.fill("#ns-prompt", "");
    await page.click("#ns-go");
    await page.waitForTimeout(400);
    console.log("NSERR_EMPTY: " + (await page.textContent("#ns-err")).trim());
    // ── happy path ──
    await page.fill("#ns-prompt", "скажи ок");
    await page.click("#ns-go");
    await page.waitForTimeout(4000);
    const r = await page.evaluate(() => ({
      nsErr: document.getElementById("ns-err")?.textContent ?? "",
      nsModalOpen: !!document.getElementById("new-session-modal"),
      tabs: document.querySelectorAll("#tabs-scroll .oc-tab").length,
      toasts: [...document.querySelectorAll(".oc-toast")].map((t) => t.textContent).join(" | "),
      feed: (document.getElementById("feed")?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 160),
      branch: (document.getElementById("rp-branch")?.textContent ?? "").trim(),
    }));
    console.log("AFTERSESSION: " + JSON.stringify(r));
    console.log("SESSIONERR: " + JSON.stringify(errors));
    // ── F2: файл по центру ──
    await page.click("#rtab-files");
    await page.waitForSelector("#file-tree [data-open]", { timeout: 8000 });
    const first = await page.locator("#file-tree [data-open]").first().getAttribute("data-open");
    await page.click(`#file-tree [data-open="${first}"]`);
    await page.waitForTimeout(1200);
    const fv = await page.evaluate(() => ({
      fileView: !document.getElementById("view-file")?.classList.contains("hidden"),
      name: document.getElementById("file-modal-name")?.textContent ?? "",
      code: (document.getElementById("file-modal-code")?.textContent ?? "").slice(0, 60),
      treeRows: document.querySelectorAll("#file-tree .oc-ft-row").length,
    }));
    console.log("FILEVIEW: " + JSON.stringify(fv));
    // ── F6: доска — сессия должна быть видна в колонке ──
    await page.click("#nav-board");
    await page.waitForTimeout(1800);
    const board = await page.evaluate(() => [...document.querySelectorAll("#board-cols .oc-col")].map((c) => ({
      head: c.querySelector(".oc-col__head")?.textContent?.trim() ?? "",
      count: c.querySelector(".oc-col__count")?.textContent ?? "0",
      cards: [...c.querySelectorAll(".oc-card-task__title")].map((t) => t.textContent),
    })));
    console.log("BOARD: " + JSON.stringify(board));
    // ── F8: история — дерево коммитов, ветка без «?» ──
    await page.click("#nav-history");
    await page.waitForSelector("#view-history:not(.hidden)", { timeout: 4000 });
    await page.selectOption("#history-project", { index: 1 });
    await page.waitForTimeout(1500);
    const hist = await page.evaluate(() => ({
      rows: document.querySelectorAll("#history-pane .oc-hist__row").length,
      branches: [...document.querySelectorAll("#history-pane .oc-hist__branch")].map((b) => b.textContent?.trim()),
      hasQuestion: (document.getElementById("history-pane")?.textContent ?? "").includes("?"),
    }));
    console.log("HISTORY: " + JSON.stringify(hist));
    // ── F3: все темы применяются без ошибок ──
    await page.click("#nav-settings");
    await page.waitForTimeout(600);
    const themes = await page.evaluate(() => [...document.querySelectorAll("#theme-dots .oc-themedot")].map((d) => d.dataset.theme));
    console.log("THEMES: " + themes.length + " " + JSON.stringify(themes));
    for (const t of ["glass", "neo", "glass-slate", "glass-light", "glass-violet", "oc-rose", "oc-dark"]) {
      await page.evaluate((th) => { document.documentElement.dataset.theme = th; }, t);
      await page.waitForTimeout(60);
    }
    const applied = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim());
    console.log("THEME_APPLIED: " + applied);
  }
  console.log("ERRORS: " + JSON.stringify(errors, null, 1));
  await browser.close();
} catch (e) {
  console.log("FATAL: " + String(e.message ?? e));
  console.log("ERRORS: " + JSON.stringify(errors, null, 1));
} finally { proc.kill(); }
