// dirigo-site — E2E лендинга: RU↔EN, темы, интерактив, мобильная верстка.
// Запуск: bun run tests/site-e2e.ts
// Предпросмотр поднимается сам (serve.ts на PORT, по умолчанию 7381).
// Если браузера playwright в системе нет — тест честно пропускается (exit 0).
import { chromium } from "playwright-core";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const PORT = Number(process.env.PORT ?? 7381);
const BASE = `http://127.0.0.1:${PORT}`;

/* ------------------------- поиск установленного браузера ------------------------- */

function findChromium(): string | null {
  if (process.env.PLAYWRIGHT_CHROMIUM && existsSync(process.env.PLAYWRIGHT_CHROMIUM)) return process.env.PLAYWRIGHT_CHROMIUM;
  const regs = [
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "ms-playwright") : "",
    process.env.HOME ? join(process.env.HOME, ".cache", "ms-playwright") : "",
    process.env.HOME ? join(process.env.HOME, "Library", "Caches", "ms-playwright") : "",
  ].filter(Boolean);
  const inner = [
    "chrome-win64/chrome.exe", "chrome-win/chrome.exe",
    "chrome-linux/chrome", "chrome-linux64/chrome",
    "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
  ];
  for (const reg of regs) {
    let dirs: string[] = [];
    try { dirs = readdirSync(reg).filter((d) => d.startsWith("chromium-")).sort().reverse(); } catch { continue; }
    for (const d of dirs) for (const i of inner) {
      const p = join(reg, d, ...i.split("/"));
      if (existsSync(p)) return p;
    }
  }
  for (const p of ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]) {
    if (existsSync(p)) return p;
  }
  return null;
}

const chromiumPath = findChromium();
console.log("chromium:", chromiumPath ?? "(не найден)");

/* ------------------------------ предпросмотр ------------------------------ */

const server = Bun.spawn([process.execPath, "run", join(ROOT, "serve.ts")], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), SITE_DATA: join(require("node:os").tmpdir(), "dg-site-e2e-data") }, // метрики теста — не в data/ сайта
  stdout: "ignore",
  stderr: "ignore",
});
const stopServer = () => { try { server.kill(); } catch { /* уже мёртв */ } };

let up = false;
for (let i = 0; i < 60; i++) {
  try { if ((await fetch(BASE + "/")).ok) { up = true; break; } } catch { /* ещё не слушает */ }
  await Bun.sleep(100);
}
if (!up) { stopServer(); console.log("FAIL  предпросмотр не поднялся на " + BASE); process.exit(1); }

let browser: any;
try {
  browser = await chromium.launch({ executablePath: chromiumPath ?? undefined, args: ["--no-sandbox"] });
} catch (e) {
  stopServer();
  console.log("skip: браузер недоступен через playwright-core —", String(e).slice(0, 120));
  process.exit(0);
}

const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
try { await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE }); } catch { /* не критично */ }
const page = await ctx.newPage();

const consoleErrors: string[] = [];
page.on("console", (m: any) => { if (m.type() === "error") consoleErrors.push(m.text()); });
page.on("pageerror", (e: any) => consoleErrors.push("pageerror: " + e.message));

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log("PASS  " + name); }
  else { fail++; console.log("FAIL  " + name + (detail ? "  — " + detail : "")); }
};
const txt = async (sel: string) => ((await page.locator(sel).first().textContent()) ?? "").trim();

await page.goto(BASE + "/", { waitUntil: "networkidle" });

/* ------------------------- ноль внешних запросов вживую ------------------------- */

const offsite: string[] = [];
page.on("request", (r: any) => {
  const u = r.url();
  if (!u.startsWith(BASE) && !u.startsWith("data:") && !u.startsWith("blob:")) offsite.push(u);
});
await page.reload({ waitUntil: "networkidle" });
check("страница не делает внешних запросов", offsite.length === 0, offsite.slice(0, 3).join(" | "));

/* ------------------------------ RU по умолчанию ------------------------------ */

check("RU: hero-заголовок", (await txt("h1 span")).includes("кто написал каждую строку"));
check("RU: позиционирование в лиде", (await txt(".hero .lead")).includes("внутри цикла генерации"));
check("RU: запись нельзя собрать постфактум",
  (await txt(".hero .lead")).includes("уже не собрать"), await txt(".hero .lead"));
check("RU: проблема", (await txt("#problem h2")).includes("Один агент уже не вывозит"));
check("RU: Enterprise — private beta", (await txt("#enterprise .badge--beta")).toLowerCase().includes("private beta"));
check("RU: Enterprise — design-партнёры", (await txt("#enterprise .price__sum--text")).includes("design-партнёр"));
check("RU: бейдж «скоро» виден", (await page.locator(".badge--soon").count()) >= 1);
check("RU: FAQ отрисован", (await page.locator("#faqList .acc").count()) >= 10);

/* ------------------- провенанс: пакет, трейлеры, шлюз, знания ------------------- */

check("RU: три отличия на месте", (await page.locator("#edge .edge").count()) === 3,
  String(await page.locator("#edge .edge").count()));
check("RU: третье отличие — провенанс",
  (await txt("#edge .edge--third .h3--lg")).includes("Провенанс"), await txt("#edge .edge--third .h3--lg"));
check("RU: карточка пакета с печатью целостности",
  (await txt("#edge .pack__seal")).includes("подпись и журнал целы"), await txt("#edge .pack__seal"));

check("RU: раздел доказательств виден", await page.locator("#evidence").isVisible());
check("RU: состав пакета — не меньше 8 пунктов",
  (await page.locator("#evidence .evi__list li").count()) >= 8,
  String(await page.locator("#evidence .evi__list li").count()));
{
  const log = await txt("#evidence .term__body");
  const trailers = ["Dirigo-Agent", "Dirigo-Model", "Dirigo-Checks", "Dirigo-Returned-To-Agent", "Dirigo-Ledger-Head"];
  check("RU: git log показывает все трейлеры", trailers.every((t) => log.includes(t)),
    trailers.filter((t) => !log.includes(t)).join(", "));
  check("RU: git log — это разметка, а не картинка",
    (await page.locator("#evidence img").count()) === 0 && log.includes("git log -1"));
}
check("RU: подделка журнала названа прямо",
  (await txt("#evidence .card--evi p")).includes("незаметно нельзя"), await txt("#evidence .card--evi h3"));
check("RU: выгрузка для аудита описана",
  (await page.locator("#evidence .card").nth(1).innerText()).includes("JSON"));

check("RU: четыре режима шлюза", (await page.locator("#gateway .pmode").count()) === 4,
  String(await page.locator("#gateway .pmode").count()));
{
  const modes = await page.locator("#gateway .pmode .card__num").allInnerTexts();
  check("RU: режимы названы off/warn/redact/block",
    JSON.stringify(modes.map((m: string) => m.trim())) === JSON.stringify(["off", "warn", "redact", "block"]),
    JSON.stringify(modes));
}
check("RU: шлюз ничего не хранит",
  (await txt("#piiPrinciple")).includes("не сохраняются нигде"), await txt("#piiPrinciple"));
check("RU: база знаний внутри периметра",
  (await page.locator("#knowledge").innerText()).includes("внутри вашего периметра"));
check("RU: выгрузка знаний идёт через шлюз",
  (await page.locator("#knowledge").innerText()).includes("проходит через шлюз"));
check("RU: ссылка на доказательства в шапке",
  (await page.locator("header .nav a[href='#evidence']").count()) === 1);

/* --------------------------------- EN-версия --------------------------------- */

await page.click('.lang-toggle button[data-lang="en"]');
await page.waitForTimeout(300);

const enChecks: [string, string, string][] = [
  ["nav.how", "header .nav a[href='#how']", "How it works"],
  ["hero.title", "h1 span", "who wrote each line"],
  ["hero.lead", ".hero .lead", "inside the generation loop"],
  ["hero.cta1", ".hero .btn--primary span", "Install with one command"],
  ["problem.title", "#problem h2", "One agent is no longer enough"],
  ["problem.card1", "#problem .card h3", "fight over the working directory"],
  ["how.title", "#how h2", "Three steps"],
  ["how.step1", "#clip1 .clip__step", "Step 1"],
  ["how.card2", "#clip2 .clip__label h3", "Checks run before the human"],
  ["edge.c1", "#edge .edge .h3--lg", "One-click provisioning"],
  ["edge.c3", "#edge .edge--third .h3--lg", "Provenance"],
  ["edge.c3.loop", "#edge .edge--third p", "inside the generation loop"],
  ["pack.seal", "#edge .pack__seal", "signature and ledger intact"],
  ["evi.title", "#evidence h2", "signed evidence pack"],
  ["evi.lead", "#evidence .lead", "Ed25519"],
  ["evi.list", "#evidence .evi__list li", "the agent and the model"],
  ["evi.logcaption", "#evidence .evi__shot figcaption", "Plain git reads the trailers"],
  ["evi.tamper", "#evidence .card--evi p", "cannot go unnoticed"],
  ["evi.export", "#evidence .card:nth-of-type(2) h3", "audit export is one file"],
  ["pii.title", "#gateway h2", "personal-data gateway"],
  ["pii.lead", "#gateway .lead", "before apply and commit"],
  ["pii.mode1", "#gateway .pmode h3", "Off"],
  ["pii.principle", "#piiPrinciple span", "stored nowhere"],
  ["kb.title", "#knowledge .h3--lg", "stays inside the company"],
  ["kb.gateway", "#knowledge .ticks li:nth-child(2)", "always passes through the gateway"],
  ["modes.lead", "#modes .lead", "merged automatically"],
  ["agents.title", "#agents h2", "we run them"],
  ["remote.lead", "#remote .lead", "Cloudflare tunnel or Tailscale"],
  ["security.c3", "#security .card:nth-of-type(3) p", "zero npm dependencies"],
  ["security.soon", "#security .note-box p", "is available on request"],
  ["download.hint", "#download .install-hint", "Bun 1.4+"],
  ["pricing.title", "#pricing h2", "The core is free"],
  ["pricing.honest", "#enterprise .price__honest", "developed together with design partners"],
  ["pricing.built", "#enterprise .price__honest", "In the open core: the provenance ledger"],
  ["security.built", "#security .note-box p", "are part of the open core"],
  ["enterprise.submit", "#entForm button[type=submit]", "design partner"],
  ["faq.title", "#faq .h2", "Frequently asked"],
  ["footer.bottom", ".footer__bottom span:last-child", "decide for themselves"],
];
for (const [name, sel, must] of enChecks) {
  const t = await txt(sel);
  check("EN " + name, t.includes(must), t.slice(0, 70));
}
check("EN: заголовок документа", (await page.title()).includes("provenance for AI-written code"), await page.title());
check("EN: FAQ переведён", (await txt("#faqList .acc__q")).includes("What is Dirigo?"));
{
  const qs = await page.locator("#faqList .acc__q").allInnerTexts();
  const joined = qs.join(" | ");
  check("EN: FAQ — что в пакете", /what exactly is in an evidence pack/i.test(joined));
  check("EN: FAQ — уходит ли что-то с машины", /leave my machine/i.test(joined));
  check("EN: FAQ — как проверит аудитор", /without installing anything/i.test(joined));
}
check("EN: трейлеры не переводятся",
  (await txt("#evidence .term__body")).includes("Dirigo-Ledger-Head"));
check("EN: режим Orchestrator не переименован", (await txt('.tab[data-mode="orchestrator"]')) === "Orchestrator");
{
  const body = await page.locator("main").innerText();
  const ru = body.match(/[А-Яа-яЁё]{4,}/g) ?? [];
  check("EN: основной поток без русских слов", ru.length < 10, JSON.stringify(ru.slice(0, 10)));
}

await page.click('.lang-toggle button[data-lang="ru"]');
await page.waitForTimeout(250);
check("RU возвращается", (await txt("header .nav a[href='#how']")).includes("Как работает"));

/* ------------------------------ режимы и FAQ ------------------------------ */

await page.click('.tab[data-mode="swarm"]');
check("режимы: Swarm открывается", await page.locator('[data-panel="swarm"]').isVisible());
await page.click('.tab[data-mode="orchestrator"]');
check("режимы: Orchestrator открывается", await page.locator('[data-panel="orchestrator"]').isVisible());
await page.click('.tab[data-mode="solo"]');

await page.click("#faqList .acc__q >> nth=1");
await page.waitForTimeout(250);
check("FAQ: ответ раскрывается", await page.locator("#faqList .acc").nth(1).evaluate((el: any) => el.classList.contains("acc--open")));

/* ------------------------- установка: копирование команды ------------------------- */

await page.click('[data-copy="#cmd-unix"]');
await page.waitForTimeout(350);
check("установка: кнопка копирования отработала",
  await page.locator('[data-copy="#cmd-unix"]').evaluate((el: any) => el.classList.contains("install__copy--done")),
  await txt("#copyStatus"));

/* ------------------------- Enterprise: валидация формы ------------------------- */

await page.click("#entForm button[type=submit]");
await page.waitForTimeout(200);
check("Enterprise: пустая форма не отправляется",
  (await txt("#entNote")).includes("Заполните"),
  await txt("#entNote"));
check("Enterprise: подсвечено поле", (await page.locator(".field__input--bad").count()) === 1);
check("Enterprise: форма без action наружу",
  await page.locator("#entForm").evaluate((el: any) => !el.getAttribute("action")));

/* --------------------------- интерактивный макет пульта --------------------------- */

await page.click('[data-am-view="board"]');
check("макет: доска рендерится", (await page.locator(".am-bcard").count()) > 0);
await page.click('[data-am-view="history"]');
check("макет: история", (await page.locator(".am-hrow").count()) >= 4);
await page.click('[data-am-view="chat"]');
await page.click('.am-chip[data-am-agent="codex"]');
check("макет: агент выбирается", (await txt(".am-chip--on")).includes("Codex"));
await page.fill("#amInput", "Add checkout test");
await page.press("#amInput", "Enter");
await page.waitForTimeout(2800);
check("макет: сообщение уходит в ленту", (await page.locator("#amFeedBox .am-msg").count()) >= 4);
await page.click('[data-am-rtab="changes"]');
await page.click("#amApply");
await page.waitForTimeout(900);
check("макет: «Применить» срабатывает", (await txt("#amApply")).includes("✓"), await txt("#amApply"));

/* --------------------------------- темы --------------------------------- */

await page.click("#themeToggle");
await page.waitForTimeout(200);
const theme1 = await page.evaluate(() => document.documentElement.getAttribute("data-site-theme"));
await page.click("#themeToggle");
await page.waitForTimeout(200);
const theme2 = await page.evaluate(() => document.documentElement.getAttribute("data-site-theme"));
check("тема переключается в обе стороны", theme1 !== theme2, theme1 + " → " + theme2);

await page.evaluate(() => { try { localStorage.setItem("dirigo-site-theme", "light"); } catch {} });
await page.reload({ waitUntil: "networkidle" });
check("светлая тема применяется",
  (await page.evaluate(() => document.documentElement.getAttribute("data-site-theme"))) === "light");
{
  const stroke = await page.locator(".vfm-link").first().evaluate((el: any) => getComputedStyle(el).stroke);
  check("светлая: линии схемы тёмные", stroke.includes("15, 23, 42"), stroke);
  const lead = await page.locator("#problem .lead").first().evaluate((el: any) => getComputedStyle(el).color);
  check("светлая: лид читаем (тёмный текст)", /rgb\((\d+), (\d+), (\d+)\)/.test(lead) &&
    Number(lead.match(/\d+/g)![0]) < 140, lead);
}
await page.evaluate(() => { try { localStorage.setItem("dirigo-site-theme", "dark"); } catch {} });

/* ------------------------------- мобильный вид ------------------------------- */

for (const w of [360, 390, 430]) {
  await page.setViewportSize({ width: w, height: 820 });
  await page.reload({ waitUntil: "networkidle" });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(`мобильный ${w}px: нет горизонтального скролла`, overflow <= 1, "overflow " + overflow + "px");
  const burger = await page.locator("#burger").isVisible();
  check(`мобильный ${w}px: бургер-меню видно`, burger);
}
await page.setViewportSize({ width: 1600, height: 1000 });

/* -------------------------- reduced motion уважается -------------------------- */

{
  const rm = await ctx.newPage();
  await rm.emulateMedia({ reducedMotion: "reduce" });
  await rm.goto(BASE + "/", { waitUntil: "networkidle" });
  const op = await rm.locator("#problem .card").first().evaluate((el: any) => getComputedStyle(el).opacity);
  check("reduced-motion: контент виден без анимации", Number(op) === 1, "opacity " + op);
  await rm.close();
}

check("консоль без ошибок", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));

await browser.close();
stopServer();
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
