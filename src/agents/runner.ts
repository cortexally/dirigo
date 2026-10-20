// Dirigo — запуск агентов (spawn/стоп/логи/web-режим/рестарт)
import { existsSync } from "node:fs";
import { getAgent, buildArgs, buildWebArgs, reasoningArgs, type AgentDef } from "./registry";
import { AcpClient, type AcpConfigOption } from "./acp";
import type { PtyHandle } from "./pty";
import { Screen, LIGHT_COLORS, isLightColor, type TermColors } from "./screen";
import { diagnose } from "./diagnose";
import { AGENTS_WITH_DAEMONS, killAgentDaemonsAsync, killPidTree, killPidTreeAsync, sweepAgentOrphansAsync } from "./daemons";
import { ensureClineHub } from "./cline-hub";
import { workDir, repairWorktree } from "../worktrees";
import { checksFeedbackPrompt, runChecksOverride } from "../checks";
import { secretsEnv } from "../secrets";
import {
  sessions,
  projects,
  messages,
  appendLog,
  appendLogRotated,
  readLogTail,
  emit,
  type Session,
} from "../store";

/**
 * Живые процессы сессии. Их может быть НЕСКОЛЬКО: «send» в режиме «Задача
 * (CLI)» поднимает отдельный процесс на каждое сообщение, и он живёт рядом
 * с основным запуском.
 *
 * Раньше здесь лежал один процесс на сессию, и второй запуск его затирал:
 * выход короткого сообщения объявлял сессию завершённой, пока основной
 * агент ещё работал. Набор e2e-cli верил статусу и сносил копию проекта —
 * у живого агента пропадала рабочая папка («Working directory does not
 * exist»), а вместе с ней и правки.
 */
const procs = new Map<string, Set<Bun.Subprocess>>();
const stoppedByUser = new Set<string>();

/** Запомнить живой процесс сессии. */
function addProc(sessionId: string, proc: Bun.Subprocess): void {
  let set = procs.get(sessionId);
  if (!set) { set = new Set(); procs.set(sessionId, set); }
  set.add(proc);
}

/**
 * Забыть процесс сессии. true — у сессии остались живые процессы (значит,
 * сессия жива, итоговый статус ставить нельзя).
 */
function dropProc(sessionId: string, proc: Bun.Subprocess): boolean {
  const set = procs.get(sessionId);
  if (!set) return false;
  set.delete(proc);
  if (set.size === 0) { procs.delete(sessionId); return false; }
  return true;
}

/** pid живого процесса сессии (нужен, чтобы сессия выглядела живой). */
function livePid(sessionId: string): number | null {
  for (const p of procs.get(sessionId) ?? []) if (p.exitCode === null) return p.pid;
  return null;
}
const decoder = new TextDecoder();

/** Свободный порт на loopback. */
async function getFreePort(): Promise<number> {
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {}, open() {}, close() {}, error() {} },
  });
  const port = server.port;
  server.stop(true);
  return port;
}

/**
 * Рабочий каталог сессии: копия проекта (v2 worktree), если привязана,
 * иначе путь проекта, иначе cwd демона.
 */
/**
 * Проверить рабочую папку перед запуском агента.
 *
 * posix_spawn возвращает ENOENT и когда нет исполняемого файла, и когда нет
 * cwd — различить их по коду нельзя. Из-за этого исчезнувшая папка проекта
 * выглядела как «Исполняемый файл не найден: …/opencode», и пользователь шёл
 * искать несуществующую проблему с агентом.
 */
async function ensureCwd(sessionId: string, cwd: string, label: string): Promise<boolean> {
  // Копию могли снести наполовину: `git worktree remove` выносит содержимое,
  // но каталог, который держит процесс агента, снести не может. Повторный
  // запуск в такой сессии стартовал бы в пустой папке — агент «не видел» бы
  // проект. Лечим копию до старта.
  const rep = repairWorktree(sessionId);
  if (!rep.ok) {
    await appendLog(sessionId, `[dirigo] копию проекта не удалось восстановить: ${rep.detail}\n`);
    await sessions.setStatus(sessionId, "error", -1, {
      reason: "Копия проекта повреждена и не восстанавливается",
      fix: "Удалите копию сессии (Настройки → Копии) и запустите сессию заново",
    });
    void label;
    return false;
  }
  if (existsSync(cwd)) return true;
  await appendLog(sessionId,
    `[dirigo] рабочая папка не найдена: ${cwd}\n` +
    `  Проект удалён или переименован на диске. Создайте папку или смените путь проекта.\n`);
  await sessions.setStatus(sessionId, "error", -1, {
    reason: `Папка проекта не найдена: ${cwd}`,
    fix: "Проект указывает на несуществующую папку — создайте её или исправьте путь проекта",
  });
  void label;
  return false;
}

/** MCP-серверы для session/new: база знаний — агентам без пользовательского
 *  конфига MCP (minimax), если её подключили к агентам в Настройках. */
async function sessionMcpServers(agentId: string): Promise<unknown[]> {
  try {
    const { loadKnowledge } = await import("../knowledge");
    const k = loadKnowledge();
    if (!k.linkAgents || !k.apiKey || !k.url) return [];
    const { acpMcpServers, coallySpec } = await import("../agent-mcp");
    return acpMcpServers(agentId, coallySpec(k.url, k.apiKey));
  } catch { return []; }
}

/** id ответа агента: подключение + ход + messageId моста (может быть пустым). */
export function acpMsgId(conn: string, turn: number, messageId?: string): string {
  return `acp:${conn}:${turn}:${messageId ?? ""}`;
}
/** Непустые ответы агента ровно этого хода этого подключения. */
export function turnReplies<T extends { id: string; text: string }>(list: T[], conn: string, turn: number): T[] {
  const prefix = `acp:${conn}:${turn}:`;
  return list.filter((m) => m.id.startsWith(prefix) && m.text.trim());
}

export function sessionCwd(s: Session): string {
  if (s.worktree?.path) return s.worktree.path;
  return projects.get(s.projectId)?.path ?? process.cwd();
}

/**
 * Убийство процесса ДЕРЕВОМ: агенты (hermes/codex-обёртки) плодят дети,
 * а на Windows живой процесс держит свой CWD — копия проекта не удалится,
 * пока висит потомок. taskkill /T /F как в boot-чистке v1; fallback — kill().
 */
function killTree(proc: Bun.Subprocess): void {
  const pid = proc.pid;
  try { proc.kill(); } catch { /* уже мёртв */ }
  if (process.platform === "win32" && pid) {
    try { Bun.spawnSync(["taskkill", "/PID", String(pid), "/T", "/F"]); } catch { /* процесс уже мёртв */ }
  }
}

/** Достаёт «ответ агента» из хвоста лога: последний блок текста без ANSI/баннеров/маркеров. */
function extractAnswer(tail: string[]): string {
  const strip = (l: string) => l.replace(/\x1B\[[0-9;]*[A-Za-z]/g, "");
  const isNoise = (l: string) =>
    !l.trim() || /^\[dirigo\]/.test(l) || /^\$ /.test(l) || /^> code /.test(l) ||
    /^ZCode Built-in/.test(l) || /无法定位|CLI ZCode Built-in/.test(l) ||
    /^\s*$/.test(l);
  const out: string[] = [];
  for (let i = tail.length - 1; i >= 0; i--) {
    const l = strip(tail[i]!);
    if (isNoise(l)) {
      if (out.length) break;
      continue;
    }
    out.unshift(l.trim());
    if (out.length >= 8) break;
  }
  return out.join("\n").trim();
}

/** Парсит stdout веб-процесса: URL, порт, токен. */
interface WebInfo { url?: string; token?: string }
function parseWebOutput(line: string, port: number): WebInfo {
  const info: WebInfo = {};
  // opencode: "server listening on http://127.0.0.1:41711" + "server password xxx"
  const listen = line.match(/listening on (https?:\/\/[^\s]+)/i);
  if (listen) info.url = listen[1]!;
  const pwd = line.match(/server password (\S+)/i);
  if (pwd) info.token = pwd[1]!;
  // hermes: "Hermes Web UI → http://127.0.0.1:9119" (stderr) / "HERMES_DASHBOARD_READY port=9119"
  const hermesUrl = line.match(/https?:\/\/127\.0\.0\.1:\d+/i);
  if (hermesUrl && /\b(Web UI|dashboard)\b/i.test(line)) info.url = hermesUrl[0];
  const ready = line.match(/HERMES_DASHBOARD_READY port=(\d+)/i);
  if (ready) info.url = `http://127.0.0.1:${ready[1]}`;
  // zcode --web: "ZCode Web is running / Local:   http://127.0.0.1:PORT/"
  const local = line.match(/\blocal:?\s+(https?:\/\/[^\s]+)/i);
  if (local) info.url = local[1];
  return info;
}

/** Альт-экран: верный признак того, что «CLI» на самом деле полноэкранный TUI. */
const ALT_SCREEN = /\x1b\[\?1049h/;
/** Сколько терпеть полную тишину CLI-агента, прежде чем признать зависание. */
const CLI_SILENCE_MS = Number(process.env.DIRIGO_CLI_SILENCE_MS ?? 5 * 60_000);

export async function runSession(sessionId: string, prompt: string, modelOverride?: string): Promise<void> {
  const s = sessions.get(sessionId);
  if (!s) throw new Error("session not found");
  const def = getAgent(s.agentId);
  if (!def) throw new Error(`unknown agent ${s.agentId}`);
  if (s.mode === "web") return startWeb(sessionId);
  if (def.kind === "desktop") return launchDesktop(def.desktopPath!, sessionId);

  const cwd = sessionCwd(s);

  // V2-5.2: агент не установлен (npm-CLI не найден при резолве реестра) —
  // внятная ошибка вместо ENOENT от spawn.
  if (def.command[0] === "__dirigo_missing__") {
    // сперва лог, потом статус: иначе гейт (и API-клиенты) увидит error без объяснения
    await appendLog(sessionId, `[dirigo] агент «${def.label}» не установлен. Установи CLI (подсказка в селекте агента) и повтори.\n`);
    await sessions.setStatus(sessionId, "error", -1, {
      reason: `${def.label} не установлен на этой машине`,
      fix: "Настройки → Агенты: там видно, чего не хватает и как поставить",
    });
    notifyWorkMode(sessionId, s.workMode);
    return;
  }

  if (!(await ensureCwd(sessionId, cwd, def.label))) { notifyWorkMode(sessionId, s.workMode); return; }

  // cline: хаб поднимает пульт (скрытая консоль, без окон и сирот) — см. cline-hub.ts
  if (def.id === "cline") await ensureClineHub(def.command);
  let argv = [...def.command, ...buildArgs(def, sessionId, prompt, cwd, modelOverride ?? s.model, s.reasoning)];

  // Флаг продолжения/создания сессии на стороне агента: вставляем ПЕРЕД финальным
  // позиционным аргументом (prompt), т.к. флаги должны идти до позиционных.
  if (def.sessionFlag && (s.externalRef || def.createsSession)) {
    argv.splice(argv.length - 1, 0, def.sessionFlag, s.externalRef ?? sessionId);
  }

  await appendLog(sessionId, `\n$ ${argv.join(" ")}\n\n`);
  let proc: Bun.Subprocess;
  try {
    proc = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe", stdin: def.stdinPrompt ? "pipe" : "ignore", env: secretsEnv(cwd) });
  } catch (e) {
    const msg = String(e);
    await sessions.setStatus(sessionId, "error", -1, msg.includes("ENOENT")
      ? { reason: `Исполняемый файл не найден: ${argv[0]}`, fix: "Настройки → Агенты: проверьте установку агента" }
      : { reason: `Процесс агента не запустился: ${msg.slice(0, 200)}` });
    // ENOENT: агент не найден (или его заменяет обновитель) — объясняем, что делать
    if (msg.includes("ENOENT")) {
      await appendLog(sessionId,
        `[dirigo] агент не найден: ${argv[0]}\n` +
        `  Проверь: файл существует? ('Настройка' панель показывает статус агентов)\n` +
        `  Если агент только что ставился/обновлялся — подожди минуту и повтори запуск.\n` +
        `  Технические детали: ${msg}\n`);
    } else {
      await appendLog(sessionId, `[dirigo] spawn failed: ${msg}\n`);
    }
    notifyWorkMode(sessionId, s.workMode);
    return;
  }

  // V5-13: агенты без аргумент-промпта (freebuff) — пишем задачу в stdin
  if (def.stdinPrompt && proc.stdin) {
    try {
      proc.stdin.write(prompt + "\n");
      await proc.stdin.end();
    } catch (e) {
      await appendLog(sessionId, `[dirigo] stdin write failed: ${String(e)}\n`);
    }
  }

  addProc(sessionId, proc);
  // Гонка «стоп пришёл, пока сессия была queued»: пользователь остановил ещё
  // до старта — гасим только что spawn'нутый процесс и не запускаем статус в running.
  if (sessions.get(sessionId)?.status === "stopped") {
    killTree(proc);
    dropProc(sessionId, proc);
    await appendLog(sessionId, "[dirigo] остановлена до старта — процесс не запущен\n");
    notifyWorkMode(sessionId, s.workMode);
    return;
  }
  await sessions.setStatus(sessionId, "running");
  await sessions.setPid(sessionId, proc.pid);
  // Агент пошёл заново — старой отметки «процесс ушёл» больше нет.
  await sessions.setAgentExitAt(sessionId, 0);

  // Два способа «зависнуть молча», оба встречались на реальных агентах:
  //  1) CLI на самом деле открывает полноэкранный TUI (ESC[?1049h — альт-экран)
  //     и ждёт клавиш, которых в режиме задачи никто не нажмёт;
  //  2) процесс жив, но ничего не пишет — сессия вечно висит в running.
  // Оба случая теперь заканчиваются понятной ошибкой, а не бесконечностью.
  let lastOutputAt = Date.now();
  let tuiDetected = false;
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    for await (const chunk of stream) {
      const text = decoder.decode(chunk);
      lastOutputAt = Date.now();
      if (!tuiDetected && ALT_SCREEN.test(text)) {
        tuiDetected = true;
        await appendLog(sessionId,
          `\n[dirigo] ${def.label} открыл полноэкранный интерфейс вместо выполнения задачи.\n` +
          `  Этот агент в режиме «Задача (CLI)» ждёт нажатий клавиш — задача так не выполнится.\n` +
          `  Запустите его в режиме «Терминал (TUI)».\n`);
        stoppedByUser.delete(sessionId);
        killTree(proc);
      }
      await appendLogRotated(sessionId, text);
    }
  };
  pump(proc.stdout).catch(() => {});
  pump(proc.stderr).catch(() => {});

  // Сторож тишины: процесс жив и молчит дольше лимита — гасим и объясняем.
  let silent = false;
  const watchdog = setInterval(() => {
    if (!procs.get(sessionId)?.has(proc)) return;
    if (Date.now() - lastOutputAt < CLI_SILENCE_MS) return;
    silent = true;
    void appendLog(sessionId,
      `\n[dirigo] ${def.label} не выдал ни строки за ${Math.round(CLI_SILENCE_MS / 60000)} мин — сессия остановлена.\n` +
      `  Обычно это значит, что агент ждёт ввода (авторизация, подтверждение) или завис.\n` +
      `  Проверьте \`${argv[0]}\` в терминале вручную, либо запустите режим «Терминал (TUI)».\n`);
    killTree(proc);
  }, 15_000);

  const code = await proc.exited;
  clearInterval(watchdog);
  // Сессия может жить несколькими запусками («send» поднимает отдельный
  // процесс на каждое сообщение). Итоговый статус ставит ТОЛЬКО последний
  // ушедший процесс: иначе короткое сообщение объявляло сессию завершённой,
  // пока основной агент ещё работал — и набор e2e-cli сносил его рабочую
  // папку вместе с правками.
  const stillAlive = dropProc(sessionId, proc);
  const wasStopped = stoppedByUser.has(sessionId); //true — остановили кнопкой «Стоп»
  if (stillAlive) {
    await sessions.setPid(sessionId, livePid(sessionId)); // pid остаётся живым
  } else {
    stoppedByUser.delete(sessionId);
    await sessions.setPid(sessionId, null);
    // Отметка «процесс агента ушёл» — опорная тория для «жив ли агент»:
    // opencode отдаёт ход своему сервису, клиент умирает, а работа идёт
    // дальше (F_VER-4). Правки в копии ПОСЛЕ этого времени — признак живого
    // агента: такую копию сносить нельзя (F_VER-5).
    await sessions.setAgentExitAt(sessionId, Date.now());
  }
  await appendLog(sessionId, `\n[dirigo] exited with code ${code}\n`);
  const fail = tuiDetected
    ? { reason: `${def.label} открывает полноэкранный интерфейс и не умеет выполнять разовую задачу`, fix: "Перезапустите сессию в режиме «Терминал (TUI)»" }
    : silent
      ? { reason: `${def.label} ничего не вывел за ${Math.round(CLI_SILENCE_MS / 60000)} мин и был остановлен`, fix: "Скорее всего агент ждёт ввода — проверьте его запуск в терминале или используйте режим «Терминал (TUI)»" }
      : code === 0 ? undefined
        : (diagnose((await readLogTail(sessionId, 40)).join("\n"), def.label, def.id)
           ?? { reason: `${def.label} завершился с кодом ${code}`, fix: "Откройте журнал сессии — последние строки показывают, на чём он упал" });
  // Жив ещё один запуск сессии — статус остаётся «running»: работа продолжается.
  if (!stillAlive) {
    await sessions.setStatus(sessionId,
      wasStopped && !tuiDetected && !silent ? "stopped" : code === 0 && !tuiDetected && !silent ? "done" : "error",
      wasStopped ? null : code, fail);
  }

  if (!wasStopped) {
    const answer = extractAnswer(await readLogTail(sessionId, 80));
    if (answer) await messages.add(sessionId, "agent", answer);
    // continuity: запоминаем session id агента, чтобы можно было продолжить диалог
    const tailText = (await readLogTail(sessionId, 150)).join("\n");
    const m = tailText.match(/\bses_[A-Za-z0-9]{8,}\b/);
    if (m && !s.externalRef) await sessions.setExternalRef(sessionId, m[0]);
  }

  // v2: ревью-первый — авто-проверки в копии ДО показа результата пользователю
  if (s.worktree) void checksAfterRun(sessionId);

  notifyWorkMode(sessionId, s.workMode);
}

/**
 * Сообщить режиму работы, что сессия закончилась — чем угодно, включая отказ
 * запуска. Без этого рой/план/fusion ждут воркера, который уже никогда не
 * ответит: один неустановленный агент подвешивал весь прогон навсегда.
 */
function notifyWorkMode(sessionId: string, workMode: string | undefined): void {
  if (!workMode || workMode === "solo") return;
  void (async () => {
    try {
      if (workMode === "orchestrator") {
        const { markEpicSessionFinished } = await import("../orchestrator");
        await markEpicSessionFinished(sessionId);
      } else if (workMode === "swarm") {
        const { markWorkerFinished } = await import("../swarm");
        await markWorkerFinished(sessionId);
      } else if (workMode === "fusion") {
        const { markCandidateFinished } = await import("../fusion");
        await markCandidateFinished(sessionId);
      }
    } catch { /* режим выключен/модуль недоступен — не критично */ }
  })();
}

/** Web-режим: запускаем нативный веб-интерфейс агента и ловим URL из вывода. */
async function startWeb(sessionId: string): Promise<void> {
  const s = sessions.get(sessionId)!;
  const def = getAgent(s.agentId)!;
  const w = def.web!;
  const cwd = sessionCwd(s);

  // Внешний web-UI (нет локального сервера) — просто фиксируем ссылку.
  if (w.externalOnly) {
    await appendLog(sessionId, `[dirigo] external web: ${w.externalUrl}\n`);
    // стоп мог прийти, пока мы awaти'ли лог: проверяем ПЕРЕД каждым поднятием статуса
    if (sessions.get(sessionId)?.status === "stopped") return;
    await sessions.setWeb(sessionId, w.externalUrl ?? "");
    if (sessions.get(sessionId)?.status === "stopped") return;
    await sessions.setStatus(sessionId, "running");
    return;
  }

  // Запуск десктоп-приложения как «второго способа» (zcode).
  if (w.launchApp) {
    await appendLog(sessionId, `[dirigo] launching app: ${w.launchApp}\n`);
    try {
      Bun.spawn([w.launchApp], { detached: true, stdio: ["ignore", "ignore", "ignore"] });
      await sessions.setStatus(sessionId, "running");
      await appendLog(sessionId, "[dirigo] приложение запущено (отдельным процессом)\n");
    } catch (e) {
      await appendLog(sessionId, `[dirigo] launch failed: ${String(e)}\n`);
      await sessions.setStatus(sessionId, "error", -1, {
        reason: `Не удалось запустить приложение ${def.label}`,
        fix: `Проверьте путь: ${w.launchApp}`,
      });
    }
    return;
  }

  if (!(await ensureCwd(sessionId, cwd, def.label))) return;
  const port = w.portArg ? await getFreePort() : 0;
  const argv = buildWebArgs(def, cwd, port);

  await appendLog(sessionId, `$ ${argv.join(" ")}\n\n`);
  let proc: Bun.Subprocess;
  try {
    proc = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: secretsEnv(cwd) });
  } catch (e) {
    await sessions.setStatus(sessionId, "error", -1, {
      reason: `Веб-панель ${def.label} не запустилась: ${String(e).includes("ENOENT") ? "исполняемый файл не найден" : String(e).slice(0, 160)}`,
      fix: `Проверьте команду вручную: ${argv.join(" ")}`,
    });
    await appendLog(sessionId, `[dirigo] spawn failed: ${String(e)}\n`);
    return;
  }
  addProc(sessionId, proc);
  await sessions.setPid(sessionId, proc.pid);

  let url = "";
  let token = "";
  const deadline = Date.now() + 20000;
  const pump = async (stream: ReadableStream<Uint8Array>, isErr: boolean) => {
    let buf = "";
    for await (const chunk of stream) {
      const text = buf + decoder.decode(chunk, { stream: true });
      buf = "";
      const lines = text.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        await appendLog(sessionId, (isErr ? "" : "") + line + "\n");
        const info = parseWebOutput(line, port);
        if (info.url && !url) url = info.url;
        if (info.token) token = info.token;
      }
    }
  };
  pump(proc.stdout, false).catch(() => {});
  pump(proc.stderr, true).catch(() => {});

  // ждём появления URL (только для агентов, которые его печатают; kilo remote — не печатает)
  if (w.portArg) {
    while (!url && Date.now() < deadline && proc.exitCode === null && procs.get(sessionId)?.has(proc)) {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  // Автоподключение к панели: <url>?auth_token=base64("<user>:<password>")
  // (opencode web-ui читает параметр и настраивает соединение без экрана pairing).
  let authUrl = url;
  if (w.authTokenUser && url && token) {
    const sep = url.includes("?") ? "&" : "?";
    authUrl = `${url}${sep}auth_token=${Buffer.from(`${w.authTokenUser}:${token}`, "utf8").toString("base64")}`;
  }
  if (url) await sessions.setWeb(sessionId, url, token || undefined, authUrl !== url ? authUrl : undefined);

  // Одноразовая ссылка подключения (для телефона/другого браузера): минтим
  // код через API самого агента. Не критично — авто-вход через auth_token и так работает.
  if (w.authTokenUser && url && token) {
    try {
      const basic = Buffer.from(`${w.authTokenUser}:${token}`, "utf8").toString("base64");
      const r = await fetch(`${url}/api/pair`, { method: "POST", headers: { Authorization: `Basic ${basic}` } });
      if (r.ok) {
        const j = await r.json() as { code?: string };
        if (j.code) await sessions.setPairUrl(sessionId, `${url}/auth/connect/${j.code}`);
      }
    } catch { /* агент без /api/pair — просто не будет кнопки */ }
  }
  // остановили, пока ждали URL/порт — гасим процесс, статус не поднимаем
  if (sessions.get(sessionId)?.status === "stopped") {
    killTree(proc);
    dropProc(sessionId, proc);
    await sessions.setPid(sessionId, null);
    await appendLog(sessionId, "[dirigo] остановлена до готовности — веб-UI не запущен\n");
    return;
  }
  // Веб-режим без адреса открывать нечего: раньше такая сессия вставала в
  // «running» и пользователь жал «Открыть» в пустоту.
  if (w.portArg && !w.relayOnly && !url) {
    killTree(proc);
    dropProc(sessionId, proc);
    await sessions.setPid(sessionId, null);
    await appendLog(sessionId, "[dirigo] веб-панель не сообщила адрес за 20 с — останавливаю\n");
    await sessions.setStatus(sessionId, "error", -1, {
      reason: `${def.label} запустился, но не сообщил адрес веб-панели`,
      fix: "Откройте журнал сессии: обычно агент требует входа или порт занят",
    });
    return;
  }
  await sessions.setStatus(sessionId, "running");
  if (w.relayOnly && !url) {
    await appendLog(sessionId, "[dirigo] релей активен: CLI-сессии этого агента синхронизируются с облаком (кабинет — кнопка «Открыть»)\n");
  }
  await appendLog(sessionId, url
    ? `[dirigo] web ui ready: ${url}${token ? ` (password: ${token})` : ""}\n`
    : "[dirigo] web ui started (URL not detected — смотри лог)\n");

  const code = await proc.exited;
  const stillAlive = dropProc(sessionId, proc);
  const wasStopped = stoppedByUser.has(sessionId);
  if (stillAlive) {
    await sessions.setPid(sessionId, livePid(sessionId));
  } else {
    stoppedByUser.delete(sessionId);
    await sessions.setPid(sessionId, null);
  }
  await appendLog(sessionId, `[dirigo] exited with code ${code}\n`);
  if (!stillAlive) {
    await sessions.setStatus(sessionId, wasStopped ? "stopped" : code === 0 ? "done" : "error", wasStopped ? null : code,
      wasStopped || code === 0 ? undefined
        : { reason: `Веб-панель ${def.label} завершилась с кодом ${code}`, fix: "Журнал сессии содержит вывод агента" });
  }
}

function launchDesktop(exePath: string, sessionId: string): void {
  try {
    Bun.spawn([exePath], { detached: true, stdio: ["ignore", "ignore", "ignore"] });
    sessions.setStatus(sessionId, "running");
  } catch (e) {
    appendLog(sessionId, `[dirigo] launch failed: ${String(e)}\n`);
    sessions.setStatus(sessionId, "error", -1, { reason: `Не удалось открыть приложение: ${exePath}`, fix: "Проверьте, что приложение установлено" });
  }
}

export async function stopSession(sessionId: string): Promise<void> {
  // Отвязанные демоны агента (cline hub) держат папку сессии — гасим и их.
  const cur0 = sessions.get(sessionId);
  if (cur0 && AGENTS_WITH_DAEMONS.has(cur0.agentId)) {
    const dir = sessionCwd(cur0);
    // асинхронно: синхронный powershell замораживал весь демон на остановке
    setTimeout(() => { void killAgentDaemonsAsync(dir).then(() => sweepAgentOrphansAsync(workDir())); }, 1500);   // после выхода самого агента
  }
  const ptyHandle = ptyHandles.get(sessionId);
  if (ptyHandle) {
    stoppedByUser.add(sessionId);
    const pid = ptyHandle.pid;
    ptyHandle.kill();
    // ConPTY гасит только корневой процесс — потомки агента (LSP, серверы)
    // оставались жить и держали папку копии. Добиваем дерево.
    if (process.platform === "win32") void killPidTreeAsync(pid);
    ptyHandles.delete(sessionId);
    await appendLog(sessionId, "[dirigo] pty stopped by user\n");
    await sessions.setStatus(sessionId, "stopped");
    return;
  }
  const set = procs.get(sessionId);
  if (set && set.size) {
    // Гасим ВСЕ запуски сессии, а не только последний: «send» мог поднять
    // второй процесс, и первый оставался жить (в реестре его уже не было).
    stoppedByUser.add(sessionId);
    for (const p of set) killTree(p);
    procs.delete(sessionId);
    await appendLog(sessionId, "[dirigo] stopped by user\n");
    await sessions.setStatus(sessionId, "stopped");
  } else {
    const cur = sessions.get(sessionId);
    if (cur && (cur.status === "running" || cur.status === "queued")) {
      await sessions.setStatus(sessionId, "stopped");
    }
  }
}

/** Перезапуск сессии (тот же режим: cli/web/pty). */
export async function restartSession(sessionId: string): Promise<void> {
  const s = sessions.get(sessionId);
  if (!s) return;
  resetCheckIterations(sessionId); // ручной рестарт — новый шанс авто-доработок
  await stopSession(sessionId);
  await sessions.setStatus(sessionId, "queued");
  if (s.mode === "web") {
    runner.runSession(sessionId, "").catch(() => {});
  } else if (s.mode === "pty") {
    runner.startPty(sessionId).catch(() => {});
  } else if (s.mode === "persistent") {
    // Молчаливый catch оставлял сессию в «queued» навсегда: пользователь жал
    // «Перезапустить» и ничего не происходило. Причину теперь видно.
    runner.startPersistent(sessionId, { resume: false }).catch(async (e) => {
      await appendLog(sessionId, `[dirigo] перезапуск ACP не удался: ${String(e)}\n`);
      if (sessions.get(sessionId)?.status !== "error") {
        await sessions.setStatus(sessionId, "error", -1, {
          reason: `Не удалось переподключить ${getAgent(s.agentId)?.label ?? s.agentId} по ACP`,
          fix: "Откройте журнал сессии — там ответ моста",
        });
      }
    });
  } else if (s.prompt) {
    runner.runSession(sessionId, s.prompt).catch(() => {});
  } else {
    await sessions.setStatus(sessionId, "error", -1, {
      reason: "Нечего перезапускать: у сессии нет задачи",
      fix: "Создайте новую сессию с описанием задачи",
    });
  }
}

export function isRunning(sessionId: string): boolean {
  // PTY- и ACP-сессии живут не в procs: без этого «Остановить» и индикаторы
  // считали живой терминал мёртвым.
  return (procs.get(sessionId)?.size ?? 0) > 0 || ptyHandles.has(sessionId) || persistent.has(sessionId);
}

/* ---------------- persistent (ACP over stdio) ---------------- */

interface PersistentHandle {
  client: AcpClient;
  sessionId: string;   // session id агента
  model?: string;
  busy: boolean;
  /** Номер реплики. Мост не всегда присылает messageId: без него все ответы
   *  склеивались в одно сообщение («ПриветГолубой» вместо двух реплик). */
  turn: number;
  /** Метка подключения. Счётчик turn после переподключения начинается с нуля:
   *  без метки новые ответы получали id прошлых («acp:1:») — дописывались в
   *  старые сообщения посреди ленты, а проверка «агент ответил?» находила
   *  старый ответ, и ход одними размышлениями пропадал из ленты. */
  conn: string;
  /** Идёт session/load: агент проигрывает историю (прошлые реплики), в ленте
   *  они уже есть — повторно не записываем (иначе ответы дублировались). */
  replaying?: boolean;
  stopping?: boolean;  // остановлено пользователем — onExit не лезет со статусом
  heartbeat?: ReturnType<typeof setInterval>;
  /** настройки сессии агента (модели и т.п.) — из session/new|load */
  configOptions?: AcpConfigOption[];
  /** команды, которые агент объявил сам (/model, /compact…) */
  commands?: { name: string; description: string }[];
  /** сообщения, пришедшие, пока агент отвечал: уйдут сразу после хода */
  queue?: string[];
}
const persistent = new Map<string, PersistentHandle>();

/* ── Ход работы живого диалога (ACP) ──
   Пока модель думает, агент шлёт размышления, вызовы инструментов и план —
   раньше всё это уходило только в журнал, и в ленте десятки секунд было
   пусто: «кажется, ничего не происходит». Теперь это видно в пульте. */
export interface AcpActivity {
  busy: boolean;
  since: number;                 // когда ушла реплика пользователя
  phase: "connecting" | "waiting" | "thinking" | "tool" | "writing" | "plan";
  thought: string;               // хвост размышлений текущего хода
  tools: { id: string; title: string; status: string }[];
  plan: { content: string; status: string }[];
  updatedAt: number;
}
const acpActivity = new Map<string, AcpActivity>();
/** Размышления текущего хода целиком (до 8 КБ): если агент ответил только ими. */
const turnThought = new Map<string, string>();
const activityTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function getAcpActivity(sessionId: string): AcpActivity | null {
  return acpActivity.get(sessionId) ?? null;
}

/** Изменение хода работы → событие в пульт (не чаще 4 раз в секунду). */
function touchActivity(sessionId: string, patch: Partial<AcpActivity>, now = false): void {
  const cur = acpActivity.get(sessionId) ?? { busy: false, since: Date.now(), phase: "waiting" as const, thought: "", tools: [], plan: [], updatedAt: 0 };
  const next = { ...cur, ...patch, updatedAt: Date.now() };
  acpActivity.set(sessionId, next);
  const fire = () => { activityTimers.delete(sessionId); emit({ type: "session.activity", sessionId, activity: acpActivity.get(sessionId) } as never); };
  if (now) { clearTimeout(activityTimers.get(sessionId)); fire(); return; }
  if (!activityTimers.has(sessionId)) activityTimers.set(sessionId, setTimeout(fire, 250));
}

/** Модели агента для «/model»: из настроек ACP-сессии. */
export function acpModelOptions(sessionId: string): { current: string; options: { value: string; name: string }[] } | null {
  const opt = persistent.get(sessionId)?.configOptions?.find((o) => o.id === "model" || o.category === "model");
  return opt ? { current: opt.currentValue, options: opt.options ?? [] } : null;
}

/** Сменить модель живого диалога (configOption «model»). */
export async function setAcpModel(sessionId: string, model: string): Promise<string> {
  const h = persistent.get(sessionId);
  if (!h) throw new Error("диалог не подключён — нажмите «Перезапустить»");
  const res = await h.client.setConfigOption(h.sessionId, "model", model);
  if (res?.configOptions) h.configOptions = res.configOptions;
  h.model = model;
  await sessions.setAcpModel(sessionId, model);
  await appendLog(sessionId, `[dirigo] модель: ${model}\n`);
  return model;
}

/** Команды, объявленные агентом по ACP (без «/»). */
export function acpCommands(sessionId: string): { name: string; description: string }[] {
  return persistent.get(sessionId)?.commands ?? [];
}

/** Незакрытые вопросы агента: id вопроса → как его разрешить. */
const pendingChoices = new Map<string, (optionId: string) => void>();

/** Сколько ждём решения человека, прежде чем отменить действие агента. */
const CHOICE_WAIT_MS = Number(process.env.DIRIGO_CHOICE_WAIT_MS ?? 15 * 60_000);

/** Показать вопрос в ленте и дождаться выбора пользователя. */
async function askUser(sessionId: string, question: string, options: { id: string; label: string; kind?: string }[]): Promise<string> {
  const choiceId = `ch_${Math.random().toString(36).slice(2, 10)}`;
  await sessions.setChoice(sessionId, { id: choiceId, question, options, at: Date.now() });
  await appendLog(sessionId, `\n[dirigo] агент просит решение: ${question}\n  варианты: ${options.map((o) => o.label).join(" | ")}\n`);
  return await new Promise<string>((resolve) => {
    const timer = setTimeout(() => {
      pendingChoices.delete(choiceId);
      void sessions.setChoice(sessionId, null);
      void appendLog(sessionId, "[dirigo] ответа не было — действие отменено по таймауту\n");
      resolve(options.find((o) => /reject|deny|no|cancel/i.test(o.kind ?? o.id))?.id ?? options[options.length - 1]!.id);
    }, CHOICE_WAIT_MS);
    pendingChoices.set(choiceId, (optionId) => {
      clearTimeout(timer);
      pendingChoices.delete(choiceId);
      void sessions.setChoice(sessionId, null);
      resolve(optionId);
    });
  });
}

/** Ответ пользователя на вопрос агента. */
export function answerChoice(choiceId: string, optionId: string): boolean {
  const fn = pendingChoices.get(choiceId);
  if (!fn) return false;
  fn(optionId);
  return true;
}

/** Сколько ждём ответа ACP-моста на рукопожатие, прежде чем признать его мёртвым. */
const ACP_HANDSHAKE_MS = Number(process.env.DIRIGO_ACP_TIMEOUT_MS ?? 45_000);

/** Ждать обещание не дольше лимита: иначе «запущено» висит вечно без признаков жизни. */
async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}: нет ответа за ${Math.round(ms / 1000)} с`)), ms); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

/** Старт (или переподключение) ACP-сессии. resume=false — всегда новая session/new. */
export async function startPersistent(sessionId: string, opts: { resume?: boolean; model?: string; firstPrompt?: boolean } = {}): Promise<void> {
  const s = sessions.get(sessionId);
  const def = getAgent(String(s?.agentId));
  if (!s || !def?.acp) throw new Error("agent has no acp mode");

  // уже подключены — ничего не делаем
  if (persistent.has(sessionId)) return;

  // Рабочая папка — копия сессии, если она есть. Раньше живой диалог всегда
  // работал в исходном проекте: агент правил оригинал, а «Изменения» сравнивали
  // нетронутую копию с изменённым проектом — правки выглядели удалёнными, а
  // «Открыть в редакторе» показывало копию без них.
  const cwd = sessionCwd(s);
  if (!(await ensureCwd(sessionId, cwd, def.label))) throw new Error(`рабочая папка не найдена: ${cwd}`);
  // Строку запуска пишем СРАЗУ, до рукопожатия: оно может занять десятки
  // секунд (особенно если агент не авторизован), и всё это время сессия стояла
  // в «очереди» с пустым журналом — выглядело как «ничего не происходит».
  await appendLog(sessionId, `\n$ ${def.acp.command.join(" ")}  [acp]\n\n[dirigo] подключаюсь к ${def.label} по ACP…\n`);
  // Рукопожатие ACP занимает до десятков секунд — показываем это в ленте
  touchActivity(sessionId, { busy: true, since: Date.now(), phase: "connecting", thought: "", tools: [], plan: [] }, true);
  if (def.id === "cline") await ensureClineHub(def.command);
  const client = new AcpClient(def.acp.command, cwd);
  // stderr моста — в журнал сессии: там лежит настоящая причина, тогда как по
  // протоколу приходит безликое «Internal error».
  client.onStderr = (text) => { void appendLog(sessionId, text.split("\n").filter(Boolean).map((l) => `[acp] ${l}\n`).join("")); };
  const handle: PersistentHandle = { client, sessionId: s.externalRef ?? "", busy: false, turn: 0, conn: Date.now().toString(36), model: opts.model };
  persistent.set(sessionId, handle);

  client.onExit = (code) => {
    const h = persistent.get(sessionId);
    if (h?.heartbeat) clearInterval(h.heartbeat);
    persistent.delete(sessionId);
    void sessions.setPid(sessionId, null);
    // пережить перезапуск сервера должны persistent-сессии, но не «убитые вручную»
    if (!h?.stopping && s.status === "running" && s.persistent) {
      void sessions.setStatus(sessionId, "error", code, {
        reason: `ACP-мост ${def.label} завершился с кодом ${code}`,
        fix: "Нажмите «Перезапустить»; если повторяется — проверьте установку моста",
      });
      void appendLog(sessionId, `[dirigo] ACP-процесс завершился (код ${code}) — переподключение через «Перезапустить»\n`);
    }
  };

  // Агент просит разрешение и предлагает варианты — показываем их кнопками и
  // ждём человека. Без этого он стоял в ожидании ответа, которого никто не
  // мог дать: в ленте была только оборванная реплика.
  client.onRequest = async (method, params) => {
    if (method === "session/request_permission") {
      const opts = (params?.options ?? []) as { optionId?: string; name?: string; kind?: string }[];
      const question = String(params?.toolCall?.title ?? params?.title ?? "Агент просит разрешение");
      const options = opts.map((o, i) => ({
        id: String(o.optionId ?? i),
        label: String(o.name ?? o.optionId ?? `вариант ${i + 1}`),
        kind: o.kind,
      }));
      if (!options.length) return { outcome: { outcome: "cancelled" } };
      const picked = await askUser(sessionId, question, options);
      return { outcome: { outcome: "selected", optionId: picked } };
    }
    throw new Error(`метод ${method} не поддерживается пультом`);
  };

  client.onUpdate = (u) => {
    // история при переподключении — уже в ленте; команды и настройки берём
    if (handle.replaying && (u.kind === "message" || u.kind === "thought" || u.kind === "user_message" || u.kind === "raw")) return;
    const act = acpActivity.get(sessionId);
    if (u.kind === "message" && u.text) {
      void messages.appendChunk(sessionId, acpMsgId(handle.conn, handle.turn, u.messageId), "agent", u.text);
      if (act?.busy && act.phase !== "writing") touchActivity(sessionId, { phase: "writing" });
    } else if (u.kind === "user_message" && u.text) void appendLog(sessionId, `[acp] user: ${u.text}\n`);
    else if (u.kind === "thought" && u.text) {
      void appendLog(sessionId, `[acp] thought: ${u.text}\n`);
      if (act?.busy) {
        turnThought.set(sessionId, ((turnThought.get(sessionId) ?? "") + u.text).slice(-8000));
        touchActivity(sessionId, { phase: "thinking", thought: (act.thought + u.text).slice(-1200) });
      }
    } else if (u.kind === "usage") void appendLog(sessionId, `[acp] usage: ${u.used}/${u.size} tokens${u.cost ? `, cost ${u.cost.amount} ${u.cost.currency}` : ""}\n`);
    else if (u.kind === "available_commands") handle.commands = u.commands;
    else if (u.kind === "raw" && act?.busy) {
      const up = u.update ?? {};
      if (up.sessionUpdate === "tool_call" || up.sessionUpdate === "tool_call_update") {
        const id = String(up.toolCallId ?? up.id ?? act.tools.length);
        const tools = act.tools.slice();
        const i = tools.findIndex((t) => t.id === id);
        const title = String(up.title ?? (i >= 0 ? tools[i]!.title : "инструмент"));
        const status = String(up.status ?? (i >= 0 ? tools[i]!.status : "pending"));
        if (i >= 0) tools[i] = { id, title, status }; else tools.push({ id, title, status });
        void appendLog(sessionId, `[acp] tool: ${title} — ${status}\n`);
        touchActivity(sessionId, { phase: "tool", tools: tools.slice(-12) });
      } else if (up.sessionUpdate === "plan" && Array.isArray(up.entries)) {
        touchActivity(sessionId, { phase: "plan", plan: up.entries.map((e: any) => ({ content: String(e.content ?? ""), status: String(e.status ?? "") })).slice(0, 12) });
      }
    }
  };

  await withTimeout(client.initialize(), ACP_HANDSHAKE_MS, "ACP initialize").catch(async (e) => {
    touchActivity(sessionId, { busy: false }, true);
    persistent.delete(sessionId);
    try { await client.dispose(); } catch { /* мост уже мёртв */ }
    await appendLog(sessionId,
      `[dirigo] ACP-мост «${def.acp!.command[0]}» не ответил на рукопожатие: ${String(e)}\n` +
      `  Проверьте, что мост установлен и запускается руками: ${def.acp!.command.join(" ")}\n`);
    await sessions.setStatus(sessionId, "error", -1, {
      reason: `ACP-мост для ${def.label} не отвечает`,
      fix: `Проверьте команду вручную: ${def.acp!.command.join(" ")}`,
    });
    throw e;
  });

  let loaded = false;
  if (opts.resume !== false && s.externalRef) {
    handle.replaying = true;
    try {
      const ld = await withTimeout(client.loadSession(s.externalRef, cwd, await sessionMcpServers(def.id)), ACP_HANDSHAKE_MS, "ACP session/load");
      if (ld?.configOptions) handle.configOptions = ld.configOptions;
      handle.sessionId = s.externalRef;
      loaded = true;
      await appendLog(sessionId, `[dirigo] ACP-сессия переподключена: ${s.externalRef}\n`);
    } catch (e) {
      await appendLog(sessionId, `[dirigo] ACP load не удался (${String(e)}) — создаём новую сессию\n`);
    } finally {
      // хвост проигрыша может прийти сразу после ответа на session/load
      await Bun.sleep(300);
      handle.replaying = false;
    }
  }
  // Переподключение не удалось, хотя его просили: агент начнёт НОВУЮ нить и
  // прежний контекст ему недоступен. Молча терять это нельзя — переписка
  // в пульте остаётся, а агент её не помнит, и это надо сказать прямо.
  const threadLost = !loaded && opts.resume !== false && !!s.externalRef;
  if (!loaded) {
    // База знаний в session/new — дополнение, а не условие запуска: если агент
    // отверг сервер, повторяем без него и пишем причину в журнал.
    const mcp = await sessionMcpServers(def.id);
    const newSess = mcp.length
      ? client.newSession(cwd, mcp).catch(async (e) => {
          await appendLog(sessionId, `[dirigo] агент не принял MCP базы знаний (${String(e).slice(0, 120)}) — сессия без неё\n`);
          return client.newSession(cwd, []);
        })
      : client.newSession(cwd, []);
    const created = await withTimeout(newSess, ACP_HANDSHAKE_MS, "ACP session/new").catch(async (e) => {
      touchActivity(sessionId, { busy: false }, true);
      persistent.delete(sessionId);
      try { await client.dispose(); } catch { /* мост уже мёртв */ }
      await appendLog(sessionId, `[dirigo] ACP session/new не удался: ${String(e)}\n`);
      // Протокольный «Internal error» ничего не объясняет — берём последнюю
      // внятную строку из stderr моста, пользователь должен понять причину.
      const hint = client.stderrTail.filter((l) => /error|cannot|failed|denied|login|auth/i.test(l)).pop();
      await sessions.setStatus(sessionId, "error", -1, {
        reason: hint ? `${def.label}: ${hint.slice(0, 180)}` : `${def.label} не создал ACP-сессию`,
        fix: hint ? "Подробности — в журнале сессии" : "Возможно агент требует авторизации — запустите его CLI вручную и войдите",
      });
      throw e;
    });
    handle.sessionId = created.sessionId;
    handle.configOptions = created.configOptions;
    await sessions.setExternalRef(sessionId, created.sessionId);
    await appendLog(sessionId, `[dirigo] ACP-сессия создана: ${created.sessionId}\n`);
    if (threadLost) {
      await appendLog(sessionId, "[dirigo] прежнюю нить агента восстановить не удалось — он начал новую и не помнит прошлых сообщений\n");
      await messages.add(sessionId, "agent",
        "⚠️ Соединение поднято заново: агент начал новую нить и не помнит прошлую переписку. История выше сохранена в пульте — при необходимости повторите контекст.");
    }
  }

  const model = handle.model ?? def.acp.defaultModel;
  if (model) {
    try {
      const res = await client.setConfigOption(handle.sessionId, "model", model);
      if (res?.configOptions) handle.configOptions = res.configOptions;
      await sessions.setAcpModel(sessionId, model);
      await appendLog(sessionId, `[dirigo] модель: ${model}\n`);
    } catch (e) {
      await appendLog(sessionId, `[dirigo] не удалось выставить модель ${model}: ${String(e)}\n`);
    }
  }

  await sessions.setPid(sessionId, client.pid);
  // подключились: если сразу пойдёт первое сообщение — пузырь не гасим (таймер непрерывный)
  if (!handle.busy && !opts.firstPrompt) touchActivity(sessionId, { busy: false }, true);
  // стоп мог прийти во время initialize/session/load — не поднимаем статус поверх stopped
  if (handle.stopping || sessions.get(sessionId)?.status === "stopped") return;
  await sessions.setStatus(sessionId, "running");

  // heartbeat: раз в 30 с проверяем живость процессara (session/list дешёвый)
  handle.heartbeat = setInterval(() => {
    client.listSessions().catch(() => { /* смерть поймает onExit */ });
  }, 30000);
}

/** Отправка сообщения в живую ACP-сессию (с авто-реконнектом). */
export async function sendPersistentMessage(sessionId: string, text: string, opts: { recorded?: boolean } = {}): Promise<void> {
  // Сообщение записываем ПЕРВЫМ делом. Раньше оно добавлялось уже после
  // переподключения, и если мост не поднимался — текст пользователя исчезал
  // бесследно: «ввожу команду, жму Send, ничего не происходит».
  if (!opts.recorded) await messages.add(sessionId, "user", text);
  if (!persistent.has(sessionId)) await startPersistent(sessionId, { resume: true });
  const handle = persistent.get(sessionId);
  if (!handle) throw new Error("acp session not started");
  // Агент ещё отвечает — сообщение в очередь, а не ошибка: раньше уточнение,
  // отправленное во время ответа, переводило всю сессию в «Ошибку».
  if (handle.busy) {
    (handle.queue ??= []).push(text);
    await appendLog(sessionId, `[dirigo] сообщение в очереди — уйдёт после текущего ответа агента\n`);
    return;
  }
  await runTurn(sessionId, handle, text);
}

/** Один ход живого диалога: реплика → ответ агента; затем очередь. */
async function runTurn(sessionId: string, handle: PersistentHandle, text: string): Promise<void> {
  handle.busy = true;
  handle.turn += 1;                       // новая реплика — новое сообщение агента
  // первый ход сразу после подключения: таймер идёт с начала подключения
  const prevAct = acpActivity.get(sessionId);
  const since = prevAct?.busy && prevAct.phase === "connecting" ? prevAct.since : Date.now();
  touchActivity(sessionId, { busy: true, since, phase: "waiting", thought: "", tools: [], plan: [] }, true);
  turnThought.delete(sessionId);
  await sessions.setStatus(sessionId, "running");
  try {
    const res = await handle.client.prompt(handle.sessionId, text);
    await appendLog(sessionId, `[acp] stop: ${res.stopReason}${res.usage?.totalTokens ? `, tokens ${res.usage.totalTokens}` : ""}\n`);
    // Ход закончился, а агент ничего не написал (например, на «/model» или
    // пустой ответ модели) — говорим это в ленте, а не оставляем тишину.
    const turnMsgs = turnReplies(messages.list(sessionId), handle.conn, handle.turn);
    if (!turnMsgs.length) {
      // Модели с рассуждениями иногда кончают ход одними размышлениями — тогда
      // показываем их, а не прячем в журнал: там бывает весь ответ.
      const thought = (turnThought.get(sessionId) ?? "").trim();
      // какие инструменты агент вызвал в этом ходе — иначе непонятно, что он делал
      const tools = (acpActivity.get(sessionId)?.tools ?? []).map((t) => t.title.replace(/^Call(?:ing|ed)\s+/i, ""));
      const counts = [...new Set(tools)].map((t) => { const n = tools.filter((x) => x === t).length; return n > 1 ? `${t} ×${n}` : t; });
      const toolNote = counts.length ? ` Инструменты: ${counts.join(", ")}.` : "";
      if (thought) {
        await messages.add(sessionId, "agent", thought);
        await messages.add(sessionId, "system", `Агент ответил только размышлениями — показаны выше.${toolNote}`);
      } else await messages.add(sessionId, "system", `Агент завершил ход без ответа (${res.stopReason}).${toolNote}`);
    }
  } finally {
    handle.busy = false;
    touchActivity(sessionId, { busy: false }, true);
  }
  // очередь: следующее сообщение — сразу после хода (уже записано в ленту)
  const next = handle.queue?.shift();
  if (next !== undefined && persistent.get(sessionId) === handle) await runTurn(sessionId, handle, next);
}

/** Остановка persistent-сессии (мягкое закрытие + убийство процесса). */
export async function stopPersistent(sessionId: string): Promise<void> {
  const handle = persistent.get(sessionId);
  if (handle) {
    handle.stopping = true; // onExit не должен переписать статус в error
    if (handle.heartbeat) clearInterval(handle.heartbeat);
    persistent.delete(sessionId);
    await handle.client.dispose(handle.sessionId).catch(() => {});
  }
  await sessions.setPid(sessionId, null);
  await sessions.setStatus(sessionId, "stopped", 0);
}

/* ---------------- PTY-терминал (интерактивные агенты) ---------------- */

const ptyHandles = new Map<string, PtyHandle>();

/** Запуск интерактивной сессии через PTY (hermes --tui, devin REPL). */
/** Экраны живых PTY-сессий: поток терминала, разобранный в сетку для UI. */
const screens = new Map<string, Screen>();

/** Снимок экрана терминала сессии (null — сессия не в режиме терминала). */
export function ptyScreen(sessionId: string): ReturnType<Screen["snapshot"]> | null {
  return screens.get(sessionId)?.snapshot() ?? null;
}

/** Видимый текст экрана — для детекта «агент ждёт входа» и готовности ввода. */
export function ptyScreenText(sessionId: string): string {
  return screens.get(sessionId)?.plain() ?? "";
}

/* ── Живой поток терминала для браузера (xterm.js) ──
   Браузер получает снимок текущего кадра (serialize) и дальше — сырые куски
   вывода по мере поступления. Так экран в пульте рисует настоящий эмулятор,
   а не перерисовка сетки раз в 700 мс. */
export type PtyStreamEvent =
  | { t: "init"; cols: number; rows: number; data: string; live: boolean }
  | { t: "d"; data: string }
  | { t: "exit"; code: number };
const ptySubs = new Map<string, Set<(e: PtyStreamEvent) => void>>();

function ptyBroadcast(sessionId: string, e: PtyStreamEvent): void {
  for (const fn of ptySubs.get(sessionId) ?? []) { try { fn(e); } catch { /* закрытый поток */ } }
}

/** Подписка на экран сессии: сразу init-снимок, затем живые куски. */
export function ptyAttach(sessionId: string, fn: (e: PtyStreamEvent) => void): (() => void) | null {
  const screen = screens.get(sessionId);
  if (!screen) return null;
  let set = ptySubs.get(sessionId);
  if (!set) ptySubs.set(sessionId, (set = new Set()));
  // Снимок и подписка — в одном синхронном шаге: между ними не проскочит кусок.
  fn({ t: "init", cols: screen.cols, rows: screen.rows, data: screen.serialize(), live: ptyHandles.has(sessionId) });
  set.add(fn);
  return () => { set!.delete(fn); if (!set!.size) ptySubs.delete(sessionId); };
}

/** Последний размер окна терминала: по сессии и общий — новая сессия
 *  стартует сразу в размере окна пульта, без лишней перерисовки. */
const lastPtySize = new Map<string, { cols: number; rows: number }>();
let lastAnyPtySize: { cols: number; rows: number } | null = null;

/** Ждущие первого размера от пульта сессии (до запуска агента). */
const sizeWaiters = new Map<string, () => void>();
const PTY_SIZE_WAIT_MS = Number(process.env.DIRIGO_PTY_SIZE_WAIT_MS ?? 2500);

/**
 * Дождаться, пока пульт сообщит размер окна, — но не дольше timeoutMs.
 * TUI вроде Claude Code (ink) рисует в обычном буфере: если стартовать в
 * 120 колонках, а через долю секунды ужать до 105, эмулятор переносит уже
 * нарисованные строки, а агент затирает их по старым расчётам — экран
 * «рвался» и строки дублировались. Поэтому агент стартует сразу в размере окна.
 */
function waitForClientSize(sessionId: string, timeoutMs: number): Promise<void> {
  if (lastPtySize.has(sessionId)) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { clearTimeout(t); sizeWaiters.delete(sessionId); resolve(); };
    const t = setTimeout(done, timeoutMs);
    sizeWaiters.set(sessionId, done);
  });
}

/** Размер терминала под окно пульта: PTY + экран. Возвращает итоговый размер. */
export function ptyResize(sessionId: string, cols: number, rows: number): { cols: number; rows: number } | null {
  const screen = screens.get(sessionId);
  if (!screen) return null;
  const c = Math.max(20, Math.min(400, Math.floor(cols)));
  const r = Math.max(5, Math.min(200, Math.floor(rows)));
  const h = ptyHandles.get(sessionId);
  // Провайдер без resize (script(1) на Linux) держит исходный размер — тогда и
  // экран не трогаем, а браузер подстраивается под фактический размер.
  if (h?.resizable === false) return { cols: screen.cols, rows: screen.rows };
  try { h?.resize(c, r); } catch { /* процесс закрылся */ }
  const changed = screen.cols !== c || screen.rows !== r;
  screen.resize(r, c);
  // Пульт получает кадр в новом размере от демона. Если браузер менял размер
  // сам, куски вывода, пришедшие между двумя resize, раскладывались двумя
  // эмуляторами по-разному — экран пульта расходился с экраном агента.
  if (changed) ptyBroadcast(sessionId, { t: "init", cols: screen.cols, rows: screen.rows, data: screen.serialize(), live: ptyHandles.has(sessionId) });
  lastPtySize.set(sessionId, { cols: c, rows: r });
  lastAnyPtySize = { cols: c, rows: r };
  sizeWaiters.get(sessionId)?.();
  return { cols: screen.cols, rows: screen.rows };
}

/** Цвета темы пульта: ими терминал «представляется» агенту (OSC 10/11, COLORFGBG). */
let uiTermColors: TermColors = LIGHT_COLORS;
export function setTermColors(c: Partial<TermColors>): TermColors {
  const ok = (v: unknown) => typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v);
  uiTermColors = { fg: ok(c.fg) ? c.fg! : uiTermColors.fg, bg: ok(c.bg) ? c.bg! : uiTermColors.bg };
  for (const sc of screens.values()) sc.setColors(uiTermColors);
  return uiTermColors;
}
const isLight = isLightColor;

/**
 * Командная строка TUI сессии. Флаги — только те, что TUI агента точно
 * принимает (scripts/tui-flags-test.ts проверяет запуском): флаги CLI-режима
 * и TUI у агентов разные. opencode без подкоманды не знает --model и падал
 * «Unrecognized flag: --model», kilo на --variant печатает справку и выходит.
 */
export function ptyLaunchArgv(def: AgentDef, s: { model?: string; reasoning?: string; loginSession?: boolean }): string[] {
  if (!def.ptyCommand) return [];
  if (s.loginSession && def.auth?.loginArgs?.length) return [...def.ptyCommand.command, ...def.auth.loginArgs];
  return [
    ...def.ptyCommand.command,
    ...(s.model && def.ptyCommand.modelFlag ? [def.ptyCommand.modelFlag, s.model] : []),
    ...(def.ptyCommand.reasoning ? reasoningArgs(def, s.reasoning) : []),
  ];
}

export async function startPty(sessionId: string): Promise<void> {
  const s = sessions.get(sessionId);
  if (!s) throw new Error("session not found");
  const def = getAgent(s.agentId);
  if (!def?.ptyCommand) throw new Error("agent has no pty mode");
  const cwd = sessionCwd(s);
  // Сессия входа запускает ту же программу с её командой login — чтобы
  // авторизоваться ОДИН раз, а не ловить код в каждой рабочей сессии.
  // Выбранные в диалоге модель и уровень рассуждений доходят и до TUI — теми
  // же флагами, что у CLI (TUI-режимы этих агентов их принимают).
  const argv = ptyLaunchArgv(def, s);

  // node-pty опционален: без него честно гасим сессию с понятной причиной,
  // а не падаем 500-кой (и тем более не роняем демон).
  const { spawnPty, ptyStatus, PTY_HINT } = await import("./pty");
  const st = await ptyStatus();
  if (!st.available) {
    const why = `[dirigo] режим PTY недоступен на этой машине: ${st.reason ?? PTY_HINT}\n`;
    await appendLog(sessionId, why);
    await sessions.setStatus(sessionId, "error", 1, {
      reason: "Режим терминала требует нативный модуль node-pty, а он не собран",
      fix: "Выполните bun install в каталоге установки (нужны python3, make и компилятор C++)",
    });
    throw new Error(`PTY недоступен: ${st.reason ?? PTY_HINT}`);
  }

  if (!(await ensureCwd(sessionId, cwd, def.label))) throw new Error(`рабочая папка не найдена: ${cwd}`);
  // Перезапуск: прежний экран и его подписчиков заменяем новым.
  screens.get(sessionId)?.dispose();
  const size = lastPtySize.get(sessionId) ?? lastAnyPtySize ?? { cols: 120, rows: 36 };
  const screen = new Screen(size.rows, size.cols);
  screen.colors = uiTermColors;
  screens.set(sessionId, screen);
  // Пульт уже смотрит на эту сессию (перезапуск) — сбросить его экран на новый.
  ptyBroadcast(sessionId, { t: "init", cols: screen.cols, rows: screen.rows, data: "", live: true });
  await appendLog(sessionId, `$ ${argv.join(" ")}  [pty]\n\n`);
  // Окно пульта ещё не прислало размер — ждём его (пульт подключается к
  // потоку за доли секунды после создания сессии), затем стартуем.
  await waitForClientSize(sessionId, PTY_SIZE_WAIT_MS);
  const real = lastPtySize.get(sessionId) ?? size;
  screen.resize(real.rows, real.cols);
  // Ответы эмулятора (позиция курсора, цвета) идут обратно агенту. До того,
  // как spawn вернул handle, копим их — агент спрашивает в первых байтах.
  let live: PtyHandle | null = null;
  const early: string[] = [];
  screen.onResponse = (r) => { if (live) live.write(r); else early.push(r); };
  let handle: Awaited<ReturnType<typeof spawnPty>>;
  if (def.id === "cline") await ensureClineHub(def.command);
  try {
    handle = await spawnPty(argv[0]!, argv.slice(1), {
    cwd,
    cols: screen.cols,
    rows: screen.rows,
    // Светлая/тёмная тема пульта: COLORFGBG читают TUI, которые не умеют OSC 11.
    env: { COLORFGBG: isLight(uiTermColors.bg) ? "0;15" : "15;0" },
    onData: (chunk) => {
      screen.feed(chunk);                       // эмулятор — источник правды экрана
      ptyBroadcast(sessionId, { t: "d", data: chunk });
      void appendLogRotated(sessionId, chunk);  // сырой поток — в журнал (с потолком)
    },
    onExit: (code) => {
      ptyHandles.delete(sessionId);
      ptyBroadcast(sessionId, { t: "exit", code });
      // экран оставляем: после выхода пользователь должен видеть последний кадр
      void sessions.setPid(sessionId, null);
      const wasStopped = stoppedByUser.delete(sessionId);
      void appendLog(sessionId, `\n[dirigo] pty exited with code ${code}\n`);
      // Сессия входа закончилась — перепроверить вход сразу, а не через минуту:
      // иначе диалог старта ещё показывал бы «Войти один раз».
      if (sessions.get(sessionId)?.loginSession) void import("./availability").then((m) => m.refreshAuthFor(def.id)).catch(() => {});
      void sessions.setStatus(sessionId, wasStopped ? "stopped" : code === 0 ? "done" : "error", wasStopped ? null : code,
        wasStopped || code === 0 ? undefined
          : { reason: `${def.label} в терминале завершился с кодом ${code}`, fix: "Последние строки терминала показывают причину" });
      // v2: авто-проверки копии после работы агента
      if (!wasStopped && sessions.get(sessionId)?.worktree) void checksAfterRun(sessionId);
    },
  });
  } catch (e) {
    // Терминал не поднялся (нет бинаря, нет прав на tty) — сессия должна умереть
    // с объяснением, а не остаться в queued навсегда.
    await appendLog(sessionId, `[dirigo] терминал не запустился: ${String(e)}\n`);
    await sessions.setStatus(sessionId, "error", -1, {
      reason: `Не удалось открыть терминал для ${def.label}`,
      fix: `Проверьте команду вручную: ${argv.join(" ")}`,
    });
    throw e;
  }
  ptyHandles.set(sessionId, handle);
  live = handle;
  for (const r of early.splice(0)) handle.write(r);
  await sessions.setPid(sessionId, handle.pid);
  await sessions.setStatus(sessionId, "running");

  // Задача, написанная при создании сессии, не должна исчезать: TUI-агенту её
  // надо напечатать. Ждём, пока интерфейс поднимется (первый вывод + пауза),
  // и отправляем — в журнале видно, что именно ушло.
  const task = (sessions.get(sessionId)?.prompt ?? "").trim();
  if (task && task !== def.ptyCommand.label) void deliverTask(sessionId, screen, handle, task);
}

/**
 * Печатает задачу в TUI — но только когда интерфейс действительно готов её
 * принять.
 *
 * Первая версия просто ждала фиксированные 3.5 с и печатала. На практике
 * агент в этот момент показывал экран входа («Open this URL… Waiting for
 * login»), задача уходила в пустоту, а пользователь видел зависший терминал и
 * свою задачу нигде. Теперь: ждём, пока экран перестанет меняться, и если он
 * просит авторизацию — ничего не печатаем, а прямо говорим об этом.
 */
async function deliverTask(sessionId: string, screen: Screen, handle: PtyHandle, task: string): Promise<void> {
  // Пока агент требует входа, ждём долго (вход руками через браузер);
  // если входа не требуется, ждём лишь готовности интерфейса.
  const budgetMs = PTY_AUTH_WAIT_MS;
  const deadline = Date.now() + budgetMs;
  let lastRev = -1;
  let stableSince = Date.now();
  let announcedAuth = false;
  let announcedUrl = false;
  let firstOutputAt = 0;
  let attempts = 0;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    if (!ptyHandles.has(sessionId)) return;                 // сессию остановили
    if (screen.rev > 0 && !firstOutputAt) firstOutputAt = Date.now();
    const changed = screen.rev !== lastRev;
    if (changed) { lastRev = screen.rev; stableSince = Date.now(); }
    // Готовность: экран затих ИЛИ прошло PTY_READY_MAX_MS с первого вывода.
    // Анимированные TUI (kilo с бегущими подсказками) не затихают никогда —
    // раньше задача ждала их 10 минут и так и не уходила.
    const quiet = !changed && Date.now() - stableSince >= PTY_QUIET_MS;
    const longEnough = firstOutputAt > 0 && Date.now() - firstOutputAt >= PTY_READY_MAX_MS;
    if (!quiet && !longEnough) continue;

    const auth = detectAuthPrompt(screen.plain());
    if (auth?.expired) {
      await appendLog(sessionId,
        `\n[dirigo] ${auth.label}. Задача не отправлена.\n` +
        `  Нажмите «Перезапустить» — и войдите один раз, не открывая несколько сессий сразу.\n`);
      await sessions.setAuthPrompt(sessionId, auth);
      return;
    }
    if (auth) {
      // Вход — дело пользователя и занимает сколько займёт. Задачу держим,
      // а не теряем: как только агент перестанет просить авторизацию, отправим.
      if (!announcedAuth) {
        announcedAuth = true;
        await appendLog(sessionId, auth.kind === "choice"
          ? `\n[dirigo] ${auth.label} (доверие к папке, тема и т.п.). Задача придержана и уйдёт сразу после ответа.\n`
          : `\n[dirigo] ${auth.label}. Задача придержана и уйдёт сразу после входа.\n` +
            (auth.url ? `  Ссылка для входа: ${auth.url}\n` : "  Нажмите Enter в терминале — агент покажет ссылку входа.\n"));
        await sessions.setAuthPrompt(sessionId, auth);
      } else if (auth.url && !announcedUrl) {
        announcedUrl = true;
        await appendLog(sessionId, `[dirigo] ссылка для входа: ${auth.url}\n`);
        await sessions.setAuthPrompt(sessionId, auth);
      }
      stableSince = Date.now();                   // ждём дальше, не торопясь
      continue;
    }
    if (announcedAuth) { announcedAuth = false; await sessions.setAuthPrompt(sessionId, null); }
    // Отправка с подтверждением: задача должна появиться на экране агента.
    // Иначе (TUI ещё грузился и выбросил ввод, вопрос всплыл в момент набора)
    // она терялась молча — пользователь видел пустое поле агента.
    attempts++;
    const probe = task.replace(/\s+/g, " ").trim().slice(0, 24);
    await writePtyLine(sessionId, task);
    let seen = false;
    for (let i = 0; i < 16 && !seen; i++) {
      await new Promise((r) => setTimeout(r, 250));
      seen = screen.plain().replace(/\s+/g, " ").includes(probe);
    }
    if (seen || attempts >= PTY_DELIVER_ATTEMPTS) {
      await appendLog(sessionId, seen
        ? `\n[dirigo] задача отправлена в терминал: ${task.slice(0, 120)}\n`
        : `\n[dirigo] задача отправлена в терминал, но агент её не показал (${attempts} попытки) — проверьте поле ввода агента: ${task.slice(0, 120)}\n`);
      await messages.add(sessionId, "user", task);
      return;
    }
    await appendLog(sessionId, `[dirigo] агент ещё не принял ввод — повторю отправку задачи\n`);
    stableSince = Date.now();
    firstOutputAt = Date.now() - PTY_READY_MAX_MS + 2000;   // следующая попытка — через ~2 с
  }
  await appendLog(sessionId,
    `\n[dirigo] терминал так и не пришёл в готовность за ${Math.round(budgetMs / 60000)} мин — задачу не отправляю, ` +
    `чтобы она не попала в чужое поле ввода. Напишите её вручную, когда агент ответит.\n`);
}

/**
 * Экран просит авторизацию? Признаки у CLI-агентов однотипные: ссылка входа,
 * «waiting for login», «not authenticated», «run X login».
 */
export function detectAuthPrompt(text: string): { label: string; url?: string; expired?: boolean; kind?: "choice" } | null {
  const low = text.toLowerCase();
  // Агент задал вопрос-выбор: «доверяете папке?» (claude, cursor, devin),
  // «переключить тему?» (devin). Каждая копия проекта — новая папка, поэтому
  // вопрос о доверии встречается постоянно. Напечатать в него задачу нельзя:
  // Enter выбирает подсвеченный пункт, а у claude это «No, exit» — агент
  // закрывался сразу после старта. Ждём ответа человека, как при входе.
  // Смотрим только на низ экрана: ink-агенты (cursor) после ответа рисуют
  // основной интерфейс ПОД старым окном вопроса, и его текст остаётся выше.
  // По всему экрану вопрос «висел» вечно — задача не уходила, поле ввода
  // было заблокировано.
  // Вопрос активен, только если ПОД его последней строкой почти ничего нет
  // (рамка окна, подсказка клавиш). Появился интерфейс ниже — вопрос отвечен.
  const rows = low.split("\n").filter((l) => l.trim());
  let lastQ = -1;
  rows.forEach((l, i) => { if (CHOICE_RE.test(l)) lastQ = i; });
  if (lastQ >= 0 && rows.length - 1 - lastQ <= CHOICE_TAIL_LINES) {
    return { label: "Агент ждёт ответа в терминале", kind: "choice" };
  }
  // Код входа протух: так бывает, когда открыто несколько сессий и каждая
  // показала свой код. Это отдельное состояние — ждать тут нечего, нужен
  // перезапуск, и пользователю надо сказать об этом прямо.
  if (/login (timed out|expired)|code (has )?expired|срок кода истёк/.test(low)) {
    return { label: "Код входа истёк — нужен повторный запуск", expired: true };
  }
  const waiting = /waiting for (login|authentication)|press enter to (log ?in|authenticate)|not (logged in|authenticated)|please (log ?in|sign in)|run .{0,20}login|authentication required|требуется вход|войдите/.test(low);
  // Ссылка входа — это /login, /signin, /device, /activate, /oauth, /authorize
  // или код авторизации в адресе. Голое «auth» в пути ловило и страницы
  // оплаты («…/api/auth/checkout?tier=pro» при исчерпанном лимите cursor),
  // и пульт показывал ложное «Агент ждёт входа в аккаунт».
  const loginUrl = (text.match(/https?:\/\/[^\s"'<>()\]]+/g) ?? []).find((u) =>
    /(\/|\b)(login|signin|sign-in|device|activate|oauth|authorize)\b|[?&](auth_code|user_code|code)=/i.test(u)
    && !/checkout|upgrade|billing|pricing|subscribe|dashboard|docs?\b/i.test(u));
  if (!waiting && !loginUrl) return null;
  return { label: "Агент ждёт входа в аккаунт", url: loginUrl };
}

/** Строка вопроса-выбора агента (доверие к папке, тема) или подсказки его клавиш. */
const CHOICE_RE = /do you trust|trust this folder|workspace trust|trust the (authors|contents|files)|detected (light|dark) theme|switch theme\?|enter to (confirm|select|choose)|↑↓ (to )?select|↓↑ (to )?select|use arrow keys to navigate/;
/** Сколько непустых строк может стоять под вопросом, чтобы он ещё считался активным. */
const CHOICE_TAIL_LINES = 4;

/** Сколько экран должен не меняться, чтобы считать интерфейс готовым. */
const PTY_QUIET_MS = Number(process.env.DIRIGO_PTY_QUIET_MS ?? 1200);
/** Анимированный TUI не затихает: готовым считаем через столько после первого вывода. */
const PTY_READY_MAX_MS = Number(process.env.DIRIGO_PTY_READY_MAX_MS ?? 6000);
/** Сколько раз пробовать отправить задачу, пока она не появится на экране агента. */
const PTY_DELIVER_ATTEMPTS = 3;
/** Потолок ожидания: вход в аккаунт пользователь делает руками через браузер. */
const PTY_AUTH_WAIT_MS = Number(process.env.DIRIGO_PTY_READY_MS ?? 10 * 60_000);

/** Ввод в живую PTY-сессию. */
/**
 * Отправить строку в TUI как «набрал и нажал Enter».
 *
 * Текст и возврат каретки идут ДВУМЯ записями с паузой. Одной записью TUI
 * принимает это за вставку из буфера: текст попадает в поле ввода, а Enter
 * внутри вставки считается переносом строки — сообщение так и висит набранным
 * и никуда не уходит. Ровно так «нижнее поле не передавалось в терминал».
 */
export async function writePtyLine(sessionId: string, text: string): Promise<boolean> {
  const h = ptyHandles.get(sessionId);
  if (!h) return false;
  // Многострочная задача: каждый \n в наборе TUI принимал за Enter и
  // отправлял текст кусками. Если агент понимает bracketed paste — шлём
  // вставкой (переводы строк остаются внутри поля), Enter — отдельно.
  // Окно пульта для агента всегда «в фокусе»: TUI на opentui (freebuff)
  // выбрасывают ввод, пока считают окно неактивным, а нижнее поле ввода как
  // раз уводит фокус из терминала. Перед вводом подтверждаем фокус.
  if (screens.get(sessionId)?.focusReporting) h.write("\x1b[I");
  const multi = /\r?\n/.test(text);
  if (multi && screens.get(sessionId)?.bracketedPaste) h.write(`\x1b[200~${text.replace(/\r?\n/g, "\r")}\x1b[201~`);
  else h.write(multi ? text.replace(/\r?\n/g, " ") : text);
  await new Promise((r) => setTimeout(r, PTY_SUBMIT_DELAY_MS));
  if (!ptyHandles.has(sessionId)) return false;      // сессию успели остановить
  h.write("\r");
  return true;
}

/** Пауза между набором текста и Enter — чтобы TUI не счёл это вставкой. */
const PTY_SUBMIT_DELAY_MS = Number(process.env.DIRIGO_PTY_SUBMIT_DELAY_MS ?? 120);

export function writePty(sessionId: string, data: string): boolean {
  const h = ptyHandles.get(sessionId);
  if (!h) return false;
  h.write(data);
  return true;
}

/* ---------------- авто-проверки копии (V2-2.2, ревью-первый) ---------------- */

/** Счётчик автоматических доработок по сессиям (максимум 2 итерации). */
const checkIterations = new Map<string, number>();
const MAX_CHECK_ITERATIONS = 2;
/** Выключить авто-прогон: DIRIGO_AUTO_CHECKS=0 (ручной триггер остаётся). */
const AUTO_CHECKS = process.env.DIRIGO_AUTO_CHECKS !== "0";

/**
 * Доотправка задачи агенту в его родном режиме: persistent — живое сообщение,
 * cli — перезапуск в той же сессии (лог дописывается), pty — ввод в терминал.
 */
async function sendFollowUp(sessionId: string, text: string): Promise<string> {
  const s = sessions.get(sessionId);
  if (!s) return "нет сессии";
  if (s.persistent) {
    await sendPersistentMessage(sessionId, text);
    return "ACP follow-up отправлен";
  }
  if (s.mode === "pty") {
    await writePtyLine(sessionId, text);
    return "введено в PTY";
  }
  if (s.mode === "cli") {
    void runSession(sessionId, text).catch(async (e) => {
      await appendLog(sessionId, `[dirigo] повторный запуск не удался: ${String(e)}\n`);
    });
    return "перезапуск cli-агента с правками";
  }
  return "режим без авто-доработки — вернись вручную";
}

/**
 * Авто-проверки после работы агента в копии: прогон в копии → при фейле
 * возврат агенту (до 2 итераций) → затем пометка «нужен человек».
 * Идемпотентна по (sessionId + revision): ручной вызов тоже считается итерацией.
 */
export async function checksAfterRun(sessionId: string): Promise<void> {
  const s = sessions.get(sessionId);
  if (!s?.worktree?.path || !existsSync(s.worktree.path)) return;
  // Задача закончилась, файлы не изменились, а в ответе агента — патч или жалоба
  // на права записи (`claude -p` без прав печатал код вместо правок). Снаружи
  // это выглядело успехом: «done», пустой дифф. Говорим это в ленте.
  try {
    const { diffWorktree } = await import("../worktrees");
    if (!diffWorktree(sessionId).files.length) {
      const { readLogTail } = await import("../store");
      const tail = (await readLogTail(sessionId, 300)).join("\n");
      if (looksLikeUnappliedPatch(tail)) {
        await messages.add(sessionId, "system", "Агент закончил без изменений в файлах, хотя в ответе есть патч или жалоба на права записи — правки не применены. Посмотрите журнал или запустите задачу снова.");
        await appendLog(sessionId, "[dirigo] пустой дифф при патче в ответе агента — правки не применены\n");
      }
    }
  } catch { /* дифф не снялся — не повод мешать проверкам */ }
  if (!AUTO_CHECKS) return;
  const iteration = checkIterations.get(sessionId) ?? 0;

  const report = await runChecksOverride(s.worktree.path, s.verifyCommand);
  // Журнал происхождения: прогон проверок — факт, который потом попадёт в
  // пакет доказательств. Запись никогда не должна ронять работу агента.
  try {
    const { record } = await import("../provenance");
    record(sessionId, "checks.run", {
      source: report.source ?? null,
      command: report.outcomes.map((o) => o.command).join("; "),
      ok: report.ok,
      durationMs: report.outcomes.reduce((a, o) => a + o.durationMs, 0),
      iteration,
    });
  } catch { /* провенанс не критичен для выполнения задачи */ }
  await sessions.addCheck(sessionId, {
    command: report.source ? `${report.source}: ${report.outcomes.map((o) => o.command).join("; ")}` : "проверки не обнаружены",
    ok: report.ok,
    output: report.outcomes.map((o) => `$ ${o.command}\n${o.output}`).join("\n\n") || "нет команд проверок в проекте",
    durationMs: report.outcomes.reduce((a, o) => a + o.durationMs, 0),
    at: Date.now(),
  });

  if (!report.source) {
    await appendLog(sessionId, `[dirigo] авто-проверки не обнаружены — можно смотреть дифф и применять\n`);
    return;
  }
  if (report.ok) {
    await appendLog(sessionId, `[dirigo] авто-проверки пройдены (${report.source ?? "?"}) — можно смотреть дифф и применять\n`);
    return;
  }

  // Ни одной команды проверок не найдено — «упавших» нет тоже. Слать агенту
  // пустой фидбек (две строки без причины) бессмысленно: исправлять нечего,
  // а итерация доработки сгорает. Возврат — только при реально упавшей команде.
  if (!report.source) {
    await appendLog(sessionId, `[dirigo] в проекте нет команд авто-проверок — возврат агенту не требуется\n`);
    return;
  }

  if (iteration >= MAX_CHECK_ITERATIONS) {
    await appendLog(sessionId, `[dirigo] авто-проверки упали ${iteration + 1}-й раз подряд — нужен человек (открой дифф и разберись)\n`);
    return;
  }
  checkIterations.set(sessionId, iteration + 1);
  try {
    const { record } = await import("../provenance");
    record(sessionId, "checks.returned", {
      iteration: iteration + 1,
      failed: report.outcomes.filter((o) => !o.ok).map((o) => o.command),
    });
  } catch { /* см. выше */ }
  const how = await sendFollowUp(sessionId, checksFeedbackPrompt(report));
  await appendLog(sessionId, `[dirigo] авто-проверки упали → возврат агенту (${how})\n`);
}

/** Сброс счётчика доработок (при ручном перезапуске сессии). */
export function resetCheckIterations(sessionId: string): void {
  checkIterations.delete(sessionId);
}

export const runner = { runSession, stopSession, restartSession, isRunning, startPersistent, sendPersistentMessage, stopPersistent, startPty, writePty, writePtyLine, answerChoice, checksAfterRun, ptyAttach, ptyResize, setTermColors, getAcpActivity, acpModelOptions, setAcpModel, acpCommands };

/** В тексте ответа агента — патч или отказ в праве записи (а файлы не изменились). */
export function looksLikeUnappliedPatch(text: string): boolean {
  return /```(?:diff|patch)\b|^\+\+\+ b\/|^@@ -\d+(?:,\d+)? \+\d+/m.test(text)
    || /couldn'?t (?:write|edit|modify)|can(?:no|')t (?:write|edit|modify)|(?:write|edit) permission|permission (?:was |is )?denied|not (?:allowed|permitted) to (?:write|edit)/i.test(text)
    || /не (?:смог|могу|удалось) (?:записать|изменить|сохранить)|нет прав (?:на )?запис/i.test(text);
}
