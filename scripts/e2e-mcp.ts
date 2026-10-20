#!/usr/bin/env bun
// e2e MCP-сервера (V2-4.5): поднимаем демон, гоняем JSON-RPC через stdin/stdout.
import { mkdirSync, rmSync } from "node:fs";

const PORT = 7288;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = `${import.meta.dir}/../.smoke-mcp`;
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

// MCP-клиент: пишем строки, читаем ответы
class McpClient {
  private proc: Bun.Subprocess;
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private buf = "";
  private nextId = 1;
  constructor(env: Record<string, string>) {
    this.proc = Bun.spawn([process.execPath, "run", "scripts/mcp.ts"], {
      env, stdin: "pipe", stdout: "pipe", stderr: "ignore",
    });
    this.reader = this.proc.stdout.getReader();
  }
  private async send(obj: unknown) {
    await this.proc.stdin.write(JSON.stringify(obj) + "\n");
    await this.proc.stdin.flush();
  }
  async request(method: string, params?: unknown): Promise<any> {
    const id = this.nextId++;
    await this.send({ jsonrpc: "2.0", id, method, params });
    return this.readResponse(id);
  }
  async notify(method: string, params?: unknown) {
    await this.send({ jsonrpc: "2.0", method, params });
  }
  private async readResponse(id: number): Promise<any> {
    const dec = new TextDecoder();
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const idx = this.buf.indexOf("\n");
      if (idx < 0) {
        const { value, done } = await this.reader.read();
        if (done) throw new Error("mcp closed");
        this.buf += dec.decode(value, { stream: true });
        continue;
      }
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.id === id) return msg;
      // чужие id — пропускаем (уведомления без ответа)
    }
    throw new Error("mcp timeout");
  }
  kill() { try { this.proc.kill(); } catch { /* уже мёртв */ } }
}

try {
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch {} await sleep(300); }
  const { pickAgent } = await import("./pick-agent");
  const mcpWebAgent = await pickAgent(BASE, "web") ?? "cursor";
  const mcp = new McpClient({ ...process.env, DIRIGO_HOST: BASE });

  const init = await mcp.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "1" } });
  check("initialize", init.result?.serverInfo?.name === "dirigo" && !!init.result?.capabilities?.tools, JSON.stringify(init.result?.serverInfo));
  await mcp.notify("notifications/initialized");

  const ping = await mcp.request("ping");
  check("ping", ping.result !== undefined && !ping.error, "");

  const tools = await mcp.request("tools/list");
  const names = (tools.result?.tools ?? []).map((t: any) => t.name);
  check("tools/list", names.includes("run_task") && names.includes("diff") && names.includes("apply") && names.length >= 10, `${names.length} инструментов`);

  const bad = await mcp.request("tools/call", { name: "нет-такого", arguments: {} });
  check("unknown tool → isError", bad.result?.isError === true, "");

  // реальный вызов: создать проект + сессию через run_task с копией
  const proj = await jpost("/api/projects", { name: "mcp-e2e", path: process.cwd() });
  const run = await mcp.request("tools/call", {
    name: "run_task", arguments: { agentId: mcpWebAgent, prompt: "mcp e2e", projectId: proj.body.id, mode: "web", worktree: true },
  });
  const runBody = JSON.parse(run.result?.content?.[0]?.text ?? "{}");
  check("run_task (копия)", run.result?.isError === false && !!runBody.worktree, runBody.id ?? "");
  const sid = runBody.id as string;

  const ls = await mcp.request("tools/call", { name: "list_sessions", arguments: {} });
  check("list_sessions", ls.result?.isError === false && (await ls.result?.content?.[0]?.text ?? "[]").includes(sid), "");

  const diff = await mcp.request("tools/call", { name: "diff", arguments: { id: sid } });
  check("get_diff", diff.result?.isError === false && JSON.parse(diff.result.content[0].text).files !== undefined, "");

  const checks = await mcp.request("tools/call", { name: "checks", arguments: { id: sid } });
  check("checks", checks.result?.isError === false, "");

  const skills = await mcp.request("tools/call", { name: "skills", arguments: {} });
  check("skills", skills.result?.isError === false && skills.result.content[0].text.includes("tdd-red-green"), "");

  const ping404 = await mcp.request("tools/call", { name: "get_session", arguments: { id: "нет-такого" } });
  check("get_session 404 → isError", ping404.result?.isError === true, "");

  mcp.kill();
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
