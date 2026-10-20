// Dirigo — библиотека скиллов (V2-5.4).
//
// Скилл = папка skills/<name>/ с SKILL.md (фронтматтер name/description + инструкция).
// Демон только перечисляет и отдаёт содержимое: применение скилла — на стороне
// агента/режима (в solo-поток скилл можно вложить в промпт).

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface SkillMeta {
  name: string;
  description: string;
  /** путь к SKILL.md */
  path: string;
  /** размер инструкции в символах */
  size: number;
}

const SKILLS_DIR = new URL("../skills/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

/** Разбор фронтматтера YAML-мини (--- name: x / description: y ---). */
function parseFrontmatter(text: string): { name: string; description: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return { name: "", description: "" };
  const name = m[1]!.match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? "";
  const description = m[1]!.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? "";
  return { name, description };
}

export function listSkills(): SkillMeta[] {
  if (!existsSync(SKILLS_DIR)) return [];
  const out: SkillMeta[] = [];
  for (const entry of readdirSync(SKILLS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = join(SKILLS_DIR, entry.name, "SKILL.md");
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    const fm = parseFrontmatter(text);
    out.push({
      name: fm.name || entry.name,
      description: fm.description || "(без описания)",
      path: file,
      size: text.length,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Полный текст скилла по имени (для вложения в промпт). */
export function readSkill(name: string): string | null {
  const file = join(SKILLS_DIR, name, "SKILL.md");
  if (!existsSync(file)) return null;
  return readFileSync(file, "utf8");
}

/** Все скилл-инструкции одним блоком — для префикса промпта solo-сессии. */
export function skillsPromptBlock(): string {
  const skills = listSkills();
  if (!skills.length) return "";
  return [
    "Доступные скиллы проекта (применяй по ситуации, следуй инструкциям):",
    ...skills.map((s) => `• ${s.name} — ${s.description}`),
  ].join("\n");
}

export interface SkillHit { name: string; description: string; score: number; snippet: string; }

/**
 * Локальный поиск по скиллам (V2-5.5, аналог /parse-skill): скоринг по
 * имени (вес 3), описанию (2) и телу (1) с текстом вокруг совпадения.
 */
export function searchSkills(query: string): SkillHit[] {
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 1);
  if (!terms.length) return [];
  const hits: SkillHit[] = [];
  for (const s of listSkills()) {
    const text = readSkill(s.name);
    if (text === null) continue;
    const name = s.name.toLowerCase(), desc = s.description.toLowerCase(), body = text.toLowerCase();
    let score = 0;
    let firstAt = -1;
    for (const t of terms) {
      const n = name.split(t).length - 1;
      const d = desc.split(t).length - 1;
      const b = body.split(t).length - 1;
      score += n * 3 + d * 2 + b;
      if (firstAt < 0 && b > 0) firstAt = body.indexOf(t);
    }
    if (score === 0) continue;
    const snippet = firstAt >= 0
      ? text.slice(Math.max(0, firstAt - 60), firstAt + 120).replace(/\s+/g, " ").trim()
      : s.description;
    hits.push({ name: s.name, description: s.description, score, snippet: `…${snippet}…` });
  }
  return hits.sort((a, b) => b.score - a.score);
}
