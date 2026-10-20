// Dirigo — что РЕАЛЬНО можно запустить прямо сейчас.
//
// Правило продукта: интерфейс не предлагает того, что не сработает. Если режим
// недоступен, пользователь видит это до клика и вместе с причиной и способом
// починить — а не «Error» в карточке сессии и догадки в логе.
//
// Единый источник правды: этим пользуется и /api/agents (для UI), и проверка
// перед созданием сессии (чтобы мёртвая сессия вообще не появлялась).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AGENTS, getAgent, expand as expandVars, type AgentDef } from "./registry";

export type ModeId = "cli" | "web" | "persistent" | "pty";

export interface ModeAvailability {
  mode: ModeId;
  label: string;
  /** Чем этот режим отличается от остальных (подсказка в интерфейсе). */
  about?: string;
  available: boolean;
  /** Запустить можно, но агент почти наверняка откажется — например, не задан
   *  ключ и не выполнен вход. Блокировать нельзя (ключ может прийти из
   *  окружения), но и молчать нельзя: иначе сессия падает «непонятно почему». */
  warn?: string;
  /** почему нельзя — человеческим языком */
  reason?: string;
  /** что сделать, чтобы стало можно */
  fix?: string;
}

export interface AgentAuthState {
  /** известно ли вообще, как проверять вход у этого агента */
  known: boolean;
  signedIn: boolean;
  /** почта/имя аккаунта, если агент их хранит */
  account?: string;
  hint?: string;
  /** можно ли войти прямо из пульта (у агента есть команда входа) */
  canLogin: boolean;
}

export interface AgentAvailability {
  id: string;
  label: string;
  installed: boolean;
  path?: string;
  reason?: string;
  fix?: string;
  modes: ModeAvailability[];
  /** есть ли хоть один рабочий режим */
  usable: boolean;
  /** состояние входа в аккаунт агента */
  auth: AgentAuthState;
}

/**
 * Выполнен ли вход в аккаунт агента.
 *
 * Проверяется по файлу учётных данных — его наличие означает, что агент уже
 * авторизован и новые сессии не станут просить вход. Это нужно знать ДО
 * запуска: без входа каждая сессия TUI рисует свой код авторизации, коды
 * конкурируют между собой, и все отваливаются с «Login timed out».
 */
export function authState(def: AgentDef): AgentAuthState {
  if (!def.auth) return { known: false, signedIn: false, canLogin: false };
  const canLogin = !!def.auth.loginArgs?.length;
  // 1) Ответ самого агента (statusCommand) — точнее файла: у opencode 2.x
  //    учётки в SQLite, файла auth.json нет вовсе. Команда медленная, поэтому
  //    ответ кешируется и обновляется в фоне; пока его нет — смотрим файл.
  if (def.auth.statusCommand?.length) {
    const st = statusCache.get(def.id);
    if (!st || Date.now() - st.at > AUTH_TTL_MS) void refreshAuthStatus(def);
    if (st?.ok) {
      return st.signedIn
        ? { known: true, signedIn: true, account: st.account, canLogin }
        : fileAuth(def, canLogin).signedIn ? fileAuth(def, canLogin) : { known: true, signedIn: false, hint: def.auth.hint, canLogin };
    }
  }
  return fileAuth(def, canLogin);
}

/** Вход по файлу учётных данных: первый существующий из кандидатов. */
function fileAuth(def: AgentDef, canLogin: boolean): AgentAuthState {
  const files = (Array.isArray(def.auth!.credentialsFile) ? def.auth!.credentialsFile : [def.auth!.credentialsFile]).map(expandHome);
  const file = files.find((f) => !f.includes("%") && existsSync(f));
  if (!file) return { known: true, signedIn: false, hint: def.auth!.hint, canLogin };
  let account: string | undefined;
  if (/\.json$/i.test(file)) {
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
      const at = (path: string) => path.split(".").reduce<any>((acc, k) => (acc == null ? acc : acc[k]), raw);
      // Файл бывает, а входа нет (пустой список провайдеров после logout).
      if (def.auth!.signedInPath) {
        const v = at(def.auth!.signedInPath);
        const empty = v == null || v === "" || (typeof v === "object" && !Object.keys(v).length);
        if (empty) return { known: true, signedIn: false, hint: def.auth!.hint, canLogin };
      }
      if (def.auth!.accountPath) {
        const a = at(def.auth!.accountPath);
        account = typeof a === "string" ? a : undefined;
      }
    } catch { /* файл есть, но нечитаем — вход считаем выполненным */ }
  }
  return { known: true, signedIn: true, account, canLogin };
}

/* ── ответы statusCommand: кеш + фоновое обновление ── */
const AUTH_TTL_MS = 60_000;
const statusCache = new Map<string, { at: number; ok: boolean; signedIn: boolean; account?: string }>();
const statusInFlight = new Map<string, Promise<void>>();

/** Спросить агента «вошёл ли я». Ошибка/таймаут — ответа нет, решает файл. */
export function refreshAuthStatus(def: AgentDef): Promise<void> {
  const cmd = def.auth?.statusCommand;
  if (!cmd?.length || !commandResolvable(cmd).ok) return Promise.resolve();
  const running = statusInFlight.get(def.id);
  if (running) return running;
  const p = (async () => {
    try {
      const proc = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, NO_COLOR: "1" } });
      const timer = setTimeout(() => { try { proc.kill(); } catch { /* */ } }, 20_000);
      const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      await proc.exited;
      clearTimeout(timer);
      // ESC-коды и рамки псевдографики не мешают поиску слов
      const text = (out + "\n" + err).replace(/\x1b\[[0-9;]*m/g, "");
      const signedIn = new RegExp(def.auth!.signedInPattern ?? "logged in", "im").test(text);
      const m = def.auth!.accountPattern ? new RegExp(def.auth!.accountPattern, "im").exec(text) : null;
      statusCache.set(def.id, { at: Date.now(), ok: true, signedIn, account: m?.[1] });
    } catch {
      statusCache.set(def.id, { at: Date.now(), ok: false, signedIn: false });
    } finally {
      statusInFlight.delete(def.id);
    }
  })();
  statusInFlight.set(def.id, p);
  return p;
}

/** После сессии входа — сразу перепроверить, не дожидаясь TTL. */
export async function refreshAuthFor(agentId: string): Promise<void> {
  const def = getAgent(agentId);
  if (def) { statusCache.delete(def.id); await refreshAuthStatus(def); }
}

/** Первичный опрос при старте демона: к первому открытию пульта ответ уже есть. */
export function warmAuthStatus(): void {
  for (const def of AGENTS) if (def.auth?.statusCommand?.length) void refreshAuthStatus(def);
}

function expandHome(p: string): string {
  const e = expandVars(p);
  return e.startsWith("~") ? join(process.env.HOME ?? process.env.USERPROFILE ?? "", e.slice(1)) : e;
}

const MISSING_MARK = "__dirigo_missing__";

/** Разрешается ли эта команда в реальный исполняемый файл. */
export function commandResolvable(command?: string[]): { ok: boolean; path?: string } {
  if (!command?.length) return { ok: false };
  // Маркер может стоять не первым аргументом: npm-агент запускается как
  // [node, <путь к скрипту>], и не хватает именно скрипта.
  if (command.some((part) => part === MISSING_MARK)) return { ok: false };
  const first = command[0]!;
  if (!first) return { ok: false };
  // абсолютный путь — проверяем файл; иначе ищем в PATH
  if (first.includes("/") || first.includes("\\")) {
    if (!existsSync(first)) return { ok: false };
    // [node.exe, <скрипт пакета>]: интерпретатор есть, а пакет могли удалить
    const script = command[1];
    if (script && /\.[cm]?js$|[\\/]bin[\\/][\w.-]+$/i.test(script) && (script.includes("/") || script.includes("\\")) && !existsSync(script)) return { ok: false };
    return { ok: true, path: first };
  }
  const viaPath = Bun.which(first);
  if (!viaPath) return { ok: false };
  // [node, script.js]: сам интерпретатор есть всегда — проверять надо скрипт.
  const script = command[1];
  if (script && (script.includes("/") || script.includes("\\")) && !existsSync(script)) return { ok: false };
  return { ok: true, path: viaPath };
}

const INSTALL_HINT = "Настройки → Агенты → поставить недостающее";

/**
 * Чем режимы отличаются друг от друга — одним абзацем на каждый.
 * Текст висит подсказкой у выбора режима: четыре способа запуска выглядят
 * похоже, и без объяснения непонятно, какой когда брать.
 */
export const MODE_ABOUT: Record<ModeId, string> = {
  cli: "Разовая задача: агент получает текст, работает без вопросов и возвращает результат. Вмешаться по ходу нельзя. Подходит для простых и повторяемых задач.",
  persistent: "Живое соединение по протоколу ACP: агент отвечает структурированно, пульт показывает ход работы своим интерфейсом и держит контекст между сообщениями. Доступно там, где агент умеет ACP.",
  pty: "Полноценный терминал агента прямо в пульте: его родной интерфейс, подтверждения и подсказки. Максимум контроля — обычно это основной способ.",
  web: "Собственная веб-панель агента. Локальная открывается прямо здесь, во встроенном окне; если у агента только сайт — откроется отдельной вкладкой.",
};

function modeFor(def: AgentDef, mode: ModeId, ptyOk: boolean): ModeAvailability {
  switch (mode) {
    case "cli": {
      if (def.kind !== "cli") {
        return { mode, label: "Задача (CLI)", available: false, reason: `${def.label} не умеет разовые задачи из командной строки`, fix: "Выберите другой режим или другого агента" };
      }
      if (def.cliInteractiveOnly) {
        return {
          mode, label: "Задача (CLI)", available: false,
          reason: `${def.label} работает только интерактивно — разового запуска задачи у него нет`,
          fix: "Выберите режим «Терминал (TUI)»",
        };
      }
      const r = commandResolvable(def.command);
      return r.ok
        ? { mode, label: "Задача (CLI)", available: true }
        : { mode, label: "Задача (CLI)", available: false, reason: `${def.label} не установлен на этой машине`, fix: INSTALL_HINT };
    }
    case "web": {
      if (!def.web) {
        return { mode, label: "Веб-панель", available: false, reason: `У ${def.label} нет веб-интерфейса`, fix: "Используйте режим «Задача (CLI)»" };
      }
      if (def.web.externalOnly) {
        return { mode, label: "Веб-панель (сайт агента)", available: true };
      }
      const r = commandResolvable(def.web.command?.length ? def.web.command : def.command);
      return r.ok
        ? { mode, label: "Веб-панель", available: true }
        : { mode, label: "Веб-панель", available: false, reason: `${def.label} не установлен — веб-панель поднимать нечем`, fix: INSTALL_HINT };
    }
    case "persistent": {
      if (!def.acp) {
        return { mode, label: "Живой диалог (ACP)", available: false, reason: `${def.label} не говорит по ACP`, fix: "Используйте «Задача (CLI)» или «Веб-панель»" };
      }
      const r = commandResolvable(def.acp.command);
      return r.ok
        ? { mode, label: "Живой диалог (ACP)", available: true }
        : {
            mode, label: "Живой диалог (ACP)", available: false,
            reason: `ACP-мост для ${def.label} не установлен`,
            fix: def.id === "claude-code"
              ? "Настройки → Агенты → «Claude Code — мост ACP» → установить"
              : INSTALL_HINT,
          };
    }
    case "pty": {
      if (!def.ptyCommand) {
        return { mode, label: "Терминал (TUI)", available: false, reason: `У ${def.label} нет интерактивного терминального режима`, fix: "Используйте «Задача (CLI)»" };
      }
      if (!ptyOk) {
        return {
          mode, label: "Терминал (TUI)", available: false,
          reason: "На этой машине не собран нативный модуль node-pty",
          fix: "bun install в каталоге установки (нужны python3, make, g++/clang)",
        };
      }
      const r = commandResolvable(def.ptyCommand.command);
      return r.ok
        ? { mode, label: "Терминал (TUI)", available: true }
        : { mode, label: "Терминал (TUI)", available: false, reason: `${def.label} не установлен`, fix: INSTALL_HINT };
    }
  }
}

const ALL_MODES: ModeId[] = ["cli", "web", "persistent", "pty"];

/**
 * Есть ли у агента чем авторизоваться: вход в аккаунт или ключ в окружении.
 * Пустой ответ — не запрет, а предупреждение: ключ мог прийти из профиля ОС.
 */
function credentialWarning(def: AgentDef, auth: AgentAuthState, ctx: CredentialCtx): string | undefined {
  if (auth.known && auth.signedIn) return undefined;
  const envVar = ctx.envVars.get(def.id);
  if (!envVar) return auth.known && !auth.signedIn ? `Вход в ${def.label} не выполнен` : undefined;
  if (process.env[envVar] || ctx.hasSecret(envVar)) return undefined;
  return `Не задан ключ ${envVar}${auth.known ? " и не выполнен вход" : ""} — агент, скорее всего, откажется работать`;
}

interface CredentialCtx { envVars: Map<string, string>; hasSecret: (k: string) => boolean; }

/** Собираем источники учётных данных один раз на вызов (а не на агента). */
async function credentialCtx(): Promise<CredentialCtx> {
  const envVars = new Map<string, string>();
  try {
    const { RECIPES } = await import("../setup/recipes");
    for (const r of RECIPES) if (r.envVar) envVars.set(r.id, r.envVar);
  } catch { /* рецепты недоступны — обойдёмся без подсказки про ключ */ }
  let hasSecret: (k: string) => boolean = () => false;
  try { ({ hasSecret } = await import("../secrets")); } catch { /* хранилище секретов не поднято */ }
  return { envVars, hasSecret };
}

export async function agentAvailability(id: string): Promise<AgentAvailability | null> {
  const def = getAgent(id);
  if (!def) return null;
  const { ptyStatus } = await import("./pty");
  const pty = await ptyStatus();
  const base = commandResolvable(def.command);
  const auth = authState(def);
  const warn = credentialWarning(def, auth, await credentialCtx());
  const modes = ALL_MODES.map((m) => withWarning(modeFor(def, m, pty.available), m, warn));
  const usable = modes.some((m) => m.available);
  return {
    id: def.id,
    label: def.label,
    installed: base.ok,
    path: base.path,
    reason: base.ok ? undefined : `${def.label} не найден ни в PATH, ни в типовых местах установки`,
    fix: base.ok ? undefined : INSTALL_HINT,
    modes,
    usable,
    auth,
  };
}

/** Веб-ссылка на сайт агента ключа не требует — там предупреждение неуместно. */
function withWarning(m: ModeAvailability, mode: ModeId, warn?: string): ModeAvailability {
  const withAbout = { ...m, about: MODE_ABOUT[mode] };
  if (!warn || !m.available || mode === "web") return withAbout;
  return { ...withAbout, warn };
}

export async function allAvailability(): Promise<AgentAvailability[]> {
  const { ptyStatus } = await import("./pty");
  const pty = await ptyStatus();
  const ctx = await credentialCtx();
  return AGENTS.map((def) => {
    const base = commandResolvable(def.command);
    const auth = authState(def);
    const warn = credentialWarning(def, auth, ctx);
    const modes = ALL_MODES.map((m) => withWarning(modeFor(def, m, pty.available), m, warn));
    return {
      id: def.id,
      label: def.label,
      installed: base.ok,
      path: base.path,
      reason: base.ok ? undefined : `${def.label} не найден ни в PATH, ни в типовых местах установки`,
      fix: base.ok ? undefined : INSTALL_HINT,
      modes,
      usable: modes.some((m) => m.available),
      auth,
    };
  });
}

/** Проверка перед запуском: можно ли вообще стартовать эту пару агент+режим. */
export async function canStart(agentId: string, mode: ModeId): Promise<ModeAvailability & { agentLabel: string }> {
  const a = await agentAvailability(agentId);
  if (!a) {
    return { mode, label: mode, available: false, reason: `Агент «${agentId}» не найден в реестре`, fix: "Выберите агента из списка", agentLabel: agentId };
  }
  const m = a.modes.find((x) => x.mode === mode)!;
  return { ...m, agentLabel: a.label };
}
