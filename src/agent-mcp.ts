// Dirigo — подключение MCP-сервера базы знаний (CoAlly Nexus) к агентам машины.
//
// Владелец: «добавь CoAlly во все агенты». Каждый агент хранит MCP-серверы по-
// своему, поэтому у каждого — свой способ, проверенный на этой машине:
//   • свои команды `mcp add -s user`, где они есть (claude, devin) — надёжнее
//     ручной правки, агент сам проверит формат; проверка — `mcp get`;
//   • слияние в пользовательский конфиг (opencode, kilo, cline, cursor,
//     freebuff, zcode, gemini, copilot) — чужие серверы и настройки остаются,
//     перед первой правкой — копия файла рядом (*.dirigo-backup);
//   • hermes — блок в config.yaml с метками, чтобы его можно было чисто убрать;
//   • codex — секция в config.toml;
//   • minimax (mcode) пользовательского конфига MCP не читает — ему сервер
//     передаётся в сессиях пульта через ACP (session/new mcpServers).
// Агент не установлен — пропускаем и говорим об этом.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { getAgent } from "./agents/registry";

export interface McpServerSpec { name: string; url: string; headers: Record<string, string> }
export type AgentMcpState = "added" | "updated" | "present" | "removed" | "absent" | "not-installed" | "session-only" | "error";
export interface AgentMcpResult {
  agent: string; label: string; state: AgentMcpState; detail: string;
  where?: string; verified?: boolean;
}

interface Env {
  home: string;
  appdata: string;      // %APPDATA%
  localappdata: string; // %LOCALAPPDATA%
  /** true — реальная машина: можно звать CLI агентов (claude/devin/hermes) */
  live: boolean;
  /** установлен ли агент (тесты подменяют) */
  installed: (id: string) => boolean;
}

export function defaultEnv(): Env {
  // Тесты: подменная домашняя папка — настоящие конфиги агентов не трогаются никогда
  const fake = process.env.DIRIGO_AGENT_HOME;
  if (fake) {
    const list = (process.env.DIRIGO_AGENT_INSTALLED ?? "").split(",").map((x) => x.trim()).filter(Boolean);
    return {
      home: fake, appdata: join(fake, "AppData", "Roaming"), localappdata: join(fake, "AppData", "Local"),
      live: false, installed: (id) => !list.length || list.includes(id),
    };
  }
  const home = homedir();
  return {
    home,
    appdata: process.env.APPDATA ?? join(home, "AppData", "Roaming"),
    localappdata: process.env.LOCALAPPDATA ?? join(home, "AppData", "Local"),
    live: true,
    installed: (id) => {
      const def = getAgent(id);
      if (!def) return false;
      return def.command[0] !== "__dirigo_missing__" && !def.command.includes("__dirigo_missing__");
    },
  };
}

/* ───────────── файлы: JSON/JSONC с бэкапом ───────────── */

/** JSONC → JSON: убрать комментарии вне строк и висячие запятые. */
export function stripJsonc(text: string): string {
  let out = "", inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!, n = text[i + 1];
    if (inStr) { out += c; if (esc) esc = false; else if (c === "\\") esc = true; else if (c === "\"") inStr = false; continue; }
    if (c === "\"") { inStr = true; out += c; continue; }
    if (c === "/" && n === "/") { while (i < text.length && text[i] !== "\n") i++; out += "\n"; continue; }
    if (c === "/" && n === "*") { i += 2; while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++; i++; continue; }
    out += c;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

function readJson(path: string): { ok: true; data: any } | { ok: false; error: string } {
  if (!existsSync(path)) return { ok: true, data: {} };
  const raw = readFileSync(path, "utf8");
  if (!raw.trim()) return { ok: true, data: {} };
  try { return { ok: true, data: JSON.parse(raw) }; } catch { /* попробуем как JSONC */ }
  try { return { ok: true, data: JSON.parse(stripJsonc(raw)) }; } catch (e) {
    return { ok: false, error: `не читается как JSON — файл не трогаем (${String((e as Error).message).slice(0, 80)})` };
  }
}

function backupOnce(path: string): void {
  const bak = `${path}.dirigo-backup`;
  if (existsSync(path) && !existsSync(bak)) copyFileSync(path, bak);
}

function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  backupOnce(path);
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf8");
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Положить/убрать запись в объекте по пути ключей (mcpServers или mcp.servers). */
function jsonTarget(path: string, keys: string[], entry: (s: McpServerSpec) => unknown) {
  return {
    where: path,
    install(spec: McpServerSpec): { state: AgentMcpState; detail: string } {
      const r = readJson(path);
      if (!r.ok) return { state: "error", detail: r.error };
      const root = r.data && typeof r.data === "object" ? r.data : {};
      let box: any = root;
      for (const k of keys) { if (!box[k] || typeof box[k] !== "object") box[k] = {}; box = box[k]; }
      const want = entry(spec);
      if (box[spec.name] && same(box[spec.name], want)) return { state: "present", detail: "уже подключён" };
      const existed = !!box[spec.name];
      box[spec.name] = want;
      writeJson(path, root);
      return { state: existed ? "updated" : "added", detail: existed ? "запись обновлена" : "добавлен" };
    },
    remove(name: string): { state: AgentMcpState; detail: string } {
      const r = readJson(path);
      if (!r.ok) return { state: "error", detail: r.error };
      let box: any = r.data;
      for (const k of keys) box = box?.[k];
      if (!box || !(name in box)) return { state: "absent", detail: "не был подключён" };
      delete box[name];
      writeJson(path, r.data);
      return { state: "removed", detail: "убран" };
    },
    has(name: string): boolean {
      const r = readJson(path);
      if (!r.ok) return false;
      let box: any = r.data;
      for (const k of keys) box = box?.[k];
      return !!box && name in box;
    },
  };
}

/* ───────────── hermes: YAML-блок с метками ───────────── */

const yBegin = (n: string) => `# >>> dirigo:${n}`;
const yEnd = (n: string) => `# <<< dirigo:${n}`;
const yq = (s: string) => JSON.stringify(s); // строка YAML в двойных кавычках

function yamlTarget(path: string) {
  const block = (s: McpServerSpec) => [
    yBegin(s.name),
    `  ${s.name}:`,
    `    url: ${yq(s.url)}`,
    `    headers:`,
    ...Object.entries(s.headers).map(([k, v]) => `      ${k}: ${yq(v)}`),
    yEnd(s.name),
  ].join("\n");
  const strip = (text: string, name: string) => {
    const re = new RegExp(`\\n?${yBegin(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${yEnd(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n?`, "g");
    return text.replace(re, "\n");
  };
  return {
    where: path,
    install(spec: McpServerSpec): { state: AgentMcpState; detail: string } {
      const text = existsSync(path) ? readFileSync(path, "utf8") : "";
      const had = text.includes(yBegin(spec.name));
      let base = strip(text, spec.name);
      // ключ mcp_servers без комментария в начале строки
      const top = /^mcp_servers:\s*(?:\{\s*\}|null)?\s*$/m.exec(base);
      if (top && /\{\s*\}|null/.test(top[0])) base = base.replace(top[0], "mcp_servers:");
      let next: string;
      if (/^mcp_servers:\s*$/m.test(base)) {
        next = base.replace(/^mcp_servers:\s*$/m, `mcp_servers:\n${block(spec)}`);
      } else if (/^mcp_servers:/m.test(base)) {
        return { state: "error", detail: "mcp_servers в config.yaml записан в одну строку — добавьте сервер вручную" };
      } else {
        next = `${base.replace(/\s*$/, "")}\n\nmcp_servers:\n${block(spec)}\n`;
      }
      if (had && next === text) return { state: "present", detail: "уже подключён" };
      mkdirSync(dirname(path), { recursive: true });
      backupOnce(path);
      writeFileSync(path, next, "utf8");
      return { state: had ? "updated" : "added", detail: had ? "запись обновлена" : "добавлен" };
    },
    remove(name: string): { state: AgentMcpState; detail: string } {
      if (!existsSync(path)) return { state: "absent", detail: "не был подключён" };
      const text = readFileSync(path, "utf8");
      if (!text.includes(yBegin(name))) return { state: "absent", detail: "не был подключён" };
      backupOnce(path);
      writeFileSync(path, strip(text, name), "utf8");
      return { state: "removed", detail: "убран" };
    },
    has(name: string): boolean { return existsSync(path) && readFileSync(path, "utf8").includes(yBegin(name)); },
  };
}

/* ───────────── codex: секция TOML ───────────── */

function tomlTarget(path: string) {
  const head = (n: string) => `[mcp_servers.${JSON.stringify(n)}]`;
  const section = (s: McpServerSpec) => `${head(s.name)}\nurl = ${JSON.stringify(s.url)}\nhttp_headers = { ${Object.entries(s.headers).map(([k, v]) => `${JSON.stringify(k)} = ${JSON.stringify(v)}`).join(", ")} }\n`;
  const strip = (text: string, n: string) => {
    const i = text.indexOf(head(n));
    if (i < 0) return text;
    const rest = text.slice(i + head(n).length);
    const j = rest.search(/\n\[/);
    return text.slice(0, i) + (j < 0 ? "" : rest.slice(j + 1));
  };
  return {
    where: path,
    install(spec: McpServerSpec) {
      const text = existsSync(path) ? readFileSync(path, "utf8") : "";
      const had = text.includes(head(spec.name));
      const next = `${strip(text, spec.name).replace(/\s*$/, "")}${text.trim() ? "\n\n" : ""}${section(spec)}`;
      if (had && next === text) return { state: "present" as AgentMcpState, detail: "уже подключён" };
      mkdirSync(dirname(path), { recursive: true }); backupOnce(path); writeFileSync(path, next, "utf8");
      return { state: (had ? "updated" : "added") as AgentMcpState, detail: had ? "запись обновлена" : "добавлен" };
    },
    remove(name: string) {
      if (!existsSync(path) || !readFileSync(path, "utf8").includes(head(name))) return { state: "absent" as AgentMcpState, detail: "не был подключён" };
      backupOnce(path); writeFileSync(path, strip(readFileSync(path, "utf8"), name), "utf8");
      return { state: "removed" as AgentMcpState, detail: "убран" };
    },
    has(name: string) { return existsSync(path) && readFileSync(path, "utf8").includes(head(name)); },
  };
}

/* ───────────── CLI агента (claude, devin) ───────────── */

/** CLI агента — только асинхронно: синхронный запуск (claude mcp get ~5 с)
 *  останавливал весь демон, и пока открыты Настройки, не грузилась даже доска. */
async function runCli(cmd: string[], timeoutMs = 30000): Promise<{ ok: boolean; out: string }> {
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const timer = setTimeout(() => { try { proc.kill(); } catch { /* */ } }, timeoutMs);
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const code = await proc.exited;
    clearTimeout(timer);
    return { ok: code === 0, out: (out + err).trim() };
  } catch (e) { return { ok: false, out: String(e) }; }
}

/** Агент со своей командой mcp: запись и проверка — его CLI (асинхронно),
 *  статус для экрана — чтение файла, без запуска агента. */
function cliTarget(bin: string[], label: string, addArgs: (s: McpServerSpec) => string[], removeArgs: (n: string) => string[], getArgs: (n: string) => string[], fileHas: (n: string) => boolean): Target {
  const cliHas = async (name: string) => {
    const r = await runCli([...bin, ...getArgs(name)]);
    return r.ok && !/not found|no mcp server|не найден|no server/i.test(r.out);
  };
  return {
    where: `${label}: mcp add -s user`,
    async install(spec: McpServerSpec) {
      const existed = await cliHas(spec.name);
      if (existed) await runCli([...bin, ...removeArgs(spec.name)]);
      const r = await runCli([...bin, ...addArgs(spec)]);
      if (!r.ok) return { state: "error" as AgentMcpState, detail: r.out.slice(0, 200) || "команда не выполнилась" };
      const ok = await cliHas(spec.name);
      return { state: (existed ? "updated" : "added") as AgentMcpState, detail: ok ? "добавлен и виден агенту (mcp get)" : "добавлен, но mcp get его не показал", verified: ok };
    },
    async remove(name: string) {
      if (!(await cliHas(name))) return { state: "absent" as AgentMcpState, detail: "не был подключён" };
      const r = await runCli([...bin, ...removeArgs(name)]);
      return r.ok ? { state: "removed" as AgentMcpState, detail: "убран" } : { state: "error" as AgentMcpState, detail: r.out.slice(0, 200) };
    },
    has: fileHas,
  };
}

/* ───────────── список агентов ───────────── */

type Res = { state: AgentMcpState; detail: string; verified?: boolean };
interface Target { where: string; install(s: McpServerSpec): Res | Promise<Res>; remove(n: string): Res | Promise<Res>; has(n: string): boolean }

function targets(env: Env): Array<{ id: string; label: string; make?: () => Target; sessionOnly?: string }> {
  const h = env.home;
  const hdr = (s: McpServerSpec) => Object.entries(s.headers).map(([k, v]) => `${k}: ${v}`);
  const claudeBin = getAgent("claude-code")?.command ?? ["claude"];
  const devinBin = getAgent("devin")?.command ?? ["devin"];
  return [
    {
      id: "claude-code", label: "Claude Code",
      make: () => env.live
        ? cliTarget(claudeBin, "claude",
          (s) => ["mcp", "add", "--transport", "http", "-s", "user", s.name, s.url, ...hdr(s).flatMap((x) => ["-H", x])],
          (n) => ["mcp", "remove", "-s", "user", n], (n) => ["mcp", "get", n],
          (n) => jsonTarget(join(h, ".claude.json"), ["mcpServers"], () => null).has(n))
        : jsonTarget(join(h, ".claude.json"), ["mcpServers"], (s) => ({ type: "http", url: s.url, headers: s.headers })),
    },
    {
      id: "devin", label: "Devin",
      make: () => env.live
        ? cliTarget(devinBin, "devin",
          (s) => ["mcp", "add", "--transport", "http", "-s", "user", s.name, s.url, ...hdr(s).flatMap((x) => ["-H", x])],
          (n) => ["mcp", "remove", "-s", "user", n], (n) => ["mcp", "get", n],
          // devin пишет пользовательский конфиг в %APPDATA%\devin (Windows) или ~/.config/devin
          (n) => [join(env.appdata, "devin", "mcp_config.json"), join(h, ".config", "devin", "mcp_config.json")].some((f) => jsonTarget(f, ["mcpServers"], () => null).has(n)))
        : jsonTarget(join(h, ".config", "devin", "mcp_config.json"), ["mcpServers"], (s) => ({ url: s.url, headers: s.headers })),
    },
    { id: "opencode", label: "OpenCode", make: () => jsonTarget(join(h, ".config", "opencode", "opencode.json"), ["mcp"], (s) => ({ type: "remote", url: s.url, headers: s.headers, enabled: true })) },
    {
      id: "kilo", label: "Kilo",
      make: () => {
        const jsonc = join(h, ".config", "kilo", "kilo.jsonc");
        const path = existsSync(jsonc) ? jsonc : join(h, ".config", "kilo", "kilo.json");
        return jsonTarget(path, ["mcp"], (s) => ({ type: "remote", url: s.url, headers: s.headers, enabled: true }));
      },
    },
    { id: "cline", label: "Cline", make: () => jsonTarget(join(h, ".cline", "data", "settings", "cline_mcp_settings.json"), ["mcpServers"], (s) => ({ type: "streamableHttp", url: s.url, headers: s.headers, disabled: false })) },
    { id: "cursor", label: "Cursor", make: () => jsonTarget(join(h, ".cursor", "mcp.json"), ["mcpServers"], (s) => ({ url: s.url, headers: s.headers })) },
    { id: "freebuff", label: "Freebuff", make: () => jsonTarget(join(h, ".agents", "mcp.json"), ["mcpServers"], (s) => ({ type: "http", url: s.url, headers: s.headers })) },
    { id: "zcode", label: "ZCode", make: () => jsonTarget(join(h, ".zcode", "cli", "setting.json"), ["mcp", "servers"], (s) => ({ type: "http", url: s.url, headers: s.headers })) },
    {
      id: "hermes", label: "Hermes",
      make: () => {
        const win = process.platform === "win32";
        const def = win ? join(env.localappdata, "hermes", "config.yaml") : join(h, ".hermes", "config.yaml");
        return yamlTarget(process.env.HERMES_HOME ? join(process.env.HERMES_HOME, "config.yaml") : def);
      },
    },
    { id: "gemini", label: "Gemini CLI", make: () => jsonTarget(join(h, ".gemini", "settings.json"), ["mcpServers"], (s) => ({ httpUrl: s.url, headers: s.headers })) },
    { id: "copilot", label: "Copilot CLI", make: () => jsonTarget(join(h, ".copilot", "mcp-config.json"), ["mcpServers"], (s) => ({ type: "http", url: s.url, headers: s.headers, tools: ["*"] })) },
    { id: "codex", label: "Codex", make: () => tomlTarget(join(h, ".codex", "config.toml")) },
    { id: "minimax", label: "MiniMax Code", sessionOnly: "пользовательский конфиг MCP не читает — подключается в сессиях Dirigo (живой диалог)" },
  ];
}

export function coallySpec(url: string, key: string, name = "coally-nexus"): McpServerSpec {
  return { name, url, headers: { Authorization: `Bearer ${key}` } };
}

/** Подключить сервер ко всем установленным агентам. */
export async function installMcpForAgents(spec: McpServerSpec, env: Env = defaultEnv(), only?: string[]): Promise<AgentMcpResult[]> {
  const out: AgentMcpResult[] = [];
  for (const t of targets(env).filter((x) => !only || only.includes(x.id))) {
    if (!env.installed(t.id)) { out.push({ agent: t.id, label: t.label, state: "not-installed", detail: "агент не установлен" }); continue; }
    if (t.sessionOnly) { out.push({ agent: t.id, label: t.label, state: "session-only", detail: t.sessionOnly }); continue; }
    try {
      const tg = t.make!();
      out.push({ agent: t.id, label: t.label, where: tg.where, ...(await tg.install(spec)) });
    } catch (e) { out.push({ agent: t.id, label: t.label, state: "error", detail: String((e as Error).message ?? e).slice(0, 200) }); }
  }
  return out;
}

/** Убрать сервер у всех агентов (только нашу запись, остальное не трогаем). */
export async function removeMcpFromAgents(name: string, env: Env = defaultEnv(), only?: string[]): Promise<AgentMcpResult[]> {
  const out: AgentMcpResult[] = [];
  for (const t of targets(env).filter((x) => !only || only.includes(x.id))) {
    if (!env.installed(t.id)) { out.push({ agent: t.id, label: t.label, state: "not-installed", detail: "агент не установлен" }); continue; }
    if (t.sessionOnly) { out.push({ agent: t.id, label: t.label, state: "session-only", detail: t.sessionOnly }); continue; }
    try { const tg = t.make!(); out.push({ agent: t.id, label: t.label, where: tg.where, ...(await tg.remove(name)) }); }
    catch (e) { out.push({ agent: t.id, label: t.label, state: "error", detail: String((e as Error).message ?? e).slice(0, 200) }); }
  }
  return out;
}

/** Где сервер уже подключён (для экрана настроек). */
export function mcpStatusForAgents(name: string, env: Env = defaultEnv()): AgentMcpResult[] {
  return targets(env).map((t) => {
    if (!env.installed(t.id)) return { agent: t.id, label: t.label, state: "not-installed", detail: "агент не установлен" };
    if (t.sessionOnly) return { agent: t.id, label: t.label, state: "session-only", detail: t.sessionOnly };
    try { const tg = t.make!(); const on = tg.has(name); return { agent: t.id, label: t.label, where: tg.where, state: on ? "present" : "absent", detail: on ? "подключён" : "не подключён" }; }
    catch (e) { return { agent: t.id, label: t.label, state: "error", detail: String((e as Error).message ?? e).slice(0, 200) }; }
  });
}

/** Для ACP-сессий агентов без пользовательского конфига (minimax) — запись session/new. */
export function acpMcpServers(agentId: string, spec: McpServerSpec | null): unknown[] {
  if (!spec || agentId !== "minimax") return [];
  return [{ type: "http", name: spec.name, url: spec.url, headers: Object.entries(spec.headers).map(([name, value]) => ({ name, value })) }];
}
