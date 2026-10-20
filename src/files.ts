// Dirigo v1.1 — дерево файлов и содержимое (правая панель клона, V5-7).
//
// Листинг идёт git'ом (отслеживаемые файлы + актуальные untracked), чтобы
// не показывать node_modules/.git/артефакты. Чтение — только внутри проекта
// (защита от выхода за его пределы), с ограничением размера.

import { execFileSync } from "node:child_process";
import { existsSync, statSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";

const MAX_FILE_BYTES = 512 * 1024; // текст больше — обрежем
const MAX_TEXT_CHARS = 200_000;

export interface FileEntry { path: string; status: "tracked" | "new"; size?: number; }

function gitTracked(dir: string): string[] {
  try {
    const out = execFileSync("git", ["-C", dir, "ls-files", "-z"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    return out.split("\0").filter(Boolean);
  } catch { return []; }
}

/** Все файлы проекта: отслеживаемые + новые (untracked, без игнорируемых). */
export function listFiles(dir: string): FileEntry[] {
  if (!existsSync(dir)) return [];
  const out: FileEntry[] = [];
  const seen = new Set<string>();
  for (const p of gitTracked(dir)) {
    if (seen.has(p)) continue;
    seen.add(p);
    try { out.push({ path: p, status: "tracked", size: statSync(join(dir, p)).size }); } catch { out.push({ path: p, status: "tracked" }); }
  }
  try {
    const raw = execFileSync("git", ["-C", dir, "ls-files", "-o", "--exclude-standard", "-z"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    for (const p of raw.split("\0").filter(Boolean)) {
      if (seen.has(p)) continue;
      seen.add(p);
      out.push({ path: p, status: "new" });
    }
  } catch { /* не git — только tracked выше (пусто) */ }
  // Не git-проект: покажем верхний уровень, чтобы панель не была пустой
  if (!out.length) {
    try {
      const { readdirSync } = require("node:fs") as typeof import("node:fs");
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name.startsWith(".") || e.name === "node_modules") continue;
        if (e.isFile()) out.push({ path: e.name, status: "tracked" });
        else if (e.isDirectory()) out.push({ path: `${e.name}/…`, status: "tracked" });
      }
    } catch { /* пусто */ }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

function insideProject(root: string, candidate: string): boolean {
  const real = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };
  const r = real(root), c = real(candidate);
  return c === r || c.startsWith(r + (/[\\/]$/.test(r) ? "" : /\\/.test(process.platform === "win32" ? "\\" : "/")) && true) || relative(r, c).split(/[\\/]/)[0] !== "..";
}

export interface FileReadResult { content: string; truncated: boolean; size: number; }

/** Прочитать файл проекта по относительному пути. null — путь вне проекта. */
export function readProjectFile(root: string, rel: string): FileReadResult | null {
  if (!rel || isAbsolute(rel)) return null;
  const abs = join(root, rel);
  if (!insideProject(root, abs)) return null;
  if (!existsSync(abs) || !statSync(abs).isFile()) return null;
  const size = statSync(abs).size;
  const truncated = size > MAX_FILE_BYTES;
  const buf = readFileSync(abs);
  const text = buf.subarray(0, MAX_FILE_BYTES).toString("utf8");
  return { content: text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) + "\n… (обрезано)" : text, truncated, size };
}
