// Установка на Windows целиком, как у пользователя (`irm …/install.ps1 | iex`), но с
// локального сервера, во временную папку и на свой порт:
//   установщик → ярлыки «Dirigo» / «Stop Dirigo» → пульт отвечает →
//   ярлык остановки (stop.bat) гасит его → повторный запуск ярлыком (run.bat) поднимает.
// Ярлыки — в DIRIGO_SHORTCUT_DIR (меню «Пуск» и рабочий стол пользователя не трогаем).
// Комплект сайта собирает make-deploy во временную папку (нужен собранный бандл).
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = join(import.meta.dir, "..");
let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) pass++; else fail++; console.log(`${c ? "PASS" : "FAIL"} ${m}`); };

if (process.platform !== "win32") { console.log("SKIP: только Windows\n0/0 passed"); process.exit(0); }
const DIR = mkdtempSync(join(tmpdir(), "dg-install-"));
const DEPLOY = join(DIR, "site");
const mk = Bun.spawnSync([process.execPath, "run", "scripts/make-deploy.ts", "--out", DEPLOY], { cwd: ROOT, windowsHide: true });
if (mk.exitCode !== 0 || !existsSync(join(DEPLOY, "install.ps1"))) {
  console.log(`FAIL make-deploy: ${(mk.stdout.toString() + mk.stderr.toString()).slice(-400)}\n0/1 passed`);
  process.exit(1);
}

// Сайт за CDN со старой копией (так сломалась установка 0.1.0 после перевыкладки):
// на адрес без параметров отдаётся устаревший файл — старый архив и суммы от другой
// сборки. Установщик обязан брать суммы мимо кэша (?t=…), а архив — по его сумме (?sha256=…).
const STALE_SUMS = "0000000000000000000000000000000000000000000000000000000000000000 *dirigo-0.1.0.tar.gz\n";
const cdnHits = { staleBundle: 0, staleSums: 0, freshBundle: 0 };
const site = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req) => {
  const u = new URL(req.url);
  const p = decodeURIComponent(u.pathname);
  if (p.endsWith(".tar.gz") && !u.searchParams.get("sha256")) { cdnHits.staleBundle++; return new Response("stale bundle from cache"); }
  if (p.endsWith(".tar.gz")) cdnHits.freshBundle++;
  if (p.endsWith("/SHA256SUMS") && !u.search) { cdnHits.staleSums++; return new Response(STALE_SUMS); }
  const f = Bun.file(join(DEPLOY, p));
  return f.size ? new Response(f) : new Response("not found", { status: 404 });
} });
const free = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
const PORT = free.port; free.stop(true);
const LNK = join(DIR, "shortcuts");
const env = { ...process.env, DIRIGO_BASE_URL: `http://127.0.0.1:${site.port}`, DIRIGO_INSTALL_DIR: join(DIR, "app"),
  DIRIGO_SHORTCUT_DIR: LNK, PORT: String(PORT), DIRIGO_PORT: String(PORT), DIRIGO_NO_BROWSER: "1", DIRIGO_NO_OPEN: "1" } as Record<string, string>;
const health = async () => { try { return (await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; } };
const waitFor = async (want: boolean, ms: number) => { const t = Date.now() + ms; while (Date.now() < t) { if ((await health()) === want) return true; await Bun.sleep(500); } return false; };
const lnkTarget = async (p: string) => {
  const r = Bun.spawnSync(["powershell", "-NoProfile", "-Command", `(New-Object -ComObject WScript.Shell).CreateShortcut('${p.replace(/'/g, "''")}').TargetPath`], { windowsHide: true });
  return r.stdout.toString().trim();
};
const current = join(DIR, "app", "current");

// установщик — как у пользователя `irm … | iex`: текст ответа Invoke-RestMethod
// выполняется Invoke-Expression (= iex). Так ловится BOM, на котором
// 0.1.0 падала у пользователя («Missing argument in parameter list»); файлом этого не видно.
// Путь «скачать и запустить файлом» проверяют make-deploy и install-security-review.
const inst = Bun.spawn(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
  `[Console]::OutputEncoding = [Text.Encoding]::UTF8; $s = Invoke-RestMethod -UseBasicParsing 'http://127.0.0.1:${site.port}/install.ps1'; Invoke-Expression $s`], { env, stdout: "pipe", stderr: "pipe", windowsHide: true });
let out = "";
void (async () => { for await (const c of inst.stdout as any) out += new TextDecoder().decode(c); })();
try {
  ok(await waitFor(true, 180_000), `установщик поднял пульт на :${PORT}`);
  ok(cdnHits.freshBundle > 0 && cdnHits.staleBundle === 0 && cdnHits.staleSums === 0, `CDN со старой копией: архив и суммы взяты мимо кэша (свежих ${cdnHits.freshBundle}, устаревших ${cdnHits.staleBundle + cdnHits.staleSums})`);
  ok(/Start:.*"Dirigo" shortcut/.test(out) && /Stop:.*"Stop Dirigo" shortcut/.test(out) && out.includes(current), "установщик объяснил, где пульт и как запускать/останавливать");
  ok(existsSync(join(current, "run.bat")) && existsSync(join(current, "stop.bat")), "run.bat и stop.bat в каталоге установки");
  const run = join(LNK, "Dirigo.lnk"), stop = join(LNK, "Stop Dirigo.lnk");
  ok(existsSync(run) && (await lnkTarget(run)).toLowerCase() === join(current, "run.bat").toLowerCase(), "ярлык «Dirigo» → current\\run.bat");
  ok(existsSync(stop) && (await lnkTarget(stop)).toLowerCase() === join(current, "stop.bat").toLowerCase(), "ярлык «Stop Dirigo» → current\\stop.bat");

  // остановка ярлыком
  Bun.spawnSync(["cmd", "/c", join(current, "stop.bat")], { env, windowsHide: true, timeout: 60_000 });
  ok(await waitFor(false, 20_000), "ярлык «Stop Dirigo» гасит пульт");

  // повторный запуск ярлыком (run.bat держит окно с журналом — запускаем фоном)
  const again = Bun.spawn(["cmd", "/c", join(current, "run.bat")], { env, stdout: "ignore", stderr: "ignore", windowsHide: true });
  ok(await waitFor(true, 90_000), "ярлык «Dirigo» снова поднимает пульт");
  // run.bat пишет pid после своей проверки готовности (раз в секунду) — ждём
  for (let i = 0; i < 20 && !existsSync(join(current, "data", "dirigo.pid")); i++) await Bun.sleep(500);
  ok(existsSync(join(current, "data", "dirigo.pid")), "pid записан для остановки");
  Bun.spawnSync(["cmd", "/c", join(current, "stop.bat")], { env, windowsHide: true, timeout: 60_000 });
  ok(await waitFor(false, 20_000), "и снова останавливается");
  try { Bun.spawnSync(["taskkill", "/PID", String(again.pid), "/T", "/F"], { windowsHide: true }); } catch { /* */ }
} finally {
  try { Bun.spawnSync(["cmd", "/c", join(current, "stop.bat")], { env, windowsHide: true, timeout: 30_000 }); } catch { /* */ }
  try { Bun.spawnSync(["taskkill", "/PID", String(inst.pid), "/T", "/F"], { windowsHide: true }); } catch { /* */ }
  site.stop(true);
  for (let i = 0; i < 10; i++) { try { rmSync(DIR, { recursive: true, force: true }); break; } catch { await Bun.sleep(500); } }
}
if (fail) console.log(out.split("\n").slice(-25).join("\n"));
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
