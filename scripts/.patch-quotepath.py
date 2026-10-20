# -*- coding: utf-8 -*-
"""Фикс: git экранирует не-ASCII пути (core.quotePath) — дифф их молча терял.

Симптом: для файла с не-ASCII именем заголовок выглядит как
`diff --git "a/\\320\\275\\320\\276..." "b/..."` — регулярка разбора его не
узнавала, и файл выпадал из диффа целиком: панель «Изменения» молча пуста,
apply ничего не переносил.

Лечится в двух местах:
  1. git запускаем с core.quotePath=false — он отдаёт путь как есть;
  2. разборщик умеет и закавыченную форму (патчи извне, чужая конфигурация).
"""
import io

# ── src/worktrees.ts ───────────────────────────────────────────────────────
P = "src/worktrees.ts"
s = io.open(P, encoding="utf-8").read()
orig = s


def sub(text, old, new, count=1):
    assert text.count(old) == count, "anchor not unique: %r (%d)" % (old[:70], text.count(old))
    return text.replace(old, new)


# 1. diff копии: пути без экранирования
s = sub(
    s,
    """    const patch = run(["git", "-C", info.path, "diff", "--no-color", info.baseRef ?? "HEAD"]);""",
    """    // core.quotePath=false: иначе git экранирует не-ASCII пути («\\320\\275...»),
    // и разбор такого заголовка молча терял файл целиком.
    const patch = run(["git", "-C", info.path, "-c", "core.quotePath=false", "diff", "--no-color", info.baseRef ?? "HEAD"]);""",
)

# 2. разборщик: закавыченная форма + помощник
s = sub(
    s,
    """/** Парсер unified diff → построчная структура. */
export function parseUnified(text: string): DiffFile[] {""",
    """/**
 * Раскодировать путь, который git закавычил (core.quotePath).
 *
 * По умолчанию git экранирует не-ASCII в путях: вместо «новый файл.txt» в
 * diff приходит "a/\\320\\275\\320\\276 \\321\\204\\320\\260\\320\\271\\320\\273.txt".
 * Такую форму разбор заголовка не узнавал — и файл выпадал из диффа целиком.
 * Возвращаем настоящее имя файла (в кавычках — C-экранирование: \\320 — это
 * байт, «\\n» — перевод строки).
 */
export function unquoteGitPath(p: string): string {
  if (p.length < 2 || !p.startsWith('"') || !p.endsWith('"')) return p;
  const inner = p.slice(1, -1);
  const bytes: number[] = [];
  const oct = (c: string) => c >= "0" && c <= "7";
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]!;
    if (c === "\\\\" && i + 3 < inner.length && oct(inner[i + 1]!) && oct(inner[i + 2]!) && oct(inner[i + 3]!)) {
      bytes.push(parseInt(inner.slice(i + 1, i + 4), 8));
      i += 3;
      continue;
    }
    if (c === "\\\\" && i + 1 < inner.length) {
      const esc: Record<string, number> = { n: 10, t: 9, r: 13, f: 12, b: 8, v: 11, a: 7, "\\\\": 92, '"': 34 };
      const code = esc[inner[i + 1]!];
      if (code !== undefined) { bytes.push(code); i += 1; continue; }
    }
    for (const b of new TextEncoder().encode(c)) bytes.push(b);
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** Заголовок «diff --git a/путь b/путь» → путь файла (и закавыченная форма). */
function gitHeaderPath(raw: string): string | null {
  const plain = raw.match(/^diff --git a\\/(.+?) b\\/(.+)$/);
  if (plain) return plain[2]!;
  const quoted = raw.match(/^diff --git "a\\/(.+?)" "b\\/(.+?)"$/);
  if (quoted) return unquoteGitPath(`"${quoted[2]}"`);
  return null;
}

/** Парсер unified diff → построчная структура. */
export function parseUnified(text: string): DiffFile[] {""",
)

s = sub(
    s,
    """    const gitHeader = raw.match(/^diff --git a\\/(.+?) b\\/(.+)$/);
    if (gitHeader) {
      cur = { path: gitHeader[2]!, status: "modified", lines: [], added: 0, deleted: 0 };
      files.push(cur);
      continue;
    }""",
    """    const headerPath = gitHeaderPath(raw);
    if (headerPath !== null) {
      cur = { path: headerPath, status: "modified", lines: [], added: 0, deleted: 0 };
      files.push(cur);
      continue;
    }""",
)

io.open(P, "w", encoding="utf-8", newline="\n").write(s)
print("worktrees.ts:", len(orig), "->", len(s))

# ── src/branch.ts ──────────────────────────────────────────────────────────
P = "src/branch.ts"
s = io.open(P, encoding="utf-8").read()
orig = s
s = sub(
    s,
    """  const r = gitRun(["git", "-C", target.path, "diff", "--no-color", "HEAD"]);""",
    """  // core.quotePath=false — иначе не-ASCII пути приходят экранированными и
  // разбор молча их теряет (см. unquoteGitPath в worktrees.ts).
  const r = gitRun(["git", "-C", target.path, "-c", "core.quotePath=false", "diff", "--no-color", "HEAD"]);""",
)
io.open(P, "w", encoding="utf-8", newline="\n").write(s)
print("branch.ts:", len(orig), "->", len(s))

# ── src/history.ts ─────────────────────────────────────────────────────────
P = "src/history.ts"
s = io.open(P, encoding="utf-8").read()
orig = s
s = sub(
    s,
    """  const stat = gitSafe(projectPath, ["show", "--numstat", "--format=", sha]) ?? "";
  const paths: { path: string; added: number; deleted: number }[] = [];
  for (const line of stat.split("\\n")) {
    const m = /^(\\d+|-)\\t(\\d+|-)\\t(.+)$/.exec(line.trim());
    if (!m) continue;
    paths.push({ path: m[3]!, added: m[1] === "-" ? 0 : Number(m[1]), deleted: m[2] === "-" ? 0 : Number(m[2]) });
  }
  // построчный дифф коммита (без numstat-шапок); readPatch парсит unified
  const patch = gitSafe(projectPath, ["show", "--no-color", "--format=", sha]) ?? "";""",
    """  // core.quotePath=false: иначе не-ASCII пути приходят экранированными.
  const stat = gitSafe(projectPath, ["-c", "core.quotePath=false", "show", "--numstat", "--format=", sha]) ?? "";
  const paths: { path: string; added: number; deleted: number }[] = [];
  for (const line of stat.split("\\n")) {
    const m = /^(\\d+|-)\\t(\\d+|-)\\t(.+)$/.exec(line.trim());
    if (!m) continue;
    paths.push({ path: unquoteGitPath(m[3]!), added: m[1] === "-" ? 0 : Number(m[1]), deleted: m[2] === "-" ? 0 : Number(m[2]) });
  }
  // построчный дифф коммита (без numstat-шапок); readPatch парсит unified
  const patch = gitSafe(projectPath, ["-c", "core.quotePath=false", "show", "--no-color", "--format=", sha]) ?? "";""",
)
s = sub(
    s,
    """    const head = /^diff --git a\\/(.+?) b\\/(.+)$/.exec(raw);
    if (head) { ensure(head[2]!); oldNo = 0; newNo = 0; continue; }""",
    """    const head = /^diff --git (?:a\\/(.+?) b\\/(.+)|"a\\/(.+?)" "b\\/(.+?)")$/.exec(raw);
    if (head) { ensure(head[2] ? head[2] : unquoteGitPath(`"${head[4]}"`)); oldNo = 0; newNo = 0; continue; }""",
)
s = sub(
    s,
    """import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";""",
    """import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { unquoteGitPath } from "./worktrees";""",
)
io.open(P, "w", encoding="utf-8", newline="\n").write(s)
print("history.ts:", len(orig), "->", len(s))
