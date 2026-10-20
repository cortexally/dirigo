// Минимальный MCP-клиент (streamable HTTP, JSON-RPC 2.0) — для базы знаний
// компании (CoAlly Nexus: https://coally.cortexally.ai/mcp, ключ — Bearer).
//
// Сервер может ответить как application/json, так и text/event-stream (SSE с
// одним или несколькими событиями) — разбираем оба. Mcp-Session-Id из
// initialize передаём дальше, как требует спецификация.

import pkg from "../package.json";

export interface McpTool { name: string; description?: string; inputSchema?: unknown; }
export interface McpCallResult { ok: boolean; status?: number; error?: string; code?: string; result?: any; }

export class McpHttpClient {
  private sessionId: string | null = null;
  private seq = 0;
  constructor(private url: string, private apiKey: string, private timeoutMs = 8000) {}

  private async rpc(method: string, params?: unknown, notify = false): Promise<McpCallResult> {
    const id = notify ? undefined : ++this.seq;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
          ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
        },
        body: JSON.stringify({ jsonrpc: "2.0", ...(id !== undefined ? { id } : {}), method, ...(params !== undefined ? { params } : {}) }),
        signal: ctrl.signal,
      });
      const sid = res.headers.get("mcp-session-id");
      if (sid) this.sessionId = sid;
      const text = await res.text();
      if (!res.ok) {
        // CoAlly: {"error":"Missing API key","code":"AUTH_REQUIRED"}
        let err = `HTTP ${res.status}`, code: string | undefined;
        try { const j = JSON.parse(text); err = j.error?.message ?? j.error ?? j.detail ?? err; code = j.code; } catch { /* не JSON */ }
        return { ok: false, status: res.status, error: String(err), code };
      }
      if (notify) return { ok: true, status: res.status };
      const msg = parseRpcBody(text, res.headers.get("content-type") ?? "", id!);
      if (!msg) return { ok: false, status: res.status, error: "пустой ответ MCP-сервера" };
      if (msg.error) return { ok: false, status: res.status, error: String(msg.error.message ?? msg.error), code: String(msg.error.code ?? "") };
      return { ok: true, status: res.status, result: msg.result };
    } catch (e) {
      const m = (e as Error)?.name === "AbortError" ? `нет ответа за ${this.timeoutMs / 1000} с` : String((e as Error)?.message ?? e);
      return { ok: false, error: m.slice(0, 160) };
    } finally { clearTimeout(timer); }
  }

  async initialize(): Promise<McpCallResult> {
    const r = await this.rpc("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "dirigo", version: pkg.version },
    });
    if (r.ok) await this.rpc("notifications/initialized", undefined, true);
    return r;
  }

  async listTools(): Promise<{ ok: boolean; tools: McpTool[]; error?: string; status?: number; code?: string }> {
    const r = await this.rpc("tools/list", {});
    return r.ok ? { ok: true, tools: (r.result?.tools ?? []) as McpTool[] } : { ok: false, tools: [], error: r.error, status: r.status, code: r.code };
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult & { text?: string }> {
    const r = await this.rpc("tools/call", { name, arguments: args });
    if (!r.ok) return r;
    // ошибка инструмента приходит как result.isError=true
    const text = ((r.result?.content ?? []) as Array<{ type: string; text?: string }>)
      .filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
    if (r.result?.isError) return { ok: false, status: r.status, error: text.slice(0, 300) || "инструмент вернул ошибку", text };
    return { ...r, text };
  }
}

/** Ответ JSON-RPC из тела: обычный JSON или поток SSE (`data: {...}`). */
export function parseRpcBody(text: string, contentType: string, id: number): any | null {
  // строго по id: в потоке до ответа бывают уведомления (progress) без id
  const pick = (o: any) => (Array.isArray(o) ? o.find((x) => x?.id === id) ?? null : o?.id === id ? o : null);
  if (!contentType.includes("event-stream")) {
    try { return pick(JSON.parse(text)); } catch { /* вдруг SSE без заголовка */ }
  }
  let data = "";
  const events: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("data:")) data += (data ? "\n" : "") + line.slice(5).trimStart();
    else if (line.trim() === "" && data) { events.push(data); data = ""; }
  }
  if (data) events.push(data);
  for (const ev of events) {
    try { const m = pick(JSON.parse(ev)); if (m) return m; } catch { /* не JSON-событие */ }
  }
  return null;
}
