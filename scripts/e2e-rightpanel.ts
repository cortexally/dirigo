#!/usr/bin/env bun
// E2E правой панели (1.9.1): свернуть/развернуть, рельс со счётчиками,
// раскладка кнопок по смыслу цели, кнопка «Создать git проекта».
//
// Ловит: пустую колонку на месте скрытой панели; кнопки, у которых обрезан
// текст; git-кнопки, которые видны, но отвечают 409; рельс, который не
// открывает нужный раздел; потерю свёрнутости после перезагрузки.
//
//   bun run scripts/e2e-rightpanel.ts        (порт 7295, свои данные)
//   E2E_SHOTS=dir — сохранить скриншоты для глаз
import { join } from "node:path";
import { chromium } from "playwright";
import { answerConfirms } from "./confirm-dom";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";

const PORT = Number(process.env.E2E_RP_PORT ?? 7295);
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = join(import.meta.dir, "..", `.smoke-rightpanel-${PORT}`);
const SHOTS = process.env.E2E_SHOTS ?? "";
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });

// git-проект (копия → git-worktree) и папка внутри чужого репо (нужен свой git)
const repo = join(ROOT, "repo");
const parent = join(ROOT, "parent");
const nested = join(parent, "sub");
mkdirSync(repo, { recursive: true });
mkdirSync(nested, { recursive: true });
writeFileSync(join(repo, "a.txt"), "one\n");
writeFileSync(join(nested, "b.txt"), "two\n");
for (const dir of [repo, parent]) {
  for (const c of [["git", "init", "-q", "-b", "main"], ["git", "config", "user.email", "t@t"], ["git", "config", "user.name", "t"], ["git", "add", "-A"], ["git", "commit", "-qm", "i"]]) Bun.spawnSync(c, { cwd: dir });
}

const server = Bun.spawn([process.execPath, "run", "src/server.ts"], {
  cwd: join(import.meta.dir, ".."),
  env: { ...process.env, PORT: String(PORT), DIRIGO_DATA: join(ROOT, "data"), DIRIGO_EDITOR_DRYRUN: "1" },
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
  const p1 = await jpost("/api/projects", { name: "rp-git", path: repo });
  const p2 = await jpost("/api/projects", { name: "rp-nested", path: nested });
  // веб-режим не требует установленного агента — проверяем панель, а не агента
  const s1 = await jpost("/api/sessions", { agentId: "cursor", projectId: p1.body.id, mode: "web", prompt: "rp", worktree: true });
  const s2 = await jpost("/api/sessions", { agentId: "cursor", projectId: p2.body.id, mode: "web", prompt: "rp" });
  check("сессии созданы", s1.status === 201 && s2.status === 201, `${s1.status}/${s2.status} ${s1.body?.error ?? ""}${s2.body?.error ?? ""}`);
  const copyPath = (await (await fetch(`${BASE}/api/sessions/${s1.body.id}/target`)).json() as any).path;
  writeFileSync(join(copyPath, "a.txt"), "one\nadded\n");
  writeFileSync(join(copyPath, "new.txt"), "x\n");

  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  answerConfirms(page, () => "ok");
  await page.goto(BASE, { waitUntil: "commit" });
  await page.waitForSelector(".oc-side", { timeout: 15000 });

  const cols = () => page.evaluate(() => getComputedStyle(document.getElementById("app")!).gridTemplateColumns.split(" ").length);
  const rightW = () => page.evaluate(() => document.getElementById("right-panel")!.getBoundingClientRect().width);

  // версии UI и демона совпадают — страница не перезагружает сама себя
  // (регресс 1.9.1: «1.9» из UI_BUILD против «1.9.1» демона → reload на каждой вкладке)
  await page.waitForTimeout(1500);
  check("UI не считает себя устаревшим при той же версии демона", await page.evaluate(() => sessionStorage.getItem("ui-reloaded") === null));
  const ver = await (await fetch(`${BASE}/api/health`)).json() as any;
  const appSrc = await Bun.file(join(import.meta.dir, "..", "web", "app.js")).text();
  check("UI_BUILD = APP_VERSION демона", appSrc.includes(`const UI_BUILD = "${ver.version}"`), String(ver.version));

  // без сессии: панели нет и колонки под неё тоже
  await page.waitForTimeout(500);
  const noSes = await page.evaluate(() => document.getElementById("right-panel")!.classList.contains("hidden"));
  if (noSes) check("без сессии нет пустой колонки справа", (await cols()) === 2, `колонок ${await cols()}`);

  await page.click(`.oc-session[data-ses="${s1.body.id}"]`);
  await page.waitForSelector("#view-chat:not(.hidden)", { timeout: 10000 });
  await page.waitForFunction(() => document.getElementById("changes-count")!.textContent === "2", null, { timeout: 15000 }).catch(() => null);
  check("панель развёрнута: 3 колонки, ширина ~340", (await cols()) === 3 && Math.abs((await rightW()) - 340) < 4, `w=${await rightW()}`);
  check("счётчик изменений = 2", (await page.textContent("#changes-count")) === "2");
  const vis = (id: string) => page.evaluate((x) => { const el = document.getElementById(x)!; return !!el.offsetParent && !el.hidden; }, id);
  check("копия: видны «Применить» и «Вернуть»", await vis("btn-apply") && await vis("btn-revert"));
  check("git-проект: видны Commit/Push/PR/Merge", await vis("btn-commit") && await vis("btn-merge"));
  check("нет блока «Создать git проекта» у собственного репо", !(await vis("rp-gitinit")));
  const clipped = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("#rpane-changes .oc-btn")]
    .filter((b) => b.offsetParent && b.scrollWidth > b.clientWidth + 1).map((b) => b.id || b.textContent));
  check("ни у одной кнопки панели не обрезан текст", clipped.length === 0, clipped.join(", "));
  if (SHOTS) { mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: join(SHOTS, "rp-expanded.png") }); }

  // свернуть → рельс
  await page.click("#rp-collapse");
  await page.waitForTimeout(200);
  check("свёрнута: рельс ~46px", Math.abs((await rightW()) - 46) < 3, `w=${await rightW()}`);
  check("свёрнута: вкладки и кнопки скрыты", !(await vis("rtab-changes")) && !(await vis("btn-commit")));
  check("рельс показывает счётчик изменений", (await page.textContent("#rail-changes")) === "2");
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "rp-rail.png") });

  // перезагрузка — свёрнутость сохраняется
  await page.reload({ waitUntil: "commit" });
  await page.waitForSelector(".oc-side", { timeout: 15000 });
  await page.click(`.oc-session[data-ses="${s1.body.id}"]`).catch(() => null);
  await page.waitForSelector("#view-chat:not(.hidden)", { timeout: 10000 });
  await page.waitForTimeout(300);
  check("после перезагрузки панель осталась свёрнутой", Math.abs((await rightW()) - 46) < 3, `w=${await rightW()}`);

  // рельс открывает нужный раздел
  await page.click('[data-rail="files"]');
  await page.waitForTimeout(200);
  check("иконка «Файлы» разворачивает панель на Файлах", Math.abs((await rightW()) - 340) < 4 && await page.evaluate(() => document.getElementById("rtab-files")!.classList.contains("oc-rtab--active")));
  await page.click("#rtab-changes");

  // проект внутри чужого репо: git-кнопок нет, есть объяснение и кнопка
  await page.click(`.oc-session[data-ses="${s2.body.id}"]`);
  await page.waitForFunction(() => !document.getElementById("rp-gitinit")!.hidden, null, { timeout: 15000 }).catch(() => null);
  check("вложенный проект: показано «Создать git проекта»", await vis("rp-gitinit"));
  check("вложенный проект: git-кнопки скрыты (не дают 409)", !(await vis("btn-commit")));
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "rp-gitinit.png") });
  await page.click("[data-act='git-init']");
  await page.waitForFunction(() => document.getElementById("rp-gitinit")!.hidden, null, { timeout: 15000 }).catch(() => null);
  check("после «Создать git проекта»: блок исчез, git-кнопки есть", !(await vis("rp-gitinit")) && await vis("btn-commit"));
  check("у вложенного проекта появился свой .git", existsSync(join(nested, ".git")));

  check("ноль JS-ошибок в браузере", errors.length === 0, errors.slice(0, 2).join(" | "));
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
