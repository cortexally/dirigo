#!/usr/bin/env bun
// Стабильность экрана (1.9.2): «периодически моргает, как обновление страницы».
//
// Каждый вид держим открытым ~12 с без изменений данных и считаем:
//   • перезагрузки/навигации страницы;
//   • полные перерисовки ключевых блоков (замена детей контейнера целиком);
//   • сдвиги раскладки (layout-shift).
// Опрос раз в 5 с, SSE-события и таймеры не должны ничего перерисовывать,
// если данные не поменялись. Раньше «Доска» каждые 5 с показывала
// «загружаем доску…» и рисовалась заново — это и было мигание.
//
//   bun run scripts/e2e-stability.ts     (порт 7291, свои данные)
import { join } from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";

const PORT = Number(process.env.E2E_STAB_PORT ?? 7291);
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = join(import.meta.dir, "..", `.smoke-stability-${PORT}`);
const HOLD = Number(process.env.E2E_STAB_HOLD_MS ?? 12_000);
rmSync(ROOT, { recursive: true, force: true });
const repo = join(ROOT, "repo");
mkdirSync(repo, { recursive: true });
writeFileSync(join(repo, "a.txt"), "one\n");
for (const c of [["git", "init", "-q", "-b", "main"], ["git", "config", "user.email", "t@t"], ["git", "config", "user.name", "t"], ["git", "add", "-A"], ["git", "commit", "-qm", "i"]]) Bun.spawnSync(c, { cwd: repo });

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

// Наблюдатель в странице: полные перерисовки контейнеров и сдвиги раскладки
const PROBE = `(() => {
  const w = window;
  w.__stab = { replaced: {}, shift: 0 };
  const watch = ["feed", "board-cols", "history-list", "file-tree", "rp-staged", "rp-status", "rp-branch",
    "evidence-pane", "settings-pane", "sessions-scroll", "tabs-scroll", "rp-checks", "rp-gitinit"];
  const mo = new MutationObserver((list) => {
    for (const m of list) {
      if (m.type !== "childList" || !m.removedNodes.length) continue;
      const host = m.target.closest ? m.target : null;
      const id = (host && (host.id || host.closest?.("[id]")?.id)) || "?";
      if (!watch.includes(id)) continue;
      // «полная перерисовка» — контейнер потерял больше половины детей разом
      const direct = watch.includes(m.target.id) && [...m.removedNodes].some((n) => n.nodeType === 1);
      if (direct || m.removedNodes.length >= 2 || (m.target.childElementCount <= 1 && m.removedNodes.length >= 1 && m.addedNodes.length >= 1)) {
        w.__stab.replaced[id] = (w.__stab.replaced[id] ?? 0) + 1;
      }
    }
  });
  mo.observe(document.body, { childList: true, subtree: true });
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) w.__stab.shift += e.value; })
      .observe({ type: "layout-shift", buffered: false });
  } catch {}
})()`;

try {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* */ } await Bun.sleep(250); }
  const pid = (await jpost("/api/projects", { name: "stab", path: repo })).body.id;
  const s1 = await jpost("/api/sessions", { agentId: "cursor", projectId: pid, mode: "web", prompt: "stab", worktree: true });
  await jpost("/api/plans", { projectId: pid, goal: "доска стабильна" }).catch(() => null);
  check("сессия для проверки", s1.status === 201, String(s1.status));

  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors: string[] = [];
  let navigations = 0;
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("framenavigated", (f) => { if (f === page.mainFrame()) navigations++; });
  await page.goto(BASE, { waitUntil: "commit" });
  await page.waitForSelector(".oc-side", { timeout: 15000 });
  await page.waitForTimeout(2500); // первичная загрузка, прогрев
  const navBase = navigations;

  // events=true: сервер всё время шлёт события (как при работающем агенте), данные те же
  const hold = async (label: string, open: () => Promise<void>, events = false) => {
    await open();
    await page.waitForTimeout(1800); // вид загрузился
    await page.evaluate(PROBE);
    let stop = false;
    const curTitle = (await (await fetch(`${BASE}/api/sessions/${s1.body.id}`)).json() as any).title;
    const pump = (async () => { while (events && !stop) { await fetch(`${BASE}/api/sessions/${s1.body.id}/rename`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: curTitle }) }).catch(() => null); await Bun.sleep(1200); } })();
    // демон отвечает, пока вид открыт: синхронный запуск процесса в обработчике
    // (например, `claude mcp get`) замораживал весь сервер на секунды
    // Заморозка от синхронного процесса повторяется на каждом опросе вида или длится секунды;
    // единичный всплеск занятой машины (GC, соседние процессы) — нет: допускаем один замер > 1 с.
    let worst = 0, slow = 0;
    const ping = (async () => { while (!stop) { const t = performance.now(); await fetch(`${BASE}/api/health`).catch(() => null); const ms = performance.now() - t; worst = Math.max(worst, ms); if (ms > 1000) slow++; await Bun.sleep(300); } })();
    await page.waitForTimeout(HOLD);
    stop = true; await pump; await ping;
    check(`${label}: демон отвечает без задержек`, slow <= 1 && worst < 2500, `худший ${Math.round(worst)} мс, > 1 с: ${slow}`);
    const st = await page.evaluate(() => (window as any).__stab);
    const rep = Object.entries(st.replaced as Record<string, number>).map(([k, v]) => `${k}×${v}`).join(", ");
    check(`${label}: за ${HOLD / 1000} с без изменений нет перерисовок`, !rep, rep);
    check(`${label}: нет сдвигов раскладки`, st.shift < 0.02, st.shift.toFixed(3));
  };

  await hold("Разговор (веб-сессия)", async () => { await page.click(`.oc-session[data-ses="${s1.body.id}"]`); });
  await hold("Разговор: поток событий без изменений данных", async () => {}, true);
  await hold("Разговор: вкладка «Файлы»", async () => { await page.click("#rtab-files"); });
  await page.click("#rtab-changes");
  await hold("Доска", async () => { await page.click("#nav-board"); });
  await hold("История", async () => { await page.click("#nav-history"); });
  await hold("Доказательства", async () => { await page.click("#nav-evidence"); });
  await hold("Настройки", async () => { await page.click("#nav-settings"); });

  check("страница ни разу не перезагрузилась сама", navigations === navBase, `${navigations - navBase}`);
  check("ноль JS-ошибок", errors.length === 0, errors.slice(0, 2).join(" | "));
} catch (e) {
  check("без исключений", false, String(e).slice(0, 240));
} finally {
  await browser?.close().catch(() => null);
  server.kill();
  await Bun.sleep(400);
  for (let i = 0; i < 5; i++) { try { rmSync(ROOT, { recursive: true, force: true }); break; } catch { await Bun.sleep(800); } }
}
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
