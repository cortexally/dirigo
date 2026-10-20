#!/usr/bin/env bun
// Уборка процессов, которые агенты оставляют после себя (src/agents/daemons.ts).
// Поддельные процессы с теми же командными строками, что у настоящих:
//   хаб cline на нашей копии — гасим;      хаб cline на чужой папке — не трогаем;
//   сторож freebuff с мёртвым freebuff — гасим;  с живым — не трогаем.
import { join } from "node:path";
import { killAgentDaemons, sweepAgentOrphans } from "../src/agents/daemons";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  ok ? pass++ : fail++;
};
const node = Bun.which("node") ?? process.execPath;
const hold = "setInterval(()=>{},1000)";
const alive = (p: Bun.Subprocess) => { try { process.kill(p.pid, 0); return true; } catch { return false; } };
const spawn = (...tail: string[]) => Bun.spawn([node, "-e", hold, "--", ...tail], { stdout: "ignore", stderr: "ignore" });

const work = join(import.meta.dir, "..", ".daemons-test", "data", "work").replace(/\\/g, "/");
const ourHub = spawn("--cline-hub-daemon", "--cwd", `${work}/ses_abc`, "--port", "1");
const foreignHub = spawn("--cline-hub-daemon", "--cwd", "C:/Users/someone/elsewhere", "--port", "2");
const liveFb = spawn("freebuff-standin");
const deadPid = 999_991;
const deadWatch = spawn(`codebuff-watchdog-disarm-${deadPid}-x`);
const liveWatch = spawn(`codebuff-watchdog-disarm-${liveFb.pid}-x`);
await Bun.sleep(900);

// пульт пользуется асинхронной версией (синхронная держала цикл событий)
const { sweepAgentOrphansAsync: sweepA } = await import("../src/agents/daemons");
const n = await sweepA(work);
await Bun.sleep(600);
check("хаб cline на копии демона убран", !alive(ourHub));
check("хаб cline на чужой папке жив", alive(foreignHub));
check("сторож мёртвого freebuff убран", !alive(deadWatch));
check("сторож живого freebuff жив", alive(liveWatch));
check("уборка вернула число убранных", n >= 2, String(n));

// адресная уборка по папке сессии
const sessHub = spawn("--cline-hub-daemon", "--cwd", `${work}/ses_zzz`, "--port", "3");
await Bun.sleep(600);
killAgentDaemons(`${work}/ses_zzz`.replace(/\//g, "\\"));
await Bun.sleep(500);
check("хаб сессии убирается по её папке (любые слэши)", !alive(sessHub));

// 1.9.4: асинхронные версии — те же цели, и демон не замирает во время уборки
// (синхронный powershell Get-CimInstance держал однопоточный пульт секундами)
{
  const { killAgentDaemonsAsync, sweepAgentOrphansAsync } = await import("../src/agents/daemons");
  const asyncHub = spawn("--cline-hub-daemon", "--cwd", `${work}/ses_async`, "--port", "4");
  const asyncWatch = spawn(`codebuff-watchdog-disarm-${deadPid + 1}-y`);
  await Bun.sleep(700);
  let worst = 0, last = performance.now();
  const ticker = setInterval(() => { const now = performance.now(); worst = Math.max(worst, now - last); last = now; }, 50);
  const swept = await sweepAgentOrphansAsync(work);
  await Bun.sleep(400);
  check("асинхронная уборка сирот: хаб и мёртвый сторож убраны", !alive(asyncHub) && !alive(asyncWatch), String(swept));
  const sessHub2 = spawn("--cline-hub-daemon", "--cwd", `${work}/ses_async2`, "--port", "5");
  await Bun.sleep(600);
  await killAgentDaemonsAsync(`${work}/ses_async2`);
  await Bun.sleep(400);
  clearInterval(ticker);
  check("асинхронная адресная уборка по папке", !alive(sessHub2));
  check("цикл событий не блокируется во время уборки (< 400 мс)", worst < 400, `${Math.round(worst)} мс`);
  check("чужой хаб по-прежнему жив", alive(foreignHub));
  for (const p of [asyncHub, asyncWatch, sessHub2]) { try { p.kill(); } catch { /* */ } }
}

for (const p of [ourHub, foreignHub, liveFb, deadWatch, liveWatch, sessHub]) { try { p.kill(); } catch { /* */ } }
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
