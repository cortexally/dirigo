// Регресс: на прогоне гейта появлялись сотни мигающих окон консоли — демон и тесты
// запускали git/powershell/taskkill/bun без windowsHide. Проверяем:
//  1) src/hide-windows.ts подключён первым импортом server.ts и preload в bunfig.toml;
//  2) подстановка опций: windowsHide по умолчанию, detached (GUI) и явное значение не трогаются;
//  3) node child_process с именованным импортом (его не подменить) — windowsHide явно;
//  4) вживую (Windows): процесс без консоли (как демон в фоне) запускает powershell —
//     окно консоли у ребёнка невидимо.
import { readFileSync, readdirSync, existsSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { _test } from "../src/hide-windows";

const ROOT = join(import.meta.dir, "..");
let fail = 0, pass = 0;
const ok = (c: boolean, m: string) => { if (c) pass++; else fail++; console.log(`${c ? "PASS" : "FAIL"} ${m}`); };

// 1. подключение
const server = readFileSync(join(ROOT, "src/server.ts"), "utf8");
const firstImport = server.split("\n").find((l) => /^import\s/.test(l)) ?? "";
ok(/^import "\.\/hide-windows";/.test(firstImport), "server.ts: первый импорт — ./hide-windows");
ok(/preload\s*=\s*\[[^\]]*hide-windows/.test(readFileSync(join(ROOT, "bunfig.toml"), "utf8")), "bunfig.toml: preload hide-windows для скриптов и тестов");
// поверх Bun.spawn может стоять обёртка уборки тестов (test-cleanup) — смотрим флаг установки
if (process.platform === "win32") ok((globalThis as any)[Symbol.for("dirigo.hideWindows")] === true && String(Bun.spawnSync).includes("bunArgs"), "Bun.spawn/spawnSync обёрнуты в этом процессе (preload)");

// 2. подстановка
const { bunArgs, nodeArgs } = _test;
ok(bunArgs([["git"]])[1].windowsHide === true, "Bun.spawn(cmd) → windowsHide");
ok(bunArgs([["git"], undefined])[1].windowsHide === true, "Bun.spawnSync(cmd, undefined) → windowsHide");
ok(bunArgs([["git"], { cwd: "x" }])[1].cwd === "x" && bunArgs([["git"], { cwd: "x" }])[1].windowsHide === true, "опции сохраняются");
ok(bunArgs([{ cmd: ["git"] }])[0].windowsHide === true && bunArgs([{ cmd: ["git"] }])[0].cmd[0] === "git", "Bun.spawn({cmd}) → windowsHide");
ok(bunArgs([["app"], { detached: true }])[1].windowsHide === undefined, "detached (GUI) не скрывается");
ok(bunArgs([["x"], { windowsHide: false }])[1].windowsHide === false, "явный windowsHide:false уважается");
const cb = () => {};
const n1 = nodeArgs(["git", ["a"], cb]);
ok(n1.length === 4 && n1[2].windowsHide === true && n1[3] === cb, "execFile(file, args, cb) → опции перед колбэком");
ok(nodeArgs(["git", ["a"], { cwd: "y" }])[2].windowsHide === true, "spawn(file, args, opts) → windowsHide");
ok(nodeArgs(["git"])[1].windowsHide === true, "spawn(file) → windowsHide");
ok(nodeArgs(["git", { detached: true }])[1].windowsHide === undefined, "node detached не скрывается");

// 3. статически: именованный execFileSync/execSync в src — только с windowsHide
const offenders: string[] = [];
const walk = (d: string) => {
  for (const f of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, f.name);
    if (f.isDirectory()) { if (f.name !== "vendor") walk(p); continue; }
    if (!/\.ts$/.test(f.name)) continue;
    const src = readFileSync(p, "utf8");
    if (!/from "node:child_process"/.test(src)) continue;
    src.split("\n").forEach((l, i) => {
      if (/\b(execFileSync|execSync|spawnSync)\(/.test(l) && !/Bun\.spawnSync/.test(l) && !/windowsHide/.test(l)) offenders.push(`${p.slice(ROOT.length + 1)}:${i + 1}`);
    });
  }
};
walk(join(ROOT, "src"));
ok(offenders.length === 0, `node child_process в src с windowsHide${offenders.length ? ": " + offenders.join(", ") : ""}`);

// 4. вживую: родитель без консоли (DETACHED_PROCESS, как фоновый демон) → ребёнок powershell
if (process.platform === "win32") {
  const dir = mkdtempSync(join(tmpdir(), "dg-hide-"));
  const out = join(dir, "vis.txt").replace(/\\/g, "/");
  const ps = `Add-Type -Name W -Namespace N -MemberDefinition '[DllImport("kernel32.dll")] public static extern System.IntPtr GetConsoleWindow(); [DllImport("user32.dll")] public static extern bool IsWindowVisible(System.IntPtr h);'; $h=[N.W]::GetConsoleWindow(); [IO.File]::WriteAllText('${out}', [string]([N.W]::IsWindowVisible($h)))`;
  const child = join(dir, "child.ts");
  await Bun.write(child, `import ${JSON.stringify(join(ROOT, "src/hide-windows.ts").replace(/\\/g, "/"))};\nBun.spawnSync(["powershell", "-NoProfile", "-NonInteractive", "-Command", ${JSON.stringify(ps)}]);\n`);
  const p = Bun.spawn([process.execPath, child], { detached: true, stdio: ["ignore", "ignore", "ignore"], cwd: dir });
  await Promise.race([p.exited, Bun.sleep(30_000)]);
  const vis = existsSync(join(dir, "vis.txt")) ? readFileSync(join(dir, "vis.txt"), "utf8").trim() : "(нет результата)";
  ok(vis === "False", `консоль ребёнка процесса без консоли невидима (IsWindowVisible=${vis})`);
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
