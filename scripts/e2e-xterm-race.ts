#!/usr/bin/env bun
// Гонка «снимок экрана ↔ поток» в браузерном терминале (1.9.2).
//
// Симптом: в терминале Claude заголовок рисовался дважды, строки наезжали
// (e2e-scenarios: «экран пульта ≠ экран агента»). Причина: на смене размера
// демон шлёт init-снимок, а браузер делал term.reset() сразу — ещё не
// разобранные xterm'ом прежние куски доигрывались на чистом экране, и снимок
// ложился сверху. Особенно у TUI, которые рисуют частично (ink: курсор вверх,
// стереть строку), — мусор не перерисовывался и оставался навсегда.
//
// Воспроизведение без агента: в терминале оболочки программа рисует как ink
// (заголовок один раз, дальше — правка строк курсором вверх) плотным потоком,
// а окно в это время меняет размер (каждый раз — init от демона). После
// затихания на экране должно быть ровно: заголовок + последнее состояние.
//
//   bun run scripts/e2e-xterm-race.ts      (порт 7287)
import { join } from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";

const PORT = Number(process.env.E2E_XR_PORT ?? 7287);
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = join(import.meta.dir, "..", `.smoke-xterm-race-${PORT}`);
rmSync(ROOT, { recursive: true, force: true });
const repo = join(ROOT, "repo");
mkdirSync(repo, { recursive: true });
writeFileSync(join(repo, "a.txt"), "x\n");
for (const c of [["git", "init", "-q", "-b", "main"], ["git", "config", "user.email", "t@t"], ["git", "config", "user.name", "t"], ["git", "add", "-A"], ["git", "commit", "-qm", "i"]]) Bun.spawnSync(c, { cwd: repo });
// «ink»: очистка один раз, заголовок, потом только частичные правки трёх строк
const STEPS = 3000;
const stress = join(ROOT, "ink.js");
writeFileSync(stress, `
const w = (s) => process.stdout.write(s);
w("\\x1b[2J\\x1b[H");
w("HEADER-ONCE\\r\\n");
w("status: 0\\r\\nprogress: 0\\r\\nlast: 0\\r\\n");
let i = 0;
const t = setInterval(() => {
  // тяжёлый поток, как у Claude Code: цветная рамка на каждом кадре — xterm
  // не успевает разбирать, и в его очереди копятся куски
  let out = "";
  for (let k = 0; k < 40 && i < ${STEPS}; k++) {
    i++;
    const bar = Array.from({ length: 40 }, (_, j) => "\\x1b[38;5;" + ((i + j) % 200 + 16) + "m-").join("") + "\\x1b[0m";
    // как ink: вверх на 3 строки, каждую стереть и переписать
    out += "\\x1b[3A\\r\\x1b[2Kstatus: " + i + "\\r\\n\\x1b[2K" + (i < ${STEPS} ? bar : "progress: done") + "\\r\\n\\x1b[2Klast: " + i + "\\r\\n";
  }
  w(out);
  if (i >= ${STEPS}) { clearInterval(t); setInterval(() => {}, 1000); }
}, 4);
`);

const server = Bun.spawn([process.execPath, "run", "src/server.ts"], {
  cwd: join(import.meta.dir, ".."),
  env: { ...process.env, PORT: String(PORT), DIRIGO_DATA: join(ROOT, "data") },
  stdout: "ignore", stderr: "ignore",
});
const jpost = async (p: string, b: unknown) => {
  const r = await fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
  return { status: r.status, body: await r.json().catch(() => null) as any };
};
let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  ok ? pass++ : fail++;
};
let browser: import("playwright").Browser | null = null;

try {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* */ } await Bun.sleep(250); }
  const pid = (await jpost("/api/projects", { name: "xr", path: repo })).body.id;
  const ses = await jpost("/api/sessions", { agentId: "cursor", projectId: pid, mode: "web", prompt: "xr" });
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(BASE, { waitUntil: "commit" });
  await page.waitForSelector(".oc-side", { timeout: 15000 });
  await page.click(`.oc-session[data-ses="${ses.body.id}"]`);
  await page.waitForSelector("#view-chat:not(.hidden)", { timeout: 10000 });
  await page.click("#rtab-term");
  await page.click("#term-add");
  await page.waitForSelector("#term-xterm .xterm-rows", { timeout: 15000 });
  await page.waitForTimeout(2500); // оболочка поднялась
  // запуск «ink» и смена размера окна посреди потока
  await page.click("#term-xterm");
  await page.keyboard.type(`node "${stress.replace(/\\/g, "/")}"`);
  // Медленная машина под нагрузкой (так падал гейт): процессор браузера в 6 раз
  // медленнее — xterm не успевает разбирать, в его очереди копятся куски.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: Number(process.env.E2E_XR_THROTTLE ?? 6) });
  await page.keyboard.press("Enter");
  const sizes = [[1400, 900], [1100, 760], [1300, 820], [1000, 700], [1400, 900], [1200, 800]];
  for (let k = 0; k < 14; k++) { const [w, h] = sizes[k % sizes.length]!; await page.setViewportSize({ width: w, height: h }); await page.waitForTimeout(110); }
  await page.setViewportSize({ width: 1400, height: 900 });
  // затихание: экран не меняется 2 с
  const rows = () => page.evaluate(() => [...document.querySelectorAll("#term-xterm .xterm-rows > div")].map((r) => (r as HTMLElement).innerText.replace(/ /g, " ").trimEnd()));
  let prev = "", calm = 0;
  for (let k = 0; k < 40 && calm < 4; k++) { await page.waitForTimeout(500); const t = (await rows()).join("\n"); calm = t === prev ? calm + 1 : 0; prev = t; }
  const r = (await rows()).filter((l) => l.trim());
  const headers = r.filter((l) => l.includes("HEADER-ONCE")).length;
  const statuses = r.filter((l) => /^status: \d+$/.test(l));
  check("заголовок ровно один (нет доигранных кусков поверх снимка)", headers === 1, `заголовков: ${headers}`);
  check("строка статуса одна и последняя", statuses.length === 1 && statuses[0] === `status: ${STEPS}`, statuses.join(" | "));
  check("строка last одна и последняя", r.filter((l) => /^last: \d+$/.test(l)).length === 1 && r.includes(`last: ${STEPS}`), r.filter((l) => l.startsWith("last")).join(" | "));
  check("ноль JS-ошибок", errors.length === 0, errors.slice(0, 2).join(" | "));
  if (fail) console.log("экран:\n" + r.slice(0, 14).join("\n"));
} catch (e) {
  check("без исключений", false, String(e).slice(0, 240));
} finally {
  await browser?.close().catch(() => null);
  server.kill();
  await Bun.sleep(500);
  for (let i = 0; i < 5; i++) { try { rmSync(ROOT, { recursive: true, force: true }); break; } catch { await Bun.sleep(800); } }
}
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
