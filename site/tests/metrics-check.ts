// Метрики лендинга: serve.ts (/api/event, /api/stats, /stats) и трекинг в app.js.
// Запуск: bun run tests/metrics-check.ts. Данные — во временной папке (SITE_DATA),
// ключ сводки — STATS_KEY теста. Браузерная часть пропускается, если нет chromium.
import { chromium } from "playwright-core";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = join(import.meta.dir, "..");
const DATA = mkdtempSync(join(tmpdir(), "dg-site-metrics-"));
const KEY = "test-key-" + process.pid;
const free = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
const PORT = free.port; free.stop(true);
const BASE = `http://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;
const ok = (c: boolean, m: string, d = "") => { if (c) pass++; else fail++; console.log(`${c ? "PASS" : "FAIL"}  ${m}${d ? "  — " + d : ""}`); };
const events = () => { try { return readFileSync(join(DATA, "events.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const post = (b: unknown, raw?: string) => fetch(BASE + "/api/event", { method: "POST", headers: { "content-type": "application/json" }, body: raw ?? JSON.stringify(b) });

const server = Bun.spawn([process.execPath, "run", join(ROOT, "serve.ts")], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), SITE_DATA: DATA, STATS_KEY: KEY }, stdout: "ignore", stderr: "ignore" });
try {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + "/")).ok) break; } catch { /* ещё нет */ } await Bun.sleep(100); }

  // приём
  ok((await post({ type: "view", visitor: "v1", meta: { ref: "https://news.ycombinator.com/x" } })).status === 200, "view принят");
  ok((await post({ type: "buy_intent", visitor: "v1", meta: { label: "hero" } })).status === 200, "buy_intent принят");
  ok((await post({ type: "signup", visitor: "v1", email: "a@b.co", meta: { company: "ACME" } })).status === 200, "signup принят");
  ok((await post({ type: "view", visitor: "v2", email: "leak@x.io" })).status === 200, "view второго посетителя");
  ok((await post({ type: "hack", visitor: "v1" })).status === 400, "неизвестный тип → 400");
  ok((await post(null, "{не json")).status === 400, "битый JSON → 400");
  ok((await post(null, JSON.stringify({ type: "view", meta: { x: "a".repeat(9000) } }))).status === 413, "больше 8 КБ → 413");
  ok((await fetch(BASE + "/api/event")).status === 405, "GET /api/event → 405");
  const ev = events();
  ok(ev.length === 4 && ev.every((e) => e.ts && e.landing === "dirigo" && "visitor" in e && "email" in e && "meta" in e), "формат строки {ts, landing, type, visitor, email, meta}", `${ev.length} строк`);
  ok(ev.find((e) => e.type === "signup")?.email === "a@b.co" && ev.filter((e) => e.type !== "signup").every((e) => e.email === ""), "e-mail сохраняется только у заявки");

  // закрытое
  ok((await fetch(BASE + "/data/events.jsonl")).status === 404, "data/ наружу не отдаётся");
  ok((await fetch(BASE + "/stats")).status === 404 && (await fetch(BASE + "/stats?key=wrong")).status === 404, "сводка без ключа → 404");
  const js = await (await fetch(`${BASE}/api/stats?key=${KEY}&days=0`)).json() as any;
  ok(js.funnel?.[0]?.visitors === 2 && js.funnel?.find((f: any) => f.step === "signup")?.visitors === 1, "воронка: 2 просмотра → 1 заявка", JSON.stringify(js.funnel));
  ok(js.labels?.hero === 1 && js.referrers?.["news.ycombinator.com"] === 1, "клики по label и источники");
  const html = await (await fetch(`${BASE}/stats?key=${KEY}`)).text();
  ok(/Воронка/.test(html) && html.includes("a@b.co") && !html.includes("<script"), "HTML-сводка с заявками, без скриптов");

  // браузер: страница сама шлёт view, клики CTA — buy_intent, заявка — signup
  const exe = (() => {
    const reg = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "ms-playwright") : join(process.env.HOME ?? "", ".cache", "ms-playwright");
    try {
      for (const d of readdirSync(reg).filter((x) => x.startsWith("chromium-")).sort().reverse())
        for (const i of ["chrome-win64/chrome.exe", "chrome-win/chrome.exe", "chrome-linux/chrome", "chrome-mac/Chromium.app/Contents/MacOS/Chromium"])
          if (existsSync(join(reg, d, i))) return join(reg, d, i);
    } catch { /* нет реестра */ }
    return undefined;
  })();
  let browser: any = null;
  try { browser = await chromium.launch({ executablePath: exe, args: ["--no-sandbox"] }); } catch (e) { console.log("skip браузер:", String(e).slice(0, 100)); }
  if (browser) {
    writeFileSync(join(DATA, "events.jsonl"), "");
    const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
    const errors: string[] = [];
    page.on("pageerror", (e: any) => errors.push(e.message));
    await page.goto(BASE + "/?utm_source=test");
    await page.waitForTimeout(600);
    await page.click('a[data-track="buy"][data-label="hero"]');
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(400);
    await page.fill('#entForm [name="name"]', "Test").catch(() => {});
    await page.fill('#entForm [name="email"]', "lead@example.com").catch(() => {});
    await page.evaluate(() => { const f = document.querySelector("#entForm") as HTMLFormElement | null; f?.requestSubmit?.(); });
    await page.waitForTimeout(800);
    const b = events();
    const vid = b[0]?.visitor;
    ok(b.some((e) => e.type === "view" && e.meta?.utm?.utm_source === "test"), "страница шлёт view с utm");
    ok(b.some((e) => e.type === "buy_intent" && e.meta?.label === "hero"), "клик «Установить» → buy_intent (hero)");
    ok(b.some((e) => e.type === "scroll50"), "прокрутка до середины → scroll50");
    ok(b.some((e) => e.type === "signup" && e.email === "lead@example.com"), "заявка → signup с e-mail");
    ok(!!vid && b.every((e) => e.visitor === vid), "один посетитель — один id (localStorage d_vid)");
    ok(errors.length === 0, "без ошибок JS", errors.join("; "));
    await browser.close();
  }
  // предел частоты (последним: тот же адрес, что у браузера)
  let limited = false;
  for (let i = 0; i < 130 && !limited; i++) if ((await post({ type: "scroll50", visitor: "flood" })).status === 429) limited = true;
  ok(limited, "поток событий с одного адреса ограничен (429)");

} finally {
  try { server.kill(); } catch { /* */ }
  await Promise.race([server.exited, Bun.sleep(3000)]);
  for (let i = 0; i < 10; i++) { try { rmSync(DATA, { recursive: true, force: true }); break; } catch { await Bun.sleep(300); } }
}
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
