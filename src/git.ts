// Dirigo — git-операции над копией сессии (V2-1.5).
//
// Поток: агент поработал в копии → «Коммит» (фиксирует правки в копии) →
// «Push» (ветка v2/<id> в remote) → «PR» (gh pr create или compare-URL) →
// «Merge» (--no-ff в целевую ветку проекта, по подтверждению).
//
// Все операции идут через Bun.spawn("git") — без зависимостей. ДESTRUCTIVE
// (merge) требуют confirmed=true — как apply.

import { getWorktree } from "./worktrees";
import { branchOps } from "./branch";

export interface GitResult {
  ok: boolean;
  action: string;
  detail: string;
  /** для push/pr — ветка; для pr — ссылка */
  branch?: string;
  url?: string;
}

function run(cmd: string[], cwd: string): { ok: boolean; out: string; err: string } {
  try {
    const r = Bun.spawnSync(cmd, { cwd });
    if (r.exitCode === null || r.exitCode === undefined) {
      // spawn не удался (нет бинарника и т.п.) — Bun бросает, но на всякий случай
      return { ok: false, out: "", err: "не удалось запустить процесс" };
    }
    return { ok: r.exitCode === 0, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
  } catch (e) {
    return { ok: false, out: "", err: String(e) };
  }
}

/** Имя ветки для сессии (создаётся лениво при push). */
export function sessionBranch(sessionId: string): string {
  return `v2/${sessionId.replace(/[^a-zA-Z0-9]/g, "").slice(-8) || "ses"}`;
}

/** Статус копии: ветка, изменений, коммит. */
export function gitStatus(sessionId: string): GitResult & { files?: string[]; commit?: string } {
  const wt = getWorktree(sessionId);
  if (!wt) return { ok: false, action: "status", detail: "нет копии" };
  const branch = run(["git", "-C", wt.path, "rev-parse", "--abbrev-ref", "HEAD"]);
  const porcelain = run(["git", "-C", wt.path, "status", "--porcelain"]);
  const head = run(["git", "-C", wt.path, "rev-parse", "--short", "HEAD"]);
  const files = porcelain.out ? porcelain.out.split("\n").map((l) => l.slice(3)) : [];
  return {
    ok: true, action: "status", detail: `${files.length} изменений`,
    branch: branch.out, commit: head.out, files,
  };
}

/** Коммит правок копии (git add -A + commit). detached HEAD → временная ветка. */
export function gitCommit(sessionId: string, message: string): GitResult {
  const wt = getWorktree(sessionId);
  if (!wt) return { ok: false, action: "commit", detail: "нет копии" };
  const msg = message?.trim() || "dirigo: правки агента";
  const add = run(["git", "-C", wt.path, "add", "-A"]);
  if (!add.ok) return { ok: false, action: "commit", detail: `git add: ${add.err}` };
  const head = run(["git", "-C", wt.path, "rev-parse", "--abbrev-ref", "HEAD"]);
  if (head.out === "HEAD") {
    // detached: фиксируем на ветке сессии, чтобы было куда пушить
    run(["git", "-C", wt.path, "checkout", "-b", sessionBranch(sessionId)]);
  }
  // Трейлеры происхождения: кто из агентов писал, какая модель, прошли ли
  // проверки и сколько раз работа возвращалась агенту. Читаются обычным
  // `git log` и не требуют от аудитора наших инструментов.
  let full = msg;
  try {
    const { ledgerTrailers } = require("./provenance") as typeof import("./provenance");
    const trailers = ledgerTrailers(sessionId);
    if (trailers.length) full = `${msg}\n\n${trailers.join("\n")}`;
  } catch { /* без трейлеров коммит всё равно должен состояться */ }
  const commit = run(["git", "-C", wt.path, "commit", "-m", full]);
  const short = run(["git", "-C", wt.path, "rev-parse", "--short", "HEAD"]);
  return {
    ok: commit.ok, action: "commit", detail: commit.ok ? `коммит ${short.out}` : (commit.err || commit.out),
    branch: sessionBranch(sessionId),
  };
}

/** Push ветки сессии в remote. */
export function gitPush(sessionId: string, remote = "origin"): GitResult {
  const wt = getWorktree(sessionId);
  if (!wt) return { ok: false, action: "push", detail: "нет копии" };
  const remotes = run(["git", "-C", wt.path, "remote"]);
  if (!remotes.out.split("\n").includes(remote)) {
    return { ok: false, action: "push", detail: `remote «${remote}» не настроен (есть: ${remotes.out || "нет"})` };
  }
  const branch = sessionBranch(sessionId);
  const push = run(["git", "-C", wt.path, "push", "-u", remote, branch]);
  return { ok: push.ok, action: "push", detail: push.ok ? `ветка ${branch} → ${remote}` : (push.err || push.out), branch };
}

/** PR через gh (если установлен и авторизован), иначе compare-URL. */
export function gitPr(sessionId: string, title?: string, base = "main"): GitResult {
  const wt = getWorktree(sessionId);
  if (!wt) return { ok: false, action: "pr", detail: "нет копии" };
  const branch = sessionBranch(sessionId);
  const gh = run(["gh", "auth", "status"]);
  if (!gh.ok) {
    const remote = run(["git", "-C", wt.path, "remote", "get-url", "origin"]);
    const url = remote.out
      ? remote.out.replace(/\.git$/, "").replace(/^git@github\.com:/, "https://github.com/") + `/compare/${base}...${branch}?expand=1`
      : "";
    return { ok: false, action: "pr", detail: "gh не авторизован — открой compare-URL", branch, url };
  }
  const head = run(["git", "-C", wt.path, "rev-parse", "--abbrev-ref", "HEAD"]);
  const pr = run(["gh", "pr", "create", "--base", base, "--head", head.out === "HEAD" ? branch : head.out,
    "--title", title?.trim() || `dirigo: ${branch}`, "--fill"]);
  return { ok: pr.ok, action: "pr", detail: pr.ok ? pr.out : (pr.err || pr.out), branch, url: pr.out };
}

/** Merge ветки сессии в целевую ветку боевого проекта (--no-ff). */
export function gitMerge(sessionId: string, into = "main", confirmed = false): GitResult {
  const wt = getWorktree(sessionId);
  if (!wt) return { ok: false, action: "merge", detail: "нет копии" };
  if (!confirmed) return { ok: false, action: "merge", detail: "требуется подтверждение (confirmed=true)" };
  const project = wt.projectPath;
  const dirty = run(["git", "-C", project, "status", "--porcelain"]);
  if (dirty.out) return { ok: false, action: "merge", detail: `проект грязный (${dirty.out.split("\n").length} файлов) — сначала commit/apply` };
  const cur = run(["git", "-C", project, "rev-parse", "--abbrev-ref", "HEAD"]);
  const branch = sessionBranch(sessionId);
  if (cur.out !== into) {
    const co = run(["git", "-C", project, "checkout", into]);
    if (!co.ok) return { ok: false, action: "merge", detail: `checkout ${into}: ${co.err || co.out}` };
  }
  const merge = run(["git", "-C", project, "merge", "--no-ff", branch, "-m", `merge ${branch} (dirigo)`]);
  return { ok: merge.ok, action: "merge", detail: merge.ok ? `влито в ${into}` : (merge.err || merge.out), branch };
}

/** Единая точка входа для API. */
export function gitAction(sessionId: string, action: string, opts: {
  message?: string; remote?: string; into?: string; base?: string; title?: string; confirmed?: boolean;
} = {}): GitResult {
  // V9: branch-mode — если у сессии нет копии, работаем с деревом проекта.
  const wt = getWorktree(sessionId);
  if (!wt) return branchOps(sessionId, action, opts);
  switch (action) {
    case "commit": return gitCommit(sessionId, opts.message ?? "");
    case "push": return gitPush(sessionId, opts.remote ?? "origin");
    case "pr": return gitPr(sessionId, opts.title, opts.base ?? "main");
    case "merge": return gitMerge(sessionId, opts.into ?? "main", opts.confirmed === true);
    case "status": return gitStatus(sessionId);
    default: return { ok: false, action, detail: `неизвестное действие: ${action}` };
  }
}
