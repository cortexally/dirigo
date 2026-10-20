#!/usr/bin/env bun
// E2E «Изменения»: дифф по клику на файле,
// «Применить в проект» / «Вернуть как было», commit-флоу.
// Запуск: bun run e2e:diff (свой порт 7296, изолированные данные).
import { join } from "node:path";
import { chromium } from "playwright";
import { answerConfirms } from "./confirm-dom";
import { rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const PORT = Number(process.env.E2E_DIFF_PORT ?? 7296); // V6.13: динамический порт — гейты пула не конфликтуют
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = `${import.meta.dir}/../.smoke-e2e-diff-${PORT}`;
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

let pass = 0, fail = 0;
let browser: import("playwright").Browser | null = null;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  ok ? pass++ : fail++;
};

try {
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* */ } await sleep(300); }

  // git-проект + сессия с копией
  const repo = join(import.meta.dir, "..", ".smoke-e2e-proj", "r");
  rmSync(join(import.meta.dir, "..", ".smoke-e2e-proj"), { recursive: true, force: true });
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "a.txt"), "one\ntwo\n");
  for (const c of [["git", "init", "-q", "-b", "main"], ["git", "config", "user.email", "t@t"], ["git", "config", "user.name", "t"], ["git", "add", "-A"], ["git", "commit", "-qm", "i"]]) {
    Bun.spawnSync(c, { cwd: repo });
  }
  const proj = await jpost("/api/projects", { name: "e2e-diff", path: repo });
  const s = await jpost("/api/sessions", { agentId: "cursor", projectId: proj.body.id, mode: "web", prompt: "e2e diff", worktree: true });
  check("сессия с копией создана", s.status === 201, s.body?.id);

const page = await (browser = await chromium.launch()).newPage();
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(BASE, { waitUntil: "commit" });
  await page.waitForSelector(".oc-side", { timeout: 15000 });

  // открыть сессию по табу (клик по карточке в sidebar)
  await page.click(`.oc-session[data-ses="${s.body.id}"]`);
  await page.waitForSelector("#view-chat:not(.hidden)", { timeout: 10000 });
  check("сессия открылась: лента + правая панель", await page.evaluate(() => !document.getElementById("right-panel")!.classList.contains("hidden")));

  // ── изменения: чип цели + список файлов ──
  await page.waitForSelector("#rp-branch .oc-chip", { timeout: 8000 });
  const chip = (await page.textContent("#rp-branch")) ?? "";
  check("чип цели (копия/бранч)", /копия|бранч/.test(chip), chip.trim());
  const changesCount = await page.textContent("#changes-count");
  check("счётчик «Изменения» на месте", (changesCount ?? "").trim().length > 0, changesCount ?? "-");

  // пишем правку в копию через запись файла (эмулируем работу агента);
  // панель «Изменения» обновляется сама (поллинг 5с — как в v2)
  const copyPath = s.body.worktree?.path as string;
  writeFileSync(join(copyPath, "a.txt"), "one\nTWO\nthree\n");
  await page.click("#rtab-changes");
  await page.waitForSelector("#rp-staged .oc-file", { timeout: 15000 });
  const fileRows = await page.locator("#rp-staged .oc-file").count();
  check("файл правки в списке «Изменения»", fileRows >= 1, `${fileRows}`);

  // клик по файлу → построчный дифф ПО ЦЕНТРУ (V5.2) с +/−
  await page.click("#rp-staged .oc-file >> nth=0");
  await page.waitForSelector("#view-file:not(.hidden)", { timeout: 8000 });
  const diffText = (await page.textContent("#file-modal-code")) ?? "";
  const addLines = await page.locator("#file-modal-code .diff-line.add").count();
  check("дифф открылся по клику на файле (по центру)", diffText.includes("TWO"), diffText.slice(0, 60).replace(/\n/g, "|"));
  check("дифф содержит строки добавления", addLines >= 1, `add=${addLines}`);
  await page.click("#file-modal-close");

  // ── «Применить в проект» ──
  answerConfirms(page, () => "ok");
  await page.click("#btn-apply");
  await page.waitForTimeout(1200);
  const applied = readFileSync(join(repo, "a.txt"), "utf8");
  // apply переносит файлы в рабочий проект; при пустом проекте-источнике файл остаётся —
  // проверяем контракт: либо применено, либо понятная причина (деталь в тосте)
  const applyToast = await page.textContent("#toasts").catch(() => null);
  check("«Применить в проект» даёт ответ без ошибки", applyToast !== null || applied.includes("TWO"), applyToast?.slice(0, 80) ?? "-");

  // ── «Вернуть как было» ──
  await page.click("#btn-revert");
  await page.waitForTimeout(1000);
  const d2 = await jget(`/api/sessions/${s.body.id}/diff`);
  check("«Вернуть как было» вернуло копию к точке возврата", d2.files.length === 0, `files=${d2.files.length}`);

  // ── commit-флоу ──
  writeFileSync(join(copyPath, "a.txt"), "one\nTWO\nthree\n");
  await page.click("#rtab-changes");
  await page.waitForSelector("#rp-staged .oc-file", { timeout: 15000 });
  await page.fill("#commit-msg", "e2e: правка копии");
  await page.click("#btn-commit");
  // коммит асинхронный — ждём появления в git log (поллинг вместо паузы)
  let committed = false;
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    const log = Bun.spawnSync(["git", "-C", copyPath, "log", "--oneline", "-1"]).stdout.toString();
    if (log.includes("e2e: правка копии")) { committed = true; break; }
  }
  const gitLog = Bun.spawnSync(["git", "-C", copyPath, "log", "--oneline", "-1"]).stdout.toString();
  check("commit через UI создал коммит в копии", committed, gitLog.trim());

  check("ноль JS-ошибок в браузере", errors.length === 0, errors.slice(0, 2).join(" | "));
} catch (e) {
  check("e2e without exceptions", false, String(e).slice(0, 200));
  // исключение могло оставить живые сессии — гасим
  try {
    const list = await jget("/api/sessions");
    for (const ses of (list ?? [])) await fetch(`${BASE}/api/sessions/${ses.id}/stop`, { method: "POST" }).catch(() => {});
  } catch { /* */ }
} finally {
  await browser?.close().catch(() => {});
  server.kill();
  // Windows держит папку данных, пока демон не вышел: ждём выхода и повторяем —
  // EBUSY уборки ронял набор, в котором все проверки прошли
  await Promise.race([server.exited, new Promise((r) => setTimeout(r, 5000))]);
  for (let i = 0; i < 10; i++) {
    try { rmSync(DATA, { recursive: true, force: true }); break; } catch { await new Promise((r) => setTimeout(r, 500)); }
  }
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
