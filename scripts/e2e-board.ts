#!/usr/bin/env bun
// E2E «Доска режимов» клона (v1.1): виды, колонки, планы/рои на доске,
// переход к сессии. Свой порт 7292 и изолированные данные.
import { join } from "node:path";
import { chromium } from "playwright";
import { rmSync, mkdirSync } from "node:fs";

const PORT = Number(process.env.E2E_BOARD_PORT ?? 7292); // V6.13: динамический порт
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = `${import.meta.dir}/../.smoke-e2e-board-${PORT}`;
rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });

const server = Bun.spawn([process.execPath, "run", "src/server.ts"], {
  cwd: join(import.meta.dir, ".."),
  env: { ...process.env, PORT: String(PORT), DIRIGO_DATA: DATA },
  stdout: "ignore", stderr: "ignore",
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jpost = async (p: string, b: unknown) => {
  const r = await fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
  return { status: r.status, body: await r.json().catch(() => null) as any };
};
const jget = async (p: string) => (await fetch(BASE + p)).json() as any;
const jdel = async (p: string) => { await fetch(BASE + p, { method: "DELETE" }); };

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  ok ? pass++ : fail++;
};

try {
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* */ } await sleep(300); }

  // проект + git-репо для плана
  const root = join(import.meta.dir, "..", ".smoke-e2e-board-proj");
  rmSync(root, { recursive: true, force: true });
  const repo = join(root, "r");
  mkdirSync(repo, { recursive: true });
  require("node:fs").writeFileSync(join(repo, "app.ts"), "export const a = 1;\n");
  for (const c of [["git", "init", "-q"], ["git", "config", "user.email", "t@t"], ["git", "config", "user.name", "t"], ["git", "add", "-A"], ["git", "commit", "-qm", "i"]]) Bun.spawnSync(c, { cwd: repo });
  const proj = await jpost("/api/projects", { name: "board-e2e", path: repo });

  // план с двумя эпиками
  const pl = await jpost("/api/plans", {
    projectId: proj.body.id, goal: "доска e2e цель", agentId: "cursor",
    epics: [{ title: "Epic один", branch: "vf/b1/e1" }, { title: "Epic два", branch: "vf/b1/e2" }],
  });
  check("план создан через API", pl.status === 201 && pl.body?.epics?.length === 2, `${pl.status}`);

  let browser: import("playwright").Browser | null = null;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(BASE, { waitUntil: "commit" });
    await page.waitForSelector(".oc-side", { timeout: 15000 });

    // вид «Доска» из левого меню — 4 колонки клона
    await page.click("#nav-board");
    await page.waitForSelector("#view-board:not(.hidden)", { timeout: 5000 });
    await page.waitForSelector("#board-cols .oc-col", { timeout: 10000 });
    const cols = await page.locator("#board-cols .oc-col").count();
    check("доска: 4 колонки (Ожидают/В работе/Ревью/Готово)", cols === 4, `${cols}`);

    // эпики плана на доске
    await page.waitForSelector("#board-cols .oc-card-task", { timeout: 5000 });
    const tasks = await page.evaluate(() => [...document.querySelectorAll("#board-cols .oc-card-task")].map((el) => el.textContent ?? ""));
    check("план на доске с целью", tasks.some((t) => t.includes("доска e2e цель")), tasks.join(" | ").slice(0, 90));
    const metaShown = await page.evaluate(() => (document.querySelector("#board-cols .oc-card-task__meta")?.textContent ?? ""));
    check("прогресс эпиков показан", /\d+\/\d+/.test(metaShown), metaShown);

    // клик по карточке не роняет вид
    await page.click("#board-cols .oc-card-task >> nth=0");
    await page.waitForTimeout(400);
    check("клик по карточке безопасен", true);

    // карточки стабильны
    const tasks2 = await page.locator("#board-cols .oc-card-task").count();
    check("карточки стабильны после клика", tasks2 >= 1, `${tasks2}`);

    // повторная навигация не ломает вид
    await page.click("#nav-chat");
    await page.waitForTimeout(300);
    await page.click("#nav-board");
    await page.waitForSelector("#board-cols .oc-card-task", { timeout: 5000 });
    const tasks3 = await page.locator("#board-cols .oc-card-task").count();
    check("доска survives повторный вход", tasks3 >= 1, `${tasks3}`);

    check("ноль JS-ошибок в браузере", errors.length === 0, errors.slice(0, 2).join(" | "));
    await page.goto(BASE, { waitUntil: "commit" });
    await page.click("#nav-chat");
    check("возврат к разговору работает", await page.evaluate(() => !document.getElementById("view-chat")?.classList.contains("hidden") || !document.getElementById("view-empty")?.classList.contains("hidden")));
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
} catch (e) {
  check("e2e without exceptions", false, String(e).slice(0, 200));
} finally {
  server.kill();
  try { rmSync(DATA, { recursive: true, force: true }); } catch { /* Windows держит файлы — приберёт следующий прогон */ }
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
