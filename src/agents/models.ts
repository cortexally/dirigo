// Реальный список моделей — у самого агента, а не из копии в нашем коде.
//
// Держать список в реестре нельзя: у kilo их больше трёхсот, у opencode
// десяток, и состав зависит от аккаунта и тарифа. Любая зашитая копия
// протухает и показывает пользователю модели, которых у него нет.
// Поэтому спрашиваем агента его же командой и кэшируем ответ.
import { getAgent } from "./registry";
import { secretsEnv } from "../secrets";

export interface ModelList {
  /** откуда взяты: запрос к агенту, реестр или ничего */
  source: "agent" | "registry" | "none";
  models: string[];
  /** агент отказался — обычно нужен вход в аккаунт */
  error?: string;
  /** когда список получен (мс) */
  at: number;
}

const CACHE = new Map<string, ModelList>();
const TTL_MS = Number(process.env.DIRIGO_MODELS_TTL_MS ?? 10 * 60_000);
const TIMEOUT_MS = Number(process.env.DIRIGO_MODELS_TIMEOUT_MS ?? 25_000);

/** Сбросить кэш (после входа в аккаунт список обычно меняется). */
export function invalidateModels(agentId?: string): void {
  if (agentId) CACHE.delete(agentId); else CACHE.clear();
}

export async function listModels(agentId: string, force = false): Promise<ModelList> {
  const def = getAgent(agentId);
  if (!def) return { source: "none", models: [], at: Date.now() };

  const cached = CACHE.get(agentId);
  if (!force && cached && Date.now() - cached.at < TTL_MS) return cached;

  // Нет команды списка — отдаём то, что объявлено в реестре (может быть пусто).
  if (!def.modelsCommand?.length || def.modelsCommand.includes("__dirigo_missing__")) {
    const out: ModelList = { source: def.models?.length ? "registry" : "none", models: def.models ?? [], at: Date.now() };
    CACHE.set(agentId, out);
    return out;
  }

  try {
    const proc = Bun.spawn(def.modelsCommand, { stdout: "pipe", stderr: "pipe", stdin: "ignore", env: secretsEnv() });
    const killer = setTimeout(() => { try { proc.kill(); } catch { /* уже мёртв */ } }, TIMEOUT_MS);
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(killer);

    const models = parseModelLines(stdout);
    if (code !== 0 || !models.length) {
      // Частый случай: «Authentication required» — это не поломка, а состояние.
      const why = firstMeaningfulLine(stderr) ?? firstMeaningfulLine(stdout) ?? `команда вернула код ${code}`;
      const out: ModelList = {
        source: def.models?.length ? "registry" : "none",
        models: def.models ?? [],
        error: why,
        at: Date.now(),
      };
      CACHE.set(agentId, out);
      return out;
    }
    const out: ModelList = { source: "agent", models, at: Date.now() };
    CACHE.set(agentId, out);
    return out;
  } catch (e) {
    const out: ModelList = {
      source: def.models?.length ? "registry" : "none",
      models: def.models ?? [],
      error: String(e).slice(0, 180),
      at: Date.now(),
    };
    CACHE.set(agentId, out);
    return out;
  }
}

/** Строки вывода → идентификаторы моделей (без баннеров и логов агента). */
export function parseModelLines(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    const clean = raw.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\r$/, "");
    // Таблица «  <id>   <название>  [цены]» (devin models list: модели по
    // семействам с отступом). Раньше такая строка отбрасывалась целиком, и
    // в диалоге вместо 55 моделей была «ошибка» «Available models (55 families)».
    const row = /^\s{2,}([\w][\w./:@+-]*)\s{2,}\S/.exec(clean);
    if (row && !/^\s*aliases:/i.test(clean)) { out.push(row[1]!); continue; }
    const line = clean.trim();
    if (!line || line.length > 120) continue;
    // Баннеры, логи и заголовки в список моделей не попадают.
    if (/^(INFO|WARN|ERROR|DEBUG)\b/i.test(line)) continue;
    if (/\s{2,}/.test(line)) continue;
    if (!/^[\w][\w./:@+-]*$/.test(line)) continue;
    if (!line.includes("/") && !line.includes("-") && !line.includes(".")) continue;
    out.push(line);
  }
  return [...new Set(out)];
}

function firstMeaningfulLine(text: string): string | undefined {
  for (const raw of text.split("\n")) {
    const l = raw.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").trim();
    if (l && !/^(INFO|DEBUG)\b/i.test(l)) return l.slice(0, 180);
  }
  return undefined;
}
