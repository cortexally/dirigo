#!/usr/bin/env bun
// V7-9 (KA): security-review install-skriptov HA — static analysis + bundle checks.
// ASCII-имена проверок: скрипт-гейт не должен зависеть от кодировки консоли.
// Запуск: bun run scripts/install-security-review.ts

import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";

const BUILD = join(import.meta.dir, "..", "build");

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -- " + detail : ""}`);
  ok ? pass++ : fail++;
};

const read = (f: string): string | null => {
  const p = join(BUILD, f);
  return existsSync(p) ? readFileSync(p, "utf8") : null;
};

const sh = read("install.sh");
const ps1 = read("install.ps1");
const bundle = read("bundle.sh");
const sec = read("security-check.sh");

check("vse 4 skripta na meste", !!sh && !!ps1 && !!bundle && !!sec, `sh=${!!sh} ps1=${!!ps1} bundle=${!!bundle} sec=${!!sec}`);

/* ---------- install.sh ---------- */
if (sh) {
  check("sh: set -euo pipefail", /set -euo pipefail/.test(sh));
  // CDN otdaval staryy arhiv pri novykh summakh (0.1.0): summy — mimo kesha, arhiv — po summe
  check("sh: manifest i summy mimo kesha CDN", sh.includes('latest.json$NOCACHE') && sh.includes('SHA256SUMS$NOCACHE'));
  check("sh: arhiv po ego summe (?sha256=)", sh.includes('QUERY="?sha256=$expected"') && sh.includes('curl -fsSL "$BUNDLE$QUERY"'));
  check("sh: otkaz ot root", /id -u.*=.*0/.test(sh));
  check("sh: tolko https", /case "\$BASE_URL" in[\s\S]{0,80}https:\/\/\*/.test(sh));
  check("sh: sha256 obyazatelen (ne tolko opt-out)", /sha256sum -c/.test(sh));
  check("sh: propusk sha256 tolko cherez DIRIGO_SKIP_VERIFY", /DIRIGO_SKIP_VERIFY/.test(sh));
  check("sh: ustanovka tolko v HOME/.dirigo", /DIRIGO_INSTALL_DIR:-\$HOME\/\.dirigo/.test(sh));
  check("sh: trap cleanup temp", /trap .* EXIT/.test(sh));
  check("sh: mktemp dlya zagruzki", /mktemp -d/.test(sh));
  check("sh: net eval", !/\beval\b/.test(sh));
  check("sh: net proizvolnogo curl|sh (krome bun.sh v kommentariyah)",
    [ ...sh.split("\n").filter((l) => !l.trimStart().startsWith("#")).join("\n").matchAll(/curl[^|]*\|\s*(?:bash|sh)\b/g) ]
      .every((m) => m[0].includes("bun.sh")));
  check("sh: tar bez --absolute-names", !/--absolute-names/.test(sh));
  check("sh: sha256 fail = ustanovka ostanovlena (die)", /sha256sum -c[\s\S]{0,120}\|\|\s*\\?\s*\n?\s*die/.test(sh));
}

/* ---------- install.ps1 ---------- */
if (ps1) {
  check("ps1: ErrorActionPreference Stop", /ErrorActionPreference = "Stop"/.test(ps1));
  check("ps1: TLS 1.2+ prinuditelno", /Tls12/.test(ps1));
  check("ps1: tolko https (loopback — isklyuchenie dlya lokalnoy proverki)",
    /-like "https:\/\/\*"/.test(ps1) && /Test-HttpsOrLoopback/.test(ps1));
  check("ps1: sha256 cherez Get-FileHash", /Get-FileHash.*-Algorithm SHA256/.test(ps1));
  check("ps1: sravnenie heshey (ne prosto nalichie)", /\$actual -ne \$expected/.test(ps1));
  check("ps1: ustanovka tolko v profil", /Join-Path \$env:USERPROFILE "\.dirigo"/.test(ps1));
  check("ps1: propusk sha256 tolko cherez DIRIGO_SKIP_VERIFY", /DIRIGO_SKIP_VERIFY/.test(ps1));
  check("ps1: net iex na skachannom kontente", ![ ...ps1.replaceAll(/irm [^\n|]*\| iex/g, "").matchAll(/iex/g) ].length);
  check("ps1: temp katalog dlya zagruzki", /Join-Path \$env:TEMP/.test(ps1));
  // BOM: irm|iex poluchaet U+FEFF pered pervoy strokoy i padaet; ne-ASCII: PS 5.1 ne razbiraet fayl
  check("ps1: bez BOM (irm | iex)", ps1.charCodeAt(0) !== 0xfeff);
  check("ps1: manifest i summy mimo kesha CDN", ps1.includes('"/latest.json" + $nocache') && ps1.includes('"/SHA256SUMS" + $nocache'));
  check("ps1: arhiv po ego summe (?sha256=)", ps1.includes('"?sha256=" + $expected') && ps1.includes("($BundleUrl + $query)"));
  check("ps1: tolko ASCII (PS 5.1 fayl)", !/[^\x00-\x7F]/.test(ps1));
}

/* ---------- bundle.sh (denylist) ---------- */
if (bundle) {
  check("bundle: whitelist podhod", /INCLUDE=\(/.test(bundle));
  check("bundle: denylist secrets", /data\/secrets\.json/.test(bundle));
  check("bundle: net node_modules v denyliste", /node_modules/.test(bundle));
  check("bundle: net RUNTIME.md", /RUNTIME\.md/.test(bundle));
  check("bundle: versiya iz APP_VERSION", /APP_VERSION/.test(bundle));
  check("bundle: sha256sum na vyhode", /sha256sum/.test(bundle));
  check("bundle: net .git v denyliste", /"\.git"/.test(bundle));
}

/* ---------- security-check.sh ---------- */
if (sec) {
  // grep-паттерн в файле — литеральный текст с regex-символами, матчим как строку
  check("sec: proverka secretov v bandle", /grep -rIn/.test(sec) && sec.includes("api[_-]?key") && sec.includes("secret"));
  check("sec: proverka data-artifactov", /data\//.test(sec) && /db\.json/.test(sec));
  check("sec: proverka klyuchey/sertifikatov", /\.pem/.test(sec) && /\.key/.test(sec));
  check("sec: proverka sintaksisa bash -n", /bash -n/.test(sec));
  check("sec: exit 1 pri FAIL", /exit 1/.test(sec));
  check("sec: proverka RUNTIME-zhurnalov", /RUNTIME\.md/.test(sec));
}

/* ---------- реальный артефакт: bundle ---------- */
{
  const dist = join(BUILD, "dist");
  const sums = join(dist, "SHA256SUMS");
  check("bundle sushchestvuet", existsSync(sums));
  if (existsSync(sums)) {
    const text = readFileSync(sums, "utf8");
    check("SHA256SUMS ne pustoy", text.trim().length > 10);
    const names = text.split("\n").map((l) => l.replace(/^\S+\s+\*?/, "").trim()).filter(Boolean);
    check("v summakh tolko ozhidaemye artifactы", names.length >= 1 && names.every((n) => /^dirigo-[\d.]+\.(tar\.gz|zip)$/.test(n)), names.join(","));
  }
  // tar из MSYS не понимает абсолютные Windows-пути («C:» = удалённый хост) —
  // вызываем с cwd=ROOT и относительным путём, иначе tar падает с
  // «Cannot connect to C: resolve failed», а гейт видит пустой бандл.
  const ROOT = join(import.meta.dir, "..");
  // Версия бандла берётся из APP_VERSION, а не вшивается: раньше тут стояла
  // «1.1», и после каждого релиза проверка смотрела на древний архив.
  const appVersion = readFileSync(join(ROOT, "src", "server.ts"), "utf8")
    .match(/APP_VERSION = "([\d.]+)"/)?.[1] ?? "";
  const bundlePath = `build/dist/dirigo-${appVersion}.tar.gz`;
  const bundleExists = existsSync(join(ROOT, bundlePath));
  check(`bandl ${bundlePath} sobran`, bundleExists, bundleExists ? "" : "сначала bun run scripts/bundle-native.ts");
  const list = bundleExists
    ? Bun.spawnSync(["tar", "-tzf", bundlePath], { cwd: ROOT })
    : { stdout: Buffer.from("") } as { stdout: Buffer };
  const files = list.stdout.toString().split(/\r?\n/).map((f) => f.trim());
  check("v bandle net secrets.json", !files.some((f) => f.includes("secrets.json")));
  check("v bandle net db.json", !files.some((f) => f.includes("db.json")));
  check("v bandle net RUNTIME.md", !files.some((f) => f.includes("RUNTIME.md")));
  check("v bandle net node_modules", !files.some((f) => f.includes("node_modules")));
  check("v bandle est src/server.ts", files.some((f) => f === "dirigo/src/server.ts"));
  check("v bandle est web/index.html", files.some((f) => f === "dirigo/web/index.html"));
  check("v bandle est orch.cmd + start.sh", files.some((f) => f === "dirigo/orch.cmd") && files.some((f) => f === "dirigo/start.sh"));
  check("v bandle est install-shablon (start.ps1)", files.some((f) => f === "dirigo/start.ps1"));
  check("v bandle net RUNTIME/BACKLOG", !files.some((f) => /RUNTIME|BACKLOG/.test(f)));
  check("v bandle net vnutrennih materialov", !files.some((f) => /research|reverse|postmortem/i.test(f)));
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
