#!/usr/bin/env bun
// Dirigo — MCP-сервер демона (V2-4.5).
//
// Говорит на Model Context Protocol (JSON-RPC 2.0, newline-delimited) по stdio
// и проксирует вызовы в HTTP API демона. Работает как внешний инструмент для
// любых MCP-клиентов (Claude Code, Cursor, custom agents).
//
//   DIRIGO_HOST=http://127.0.0.1:7171 DIRIGO_TOKEN=... bun run scripts/mcp.ts
//
// Инструменты: run_task, list_sessions, get_session, send, diff, apply, revert,
// checks, plans, plan_start, plan_apply, swarm_start, swarm_judge, skills.

const HOST = (process.env.DIRIGO_HOST ?? "http://127.0.0.1:7171").replace(/\/+$/, "");
const TOKEN = process.env.DIRIGO_TOKEN ?? "";
const PROTOCOL_VERSION = "2024-11-05";

const logErr = (...args: unknown[]) => console.error("[mcp]", ...args);

async function api(path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const r = await fetch(HOST + path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
      ...(init.headers ?? {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await r.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: r.status, body };
}

/* ---------------- инструменты ---------------- */

interface Tool { name: string; description: string; inputSchema: Record<string, unknown>; }

const TOOLS: Tool[] = [
  {
    name: "run_task",
    description: "Запустить задачу у агента. worktree=true — работа в копии проекта (git worktree).",
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string" }, prompt: { type: "string" },
        projectId: { type: "string" }, mode: { type: "string", enum: ["cli", "web", "persistent", "pty"] },
        worktree: { type: "boolean" }, model: { type: "string" },
      },
      required: ["agentId", "prompt"],
    },
  },
  {
    name: "list_sessions",
    description: "Список сессий с статусами (и меткой копии, если режим Solo).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_session",
    description: "Детали сессии по id (статус, сообщения, копия, точки возврата).",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "send",
    description: "Отправить сообщение агенту в живой сессии.",
    inputSchema: { type: "object", properties: { id: { type: "string" }, text: { type: "string" } }, required: ["id", "text"] },
  },
  {
    name: "diff",
    description: "Построчный дифф копии сессии к боевому проекту.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "apply",
    description: "Применить изменения копии в боевой проект (необратимо; force — для массовых удалений).",
    inputSchema: { type: "object", properties: { id: { type: "string" }, force: { type: "boolean" } }, required: ["id"] },
  },
  {
    name: "revert",
    description: "Вернуть копию сессии к точке возврата.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "checks",
    description: "Прогнать авто-проверки проекта в копии сессии.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "plans",
    description: "Список планов Orchestrator.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "plan_start",
    description: "Запустить план: копия + агент на каждый эпик.",
    inputSchema: { type: "object", properties: { planId: { type: "string" } }, required: ["planId"] },
  },
  {
    name: "plan_apply",
    description: "Применить все проверенные эпики плана.",
    inputSchema: { type: "object", properties: { planId: { type: "string" } }, required: ["planId"] },
  },
  {
    name: "swarm_start",
    description: "Запустить рой: копия + агент на каждый участок.",
    inputSchema: { type: "object", properties: { swarmId: { type: "string" } }, required: ["swarmId"] },
  },
  {
    name: "swarm_judge",
    description: "Судья разберёт дедлоки роя (CONTINUE/RETRY/SKIP).",
    inputSchema: { type: "object", properties: { swarmId: { type: "string" } }, required: ["swarmId"] },
  },
  {
    name: "skills",
    description: "Список скиллов проекта (или полный текст одного).",
    inputSchema: { type: "object", properties: { name: { type: "string" } } },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; content: string }> {
  const result = async (r: { status: number; body: any }): Promise<{ ok: boolean; content: string }> => ({
    ok: r.status >= 200 && r.status < 300,
    content: JSON.stringify(r.body, null, 2),
  });
  switch (name) {
    case "run_task": {
      const body: Record<string, unknown> = {
        agentId: args.agentId, prompt: args.prompt, mode: args.mode ?? "cli",
        projectId: args.projectId, model: args.model,
      };
      if (args.worktree === true) body.worktree = true;
      if (!body.projectId) {
        const pr = await api("/api/projects");
        const first = (pr.body ?? [])[0];
        if (!first) return { ok: false, content: "нет проектов — создай проект в UI демона" };
        body.projectId = first.id;
      }
      return result(await api("/api/sessions", { method: "POST", body }));
    }
    case "list_sessions": return result(await api("/api/sessions"));
    case "get_session": return result(await api(`/api/sessions/${args.id}`));
    case "send": return result(await api(`/api/sessions/${args.id}/messages`, { method: "POST", body: { text: args.text } }));
    case "diff": return result(await api(`/api/sessions/${args.id}/diff`));
    case "apply": return result(await api(`/api/sessions/${args.id}/apply`, { method: "POST", body: { confirmed: true, force: args.force === true } }));
    case "revert": return result(await api(`/api/sessions/${args.id}/revert`, { method: "POST" }));
    case "checks": return result(await api(`/api/sessions/${args.id}/checks`, { method: "POST" }));
    case "plans": return result(await api("/api/plans"));
    case "plan_start": return result(await api(`/api/plans/${args.planId}/start`, { method: "POST" }));
    case "plan_apply": return result(await api(`/api/plans/${args.planId}/apply-all`, { method: "POST" }));
    case "swarm_start": return result(await api(`/api/swarm/${args.swarmId}/start`, { method: "POST" }));
    case "swarm_judge": return result(await api(`/api/swarm/${args.swarmId}/judge`, { method: "POST" }));
    case "skills": return result(await api(args.name ? `/api/skills/${args.name}` : "/api/skills"));
    default: return { ok: false, content: `неизвестный инструмент: ${name}` };
  }
}

/* ---------------- JSON-ROC loop ---------------- */

interface Rpc { jsonrpc: "2.0"; id?: number | string | null; method: string; params?: any; }

function reply(id: number | string | null | undefined, result: unknown): void {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: id ?? null, result }) + "\n");
}
function replyError(id: number | string | null | undefined, code: number, message: string): void {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }) + "\n");
}

async function handle(msg: Rpc): Promise<void> {
  const id = msg.id;
  try {
    switch (msg.method) {
      case "initialize":
        return reply(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "dirigo", version: "2.0.0" },
        });
      case "ping":
        return reply(id, {});
      case "tools/list":
        return reply(id, { tools: TOOLS });
      case "tools/call": {
        const name = String(msg.params?.name ?? "");
        const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
        const r = await callTool(name, args);
        return reply(id, {
          content: [{ type: "text", text: r.content }],
          isError: !r.ok,
        });
      }
      case "notifications/initialized":
      case "initialized":
        return; // уведомление — без ответа
      default:
        if (id !== undefined && id !== null) return replyError(id, -32601, `method not found: ${msg.method}`);
        return; // неизвестное уведомление — молча
    }
  } catch (e) {
    if (id !== undefined && id !== null) return replyError(id, -32603, String(e));
  }
}

// чтение newline-delimited JSON из stdin
let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(chunk);
  let idx: number;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg: Rpc;
    try { msg = JSON.parse(line); } catch (e) { replyError(null, -32700, `parse error: ${String(e)}`); continue; }
    await handle(msg);
  }
}
