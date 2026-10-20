#!/usr/bin/env bun
// Плавность панели: частота кадров при анимации (1.9.4).
//
// Регресс (замер промо-съёмки 1.9.3): backdrop-filter: blur на постоянных
// поверхностях панели давал 17 кадров/с вместо 60 — композитор каждый кадр
// перерисовывал размытые слои, хотя размывать было нечего. Считаем кадры
// CDP-скринкаста, пока на странице крутится анимированный элемент, и
// сравниваем с той же страницей, где backdrop-filter выключен принудительно:
// без лишнего blur разницы быть не должно.
//
//   bun run scripts/e2e-fps.ts      (порт 7283)
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { chromium } from "playwright";

const PORT = Number(process.env.E2E_FPS_PORT ?? 7283);
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = join(import.meta.dir, "..", `.smoke-fps-${PORT}`);
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });
let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  ok ? pass++ : fail++;
};
const server = Bun.spawn([process.execPath, "run", "src/server.ts"], {
  cwd: join(import.meta.dir, ".."), env: { ...process.env, PORT: String(PORT), DIRIGO_DATA: join(ROOT, "data") }, stdout: "ignore", stderr: "ignore",
});
let browser: import("playwright").Browser | null = null;
try {
  for (let i = 0; i < 160; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* */ } await Bun.sleep(250); }
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.goto(BASE, { waitUntil: "commit" });
  await page.waitForSelector(".oc-side", { timeout: 15000 });
  await page.waitForTimeout(1200);
  // непрерывно анимированный элемент — как пузырь размышления или кольцо статуса
  await page.evaluate(() => {
    const d = document.createElement("div");
    d.id = "fps-probe";
    d.style.cssText = "position:fixed;left:40%;top:40%;width:60px;height:60px;background:#7c5cff;border-radius:50%;z-index:5;animation:fpsSpin 1s linear infinite";
    const st = document.createElement("style");
    st.textContent = "@keyframes fpsSpin{0%{transform:translateX(0)}50%{transform:translateX(200px)}100%{transform:translateX(0)}}";
    document.head.appendChild(st); document.body.appendChild(d);
  });
  const cdp = await page.context().newCDPSession(page);
  const measure = async (ms: number) => {
    let frames = 0;
    const onFrame = async (e: any) => { frames++; try { await cdp.send("Page.screencastFrameAck", { sessionId: e.sessionId }); } catch { /* */ } };
    cdp.on("Page.screencastFrame", onFrame);
    await cdp.send("Page.startScreencast", { format: "jpeg", quality: 30, everyNthFrame: 1 });
    await page.waitForTimeout(ms);
    await cdp.send("Page.stopScreencast");
    cdp.off("Page.screencastFrame", onFrame);
    return frames / (ms / 1000);
  };
  await measure(800); // прогрев
  const asShipped = await measure(3000);
  await page.addStyleTag({ content: "*{backdrop-filter:none!important;-webkit-backdrop-filter:none!important}" });
  await page.waitForTimeout(300);
  const noBlur = await measure(3000);
  console.log(`INFO  кадров/с: как есть ${asShipped.toFixed(1)}, без blur вообще ${noBlur.toFixed(1)}`);
  check("blur не съедает частоту кадров (≥ 80% от страницы без blur)", asShipped >= noBlur * 0.8, `${asShipped.toFixed(1)} vs ${noBlur.toFixed(1)}`);
  const persistent = await page.evaluate(() => [".oc-side", ".oc-right", ".oc-main"].map((sel) => {
    const el = document.querySelector(sel); return el ? getComputedStyle(el).backdropFilter : "none";
  }));
  check("постоянные поверхности без backdrop-filter", persistent.every((v) => v === "none"), persistent.join(", "));
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
