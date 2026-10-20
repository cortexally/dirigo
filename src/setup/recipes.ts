// Dirigo — рецепты установки агентов (V3-5, Amnezia-style provisioning).
//
// Каждый агент = рецепт: как ПРОВЕРИТЬ что установлен, как УСТАНОВИТЬ (по ОС),
// как ПРОВЕРИТЬ после установки, где взять ключ (envVar) и подсказка по авторизации.
// Менеджер (setup/manager.ts) исполняет рецепты локально, рецепты удалёнки
// использует deploy.ts по ssh (тот же список).

export type Os = "windows" | "linux" | "darwin";

export interface InstallStep {
  /** argv команды (без shell-обёртки) */
  cmd: string[];
  /** человекочитаемое описание шага */
  label: string;
  /** нужен ли sudo на linux (для apt-library) */
  sudo?: boolean;
  /** таймаут мс (по умолчанию 10 мин) */
  timeoutMs?: number;
}

export interface AgentRecipe {
  id: string;
  label: string;
  /** бинарник, который ищем в PATH (пробер: which) */
  bin: string;
  /** альтернативные пути-кандидаты (windows npm/scoop и т.п.) */
  candidates?: (os: Os) => string[];
  /** команда проверки версии (argv после бинарника) */
  versionArgs?: string[];
  /** шаги установки по ОС */
  install: Record<Os, InstallStep[]>;
  /** переменная окружения с ключом (если агент умеет API-ключ) */
  envVar?: string;
  /** подсказка по авторизации (для UI) */
  authHint?: string;
  /** URL получения ключа/подписки */
  keyUrl?: string;
  /** агент встроен в дистрибутив (не требует установки) */
  builtin?: boolean;
  /** Автоустановки нет — только сборка руками. Значение: ссылка на инструкцию. */
  manualOnly?: string;
}

const NPM = (pkg: string, label: string): InstallStep => ({ cmd: ["npm", "install", "-g", "--no-audit", "--no-fund", "--allow-scripts", pkg], label });
/** Установщик с сайта агента. Адрес берём только из официальной документации. */
const SH = (script: string, label: string): InstallStep => ({ cmd: ["bash", "-c", script], label });

export const RECIPES: AgentRecipe[] = [
  {
    id: "opencode", label: "opencode", bin: "opencode", versionArgs: ["--version"],
    install: {
      windows: [NPM("opencode-ai@latest", "opencode (npm)")],
      linux: [NPM("opencode-ai@latest", "opencode (npm)")],
      darwin: [NPM("opencode-ai@latest", "opencode (npm)")],
    },
    envVar: "OPENCODE_API_KEY", keyUrl: "https://opencode.ai/auth",
    authHint: "opencode auth login — вход через браузер (или ключ из кабинета)",
  },
  {
    id: "kilo", label: "Kilo Code", bin: "kilo", versionArgs: ["--version"],
    install: {
      windows: [NPM("@kilocode/cli@latest", "kilo CLI (npm)")],
      linux: [NPM("@kilocode/cli@latest", "kilo CLI (npm)")],
      darwin: [NPM("@kilocode/cli@latest", "kilo CLI (npm)")],
    },
    envVar: "KILO_API_KEY", keyUrl: "https://kilocode.ai/settings/api",
    authHint: "kilo — рабочий профиль и token из профиля (уже настроен на этой машине)",
  },
  {
    id: "claude-code", label: "Claude Code", bin: "claude", versionArgs: ["--version"],
    install: {
      windows: [NPM("@anthropic-ai/claude-code@latest", "claude-code (npm)")],
      linux: [NPM("@anthropic-ai/claude-code@latest", "claude-code (npm)")],
      darwin: [NPM("@anthropic-ai/claude-code@latest", "claude-code (npm)")],
    },
    envVar: "ANTHROPIC_API_KEY", keyUrl: "https://console.anthropic.com/settings/keys",
    authHint: "claude — вход по подписке (один раз) ИЛИ ANTHROPIC_API_KEY",
  },
  {
    // Мост ACP для Claude Code (проект Zed). Отдельная установка: сам claude
    // по ACP не говорит, и без моста режим «Живой диалог» недоступен.
    // Держим его в рецептах, чтобы экран установки мог поставить его кнопкой,
    // а не отправлял пользователя в терминал за npm-командой.
    id: "claude-code-acp", label: "Claude Code — мост ACP", bin: "claude-code-acp", versionArgs: ["--version"],
    install: {
      windows: [NPM("@zed-industries/claude-code-acp@latest", "claude-code-acp (npm)")],
      linux: [NPM("@zed-industries/claude-code-acp@latest", "claude-code-acp (npm)")],
      darwin: [NPM("@zed-industries/claude-code-acp@latest", "claude-code-acp (npm)")],
    },
    authHint: "вход — тот же, что у claude; мост нужен только для режима «Живой диалог (ACP)»",
  },
  {
    id: "codex", label: "Codex CLI", bin: "codex", versionArgs: ["--version"],
    install: {
      windows: [NPM("@openai/codex@latest", "codex (npm)")],
      linux: [NPM("@openai/codex@latest", "codex (npm)")],
      darwin: [NPM("@openai/codex@latest", "codex (npm)")],
    },
    envVar: "OPENAI_API_KEY", keyUrl: "https://platform.openai.com/api-keys",
    authHint: "codex login — вход по подписке ChatGPT ИЛИ OPENAI_API_KEY",
  },
  {
    id: "copilot", label: "Copilot CLI", bin: "copilot", versionArgs: ["--version"],
    install: {
      windows: [NPM("@github/copilot@latest", "copilot CLI (npm)")],
      linux: [NPM("@github/copilot@latest", "copilot CLI (npm)")],
      darwin: [NPM("@github/copilot@latest", "copilot CLI (npm)")],
    },
    authHint: "copilot — /login по подписке GitHub Copilot",
    keyUrl: "https://github.com/settings/copilot",
  },
  {
    id: "gemini", label: "Gemini CLI", bin: "gemini", versionArgs: ["--version"],
    install: {
      windows: [NPM("@google/gemini-cli@latest", "gemini CLI (npm)")],
      linux: [NPM("@google/gemini-cli@latest", "gemini CLI (npm)")],
      darwin: [NPM("@google/gemini-cli@latest", "gemini CLI (npm)")],
    },
    envVar: "GEMINI_API_KEY", keyUrl: "https://aistudio.google.com/apikey",
    authHint: "gemini — /auth по Google-аккаунту ИЛИ GEMINI_API_KEY",
  },
  {
// Источник: hermes-agent.nousresearch.com и github.com/nousresearch/hermes-agent.
    // Старый адрес hermes.agents.dev не существует — отсюда «Could not resolve host».
    id: "hermes", label: "Hermes", bin: "hermes", versionArgs: ["--version"],
    install: {
      windows: [{ cmd: ["powershell", "-NoProfile", "-Command", "Write-Host 'Скачайте Hermes-Setup.exe с hermes-agent.nousresearch.com'"], label: "hermes (установщик для Windows)" }],
      linux: [SH("curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash", "hermes (официальный установщик)")],
      darwin: [SH("curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash", "hermes (официальный установщик)")],
    },
    authHint: "hermes — вход по подписке из терминала",
  },
  {
// Источник: docs.devin.ai/cli (quickstart). Пакета devin-cli в npm нет —
    // тот, что лежит под этим именем, версии 0.0.1 и бинарника не ставит.
    id: "devin", label: "Devin", bin: "devin", versionArgs: ["--version"],
    install: {
      windows: [{ cmd: ["powershell", "-NoProfile", "-Command", "irm https://static.devin.ai/cli/setup.ps1 | iex"], label: "devin (официальный установщик)" }],
      linux: [SH("curl -fsSL https://cli.devin.ai/install.sh | bash", "devin (официальный установщик)")],
      darwin: [SH("curl -fsSL https://cli.devin.ai/install.sh | bash", "devin (официальный установщик)")],
    },
    authHint: "devin — логин по токену кабинета cognition.ai",
  },
  {
    id: "cursor", label: "Cursor Agent", bin: "cursor-agent", versionArgs: ["--version"],
    install: {
      windows: [{ cmd: ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "irm https://cursor.com/install?creator=true | iex"], label: "cursor-agent (официальный установщик)" }],
      linux: [{ cmd: ["bash", "-c", "curl https://cursor.com/install -fsS | bash"], label: "cursor-agent (официальный установщик)" }],
      darwin: [{ cmd: ["bash", "-c", "curl https://cursor.com/install -fsS | bash"], label: "cursor-agent (официальный установщик)" }],
    },
    authHint: "cursor-agent login — вход по подписке Cursor",
  },
  {
    // Готовых пакетов у ZCode нет: по README github.com/zai-org/ZCode он
    // собирается из исходников (pnpm bootstrap → pnpm build:zcode → install.sh).
    // Адрес zcode.dev не существует — отсюда «Could not resolve host».
    // Автоустановку не предлагаем, но даём ссылку на инструкцию.
    id: "zcode", label: "ZCode", bin: "zcode", versionArgs: ["--version"],
    manualOnly: "https://github.com/zai-org/ZCode",
    install: { windows: [], linux: [], darwin: [] },
  },
  {
    id: "minimax", label: "MiniMax Code", bin: "mcode", versionArgs: ["--version"],
    install: {
      windows: [NPM("@minimax-ai/code@latest", "mcode (npm)")],
      linux: [NPM("@minimax-ai/code@latest", "mcode (npm)")],
      darwin: [NPM("@minimax-ai/code@latest", "mcode (npm)")],
    },
    envVar: "MINIMAX_API_KEY", authHint: "mcode — провайдер моделей настраивается флагом",
  },
  {
    // V5-8: Freebuff — бесплатный CLI-агент (модели включены, без ключа).
    id: "freebuff", label: "Freebuff", bin: "freebuff", versionArgs: ["--version"],
    install: {
      windows: [NPM("freebuff@latest", "freebuff (npm)")],
      linux: [NPM("freebuff@latest", "freebuff (npm)")],
      darwin: [NPM("freebuff@latest", "freebuff (npm)")],
    },
    authHint: "freebuff — ключ/подписка не нужны (бесплатные модели включены); первый запуск индексирует репозиторий",
    keyUrl: "https://freebuff.com/cli",
  },
  {
    // V5-8: Cline — CLI-агент (npm i -g cline), авторизация cline auth.
    id: "cline", label: "Cline", bin: "cline", versionArgs: ["--version"],
    install: {
      windows: [NPM("cline@latest", "cline (npm)")],
      linux: [NPM("cline@latest", "cline (npm)")],
      darwin: [NPM("cline@latest", "cline (npm)")],
    },
    authHint: "cline auth — вход (Cline Provider / ClinePass / свой ключ провайдера)",
    keyUrl: "https://docs.cline.bot/getting-started/installing-cline",
  },
];

/** Агенты без установки (внешние/релейные). */
export const VIRTUAL_RECIPES: AgentRecipe[] = [
  { id: "devin-web", label: "Devin Web", bin: "", install: { windows: [], linux: [], darwin: [] }, builtin: true, authHint: "облачный агент — только через сайт" },
];

export function recipeFor(id: string): AgentRecipe | undefined {
  return [...RECIPES, ...VIRTUAL_RECIPES].find((r) => r.id === id);
}

export function currentOs(): Os {
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin") return "darwin";
  return "linux";
}

/** Пути-кандидаты для агента на этой ОС (windows: npm/scoop/locl). */
export function candidatePaths(id: string, os: Os = currentOs()): string[] {
  const r = recipeFor(id);
  if (!r) return [];
  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
  const appdata = process.env.APPDATA ?? "";
  if (os === "windows") {
    return [
      `${appdata}\\npm\\${r.bin}.cmd`,
      `${home}\\scoop\\shims\\${r.bin}.cmd`,
      `${home}\\scoop\\shims\\${r.bin}.exe`,
      `${home}\\.local\\bin\\${r.bin}.exe`,
    ].filter(Boolean);
  }
  return [`/usr/local/bin/${r.bin}`, `/usr/bin/${r.bin}`, `${home}/.local/bin/${r.bin}`, `${home}/.npm-global/bin/${r.bin}`];
}
