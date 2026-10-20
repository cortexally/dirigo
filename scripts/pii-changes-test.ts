#!/usr/bin/env bun
// Шлюз PII 1.9.1: проверяется не только первая задача, но и сообщения агенту,
// и строки, которые агент ДОБАВИЛ в файлы (перед «Применить» и коммитом).
// Плюс воспроизведение «нарушений» на экране «Доказательства» — это нарушения
// ЦЕЛОСТНОСТИ (правка журнала/пакета), а не находки PII.
//
// Как воспроизвести руками (то же делает тест):
//   1) Настройки → шлюз PII = block; агент вписал в файл e-mail клиента →
//      «Применить» остановлено, видно файл и строки; «продолжить» — исключение в журнале.
//   2) Поправить любую строку в data/provenance/<сессия>.jsonl → «Проверить»
//      на экране «Доказательства» покажет «Нарушения целостности: … журналов».
//
//   bun run scripts/pii-changes-test.ts     (порт 7294, свои данные)
import { join } from "node:path";
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";

const PORT = Number(process.env.PII_PORT ?? 7294);
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = join(import.meta.dir, "..", `.smoke-pii-${PORT}`);
const DATA = join(ROOT, "data");
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  ok ? pass++ : fail++;
};

// ── модуль: scanChanges ──
process.env.DIRIGO_DATA = DATA;
const { scanChanges } = await import("../src/policy");
const warn = { mode: "warn" as const, detectors: ["email", "phone", "iban", "card", "secret", "jwt"] as any, allowPaths: [] as string[] };
const file = (path: string, lines: Array<[string, string, number | null]>, status = "modified") =>
  ({ path, status, lines: lines.map(([kind, text, newNo]) => ({ kind, text, newNo })) });
// scan-ok: ниже синтетические данные, на которых проверяется сам детектор —
// тест PII обязан содержать то, что PII-шлюз должен находить.
const EMAIL = "ivan.petrov@bank.de";
// scan-ok: в удалённой строке — такой же синтетический адрес.
const r1 = scanChanges([file("a.py", [["ctx", "x = 1", 1], ["add", `CLIENT = '${EMAIL}'`, 2], ["del", "old@mail.com", null]])], warn);
check("находит PII в добавленной строке", r1.findings === 1 && r1.byKind.email === 1 && r1.files[0]?.lines[0] === 2, JSON.stringify(r1.byKind));
check("удалённые строки не считаются утечкой", r1.findings === 1);
check("значение не попадает в результат", !JSON.stringify(r1).includes(EMAIL));
check("allowPaths исключает файлы", scanChanges([file("fixtures/a.py", [["add", EMAIL, 1]])], { ...warn, allowPaths: ["fixtures"] }).findings === 0);
check("маска * в allowPaths", scanChanges([file("test/x.spec.ts", [["add", EMAIL, 1]])], { ...warn, allowPaths: ["*.spec.ts"] }).findings === 0);
check("режим off не проверяет", scanChanges([file("a.py", [["add", EMAIL, 1]])], { ...warn, mode: "off" }).findings === 0);
check("block → blocked", scanChanges([file("a.py", [["add", EMAIL, 1]])], { ...warn, mode: "block" }).blocked === true);
check("удалённый файл не проверяется", scanChanges([file("gone.py", [["add", EMAIL, 1]], "deleted")], warn).findings === 0);

// ── сквозной путь через демон ──
const repo = join(ROOT, "repo");
mkdirSync(repo, { recursive: true });
writeFileSync(join(repo, "loan.py"), "def pay(x):\n    return x\n");
for (const c of [["git", "init", "-q", "-b", "main"], ["git", "config", "user.email", "t@t"], ["git", "config", "user.name", "t"], ["git", "add", "-A"], ["git", "commit", "-qm", "i"]]) Bun.spawnSync(c, { cwd: repo });

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
const session = async (pid: string) => {
  const s = await jpost("/api/sessions", { agentId: "cursor", projectId: pid, mode: "web", prompt: "pii", worktree: true });
  const t = await jget(`/api/sessions/${s.body?.id}/target`);
  return { id: s.body?.id as string, copy: t.path as string, status: s.status };
};

try {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* */ } await Bun.sleep(250); }
  const pid = (await jpost("/api/projects", { name: "pii", path: repo })).body.id;

  // 1) warn: применяется, но находка в журнале и пакете
  await jpost("/api/policy", { mode: "warn" });
  const a = await session(pid);
  check("сессия с копией", a.status === 201 && !!a.copy, String(a.status));
  writeFileSync(join(a.copy, "loan.py"), `def pay(x):\n    return x\n\nCLIENT = '${EMAIL}'\n`);
  const ap = await jpost(`/api/sessions/${a.id}/apply`, { confirmed: true });
  check("warn: применение проходит", ap.body?.ok === true, ap.body?.error ?? "");
  const packs = (await jget("/api/evidence")).packs as any[];
  const pa = packs.find((p) => p.sessionId === a.id);
  check("пакет доказательств: PII в изменениях посчитаны", pa?.pii?.inChanges === 1, JSON.stringify(pa?.pii));
  const ledgerA = readFileSync(join(DATA, "provenance", `${a.id}.jsonl`), "utf8");
  check("журнал: policy.scan target=changes с файлом и строкой", /"target":"changes"/.test(ledgerA) && /loan\.py/.test(ledgerA) && /"lines":\[4\]/.test(ledgerA));
  check("журнал не содержит самого значения", !ledgerA.includes(EMAIL));

  // 2) block: остановка с указанием места, проект не тронут; осознанное исключение
  Bun.spawnSync(["git", "-C", repo, "checkout", "-q", "--", "."]);
  Bun.spawnSync(["git", "-C", repo, "add", "-A"]); Bun.spawnSync(["git", "-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "after-a"]);
  await jpost("/api/policy", { mode: "block" });
  const b = await session(pid);
  writeFileSync(join(b.copy, "pii.txt"), `contact ${EMAIL}\ncard 4111 1111 1111 1111\n`);
  const bp = await jpost(`/api/sessions/${b.id}/apply`, { confirmed: true });
  check("block: «Применить» остановлено (409, needsPiiOverride)", bp.status === 409 && bp.body?.needsPiiOverride === true, `${bp.status} ${bp.body?.error ?? ""}`);
  check("block: ответ называет файл и строки", bp.body?.policy?.files?.[0]?.path === "pii.txt" && bp.body.policy.files[0].lines.join(",") === "1,2", JSON.stringify(bp.body?.policy?.files));
  check("block: ответ без самих значений", !JSON.stringify(bp.body).includes(EMAIL) && !JSON.stringify(bp.body).includes("4111"));
  check("block: проект не тронут", !existsSync(join(repo, "pii.txt")));
  const bc = await jpost(`/api/sessions/${b.id}/git`, { action: "commit", message: "pii" });
  check("block: коммит тоже остановлен", bc.status === 409 && bc.body?.needsPiiOverride === true, String(bc.status));
  const bo = await jpost(`/api/sessions/${b.id}/apply`, { confirmed: true, allowPii: true });
  check("исключение (allowPii): применено", bo.body?.ok === true && existsSync(join(repo, "pii.txt")), bo.body?.error ?? "");
  const pb = ((await jget("/api/evidence")).packs as any[]).find((p) => p.sessionId === b.id);
  check("пакет помечает «применено вопреки политике»", pb?.pii?.overridden === 1, JSON.stringify(pb?.pii));

  // 3) сообщения агенту — через тот же шлюз
  const m = await jpost(`/api/sessions/${b.id}/messages`, { text: `напиши клиенту на ${EMAIL}` });
  check("block: сообщение с PII не уходит агенту (409)", m.status === 409 && /персональные данные/.test(m.body?.error ?? ""), `${m.status} ${m.body?.error ?? ""}`);
  const ledgerB = readFileSync(join(DATA, "provenance", `${b.id}.jsonl`), "utf8");
  check("журнал: policy.scan target=message", /"target":"message"/.test(ledgerB));

  // 4) «Нарушения» на экране доказательств = нарушение целостности
  const v0 = await jget("/api/evidence/verify");
  check("до вмешательства: нарушений нет", v0.ok === true, JSON.stringify(v0));
  const lf = join(DATA, "provenance", `${a.id}.jsonl`);
  const lines = readFileSync(lf, "utf8").split("\n");
  lines[0] = lines[0]!.replace(/"at":\d+/, '"at":1');
  writeFileSync(lf, lines.join("\n"));
  const v1 = await jget("/api/evidence/verify");
  check("правка журнала → «нарушения целостности»", v1.ok === false && (v1.brokenLedgers ?? []).includes(a.id), JSON.stringify(v1));
  const app = readFileSync(join(import.meta.dir, "..", "web", "app.js"), "utf8");
  check("UI: подпись «Нарушения целостности» и строка PII в карточке пакета", app.includes("Нарушения целостности") && app.includes("p.pii.inChanges"));
} catch (e) {
  check("без исключений", false, String(e).slice(0, 240));
} finally {
  server.kill();
  await Bun.sleep(400);
  for (let i = 0; i < 5; i++) { try { rmSync(ROOT, { recursive: true, force: true }); break; } catch { await Bun.sleep(800); } }
}
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
