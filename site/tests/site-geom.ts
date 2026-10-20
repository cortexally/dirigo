// dirigo-site — геометрия, вертикальный ритм и контраст в обеих темах.
// Запуск: bun run tests/site-geom.ts        (скриншоты: SHOT_DIR или系统 temp)
// Предпросмотр поднимается сам. Без браузера — честный skip (exit 0).
import { chromium } from "playwright-core";
import { existsSync, readdirSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = join(import.meta.dir, "..");
const PORT = Number(process.env.PORT ?? 7382);
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = process.env.SHOT_DIR ?? join(tmpdir(), "dirigo-site-shots");

function findChromium(): string | null {
  if (process.env.PLAYWRIGHT_CHROMIUM && existsSync(process.env.PLAYWRIGHT_CHROMIUM)) return process.env.PLAYWRIGHT_CHROMIUM;
  const regs = [
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "ms-playwright") : "",
    process.env.HOME ? join(process.env.HOME, ".cache", "ms-playwright") : "",
    process.env.HOME ? join(process.env.HOME, "Library", "Caches", "ms-playwright") : "",
  ].filter(Boolean);
  const inner = ["chrome-win64/chrome.exe", "chrome-win/chrome.exe", "chrome-linux/chrome",
    "chrome-linux64/chrome", "chrome-mac/Chromium.app/Contents/MacOS/Chromium"];
  for (const reg of regs) {
    let dirs: string[] = [];
    try { dirs = readdirSync(reg).filter((d) => d.startsWith("chromium-")).sort().reverse(); } catch { continue; }
    for (const d of dirs) for (const i of inner) {
      const p = join(reg, d, ...i.split("/"));
      if (existsSync(p)) return p;
    }
  }
  for (const p of ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]) if (existsSync(p)) return p;
  return null;
}

const server = Bun.spawn([process.execPath, "run", join(ROOT, "serve.ts")], {
  cwd: ROOT, env: { ...process.env, PORT: String(PORT), SITE_DATA: join(require("node:os").tmpdir(), "dg-site-e2e-data") }, stdout: "ignore", stderr: "ignore",
});
const stopServer = () => { try { server.kill(); } catch { /* уже мёртв */ } };
let up = false;
for (let i = 0; i < 60; i++) {
  try { if ((await fetch(BASE + "/")).ok) { up = true; break; } } catch { /* ждём */ }
  await Bun.sleep(100);
}
if (!up) { stopServer(); console.log("FAIL  предпросмотр не поднялся"); process.exit(1); }

let browser: any;
try {
  browser = await chromium.launch({ executablePath: findChromium() ?? undefined, args: ["--no-sandbox"] });
} catch (e) {
  stopServer();
  console.log("skip: браузер недоступен —", String(e).slice(0, 120));
  process.exit(0);
}

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log("PASS  " + name); }
  else { fail++; console.log("FAIL  " + name + (detail ? "  — " + detail : "")); }
};

mkdirSync(SHOTS, { recursive: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

/* --------- измеритель контраста: цвет текста против фактического фона --------- */

const CONTRAST_PROBE = (selectors: string[]) => {
  const lum = (c: number[]) => {
    const f = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2];
  };
  const parse = (s: string) => {
    const m = String(s).match(/[\d.]+/g);
    if (!m) return null;
    const a = m.length > 3 ? parseFloat(m[3]) : 1;
    return { rgb: [+m[0], +m[1], +m[2]], a: a };
  };
  const bgOf = (el: Element) => {
    let n: Element | null = el, acc: number[] | null = null;
    while (n && n !== document.documentElement) {
      const p = parse(getComputedStyle(n).backgroundColor);
      if (p && p.a >= 0.92) { acc = p.rgb; break; }
      n = n.parentElement;
    }
    if (!acc) {
      const b = parse(getComputedStyle(document.body).backgroundColor);
      acc = b ? b.rgb : [255, 255, 255];
    }
    return acc;
  };
  return selectors.map((sel) => {
    const el = document.querySelector(sel);
    if (!el) return { sel: sel, ratio: null as number | null };
    const fgp = parse(getComputedStyle(el).color);
    if (!fgp) return { sel: sel, ratio: null as number | null };
    const l1 = lum(fgp.rgb), l2 = lum(bgOf(el));
    const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    return { sel: sel, ratio: Math.round(ratio * 100) / 100 };
  });
};

const TEXT_SELECTORS = [
  ".hero .lead", "#problem .card p", "#edge .ticks li", "#modes .step p",
  "#security .card p", "#download .install-hint", "#pricing .price__who",
  "#faqList .acc__q", ".footer__about p", ".footer a", ".agents__list",
  // «кодовые» поверхности: терминал, клипы, мастер, команда установки
  "#remote .term__body", "#remote .term .c", "#remote .term .p", "#remote .term .d",
  "#clip2 .clip__row", "#clip2 .clip__row .ok", "#clip1 .clip__row .acc",
  "#edge .wiz__row span", "#edge .wiz__row code", "#edge .gate__sub",
  "#download .install__code", "#download .install__label",
  // новые поверхности провенанса: карточка пакета, git log, запись для базы знаний
  "#edge .pack__row dt", "#edge .pack__row dd", "#edge .pack__seal",
  "#evidence .term__body", "#evidence .term .c", "#evidence .evi__shot figcaption",
  "#evidence .ticks li", "#gateway .card p", "#gateway .card__num",
  "#knowledge .ticks li", "#knowledge .krec__row dt", "#knowledge .krec__row dd",
  "#knowledge .krec__foot",
];

for (const theme of ["dark", "light"] as const) {
  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  await page.evaluate((t: string) => { try { localStorage.setItem("dirigo-site-theme", t); } catch {} }, theme);
  await page.reload({ waitUntil: "networkidle" });
  const applied = await page.evaluate(() => document.documentElement.getAttribute("data-site-theme"));
  check(`${theme}: тема применена`, applied === theme, String(applied));

  const probes: { sel: string; ratio: number | null }[] = await page.evaluate(CONTRAST_PROBE, TEXT_SELECTORS);
  const weak = probes.filter((p) => p.ratio === null || p.ratio < 4.5);
  check(`${theme}: контраст текста ≥ 4.5:1 (WCAG AA)`, weak.length === 0,
    weak.map((w) => `${w.sel}=${w.ratio}`).join(", ") ||
    `min ${Math.min(...probes.map((p) => p.ratio ?? 99))}:1`);

  // вертикальный ритм: соседние секции не слипаются и не разъезжаются
  const rhythm: number[] = await page.evaluate(() => {
    const secs = Array.from(document.querySelectorAll("main > section"));
    const gaps: number[] = [];
    for (let i = 1; i < secs.length; i++) {
      const prev = secs[i - 1].getBoundingClientRect();
      const cur = secs[i].getBoundingClientRect();
      gaps.push(Math.round(cur.top - prev.bottom));
    }
    return gaps;
  });
  check(`${theme}: секции стыкуются без разрывов`, rhythm.every((g) => Math.abs(g) <= 1), JSON.stringify(rhythm));

  const h1 = await page.locator(".hero__copy .h1").boundingBox();
  check(`${theme}: hero-заголовок отрисован`, !!h1 && h1.width > 300 && h1.height > 40, JSON.stringify(h1));
  const mock = await page.locator("#appmock").boundingBox();
  check(`${theme}: макет пульта отрисован`, !!mock && mock.width > 800, JSON.stringify(mock));

  await page.locator("#appmock").scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(SHOTS, `site-${theme}-1600.png`), fullPage: false });

  // мобильный вид той же темы
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: "networkidle" });
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(`${theme}: 390px без горизонтального скролла`, over <= 1, "overflow " + over);
  const tap = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll(".btn, .install__copy, .tab, .acc__q"));
    return btns.filter((b) => b.getBoundingClientRect().height > 0 && b.getBoundingClientRect().height < 36).length;
  });
  check(`${theme}: 390px — цели нажатия не мельче 36px`, tap === 0, tap + " мелких целей");
  await page.screenshot({ path: join(SHOTS, `site-${theme}-390.png`), fullPage: false });
  await page.setViewportSize({ width: 1600, height: 1000 });
}

await browser.close();
stopServer();
console.log(`\nскриншоты: ${SHOTS}`);
console.log(`${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
