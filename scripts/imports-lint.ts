#!/usr/bin/env bun
// Линт «используется, но не импортировано».
//
// Правило появилось из реальных случаев:
//   • в scripts/cli-e2e.ts вызывался readdirSync, но он не был импортирован.
//     Вызов стоял в try/catch, который глотал ошибку, — «защита» молча
//     возвращала 0, и набор e2e-cli считал каталог с чужой рабочей папкой
//     агента пустым и сносил его. Агент терял рабочую папку
//     («Working directory does not exist»), правки — вместе с ней;
//   • в том же файле не был импортирован resolve — набор падал с
//     «resolve is not defined» ещё на старте.
//
// В TypeScript это ошибка компиляции, а в Bun (без типов) — ReferenceError в
// рантайме, часто спрятанный под try/catch. Проверка намеренно без
// зависимостей (проект — zero-dep): разбираем вызовы функций и сравниваем с
// импортами и локальными объявлениями.
//
// Проверяем два класса:
//   1. вызов node:fs/node:path/node:os без импорта;
//   2. вызов функции, которую экспортит модуль, ИЗ КОТОРОГО этот файл уже
//      что-то импортирует (забытый импорт из своего модуля).
//
// Запуск: bun run scripts/imports-lint.ts
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

/** Функции node:*, которые не путают с локальными именами. */
const NODE_NAMES = new Set([
  // node:fs
  "existsSync", "readFileSync", "writeFileSync", "appendFileSync", "readdirSync",
  "mkdirSync", "rmSync", "rmdirSync", "unlinkSync", "renameSync", "copyFileSync",
  "statSync", "lstatSync", "realpathSync", "chmodSync", "symlinkSync",
  "readlinkSync", "mkdtempSync", "cpSync", "opendirSync",
  // node:path
  "join", "dirname", "basename", "extname", "isAbsolute",
  // node:os
  "tmpdir", "homedir", "hostname", "platform", "arch", "cpus", "totalmem",
  "freemem", "uptime", "networkInterfaces", "release",
]);

/**
 * Убираем комментарии, не задевая строки.
 *
 * Наивная замена по регулярке съедала импорты в файлах, где «/*» встречается
 * внутри строки (например, «глоб в шаблоне») — а с ним и сам файл проверки.
 * Поэтому идём посимвольно и помним, где строка, а где код.
 */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  let state: "code" | "line" | "block" | "sq" | "dq" | "tpl" = "code";
  while (i < src.length) {
    const c = src[i]!;
    const n = src[i + 1];
    if (state === "code") {
      if (c === "/" && n === "/") { state = "line"; out += "  "; i += 2; continue; }
      if (c === "/" && n === "*") { state = "block"; out += "  "; i += 2; continue; }
      if (c === '"') { state = "dq"; out += c; i++; continue; }
      if (c === "'") { state = "sq"; out += c; i++; continue; }
      if (c === "`") { state = "tpl"; out += c; i++; continue; }
      out += c; i++; continue;
    }
    if (state === "line") {
      if (c === "\n") { state = "code"; out += c; } else out += " ";
      i++; continue;
    }
    if (state === "block") {
      if (c === "*" && n === "/") { state = "code"; out += "  "; i += 2; continue; }
      out += c === "\n" ? "\n" : " ";
      i++; continue;
    }
    // Внутри строки: копируем до закрывающей кавычки (экранирование — как есть).
    out += c;
    if (c === "\\") { out += n ?? ""; i += 2; continue; }
    if ((state === "dq" && c === '"') || (state === "sq" && c === "'") || (state === "tpl" && c === "`")) state = "code";
    i++;
  }
  return out;
}

/** Все .ts под каталогом (без node_modules, служебных и скрытых папок). */
function tsFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    if (e.name.startsWith(".")) continue; // черновики и временные файлы
    const p = join(dir, e.name);
    if (e.isDirectory()) tsFiles(p, out);
    else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** Имена, объявленные в файле (функции, классы, переменные, деструктуризация). */
function declaredNames(src: string): Set<string> {
  const names = new Set<string>();
  for (const m of src.matchAll(/(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]!);
  for (const m of src.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=/g)) {
    for (const part of m[1]!.split(",")) {
      const raw = part.split("=")[0]!.split(":").pop()!.trim().replace(/^\.\.\./, "");
      if (/^[A-Za-z_$][\w$]*$/.test(raw)) names.add(raw);
    }
  }
  return names;
}

/** Имена, импортированные из node:* (в т.ч. динамический импорт с деструктуризацией). */
function importedNames(src: string): Set<string> {
  const names = new Set<string>();
  for (const m of src.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from/g)) {
    for (const part of m[1]!.split(",")) {
      const raw = part.split(" as ").pop()!.split(":").pop()!.trim();
      if (/^[A-Za-z_$][\w$]*$/.test(raw)) names.add(raw);
    }
  }
  for (const m of src.matchAll(/import\s+(?:type\s+)?([A-Za-z_$][\w$]*)\s+from/g)) names.add(m[1]!);
  // const { readFileSync } = require("node:fs") / await import("node:fs")
  for (const m of src.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=\s*(?:await\s+)?(?:require|import)\s*\(\s*["']node:/g)) {
    for (const part of m[1]!.split(",")) {
      const raw = part.split("=")[0]!.split(":").pop()!.trim().replace(/^\.\.\./, "");
      if (/^[A-Za-z_$][\w$]*$/.test(raw)) names.add(raw);
    }
  }
  return names;
}

/** Что модуль экспортирует: export function X / export const X / export { X }. */
function exportedNames(src: string): Set<string> {
  const names = new Set<string>();
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]!);
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1]!.split(",")) {
      const raw = part.split(" as ").pop()!.trim();
      if (/^[A-Za-z_$][\w$]*$/.test(raw)) names.add(raw);
    }
  }
  for (const m of src.matchAll(/export\s+type\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]!);
  return names;
}

/** Модули, из которых файл импортирует (относительные пути). */
function importedModules(src: string, file: string): string[] {
  const mods: string[] = [];
  const dir = join(file, "..");
  for (const m of src.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
    const base = join(dir, m[1]!);
    for (const cand of [`${base}.ts`, join(base, "index.ts")]) {
      if (existsSync(cand)) { mods.push(cand); break; }
    }
  }
  return mods;
}

/** Вызовы в коде (без комментариев): имя + номер строки. */
function calls(code: string): { name: string; line: number }[] {
  const out: { name: string; line: number }[] = [];
  code.split(/\r?\n/).forEach((line, i) => {
    // сигнатура типа в интерфейсе: writeSync(d: string): void;
    if (/^\s*[A-Za-z_$][\w$]*\s*\([^)]*:\s*[^)]*\)\s*:\s*[A-Za-z_$]/.test(line)) return;
    for (const m of line.matchAll(/(?<![\w.$])([A-Za-z_$][\w$]*)\s*\(/g)) out.push({ name: m[1]!, line: i + 1 });
  });
  return out;
}

let bad = 0;
const files = [...tsFiles(join(ROOT, "scripts")), ...tsFiles(join(ROOT, "src"))];
for (const f of files) {
  const code = stripComments(readFileSync(f, "utf8"));
  const known = new Set([...declaredNames(code), ...importedNames(code)]);
  // Экспорты модулей, из которых этот файл импортирует.
  const exported = new Set<string>();
  for (const mod of importedModules(code, f)) for (const n of exportedNames(stripComments(readFileSync(mod, "utf8")))) exported.add(n);

  const misses: { name: string; line: number; from: string }[] = [];
  for (const c of calls(code)) {
    if (known.has(c.name)) continue;
    if (NODE_NAMES.has(c.name)) misses.push({ ...c, from: "node:*" });
    else if (exported.has(c.name)) misses.push({ ...c, from: "свой модуль" });
  }
  if (!misses.length) continue;
  bad++;
  const rel = f.slice(ROOT.length + 1).replace(/\\/g, "/");
  console.log(`FAIL  ${rel}`);
  for (const m of misses) console.log(`      ${m.line}: ${m.name} — вызывается, но не импортирован (${m.from})`);
}
console.log(bad ? `\n${bad} файл(ов) с непокрытыми вызовами` : `OK  все вызовы покрыты импортами (${files.length} файлов)`);
process.exit(bad ? 1 : 0);
