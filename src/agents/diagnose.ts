// Перевод ошибок агентов в понятное действие.
//
// Агенты сообщают о своих бедах по-своему и по-английски: «invalid model
// format», «Please log in», «hook dispatch failed». Пользователю нужно не
// это, а что нажать дальше. Здесь живёт сопоставление «текст ошибки → что
// сделать», общее для всех агентов и всех режимов.
export interface Diagnosis { reason: string; fix: string }

interface Rule { test: RegExp; reason: (label: string) => string; fix: (label: string, id: string) => string }

const RULES: Rule[] = [
  {
    // cline: провайдер авторизован, но модель не выбрана → любой запуск падает
    test: /invalid model format|expected format:\s*modeltype\/model|model .*not (found|configured)|no model (selected|configured)/i,
    reason: (l) => `${l} не настроил модель`,
    fix: (_l, id) => `Выберите модель в самом агенте: выполните «${id} auth» в терминале (режим «Терминал (TUI)») и укажите провайдера и модель`,
  },
  {
    test: /please (log ?in|authenticate)|authentication (failed|required)|not (logged in|authenticated)|unauthorized|401|need to sign ?in|sign ?in to (use|continue)|no .{0,20}authentication found|run: \w+ auth/i,
    reason: (l) => `${l} требует входа в аккаунт`,
    fix: (_l, id) => `Нажмите «Войти один раз» в диалоге новой сессии либо выполните «${id} auth login» в терминале`,
  },
  {
    test: /api key|apikey|no credentials|missing key/i,
    reason: (l) => `${l} не получил ключ доступа`,
    fix: () => "Настройки → Агенты → ключи: задайте ключ этого агента",
  },
  {
    // OpenRouter и подобные: «requires more credits … can only afford 5209»
    test: /requires more credits|can only afford|out of credits|insufficient credits|credit balance|payment required|402/i,
    reason: (l) => `У провайдера модели ${l} кончились кредиты`,
    fix: () => "Пополните баланс у провайдера (ссылка в журнале) или выберите бесплатную модель в поле «Модель»",
  },
  {
    test: /quota|rate ?limit|too many requests|429|insufficient (credit|balance)/i,
    reason: (l) => `${l} упёрся в лимит провайдера`,
    fix: () => "Подождите или смените модель/провайдера в настройках агента",
  },
  {
    test: /hook dispatch failed|hook event payload/i,
    reason: (l) => `${l} жалуется на свои хуки`,
    fix: () => "Проверьте каталог хуков агента (~/.cline/hooks и подобные) — сломанный хук мешает запуску",
  },
  {
    test: /ENOENT|command not found|no such file/i,
    reason: (l) => `${l} не нашёл нужный файл или команду`,
    fix: () => "Проверьте установку агента: Настройки → Агенты",
  },
  {
    test: /workspace trust|untrusted workspace/i,
    reason: (l) => `${l} не доверяет этой папке`,
    fix: () => "Откройте проект в доверенной папке либо подтвердите доверие в режиме «Терминал (TUI)»",
  },
];

/**
 * Разобрать вывод агента. Возвращает null, если ничего знакомого не нашлось —
 * тогда показываем исходный текст, не выдумывая объяснений.
 */
export function diagnose(text: string, agentLabel: string, agentId: string): Diagnosis | null {
  const clean = text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
  for (const r of RULES) {
    if (r.test.test(clean)) return { reason: r.reason(agentLabel), fix: r.fix(agentLabel, agentId) };
  }
  return null;
}
