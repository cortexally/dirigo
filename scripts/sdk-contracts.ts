#!/usr/bin/env bun
// Кодоген контрактов (V2-4.6): вытаскивает маршруты из src/server.ts и
// сверяет покрытие SDK. Пишет docs/API-CONTRACTS.md. Падает, если метод SDK
// не накрывает объявленный маршрут.
//
// Запуск: bun run scripts/sdk-contracts.ts [--check]

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SERVER = join(import.meta.dir, "..", "src", "server.ts");
const SDK = join(import.meta.dir, "..", "sdk", "dirigo.ts");
const OUT = join(import.meta.dir, "..", "docs", "API-CONTRACTS.md");

interface Route { method: string; path: string; note: string; }

function extractRoutes(): Route[] {
  const src = readFileSync(SERVER, "utf8");
  const routes: Route[] = [];
  // грубый разбор: if (req.method === "GET" && path === "/api/...")
  const re = /req\.method === "(GET|POST|PATCH|DELETE)" && path === "([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    routes.push({ method: m[1]!, path: m[2]!, note: "" });
  }
  // динамические пути: /^\/api\/sessions\/([\w-]+)(...)?$/
  const reRe = /path\.match\(\/\^((?:\\\/[^\/]+)+)/g;
  while ((m = reRe.exec(src))) {
    const path = "/" + m[1]!.replace(/\\\//g, "/").replace(/\\/g, "");
    routes.push({ method: "*", path, note: "динамический шаблон" });
  }
  return routes;
}

function sdkCoverage(): { paths: string[]; count: number } {
  const src = readFileSync(SDK, "utf8");
  const paths: string[] = [];
  const re = /this\.call\(\s*[`"]([^`"$]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    // статический префикс шаблонной строки — покрывает все подстановки
    paths.push(m[1]!);
  }
  return { paths, count: paths.size };
}

const routes = extractRoutes().filter((r) => r.path.startsWith("/api/"));
const { paths } = sdkCoverage();

/** Покрыт ли маршрут SDK (по статическому префиксу или спец-методу). */
function covered(routePath: string): boolean {
  // SSE не вызывается как JSON: покрыт через eventsUrl() в SDK
  if (routePath === "/api/events") return readFileSync(SDK, "utf8").includes("eventsUrl()");
  for (const p of paths) {
    if (p === routePath) return true;
    // «/api/sessions/» покрывает «/api/sessions/<id>/diff» и т.п.
    if (routePath.startsWith(p)) return true;
  }
  return false;
}

const lines: string[] = [
  "# API-контракты dirigo",
  "",
  "> Сгенерировано `bun run sdk:contracts` из `src/server.ts` — не правь руками.",
  `> Маршрутов: ${routes.length}. Хост: \`DIRIGO_HOST\` (default http://127.0.0.1:7171).`,
  "> Авторизация: \`Authorization: Bearer $DIRIGO_TOKEN\` (если токен задан).",
  "",
  "| Метод | Путь | Примечание | SDK |",
  "|---|---|---|---|",
];
for (const r of routes.sort((a, b) => a.path.localeCompare(b.path))) {
  lines.push(`| ${r.method} | \`${r.path}\` | ${r.note} | ${covered(r.path) ? "✓" : "—"} |`);
}
lines.push("");
lines.push("## Скиллы для агентов");
lines.push("");
lines.push("- Ответы — JSON; ошибки — `{ error }` со статусом 4xx/5xx.");
lines.push("- Необратимые операции (apply/merge) требуют подтверждения в теле (`confirmed: true`).");
lines.push("- SSE-поток: `GET /api/events` — события `session.output/status`, `sessions.changed`.");
lines.push("");

const report = lines.join("\n");
if (!process.argv.includes("--check")) {
  writeFileSync(OUT, report, "utf8");
  console.log(`контракты записаны: ${OUT} (маршрутов ${routes.length})`);
} else {
  console.log(report);
}

const uncovered = routes.filter((r) => !covered(r.path)).map((r) => `${r.method} ${r.path}`);
if (uncovered.length) {
  console.error(`\nНЕ ПОКРЫТО SDK (${uncovered.length}):`);
  for (const u of uncovered) console.error("  " + u);
  process.exit(1);
}
console.log(`SDK покрывает все ${routes.length} маршрутов`);
