// Dirigo — выгрузка знаний о выполненной задаче во внешнюю базу знаний.
//
// Зачем. Пульт знает по каждой задаче то, что обычно теряется: что просили,
// какой агент делал, какие решения приняты, какие модули затронуты, прошли ли
// проверки и кто одобрил. Если это уходит в базу знаний компании с семантическим
// поиском (например, CoAlly Nexus по MCP и pgvector), то следующая задача
// начинается не с чистого листа, а знание остаётся В ПЕРИМЕТРЕ компании.
//
// Два принципа:
//   1. Выключено по умолчанию. Ничего никуда не уходит, пока это не настроено.
//   2. Всё, что уходит наружу, сначала проходит через шлюз персональных данных.
//      Инструмент, который сам сливает PII в базу знаний, бессмысленен.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { scanText, loadPolicy } from "./policy";
import { McpHttpClient, type McpTool } from "./mcp-client";

/** Адрес CoAlly Nexus по умолчанию (облако). */
export const COALLY_MCP_URL = "https://coally.cortexally.ai/mcp";

/** Приёмник — MCP-сервер (CoAlly), а не простой HTTP POST: адрес оканчивается на /mcp. */
export function isMcpUrl(url: string): boolean {
  try { return /\/mcp\/?$/i.test(new URL(url).pathname); } catch { return false; }
}

export interface KnowledgeConfig {
  enabled: boolean;
  /** HTTP-приёмник: CoAlly Nexus или любой свой эндпоинт */
  url: string;
  /** передаётся как Authorization: Bearer <...>, если задан */
  apiKey: string;
  /** идентификатор проекта на стороне базы знаний */
  project: string;
  /** таймаут запроса, мс */
  timeoutMs: number;
  /** проекты, уже проиндексированные в CoAlly (index_project) */
  indexed: string[];
  /** сервер подключён к агентам машины (Настройки → «Подключить к агентам») */
  linkAgents: boolean;
}

const DEFAULTS: KnowledgeConfig = { enabled: false, url: "", apiKey: "", project: "", timeoutMs: 15000, indexed: [], linkAgents: false };

function configFile(): string {
  const dir = process.env.DIRIGO_DATA
    ? resolve(process.env.DIRIGO_DATA.replace(/[\\/]+$/, ""))
    : resolve(new URL("../data/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  mkdirSync(dir, { recursive: true });
  return join(dir, "knowledge.json");
}

export function loadKnowledge(): KnowledgeConfig {
  try {
    if (existsSync(configFile())) {
      const raw = JSON.parse(readFileSync(configFile(), "utf8")) as Partial<KnowledgeConfig>;
      return {
        enabled: raw.enabled === true,
        url: String(raw.url ?? ""),
        apiKey: String(raw.apiKey ?? ""),
        project: String(raw.project ?? ""),
        // до 1.9.2 по умолчанию было 5 с — index_project в облаке дольше
        timeoutMs: Math.max(Number(raw.timeoutMs ?? DEFAULTS.timeoutMs) || DEFAULTS.timeoutMs, 15000),
        indexed: Array.isArray(raw.indexed) ? raw.indexed.map(String) : [],
        linkAgents: raw.linkAgents === true,
      };
    }
  } catch { /* битый конфиг — считаем, что интеграция выключена */ }
  return { ...DEFAULTS };
}

export function saveKnowledge(next: Partial<KnowledgeConfig>): KnowledgeConfig {
  const cur = loadKnowledge();
  const merged: KnowledgeConfig = {
    enabled: typeof next.enabled === "boolean" ? next.enabled : cur.enabled,
    url: next.url !== undefined ? String(next.url) : cur.url,
    apiKey: next.apiKey !== undefined ? String(next.apiKey) : cur.apiKey,
    project: next.project !== undefined ? String(next.project) : cur.project,
    timeoutMs: next.timeoutMs !== undefined ? Number(next.timeoutMs) || cur.timeoutMs : cur.timeoutMs,
    // другой адрес или ключ — другая база: прежний список проиндексированного не годится
    indexed: Array.isArray(next.indexed) ? next.indexed.map(String)
      : (next.url !== undefined && next.url !== cur.url) || (next.apiKey !== undefined && next.apiKey !== cur.apiKey) ? [] : cur.indexed,
    linkAgents: typeof next.linkAgents === "boolean" ? next.linkAgents : cur.linkAgents,
  };
  writeFileSync(configFile(), JSON.stringify(merged, null, 2), { mode: 0o600 });
  return merged;
}

/** Запись о задаче в том виде, в каком её удобно искать по смыслу. */
export interface KnowledgeEntry {
  schema: "dirigo.knowledge/1";
  project: string;
  sessionId: string;
  title: string;
  author: string;
  model: string | null;
  summary: string;
  decisions: string[];
  modules: string[];
  checks: { total: number; passed: number; returnedToAgent: number };
  approvedBy: string | null;
  commit: string | null;
  evidencePackId: string;
  at: number;
}

/** Собрать запись из пакета доказательств — он уже содержит все факты. */
export function entryFromPack(pack: import("./provenance").EvidencePack, project: string): KnowledgeEntry {
  const passed = pack.checks.filter((c) => c.ok).length;
  const modules = pack.review.files.map((f) => f.path);
  const decisions: string[] = [];
  if (pack.returnedToAgent > 0) decisions.push(`Работа возвращалась агенту ${pack.returnedToAgent} раз(а) по красным проверкам`);
  if (pack.checks.length) decisions.push(`Проверки перед ревью: ${passed}/${pack.checks.length} зелёных`);
  if (pack.isolation.kind) decisions.push(`Изоляция: ${pack.isolation.kind}${pack.isolation.baseRef ? ` от ${pack.isolation.baseRef.slice(0, 8)}` : ""}`);
  if (pack.policy.findings) decisions.push(`Шлюз персональных данных: находок ${pack.policy.findings}, блокировок ${pack.policy.blocked}`);

  return {
    schema: "dirigo.knowledge/1",
    project: project || pack.project.name || "",
    sessionId: pack.sessionId,
    title: pack.task.title ?? "задача без названия",
    author: pack.agent.id ?? "unknown",
    model: pack.agent.model ?? null,
    summary:
      `Агент ${pack.agent.id ?? "?"}${pack.agent.model ? ` (${pack.agent.model})` : ""} изменил ` +
      `${modules.length} файл(ов) в проекте ${pack.project.name ?? "?"}. ` +
      `Проверки: ${passed}/${pack.checks.length}. Одобрил: ${pack.review.approvedBy ?? "не указан"}.`,
    decisions,
    modules,
    checks: { total: pack.checks.length, passed, returnedToAgent: pack.returnedToAgent },
    approvedBy: pack.review.approvedBy ?? null,
    commit: pack.result.commit ?? null,
    evidencePackId: pack.packId,
    at: pack.producedAt,
  };
}

export interface PushResult { ok: boolean; skipped?: string; status?: number; detail?: string; scrubbed?: number; via?: "mcp" | "http"; }

/** Запись о задаче → аргументы save_session_context (CoAlly Nexus). */
export function coallyArgs(entry: KnowledgeEntry, project: string): Record<string, unknown> {
  const args: Record<string, unknown> = {
    task_description: entry.title,
    details: entry.summary,
    modules_affected: entry.modules,
    decisions: entry.decisions,
    findings: [
      `Проверки: ${entry.checks.passed}/${entry.checks.total}, возвратов агенту: ${entry.checks.returnedToAgent}`,
      `Пакет доказательств: ${entry.evidencePackId}`,
    ],
    author: entry.model ? `${entry.author} (${entry.model})` : entry.author,
    external_task_id: `dirigo:${entry.sessionId}`,
  };
  if (project || entry.project) args.project_name = project || entry.project;
  if (entry.commit) args.commit_hash = entry.commit;
  return args;
}

/** Проверка связи: initialize + tools/list. В базу ничего не пишется. */
export async function testConnection(cfg: KnowledgeConfig = loadKnowledge()): Promise<{ ok: boolean; via: "mcp" | "http"; detail: string; tools?: string[]; status?: number }> {
  if (!cfg.url) return { ok: false, via: "http", detail: "не задан адрес базы знаний" };
  if (!/^https?:\/\//i.test(cfg.url)) return { ok: false, via: "http", detail: "адрес должен начинаться с http(s)://" };
  if (!isMcpUrl(cfg.url)) return { ok: false, via: "http", detail: "простой HTTP-приёмник: проверяется первой отправкой записи" };
  const c = new McpHttpClient(cfg.url, cfg.apiKey, cfg.timeoutMs);
  const init = await c.initialize();
  if (!init.ok) {
    const hint = init.status === 401 ? (cfg.apiKey ? " — ключ не принят: создайте новый в CoAlly → Settings → API Keys" : " — нужен API-ключ CoAlly (cnx_…)") : "";
    return { ok: false, via: "mcp", status: init.status, detail: `${init.error ?? "нет связи"}${hint}` };
  }
  const tl = await c.listTools();
  if (!tl.ok) return { ok: false, via: "mcp", status: tl.status, detail: tl.error ?? "tools/list не ответил" };
  const names = tl.tools.map((t: McpTool) => t.name);
  const need = ["save_session_context", "retrieve_task_context"].filter((n) => !names.includes(n));
  return need.length
    ? { ok: false, via: "mcp", tools: names, detail: `сервер MCP отвечает, но нет инструментов: ${need.join(", ")}` }
    : { ok: true, via: "mcp", tools: names, detail: `подключено: ${names.length} инструментов (${names.join(", ")})` };
}

/** Поиск по базе знаний (retrieve_task_context) — проверенный контекст для следующей задачи. */
/**
 * Вызов инструмента CoAlly. Ошибка инструмента приходит обычным текстом-JSON
 * ({"error": "No project found. Run index_project first."}) — без разбора она
 * выглядела как успех: «отправлено», а в базе ничего.
 */
export async function coallyCall(c: McpHttpClient, tool: string, args: Record<string, unknown>): Promise<{ ok: boolean; text: string; error?: string; noProject?: boolean }> {
  const r = await c.callTool(tool, args);
  if (!r.ok) return { ok: false, text: r.text ?? "", error: r.error, noProject: /no project found|index_project/i.test(r.error ?? "") };
  const text = r.text ?? "";
  try {
    const j = JSON.parse(text);
    if (j && typeof j === "object" && !Array.isArray(j) && j.error) {
      const err = String(j.error);
      return { ok: false, text, error: err, noProject: /no project found|index_project/i.test(err) };
    }
  } catch { /* не JSON — обычный ответ */ }
  return { ok: true, text };
}

/** Дерево файлов проекта для index_project: удалённый сервер не видит диск. */
export function projectTree(root: string, max = 400): string {
  const out: string[] = [];
  const skip = new Set([".git", "node_modules", ".dirigo", "dist", "build", ".venv", "venv", "__pycache__", ".next", "target"]);
  const walk = (dir: string, depth: number) => {
    if (out.length >= max || depth > 6) return;
    let names: string[] = [];
    try { names = readdirSync(dir).sort(); } catch { return; }
    for (const n of names) {
      if (out.length >= max) return;
      if (skip.has(n) || n.startsWith(".smoke")) continue;
      const full = join(dir, n);
      let isDir = false;
      try { isDir = statSync(full).isDirectory(); } catch { continue; }
      out.push(`${"  ".repeat(depth)}${n}${isDir ? "/" : ""}`);
      if (isDir) walk(full, depth + 1);
    }
  };
  walk(root, 0);
  return out.join("\n");
}

const CONFIG_FILES = ["package.json", "pyproject.toml", "requirements.txt", "go.mod", "Cargo.toml", "README.md"];

/**
 * Проект в CoAlly: без index_project инструменты отвечают «No project found».
 * Индексируем один раз (дерево + ключевые конфиги, через шлюз PII) и
 * запоминаем; при ответе «нет проекта» — индексируем заново.
 */
export async function ensureCoallyProject(c: McpHttpClient, name: string, path: string | undefined, force = false): Promise<{ ok: boolean; detail: string }> {
  const cfg = loadKnowledge();
  if (!force && cfg.indexed.includes(name)) return { ok: true, detail: "уже проиндексирован" };
  const policy = loadPolicy();
  const config_contents: Record<string, string> = {};
  if (path) {
    for (const f of CONFIG_FILES) {
      try {
        const txt = readFileSync(join(path, f), "utf8").slice(0, 8000);
        const sc = scanText(txt, policy);
        if (sc.blocked) continue;               // конфиг с PII при block — не отправляем
        config_contents[f] = sc.mode === "redact" ? sc.text : txt;
      } catch { /* файла нет */ }
    }
  }
  const r = await coallyCall(c, "index_project", {
    path: path ?? name, project_name: name,
    tree: path ? projectTree(path) : "", config_contents,
  });
  // Повторный index_project существующего проекта у CoAlly падает на уникальности
  // имени («duplicate key … projects_name_key») — проект уже есть, это успех.
  if (!r.ok && !/duplicate key|already exists|unique constraint/i.test(r.error ?? "")) return { ok: false, detail: `index_project: ${r.error}` };
  saveKnowledge({ indexed: [...new Set([...cfg.indexed, name])] });
  return { ok: true, detail: "проект проиндексирован" };
}

/** Поиск по базе знаний (retrieve_task_context) — проверенный контекст для следующей задачи. */
export async function searchKnowledge(query: string, cfg: KnowledgeConfig = loadKnowledge(), limit = 5, project?: { name: string; path?: string }): Promise<{ ok: boolean; text?: string; detail?: string }> {
  if (!cfg.url || !isMcpUrl(cfg.url)) return { ok: false, detail: "поиск доступен для MCP-базы знаний (CoAlly)" };
  const q = scanText(query, loadPolicy());
  if (q.blocked) return { ok: false, detail: `политика заблокировала запрос: ${q.summary}` };
  const c = new McpHttpClient(cfg.url, cfg.apiKey, cfg.timeoutMs);
  const init = await c.initialize();
  if (!init.ok) return { ok: false, detail: init.error };
  const name = cfg.project || project?.name || "";
  const args: Record<string, unknown> = { query: q.text, limit };
  if (name) args.project_name = name;
  let r = await coallyCall(c, "retrieve_task_context", args);
  if (!r.ok && r.noProject) {
    if (!name) return { ok: false, detail: "в CoAlly ещё нет проектов: укажите «Проект» в настройках или примените первое изменение" };
    const ix = await ensureCoallyProject(c, name, project?.path, true);
    if (!ix.ok) return { ok: false, detail: ix.detail };
    r = await coallyCall(c, "retrieve_task_context", args);
  }
  return r.ok ? { ok: true, text: formatResults(r.text) } : { ok: false, detail: r.error };
}

/** Ответ retrieve_task_context ({project, results:[{content,…}]}) — читаемым текстом. */
export function formatResults(text: string): string {
  try {
    const j = JSON.parse(text);
    const list = Array.isArray(j?.results) ? j.results : null;
    if (!list) return text;
    if (!list.length) return "ничего не найдено";
    return list.map((x: any, i: number) => {
      const body = String(x.content ?? x.summary ?? x.text ?? JSON.stringify(x)).trim();
      const meta = [x.author, x.created_at ?? x.date, x.score != null ? `score ${Number(x.score).toFixed(2)}` : ""].filter(Boolean).join(" · ");
      return `${i + 1}. ${body.slice(0, 1200)}${meta ? `\n   — ${meta}` : ""}`;
    }).join("\n\n");
  } catch { return text; }
}

/**
 * Отправить запись. Перед отправкой — обязательная проверка шлюзом PII по
 * содержимому записи; при режиме redact значения заменяются, при block
 * отправка не происходит вовсе.
 */
export async function pushEntry(entry: KnowledgeEntry, cfg: KnowledgeConfig = loadKnowledge(), projectPath?: string): Promise<PushResult> {
  if (!cfg.enabled) return { ok: false, skipped: "интеграция выключена" };
  if (!cfg.url) return { ok: false, skipped: "не задан адрес базы знаний" };
  if (!/^https?:\/\//i.test(cfg.url)) return { ok: false, skipped: "адрес должен начинаться с http(s)://" };

  const policy = loadPolicy();
  if (isMcpUrl(cfg.url)) {
    // CoAlly: запись о задаче — вызов save_session_context; PII-шлюз — по аргументам
    const rawArgs = JSON.stringify(coallyArgs(entry, cfg.project));
    const scan = scanText(rawArgs, policy);
    if (scan.blocked) return { ok: false, via: "mcp", skipped: `политика заблокировала выгрузку: ${scan.summary}` };
    const args = JSON.parse(scan.mode === "redact" && scan.findings.length ? scan.text : rawArgs);
    const c = new McpHttpClient(cfg.url, cfg.apiKey, cfg.timeoutMs);
    const init = await c.initialize();
    if (!init.ok) return { ok: false, via: "mcp", status: init.status, detail: `MCP: ${init.error}` };
    const name = String(args.project_name ?? "");
    if (name) {
      const ix = await ensureCoallyProject(c, name, projectPath);
      if (!ix.ok) return { ok: false, via: "mcp", detail: ix.detail, scrubbed: scan.findings.length };
    }
    let r = await coallyCall(c, "save_session_context", args);
    if (!r.ok && r.noProject && name) {
      const ix = await ensureCoallyProject(c, name, projectPath, true);
      if (ix.ok) r = await coallyCall(c, "save_session_context", args);
    }
    return { ok: r.ok, via: "mcp", detail: r.ok ? "сохранено в CoAlly" : `MCP: ${r.error}`, scrubbed: scan.findings.length };
  }
  const raw = JSON.stringify(entry);
  const scan = scanText(raw, policy);
  if (scan.blocked) return { ok: false, skipped: `политика заблокировала выгрузку: ${scan.summary}` };
  const payload = scan.mode === "redact" && scan.findings.length ? scan.text : raw;

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
    const res = await fetch(cfg.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
      },
      body: payload,
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    return { ok: res.ok, status: res.status, detail: res.ok ? "отправлено" : `приёмник ответил ${res.status}`, scrubbed: scan.findings.length };
  } catch (e) {
    return { ok: false, detail: `не отправилось: ${String((e as Error)?.message ?? e).slice(0, 120)}` };
  }
}
