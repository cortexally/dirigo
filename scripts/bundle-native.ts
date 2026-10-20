// Сборка релизного бандла без bash — работает на Windows, Linux и macOS.
// Раньше пути склеивались по-виндовому (item.replace("/", "\\")), поэтому
// на Linux/macOS сборка падала или собирала пустой архив.
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const OUT = join(ROOT, "build", "dist");
const STAGE = join(ROOT, "build", ".stage");
const src = readFileSync(join(ROOT, "src", "server.ts"), "utf8");
const VERSION = (src.match(/APP_VERSION = "([^"]+)"/) ?? [])[1];
console.log("version:", VERSION);
rmSync(STAGE, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
mkdirSync(join(STAGE, "dirigo"), { recursive: true });
const INCLUDE = ["src", "web", "scripts/orch.ts", "scripts/mcp.ts", "scripts/sdk-contracts.ts", "sdk", "skills", "providers.json", "plugins.json", "start.ps1", "start.sh", "orch", "LICENSE", "README.md", "Dockerfile", "docker-compose.yml", ".env.example", "orch.cmd"];
const deny = ["node_modules", "data/db.json", "data/secrets.json", "data/logs", "data/work", ".git", "RUNTIME.md", "BACKLOG.md"];
const denyCheck = new Set(deny);
for (const item of INCLUDE) {
  const from = join(ROOT, ...item.split("/"));
  if (!existsSync(from)) { console.log("  ! пропущен:", item); continue; }
  const to = join(STAGE, "dirigo", ...item.split("/"));
  mkdirSync(join(to, ".."), { recursive: true });
  cpSync(from, to, { recursive: true, filter: (src) => {
    const rel = src.replace(ROOT, "").replace(/\\/g, "/").replace(/^\/+/, "");
    for (const d of denyCheck) { if (rel.startsWith(`${d}/`) || rel === d) return false; }
    return true;
  }});
  console.log("  +", item);
}
// Лаунчеры живут в корне репозитория, но в дистрибутиве обязаны лежать рядом
// с продуктом: после установки человек запускает ./run.sh, а не ищет мануал.
// В дистрибутиве нет подкаталога приложения — путь к нему правим.
for (const l of ["run.sh", "run.bat", "stop.sh", "stop.bat"]) {
  const from = join(ROOT, "..", l);
  if (!existsSync(from)) { console.log("  ! лаунчер пропущен:", l); continue; }
  // scan-ok: имя каталога дев-дерева — левая часть подстановки, не текст.
  const text = readFileSync(from, "utf8")
    .replace('APP="$ROOT/orchestra"', 'APP="$ROOT"') // scan-ok
    .replace('set "APP=%ROOT%\\orchestra"', 'set "APP=%ROOT%"');
  const to = join(STAGE, "dirigo", l);
  writeFileSync(to, text);
  if (l.endsWith(".sh")) { try { chmodSync(to, 0o755); } catch { /* не критично */ } }
  console.log("  +", l);
}

writeFileSync(join(STAGE, "dirigo", "package.json"), JSON.stringify({
  name: "dirigo",
  version: VERSION,
  private: true,
  type: "module",
  scripts: { start: "bun run src/server.ts" },
  // node-pty опционален: без него демон стартует, PTY-режим деградирует
  optionalDependencies: { "node-pty": "^1.1.0" },
}, null, 2) + "\n");
writeFileSync(join(STAGE, "dirigo", "BUILD.json"), JSON.stringify({ product: "dirigo", version: VERSION, built: new Date().toISOString(), bundle: "production (no dev artifacts)" }, null, 2));
const NAME = `dirigo-${VERSION}`;
const tarballName = `${NAME}.tar.gz`;
// MSYS-tar не понимает абсолютные Windows-пути для outfile («Cannot connect to
// C: resolve failed»). Запускаем tar с cwd=OUT и относительным именем файла.
const t = Bun.spawnSync(["tar", "-czf", tarballName, "-C", STAGE, "dirigo"], { cwd: OUT });
if (t.exitCode !== 0) {
  console.error("tar fail:", t.stderr.toString());
  console.error("hint: tar из MSYS не любит Windows-пути. Проверь, что tar в PATH — нативный bsdtar (Windows 10+) или MSYS с флагом --force-local.");
  process.exit(1);
}
const tarball = join(OUT, tarballName);
const hashes = [tarball];
const sums = hashes.map((f) => {
  const buf = require("node:fs").readFileSync(f);
  const h = new Bun.CryptoHasher("sha256"); h.update(buf);
  return `${h.digest("hex")} *${f.split(/[\\/]/).pop()}`;
}).join("\n");
writeFileSync(join(OUT, "SHA256SUMS"), sums + "\n");
writeFileSync(join(OUT, "latest.json"), JSON.stringify({ version: VERSION }) + "\n");
// Установщики рядом с бандлом: на сервере сайта `install.sh`/`install.ps1` — ссылки
// в build/dist (orchestra-site/SITE-HOSTING-HANDOFF.md), dist копируется целиком.
// install.ps1 — ASCII без BOM (BOM ломает `irm | iex`), проверяет make-deploy.
{
  const fs = require("node:fs");
  fs.copyFileSync(join(ROOT, "build", "install.sh"), join(OUT, "install.sh"));
  fs.copyFileSync(join(ROOT, "build", "install.ps1"), join(OUT, "install.ps1"));
}
console.log("bundled:", tarball, Bun.file(tarball).size, "bytes");
rmSync(STAGE, { recursive: true, force: true });
