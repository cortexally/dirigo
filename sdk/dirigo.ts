/**
 * Dirigo — TypeScript SDK (V2-4.6).
 *
 * Типизированный клиент поверх HTTP API демона. Ноль зависимостей (fetch),
 * работает в Bun/Node 18+/браузере. Контракты синхронизируются с сервером
 * кодогеном: `bun run sdk:contracts` (см. scripts/sdk-contracts.ts).
 *
 *   const orch = new DirigoClient({ host: "http://127.0.0.1:7171", token: "…" });
 *   const health = await orch.health();
 *   const s = await orch.run({ agentId: "hermes", prompt: "привет", projectId, worktree: true });
 *   const diff = await orch.diff(s.id);
 */

export interface ClientOptions {
  host?: string;
  token?: string;
  fetchImpl?: typeof fetch;
}

export interface SessionLite {
  id: string;
  projectId: string;
  agentId: string;
  title: string;
  prompt: string;
  mode: string;
  status: string;
  worktree?: { kind: string; path: string; baseRef?: string; createdAt: number };
  [k: string]: unknown;
}

export interface HealthInfo {
  ok: boolean;
  agents: string[];
  running: number;
  worktrees?: { active: number; orphans: number; max: number; bytes: number };
  checks?: { sessions: number; failing: number };
  processes?: { live: number; max: number };
  orchestrator?: { plans: number; epics: number; applied: number; conflicts: number };
  uptimeMs?: number;
}

export interface DiffFile { path: string; status: string; lines: unknown[]; added: number; deleted: number; }
export interface DiffResult { ok?: boolean; files: DiffFile[]; added: number; deleted: number; }

export class DirigoError extends Error {
  constructor(message: string, readonly status: number, readonly body?: unknown) {
    super(message);
    this.name = "DirigoError";
  }
}

export class DirigoClient {
  readonly host: string;
  private token: string;
  private fetchImpl: typeof fetch;

  constructor(opts: ClientOptions = {}) {
    this.host = (opts.host ?? process.env.DIRIGO_HOST ?? "http://127.0.0.1:7171").replace(/\/+$/, "");
    this.token = opts.token ?? process.env.DIRIGO_TOKEN ?? "";
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const r = await this.fetchImpl(this.host + path, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        ...(init.headers ?? {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
    const text = await r.text();
    let body: unknown = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    if (!r.ok) throw new DirigoError(`${init.method ?? "GET"} ${path} → ${r.status}`, r.status, body);
    return body as T;
  }

  /* ---------------- базовое ---------------- */
  health(): Promise<HealthInfo> { return this.call("/api/health"); }
  agents(): Promise<any[]> { return this.call("/api/agents"); }
  projects(): Promise<any[]> { return this.call("/api/projects"); }
  skills(query?: string): Promise<any[]> { return this.call(`/api/skills${query ? `?q=${encodeURIComponent(query)}` : ""}`); }
  plugins(): Promise<{ panels: any[]; links: any[] }> { return this.call("/api/plugins"); }
  usage(sessionId?: string): Promise<{ total: number; sessions: any[] }> { return this.call(`/api/usage${sessionId ? `?session=${encodeURIComponent(sessionId)}` : ""}`); }

  /* ---------------- авторизация и бэкап ---------------- */
  authCheck(): Promise<{ required: boolean; authenticated: boolean }> { return this.call("/api/auth/check"); }
  login(token: string): Promise<any> { return this.call("/api/auth/login", { method: "POST", body: { token } }); }
  logout(): Promise<any> { return this.call("/api/auth/logout", { method: "POST" }); }
  /** URL SSE-потока (события session.output/status, sessions.changed). */
  eventsUrl(): string { return `${this.host}/api/events`; }
  exportData(): Promise<any> { return this.call("/api/export"); }
  importData(data: unknown): Promise<any> { return this.call("/api/import", { method: "POST", body: data }); }

  /* ---------------- сессии ---------------- */
  sessions(): Promise<SessionLite[]> { return this.call("/api/sessions"); }
  session(id: string): Promise<any> { return this.call(`/api/sessions/${id}`); }
  run(opts: {
    agentId: string; prompt: string; projectId: string;
    mode?: "cli" | "web" | "persistent" | "pty";
    worktree?: boolean | "git" | "copy"; model?: string; title?: string;
  }): Promise<SessionLite> {
    return this.call("/api/sessions", {
      method: "POST",
      body: {
        agentId: opts.agentId, prompt: opts.prompt, projectId: opts.projectId,
        mode: opts.mode ?? "cli", model: opts.model, title: opts.title,
        worktree: opts.worktree,
      },
    });
  }
  stop(id: string): Promise<any> { return this.call(`/api/sessions/${id}/stop`, { method: "POST" }); }
  send(id: string, text: string): Promise<any> { return this.call(`/api/sessions/${id}/messages`, { method: "POST", body: { text } }); }
  log(id: string, n = 200): Promise<{ lines: string[] }> { return this.call(`/api/sessions/${id}/log?n=${n}`); }

  /* ---------------- копии: дифф/применение ---------------- */
  diff(id: string): Promise<DiffResult> { return this.call(`/api/sessions/${id}/diff`); }
  apply(id: string, opts: { force?: boolean } = {}): Promise<any> {
    return this.call(`/api/sessions/${id}/apply`, { method: "POST", body: { confirmed: true, force: opts.force === true } });
  }
  revert(id: string): Promise<any> { return this.call(`/api/sessions/${id}/revert`, { method: "POST" }); }
  checks(id: string): Promise<any> { return this.call(`/api/sessions/${id}/checks`, { method: "POST" }); }
  resolve(id: string, files?: string[]): Promise<any> {
    return this.call(`/api/sessions/${id}/resolve`, { method: "POST", body: files ? { files } : {} });
  }
  git(id: string, action: string, extra: Record<string, unknown> = {}): Promise<any> {
    return this.call(`/api/sessions/${id}/git`, { method: "POST", body: { action, ...extra } });
  }
  acceptance(id: string, criteria: string[]): Promise<any> {
    return this.call(`/api/sessions/${id}/acceptance`, { method: "POST", body: { criteria } });
  }
  review(id: string, input: { action: "comment" | "rework" | "accept" | "send" | "send-selected"; file?: string; lineNo?: number; side?: "old" | "new"; text?: string; noteId?: string; noteIds?: string[] }): Promise<any> {
    return this.call(`/api/sessions/${id}/review`, { method: "POST", body: input });
  }

  /* ---------------- Orchestrator ---------------- */
  plans(): Promise<any[]> { return this.call("/api/plans"); }
  plan(id: string): Promise<any> { return this.call(`/api/plans/${id}`); }
  createPlan(input: { goal: string; projectId: string; agentId: string; verifierAgentId?: string; epics: { title: string; criteria?: string[] }[] }): Promise<any> {
    return this.call("/api/plans", { method: "POST", body: input });
  }
  startPlan(id: string): Promise<any> { return this.call(`/api/plans/${id}/start`, { method: "POST" }); }
  applyPlan(id: string): Promise<any> { return this.call(`/api/plans/${id}/apply-all`, { method: "POST" }); }

  /* ---------------- Swarm ---------------- */
  swarms(): Promise<any[]> { return this.call("/api/swarm"); }
  swarm(id: string): Promise<any> { return this.call(`/api/swarm/${id}`); }
  createSwarm(input: { title: string; goal?: string; projectId: string; agentId: string; judgeAgentId?: string; zones: string[] }): Promise<any> {
    return this.call("/api/swarm", { method: "POST", body: input });
  }
  startSwarm(id: string): Promise<any> { return this.call(`/api/swarm/${id}/start`, { method: "POST" }); }
  judgeSwarm(id: string): Promise<any> { return this.call(`/api/swarm/${id}/judge`, { method: "POST" }); }
  applySwarm(id: string): Promise<any> { return this.call(`/api/swarm/${id}/apply-all`, { method: "POST" }); }

  /* ---------------- Fusion ---------------- */
  fusions(): Promise<any[]> { return this.call("/api/fusion"); }
  fusion(id: string): Promise<any> { return this.call(`/api/fusion/${id}`); }
  createFusion(input: { title: string; prompt: string; projectId: string; agents: string[]; judgeAgentId?: string }): Promise<any> {
    return this.call("/api/fusion", { method: "POST", body: input });
  }
  startFusion(id: string): Promise<any> { return this.call(`/api/fusion/${id}/start`, { method: "POST" }); }
  judgeFusion(id: string): Promise<any> { return this.call(`/api/fusion/${id}/judge`, { method: "POST" }); }
  applyFusion(id: string): Promise<any> { return this.call(`/api/fusion/${id}/apply`, { method: "POST" }); }

  /* ---------------- копии/очередь ---------------- */
  worktrees(): Promise<any> { return this.call("/api/worktrees"); }
  cleanupWorktrees(): Promise<any> { return this.call("/api/worktrees/cleanup", { method: "POST" }); }
  queue(type: string, payload: Record<string, unknown> = {}): Promise<any> {
    return this.call("/api/queue", { method: "POST", body: { type, payload } });
  }
  queueItem(id: string): Promise<any> { return this.call(`/api/queue/${id}`); }
}

export default DirigoClient;
