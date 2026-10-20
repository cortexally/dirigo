#!/usr/bin/env node
/* `npx dirigo` — печатает проверенную команду установки для текущей платформы.
 *
 * Намеренно НЕ скачивает и НЕ запускает ничего сам. Продукт продаёт
 * проверяемость; пакет в npm, который молча тянет скрипт из сети и отдаёт его
 * оболочке, противоречил бы этому ровно в той точке, где человек решает,
 * доверять ли нам. Команду он видит целиком и запускает сам.
 */

const SITE = "https://dirigo.cortexally.ai";
const REPO = "https://github.com/cortexally/dirigo";

const c = process.stdout.isTTY
  ? { b: "\x1b[1m", d: "\x1b[2m", g: "\x1b[32m", r: "\x1b[0m" }
  : { b: "", d: "", g: "", r: "" };

const windows = process.platform === "win32";
const command = windows
  ? `irm ${SITE}/install.ps1 | iex`
  : `curl -fsSL ${SITE}/install.sh | sh`;

const lines = [
  "",
  `  ${c.b}Dirigo${c.r} — the self-hosted control layer for AI coding agents.`,
  `  ${c.d}Every agent in its own copy of the project. Nothing lands without your`,
  `  review, and every applied change leaves verifiable evidence.${c.r}`,
  "",
  `  ${c.b}Install${c.r} ${c.d}(${windows ? "Windows, PowerShell" : "Linux and macOS"})${c.r}`,
  "",
  `    ${c.g}${command}${c.r}`,
  "",
  `  ${c.d}The installer verifies a SHA256 checksum, refuses plain HTTP, unpacks`,
  `  into ~/.dirigo and starts the daemon on http://127.0.0.1:7171.${c.r}`,
  "",
  `  ${c.b}From source${c.r}`,
  "",
  `    ${c.g}git clone ${REPO}${c.r}`,
  `    ${c.g}cd dirigo && bun run src/server.ts${c.r}`,
  "",
  `  ${c.d}Source and docs:${c.r} ${REPO}`,
  `  ${c.d}Product:${c.r}         ${SITE}`,
  "",
];

console.log(lines.join("\n"));
