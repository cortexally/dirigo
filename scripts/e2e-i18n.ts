#!/usr/bin/env bun
// Английский интерфейс без русских строк (1.9.4).
//
// При «Язык = English» по-русски оставались пояснения шлюза PII и базы знаний,
// правая колонка диалога новой сессии, строки агентов в мастере, описания
// режимов, подсказки. Перевод 170 строк собран при съёмке промо-роликов.
// Обходим основные виды в английском режиме и собираем видимый текст и
// подсказки (title/placeholder) с кириллицей.
//
//   bun run scripts/e2e-i18n.ts        (порт 7279; E2E_I18N_LIST=1 — вывести найденное)
import { join } from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";

const PORT = Number(process.env.E2E_I18N_PORT ?? 7279);
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = join(import.meta.dir, "..", `.smoke-i18n-${PORT}`);
const LIMIT = Number(process.env.E2E_I18N_MAX ?? 0);
rmSync(ROOT, { recursive: true, force: true });
const repo = join(ROOT, "repo");
mkdirSync(repo, { recursive: true });
writeFileSync(join(repo, "a.txt"), "x\n");
for (const c of [["git", "init", "-q", "-b", "main"], ["git", "config", "user.email", "t@t"], ["git", "config", "user.name", "t"], ["git", "add", "-A"], ["git", "commit", "-qm", "i"]]) Bun.spawnSync(c, { cwd: repo });

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  ok ? pass++ : fail++;
};
const server = Bun.spawn([process.execPath, "run", "src/server.ts"], {
  cwd: join(import.meta.dir, ".."), env: { ...process.env, PORT: String(PORT), DIRIGO_DATA: join(ROOT, "data") }, stdout: "ignore", stderr: "ignore",
});
const jpost = async (p: string, b: unknown) => { const r = await fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }); return { status: r.status, body: await r.json().catch(() => null) as any }; };
let browser: import("playwright").Browser | null = null;

// видимый текст и атрибуты с кириллицей (пользовательские данные — латиницей)
const COLLECT = `(() => {
  const out = new Set();
  const cyr = /[А-Яа-яЁё]/;
  const skip = "pre, code, .xterm, .oc-term__out, .oc-log, .oc-diff-line, .oc-file-modal__code, [data-i18n-skip]";
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = w.nextNode())) {
    const t = (n.nodeValue || "").trim();
    if (!t || !cyr.test(t)) continue;
    const el = n.parentElement;
    if (!el || el.closest(skip)) continue;
    const r = el.getBoundingClientRect();
    if (!el.offsetParent && getComputedStyle(el).position !== "fixed") continue;
    if (r.width === 0 || r.height === 0) continue;
    out.add(t.slice(0, 90));
  }
  for (const el of document.querySelectorAll("[title],[placeholder],[aria-label]")) {
    if (!el.offsetParent || el.closest(skip)) continue;
    for (const a of ["title", "placeholder", "aria-label"]) {
      const v = el.getAttribute(a);
      if (v && cyr.test(v)) out.add("@" + a + ": " + v.slice(0, 90));
    }
  }
  return [...out];
})()`;

try {
  for (let i = 0; i < 160; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* */ } await Bun.sleep(250); }
  await jpost("/api/projects", { name: "demo", path: repo });
  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(() => { try { localStorage.setItem("dirigo-lang", "en"); } catch { /* */ } });
  const page = await ctx.newPage();
  page.on("dialog", (d) => d.dismiss());
  await page.goto(BASE, { waitUntil: "commit" });
  await page.waitForSelector(".oc-side", { timeout: 15000 });
  await page.waitForTimeout(1500);

  const views: Array<[string, () => Promise<void>]> = [
    ["Overview", async () => { await page.click("#nav-overview").catch(() => null); }],
    ["Settings · environment", async () => { await page.click("#nav-settings"); }],
    ["Settings · agents", async () => { await page.click('.setup-step[data-step="agents"]'); }],
    ["Settings · keys", async () => { await page.click('.setup-step[data-step="keys"]'); }],
    ["Settings · remote", async () => { await page.click('.setup-step[data-step="remote"]'); }],
    ["Board", async () => { await page.click("#nav-board"); }],
    ["Evidence", async () => { await page.click("#nav-evidence"); }],
    ["History", async () => { await page.click("#nav-history"); }],
    ["New session dialog", async () => { await page.click("#nav-new").catch(async () => { await page.keyboard.press("Control+N"); }); }],
  ];
  const all: Record<string, string[]> = {};
  for (const [name, open] of views) {
    await open();
    await page.waitForTimeout(1600);
    // длинные страницы (Настройки) — прокрутить, чтобы отрисовалось всё
    await page.evaluate(() => { for (const el of document.querySelectorAll(".oc-settings, .oc-view, main")) (el as HTMLElement).scrollTop = 99999; });
    await page.waitForTimeout(300);
    all[name] = await page.evaluate(COLLECT) as string[];
    await page.keyboard.press("Escape").catch(() => null);
  }
  const total = new Set(Object.values(all).flat()).size;
  if (process.env.E2E_I18N_LIST) for (const [k, v] of Object.entries(all)) for (const t of v) console.log(`RU  [${k}] ${t}`);
  for (const [k, v] of Object.entries(all)) console.log(`INFO  ${k}: ${v.length}`);
  check(`английский режим: русских строк ≤ ${LIMIT}`, total <= LIMIT, `найдено ${total}`);
} catch (e) {
  check("без исключений", false, String(e).slice(0, 240));
} finally {
  await browser?.close().catch(() => null);
  server.kill();
  await Bun.sleep(400);
  for (let i = 0; i < 5; i++) { try { rmSync(ROOT, { recursive: true, force: true }); break; } catch { await Bun.sleep(600); } }
}
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
