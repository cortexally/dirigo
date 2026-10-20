#!/usr/bin/env bun
// CoAlly Nexus по MCP (Настройки → База знаний компании).
//
// Заглушка повторяет поведение настоящего сервера (coally.cortexally.ai/mcp):
// streamable HTTP, Bearer-ключ cnx_…, 401 {"error":"Missing API key"}, ответы
// то JSON, то SSE, заголовок Mcp-Session-Id, пять инструментов.
// Проверяем: рукопожатие и список инструментов, запись задачи через
// save_session_context, PII-шлюз на аргументах, поиск retrieve_task_context,
// и сквозной путь через демон и экран настроек.
//
//   bun run scripts/coally-mcp-test.ts
//   COALLY_API_KEY=cnx_… bun run scripts/coally-mcp-test.ts   + живая проверка облака
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";

const DATA = join(tmpdir(), `dirigo-coally-${Date.now().toString(36)}`);
mkdirSync(DATA, { recursive: true });
process.env.DIRIGO_DATA = DATA;

const { testConnection, pushEntry, searchKnowledge, coallyArgs, isMcpUrl, COALLY_MCP_URL } = await import("../src/knowledge");
const { parseRpcBody } = await import("../src/mcp-client");
const { savePolicy } = await import("../src/policy");

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  ok ? pass++ : fail++;
};

// ── заглушка CoAlly ──
const KEY = "cnx_test_key";
const TOOLS = ["index_project", "save_session_context", "retrieve_task_context", "update_project_rules", "get_agent_setup"];
const saved: any[] = [];
// Как настоящий CoAlly: проект появляется только после index_project, иначе
// инструменты отвечают ТЕКСТОМ {"error":"No project found. Run index_project first."}
const projectsOnServer = new Set<string>();
const indexCalls: any[] = [];
let sessionHeaderSeen = false;
const mock = Bun.serve({
  port: 0,
  fetch: async (req) => {
    const u = new URL(req.url);
    if (u.pathname !== "/mcp") return new Response(JSON.stringify({ detail: "Not Found" }), { status: 404 });
    const auth = req.headers.get("authorization") ?? "";
    if (!auth) return Response.json({ error: "Missing API key", code: "AUTH_REQUIRED" }, { status: 401 });
    if (auth !== `Bearer ${KEY}`) return Response.json({ error: "Invalid API key", code: "AUTH_INVALID" }, { status: 401 });
    const msg = await req.json() as any;
    if (msg.method !== "initialize" && req.headers.get("mcp-session-id") === "s-42") sessionHeaderSeen = true;
    if (msg.id === undefined) return new Response(null, { status: 202 });
    let result: any;
    if (msg.method === "initialize") result = { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "coally-nexus", version: "x" } };
    else if (msg.method === "tools/list") result = { tools: TOOLS.map((name) => ({ name, inputSchema: { type: "object" } })) };
    else if (msg.method === "tools/call" && msg.params?.name === "index_project") {
      indexCalls.push(msg.params.arguments);
      if (projectsOnServer.has(String(msg.params.arguments.project_name))) {
        // поведение облака: повторная индексация существующего проекта падает на уникальности
        result = { content: [{ type: "text", text: JSON.stringify({ error: "Failed to index project: duplicate key value violates unique constraint \"projects_name_key\"" }) }] };
        return new Response(`data: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })}

`, { headers: { "content-type": "text/event-stream" } });
      }
      projectsOnServer.add(String(msg.params.arguments.project_name));
      result = { content: [{ type: "text", text: JSON.stringify({ status: "indexed", project: msg.params.arguments.project_name }) }] };
    } else if (msg.method === "tools/call" && (msg.params?.name === "save_session_context" || msg.params?.name === "retrieve_task_context")
      && !projectsOnServer.has(String(msg.params.arguments.project_name ?? ""))) {
      result = { content: [{ type: "text", text: JSON.stringify({ error: "No project found. Run index_project first." }) }] };
    } else if (msg.method === "tools/call" && msg.params?.name === "save_session_context") {
      saved.push(msg.params.arguments);
      result = { content: [{ type: "text", text: "saved: task 17" }] };
    } else if (msg.method === "tools/call" && msg.params?.name === "retrieve_task_context") {
      result = { content: [{ type: "text", text: JSON.stringify({ project: msg.params.arguments.project_name, results: [{ content: `found for "${msg.params.arguments.query}": loan calc uses annuity formula`, author: "opencode" }] }) }] };
    } else return Response.json({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
    const body = { jsonrpc: "2.0", id: msg.id, result };
    // tools/* отвечаем потоком SSE (как streamable HTTP), initialize — JSON
    if (msg.method.startsWith("tools/")) {
      return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: {} })}\n\nevent: message\ndata: ${JSON.stringify(body)}\n\n`,
        { headers: { "content-type": "text/event-stream", "mcp-session-id": "s-42" } });
    }
    return Response.json(body, { headers: { "mcp-session-id": "s-42" } });
  },
});
const MOCK = `http://127.0.0.1:${mock.port}/mcp`;
const cfg = (over: Partial<any> = {}) => ({ enabled: true, url: MOCK, apiKey: KEY, project: "loans", timeoutMs: 4000, ...over });

// ── модуль ──
check("адрес CoAlly по умолчанию — MCP", isMcpUrl(COALLY_MCP_URL) && !isMcpUrl("https://x.example/api/entries"));
check("SSE-ответ: берётся событие с нужным id", parseRpcBody(`data: {"jsonrpc":"2.0","method":"x"}\n\ndata: {"jsonrpc":"2.0","id":3,"result":{"a":1}}\n\n`, "text/event-stream", 3)?.result?.a === 1);
const noKey = await testConnection(cfg({ apiKey: "" }));
check("без ключа: понятная причина (401, нужен ключ cnx_)", !noKey.ok && noKey.status === 401 && /cnx_/.test(noKey.detail), noKey.detail);
const badKey = await testConnection(cfg({ apiKey: "cnx_wrong" }));
check("неверный ключ: подсказка, где взять новый", !badKey.ok && /API Keys/.test(badKey.detail), badKey.detail);
const ok = await testConnection(cfg());
check("рукопожатие + tools/list: 5 инструментов", ok.ok && ok.tools?.length === 5, ok.detail);
check("Mcp-Session-Id передаётся после initialize", sessionHeaderSeen);

const entry: any = {
  schema: "dirigo.knowledge/1", project: "loans", sessionId: "ses_abc", title: "расчёт аннуитета",
  author: "opencode", model: "big-pickle", summary: "Агент изменил 1 файл.", decisions: ["Проверки: 1/1"],
  modules: ["loan_calc.py"], checks: { total: 1, passed: 1, returnedToAgent: 0 }, approvedBy: "ilya",
  commit: "abc1234", evidencePackId: "ses_abc.1", at: 1,
};
const args = coallyArgs(entry, "loans");
check("аргументы save_session_context по схеме CoAlly", args.task_description === "расчёт аннуитета" && args.project_name === "loans"
  && (args.modules_affected as string[])[0] === "loan_calc.py" && args.external_task_id === "dirigo:ses_abc" && args.commit_hash === "abc1234");
savePolicy({ mode: "warn" });
const pushed = await pushEntry(entry, cfg(), import.meta.dir);
check("запись задачи уходит через MCP", pushed.ok && pushed.via === "mcp" && saved.length === 1, pushed.detail);
check("перед первой записью проект проиндексирован (index_project с деревом)", indexCalls.length === 1 && indexCalls[0].project_name === "loans" && String(indexCalls[0].tree).length > 0, JSON.stringify(indexCalls[0] ?? {}).slice(0, 120));
await pushEntry(entry, cfg(), import.meta.dir);
check("повторная запись не индексирует заново", indexCalls.length === 1 && saved.length === 2);
// сервер «забыл» проект (база пересоздана) — пульт индексирует заново и пишет
projectsOnServer.clear();
const again = await pushEntry(entry, cfg(), import.meta.dir);
check("«No project found» в теле ответа → переиндексация и запись", again.ok && indexCalls.length === 2 && saved.length === 3, again.detail);
// пульт «забыл» (новая папка данных), а проект в облаке есть — запись всё равно проходит
{
  const { saveKnowledge } = await import("../src/knowledge");
  saveKnowledge({ indexed: [] });
  const dup = await pushEntry(entry, cfg(), import.meta.dir);
  check("проект уже есть в облаке (duplicate key) — запись проходит", dup.ok && saved.length === 4, dup.detail);
}
saved.splice(1); // дальше счёт как раньше: одна запись
const { coallyCall, formatResults } = await import("../src/knowledge");
const { McpHttpClient } = await import("../src/mcp-client");
const raw = new McpHttpClient(MOCK, KEY, 4000);
await raw.initialize();
const errBody = await coallyCall(raw, "retrieve_task_context", { query: "x", project_name: "нет-такого" });
check("ошибка в теле ответа инструмента — это ошибка, а не успех", !errBody.ok && errBody.noProject === true, errBody.error);
check("результаты поиска — читаемым текстом", /^1\. found/.test(formatResults(JSON.stringify({ results: [{ content: "found x", author: "a" }] }))) && formatResults(JSON.stringify({ results: [] })) === "ничего не найдено");

savePolicy({ mode: "redact" });
await pushEntry({ ...entry, title: "письмо клиенту ivan.petrov@bank.de" }, cfg());
check("redact: e-mail заменён ДО отправки в базу", saved.length === 2 && !JSON.stringify(saved[1]).includes("ivan.petrov@bank.de") && /REDACTED:EMAIL/.test(saved[1].task_description), saved[1]?.task_description);
savePolicy({ mode: "block" });
const blocked = await pushEntry({ ...entry, title: "карта 4111 1111 1111 1111" }, cfg());
check("block: запись с PII не отправляется вовсе", !blocked.ok && !!blocked.skipped && saved.length === 2, blocked.skipped);
const qBlocked = await searchKnowledge("найди ivan.petrov@bank.de", cfg());
check("block: поисковый запрос с PII не уходит", !qBlocked.ok && /политика/.test(qBlocked.detail ?? ""));
savePolicy({ mode: "warn" });
const found = await searchKnowledge("как считаем кредит", cfg());
check("поиск retrieve_task_context возвращает текст", found.ok && /annuity/.test(found.text ?? ""), found.detail ?? found.text);
const disabled = await pushEntry(entry, cfg({ enabled: false }));
check("выключено — ничего не уходит", !disabled.ok && saved.length === 2);

// ── сквозной путь: демон + экран настроек ──
const PORT = Number(process.env.COALLY_PORT ?? 7293);
const BASE = `http://127.0.0.1:${PORT}`;
const SDATA = join(DATA, "srv");
const server = Bun.spawn([process.execPath, "run", "src/server.ts"], {
  cwd: join(import.meta.dir, ".."),
  // подменная домашняя папка агентов: кнопка «Подключить к агентам» в тесте
  // пишет туда, настоящие конфиги машины не трогаются
  env: { ...process.env, PORT: String(PORT), DIRIGO_DATA: SDATA, DIRIGO_AGENT_HOME: join(DATA, "agent-home"), DIRIGO_AGENT_INSTALLED: "claude-code,opencode,kilo,hermes,minimax" },
  stdout: "ignore", stderr: "ignore",
});
let browser: import("playwright").Browser | null = null;
try {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* */ } await Bun.sleep(250); }
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(BASE, { waitUntil: "commit" });
  await page.waitForSelector(".oc-side", { timeout: 15000 });
  await page.click("#nav-settings");
  await page.waitForSelector("#view-settings:not(.hidden)", { timeout: 8000 });
  await page.waitForSelector("#kn-coally", { state: "visible", timeout: 10000 });
  await page.locator("#kn-coally").scrollIntoViewIfNeeded();
  await page.click("#kn-coally");
  check("UI: «Подставить адрес CoAlly» заполняет MCP-адрес", (await page.inputValue("#kn-url")) === COALLY_MCP_URL);
  // дальше — на заглушку: проверяем, что «Проверить связь» берёт введённое, не сохранённое ранее
  await page.fill("#kn-url", MOCK);
  await page.fill("#kn-key", KEY);
  await page.fill("#kn-project", "loans");
  await page.click("#kn-test");
  await page.waitForFunction(() => /подключено|не|MCP|HTTP/.test(document.getElementById("kn-result")!.textContent ?? "") && !/проверяем/.test(document.getElementById("kn-result")!.textContent ?? ""), null, { timeout: 15000 });
  const res = await page.textContent("#kn-result");
  check("UI: «Проверить связь» → подключено, 5 инструментов", /подключено: 5/.test(res ?? ""), res ?? "");
  const kn = await (await fetch(`${BASE}/api/knowledge`)).json() as any;
  check("ключ сохранён, но наружу не отдаётся", kn.knowledge?.apiKey === "set" && !JSON.stringify(kn).includes(KEY));
  check("UI: поле ключа очищено после сохранения", (await page.inputValue("#kn-key")) === "");
  await page.fill("#kn-query", "как считаем кредит");
  await page.click("#kn-search");
  await page.waitForFunction(() => /annuity|не/.test(document.getElementById("kn-out")!.textContent ?? ""), null, { timeout: 15000 });
  check("UI: поиск по базе знаний показывает ответ", /annuity/.test((await page.textContent("#kn-out")) ?? ""));
  // «Подключить CoAlly к агентам» → статусы по агентам, записи в конфигах
  page.on("dialog", (d) => d.accept());
  await page.click("#kn-agents-add");
  await page.waitForFunction(() => /добавлен|подключён/.test(document.getElementById("kn-agents")!.textContent ?? ""), null, { timeout: 15000 }).catch(() => null);
  const agText = (await page.textContent("#kn-agents")) ?? "";
  check("UI: подключение к агентам — статус по каждому", /Claude Code\s*добавлен/.test(agText) && /Kilo\s*добавлен/.test(agText) && /Hermes\s*добавлен/.test(agText) && /MiniMax Code\s*в сессиях пульта/.test(agText) && /Cursor\s*не установлен/.test(agText), agText.replace(/\s+/g, " ").slice(0, 200));
  const ah = join(DATA, "agent-home");
  const ocCfg = JSON.parse(readFileSync(join(ah, ".config", "opencode", "opencode.json"), "utf8"));
  check("UI: запись opencode с адресом и ключом из настроек", ocCfg.mcp?.["coally-nexus"]?.url === MOCK && ocCfg.mcp["coally-nexus"].headers.Authorization === `Bearer ${KEY}`);
  check("UI: флаг «подключено к агентам» сохранён", (await (await fetch(`${BASE}/api/knowledge/agents`)).json() as any).linked === true);
  await page.click("#kn-agents-remove");
  await page.waitForFunction(() => /убран/.test(document.getElementById("kn-agents")!.textContent ?? ""), null, { timeout: 15000 }).catch(() => null);
  const ocAfter = JSON.parse(readFileSync(join(ah, ".config", "opencode", "opencode.json"), "utf8"));
  check("UI: «Убрать из агентов» — записи нет, флаг снят", !ocAfter.mcp?.["coally-nexus"] && (await (await fetch(`${BASE}/api/knowledge/agents`)).json() as any).linked === false);
  check("UI: ноль JS-ошибок", errors.length === 0, errors.slice(0, 2).join(" | "));
} catch (e) {
  check("сквозной путь без исключений", false, String(e).slice(0, 240));
} finally {
  await browser?.close().catch(() => null);
  server.kill();
}

// ── живое облако (если дан ключ) ──
const LIVE = process.env.COALLY_API_KEY ?? "";
if (LIVE) {
  const live = await testConnection({ enabled: true, url: COALLY_MCP_URL, apiKey: LIVE, project: process.env.COALLY_PROJECT ?? "", timeoutMs: 15000 });
  check("облако CoAlly: подключение и инструменты", live.ok, live.detail);
  // Полный цикл в облаке — всегда в ОДНОМ тестовом проекте (на бесплатном
  // тарифе CoAlly проектов всего 2; новые тесты не должны их съедать).
  savePolicy({ mode: "warn" });
  const { saveKnowledge, loadKnowledge } = await import("../src/knowledge");
  saveKnowledge({ enabled: true, url: COALLY_MCP_URL, apiKey: LIVE, project: "dirigo-e2e-probe" });
  const mark = `dirigo-e2e-${Date.now().toString(36)}`;
  const pushedLive = await pushEntry({ ...entry, project: "dirigo-e2e-probe", sessionId: mark, title: `проверка записи ${mark}`, commit: null }, loadKnowledge(), import.meta.dir);
  check("облако: запись задачи (index_project при необходимости + save_session_context)", pushedLive.ok, pushedLive.detail);
  let foundLive = await searchKnowledge(mark, loadKnowledge(), 5, { name: "dirigo-e2e-probe" });
  // индексация поиска в облаке асинхронна — даём ей несколько секунд
  for (let i = 0; i < 6 && !(foundLive.text ?? "").includes(mark); i++) { await Bun.sleep(2500); foundLive = await searchKnowledge(mark, loadKnowledge(), 5, { name: "dirigo-e2e-probe" }); }
  check("облако: поиск находит только что записанную задачу", foundLive.ok && (foundLive.text ?? "").includes(mark), (foundLive.detail ?? foundLive.text ?? "").slice(0, 160));
} else {
  const anon = await testConnection({ enabled: true, url: COALLY_MCP_URL, apiKey: "", project: "", timeoutMs: 10000 });
  // без сети — не провал продукта; с сетью сервер должен честно требовать ключ
  if (anon.status === 401) check("облако CoAlly отвечает и требует ключ (401)", true, anon.detail);
  else console.log(`SKIP  облако CoAlly недоступно: ${anon.detail}`);
}

mock.stop(true);
await Bun.sleep(300);
try { rmSync(DATA, { recursive: true, force: true }); } catch { /* */ }
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
