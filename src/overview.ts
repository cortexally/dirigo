// Dirigo v1.3 — «Обзор»: агрегация по проектам для дашборда (V6-9).
// Считаем по данным демона + git: сессии, последняя активность, коммиты,
// последний коммит, токены. Всё быстрое — без сетевых вызовов.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

const gitSafe = (dir: string, args: string[]): string | null => {
  try { return execFileSync("git", ["-C", dir, ...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }); } catch { return null; }
};

export interface OverviewProject {
  id: string; name: string; path: string; archived?: boolean;
  sessions: number; active: number; failed: number; done: number;
  tokens: number; commits: number; branch: string; lastCommit: string;
  lastActivity: number; agents: string[];
}

export function overview(
  projects: Array<{ id: string; name: string; path: string; createdAt: number; archived?: boolean }>,
  sessions: Array<{ id: string; projectId: string; agentId: string; status: string; tokens?: number; updatedAt?: number }>,
): {
  ok: boolean; projects: OverviewProject[]; totals: { projects: number; sessions: number; active: number; tokens: number; commits: number };
  agents: Array<{ agentId: string; sessions: number; tokens: number }>;
} {
  const rows: OverviewProject[] = [];
  const agentAgg = new Map<string, { sessions: number; tokens: number }>();
  let totalTokens = 0, totalCommits = 0, activeTotal = 0;

  for (const p of projects) {
    const mine = sessions.filter((s) => s.projectId === p.id);
    const active = mine.filter((s) => s.status === "running" || s.status === "queued").length;
    const failed = mine.filter((s) => s.status === "error").length;
    const done = mine.filter((s) => s.status === "done").length;
    const tokens = mine.reduce((sum, s) => sum + (s.tokens ?? 0), 0);
    const agents = [...new Set(mine.map((s) => s.agentId))];
    const lastActivity = Math.max(0, ...mine.map((s) => s.updatedAt ?? 0));

    let commits = 0, branch = "—", lastCommit = "";
    if (existsSync(p.path)) {
      const n = gitSafe(p.path, ["rev-list", "--count", "HEAD"]);
      commits = n ? Number(n.trim()) || 0 : 0;
      const br = gitSafe(p.path, ["rev-parse", "--abbrev-ref", "HEAD"]);
      branch = (br ?? "").trim() || "—";
      const lc = gitSafe(p.path, ["log", "-1", "--format=%h %s"]);
      lastCommit = (lc ?? "").trim();
    }
    rows.push({ id: p.id, name: p.name, path: p.path, archived: p.archived, sessions: mine.length, active, failed, done, tokens, commits, branch, lastCommit, lastActivity, agents });
    for (const a of agents) {
      const cur = agentAgg.get(a) ?? { sessions: 0, tokens: 0 };
      cur.sessions += mine.filter((s) => s.agentId === a).length;
      cur.tokens += mine.filter((s) => s.agentId === a).reduce((sum, s) => sum + (s.tokens ?? 0), 0);
      agentAgg.set(a, cur);
    }
    totalTokens += tokens; totalCommits += commits; activeTotal += active;
  }

  return {
    ok: true,
    projects: rows.sort((a, b) => b.lastActivity - a.lastActivity || b.sessions - a.sessions),
    totals: { projects: projects.length, sessions: sessions.length, active: activeTotal, tokens: totalTokens, commits: totalCommits },
    agents: [...agentAgg.entries()].map(([agentId, v]) => ({ agentId, ...v })).sort((a, b) => b.tokens - a.tokens),
  };
}
