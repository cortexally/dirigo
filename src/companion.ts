// Dirigo v1 (v1.5) — Компаньон: бэкенд диалогового помощника (F-V6-2, FBA).
//
// Настройки (роль/тон/модель) и лог диалога живут в store (db.companion).
// Ответ генерируется через провайдера из providers.json (openai-compatible —
// chat/completions; anthropic-compatible — /v1/messages), ключ — из
// data/secrets.json (data/secrets; ключ в env демона не обязателен).
// Прозрачность источник (source): "llm" (провайдер отвыетл) | "local"
// (честный офлайн-фолбэк — если ключа нет/провайдер недоступен, мы не выдаем
// ответ модели за LLM, а описываем состояние в форме ответа компаньона).

import { readFileSync } from "node:fs";
import { companion, type CompanionSettings } from "./store";
import { hasSecret, secretValue } from "./secrets";

export type { CompanionSettings };

const PROVIDERS_FILE = new URL("../providers.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

interface ProviderDef {
  id: string;
  label: string;
  baseUrl: string;
  api: "openai-compatible" | "anthropic-compatible";
  envVar: string;
  models: string[];
  notes?: string;
}

const LOCAL_HOST_RE = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/;
const TIMEOUT_MS = 20_000;

const ROLE_PROMPTS: Record<string, string> = {
  assistant: "Помогай пользователю ориентироваться в Dirigo: сессиях, агентах, задачах и следующих шагах.",
  reviewer: "Будь ревьюером: указывай риски, дефекты и конкретные способы исправления, не хвали ради похвалы.",
  planner: "Будь планировщиком: разбивай задачу на конкретные шаги, отмечай зависимости и риски.",
  tutor: "Будь наставником: объясняй простым языком, задавая уточняющие вопросы, если данных мало.",
};

const TONE_PROMPTS: Record<string, string> = {
  neutral: "",
  friendly: "Тон — дружелюбный, обращение на «ты».",
  formal: "Тон — деловой и формальный, обращение на «вы».",
  concise: "Отвечай максимально кратко: 1–3 предложения.",
};

function loadProviders(): ProviderDef[] {
  try {
    const raw = JSON.parse(readFileSync(PROVIDERS_FILE, "utf8")) as { providers?: ProviderDef[] };
    return Array.isArray(raw.providers) ? raw.providers : [];
  } catch {
    return [];
  }
}

/** Список провайдеров для UI (ключ маскируется факт-флагом keySet). */
export function companionProviders(): { id: string; label: string; models: string[]; keySet: boolean; local: boolean }[] {
  return loadProviders().map((p) => ({
    id: p.id,
    label: p.label,
    models: p.models ?? [],
    keySet: !p.envVar || hasSecret(p.envVar),
    local: LOCAL_HOST_RE.test(p.baseUrl ?? ""),
  }));
}

function findProvider(model: string): ProviderDef | undefined {
  const providers = loadProviders();
  for (const p of providers) {
    for (const m of p.models ?? []) {
      if (m === model || model.startsWith(`${m}:`)) return p;
    }
  }
  // модель не из реестра — подберём провайдера по префиксу id
  for (const p of providers) {
    if (model.startsWith(`${p.id}/`)) return p;
  }
  return undefined;
}

function stripProviderPrefix(model: string, p: ProviderDef): string {
  // для openrouter "openrouter/auto" — валидное имя модели у самой OpenRouter;
  // ollama (local/qwen2.5-coder) и opencode-zen ждут суффикс.
  if (p.id === "openrouter") return model;
  return model.startsWith(`${p.id}/`) ? model.slice(p.id.length + 1) : model;
}

/** История диалога в формате сообщений провайдера / запроса. */
function buildExchange(state: ReturnType<typeof companion.state>, userText: string): { system: string; history: { role: "user" | "assistant"; content: string }[] } {
  const s = state.settings;
  const system = [`Ты — Компаньон пульта Dirigo. ${ROLE_PROMPTS[s.role] ?? ""} ${TONE_PROMPTS[s.tone] ?? ""}`.trim(),
    "Dirigo — локальный пульт управления агентами-программистами (сессии, диффы, очередь, проверки)."].join(" ");
  const history = state.messages.slice(-12).map((m) => ({ role: m.role === "user" ? "user" : "assistant", content: m.text }));
  history.push({ role: "user", content: userText });
  return { system, history };
}

async function callOpenAiCompatible(p: ProviderDef, model: string, ex: { system: string; history: { role: string; content: string }[] }, key?: string): Promise<string> {
  const res = await fetch(`${p.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify({
      model: stripProviderPrefix(model, p),
      messages: [{ role: "system", content: ex.system }, ...ex.history],
      max_tokens: 1024,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return (data.choices?.[0]?.message?.content ?? "").trim();
}

async function callAnthropicCompatible(p: ProviderDef, model: string, ex: { system: string; history: { role: string; content: string }[] }, key?: string): Promise<string> {
  const res = await fetch(`${p.baseUrl.replace(/\/$/, "")}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(key ? { "x-api-key": key } : {}),
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: stripProviderPrefix(model, p),
      system: ex.system,
      messages: ex.history,
      max_tokens: 1024,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { content?: { type: string; text?: string }[] };
  return (data.content?.map((c) => (c.type === "text" ? c.text ?? "" : "")).join("").trim() ?? "");
}

/** Офлайн-фолбэк: честный ответ без LLM — настройки + эхо запроса + что сделать, чтобы включить LLM. */
function localReply(settings: CompanionSettings, userText: string, reason: string): string {
  const lines = [
    `(локальный режим) Я Компаньон пульта Dirigo — ещё без модели LLM, отвечаю локально.`,
    ``,
    `Настройки — роль «${settings.role}», тон «${settings.tone}», модель «${settings.model}».`,
    `Причина: ${reason}.`,
  ];
  return lines.join("\n");
}

/**
 * Ответ компаньона на текст пользователя. Пишет в лог обе записи
 * (вопрос пользователя → ответ компаньона). Возвращает ответ.
 */
export async function companionReply(userText: string): Promise<{ reply: string; source: "llm" | "local" }> {
  const text = String(userText ?? "").trim().slice(0, 4000);
  if (!text) throw new Error("пустое сообщение");
  const state = companion.state();
  const settings = state.settings;
  const provider = findProvider(settings.model);
  const key = provider?.envVar ? secretValue(provider.envVar) : undefined;
  const needKey = !!provider?.envVar;

  let reason = "";
  if (provider && (!needKey || key)) {
    try {
      const ex = buildExchange(state, text);
      const reply = provider.api === "anthropic-compatible"
        ? await callAnthropicCompatible(provider, settings.model, ex, key)
        : await callOpenAiCompatible(provider, settings.model, ex, key);
      if (reply) {
        await companion.addMessage("user", userText);
        await companion.addMessage("companion", reply, "llm");
        return { reply, source: "llm" };
      }
      reason = `провайдер «${provider.label}» вернул пустой ответ`;
    } catch (e) {
      reason = `провайдер «${provider.label}» недоступен (${String(e)})`;
    }
  } else if (provider) {
    reason = `ключ ${provider.envVar} не задан (Настройки → Провайдеры)`;
  } else {
    reason = `модель «${settings.model}» не найдена в providers.json`;
  }

  const reply = localReply(settings, text, reason);
  await companion.addMessage("user", userText);
  await companion.addMessage("companion", reply, "local");
  return { reply, source: "local" };
}

/** Полные данные для GET /api/companion. */
export function companionInfo() {
  const state = companion.state();
  return {
    ...state,
    roles: Object.keys(ROLE_PROMPTS),
    tones: Object.keys(TONE_PROMPTS),
    providers: companionProviders(),
  };
}
