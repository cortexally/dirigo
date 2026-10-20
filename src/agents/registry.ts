// Dirigo — реестр агентов
// kind: "cli" — запускается как процесс с неинтерактивным промптом
// kind: "desktop" — только GUI-приложение (кнопка «открыть», статус по процессу)
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface AgentDef {
  id: string;
  label: string;
  kind: "cli" | "desktop";
  /** полный argv запуска (обёртки cmd/powershell включены) */
  command: string[];
  /** шаблон аргументов; макросы {{prompt}} {{sessionId}} {{cwd}} {{model}} */
  argsTemplate: string[];
  /**
   * V5-13: агент не принимает промпт аргументом — пульт пишет его в stdin.
   * (freebuff 0.2.27: позиционный аргумент = «Allowed choices are login»)
   */
  stdinPrompt?: boolean;
  /** CLI агента — полноэкранный TUI: разовая задача в нём невозможна в принципе
   *  (freebuff). Режим «Задача (CLI)» для такого агента честно закрыт. */
  cliInteractiveOnly?: boolean;
  /** Команда смены модели ВНУТРИ агента (его TUI), если флага CLI нет.
   *  У freebuff это `/model`: список моделей живёт в самом агенте. */
  modelCommand?: string;
  /** Готовых пакетов нет — собирается из исходников. Ссылка на инструкцию. */
  buildFromSource?: string;
  /** Команда, печатающая РЕАЛЬНЫЙ список моделей агента (по одной в строке).
   *  Выдумывать список нельзя: у kilo их 333, у opencode 10, и зависят они от
   *  аккаунта. Поэтому спрашиваем сам агент, а не держим копию в коде. */
  modelsCommand?: string[];
  /** Как понять, выполнен ли вход в аккаунт агента, и как войти.
   *  Без этого пользователь запускает несколько сессий, каждая показывает свой
   *  код входа, коды конкурируют и все отваливаются с «Login timed out». */
  auth?: {
    /** файл(ы) с учётными данными (~ и %VAR% раскрываются) — первый найденный.
     *  Пути разные по ОС: devin на Windows держит их в %APPDATA%, hermes — в
     *  %LOCALAPPDATA%; проверка только unix-пути считала их «не вошедшими». */
    credentialsFile: string | string[];
    /** путь внутри JSON, который должен быть непустым (файл бывает и пустым) */
    signedInPath?: string;
    /** команда, честно отвечающая «вошёл ли» (у opencode 2.x учётки в SQLite) */
    statusCommand?: string[];
    /** регэксп по выводу statusCommand: совпал — вход выполнен */
    signedInPattern?: string;
    /** регэксп с группой: имя аккаунта из вывода statusCommand */
    accountPattern?: string;
    /** путь к имени аккаунта внутри JSON, точками: "default.email" */
    accountPath?: string;
    /** как войти: аргументы к команде агента (например ["login"]) */
    loginArgs?: string[];
    /** человеческая подсказка, если входа нет */
    hint: string;
  };
  /** флаг продолжения сессии агента; создаёт ли агент сессию по этому id */
  sessionFlag?: string;
  createsSession?: boolean;
  /** модель по умолчанию (если агент поддерживает) */
  defaultModel?: string;
  /** для desktop: путь к exe и имя процесса */
  desktopPath?: string;
  processName?: string;
  /** подсказка для UI */
  hint?: string;
  /** web-режим: запуск нативного веб-интерфейса агента */
  web?: WebModeDef;
  /** persistent-режим: ACP-сервер (JSON-RPC 2.0) поверх stdio — живое соединение */
  acp?: { command: string[]; defaultModel?: string };
  /** интерактивный режим через PTY: команда + аргументы (TUI/REPL с вводом) */
  ptyCommand?: {
    command: string[]; label: string; hint?: string;
    /** флаг модели, который принимает именно TUI (проверено запуском; у CLI он может быть другим) */
    modelFlag?: string;
    /** TUI принимает флаг рассуждений (def.reasoningFlag) */
    reasoning?: boolean;
  };
  /** V6: поддерживаемые модели агента (пусто — только дефолтная) */
  models?: string[];
  /** Уровни рассуждений (reasoning effort) — ровно те, что принимает флаг
   *  агента (сверено с `--help`). Пусто — агент сам решает, селект выключен. */
  reasoning?: string[];
  /** V6: флаг выбора модели в CLI (напр. --model) */
  modelFlag?: string;
  /** V6: флаг уровня рассуждений (напр. --reasoning-effort) */
  reasoningFlag?: string;
}

export interface WebModeDef {
  command: string[];
  /** флаг порта (напр. --port); если нет — порт фиксирован приложением */
  portArg?: string;
  /** флаг «не открывать браузер» */
  noOpenFlag?: string;
  /** флаг рабочей папки */
  workspaceArg?: string;
  /** лейбл на кнопке */
  label: string;
  /** подсказка */
  hint?: string;
  /** true — это релей (kilo remote): своё web-UI не поднимает, только синхронизация */
  relayOnly?: boolean;
  /** true — веб-интерфейса нет локально; открываем внешний URL */
  externalOnly?: boolean;
  /**
   * Префикс Basic-auth для автоподключения к панели агента.
   * UI получает ссылку `<url>?auth_token=base64("<user>:<password>")` —
   * opencode/kilocode web-ui читают этот параметр и сами настраивают соединение,
   * минуя экран с требованием pairing-ссылки.
   */
  authTokenUser?: string;
  /** путь к десктоп-приложению как «второй способ» запуска */
  launchApp?: string;
  /** внешний URL (для externalOnly или для релея — ссылка на кабинет) */
  externalUrl?: string;
}

const WIN = process.platform === "win32";
const MAC = process.platform === "darwin";
const HOME = process.env.HOME ?? process.env.USERPROFILE ?? "";

/**
 * Подстановка переменных окружения в шаблон пути. Понимает обе нотации —
 * %VAR% (Windows) и $VAR / ~ (Unix), чтобы одни и те же таблицы работали
 * на всех платформах.
 */
export function expand(p: string): string {
  return p
    .replace(/%([A-Za-z0-9_]+)%/g, (_, k) => process.env[k] ?? `%${k}%`)
    .replace(/\$([A-Za-z0-9_]+)/g, (_, k) => process.env[k] ?? `$${k}`)
    .replace(/^~(?=[\\/]|$)/, HOME);
}

/**
 * Кроссплатформенный резолв бинарника агента.
 * Порядок: PATH (Bun.which) → типовые места установки для текущей ОС.
 * Если не нашли — возвращаем первый кандидат (сессия честно упадёт
 * «не установлен», демон при этом жив).
 *
 * До v1.7 таблица путей была только Windows-ная (%LOCALAPPDATA%\...exe),
 * поэтому на Linux/macOS НИ ОДИН из «тяжёлых» агентов не находился, даже
 * если был установлен штатно (~/.kilo/bin/kilo и т.п.).
 */
/** Маркер «бинарник не найден» — сессия упадёт с внятной ошибкой, демон жив. */
const MISSING_PREFIX = ["__dirigo_missing__"];

function resolveBin(name: string | null, winPaths: string[], unixPaths: string[]): string {
  const viaPath = name ? Bun.which(name) : null;
  if (viaPath && !/\.ps1$/i.test(viaPath)) return viaPath;
  const list = (WIN ? winPaths : unixPaths).map(expand);
  const found = list.find((p) => p && !p.includes("%") && existsSync(p));
  if (found) return found;
  // Раньше здесь возвращался первый кандидат из таблицы — несуществующий путь,
  // неотличимый от настоящего. Из-за этого агент выглядел установленным, а
  // запуск падал с ENOENT уже после создания сессии. Теперь «нет» значит «нет».
  return MISSING_PREFIX[0]!;
}

/** Новейшая версия opencode-cli.exe из папок десктопа (переживает обновления). */
function resolveOpencodeExe(): string {
  if (!WIN) {
    // Unix: штатные места установки opencode + PATH.
    return resolveBin("opencode", [], [
      "$HOME/.opencode/bin/opencode",
      "$HOME/.cache/opencode/bin/opencode",
      "$HOME/.local/bin/opencode",
      "/usr/local/bin/opencode",
      "/opt/homebrew/bin/opencode",
    ]);
  }
  const root = expand("%APPDATA%\\ai.opencode.desktop\\cli");
  try {
    const latest = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^\d+(\.\d+)+$/.test(d.name))
      .map((d) => d.name)
      .sort((a, b) => {
        const pa = a.split(".").map(Number);
        const pb = b.split(".").map(Number);
        for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
          const d = (pb[i] ?? 0) - (pa[i] ?? 0);
          if (d) return d;
        }
        return 0;
      })[0];
    if (latest) return join(root, latest, "opencode-cli.exe");
  } catch { /* папки нет — падаём на шим */ }
  return expand("%USERPROFILE%\\.cache\\opencode\\bin\\opencode.cmd");
}

const EXE = {
  node: resolveBin("node", ["%USERPROFILE%\\scoop\\apps\\nodejs-lts\\current\\node.exe"], [
    "/usr/local/bin/node", "/usr/bin/node", "/opt/homebrew/bin/node", "$HOME/.local/bin/node",
  ]),
  kilo: resolveBin("kilo", ["%USERPROFILE%\\.kilo\\bin\\kilo.exe"], [
    "$HOME/.kilo/bin/kilo", "$HOME/.local/bin/kilo", "/usr/local/bin/kilo", "/opt/homebrew/bin/kilo",
  ]),
  /** мост ACP для Hermes ставится рядом с основным бинарём */
  hermesAcp: resolveBin("hermes-acp", [], ["$HOME/.local/bin/hermes-acp", "/usr/local/bin/hermes-acp"]),
  hermes: resolveBin("hermes", ["%LOCALAPPDATA%\\hermes\\bin\\hermes.exe"], [
    "$HOME/.hermes/bin/hermes", "$HOME/.local/bin/hermes", "/usr/local/bin/hermes", "/opt/homebrew/bin/hermes",
  ]),
  devin: resolveBin("devin", ["%LOCALAPPDATA%\\devin\\cli\\bin\\devin.exe"], [
    "$HOME/.devin/cli/bin/devin", "$HOME/.local/bin/devin", "/usr/local/bin/devin",
  ]),
  cursorAgent: resolveBin("cursor-agent", ["%LOCALAPPDATA%\\cursor-agent\\cursor-agent.ps1"], [
    "$HOME/.local/bin/cursor-agent", "/usr/local/bin/cursor-agent", "/opt/homebrew/bin/cursor-agent",
  ]),
  opencode: resolveOpencodeExe(),
  zcodeCli: resolveBin(null, ["%LOCALAPPDATA%\\Programs\\ZCode\\resources\\glm\\zcode.cjs"], [
    "$HOME/.zcode/resources/glm/zcode.cjs",
    "/opt/ZCode/resources/glm/zcode.cjs",
    "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs",
  ]),
  /** runtime-дистрибутив zcode (ставится install-скриптом: `zcode --web`) */
  zcodeRuntime: resolveBin(null, ["%USERPROFILE%\\.zcode\\runtime\\current\\bin\\zcode.mjs"], [
    "$HOME/.zcode/runtime/current/bin/zcode.mjs",
  ]),
  /** mcode — терминальный агент MiniMax Code (npm @minimax-ai/code).
   *  Сначала бинарь `mcode` из PATH: npm кладёт туда обёртку, и искать
   *  cli.js по списку каталогов нужно только если обёртки нет. */
  mcodeCli: resolveBin("mcode", ["%USERPROFILE%\\scoop\\apps\\nodejs-lts\\current\\bin\\node_modules\\@minimax-ai\\code\\cli.js"], [
    "$HOME/.bun/install/global/node_modules/@minimax-ai/code/cli.js",
    "/usr/local/lib/node_modules/@minimax-ai/code/cli.js",
    "/usr/lib/node_modules/@minimax-ai/code/cli.js",
    "$HOME/.npm-global/lib/node_modules/@minimax-ai/code/cli.js",
  ]),
  minimax: resolveBin(null, ["%LOCALAPPDATA%\\Programs\\MiniMax Code\\MiniMax Code.exe"], [
    "/Applications/MiniMax Code.app/Contents/MacOS/MiniMax Code", "/opt/MiniMax Code/minimax-code",
  ]),
  zcode: resolveBin(null, ["%LOCALAPPDATA%\\Programs\\ZCode\\ZCode.exe"], [
    "/Applications/ZCode.app/Contents/MacOS/ZCode", "/opt/ZCode/zcode",
  ]),
};

/**
 * Как запустить файл, найденный на диске, БЕЗ cmd.exe там, где это возможно.
 *
 * npm на Windows ставит .cmd-шимы, и раньше агенты запускались как
 * `cmd /d /s /c <шим>.cmd <промпт>`. cmd.exe по-своему разбирает & | ^ % и
 * кавычки: промпт с кавычкой и `&` выполнял постороннюю команду (класс
 * BatBadBut), а обычные символы задачи терялись. Шим npm — это одна строка
 * `"%_prog%" "%dp0%\<скрипт>" %*`: достаём скрипт и запускаем node напрямую.
 */
export function launcherFor(path: string): string[] {
  if (path === MISSING_PREFIX[0]) return MISSING_PREFIX;
  // npm-пакет, найденный по каталогу (cli.js), — это скрипт для node
  if (/\.[cm]?js$/i.test(path)) return [Bun.which("node") ?? EXE.node, path];
  if (!WIN) return [path];
  if (/\.ps1$/i.test(path)) return ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path];
  if (!/\.(cmd|bat)$/i.test(path)) return [path];
  const npm = unwrapNpmShim(path);
  if (npm) return npm;
  // ConPTY не резолвит «cmd» по PATH — нужен абсолютный путь (COMSPEC)
  const comspec = process.env.COMSPEC ?? "C:\\Windows\\System32\\cmd.exe";
  return [comspec, "/d", "/s", "/c", path];
}

/** npm cmd-шим → [node, скрипт]; null — это не npm-шим. */
function unwrapNpmShim(cmdPath: string): string[] | null {
  try {
    const text = readFileSync(cmdPath, "utf8");
    const m = /"%(?:dp0|~dp0)%\\?([^"]+?)"\s+%\*/i.exec(text);
    if (!m) return null;
    const dir = dirname(cmdPath);
    const script = join(dir, m[1]!.replace(/^\\+/, ""));
    if (!existsSync(script)) return null;
    const localNode = join(dir, "node.exe");
    const node = existsSync(localNode) ? localNode : (Bun.which("node") ?? EXE.node);
    if (!node || node === MISSING_PREFIX[0]) return null;
    return [node, script];
  } catch { return null; }
}

/**
 * argv запуска cursor-agent. На Windows его лаунчер — .cmd → powershell .ps1 →
 * `versions\<последняя>\node.exe index.js`. Раньше пульт звал `powershell -File
 * cursor-agent.cmd`, а -File принимает только .ps1 — cursor не стартовал вовсе.
 * Идём сразу к node.exe последней версии; без неё — через .ps1.
 */
function resolveCursorCmd(): string[] {
  if (!WIN) return [EXE.cursorAgent];
  const root = expand("%LOCALAPPDATA%\\cursor-agent");
  try {
    if (existsSync(join(root, "node.exe")) && existsSync(join(root, "index.js"))) return [join(root, "node.exe"), join(root, "index.js")];
    const key = (n: string) => { const [d] = n.split("-"); return d!.split(".").map((x) => x.padStart(4, "0")).join(""); };
    const latest = readdirSync(join(root, "versions"), { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^\d{4}\.\d{1,2}\.\d{1,2}(-\d{2}-\d{2}-\d{2})?-[a-f0-9]+$/.test(d.name))
      .map((d) => d.name)
      .sort((a, b) => key(b).localeCompare(key(a)) || b.localeCompare(a))[0];
    if (latest) {
      const node = join(root, "versions", latest, "node.exe");
      const idx = join(root, "versions", latest, "index.js");
      if (existsSync(node) && existsSync(idx)) return [node, idx];
    }
  } catch { /* каталога версий нет — ниже .ps1 */ }
  const ps1 = join(root, "cursor-agent.ps1");
  if (existsSync(ps1)) return launcherFor(ps1);
  return EXE.cursorAgent === MISSING_PREFIX[0] ? MISSING_PREFIX : launcherFor(EXE.cursorAgent);
}

/** argv запуска cursor-agent (см. resolveCursorCmd). */
const CURSOR_CMD = resolveCursorCmd();

/**
 * Портативный резолвер npm-глобальных CLI (claude/codex/copilot/gemini...).
 * Ищет в PATH (Bun.which), затем в типовых местах установки. .cmd/.bat
 * оборачиваются `cmd /d /s /c` (Windows-spawn без shell их не запускает).
 * Если ничего не найдено — возвращает null, агент деградирует до «не установлен».
 */
function resolveNpmCli(name: string): string[] | null {
  const viaPath = Bun.which(name);
  const pathOk = viaPath && !/\.ps1$/i.test(viaPath) ? viaPath : null;
  const candidates = (WIN
    ? [
        // .cmd-шимы npm ПЕРВЫМИ: ConPTY не умеет запускать .ps1 («spawn failed»)
        expand(`%APPDATA%\\npm\\${name}.cmd`),
        expand(`%USERPROFILE%\\scoop\\shims\\${name}.cmd`),
        expand(`%USERPROFILE%\\scoop\\shims\\${name}.exe`),
        pathOk,
        expand(`%LOCALAPPDATA%\\Microsoft\\WindowsApps\\${name}.exe`),
        expand(`%USERPROFILE%\\.local\\bin\\${name}`),
      ]
    : [
        // Unix: PATH решает, дальше — типовые префиксы npm/bun/brew
        pathOk,
        expand(`$HOME/.local/bin/${name}`),
        expand(`$HOME/.bun/bin/${name}`),
        expand(`$HOME/.npm-global/bin/${name}`),
        `/usr/local/bin/${name}`,
        `/usr/bin/${name}`,
        MAC ? `/opt/homebrew/bin/${name}` : null,
      ]
  ).filter((p): p is string => !!p);
  const found = candidates.find((p) => existsSync(p));
  if (!found) return null;
  return launcherFor(found);
}

/** Установлен ли агент по его текущей (закешированной) команде. */
export function isMissingCommand(cmd: string[] | undefined): boolean {
  // Маркер может стоять не первым: npm-агенты запускаются как [node, <скрипт>],
  // и отсутствует там именно скрипт. Проверка только cmd[0] считала такого
  // агента установленным — ровно так ENOENT и доезжал до пользователя.
  return !cmd?.length || cmd.some((part) => part === MISSING_PREFIX[0]);
}

/**
 * Пере-резолв команд агентов.
 *
 * AGENTS строится один раз при импорте модуля, поэтому агент, установленный
 * мастером настройки уже после старта демона, оставался «не установлен» до
 * перезапуска — то есть главный сценарий продукта («поставил в один клик и
 * сразу работаешь») не работал. Вызывается после установки/удаления агента.
 * Возвращает id тех, у кого команда изменилась.
 */
export function refreshAgentCommands(): string[] {
  const npmBin: Record<string, string> = {
    "claude-code": "claude", codex: "codex", copilot: "copilot",
    gemini: "gemini", freebuff: "freebuff", cline: "cline",
  };
  const changed: string[] = [];
  for (const a of AGENTS) {
    let next: string[] | null = null;
    if (npmBin[a.id]) next = resolveNpmCli(npmBin[a.id]!);
    else if (a.id === "opencode") {
      const exe = resolveOpencodeExe();
      next = exe && existsSync(exe) ? [exe] : (Bun.which("opencode") ? [Bun.which("opencode")!] : null);
    } else if (a.id === "cursor") {
      // по PATH под именем «cursor» лежит лаунчер Cursor IDE, а не агент
      const c = resolveCursorCmd();
      next = isMissingCommand(c) ? null : c;
    } else if (a.id === "zcode") {
      next = null;                       // собирается из исходников, путь фиксирован
    } else {
      // остальные резолвятся по PATH под именем своего бинаря
      const bin = ({ minimax: "mcode" } as Record<string, string>)[a.id] ?? a.id;
      const viaPath = Bun.which(bin);
      if (viaPath) next = launcherFor(viaPath);
    }
    if (!next) continue;
    const prev = a.command;
    if (JSON.stringify(prev) !== JSON.stringify(next)) {
      a.command = next;
      changed.push(a.id);
      // Режимы «Терминал» и «Диалог» запускают тот же бинарь с другими
      // аргументами — раньше их команды оставались старыми, и агент,
      // поставленный из мастера, в этих режимах числился неустановленным.
      const swap = (cmd: string[] | undefined): string[] | undefined => {
        if (!cmd) return cmd;
        const n = isMissingCommand(prev) && cmd[0] === MISSING_PREFIX[0] ? 1 : prev.length;
        const samePrefix = cmd.slice(0, n).every((x, i) => x === prev[i] || x === MISSING_PREFIX[0]);
        return samePrefix ? [...next!, ...cmd.slice(n)] : cmd;
      };
      if (a.ptyCommand) a.ptyCommand.command = swap(a.ptyCommand.command)!;
      if (a.acp && a.id !== "claude-code") a.acp.command = swap(a.acp.command)!;
      if (a.modelsCommand) a.modelsCommand = swap(a.modelsCommand);
      if (a.auth?.statusCommand) a.auth.statusCommand = swap(a.auth.statusCommand);
    }
    // ACP-команда для claude-code резолвится отдельным бинарником
    if (a.id === "claude-code" && a.acp) {
      const acp = resolveNpmCli("claude-code-acp");
      if (acp && JSON.stringify(a.acp.command) !== JSON.stringify(acp)) a.acp.command = acp;
    }
  }
  return changed;
}

if (process.env.DIRIGO_DEBUG_PATHS === "1") {
  console.log(`[dirigo] платформа ${process.platform}/${process.arch}; opencode → ${EXE.opencode}`);
}

export const AGENTS: AgentDef[] = [
  {
    id: "opencode",
    label: "OpenCode",
    kind: "cli",
    command: [EXE.opencode],
    // Модель НЕ зашита: `opencode models` отдаёт актуальный список, а прежний
    // дефолт «opencode/step-5-preview-free» уже не существует — запуск падал с
    // «UnknownError: Unexpected server error». Без выбора пользователя флаг не
    // подставляем вовсе: агент возьмёт свою модель по умолчанию.
    argsTemplate: ["run", "{{prompt}}"],
    // Уровень рассуждений у opencode задаётся только суффиксом модели
    // (`provider/model#variant`), и набор вариантов свой у каждого провайдера —
    // поэтому отдельного выбора нет: агент берёт уровень из своих настроек.
    modelFlag: "--model",
    sessionFlag: "--session",
    // opencode 1.19: `--session` ТОЛЬКО продолжает существующую сессию.
    // С нашим идентификатором он отвечает «Error: Session not found» и выходит
    // с кодом 1 — поэтому флаг подставляем лишь когда знаем id со стороны
    // агента (externalRef), а не выдаём свой за его.
    createsSession: false,
    hint: "opencode run — своя сессия на задачу (free-tier только внутри приложения!)",
    // Проверено по `opencode --help`: подкоманды run / serve / web / acp,
    // запуск без аргументов открывает TUI.
    ptyCommand: {
      command: [EXE.opencode],
      label: "Терминал (TUI)",
      hint: "opencode без аргументов — интерактивный терминальный интерфейс",
    },
    acp: { command: [EXE.opencode, "acp"] },
    modelsCommand: [EXE.opencode, "models"],
    auth: {
      credentialsFile: "~/.local/share/opencode/auth.json",
      // opencode 2.x хранит учётки в opencode.db, а не в auth.json: по файлу
      // агент вечно выглядел «не вошедшим». Спрашиваем его самого.
      statusCommand: [EXE.opencode, "auth", "list"],
      signedInPattern: "\\bstored\\b|\\boauth\\b|\\bapi\\b",
      loginArgs: ["auth", "login"],
      hint: "Вход один раз: opencode auth login (или кнопка «Войти один раз»).",
    },
    web: {
      command: [EXE.opencode, "serve"],
      portArg: "--port",
      noOpenFlag: "",
      authTokenUser: "opencode",
      label: "Web UI (serve)",
      hint: "opencode serve — панель откроется сразу: пароль из лога автоматически подставляется в ссылку (ручной pairing не нужен)",
    },
  },
  {
    id: "kilo",
    label: "Kilo (Kilo Code)",
    kind: "cli",
    command: [EXE.kilo],
    // Список моделей отдаёт `kilo models` (их больше трёхсот и они зависят от
    // аккаунта), поэтому дефолт в коде не держим.
    argsTemplate: ["run", "{{prompt}}"],
    modelFlag: "--model",
    // `kilo run --help`: «--variant  provider-specific reasoning effort, e.g. high, max, minimal»
    reasoningFlag: "--variant",
    reasoning: ["minimal", "low", "medium", "high", "max"],
    sessionFlag: "--session",
    createsSession: false,
    hint: "kilo run — -s продолжает сессию",
    // `kilo --help`: run / serve / acp / attach, по умолчанию — TUI.
    ptyCommand: {
      command: [EXE.kilo],
      label: "Терминал (TUI)",
      hint: "kilo без аргументов — интерактивный терминальный интерфейс",
      // проверено запуском: --model TUI принимает, --variant — нет (печатает справку)
      modelFlag: "--model",
    },
    modelsCommand: [EXE.kilo, "models"],
    // `kilo auth list` показывает путь к хранилищу учётных данных; без входа
    // любой запуск отвечает «You need to sign in to use this model».
    auth: {
      credentialsFile: "~/.local/share/kilo/auth.json",
      loginArgs: ["auth", "login"],
      hint: "Вход один раз: kilo auth login (или кнопка «Войти один раз»).",
    },
    // `kilo serve --port N` поднимает локальный сервер (как opencode serve).
    // Раньше здесь стоял `kilo remote` — релей в облако, который падал с
    // кодом 1 и выглядел как «веб-панель не работает».
    // Своей веб-панели у kilo нет: `kilo serve` — headless API для его же
    // клиентов (`kilo --help`: «starts a headless kilo server»), и во фрейме
    // пульта открывался голый {"error":"Not Found"}. Честная ссылка на кабинет.
    web: {
      command: [],
      label: "Kilo (сайт)",
      externalOnly: true,
      externalUrl: "https://app.kilo.ai",
      hint: "Локальной веб-панели у Kilo нет (kilo serve — только API). Работа на этой машине — режимы «Терминал», «Задача» и «Диалог»; кабинет Kilo — на сайте.",
    },
    acp: {
      command: [EXE.kilo, "acp"],
      defaultModel: "kilo/kilo-auto/free",
    },
  },
  {
    id: "cursor",
    label: "Cursor",
    kind: "cli",
    command: CURSOR_CMD,
    argsTemplate: ["-p", "{{prompt}}", "--output-format", "stream-json", "--force"],
    hint: "cursor-agent -p (stream-json) — resume через --resume <chatId>",
    // `cursor-agent --help`: без -p это интерактивный агент; --list-models
    // отдаёт реальный список, но только после входа в аккаунт.
    ptyCommand: {
      command: CURSOR_CMD,
      label: "Терминал (TUI)",
      hint: "cursor-agent без -p — интерактивный сеанс",
      modelFlag: "--model",
    },
    modelsCommand: [...CURSOR_CMD, "--list-models"],
    modelFlag: "--model",
    web: {
      command: [],
      label: "Cursor (сайт)",
      externalOnly: true,
      externalUrl: "https://cursor.com",
      hint: "Локального web-UI у cursor-agent нет: запуск задач — через CLI, облачные агенты — на сайте Cursor.",
    },
  },
  {
    id: "devin",
    label: "Devin",
    kind: "cli",
    command: [EXE.devin],
    // --respect-workspace-trust false: в неинтерактивном (-p) режиме trust-промпт
    // показать некому, devin падает с «Refusing to run in an untrusted workspace»
    // на любой недоверенной папке. Флаг идёт ДО -p, иначе -p съест его как промпт.
    argsTemplate: ["--respect-workspace-trust", "false", "-p", "{{prompt}}"],
    hint: "devin -p — неинтерактивный режим (--respect-workspace-trust false обходит trust-промпт), -r/--resume <id> для продолжения",
    // Сверено с docs.devin.ai/cli/reference/commands: --model глобальный флаг,
    // `devin models list` печатает доступные модели, `devin acp` — ACP по stdio.
    modelFlag: "--model",
    modelsCommand: [EXE.devin, "models", "list"],
    acp: { command: [EXE.devin, "acp"] },
    // Без входа любой режим отвечает «Please log in to use Devin» — показываем
    // это до запуска, а не после неудачи.
    auth: {
      // Именно credentials.json: config.json создаётся при первом запуске и
      // про вход ничего не говорит — по нему агент выглядел авторизованным,
      // хотя отвечал «Please log in to use Devin».
      credentialsFile: ["~/.config/devin/credentials.json", "~/.config/devin/credentials.toml", "%APPDATA%\\devin\\credentials.toml"],
      statusCommand: [EXE.devin, "auth", "status"],
      signedInPattern: "^Logged in",
      accountPattern: "Email:\\s+(\\S+)",
      loginArgs: ["auth", "login"],
      hint: "Вход один раз: devin auth login (или кнопка «Войти один раз»).",
    },
    web: {
      command: [],
      label: "Devin Web",
      externalOnly: true,
      externalUrl: "https://app.devin.ai",
      hint: "Локального web-UI нет: Devin — облачный агент. Запуск CLI (-p) выполняется на этой машине, управление облачными сессиями — в кабинете.",
    },
    ptyCommand: {
      command: [EXE.devin],
      label: "Терминал (REPL)",
      hint: "devin в PTY — интерактивная сессия: пройти trust-промпт (y), писать промпты, читать вывод",
      modelFlag: "--model",
    },
  },
  {
    id: "hermes",
    label: "Hermes",
    kind: "cli",
    command: [EXE.hermes],
    // Снято с установленного бинаря (`hermes --help`), а не с README — в README
    // половины возможностей нет. Реально есть: -z (неинтерактивный запуск),
    // -m MODEL, --tui, --resume, отдельный мост hermes-acp.
    argsTemplate: ["-z", "{{prompt}}"],
    modelFlag: "-m",
    // `hermes --help`: --reasoning LEVEL (none … ultra), только на этот запуск
    reasoningFlag: "--reasoning",
    reasoning: ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
    sessionFlag: "--resume",
    modelCommand: "/model",
    hint: "hermes -z — неинтерактивный запуск; --tui — терминальный интерфейс; hermes-acp — мост ACP. Модель: hermes model или -m.",
    web: {
      command: [],
      label: "Hermes (сайт)",
      externalOnly: true,
      externalUrl: "https://hermes-agent.nousresearch.com/",
      hint: "Локальной веб-панели у Hermes нет — на сайте документация и загрузки.",
    },
    ptyCommand: {
      command: [EXE.hermes, "--tui"],
      label: "Терминал (TUI)",
      hint: "hermes --tui — интерактивный терминальный интерфейс",
      modelFlag: "-m",
      reasoning: true,
    },
    acp: { command: [EXE.hermesAcp] },
    // Без входа Hermes пишет «no Nous authentication found (run: hermes auth)».
    // Хранилище учётных данных — ~/.hermes/credentials.json (появляется после
    // первого входа), команда входа — `hermes auth`.
    auth: {
      credentialsFile: ["~/.hermes/credentials.json", "~/.hermes/auth.json", "%LOCALAPPDATA%\\hermes\\auth.json"],
      signedInPath: "providers",
      // `hermes auth` без подкоманды печатает справку; вход — `hermes portal`
      // (Nous Portal: вход, выбор модели), он же предлагается мастером setup.
      loginArgs: ["portal"],
      hint: "Вход один раз: hermes portal (или кнопка «Войти один раз»).",
    },
  },
  {
    id: "zcode",
    label: "ZCode",
    kind: "cli",
    command: [EXE.node, EXE.zcodeCli],
    argsTemplate: ["-p", "{{prompt}}", "--surface", "terminal", "--cwd", "{{cwd}}"],
    // Сверено с README github.com/zai-org/ZCode: готовых пакетов нет, CLI
    // собирается из исходников (pnpm build:zcode → install.sh в ~/.zcode).
    // Неинтерактивный режим в README не описан, зато есть веб-панель:
    // `zcode --web --port N --no-open`.
    cliInteractiveOnly: true,
    buildFromSource: "https://github.com/zai-org/ZCode",
    hint: "ZCode собирается из исходников (github.com/zai-org/ZCode): pnpm bootstrap → pnpm build:zcode → install.sh. Веб-панель поднимается командой zcode --web.",
    web: {
      command: [EXE.node, EXE.zcodeRuntime, "--web"],
      portArg: "--port",
      noOpenFlag: "--no-open",
      label: "Web UI (--web)",
      hint: "zcode --web — веб-панель ZCode (runtime-дистрибутив, ставится install-скриптом в ~/.zcode). Аналог opencode serve: панель откроется во фрейме, «⤢ Открыть» — в новой вкладке",
    },
  },
  {
    id: "minimax",
    label: "MiniMax Code",
    kind: "cli",
    command: launcherFor(EXE.mcodeCli),
    argsTemplate: ["exec", "--cwd", "{{cwd}}", "--model", "{{model}}", "{{prompt}}"],
    defaultModel: "custom_provider:openrouter/openrouter/free",
    sessionFlag: "--session",
    createsSession: false,
    hint: "mcode exec — терминальный агент MiniMax Code (npm @minimax-ai/code). Модель по умолчанию — openrouter-free через кастом-провайдер (модели minimax упираются в лимит токен-плана); выбор — в поле «Модель».",
    // `mcode --help`: позиционный prompt открывает интерактивный TUI,
    // подкоманда acp поднимает ACP-сервер по stdio.
    ptyCommand: {
      command: launcherFor(EXE.mcodeCli),
      label: "Терминал (TUI)",
      hint: "mcode без exec — интерактивный терминальный интерфейс",
    },
    web: {
      command: [],
      label: "MiniMax (сайт)",
      externalOnly: true,
      externalUrl: "https://www.minimax.io",
      hint: "MiniMax Code — CLI-агент (mcode exec/acp) + десктоп-приложение; локального web-UI нет. Кнопка «Веб» откроет сайт продукта.",
    },
    acp: {
      command: [...launcherFor(EXE.mcodeCli), "acp"],
      // значение config option "model" в ACP MiniMax (URL-encoded формат m:provider:model:v:variant)
      defaultModel: "m:custom_provider%3Aopenrouter:openrouter%2Ffree:v:",
    },
  },
  {
    // V2-5.2: Anthropic Claude Code (npm i -g @anthropic-ai/claude-code)
    id: "claude-code",
    label: "Claude Code",
    kind: "cli",
    command: resolveNpmCli("claude") ?? MISSING_PREFIX,
    // acceptEdits: без него `claude -p` не имеет права писать файлы — агент печатал
    // патч в журнал, а сессия завершалась «done» с пустым диффом. Работа идёт в
    // копии, проверки запускает пульт.
    argsTemplate: ["--permission-mode", "acceptEdits", "-p", "{{prompt}}"],
    // `claude --help`: --effort <level> (low, medium, high, xhigh, max)
    reasoningFlag: "--effort",
    reasoning: ["low", "medium", "high", "xhigh", "max"],
    hint: "claude -p — one-shot Claude Code. Ставится: npm i -g @anthropic-ai/claude-code (вход: claude один раз).",
    ptyCommand: {
      command: resolveNpmCli("claude") ?? MISSING_PREFIX,
      label: "Терминал (TUI)",
      hint: "claude в PTY — интерактивная сессия Claude Code",
      modelFlag: "--model",
      reasoning: true,
    },
    auth: {
      credentialsFile: "~/.claude/.credentials.json",
      hint: "Вход по подписке: выполните `claude` в терминале и войдите один раз.",
    },
    acp: {
      // ACP-адаптер Claude Code: npm i -g claude-code-acp (Zed-совместимый)
      command: resolveNpmCli("claude-code-acp") ?? MISSING_PREFIX,
    },
    web: {
      command: [],
      label: "Claude (сайт)",
      externalOnly: true,
      externalUrl: "https://claude.ai",
      hint: "Локального web-UI нет: Claude Code — CLI/TUI-агент. Веб-версия — на claude.ai.",
    },
  },
  {
    // V2-5.2: OpenAI Codex CLI (npm i -g @openai/codex)
    id: "codex",
    label: "Codex CLI",
    kind: "cli",
    command: resolveNpmCli("codex") ?? MISSING_PREFIX,
    argsTemplate: ["exec", "--skip-git-repo-check", "{{prompt}}"],
    hint: "codex exec — неинтерактивный запуск OpenAI Codex. Ставится: npm i -g @openai/codex.",
    ptyCommand: {
      command: resolveNpmCli("codex") ?? MISSING_PREFIX,
      label: "Терминал (TUI)",
      hint: "codex в PTY — интерактивный Codex",
    },
    web: {
      command: [],
      label: "ChatGPT (сайт)",
      externalOnly: true,
      externalUrl: "https://chatgpt.com",
      hint: "Локального web-UI нет: Codex — CLI-агент. Веб-версия — ChatGPT.",
    },
  },
  {
    // V2-5.2: GitHub Copilot CLI (npm i -g @github/copilot)
    id: "copilot",
    label: "Copilot CLI",
    kind: "cli",
    command: resolveNpmCli("copilot") ?? MISSING_PREFIX,
    argsTemplate: ["-p", "{{prompt}}"],
    hint: "copilot -p — one-shot GitHub Copilot CLI. Ставится: npm i -g @github/copilot (вход: /login).",
    ptyCommand: {
      command: resolveNpmCli("copilot") ?? MISSING_PREFIX,
      label: "Терминал (TUI)",
      hint: "copilot в PTY — интерактивный Copilot CLI",
    },
    web: {
      command: [],
      label: "GitHub (сайт)",
      externalOnly: true,
      externalUrl: "https://github.com/features/copilot",
      hint: "Локального web-UI нет: Copilot CLI — терминальный агент.",
    },
  },
  {
    // V5-7: Google Gemini CLI (npm i -g @google/gemini-cli)
    id: "gemini",
    label: "Gemini CLI",
    kind: "cli",
    command: resolveNpmCli("gemini") ?? MISSING_PREFIX,
    argsTemplate: ["-p", "{{prompt}}"],
    hint: "gemini -p — one-shot Gemini CLI. Ставится: npm i -g @google/gemini-cli (вход: /auth).",
    // `gemini --help`: «--acp  Starts the agent in ACP mode».
    acp: { command: [...(resolveNpmCli("gemini") ?? MISSING_PREFIX), "--acp"] },
    ptyCommand: {
      command: resolveNpmCli("gemini") ?? MISSING_PREFIX,
      label: "Терминал (TUI)",
      hint: "gemini в PTY — интерактивный Gemini CLI",
    },
    web: {
      command: [],
      label: "Gemini (сайт)",
      externalOnly: true,
      externalUrl: "https://gemini.google.com",
      hint: "Локального web-UI нет: Gemini CLI — терминальный агент.",
    },
  },
  {
    // V5-7: Freebuff (npm i -g freebuff) — бесплатный CLI-агент без ключа/подписки.
    id: "freebuff",
    label: "Freebuff",
    kind: "cli",
    command: resolveNpmCli("freebuff") ?? MISSING_PREFIX,
    argsTemplate: [],
    // V5-13: freebuff не принимает промпт аргументом (позиционный = "login"),
    // но читает stdin — пульт пишет задачу в stdin процесса.
    stdinPrompt: true,
    // У freebuff нет неинтерактивного режима: `freebuff --help` знает только
    // команду login и флаги --continue/--cwd. Любой запуск открывает TUI,
    // поэтому разовая задача тут невозможна — работаем через «Терминал».
    cliInteractiveOnly: true,
    // Модели у freebuff есть, но выбираются внутри TUI командой /model —
    // флага CLI нет (`freebuff --help`). Показываем это честно и даём кнопку.
    modelCommand: "/model",
    auth: {
      credentialsFile: "~/.config/manicode/credentials.json",
      accountPath: "default.email",
      loginArgs: ["login"],
      hint: "Вход один раз на всю машину: откройте ссылку, войдите — все следующие сессии подхватят аккаунт.",
    },
    hint: "freebuff — бесплатный агент без API-ключа. Работает только в режиме «Терминал (TUI)»: неинтерактивного запуска у него нет. Ставится: npm i -g freebuff.",
    ptyCommand: {
      command: resolveNpmCli("freebuff") ?? MISSING_PREFIX,
      label: "Терминал (TUI)",
      hint: "freebuff в PTY — интерактивный сеанс; первый запуск индексирует репозиторий",
    },
    web: {
      command: [],
      label: "Freebuff (сайт)",
      externalOnly: true,
      externalUrl: "https://freebuff.com",
      hint: "Локального web-UI нет: Freebuff — CLI-агент. Веб-продукты — на freebuff.com.",
    },
  },
  {
    // V5-7: Cline (npm i -g cline) — CLI-агент, есть ACP-режим (cline --acp).
    id: "cline",
    label: "Cline",
    kind: "cli",
    command: resolveNpmCli("cline") ?? MISSING_PREFIX,
    argsTemplate: ["{{prompt}}"],
    // `cline --help`: --thinking <level> none|low|medium|high|xhigh
    reasoningFlag: "--thinking",
    reasoning: ["none", "low", "medium", "high", "xhigh"],
    hint: "cline — CLI-агент (one-shot: cline \"задача\"). Авторизация: cline auth. Ставится: npm i -g cline.",
    ptyCommand: {
      command: resolveNpmCli("cline") ?? MISSING_PREFIX,
      label: "Терминал (TUI)",
      hint: "cline в PTY — интерактивный сеанс Cline",
      reasoning: true,
    },
    // Модель у Cline выбирается внутри него (`/model`) или через `cline auth`:
    // формат «modelType/model» зависит от провайдера, плоского списка нет.
    modelCommand: "/model",
    auth: {
      credentialsFile: "~/.cline/data/settings/providers.json",
      loginArgs: ["auth"],
      hint: "Вход и выбор модели: cline auth (провайдер + модель).",
    },
    acp: {
      // ACP-режим Cline: cline --acp (Zed-совместимый адаптер встроен)
      command: resolveNpmCli("cline") ? [...resolveNpmCli("cline")!, "--acp"] : MISSING_PREFIX,
    },
    web: {
      command: [],
      label: "Cline (сайт)",
      externalOnly: true,
      externalUrl: "https://cline.bot",
      hint: "Локального web-UI нет: Cline — CLI-агент (есть --kanban, канбан в вебе запускается локально, но вне пульта).",
    },
  },
];

export function getAgent(id: string): AgentDef | undefined {
  return AGENTS.find((a) => a.id === id);
}

/** Собирает argv для запуска сессии. */
export function buildArgs(def: AgentDef, sessionId: string, prompt: string, cwd: string, model?: string, reasoning?: string): string[] {
  const m = model || def.defaultModel || "";
  const args = def.argsTemplate.map((a) =>
    a
      .replaceAll("{{prompt}}", prompt)
      .replaceAll("{{sessionId}}", sessionId)
      .replaceAll("{{cwd}}", cwd)
      .replaceAll("{{model}}", m)
  );
  // Выбранная модель должна доехать до агента. Раньше она подставлялась только
  // через плейсхолдер {{model}} в шаблоне; у агентов без плейсхолдера (claude,
  // codex, gemini, copilot...) выбор в UI молча терялся — пользователь ставил
  // haiku и получал модель по умолчанию, не понимая почему.
  // Флаги ставим сразу после подкоманды (`run`, `exec`) — перед первым флагом
  // или промптом шаблона. Раньше они шли прямо перед промптом и разрывали пару
  // «флаг + значение»: у hermes `-z {{prompt}}` превращался в `-z -m <модель>
  // <промпт>`, и -z съедал «-m» вместо задачи.
  const pos = flagPos(def.argsTemplate);
  const extra: string[] = [];
  if (m && def.modelFlag && !def.argsTemplate.some((a) => a.includes("{{model}}"))) extra.push(def.modelFlag, m);
  // Уровень рассуждений — только если агент реально принимает флаг и знает
  // такое значение: иначе агент падает на неизвестном уровне.
  if (reasoning && def.reasoningFlag && (def.reasoning ?? []).includes(reasoning)) extra.push(def.reasoningFlag, reasoning);
  args.splice(pos, 0, ...extra);
  return args;
}

/** Индекс, куда вставлять флаги: после ведущих подкоманд шаблона. */
function flagPos(template: string[]): number {
  const i = template.findIndex((a) => a.startsWith("-") || a.includes("{{"));
  return i < 0 ? template.length : i;
}

/** Флаг рассуждений для интерактивных режимов (TUI в PTY): тот же, что у CLI. */
export function reasoningArgs(def: AgentDef, reasoning?: string): string[] {
  return reasoning && def.reasoningFlag && (def.reasoning ?? []).includes(reasoning) ? [def.reasoningFlag, reasoning] : [];
}

/* ── V6: модели и уровни рассуждений по агентам (H-V6-1 уточняет) ──
   Один источник правды для UI: диалог старта и композер показывают только
   то, что агент реально принимает (по флагам CLI/ACP). */
const MODELS: Record<string, string[]> = {
  opencode: ["opencode/step-5-preview-free", "opencode/gpt-5", "opencode/claude-sonnet-4", "opencode/claude-opus-4", "opencode/gemini-2.5-pro", "opencode/grok-code-fast-1"],
  kilo: ["kilo/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", "kilo/kilo-auto/free", "kilo/anthropic/claude-sonnet-4", "kilo/openai/gpt-5"],
  cursor: ["auto", "gpt-5", "claude-sonnet-4.5", "gemini-2.5-pro"],
  "claude-code": ["opus", "sonnet", "haiku"],
  codex: ["gpt-5-codex", "gpt-5", "o4-mini"],
  gemini: ["gemini-2.5-pro", "gemini-2.5-flash"],
  // minimax: --model принимает только provider/model; прежние «MiniMax-M1» он
  // отклонял сразу. Бесплатная модель по умолчанию — через кастом-провайдера.
  minimax: ["custom_provider:openrouter/openrouter/free"],
  // cline намеренно без списка: его формат — «modelType/model» и зависит от
  // подключённого провайдера. Плоский список давал «invalid model format».
  copilot: ["gpt-5", "claude-sonnet-4.5"],
  // devin / hermes / zcode / freebuff намеренно отсутствуют: у них нет
  // параметра модели в CLI. Пункт «default» — это не модель, а вид поломки:
  // пользователь видит меню из одного бессмысленного значения. Пустой список
  // UI показывает честно — «выбор модели недоступен».
};

/** Длинный флаг модели у агентов, которые его принимают.
 *  `--model` подтверждён вручную для claude (`claude --help`); у остальных это
 *  документированная длинная форма их CLI. Если агент флаг не примет, сессия
 *  теперь падает с видимой причиной и выводом в журнале — а не тихо игнорирует
 *  выбор пользователя. */
const MODEL_FLAG: Record<string, string> = {
  "claude-code": "--model",
  codex: "--model",
  gemini: "--model",
  copilot: "--model",
  cursor: "--model",

};
/** Обогащаем определения моделями. Уровни рассуждений НЕ раздаём всем подряд:
 *  раньше каждый CLI-агент получал low…extra, хотя флаг был только у kilo, —
 *  выбор молча терялся, а «high» по умолчанию понижал уровень, настроенный в
 *  самом агенте. Теперь список есть только у тех, кто принимает флаг. */
for (const def of AGENTS) {
  if (!def.models && MODELS[def.id]) def.models = MODELS[def.id];
  if (!def.reasoningFlag) def.reasoning = [];
  if (!def.modelFlag && def.argsTemplate.some((a) => a.includes("{{model}}"))) def.modelFlag = "--model";
  if (!def.modelFlag && MODEL_FLAG[def.id]) def.modelFlag = MODEL_FLAG[def.id];
}
/** argv для web-режима. */
export function buildWebArgs(def: AgentDef, cwd: string, port: number): string[] {
  const w = def.web!;
  if (w.externalOnly) return [];
  const argv = [...w.command];
  if (w.workspaceArg) argv.push(w.workspaceArg, cwd);
  if (w.portArg) argv.push(w.portArg, String(port));
  if (w.noOpenFlag) argv.push(w.noOpenFlag);
  return argv;
}
