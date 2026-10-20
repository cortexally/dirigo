// Регресс 0.1.0: cline поднимал отвязанный хаб без консоли → окна терминала от его
// процессов, хаб переживал пульт и держал копию сессии. Теперь хаб поднимает пульт
// (скрытая консоль, нейтральная папка, умирает с пультом), а cline к нему подключается.
// Живая часть — только Windows и при установленном cline; файл обнаружения — временный
// (CLINE_HUB_DISCOVERY_PATH), хаб пользователя не затрагивается.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = join(import.meta.dir, "..");
const TMP = mkdtempSync(join(tmpdir(), "dg-clinehub-"));
process.env.CLINE_HUB_DISCOVERY_PATH = join(TMP, "discovery.json");
process.env.DIRIGO_DATA = join(TMP, "data");

const { hubArgv, liveHubPid, ensureClineHub, ownHubPid, stopClineHub } = await import("../src/agents/cline-hub");
const { getAgent, isMissingCommand } = await import("../src/agents/registry");
const { spawnPty } = await import("../src/agents/pty");

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) pass++; else fail++; console.log(`${c ? "PASS" : "FAIL"} ${m}`); };

// 1. статически: все три пути запуска cline поднимают хаб заранее
const runner = readFileSync(join(ROOT, "src/agents/runner.ts"), "utf8");
ok((runner.match(/if \(def\.id === "cline"\) await ensureClineHub\(def\.command\);/g) ?? []).length === 3, "runner: хаб перед CLI, ACP и PTY");

// 2. argv хаба: платформенный exe рядом с npm-обёрткой
const pkg = join(TMP, "npm", "cline");
mkdirSync(join(pkg, "bin"), { recursive: true });
mkdirSync(join(pkg, "node_modules", "@cline", "cli-windows-x64", "bin"), { recursive: true });
const exeName = process.platform === "win32" ? "cline.exe" : "cline";
writeFileSync(join(pkg, "node_modules", "@cline", "cli-windows-x64", "bin", exeName), "");
const argv = hubArgv(["node", join(pkg, "bin", "cline")], "C:/hub");
ok(argv[0]!.endsWith(exeName) && argv.includes("--cline-hub-daemon") && argv[argv.indexOf("--cwd") + 1] === "C:/hub", `argv хаба: ${argv[0]!.split(/[\\/]/).slice(-3).join("/")}`);
ok(hubArgv(["/x/other"], "/h").join(" ") === "/x/other --cline-hub-daemon --cwd /h --host 127.0.0.1 --port 0 --pathname /hub", "без платформенного пакета — через обёртку, порт 0");

// 3. файл обнаружения: мёртвый pid — хаба нет, живой — есть
writeFileSync(process.env.CLINE_HUB_DISCOVERY_PATH!, JSON.stringify({ pid: 999999 }));
ok(liveHubPid() === null, "мёртвый pid в файле обнаружения → хаба нет");
writeFileSync(process.env.CLINE_HUB_DISCOVERY_PATH!, JSON.stringify({ pid: process.pid }));
ok(liveHubPid() === process.pid, "живой pid → хаб есть (чужой не трогаем)");
ok(await ensureClineHub(["/nonexistent"]) === (process.platform === "win32"), "живой чужой хаб: новый не поднимается");
ok(ownHubPid() === null, "…и свой процесс не запущен");
rmSync(process.env.CLINE_HUB_DISCOVERY_PATH!, { force: true });

// 4. вживую
const def = getAgent("cline");
const hubs = async () => {
  const p = Bun.spawn(["powershell", "-NoProfile", "-NonInteractive", "-Command",
    "Get-CimInstance Win32_Process -Filter \"Name='cline.exe'\" | Where-Object { $_.CommandLine -match 'cline-hub-daemon' } | ForEach-Object { \"$($_.ProcessId)|$($_.ParentProcessId)|$($_.CommandLine)\" }"], { stdout: "pipe", windowsHide: true });
  return (await new Response(p.stdout).text()).split(/\r?\n/).filter(Boolean).map((l) => { const [pid, ppid, ...c] = l.split("|"); return { pid: Number(pid), ppid: Number(ppid), cmd: c.join("|") }; });
};
if (process.platform !== "win32" || !def || isMissingCommand(def.command)) {
  console.log("SKIP живая часть: не Windows или cline не установлен");
} else {
  const before = new Set((await hubs()).map((h) => h.pid));
  const t0 = Date.now();
  const started = await ensureClineHub(def.command);
  const pid = ownHubPid();
  ok(started && !!pid && liveHubPid() === pid, `пульт поднял хаб cline (${Date.now() - t0} мс, pid ${pid})`);
  const mine = (await hubs()).find((h) => h.pid === pid);
  ok(!!mine && mine.ppid === process.pid, "хаб — дочерний процесс пульта (не отвязан, скрытая консоль)");
  ok(!!mine && /dirigo|cline-hub/i.test(mine.cmd) && !/dg-clinehub-[^\\/]*[\\/]proj/i.test(mine.cmd), "рабочая папка хаба — нейтральная, не копия сессии");

  const proj = join(TMP, "proj"); mkdirSync(proj, { recursive: true });
  const cmd = def.ptyCommand?.command ?? def.command;
  const term = await spawnPty(cmd[0]!, cmd.slice(1), { cwd: proj, cols: 120, rows: 30, onData: () => {}, onExit: () => {} });
  await Bun.sleep(8000);
  const extra = (await hubs()).filter((h) => h.pid !== pid && !before.has(h.pid));
  ok(extra.length === 0, `cline подключился к хабу пульта, своего не запустил${extra.length ? ": " + extra.map((h) => h.cmd.slice(-80)).join("; ") : ""}`);
  term.kill();
  for (const h of extra) { try { process.kill(h.pid); } catch { /* */ } }
  stopClineHub();
  await Bun.sleep(800);
  ok(!(await hubs()).some((h) => h.pid === pid), "хаб пульта завершён вместе с пультом");
}

try { rmSync(TMP, { recursive: true, force: true }); } catch { /* Windows держит файлы */ }
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
