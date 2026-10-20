#!/usr/bin/env bun
// e2e SDK (V2-4.6): типизированный клиент против живого демона.
// Запуск: bun run scripts/e2e-sdk.ts
import { mkdirSync, rmSync } from "node:fs";
import { DirigoClient, DirigoError } from "../sdk/dirigo";

const PORT = 7283;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = `${import.meta.dir}/../.smoke-sdk`;
rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });

const server = Bun.spawn([process.execPath, "run", "src/server.ts"], {
  env: { ...process.env, PORT: String(PORT), DIRIGO_DATA: DATA },
  stdout: "ignore", stderr: "ignore",
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  ok ? pass++ : fail++;
};

try {
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch {} await sleep(300); }
  const orch = new DirigoClient({ host: BASE });

  const health = await orch.health();
  check("sdk: health", health.ok === true && Array.isArray(health.agents) && health.agents.length >= 11, `${health.agents.length} агентов`);

  const agents = await orch.agents();
  check("sdk: agents", agents.some((a) => a.id === "claude-code") && agents.some((a) => a.id === "gemini"), `${agents.length}`);

  const projects = await orch.projects();
  let pid = projects[0]?.id;
  if (!pid) {
    const created = await orch.call("/api/projects", { method: "POST", body: { name: "sdk-e2e", path: process.cwd() } }) as any;
    pid = created.id;
  }
  check("sdk: projects", !!pid, String(pid));

  // run с копией
  const { pickAgent } = await import("./pick-agent");
  const webId = await pickAgent(BASE, "web") ?? "cursor";
  const s = await orch.run({ agentId: webId, prompt: "sdk e2e", projectId: pid!, mode: "web", worktree: true });
  check("sdk: run (копия)", !!s.id && !!s.worktree, s.id);

  const list = await orch.sessions();
  check("sdk: sessions", list.some((x) => x.id === s.id), `${list.length}`);

  const diff = await orch.diff(s.id);
  check("sdk: diff", Array.isArray(diff.files), `+${diff.added} -${diff.deleted}`);

  const checks = await orch.checks(s.id);
  check("sdk: checks", typeof checks.ok === "boolean", `${checks.ok}`);

  const c1 = await orch.call("/api/queue", { method: "POST", body: { type: "diff", payload: { id: s.id } } }) as any;
  check("sdk: queue", !!c1.id, c1.id);
  const q = await orch.queueItem(c1.id);
  check("sdk: queueItem", q?.status === "done" || q?.status === "queued" || q?.status === "running", q?.status);

  const sk = await orch.skills("bun");
  check("sdk: skills(query)", Array.isArray(sk) && sk.length >= 1, `${sk.length}`);
  const plugs = await orch.plugins();
  check("sdk: plugins", Array.isArray(plugs.links) && plugs.links.length >= 1, `${plugs.links.length}`);
  const usage = await orch.usage(s.id);
  check("sdk: usage", typeof usage.total === "number", `${usage.total}`);

  // ошибка → DirigoError со статусом
  try {
    await orch.session("нет-такой");
    check("sdk: ошибка → DirigoError", false, "исключения не было");
  } catch (e) {
    check("sdk: ошибка → DirigoError", e instanceof DirigoError && e.status === 404, `${(e as DirigoError).status}`);
  }

  // git-статус через SDK
  const gs = await orch.git(s.id, "status");
  check("sdk: git status", gs.ok === true, gs.detail ?? "-");

  await orch.stop(s.id);
  await fetch(`${BASE}/api/sessions/${s.id}`, { method: "DELETE" });
} catch (e) {
  check("e2e without exceptions", false, String(e));
} finally {
  server.kill();
  try { rmSync(DATA, { recursive: true, force: true }); } catch { /* занято */ }
}
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
