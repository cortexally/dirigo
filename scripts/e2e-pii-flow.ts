#!/usr/bin/env bun
// Пользовательский флоу «агент вписал персональные данные» — целиком через UI (1.9.2).
//
// Регресс из отчёта владельца 18.10: «пишу ФИО, добавил номер карты, несколько
// коммитов — в Evidence ничего; кнопки «Применить» нет, что она значит?»
// Причины: ФИО шлюз не искал; пакет создавался только при «Применить», а у
// сессии без копии его нет; находки не были видны в панели до коммита.
//
// Сценарии:
//  A. сессия БЕЗ копии: пояснение в панели, бейдж PII у файла (ФИО + карта),
//     Commit → тост с пакетом → пакет «коммит» с PII на экране «Доказательства»;
//  B. режим «Блокировать»: Commit → окно с файлом и строкой → «Отмена» не
//     коммитит → «ОК» коммитит, пакет помечен «применено вопреки политике»;
//  C. сессия В КОПИИ: «Применить» в block → окно → «ОК» → пакет «применение»;
//  D. свои слова из Настроек находятся в файлах;
//  E. сообщение агенту с ФИО в block — не уходит, понятный тост;
//  F. правка журнала → «Проверить» на экране «Доказательства» → нарушение целостности.
//
//   bun run scripts/e2e-pii-flow.ts      (порт 7290, свои данные; E2E_SHOTS=папка — скриншоты)
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { chromium } from "playwright";
import { answerConfirms } from "./confirm-dom";

const PORT = Number(process.env.E2E_PII_PORT ?? 7290);
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = join(import.meta.dir, "..", `.smoke-piiflow-${PORT}`);
const DATA = join(ROOT, "data");
const SHOTS = process.env.E2E_SHOTS ?? "";
rmSync(ROOT, { recursive: true, force: true });
const repo = join(ROOT, "loans");
mkdirSync(repo, { recursive: true });
writeFileSync(join(repo, "loan_calc.py"), "def pay(x):\n    return x\n");
const git = (args: string[], cwd = repo) => Bun.spawnSync(["git", ...args], { cwd }).stdout.toString().trim();
for (const c of [["init", "-q", "-b", "main"], ["config", "user.email", "t@t"], ["config", "user.name", "t"], ["add", "-A"], ["commit", "-qm", "init"]]) git(c);

const server = Bun.spawn([process.execPath, "run", "src/server.ts"], {
  cwd: join(import.meta.dir, ".."),
  env: { ...process.env, PORT: String(PORT), DIRIGO_DATA: DATA },
  stdout: "ignore", stderr: "ignore",
});
const jpost = async (p: string, b: unknown) => {
  const r = await fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
  return { status: r.status, body: await r.json().catch(() => null) as any };
};
const jget = async (p: string) => (await fetch(BASE + p)).json() as any;
let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  ok ? pass++ : fail++;
};
const FIO = "Иванов Иван Константинович";
/** Ждать условие (под нагрузкой гейта фиксированные паузы не годятся). */
const until = async (fn: () => boolean | Promise<boolean>, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await Bun.sleep(200); } return false; };
const CARD = "4111 1111 1111 1111";
let browser: import("playwright").Browser | null = null;

try {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* */ } await Bun.sleep(250); }
  const pid = (await jpost("/api/projects", { name: "loans", path: repo })).body.id;
  // сессия без копии — как у владельца (веб-режим не требует установленного агента)
  const direct = await jpost("/api/sessions", { agentId: "cursor", projectId: pid, mode: "web", prompt: "pii direct" });
  check("сессия без копии создана", direct.status === 201, String(direct.status));
  const sid = direct.body.id;

  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  let dialogs: string[] = [];
  let dialogAnswer: "accept" | "dismiss" = "accept";
  answerConfirms(page, (text) => { dialogs.push(text); return dialogAnswer === "accept" ? "ok" : "cancel"; });
  const toastText = async () => (await page.textContent("#toasts").catch(() => "")) ?? "";
  const shot = async (n: string) => { if (SHOTS) { mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: join(SHOTS, `pii-${n}.png`) }); } };
  await page.goto(BASE, { waitUntil: "commit" });
  await page.waitForSelector(".oc-side", { timeout: 15000 });

  // ── A: агент «вписал» ФИО и карту прямо в проект ──
  writeFileSync(join(repo, "loan_calc.py"), `"""Кредитный калькулятор.\nАвтор: ${FIO}\nКарта: ${CARD}\n"""\ndef pay(x):\n    return x\n`);
  await page.click(`.oc-session[data-ses="${sid}"]`);
  await page.waitForSelector("#view-chat:not(.hidden)", { timeout: 10000 });
  await page.waitForSelector(".oc-pii-badge", { timeout: 15000 }).catch(() => null);
  const note = await page.evaluate(() => { const el = document.getElementById("rp-mode-note")!; return el.hidden ? "" : el.textContent ?? ""; });
  check("A: панель объясняет, что агент правит проект напрямую и где пакет", /напрямую/.test(note) && /коммит/.test(note), note.slice(0, 80));
  check("A: кнопки «Применить» у сессии без копии нет", !(await page.isVisible("#btn-apply")));
  const badge = (await page.textContent(".oc-pii-badge").catch(() => "")) ?? "";
  check("A: у файла бейдж PII (ФИО + карта) ещё до коммита", badge.trim() === "PII·2", badge);
  const tip = (await page.getAttribute(`.oc-file[data-file="loan_calc.py"]`, "title")) ?? "";
  check("A: подсказка называет типы и строки, но не значения", /ФИО/.test(tip) && /карта/.test(tip) && /строки 2, 3/.test(tip) && !tip.includes("Иванов") && !tip.includes("4111"), tip);
  await shot("a-badge");
  await page.fill("#commit-msg", "feat: автор");
  await page.click("#btn-commit");
  await page.waitForFunction(() => /пакет доказательств/.test(document.getElementById("toasts")!.textContent ?? ""), null, { timeout: 15000 }).catch(() => null);
  check("A: тост коммита говорит про пакет и PII", /пакет доказательств/.test(await toastText()) && /PII: 2/.test(await toastText()), (await toastText()).slice(-140));
  check("A: коммит в репозитории проекта", git(["log", "-1", "--format=%s"]) === "feat: автор");
  await page.click("#nav-evidence");
  await page.waitForSelector(".oc-evcard", { timeout: 10000 });
  const card = (await page.textContent(".oc-evcard")) ?? "";
  check("A: на «Доказательствах» пакет от коммита", /коммит/.test(card), card.slice(0, 120));
  check("A: в пакете PII: 2 (в изменениях: 2)", /PII:\s*2/.test(card) && /в изменениях:\s*2/.test(card), card.replace(/\s+/g, " ").slice(0, 200));
  await shot("a-evidence");
  const ledger = readFileSync(join(DATA, "provenance", `${sid}.jsonl`), "utf8");
  check("A: журнал: change.committed и находки без значений", /"change\.committed"/.test(ledger) && !ledger.includes("Иванов") && !ledger.includes("4111"));

  // ── B: «Блокировать»: окно, отмена, затем осознанное исключение ──
  await jpost("/api/policy", { mode: "block" });
  appendFileSync(join(repo, "loan_calc.py"), `# клиент: Пирожков Артур Геннадьевич\n`);
  await page.click(`.oc-session[data-ses="${sid}"]`);
  await page.waitForSelector(".oc-pii-badge", { timeout: 15000 }).catch(() => null);
  const headBefore = git(["rev-parse", "HEAD"]);
  dialogs = []; dialogAnswer = "dismiss";
  await page.click("#btn-commit");
  await until(() => dialogs.length >= 1);
  await page.waitForTimeout(500);
  check("B: окно называет находку, файл и строку", dialogs.length === 1 && /name:1/.test(dialogs[0]!) && /loan_calc\.py: строки 7/.test(dialogs[0]!), (dialogs[0] ?? "нет окна").replace(/\n/g, " ").slice(0, 160));
  check("B: «Отмена» — коммита нет", git(["rev-parse", "HEAD"]) === headBefore);
  dialogs = []; dialogAnswer = "accept";
  await page.click("#btn-commit");
  await until(() => git(["rev-parse", "HEAD"]) !== headBefore);
  await until(async () => ((await jget("/api/evidence")).packs as any[]).filter((p) => p.sessionId === sid).length >= 2);
  check("B: «ОК» — коммит прошёл как осознанное исключение", git(["rev-parse", "HEAD"]) !== headBefore);
  const packsB = (await jget("/api/evidence")).packs as any[];
  const lastB = packsB.filter((p) => p.sessionId === sid).at(-1);
  check("B: пакет помечен «применено вопреки политике»; находки только этого коммита", lastB?.pii?.overridden === 1 && lastB?.pii?.inChanges === 1, JSON.stringify(lastB?.pii));

  // ── C: сессия в копии: «Применить» в block → окно → ОК → пакет «применение» ──
  const copy = await jpost("/api/sessions", { agentId: "cursor", projectId: pid, mode: "web", prompt: "pii copy", worktree: true });
  const cid = copy.body.id;
  const cpath = (await jget(`/api/sessions/${cid}/target`)).path;
  writeFileSync(join(cpath, "contacts.txt"), `менеджер: ivan.petrov@bank.de\n`);
  await page.click(`.oc-session[data-ses="${cid}"]`);
  await page.waitForSelector(".oc-pii-badge", { timeout: 15000 }).catch(() => null);
  check("C: у сессии в копии есть «Применить», пояснения «напрямую» нет", await page.isVisible("#btn-apply") && !(await page.isVisible("#rp-mode-note")));
  dialogs = []; dialogAnswer = "accept";
  await page.click("#btn-apply");
  await until(() => existsSync(join(repo, "contacts.txt")));
  await until(async () => ((await jget("/api/evidence")).packs as any[]).some((p) => p.sessionId === cid));
  check("C: два окна — подтверждение применения и находка PII", dialogs.length === 2 && /email:1/.test(dialogs[1] ?? ""), dialogs.map((d) => d.slice(0, 50)).join(" | "));
  check("C: файл доехал до проекта", existsSync(join(repo, "contacts.txt")));
  const packC = ((await jget("/api/evidence")).packs as any[]).find((p) => p.sessionId === cid);
  check("C: пакет «применение» с находкой", packC?.trigger === "applied" && packC?.pii?.inChanges === 1, JSON.stringify(packC?.pii));

  // ── D: свои слова ──
  await jpost("/api/policy", { mode: "warn" });
  await page.click("#nav-settings");
  await page.waitForSelector("#pii-terms", { state: "visible", timeout: 10000 });
  await page.fill("#pii-terms", "ООО Ромашка\nДоговор 77-ABC");
  await page.click("#pii-terms-save");
  await until(async () => ((await jget("/api/policy")).policy.terms ?? []).length === 2);
  check("D: свои слова сохранены из Настроек", ((await jget("/api/policy")).policy.terms ?? []).length === 2);
  appendFileSync(join(repo, "loan_calc.py"), `# договор 77-abc, ооо ромашка\n`);
  const dd = await jget(`/api/sessions/${sid}/diff`);
  check("D: свои слова находятся в изменениях (без учёта регистра)", dd.pii?.["loan_calc.py"]?.kinds?.custom === 2, JSON.stringify(dd.pii));

  // ── E: сообщение агенту с ФИО в block ──
  await jpost("/api/policy", { mode: "block" });
  const msg = await jpost(`/api/sessions/${sid}/messages`, { text: `напиши письмо: ${FIO}` });
  check("E: сообщение с ФИО не уходит агенту", msg.status === 409 && /персональные данные/.test(msg.body?.error ?? ""), `${msg.status} ${msg.body?.error ?? ""}`);
  await jpost("/api/policy", { mode: "warn" });

  // ── F: нарушение целостности ──
  const lf = join(DATA, "provenance", `${sid}.jsonl`);
  const lines = readFileSync(lf, "utf8").split("\n");
  lines[0] = lines[0]!.replace(/"at":\d+/, '"at":1');
  writeFileSync(lf, lines.join("\n"));
  await page.click("#nav-evidence");
  await page.waitForSelector("#ev-verify", { state: "visible", timeout: 10000 });
  await page.click("#ev-verify");
  await page.waitForFunction(() => /целостности/.test(document.getElementById("toasts")!.textContent ?? ""), null, { timeout: 10000 }).catch(() => null);
  check("F: «Проверить» показывает нарушение целостности", /Нарушения целостности/.test(await toastText()), (await toastText()).slice(-100));
  await shot("f-integrity");

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
