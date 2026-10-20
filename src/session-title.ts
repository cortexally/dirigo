// Dirigo — заголовок сессии в сайдбаре и табах.

/**
 * Заголовок сессии. Раньше живой диалог и терминал назывались по проекту
 * («ACP — northwind-api [копия]»), и четыре сессии одного проекта в списке
 * были неотличимы. Теперь — по задаче; проект и так виден группой в сайдбаре.
 */
export function sessionTitleFor(
  mode: string, def: { label: string; web?: { label: string }; ptyCommand?: { label: string } },
  projectName: string, prompt: string, login: boolean, explicit?: unknown,
): string {
  const task = String(prompt ?? "").split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
  const short = task.replace(/\s+/g, " ").length > 60 ? task.replace(/\s+/g, " ").slice(0, 59).trimEnd() + "…" : task.replace(/\s+/g, " ");
  if (mode === "web") return `${def.web?.label ?? def.label} — ${projectName}`;
  if (mode === "persistent") return `ACP — ${short || projectName}`;
  if (mode === "pty") return login ? `Вход в ${def.label}` : `${def.ptyCommand?.label ?? def.label} — ${short || projectName}`;
  return String(explicit ?? prompt).slice(0, 80);
}
