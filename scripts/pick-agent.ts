// Выбор агента для автотестов по РЕАЛЬНОЙ доступности режима на этой машине.
//
// Раньше сценарии жёстко называли агента ("cursor", "devin", "hermes"). Пока
// пульт создавал сессию любому агенту, это работало; теперь недоступный режим
// корректно отклоняется ещё до создания сессии, и такой тест проверял бы не
// продукт, а состав установленного софта. Берём первого, кто реально умеет
// нужный режим, и честно сообщаем, если не умеет никто.
export type ModeId = "cli" | "web" | "persistent" | "pty";

export async function pickAgent(base: string, mode: ModeId): Promise<string | null> {
  const r = await fetch(`${base}/api/agents`);
  if (!r.ok) return null;
  const list = await r.json() as any[];
  const ok = list.find((a) => (a.availability?.modes ?? []).some((m: any) => m.mode === mode && m.available));
  return ok?.id ?? null;
}

/** Агент, у которого нужного режима ТОЧНО нет — для проверок отказа. */
export async function pickUnavailableAgent(base: string, mode: ModeId): Promise<string | null> {
  const r = await fetch(`${base}/api/agents`);
  if (!r.ok) return null;
  const list = await r.json() as any[];
  const bad = list.find((a) => (a.availability?.modes ?? []).some((m: any) => m.mode === mode && !m.available));
  return bad?.id ?? null;
}
