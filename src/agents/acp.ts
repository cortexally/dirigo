// ACP (Agent Client Protocol) — клиент поверх line-delimited JSON-RPC 2.0 в stdio.
// Ноль зависимостей: Bun.spawn + ручной разбор строк.
//
// Подтверждено пробой на kilo 7.8.8 (`kilo acp`):
//   initialize → {protocolVersion, agentCapabilities, authMethods, agentInfo}
//   session/new {cwd, mcpServers} → {sessionId, configOptions}
//   session/load {sessionId, cwd, mcpServers} → {configOptions}      (переподключение)
//   session/set_config_option {sessionId, configId:"model", value} → {configOptions}
//   session/prompt {sessionId, prompt:[{type:"text",text}]} → {stopReason, usage, _meta}
//   notifications: session/update {sessionId, update:{sessionUpdate, messageId?, content?}}
//     available_commands_update | user_message_chunk | agent_thought_chunk |
//     agent_message_chunk | usage_update
//   session/close {sessionId} → {}
//   session/cancel / session/interrupt НЕ реализованы → «Прервать» = kill процесса.

import { secretsEnv } from "../secrets";

export interface AcpConfigOption {
  id: string;
  name: string;
  category: string;
  type: string;
  currentValue: string;
  options?: { value: string; name: string }[];
}

export interface AcpSessionInfo {
  sessionId: string;
  cwd?: string;
  title?: string;
  updatedAt?: string;
}

export type AcpUpdate =
  | { kind: "available_commands"; commands: { name: string; description: string }[] }
  | { kind: "user_message"; messageId: string; text: string }
  | { kind: "thought"; messageId: string; text: string }
  | { kind: "message"; messageId: string; text: string }
  | { kind: "usage"; used: number; size: number; cost?: { amount: number; currency: string } }
  | { kind: "raw"; update: any };

export interface AcpPromptResult {
  stopReason: string;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
}

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

export class AcpClient {
  readonly proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buf = "";
  private closed = false;
  onUpdate: (u: AcpUpdate) => void = () => {};
  onExit: (code: number | null) => void = () => {};
  /** Диагностика моста (stderr). Туда мост пишет настоящую причину отказа —
   *  протокольный ответ при этом говорит лишь «Internal error». */
  onStderr: (text: string) => void = () => {};
  /** Последние строки stderr: ими объясняем падение пользователю. */
  readonly stderrTail: string[] = [];

  constructor(command: string[], cwd?: string) {
    // процесс агента живёт в папке сессии: cwd из session/new агенты используют
    // не для всех инструментов, часть берёт рабочую папку процесса
    this.proc = Bun.spawn(command, { ...(cwd ? { cwd } : {}), stdin: "pipe", stdout: "pipe", stderr: "pipe", env: secretsEnv(cwd) });
    this.pump();
    this.pumpErr();
    this.proc.exited.then((code) => {
      this.closed = true;
      for (const [, p] of this.pending) p.reject(new Error(`acp process exited (${code})`));
      this.pending.clear();
      this.onExit(code);
    });
  }

  /** stderr моста: в журнал сессии и в хвост для объяснения ошибки. */
  private async pumpErr() {
    const dec = new TextDecoder();
    try {
      for await (const chunk of this.proc.stderr) {
        const text = dec.decode(chunk, { stream: true });
        for (const line of text.split("\n").map((l) => l.trim()).filter(Boolean)) {
          this.stderrTail.push(line);
          if (this.stderrTail.length > 40) this.stderrTail.shift();
        }
        this.onStderr(text);
      }
    } catch { /* поток закрыт вместе с процессом */ }
  }

  private async pump() {
    const dec = new TextDecoder();
    try {
      for await (const chunk of this.proc.stdout) {
        this.buf += dec.decode(chunk, { stream: true });
        let idx: number;
        while ((idx = this.buf.indexOf("\n")) >= 0) {
          const line = this.buf.slice(0, idx).trim();
          this.buf = this.buf.slice(idx + 1);
          if (line) this.handleLine(line);
        }
      }
    } catch { /* процесс убит — закрытие обработает exited */ }
  }

  /**
   * Запрос ОТ агента (не ответ на наш).
   *
   * По ACP агент может спросить разрешение на действие и предложить варианты
   * (`session/request_permission`). Раньше такие запросы молча игнорировались:
   * агент оставался ждать ответа навсегда, а пользователь видел оборванную
   * реплику и не мог ничего выбрать. Теперь на каждый запрос ответ есть —
   * либо от пользователя, либо корректная ошибка «не поддерживаем».
   */
  onRequest: (method: string, params: any) => Promise<unknown> = async () => {
    throw new Error("метод не поддерживается этим клиентом");
  };

  private respond(id: number | string, result: unknown): void {
    try { this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n"); } catch { /* мост закрыт */ }
  }

  private respondError(id: number | string, message: string, code = -32601): void {
    try { this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n"); } catch { /* мост закрыт */ }
  }

  private handleLine(line: string) {
    let msg: any;
    try { msg = JSON.parse(line); } catch { return; }
    // Запрос агента: обязаны ответить, иначе он зависнет на ожидании.
    if (msg.method && msg.id !== undefined) {
      void this.onRequest(msg.method, msg.params)
        .then((result) => this.respond(msg.id, result))
        .catch((e) => this.respondError(msg.id, String(e?.message ?? e)));
      return;
    }
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        msg.error ? p.reject(new Error(`${msg.error.message ?? "acp error"}`)) : p.resolve(msg.result);
      }
      return;
    }
    if (msg.method === "session/update" && msg.params?.update) {
      const up = msg.params.update;
      switch (up.sessionUpdate) {
        case "available_commands_update":
          this.onUpdate({ kind: "available_commands", commands: up.availableCommands ?? [] });
          break;
        case "user_message_chunk":
          this.onUpdate({ kind: "user_message", messageId: up.messageId ?? "", text: up.content?.text ?? "" });
          break;
        case "agent_thought_chunk":
          this.onUpdate({ kind: "thought", messageId: up.messageId ?? "", text: up.content?.text ?? "" });
          break;
        case "agent_message_chunk":
          this.onUpdate({ kind: "message", messageId: up.messageId ?? "", text: up.content?.text ?? "" });
          break;
        case "usage_update":
          this.onUpdate({ kind: "usage", used: up.used ?? 0, size: up.size ?? 0, cost: up.cost });
          break;
        default:
          this.onUpdate({ kind: "raw", update: up });
      }
    }
  }

  private send(method: string, params: unknown, timeoutMs = 60000): Promise<any> {
    if (this.closed) return Promise.reject(new Error("acp process closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`acp timeout: ${method}`));
      }, timeoutMs);
      const done = (fn: (v: any) => void) => (v: any) => { clearTimeout(timer); fn(v); };
      this.pending.set(id, { resolve: done(resolve), reject: done(reject) });
      try {
        this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
        this.proc.stdin.flush();
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error(`acp write failed: ${String(e)}`));
      }
    });
  }

  get pid(): number { return this.proc.pid; }

  async initialize(): Promise<{ protocolVersion: number; agentInfo?: { name: string; version: string } }> {
    return this.send("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    }, 30000);
  }

  async newSession(cwd: string, mcpServers: unknown[] = []): Promise<{ sessionId: string; configOptions: AcpConfigOption[] }> {
    return this.send("session/new", { cwd, mcpServers }, 60000);
  }

  async loadSession(sessionId: string, cwd: string, mcpServers: unknown[] = []): Promise<{ configOptions?: AcpConfigOption[] }> {
    return this.send("session/load", { sessionId, cwd, mcpServers }, 60000);
  }

  async setConfigOption(sessionId: string, configId: string, value: string): Promise<{ configOptions?: AcpConfigOption[] }> {
    return this.send("session/set_config_option", { sessionId, configId, value }, 30000);
  }

  /** prompt без таймаута: агент может думать минутами. */
  async prompt(sessionId: string, text: string): Promise<AcpPromptResult> {
    return this.send("session/prompt", { sessionId, prompt: [{ type: "text", text }] }, 30 * 60 * 1000);
  }

  async listSessions(): Promise<AcpSessionInfo[]> {
    const r = await this.send("session/list", {}, 30000);
    return r?.sessions ?? [];
  }

  async closeSession(sessionId: string): Promise<void> {
    try { await this.send("session/close", { sessionId }, 10000); } catch { /* уже мёртв */ }
  }

  /** Мягкое закрытие: session/close + убийство процесса (деревом на Windows). */
  async dispose(sessionId?: string): Promise<void> {
    if (sessionId) await this.closeSession(sessionId);
    try { this.proc.kill(); } catch { /* уже мёртв */ }
    // дети процесса (node-обёртки агентов) держат CWD — добиваем деревом,
    // иначе копия проекта (data/work) не удалится на Windows
    try {
      if (process.platform === "win32") Bun.spawnSync(["taskkill", "/PID", String(this.proc.pid), "/T", "/F"]);
    } catch { /* процесс уже мёртв */ }
    this.closed = true;
  }
}
