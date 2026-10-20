#!/usr/bin/env bun
// Companion-очередь (V2-4.3): e2e через живой демон. Запуск: bun run scripts/e2e-queue.ts
import { mkdirSync, rmSync } from "node:fs";

const PORT = 7286;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = `${import.meta.dir}/../.smoke-queue`;
rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });

const server = Bun.spawn([process.execPath, "run", "src/server.ts"], {
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
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  ok ? pass++ : fail++;
};

try {
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch {} await sleep(300); }

  // неизвестный тип → 400
  const bad = await jpost("/api/queue", { type: "нет-такого" });
  check("unknown type → 400", bad.status === 400 && Array.isArray(bad.body?.allowed), `${bad.status}`);

  // пробный прогон через CLI
  const env = { ...process.env, DIRIGO_HOST: BASE };
  const cli = async (...args: string[]) => {
    const p = Bun.spawn([process.execPath, "run", "scripts/orch.ts", ...args], { env, stdout: "pipe", stderr: "pipe" });
    const out = await new Response(p.stdout).text();
    const code = await p.exited;
    return { code, out: out.trim() };
  };

  // run: внешний web-агент (без спавна) + копия
  const proj = await jpost("/api/projects", { name: "queue-e2e", path: process.cwd() });
  const runCli = await cli("queue", "--type", "run", `agentId=cursor`, `prompt=queue-e2e задача`, `projectId=${proj.body.id}`, "worktree=true", "--json");
  const runBody = runCli.code === 0 ? JSON.parse(runCli.out || "{}") : null;
  check("cli queue run", runCli.code === 0 && !!runBody?.id, runCli.out.slice(0, 100));
  const qid = runBody?.id as string;

  // ждём исполнения
  const deadline = Date.now() + 30000;
  let item: any = null;
  while (Date.now() < deadline) {
    item = await jget(`/api/queue/${qid}`);
    if (item?.status === "done" || item?.status === "failed") break;
    await sleep(500);
  }
  check("очередь исполнила команду", item?.status === "done", `${item?.status} ${item?.error ?? ""}`);
  const sid = (item?.result as any)?.sessionId as string;
  check("run создал сессию с копией", !!sid && ["git", "copy"].includes((item?.result as any)?.worktree), JSON.stringify(item?.result).slice(0, 120));

  // diff через очередь
  const dq = await jpost("/api/queue", { type: "diff", payload: { id: sid } });
  await sleep(2500);
  const dItem = await jget(`/api/queue/${dq.body.id}`);
  check("queue diff", dItem?.status === "done" && typeof dItem?.result?.files === "number", JSON.stringify(dItem?.result).slice(0, 80));

  // checks без команд проверок в копии — вердикт из очереди
  const cq = await jpost("/api/queue", { type: "checks", payload: { id: sid } });
  await sleep(4000);
  const cItem = await jget(`/api/queue/${cq.body.id}`);
  check("queue checks", cItem?.status === "done" && typeof cItem?.result?.ok === "boolean", `${cItem?.status}`);

  // apply без confirm → failed с внятной ошибкой
  const aq = await jpost("/api/queue", { type: "apply", payload: { id: sid } });
  await sleep(1500);
  const aItem = await jget(`/api/queue/${aq.body.id}`);
  check("queue apply без confirm → failed", aItem?.status === "failed" && aItem?.error?.includes("confirmed"), aItem?.error?.slice(0, 60));

  // rework: cli-сессия получает follow-up прогон (демон сам перезапустит агента)
  const rq = await jpost("/api/queue", { type: "rework", payload: { id: sid, text: "просьба с телефона" } });
  await sleep(4000);
  const rItem = await jget(`/api/queue/${rq.body.id}`);
  check("rework cli-сессии → follow-up", rItem?.status === "done" && (rItem?.result as any)?.sent === "cli", `${rItem?.status} ${JSON.stringify(rItem?.result ?? rItem?.error ?? "").slice(0, 80)}`);

  // список очереди
  const list = await jget("/api/queue");
  check("GET /api/queue", Array.isArray(list) && list.length >= 4, `${list?.length}`);

  // чистка
  await fetch(`${BASE}/api/sessions/${sid}`, { method: "DELETE" });
  await fetch(`${BASE}/api/projects/${proj.body.id}`, { method: "DELETE" });
} catch (e) {
  check("e2e without exceptions", false, String(e));
} finally {
  server.kill();
  try { rmSync(DATA, { recursive: true, force: true }); } catch { /* занято */ }
}
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
