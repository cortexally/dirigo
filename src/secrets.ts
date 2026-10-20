// Dirigo — секреты/ключи провайдеров через UI (V4-2).
//
// Ключи НЕ в окружении демона (его трудно менять из UI), а в data/secrets.json
// (права 600 на unix; на windows — ACL по умолчанию пользователя). При спавне
// агента ключ инжектится в env процесса (ANTHROPIC_API_KEY и т.д.).
// Формат: { "<ENV_VAR>": "<value>", ... } — как в providers.json envVar.

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { uid } from "./store";

const DATA_DIR = (process.env.DIRIGO_DATA
  ? process.env.DIRIGO_DATA.replace(/[\\/]+$/, "") + "/"
  : new URL("../data/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const FILE = `${DATA_DIR}secrets.json`;

let cache: Record<string, string> = {};

export function loadSecrets(): void {
  cache = {};
  try {
    if (!existsSync(FILE)) return;
    const raw = JSON.parse(readFileSync(FILE, "utf8"));
    if (raw && typeof raw === "object") cache = raw as Record<string, string>;
  } catch { cache = {}; }
}

function persist(): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(FILE, JSON.stringify(cache, null, 2), "utf8");
    if (process.platform !== "win32") { try { chmodSync(FILE, 0o600); } catch { /* нет прав — не критично */ } }
  } catch { /* диск недоступен */ }
}

/** Записать/обновить ключ. */
export function setSecret(envVar: string, value: string): void {
  const k = String(envVar ?? "").trim();
  if (!k) throw new Error("envVar обязателен");
  if (value === null || value === undefined || value === "") { delete cache[k]; persist(); return; }
  cache[k] = String(value);
  persist();
}

/** Удалить ключ. */
export function deleteSecret(envVar: string): void {
  delete cache[String(envVar ?? "").trim()];
  persist();
}

/** Задан ли ключ (без раскрытия значения). */
export function hasSecret(envVar: string): boolean {
  return !!cache[String(envVar ?? "").trim()];
}

/** Значение ключа (только для инъекции в env процессов). */
export function secretValue(envVar: string): string | undefined {
  return cache[String(envVar ?? "").trim()];
}

/** Маскированная сводка для API/UI. */
export function secretsSummary(): { envVar: string; set: boolean; masked: string }[] {
  return Object.keys(cache).sort().map((k) => ({
    envVar: k,
    set: true,
    masked: cache[k]!.length > 4 ? `${cache[k]!.slice(0, 2)}…${cache[k]!.slice(-2)} (${cache[k]!.length})` : "****",
  }));
}

/** Инъекция: env для дочерних процессов агентов. */
/**
 * Переменные, которые НЕ должны доезжать до запускаемого агента.
 *
 * Агенты защищаются от вложенного запуска: если Claude Code видит в окружении
 * CLAUDECODE, он отказывается стартовать («Claude Code cannot be launched
 * inside another Claude Code session»). Пульт — не агент, а супервизор, и
 * когда его самого запустили из агентской сессии, этот флаг наследовался и
 * ломал запуск: пользователь видел лишь «Internal error» от моста.
 */
const SUPERVISOR_ONLY_ENV = ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT"];

/**
 * Служебные переменные прогонов (префикс E2E_*) — агентам они не нужны.
 *
 * Наборы e2e читают их из своего окружения, а агент наследует окружение
 * демона — вместе с настройками чужого набора. Наблюдалось вживую: агентская
 * сессия унаследовала E2E_CLI_SKIP_AGENT=1 от соседнего прогона, и набор,
 * запущенный изнутри неё, тихо пропустил запуск агента — «19/19 зелёных», а
 * агент не поднимался (проверка вырождается в пустую). Набор читает свои
 * переменные из своего окружения; если он запущен из агентской сессии, это
 * должно быть его собственное окружение, а не чужое.
 *
 * Отбрасываем по префиксу, а не списком: новые E2E_* не должны снова утекать
 * к агенту.
 */
const POOL_ENV_PREFIX = "E2E_";

export function secretsEnv(cwd?: string): Record<string, string> {
  const env = { ...process.env, ...cache } as Record<string, string>;
  for (const key of SUPERVISOR_ONLY_ENV) delete env[key];
  for (const key of Object.keys(env)) if (key.startsWith(POOL_ENV_PREFIX)) delete env[key];
  // PWD — папка агента, а не демона. Агенты на Bun/Node (kilo, opencode) берут
  // рабочую папку из PWD: с унаследованным PWD демона kilo писал файлы в
  // каталог, откуда запущен пульт, а не в копию сессии.
  if (cwd) env.PWD = cwd;
  return env;
}

/** Одноразовый токен для QR-ссылок (если понадобится). */
export function newPairToken(): string { return uid("pair"); }
