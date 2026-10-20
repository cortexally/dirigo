// Dirigo — учёт usage по сессиям (V2-6.4).
//
// Агенты отдаютUsage в разных местах: ACP — структурно (prompt/completion tokens
// в stop-результате), CLI — текстом в логе («tokens 1234», «Tokens: 1234»,
// «total_tokens: 1234»). Демон не выдумывает точность: собирает всё, что найдёт
// в хвосте лога, и помечает источник (acp/text). Итог — оценка «≈».

import { readLogTail, sessions } from "./store";

export interface SessionUsage {
  sessionId: string;
  agentId: string;
  title: string;
  status: string;
  tokens: number;
  /** из каких мест собрали: acp | text | est (оценка по объёму) | нет */
  source: "acp" | "text" | "est" | "none";
  /** сколько нашли упоминаний (для оценки надежности) */
  mentions: number;
  /** когда сессия обновлялась (ms) — для недельных графиков Stats */
  at: number;
}

const PATTERNS: RegExp[] = [
  /tokens?\s*[=:]?\s*(\d{2,})/i,          // "tokens 1234", "Tokens: 1234"
  /total[_\s]?tokens?\s*[=:]?\s*(\d{2,})/i, // "total_tokens: 1234"
  /(\d{3,})\s*tokens?/i,                   // "1234 tokens"
];

/** Собрать usage одной сессии из хвоста лога. */
export async function collectUsage(sessionId: string): Promise<SessionUsage | null> {
  const s = sessions.get(sessionId);
  if (!s) return null;
  const lines = await readLogTail(sessionId, 400);
  const text = lines.join("\n");
  let tokens = 0;
  let mentions = 0;
  let source: SessionUsage["source"] = "none";
  for (const line of lines) {
    const acpMatch = line.match(/\[acp\] stop:.*?tokens\s+(\d+)/i);
    if (acpMatch) { tokens += Number(acpMatch[1]); mentions++; source = "acp"; continue; }
    let matched = false;
    for (const re of PATTERNS) {
      const m = line.match(re);
      if (m) { tokens += Number(m[1]); mentions++; matched = true; break; }
    }
    if (matched && source === "none") source = "text";
  }
  // агент не отдал токены явно — оценка по объёму лога (≈4 символа на токен).
  // Честнее нуля: «Обзор»/«Статистика» иначе всегда пустые. Источник — "est".
  if (tokens === 0 && text.length > 400) {
    tokens = Math.round(text.length / 4);
    source = "est";
  }
  void text;
  return { sessionId, agentId: s.agentId, title: s.title, status: s.status, tokens, source, mentions, at: s.updatedAt ?? 0 };
}

/** Сводка usage по всем сессиям (для health/UI). */
export async function collectAllUsage(): Promise<{ total: number; sessions: SessionUsage[] }> {
  const all = sessions.list();
  const items: SessionUsage[] = [];
  let total = 0;
  for (const s of all) {
    const u = await collectUsage(s.id);
    if (u) { items.push(u); total += u.tokens; }
  }
  return { total, sessions: items.sort((a, b) => b.tokens - a.tokens) };
}
