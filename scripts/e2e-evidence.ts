#!/usr/bin/env bun
// E2E доказательств: живой демон → проект → сессия с копией → правка в копии →
// применение → пакет доказательств, трейлеры коммита, выгрузка и проверка.
// Запуск: bun run scripts/e2e-evidence.ts
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const PORT = Number(process.env.EVIDENCE_PORT ?? 7291);
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = join(import.meta.dir, "..");
const DATA = join(tmpdir(), `dirigo-ev-${Date.now().toString(36)}`);
const REPO = join(DATA, "repo");

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? "  — " + detail : ""}`);
  ok ? pass++ : fail++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd: string[], cwd: string) => Bun.spawnSync(cmd, { cwd });

rmSync(DATA, { recursive: true, force: true });
mkdirSync(REPO, { recursive: true });
writeFileSync(join(REPO, "calc.js"), "export const sum = (a, b) => a + b;\n");
writeFileSync(join(REPO, "README.md"), "# demo\n");
sh(["git", "init", "-q"], REPO);
sh(["git", "config", "user.email", "t@t"], REPO);
sh(["git", "config", "user.name", "t"], REPO);
sh(["git", "add", "-A"], REPO);
sh(["git", "commit", "-qm", "init"], REPO);

const server = Bun.spawn([process.execPath, "run", "src/server.ts"], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), DIRIGO_DATA: DATA, DIRIGO_AUTO_CHECKS: "0" },
  stdout: "ignore", stderr: "ignore",
});
const stop = () => {
  try {
    if (process.platform === "win32") Bun.spawnSync(["taskkill", "/PID", String(server.pid), "/T", "/F"]);
    else process.kill(server.pid, "SIGKILL");
  } catch { /* уже мёртв */ }
};

try {
  let up = false;
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) { up = true; break; } } catch { /* поднимается */ }
    await sleep(300);
  }
  check("демон поднялся", up);
  if (!up) throw new Error("демон не стартовал");

  const jpost = async (p: string, body: unknown) =>
    (await fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json() as Promise<any>;
  const jget = async (p: string) => (await fetch(BASE + p)).json() as Promise<any>;

  const proj = await jpost("/api/projects", { name: "evidence-demo", path: REPO });
  check("проект создан", !!proj.id, JSON.stringify(proj).slice(0, 120));

  // сессия с копией; агент заведомо не установлен — нам важен сам журнал
  const ses = await jpost("/api/sessions", {
    projectId: proj.id, agentId: "claude-code", mode: "cli",
    prompt: "добавь функцию умножения", worktree: "git", model: "test-model",
  });
  check("сессия с копией создана", !!ses.id && !!ses.worktree, JSON.stringify(ses).slice(0, 160));
  const sid = ses.id as string;

  // журнал открылся сразу при создании
  const ev1 = await jget(`/api/sessions/${sid}/evidence`);
  const types = (ev1.ledger ?? []).map((e: any) => e.type);
  check("журнал открыт при создании", types.includes("session.created") && types.includes("agent.started"), types.join(","));
  check("хеш задачи записан", types.includes("prompt.submitted"), types.join(","));
  check("цепочка целая", ev1.verdict?.ok === true, JSON.stringify(ev1.verdict));
  const started = (ev1.ledger ?? []).find((e: any) => e.type === "agent.started");
  check("модель попала в журнал", started?.data?.model === "test-model", JSON.stringify(started?.data));

  // имитируем работу агента в копии
  const wt = ses.worktree.path as string;
  writeFileSync(join(wt, "calc.js"), "export const sum = (a, b) => a + b;\nexport const mul = (a, b) => a * b;\n");
  writeFileSync(join(wt, "NOTES.md"), "сделано агентом\n");

  const diff = await jget(`/api/sessions/${sid}/diff`);
  check("дифф видит правки копии", (diff.files ?? []).length >= 2, `${(diff.files ?? []).length}`);

  // коммит в копии — проверяем трейлеры
  const git = await jpost(`/api/sessions/${sid}/git`, { action: "commit", message: "feat: умножение" });
  check("коммит в копии сделан", git.ok === true, JSON.stringify(git).slice(0, 140));
  const logOut = sh(["git", "-C", wt, "log", "-1", "--format=%B"], wt).stdout.toString();
  check("трейлер агента в коммите", /Dirigo-Agent: claude-code/.test(logOut), logOut.slice(0, 200));
  check("трейлер модели в коммите", /Dirigo-Model: test-model/.test(logOut), logOut.slice(0, 200));
  check("трейлер головы журнала", /Dirigo-Ledger-Head: [0-9a-f]{16}/.test(logOut), logOut.slice(0, 200));

  // применение → пакет
  const applied = await jpost(`/api/sessions/${sid}/apply`, { confirmed: true, approvedBy: "ilya" });
  check("изменения применены", applied.applied?.length >= 1, JSON.stringify(applied).slice(0, 160));
  check("ответ содержит пакет", !!applied.evidence?.packId, JSON.stringify(applied.evidence));
  check("правка доехала до проекта", readFileSync(join(REPO, "calc.js"), "utf8").includes("mul"));

  const ev2 = await jget(`/api/sessions/${sid}/evidence`);
  check("пакет сохранён", (ev2.packs ?? []).length === 1, `${(ev2.packs ?? []).length}`);
  const pack = ev2.packs[0];
  check("пакет: кто одобрил", pack?.review?.approvedBy === "ilya", JSON.stringify(pack?.review).slice(0, 120));
  check("пакет: список файлов", (pack?.review?.files ?? []).length >= 2, `${(pack?.review?.files ?? []).length}`);
  check("пакет: подписан", pack?.signature?.alg === "ed25519");
  check("пакет: коммит зафиксирован", typeof pack?.result?.commit === "string" && pack.result.commit.length >= 7, String(pack?.result?.commit));
  check("пакет: журнал признан целым", pack?.ledger?.intact === true);

  // откат тоже фиксируется
  await jpost(`/api/sessions/${sid}/revert`, {});
  const ev3 = await jget(`/api/sessions/${sid}/evidence`);
  check("откат записан в журнал", (ev3.ledger ?? []).some((e: any) => e.type === "change.reverted"));
  check("цепочка цела после всех событий", ev3.verdict?.ok === true, JSON.stringify(ev3.verdict));

  // выгрузка и сводная проверка
  const bundleRes = await fetch(`${BASE}/api/evidence/bundle`);
  check("выгрузка отдаётся как файл", (bundleRes.headers.get("content-disposition") ?? "").includes("attachment"));
  const bundle = await bundleRes.json() as any;
  check("выгрузка: пакет внутри", (bundle.packs ?? []).length === 1);
  check("выгрузка: подписи валидны", bundle.verification?.signatures?.valid === 1, JSON.stringify(bundle.verification?.signatures));
  check("выгрузка: открытый ключ приложен", String(bundle.publicKey?.pem ?? "").includes("BEGIN PUBLIC KEY"));

  const verdict = await jget("/api/evidence/verify");
  check("сводная проверка зелёная", verdict.ok === true, JSON.stringify(verdict));

  const list = await jget("/api/evidence");
  check("список пакетов отдаётся", (list.packs ?? []).length === 1 && list.packs[0].approvedBy === "ilya", JSON.stringify(list.packs?.[0] ?? {}).slice(0, 160));

  // подделка журнала ловится сводной проверкой
  const ledgerFile = join(DATA, "provenance", `${sid}.jsonl`);
  check("файл журнала на месте", existsSync(ledgerFile), ledgerFile);
  const lines = readFileSync(ledgerFile, "utf8").trim().split("\n");
  const hacked = JSON.parse(lines[1]!);
  hacked.data.agentId = "someone-else";
  lines[1] = JSON.stringify(hacked);
  writeFileSync(ledgerFile, lines.join("\n") + "\n");
  const after = await jget("/api/evidence/verify");
  check("подмена журнала обнаружена", after.ok === false && (after.brokenLedgers ?? []).includes(sid), JSON.stringify(after));
} finally {
  stop();
  try { rmSync(DATA, { recursive: true, force: true }); } catch { /* Windows держит файлы — приберёт следующий прогон */ }
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
