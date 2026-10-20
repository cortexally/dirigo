// Регресс: после прогонов висели десятки процессов. Bun на Windows сам гасит ПРЯМЫХ
// детей при выходе (даже при жёстком убийстве), но не внуков: агенты демона, процессы
// под cmd-шимами оставались. Проверяем — на внуках, где без исправления процесс выживает:
//  A) тест вышел, не прибрав за собой, → внук погашен (уборка на выходе, test-cleanup.ts);
//  B) родитель демона убит жёстко → демон гасит своё дерево и выходит (parent-watch.ts);
//  C) .kill() гасит дерево, а не только верхний процесс;
//  D) продукт: у демона пользователя сторож выключен, предзагрузка — только для scripts/.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isTestMain } from "./test-cleanup";
import { watchParent } from "../src/parent-watch";

const ROOT = join(import.meta.dir, "..");
const TMP = mkdtempSync(join(tmpdir(), "dg-cleanup-"));
const WATCH = join(ROOT, "src", "parent-watch.ts").replace(/\\/g, "/");
let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) pass++; else fail++; console.log(`${c ? "PASS" : "FAIL"} ${m}`); };
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitDead = async (pid: number, ms: number) => { const t = Date.now() + ms; while (Date.now() < t) { if (!alive(pid)) return true; await Bun.sleep(250); } return !alive(pid); };
const hardKill = (pid: number) => Bun.spawnSync(["taskkill", "/PID", String(pid), "/F"], { stdout: "ignore", stderr: "ignore", windowsHide: true }); // без /T
const leftovers: number[] = [];
/** внук: cmd (ребёнок) → ping (внук); pid внука печатается как GRAND <pid> */
const GRAND = `
const c = Bun.spawn(["cmd", "/c", "ping -n 120 127.0.0.1 >nul"], { stdout: "ignore" });
for (let i = 0; i < 40; i++) {
  await Bun.sleep(150);
  const r = Bun.spawnSync(["powershell", "-NoProfile", "-Command", "(Get-CimInstance Win32_Process -Filter 'ParentProcessId=" + c.pid + "').ProcessId"], { windowsHide: true });
  const g = Number(r.stdout.toString().trim().split(/\\s+/)[0] || 0);
  if (g) { console.log("GRAND " + g); break; }
}`;
async function readMark(proc: ReturnType<typeof Bun.spawn>, mark: string): Promise<number> {
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  let out = ""; const t = Date.now() + 30_000;
  while (Date.now() < t && !new RegExp(mark + " \\d+").test(out)) { const r = await reader.read(); if (r.done) break; out += new TextDecoder().decode(r.value); }
  reader.releaseLock();
  const n = Number(new RegExp(mark + " (\\d+)").exec(out)?.[1] ?? 0);
  if (n) leftovers.push(n);
  return n;
}

if (process.platform !== "win32") {
  console.log("SKIP A–C: только Windows (на Unix дерево гасит группа процессов)");
} else try {
  // A: «тест» (фикстура с предзагрузкой) выходит, не погасив своих детей
  {
    const f = join(TMP, "a.ts");
    writeFileSync(f, GRAND + "\nprocess.exit(1); // упал до уборки\n");
    const p = Bun.spawn([process.execPath, "run", f], { cwd: ROOT, env: { ...process.env, DIRIGO_TEST_CLEANUP: "1" }, stdout: "pipe", stderr: "ignore" });
    const grand = await readMark(p, "GRAND");
    await p.exited;
    ok(grand > 0 && await waitDead(grand, 5000), `A: тест вышел без уборки → внук ${grand} погашен`);
  }
  // B: демон (со сторожем) теряет родителя, убитого жёстко
  {
    const parent = Bun.spawn([process.execPath, "-e", "setInterval(()=>{},1000)"], { stdout: "ignore" });
    const f = join(TMP, "b.ts");
    writeFileSync(f, `import { watchParent } from ${JSON.stringify(WATCH)};\nwatchParent(300);\n${GRAND}\nsetInterval(() => {}, 1000);\n`);
    // cwd вне каталога пульта: без предзагрузки проверяется только сторож демона
    const d = Bun.spawn([process.execPath, "run", f], { cwd: TMP, env: { ...process.env, DIRIGO_EXIT_WITH_PARENT: String(parent.pid) }, stdout: "pipe", stderr: "ignore" });
    const grand = await readMark(d, "GRAND");
    hardKill(parent.pid);
    ok(await waitDead(d.pid, 6000), "B: родитель убит жёстко → демон вышел сам");
    ok(grand > 0 && await waitDead(grand, 6000), `B: …и погасил процессы своих агентов (внук ${grand})`);
  }
  // C: .kill() — всё дерево
  {
    const p = Bun.spawn(["cmd", "/c", "ping -n 120 127.0.0.1 >nul"], { stdout: "ignore" });
    let grand = 0;
    for (let i = 0; i < 40 && !grand; i++) {
      await Bun.sleep(150);
      const r = Bun.spawnSync(["powershell", "-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter 'ParentProcessId=${p.pid}').ProcessId`], { windowsHide: true });
      grand = Number(r.stdout.toString().trim().split(/\s+/)[0] || 0);
    }
    if (grand) leftovers.push(grand);
    p.kill();
    await p.exited;
    ok(grand > 0 && await waitDead(grand, 5000), `C: .kill() гасит дерево (внук ${grand})`);
  }
} finally {
  for (const pid of leftovers) if (alive(pid)) hardKill(pid);
}
// D
ok(!isTestMain("C:/Users/x/.dirigo/current/src/server.ts") && !isTestMain("/home/x/.dirigo/current/src/server.ts"), "D: предзагрузка не включается для демона продукта");
ok(isTestMain(join(ROOT, "scripts", "smoke.ts")), "D: …и включается для наборов scripts/");
const saved = process.env.DIRIGO_EXIT_WITH_PARENT;
delete process.env.DIRIGO_EXIT_WITH_PARENT;
ok(watchParent() === null, "D: без DIRIGO_EXIT_WITH_PARENT сторож выключен (демон пользователя)");
if (saved) process.env.DIRIGO_EXIT_WITH_PARENT = saved;

for (let i = 0; i < 10; i++) { try { rmSync(TMP, { recursive: true, force: true }); break; } catch { await Bun.sleep(500); } }
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
