#!/usr/bin/env bun
// Вендоринг xterm.js: настоящий эмулятор терминала для режима «Терминал (TUI)».
//
// Зачем копия в репозитории, а не импорт из node_modules: бандл и установка
// по install.sh/ps1 идут без node_modules и без сети на первом запуске, а
// пульт отдаётся с CSP `script-src 'self'` — CDN запрещён. Поэтому:
//   web/vendor/  — браузерный xterm.js + стили + addon-fit (рисует экран)
//   src/vendor/  — @xterm/headless для демона (ведёт экран, отвечает на запросы TUI)
//
// Обновление версии: bun add -d @xterm/xterm@X @xterm/headless@X @xterm/addon-fit@Y
// и затем  bun run scripts/vendor-xterm.ts
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const NM = join(ROOT, "node_modules", "@xterm");

/** Без ссылки на .map: карты не вендорим, иначе браузер ловит 404 в консоли. */
const strip = (s: string) => s.replace(/\n?\/\/# sourceMappingURL=\S+\s*$/, "\n");

const copies: [string, string][] = [
  [join(NM, "xterm", "lib", "xterm.js"), join(ROOT, "web", "vendor", "xterm.js")],
  [join(NM, "xterm", "css", "xterm.css"), join(ROOT, "web", "vendor", "xterm.css")],
  [join(NM, "addon-fit", "lib", "addon-fit.js"), join(ROOT, "web", "vendor", "addon-fit.js")],
  // ширины символов Unicode 11 (эмодзи — две клетки, как считают сами агенты)
  [join(NM, "addon-unicode11", "lib", "addon-unicode11.js"), join(ROOT, "web", "vendor", "addon-unicode11.js")],
  [join(NM, "addon-unicode11", "lib", "addon-unicode11.js"), join(ROOT, "src", "vendor", "addon-unicode11.cjs")],
  [join(NM, "headless", "lib-headless", "xterm-headless.js"), join(ROOT, "src", "vendor", "xterm-headless.cjs")],
  // снимок экрана для браузера, подключившегося посреди сессии
  [join(NM, "addon-serialize", "lib", "addon-serialize.js"), join(ROOT, "src", "vendor", "addon-serialize.cjs")],
];

for (const [from, to] of copies) {
  mkdirSync(join(to, ".."), { recursive: true });
  writeFileSync(to, strip(readFileSync(from, "utf8")));
  console.log(`  + ${to.slice(ROOT.length + 1)}`);
}

const ver = (pkg: string) => JSON.parse(readFileSync(join(NM, pkg, "package.json"), "utf8")).version;
const license = readFileSync(join(NM, "xterm", "LICENSE"), "utf8");
const note = `xterm.js ${ver("xterm")}, @xterm/headless ${ver("headless")}, @xterm/addon-fit ${ver("addon-fit")}, @xterm/addon-serialize ${ver("addon-serialize")}, @xterm/addon-unicode11 ${ver("addon-unicode11")}\n` +
  `https://github.com/xtermjs/xterm.js — MIT\n\n${license}`;
writeFileSync(join(ROOT, "web", "vendor", "LICENSE-xterm.txt"), note);
writeFileSync(join(ROOT, "src", "vendor", "LICENSE-xterm.txt"), note);
console.log("✓ xterm вендорен");
