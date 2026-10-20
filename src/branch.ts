// Dirigo — прямой режим работы с бранчем проекта (V9, без копии).
//
// Пользователь просил: «если копия не выбрана — чтобы кнопки работали на текущем
// выбранном бранче (и показывали её)». Здесь реализован «branch-mode»: та же
// панель управления (Проверки / Commit / Push / PR / Merge / Резолв / Применить),
// но операции идут напрямую в рабочем дереве проекта.
//
// Ключевая концепция: `BranchTarget` — адресная цель панели. Она либо
// «копия» (worktree), либо «бранч» (рабочее дерево проекта). Сервер выбирает
// целевой путь сам, UI показывает, чем именно управляет.

import { existsSync } from "node:fs";
import { gitRepoInfo, isGitProject, lineDiff, parseUnified, run as gitRun, runRead as gitRead, type DiffFile } from "./worktrees";
import { projects, sessions } from "./store";

export type TargetKind = "copy" | "branch";

export interface BranchTarget {
  kind: TargetKind;
  /** абсолютный путь, где происходят операции */
  path: string;
  /** git работает здесь (git -C path: status/diff/commit)? для подкаталога — тоже true */
  git: boolean;
  /** текущая ветка (если git) */
  branch?: string;
  /** база для диффа: HEAD (все незакоммиченные изменения) */
  baseRef?: string;
  /** сколько коммитов впереди origin (нужно для кнопки Push) */
  ahead?: number;
  /** подкаталог чужого репо (монорепо): git работает, но worktree отсюда нельзя */
  subdirOfRepo?: string;
}

/** Определить цель по сессии: копия, если есть; иначе рабочее дерево проекта. */
export function resolveTarget(projectPath: string, worktreePath?: string): BranchTarget {
  if (worktreePath && existsSync(worktreePath)) {
    const info = gitRepoInfo(worktreePath);
    const git = info.insideWorkTree || isGitProject(projectPath);
    return {
      kind: "copy",
      path: worktreePath,
      git,
      branch: git ? currentBranch(worktreePath) : undefined,
      baseRef: git ? headOf(worktreePath) : undefined,
      ahead: git ? aheadCount(worktreePath) : undefined,
      subdirOfRepo: info.insideWorkTree && !info.isRoot ? info.relFromRoot : undefined,
    };
  }
  const info = gitRepoInfo(projectPath);
  return {
    kind: "branch",
    path: projectPath,
    git: info.insideWorkTree,
    branch: info.insideWorkTree ? currentBranch(projectPath) : undefined,
    baseRef: info.insideWorkTree ? headOf(projectPath) : undefined,
    ahead: info.insideWorkTree ? aheadCount(projectPath) : undefined,
    subdirOfRepo: info.insideWorkTree && !info.isRoot ? info.relFromRoot : undefined,
  };
}

export function currentBranch(path: string): string | undefined {
  // detached HEAD (копия = worktree --detach) отдаёт "HEAD" — для UI это «?».
  // Показываем базовую ветку проекта: она и есть смысл «на чём based».
  const r = gitRead(["git", "-C", path, "rev-parse", "--abbrev-ref", "HEAD"]);
  if (!r.ok) return undefined;
  if (r.out && r.out !== "HEAD") return r.out;
  const base = gitRead(["git", "-C", path, "rev-parse", "--abbrev-ref", "HEAD@{upstream}"]);
  if (base.ok && base.out) return base.out.replace(/^origin\//, "");
  // fallback: ветка проекта, из которой сделана копия
  const proj = gitRead(["git", "-C", path, "config", "--get", "dirigo.baseBranch"]);
  if (proj.ok && proj.out) return proj.out;
  return "main";
}

export function headOf(path: string): string | undefined {
  const r = gitRead(["git", "-C", path, "rev-parse", "HEAD"]);
  return r.ok ? r.out : undefined;
}

/** Сколько коммитов локальная ветка впереди remote (для подсказки Push). */
export function aheadCount(path: string): number | undefined {
  const branch = currentBranch(path);
  if (!branch) return undefined;
  const r = gitRead(["git", "-C", path, "rev-list", "--count", `@{upstream}..HEAD`]);
  if (!r.ok) return undefined;
  const n = Number(r.out);
  return Number.isFinite(n) ? n : undefined;
}

/** Дифф цели vs HEAD: незакоммиченные изменения (+ untracked). */
export function branchDiff(target: BranchTarget): { files: DiffFile[]; added: number; deleted: number } {
  if (!target.git) return { files: [], added: 0, deleted: 0 };
  // подкаталог: add -N ограничиваем pathspec "." (иначе застейджит intent-to-add
  // весь репо). git -C уже в подкаталоге, "." = только файлы проекта.
  const pathspec = target.subdirOfRepo ? ["--", "."] : [];
  gitRun(["git", "-C", target.path, "add", "-A", "-N", ...pathspec]);
  // core.quotePath=false — иначе не-ASCII пути приходят экранированными и
  // разбор молча их теряет (см. unquoteGitPath в worktrees.ts).
  const r = gitRun(["git", "-C", target.path, "-c", "core.quotePath=false", "diff", "--no-color", "HEAD"]);
  let files = parseUnified(r.out);
  // подкаталог монорепо: git diff отдаёт пути относительно КОРНЯ репо (dirigo/...).
  // Фильтруем — показываем только файлы внутри проекта (префикс relFromRoot),
  // путь в UI обрезаем до относительного от проекта.
  if (target.subdirOfRepo) {
    const prefix = target.subdirOfRepo + "/";
    files = files
      .filter((f) => f.path === target.subdirOfRepo || f.path.startsWith(prefix))
      .map((f) => ({ ...f, path: f.path.startsWith(prefix) ? f.path.slice(prefix.length) : "" }));
  }
  let added = 0, deleted = 0;
  for (const f of files) { added += f.added; deleted += f.deleted; }
  return { files, added, deleted };
}

/** Обёртка для UI: человекочитаемое описание цели. */
export function describeTarget(target: BranchTarget): string {
  if (target.kind === "copy") {
    if (target.git) {
      return target.subdirOfRepo
        ? `копия · ${target.subdirOfRepo} (монорепо)`
        : `копия · ветка ${target.branch ?? "?"}`;
    }
    return "копия (файловая)";
  }
  if (!target.git) return "папка проекта (без git)";
  return target.subdirOfRepo
    ? `бранч ${target.branch ?? "?"} · ${target.subdirOfRepo} (монорепо)`
    : `бранч ${target.branch ?? "?"} · прямое дерево`;
}

export { lineDiff };

/* ---------------- git-операции в прямом дереве (branch-mode) ---------------- */

/**
 * Те же git-кнопки, что и для копии, но в рабочем дереве проекта:
 * commit (git add -A + commit), push (в текущую ветку), PR (gh/compare),
 * merge (влить ветку сессии в main — no-op для прямого дерева),
 * status (состояние проекта).
 */
export function branchOps(sessionId: string, action: string, opts: {
  message?: string; remote?: string; into?: string; base?: string; title?: string; confirmed?: boolean;
}): { ok: boolean; action: string; detail: string; branch?: string; url?: string } {
  const r = gitRun(["git", "-C", ".", "rev-parse", "--show-toplevel"]); // не используется — цель придёт из сессии
  void r;
  const target = targetOfSession(sessionId);
  if (!target) return { ok: false, action, detail: "нет сессии" };
  const path = target.path;

  switch (action) {
    case "status": {
      const porcelain = gitRun(["git", "-C", path, "status", "--porcelain"]);
      return {
        ok: target.git, action,
        branch: target.branch,
        detail: target.git ? (porcelain.out ? `изменений: ${porcelain.out.split("\n").length}` : "чисто") : "не git-проект",
      };
    }
    case "commit": {
      if (!target.git) return { ok: false, action, detail: "не git-проект" };
      // подкаталог монорепо: add -A застейджил бы ВЕСЬ репо (git add не ограничен
      // cwd). pathspec "." ограничивает ТЕКУЩИЙ каталог (= подкаталог проекта),
      // т.к. git -C уже стоит в нём. Коммитим только файлы проекта.
      const pathspec = target.subdirOfRepo ? ["--", "."] : [];
      const add = gitRun(["git", "-C", path, "add", "-A", ...pathspec]);
      if (!add.ok) return { ok: false, action, detail: `git add: ${add.err}` };
      const commit = gitRun(["git", "-C", path, "commit", "-m", opts.message?.trim() || "dirigo: правки"]);
      return { ok: commit.ok, action, branch: target.branch, detail: commit.ok ? "закоммичено" : (commit.err || commit.out) };
    }
    case "push": {
      if (!target.git) return { ok: false, action, detail: "не git-проект" };
      const remote = opts.remote ?? "origin";
      const remotes = gitRun(["git", "-C", path, "remote"]);
      if (!remotes.out.split("\n").includes(remote)) return { ok: false, action, detail: `remote «${remote}» не настроен` };
      const push = gitRun(["git", "-C", path, "push", "-u", remote, target.branch ?? "HEAD"]);
      return { ok: push.ok, action, branch: target.branch, detail: push.ok ? `ветка ${target.branch} → ${remote}` : (push.err || push.out) };
    }
    case "pr": {
      if (!target.git) return { ok: false, action, detail: "не git-проект" };
      const gh = gitRun(["gh", "auth", "status"]);
      if (!gh.ok) {
        const remote = gitRun(["git", "-C", path, "remote", "get-url", "origin"]);
        const url = remote.out
          ? remote.out.replace(/\.git$/, "").replace(/^git@github\.com:/, "https://github.com/") +
            `/compare/${opts.base ?? "main"}...${target.branch ?? "HEAD"}?expand=1`
          : "";
        return { ok: false, action, branch: target.branch, url, detail: "gh не авторизован — открой compare-URL" };
      }
      const pr = gitRun(["gh", "pr", "create", "--base", opts.base ?? "main", "--head", target.branch ?? "HEAD",
        "--title", opts.title?.trim() || "dirigo: правки", "--fill"]);
      return { ok: pr.ok, action, branch: target.branch, url: pr.out, detail: pr.ok ? pr.out : (pr.err || pr.out) };
    }
    case "merge": {
      if (!target.git) return { ok: false, action, detail: "не git-проект" };
      const into = opts.into ?? "main";
      const cur = currentBranch(path);
      if (cur === into) return { ok: true, action, detail: `уже на ${into}` };
      if (opts.confirmed !== true) return { ok: false, action, detail: "требуется подтверждение (confirmed=true)" };
      const checkout = gitRun(["git", "-C", path, "checkout", into]);
      if (!checkout.ok) return { ok: false, action, detail: `checkout ${into}: ${checkout.err || checkout.out}` };
      const merge = gitRun(["git", "-C", path, "merge", "--no-ff", cur ?? "HEAD", "-m", `merge ${cur ?? "HEAD"} (dirigo)`]);
      return { ok: merge.ok, action, branch: into, detail: merge.ok ? `влито в ${into}` : (merge.err || merge.out) };
    }
    default:
      return { ok: false, action, detail: `неизвестное действие: ${action}` };
  }
}

/** Сессия → дерево-цель (проект), без реестра копий. */
function targetOfSession(sessionId: string): BranchTarget | null {
  const s = sessions.get(sessionId);
  if (!s) return null;
  const project = projects.get(s.projectId);
  if (!project) return null;
  return resolveTarget(project.path, s.worktree?.path);
}
