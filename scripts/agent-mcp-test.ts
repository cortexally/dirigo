#!/usr/bin/env bun
// Подключение CoAlly (MCP) к агентам машины — src/agent-mcp.ts (1.9.2).
//
// Во временной «домашней папке» лежат настоящие по форме конфиги агентов с
// чужими настройками. Проверяем: запись по формату каждого агента, чужое не
// тронуто, копия до первой правки, повтор ничего не меняет, обновление ключа,
// чистое удаление, JSONC с комментариями, YAML hermes с уже существующими
// mcp_servers, TOML codex, «не установлен», ACP-запись для minimax, и API.
//
//   bun run scripts/agent-mcp-test.ts
//   DIRIGO_AGENT_MCP_LIVE=1 … — дополнительно: реальные `claude/devin mcp get`
//   на этой машине (только чтение: ничего не добавляет).
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const H = join(tmpdir(), `dirigo-agentmcp-${Date.now().toString(36)}`);
const APPDATA = join(H, "AppData", "Roaming"), LOCAL = join(H, "AppData", "Local");
mkdirSync(H, { recursive: true });
let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  ok ? pass++ : fail++;
};
const put = (rel: string, text: string) => { const p = join(H, rel); mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, text); return p; };
const read = (rel: string) => readFileSync(join(H, rel), "utf8");
const json = (rel: string) => JSON.parse(read(rel));

// чужие настройки, которые нельзя потерять
put(".config/opencode/opencode.json", JSON.stringify({ $schema: "https://opencode.ai/config.json", provider: { tooken: { name: "Tooken" } }, mcp: { mine: { type: "local", command: ["x"] } } }, null, 2));
put(".config/kilo/kilo.jsonc", `{\n  // комментарий пользователя\n  "$schema": "https://app.kilo.ai/config.json",\n  "permission": { "bash": { "git *": "allow" } }, /* блок */\n}\n`);
put(".zcode/cli/setting.json", JSON.stringify({ ui: { theme: "dark" }, mcp: { servers: {} } }));
const hermesYaml = put("AppData/Local/hermes/config.yaml", `_config_version: 50\nmodel:\n  default: x\n# mcp_servers:\n#   time:\n#     command: uvx\nmcp_servers:\n  time:\n    command: uvx\n    args: ["mcp-server-time"]\ndisplay:\n  theme: dark\n`);
put(".codex/config.toml", `model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "npx"\n`);
put(".claude.json", JSON.stringify({ numStartups: 5, mcpServers: { github: { type: "stdio", command: "gh" } } }));

const am = await import("../src/agent-mcp");
const installedSet = new Set(["claude-code", "devin", "opencode", "kilo", "cline", "cursor", "freebuff", "zcode", "hermes", "codex", "minimax"]);
const env = { home: H, appdata: APPDATA, localappdata: LOCAL, live: false, installed: (id: string) => installedSet.has(id) };
const KEY = "cnx_test_123";
const spec = am.coallySpec("https://coally.cortexally.ai/mcp", KEY);

// ── установка ──
const res = await am.installMcpForAgents(spec, env);
const by = Object.fromEntries(res.map((r) => [r.agent, r]));
check("установка: ни одной ошибки", !res.some((r) => r.state === "error"), res.filter((r) => r.state === "error").map((r) => `${r.agent}: ${r.detail}`).join("; "));
check("не установленные агенты пропущены (gemini, copilot)", by.gemini?.state === "not-installed" && by.copilot?.state === "not-installed");
check("minimax — подключение в сессиях пульта (ACP)", by.minimax?.state === "session-only");

const auth = `Bearer ${KEY}`;
check("claude: mcpServers http + заголовок, github и прочее на месте",
  json(".claude.json").mcpServers["coally-nexus"]?.type === "http" && json(".claude.json").mcpServers["coally-nexus"].headers.Authorization === auth
  && json(".claude.json").mcpServers.github?.command === "gh" && json(".claude.json").numStartups === 5);
check("devin: ~/.config/devin/mcp_config.json", json(".config/devin/mcp_config.json").mcpServers["coally-nexus"]?.url === spec.url);
const oc = json(".config/opencode/opencode.json");
check("opencode: mcp.remote, свои провайдер и сервер на месте", oc.mcp["coally-nexus"]?.type === "remote" && oc.mcp["coally-nexus"].enabled === true && oc.provider?.tooken?.name === "Tooken" && oc.mcp.mine?.type === "local");
const kl = JSON.parse(am.stripJsonc(read(".config/kilo/kilo.jsonc")));
check("kilo: JSONC с комментариями прочитан, запись добавлена, permission на месте", kl.mcp?.["coally-nexus"]?.headers?.Authorization === auth && kl.permission?.bash?.["git *"] === "allow");
check("cline: type=streamableHttp (без него cline считает SSE)", json(".cline/data/settings/cline_mcp_settings.json").mcpServers["coally-nexus"]?.type === "streamableHttp");
check("cursor: ~/.cursor/mcp.json url+headers", json(".cursor/mcp.json").mcpServers["coally-nexus"]?.headers?.Authorization === auth);
check("freebuff: ~/.agents/mcp.json type=http", json(".agents/mcp.json").mcpServers["coally-nexus"]?.type === "http");
check("zcode: mcp.servers, ui на месте", json(".zcode/cli/setting.json").mcp.servers["coally-nexus"]?.type === "http" && json(".zcode/cli/setting.json").ui.theme === "dark");
const hy = read("AppData/Local/hermes/config.yaml");
check("hermes: блок внутри существующего mcp_servers, time и display на месте",
  /mcp_servers:\n# >>> dirigo:coally-nexus\n  coally-nexus:\n    url: "https:\/\/coally\.cortexally\.ai\/mcp"\n    headers:\n      Authorization: "Bearer cnx_test_123"\n# <<< dirigo:coally-nexus\n  time:/.test(hy) && /display:\n  theme: dark/.test(hy) && (hy.match(/^mcp_servers:/gm) ?? []).length === 1, hy.slice(hy.indexOf("mcp_servers:\n"), hy.indexOf("mcp_servers:\n") + 220));
const ct = read(".codex/config.toml");
check("codex: секция [mcp_servers.\"coally-nexus\"], чужая секция на месте", ct.includes(`[mcp_servers."coally-nexus"]`) && ct.includes(`http_headers = { "Authorization" = "Bearer cnx_test_123" }`) && ct.includes("[mcp_servers.other]") && ct.startsWith(`model = "gpt-5"`));
check("копии до первой правки (*.dirigo-backup)", existsSync(join(H, ".config/opencode/opencode.json.dirigo-backup")) && existsSync(hermesYaml + ".dirigo-backup")
  && JSON.parse(readFileSync(join(H, ".config/opencode/opencode.json.dirigo-backup"), "utf8")).mcp["coally-nexus"] === undefined);

// ── повтор и обновление ключа ──
const again = await am.installMcpForAgents(spec, env);
check("повтор: всё «уже подключён», файлы не меняются", again.filter((r) => !["not-installed", "session-only"].includes(r.state)).every((r) => r.state === "present"), again.map((r) => `${r.agent}:${r.state}`).join(" "));
check("повтор не дублирует блок hermes", (read("AppData/Local/hermes/config.yaml").match(/>>> dirigo:coally-nexus/g) ?? []).length === 1);
const upd = await am.installMcpForAgents(am.coallySpec(spec.url, "cnx_new_456"), env);
check("новый ключ: записи обновлены", upd.filter((r) => !["not-installed", "session-only"].includes(r.state)).every((r) => r.state === "updated") && read("AppData/Local/hermes/config.yaml").includes("cnx_new_456") && !read("AppData/Local/hermes/config.yaml").includes("cnx_test_123"));
check("копия хранит исходный файл, а не промежуточный", !readFileSync(join(H, ".claude.json.dirigo-backup"), "utf8").includes("coally"));

// ── статус ──
const st = am.mcpStatusForAgents("coally-nexus", env);
check("статус: подключён у всех установленных", st.filter((r) => !["not-installed", "session-only"].includes(r.state)).every((r) => r.state === "present"));

// ── удаление ──
const rm = await am.removeMcpFromAgents("coally-nexus", env);
check("удаление: убран у всех", rm.filter((r) => !["not-installed", "session-only"].includes(r.state)).every((r) => r.state === "removed"), rm.map((r) => `${r.agent}:${r.state}`).join(" "));
const hy2 = read("AppData/Local/hermes/config.yaml");
check("удаление hermes: только наш блок, time на месте", !hy2.includes("coally") && /mcp_servers:\n  time:/.test(hy2));
check("удаление: чужие серверы на месте", json(".claude.json").mcpServers.github?.command === "gh" && json(".config/opencode/opencode.json").mcp.mine?.type === "local" && read(".codex/config.toml").includes("[mcp_servers.other]") && !read(".codex/config.toml").includes("coally"));
check("повторное удаление: «не был подключён»", (await am.removeMcpFromAgents("coally-nexus", env)).filter((r) => !["not-installed", "session-only"].includes(r.state)).every((r) => r.state === "absent"));

// ── битый конфиг не трогаем ──
put(".cursor/mcp.json", "{ это не json");
const broken = await am.installMcpForAgents(spec, env, ["cursor"]);
check("битый JSON: ошибка с объяснением, файл не перезаписан", broken[0]?.state === "error" && read(".cursor/mcp.json") === "{ это не json", broken[0]?.detail);

// ── hermes без mcp_servers ──
put("AppData/Local/hermes/config.yaml", "model:\n  default: x\n# mcp_servers:\n#   time:\n");
await am.installMcpForAgents(spec, env, ["hermes"]);
const hy3 = read("AppData/Local/hermes/config.yaml");
check("hermes без mcp_servers: ключ создан в конце, комментарии не тронуты", /\n\nmcp_servers:\n# >>> dirigo:coally-nexus/.test(hy3) && hy3.includes("# mcp_servers:\n#   time:"));

// ── ACP для minimax ──
const acp = am.acpMcpServers("minimax", spec) as any[];
check("ACP minimax: http-сервер с заголовком в session/new", acp[0]?.type === "http" && acp[0].headers[0].name === "Authorization" && acp[0].headers[0].value === `Bearer ${KEY}`);
check("ACP другим агентам не дублируем (у них пользовательский конфиг)", am.acpMcpServers("opencode", spec).length === 0 && am.acpMcpServers("minimax", null).length === 0);
check("JSONC: строки с // внутри не ломаются", JSON.parse(am.stripJsonc(`{"u":"https://x//y", /*c*/ "a":1,}`)).u === "https://x//y");

// Регресс 1.9.2: статус звал `claude mcp get` синхронно — демон замирал на
// секунды, пока открыты Настройки (не грузилась даже доска). Статус — только
// чтение файлов, CLI агентов — только асинхронно.
const src = readFileSync(join(import.meta.dir, "..", "src", "agent-mcp.ts"), "utf8");
check("нет синхронного запуска процессов (spawnSync держал весь демон)", !/spawnSync/.test(src));

// ── живая машина (только чтение) ──
if (process.env.DIRIGO_AGENT_MCP_LIVE === "1") {
  const t0 = performance.now();
  const live = am.mcpStatusForAgents("coally-nexus");
  check("живая машина: статус без запуска агентов (< 300 мс)", performance.now() - t0 < 300, `${Math.round(performance.now() - t0)} мс`);
  for (const r of live) console.log(`INFO  ${r.label}: ${r.state}${r.where ? " · " + r.where : ""}`);
  check("живая машина: статус читается у всех агентов без ошибок", !live.some((r) => r.state === "error"), live.filter((r) => r.state === "error").map((r) => `${r.agent}: ${r.detail}`).join("; "));
}

for (let i = 0; i < 5; i++) { try { rmSync(H, { recursive: true, force: true }); break; } catch { await Bun.sleep(300); } }
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
