#!/usr/bin/env bun
// Исправления по handoff промо-съёмки 1.9.3 (docs/promo_agent_issues_handoff.md).
//
//  №9 заголовки сессий — по задаче, а не «ACP — <проект> [копия]» у всех;
//  №8 копия-сирота, которую держит процесс: слот освобождается, ответ честный,
//     папка удаляется, когда процесс её отпустит;
//  №7 разовая задача claude-code получает право записи; пустой дифф при патче
//     в ответе — не «успех»;
//  №10 итог гейта — числа, а не «~NaN».
//
//   bun run scripts/promo-fixes-test.ts     (порт 7280)
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const PORT = Number(process.env.PROMO_FIX_PORT ?? 7280);
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = join(import.meta.dir, "..", `.smoke-promo-fixes-${PORT}`);
rmSync(ROOT, { recursive: true, force: true });
const repo = join(ROOT, "repo");
mkdirSync(repo, { recursive: true });
writeFileSync(join(repo, "a.txt"), "x\n");
for (const c of [["git", "init", "-q", "-b", "main"], ["git", "config", "user.email", "t@t"], ["git", "config", "user.name", "t"], ["git", "add", "-A"], ["git", "commit", "-qm", "i"]]) Bun.spawnSync(c, { cwd: repo });

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  ok ? pass++ : fail++;
};

// ── №9: заголовки ──
const { sessionTitleFor } = await import("../src/session-title");
const def = { label: "Kilo", web: { label: "Kilo (сайт)" }, ptyCommand: { label: "Терминал (TUI)" } };
check("№9 ACP: заголовок по задаче", sessionTitleFor("persistent", def, "northwind-api", "Add a GET /api/shipments/stats endpoint\nwith tests", false) === "ACP — Add a GET /api/shipments/stats endpoint");
check("№9 ACP без задачи — по проекту", sessionTitleFor("persistent", def, "northwind-api", "", false) === "ACP — northwind-api");
check("№9 терминал: по задаче, длинная — обрезана с «…»", (() => { const t = sessionTitleFor("pty", def, "p", "x".repeat(120), false); return t.startsWith("Терминал (TUI) — ") && t.endsWith("…") && t.length <= 80; })());
check("№9 вход в агента — как раньше", sessionTitleFor("pty", def, "p", "что угодно", true) === "Вход в Kilo");
check("№9 веб — по проекту (задачи у панели нет)", sessionTitleFor("web", def, "northwind-api", "", false) === "Kilo (сайт) — northwind-api");

// ── №7: claude-code и пустой дифф ──
const { getAgent } = await import("../src/agents/registry");
const cc = getAgent("claude-code")!;
check("№7 claude -p запускается с правом правок (acceptEdits)", cc.argsTemplate.join(" ").includes("--permission-mode acceptEdits") && cc.argsTemplate.includes("-p"), cc.argsTemplate.join(" "));
const { looksLikeUnappliedPatch } = await import("../src/agents/runner");
check("№7 патч в ответе распознаётся", looksLikeUnappliedPatch("Here is the change:\n```diff\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n```"));
check("№7 жалоба на права распознаётся", looksLikeUnappliedPatch("because I couldn't write the files, I have not run the tests"));
check("№7 обычный ответ — не ложная тревога", !looksLikeUnappliedPatch("Готово: добавил функцию mul и тест."));

// ── №10: итог гейта ──
const pre = readFileSync(join(import.meta.dir, "pre-release.ts"), "utf8");
check("№10 итог гейта считает только «N/M», без NaN", /\^\(\\d\+\)\\\/\(\\d\+\)\$/.test(pre) && pre.includes("${passed} из ${total} проверок"));

// ── №4: подтверждения в DOM, а не window.confirm ──
const app = readFileSync(join(import.meta.dir, "..", "web", "app.js"), "utf8");
check("№4 нет нативных confirm()", !/[^.\w]confirm\(/.test(app));
check("№4 диалог: Esc — отмена, Enter — подтвердить", /e\.key === "Escape"[^\n]*done\(false\)/.test(app) && /e\.key === "Enter"[^\n]*done\(true\)/.test(app));
check("№4 находки PII — списком файлов", /oc-confirm__files/.test(app) && /async function piiOverrideConfirm/.test(app));

// ── №8: сирота, которую держит процесс ──
const server = Bun.spawn([process.execPath, "run", "src/server.ts"], {
  cwd: join(import.meta.dir, ".."), env: { ...process.env, PORT: String(PORT), DIRIGO_DATA: join(ROOT, "data") }, stdout: "ignore", stderr: "ignore",
});
const jpost = async (p: string, b: unknown) => { const r = await fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }); return { status: r.status, body: await r.json().catch(() => null) as any }; };
const jget = async (p: string) => (await fetch(BASE + p)).json() as any;
let holder: Bun.Subprocess | null = null;
try {
  for (let i = 0; i < 160; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* */ } await Bun.sleep(250); }
  const pid = (await jpost("/api/projects", { name: "pf", path: repo })).body.id;
  const s = await jpost("/api/sessions", { agentId: "cursor", projectId: pid, mode: "web", prompt: "pf", worktree: true });
  const copy = (await jget(`/api/sessions/${s.body.id}/target`)).path as string;
  check("№8 копия создана", !!copy && existsSync(copy), copy);
  // процесс с рабочей папкой внутри копии — Windows не даёт удалить такую папку
  const node = Bun.which("node") ?? process.execPath;
  holder = Bun.spawn([node, "-e", "setInterval(()=>{},1000)"], { cwd: copy, stdout: "ignore", stderr: "ignore" });
  await Bun.sleep(800);
  const before = (await jget("/api/worktrees")).length ?? (await jget("/api/worktrees")).worktrees?.length;
  await fetch(`${BASE}/api/sessions/${s.body.id}`, { method: "DELETE" });
  await Bun.sleep(1500);
  const r = await jpost("/api/worktrees/cleanup", {});
  const held = process.platform === "win32" && existsSync(copy);
  check("№8 ответ честный: удалённое и освобождённое — раздельно", typeof r.body?.released === "number" && typeof r.body?.pending === "number", JSON.stringify(r.body));
  const list = await jget("/api/worktrees");
  const listed = (Array.isArray(list) ? list : list.worktrees ?? []).some((w: any) => w.sessionId === s.body.id);
  check("№8 слот копии освобождён, даже если папку держит процесс", !listed, `в списке: ${listed}, держится: ${held}, было: ${before}`);
  if (held) check("№8 папка в «удалить позже»", r.body?.pending >= 1 && r.body?.released + r.body?.removed >= 1, JSON.stringify(r.body));
  // процесс отпустил папку — следующая уборка её удаляет
  try { holder.kill(); } catch { /* */ }
  await Bun.sleep(1200);
  const r2 = await jpost("/api/worktrees/cleanup", {});
  check("№8 когда процесс отпустил папку — она удалена", !existsSync(copy) && r2.body?.pending === 0, JSON.stringify(r2.body));
} catch (e) {
  check("без исключений", false, String(e).slice(0, 240));
} finally {
  try { holder?.kill(); } catch { /* */ }
  server.kill();
  await Bun.sleep(500);
  for (let i = 0; i < 5; i++) { try { rmSync(ROOT, { recursive: true, force: true }); break; } catch { await Bun.sleep(800); } }
}
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
