// Dirigo — «История версий» проекта: дерево коммитов, ветки, теги.
//
// Одна команда git даёт всё, что показано на макете: дерево коммитов с
// временем, веткой, тегами и числом файлов; раскрытие коммита — какие файлы
// и на сколько строк. «Вернуть проект к этой версии» = stash (страховка
// текущих правок) + checkout sha.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { unquoteGitPath } from "./worktrees";

const SEP = "\u001f"; // юнит-разделитель между полями (git --format)
const REC = "\u001e"; // разделитель записей

function git(dir: string, args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}
function gitSafe(dir: string, args: string[]): string | null {
  try { return git(dir, args); } catch { return null; }
}

export interface HistoryFileChange { path: string; added: number; deleted: number; }
export interface HistoryCommit {
  sha: string; message: string; time: number; branch: string;
  tags: string[]; files: number; added: number; deleted: number;
  changes: HistoryFileChange[];
}

export function historyOf(projectPath: string): {
  ok: boolean; error?: string; branch?: string; head?: string;
  commits: HistoryCommit[]; remote?: string;
} {
  if (!existsSync(projectPath)) return { ok: false, error: "нет пути", commits: [] };
  if (gitSafe(projectPath, ["rev-parse", "--is-inside-work-tree"])?.trim() !== "true") {
    return { ok: false, error: "не git-проект", commits: [] };
  }
  const branch = gitSafe(projectPath, ["rev-parse", "--abbrev-ref", "HEAD"])?.trim()
    || gitSafe(projectPath, ["symbolic-ref", "--short", "HEAD"])?.trim()
    || gitSafe(projectPath, ["config", "--get", "init.defaultBranch"])?.trim()
    || "main";
  const head = gitSafe(projectPath, ["rev-parse", "HEAD"])?.trim() ?? "";
  const remote = gitSafe(projectPath, ["remote", "get-url", "origin"])?.trim() || undefined;

  // теги: sha → [имена]; сначала точные, затем ^sha (аннотированные/легковесные)
  const tagsBySha = new Map<string, string[]>();
  for (const line of (gitSafe(projectPath, ["show-ref", "--tags", "-d"]) ?? "").split("\n")) {
    const m = /^([0-9a-f]{40})\s+refs\/tags\/(.+?)(\^\{\})?$/.exec(line.trim());
    if (!m) continue;
    const [sha, name] = [m[1]!, m[2]!];
    if (!tagsBySha.has(sha)) tagsBySha.set(sha, []);
    tagsBySha.get(sha)!.push(name);
  }

  const fmt = ["%H", "%s", "%ct", "%h", "%D"].join(SEP);
  const log = gitSafe(projectPath, ["log", "-n", "60", `--format=${fmt}${REC}`]) ?? "";
  const commits: HistoryCommit[] = [];
  for (const rec of log.split(REC)) {
    const [sha, message, ctime, , refs] = rec.trim().split(SEP);
    if (!sha || !/^[0-9a-f]{40}$/.test(sha)) continue;
    // stat последнего коммита: файлы + строки (add/del)
    const stat = gitSafe(projectPath, ["show", "--numstat", "--format=", sha]) ?? "";
    const changes: HistoryFileChange[] = [];
    let added = 0, deleted = 0;
    for (const line of stat.split("\n")) {
      const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line.trim());
      if (!m) continue;
      const a = m[1] === "-" ? 0 : Number(m[1]);
      const d = m[2] === "-" ? 0 : Number(m[2]);
      changes.push({ path: m[3]!, added: a, deleted: d });
      added += a; deleted += d;
    }
    const tags = [...(tagsBySha.get(sha) ?? [])];
    // Ветка коммита: из %D (tag: name, HEAD -> branch, origin/branch). Берём
    // первую настоящую ветку; у коммитов без неё — текущая ветка проекта
    // (иначе в UI появлялся бы «?» вместо названия).
    const refList = (refs ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const branchRef = refList.find((s) => !s.includes("tag:") && !s.startsWith("HEAD"))
      ?? refList.find((s) => s.includes("->") && !s.includes("tag:"))?.split("->").pop()?.trim();
    const branchName = (branchRef && branchRef !== "HEAD" ? branchRef.replace(/^origin\//, "") : "") || branch || "main";
    commits.push({
      sha, message: message ?? "", time: Number(ctime ?? 0) || Math.floor(Date.now() / 1000),
      branch: branchName,
      tags, files: changes.length, added, deleted, changes,
    });
  }
  return { ok: true, branch, head, commits, remote };
}

/** Дифф конкретного коммита: файлы со строками (для предпросмотра в UI). */
export function commitDiff(projectPath: string, sha: string): {
  ok: boolean; error?: string; sha: string; message?: string; files: Array<{ path: string; added: number; deleted: number; lines: Array<{ kind: "add" | "del" | "ctx"; text: string; oldNo: number | null; newNo: number | null }> }>;
} {
  if (!/^[0-9a-f]{4,40}$/.test(sha)) return { ok: false, error: "не похоже на commit sha", sha, files: [] };
  if (!existsSync(projectPath)) return { ok: false, error: "нет пути", sha, files: [] };
  const message = (gitSafe(projectPath, ["log", "-1", "--format=%s", sha]) ?? "").trim();
  // core.quotePath=false: иначе не-ASCII пути приходят экранированными.
  const stat = gitSafe(projectPath, ["-c", "core.quotePath=false", "show", "--numstat", "--format=", sha]) ?? "";
  const paths: { path: string; added: number; deleted: number }[] = [];
  for (const line of stat.split("\n")) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line.trim());
    if (!m) continue;
    paths.push({ path: unquoteGitPath(m[3]!), added: m[1] === "-" ? 0 : Number(m[1]), deleted: m[2] === "-" ? 0 : Number(m[2]) });
  }
  // построчный дифф коммита (без numstat-шапок); readPatch парсит unified
  const patch = gitSafe(projectPath, ["-c", "core.quotePath=false", "show", "--no-color", "--format=", sha]) ?? "";
  const files = parsePatch(patch, paths);
  return { ok: true, sha, message, files };
}

/** Разбор unified-diff в построчные записи (общий парсер для коммита). */
function parsePatch(text: string, stats: Array<{ path: string; added: number; deleted: number }>) {
  const files: Array<{ path: string; added: number; deleted: number; lines: Array<{ kind: "add" | "del" | "ctx"; text: string; oldNo: number | null; newNo: number | null }> }> = [];
  let cur: (typeof files)[number] | null = null;
  let oldNo = 0, newNo = 0;
  const ensure = (path: string) => {
    if (cur?.path === path) return cur;
    const st = stats.find((s) => s.path === path);
    cur = { path, added: st?.added ?? 0, deleted: st?.deleted ?? 0, lines: [] };
    files.push(cur);
    return cur;
  };
  for (const raw of text.split(/\r?\n/)) {
    const head = /^diff --git (?:a\/(.+?) b\/(.+)|"a\/(.+?)" "b\/(.+?)")$/.exec(raw);
    if (head) { ensure(head[2] ? head[2] : unquoteGitPath(`"${head[4]}"`)); oldNo = 0; newNo = 0; continue; }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) { if (!cur) continue; oldNo = Number(hunk[1]); newNo = Number(hunk[2]); continue; }
    if (!cur || raw.startsWith("diff ") || raw.startsWith("index ") || raw.startsWith("--- ") || raw.startsWith("+++ ") || raw.startsWith("new file") || raw.startsWith("deleted file")) continue;
    if (raw.startsWith("+")) { cur.lines.push({ kind: "add", text: raw.slice(1), oldNo: null, newNo: newNo++ }); continue; }
    if (raw.startsWith("-")) { cur.lines.push({ kind: "del", text: raw.slice(1), oldNo: oldNo++, newNo: null }); continue; }
    cur.lines.push({ kind: "ctx", text: raw.startsWith(" ") ? raw.slice(1) : raw, oldNo: oldNo++, newNo: newNo++ });
  }
  return files;
}

/** Вернуть проект к версии: stash текущих правок (страховка) + checkout sha. */
export function restoreTo(projectPath: string, sha: string): { ok: boolean; detail: string } {
  if (!/^[0-9a-f]{4,40}$/.test(sha)) return { ok: false, detail: "не похоже на commit sha" };
  if (!existsSync(projectPath)) return { ok: false, detail: "нет пути" };
  const dirty = (gitSafe(projectPath, ["status", "--porcelain"]) ?? "").trim();
  if (dirty) {
    const st = gitSafe(projectPath, ["stash", "push", "-u", "-m", `dirigo: авто-stash перед возвратом к ${sha.slice(0, 7)}`]);
    if (st === null) return { ok: false, detail: "не удалось спрятать текущие правки" };
  }
  const co = gitSafe(projectPath, ["checkout", sha]);
  if (co === null) {
    if (dirty) gitSafe(projectPath, ["stash", "pop"]);
    return { ok: false, detail: "checkout не удался — правки возвращены" };
  }
  return { ok: true, detail: `проект на версии ${sha.slice(0, 7)}${dirty ? " (текущие правки в stash)" : ""}` };
}
