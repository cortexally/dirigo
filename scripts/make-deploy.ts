#!/usr/bin/env bun
// Сборка комплекта для хостинга: ровно то дерево, которое должен отдавать
// origin https://<домен>/ — лендинг + установщики + бандл + чек-суммы.
//
//   bun run scripts/make-deploy.ts [--out ../deploy]
//
// Установщик требует, чтобы страница, install.sh/ps1, бандл, SHA256SUMS и
// latest.json лежали на ОДНОМ origin по https, поэтому собираем их вместе и
// проверяем согласованность до выкладки, а не после.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const REPO = join(ROOT, "..");
const outArg = process.argv.indexOf("--out");
const OUT = outArg > -1 ? process.argv[outArg + 1]! : join(REPO, "deploy");

const VERSION = readFileSync(join(ROOT, "src", "server.ts"), "utf8").match(/APP_VERSION = "([\d.]+)"/)?.[1] ?? "";
if (!VERSION) { console.error("не нашёл APP_VERSION в src/server.ts"); process.exit(1); }

const bundle = join(ROOT, "build", "dist", `dirigo-${VERSION}.tar.gz`);
if (!existsSync(bundle)) {
  console.error(`нет бандла ${bundle} — сначала: bun run scripts/bundle-native.ts`);
  process.exit(1);
}

// scan-ok: второе имя — исторический каталог лендинга на диске
const siteDir = existsSync(join(REPO, "dirigo-site")) ? join(REPO, "dirigo-site") : join(REPO, "orchestra-site");

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// 1. лендинг (только то, что отдаётся браузеру)
for (const item of ["index.html", "assets"]) {
  const from = join(siteDir, item);
  if (!existsSync(from)) { console.error("нет", from); process.exit(1); }
  cpSync(from, join(OUT, item), { recursive: true });
}
console.log("  + лендинг (index.html, assets/)");

// 2. установщики (в корне) и артефакты релиза (в releases/ — так их отдаёт
//    живой сайт и ищет установщик; корень остаётся запасным вариантом)
mkdirSync(join(OUT, "releases"), { recursive: true });
for (const [from, to] of [
  [join(ROOT, "build", "install.sh"), "install.sh"],
  [join(ROOT, "build", "install.ps1"), "install.ps1"],
  [bundle, `releases/dirigo-${VERSION}.tar.gz`],
  [join(ROOT, "build", "dist", "SHA256SUMS"), "releases/SHA256SUMS"],
  [join(ROOT, "build", "dist", "latest.json"), "releases/latest.json"],
] as Array<[string, string]>) {
  if (!existsSync(from)) { console.error("нет", from); process.exit(1); }
  cpSync(from, join(OUT, to));
  console.log("  +", to);
}


// 3. сверки, без которых выкладка ломает установку у пользователя
const problems: string[] = [];
{
  // install.ps1 — только ASCII и без BOM. С BOM `irm | iex` получает U+FEFF перед первой
  // строкой и падает «Missing argument in parameter list» (так сломалась установка 0.1.0);
  // с кириллицей без BOM PowerShell 5.1 не разбирает файл, запущенный файлом.
  const buf = readFileSync(join(OUT, "install.ps1"));
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) problems.push("install.ps1 с UTF-8 BOM — `irm | iex` падает на первой строке");
  const nonAscii = buf.toString("latin1").split("\n").findIndex((l) => /[^\x00-\x7F]/.test(l));
  if (nonAscii >= 0) problems.push(`install.ps1: не-ASCII в строке ${nonAscii + 1} — PowerShell 5.1 не разберёт его файлом`);
  // живая проверка тем самым powershell.exe 5.1, что стоит по умолчанию — обоими путями:
  // как файл (-File) и как строку, которую `irm` отдаёт в `iex` (UTF-8, BOM не срезан)
  if (process.platform === "win32" && Bun.which("powershell.exe")) {
    const f = join(OUT, "install.ps1").replace(/'/g, "''");
    const script = `$e=$null;[void][System.Management.Automation.Language.Parser]::ParseFile('${f}',[ref]$null,[ref]$e);if($e.Count){'file: '+$e[0].Message;exit 1};` +
      `$s=[Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes('${f}'));$e=$null;[void][System.Management.Automation.Language.Parser]::ParseInput($s,[ref]$null,[ref]$e);if($e.Count){'irm|iex: '+$e[0].Message;exit 1}`;
    const r = Bun.spawnSync(["powershell.exe", "-NoProfile", "-Command", script], { windowsHide: true });
    if (r.exitCode !== 0) problems.push(`install.ps1 не разбирается в PowerShell 5.1 (${r.stdout.toString().trim().slice(0, 160)})`);
  }
}
const installSh = readFileSync(join(OUT, "install.sh"), "utf8");
const indexHtml = readFileSync(join(OUT, "index.html"), "utf8");
const canonical = indexHtml.match(/rel="canonical" href="https:\/\/([^/"]+)/)?.[1] ?? "";
const baseUrl = installSh.match(/BASE_URL="\$\{DIRIGO_BASE_URL:-https:\/\/([^}"]+)\}"/)?.[1] ?? "";
if (!canonical) problems.push("в index.html нет canonical");
if (!baseUrl) problems.push("в install.sh не разобрался BASE_URL");
if (canonical && baseUrl && canonical !== baseUrl) {
  problems.push(`домены расходятся: сайт ${canonical}, установщик ${baseUrl}`);
}
const latest = JSON.parse(readFileSync(join(OUT, "releases", "latest.json"), "utf8")) as { version?: string };
if (latest.version !== VERSION) problems.push(`latest.json: ${latest.version} ≠ ${VERSION}`);
const sums = readFileSync(join(OUT, "releases", "SHA256SUMS"), "utf8");
if (!sums.includes(`dirigo-${VERSION}.tar.gz`)) problems.push(`SHA256SUMS не содержит dirigo-${VERSION}.tar.gz`);
const hasher = new Bun.CryptoHasher("sha256");
hasher.update(readFileSync(bundle));
const digest = hasher.digest("hex");
if (!sums.includes(digest)) problems.push("SHA256SUMS не совпадает с бандлом — пересоберите bundle-native.ts");
// Опасны только ЗАГРУЗКИ с чужих доменов (src/@import/url()), а обычные
// <a href> на GitHub — это нормальная ссылка, не внешний запрос.
const externalLoads = [...indexHtml.matchAll(/(?:src|srcset)="(https?:\/\/[^"]+)"/g)].map((m) => m[1]!)
  .concat([...indexHtml.matchAll(/url\((https?:\/\/[^)]+)\)/g)].map((m) => m[1]!));
if (externalLoads.length) problems.push(`в index.html внешние загрузки: ${externalLoads.slice(0, 3).join(", ")}`);

writeFileSync(join(OUT, "DEPLOY.md"), `# Комплект для выкладки Dirigo ${VERSION}

Эта папка — целиком содержимое корня сайта. Ничего лишнего в ней нет и быть
не должно: ни исходников, ни тестов, ни внутренних документов.

## Что здесь

| Файл | Зачем |
|---|---|
| \`index.html\`, \`assets/\` | лендинг (ноль внешних запросов, работает офлайн) |
| \`install.sh\` | установка на Linux и macOS: \`curl -fsSL https://${baseUrl || "<домен>"}/install.sh | bash\` |
| \`install.ps1\` | то же для Windows |
| \`releases/dirigo-${VERSION}.tar.gz\` | бандл продукта |
| \`releases/SHA256SUMS\` | контрольная сумма бандла (установщик её ПРОВЕРЯЕТ и без неё откажется ставить) |
| \`releases/latest.json\` | манифест версии; по нему установщик понимает, что качать |

## Требования к origin

1. Всё отдаётся с **одного** домена по **https** — установщик жёстко
   отказывается работать по http (кроме loopback). Это защита от подмены бандла.
2. \`SHA256SUMS\` и \`latest.json\` лежат рядом с бандлом, в \`releases/\` (установщик ищет там, затем в корне).
3. Типы содержимого: \`.sh\` и \`.ps1\` — \`text/plain\`, \`.tar.gz\` —
   \`application/gzip\`. Если сервер отдаст \`.sh\` как \`application/octet-stream\`,
   \`curl | bash\` всё равно сработает, но лучше настроить правильно.
4. Кэш: \`index.html\` и \`latest.json\` — \`no-cache\`; \`assets/*\` и бандл —
   можно надолго (их имена меняются вместе с версией).

## Проверка после выкладки

\`\`\`bash
curl -fsSL https://${baseUrl || "<домен>"}/releases/latest.json   # {"version":"${VERSION}"}
curl -fsSL https://${baseUrl || "<домен>"}/releases/SHA256SUMS | head -1
curl -fsSL https://${baseUrl || "<домен>"}/install.sh | head -5  # должен начинаться с #!/usr/bin/env bash
\`\`\`

Затем на чистой машине:

\`\`\`bash
curl -fsSL https://${baseUrl || "<домен>"}/install.sh | bash
\`\`\`

Успех — демон поднялся и ответил на \`http://127.0.0.1:7171/api/health\`.
`);
console.log("  + DEPLOY.md");

if (problems.length) {
  console.error("\nПРОБЛЕМЫ (выкладывать нельзя):");
  for (const p of problems) console.error("  ✗", p);
  process.exit(1);
}
console.log(`\nГотово: ${OUT}  (версия ${VERSION}, домен ${baseUrl})`);
