#!/usr/bin/env bun
// Экран терминала (режим PTY) + детект «агент ждёт входа».
// Запуск: bun run scripts/screen-test.ts
import { Screen } from "../src/agents/screen";
import { detectAuthPrompt } from "../src/agents/runner";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  ok ? pass++ : fail++;
};
const ESC = "\x1b";

/* ── базовая сетка ── */
{
  const s = new Screen(5, 20);
  s.feed("привет");
  check("текст попадает в сетку", s.plain().split("\n")[0] === "привет", JSON.stringify(s.plain().split("\n")[0]));
  s.feed("\r\nвторая");
  check("перевод строки", s.plain().split("\n")[1] === "вторая");
  s.feed(`${ESC}[1;1H`);
  check("курсор домой (CUP)", s.cursorRow === 0 && s.cursorCol === 0, `${s.cursorRow},${s.cursorCol}`);
  s.feed(`${ESC}[2J`);
  check("очистка экрана", s.plain().trim() === "");
}

/* ── позиционирование и очистка строки ── */
{
  const s = new Screen(4, 10);
  s.feed(`${ESC}[3;5Hметка`);
  const lines = s.plain().split("\n");
  check("CUP ставит в нужную строку/столбец", lines[2] === "    метка", JSON.stringify(lines[2]));
  s.feed(`${ESC}[3;5H${ESC}[K`);
  check("EL очищает до конца строки", s.plain().split("\n")[2] === "");
}

/* ── альтернативный экран: признак полноэкранного TUI ── */
{
  const s = new Screen(3, 10);
  s.feed("обычный");
  s.feed(`${ESC}[?1049h`);
  check("вход в alt-экран", s.alt === true);
  // Как в настоящем xterm: 1049 не двигает курсор, TUI ставит его сам (CUP).
  s.feed(`${ESC}[Htui`);
  check("alt-экран чистый", s.plain().split("\n")[0] === "tui" && !s.plain().includes("обычный"), JSON.stringify(s.plain().split("\n")[0]));
  s.feed(`${ESC}[?1049l`);
  check("выход из alt-экрана возвращает прежний", s.alt === false && s.plain().split("\n")[0] === "обычный");
}

/* ── цвета ── */
{
  const s = new Screen(1, 10);
  s.feed(`${ESC}[31mкрасный${ESC}[0m`);
  const snap = s.snapshot();
  check("SGR: цвет текста сохранён", !!snap.lines[0]!.spans[0]!.fg, String(snap.lines[0]!.spans[0]!.fg));
  const s2 = new Screen(1, 10);
  s2.feed(`${ESC}[38;2;10;20;30mrgb`);
  check("SGR: truecolor", s2.snapshot().lines[0]!.spans[0]!.fg === "rgb(10,20,30)", String(s2.snapshot().lines[0]!.spans[0]!.fg));
}

/* ── устойчивость к разрыву последовательности между порциями ── */
{
  const s = new Screen(3, 20);
  s.feed(`текст${ESC}[2`);         // порция оборвалась внутри CSI
  s.feed(";3Hтут");
  const lines = s.plain().split("\n");
  check("CSI, разорванная между порциями, собирается", lines[1] === "  тут", JSON.stringify(lines[1]));
  check("мусор ESC не попал в текст", !s.plain().includes("\x1b"));
}

/* ── OSC (заголовок окна) не должен попадать на экран ── */
{
  const s = new Screen(2, 20);
  s.feed(`${ESC}]0;заголовок\x07видно`);
  check("OSC проглочен", s.plain().split("\n")[0] === "видно", JSON.stringify(s.plain().split("\n")[0]));
}

/* ── скролл при переполнении ── */
{
  const s = new Screen(2, 10);
  s.feed("раз\r\nдва\r\nтри");
  const lines = s.plain().split("\n");
  check("экран прокручивается", lines[0] === "два" && lines[1] === "три", JSON.stringify(lines));
}

/* ── детект «агент ждёт входа» ── */
{
  const cases: [string, boolean][] = [
    ["Waiting for login...", true],
    ["Press ENTER to login...", true],
    ["Open this URL in your browser to login:\nhttps://freebuff.com/login?auth_code=x", true],
    ["You are not logged in. Run `claude /login`", true],
    ["Authentication required", true],
    ["$ готов к работе, введите задачу", false],
    ["Loading files... 120 indexed\nhttps://docs.example.com/guide", false],
    ["Ready. Type your task:", false],
  ];
  for (const [text, expect] of cases) {
    check(`детект входа: ${JSON.stringify(text.split("\n")[0]!.slice(0, 40))}`, !!detectAuthPrompt(text) === expect);
  }
  const withUrl = detectAuthPrompt("Open this URL in your browser to login:\nhttps://freebuff.com/login?auth_code=abc");
  check("детект входа: ссылка извлечена", withUrl?.url === "https://freebuff.com/login?auth_code=abc", String(withUrl?.url));
}

/* ── вопрос-выбор агента: задачу в него печатать нельзя ── */
{
  const trust = detectAuthPrompt("Accessing workspace:\n Quick safety check: Is this a project you created or one you trust?\n ❯ No, exit\n   Yes, I trust this folder\n Enter to confirm · Esc to cancel");
  check("детект: диалог доверия claude — ждём ответа", trust?.kind === "choice", JSON.stringify(trust));
  check("детект: Workspace Trust cursor", detectAuthPrompt("⚠ Workspace Trust Required\nDo you trust the contents of this directory?\n▶ [a] Trust this workspace\n  [q] Quit\nUse arrow keys to navigate, Enter to select, or press the key shown\n╰───╯")?.kind === "choice");
  check("детект: смена темы devin", detectAuthPrompt("Detected light theme but configured for dark. Switch?\n❭ 1 Yes, switch theme")?.kind === "choice");
  check("детект: обычное приглашение — не вопрос", detectAuthPrompt("❯ Try \"write a test\"\n  ⏵⏵ auto mode on (shift+tab to cycle)") === null);
  // cursor после ответа: окно вопроса осталось выше, основной интерфейс — ниже
  const answered = ["╭───╮", "│ ⚠ Workspace Trust Required │", "│ Cursor Agent can execute code and access files in this directory. │",
    "│ Do you trust the contents of this directory? │", "│ ▶ [a] Trust this workspace │", "│   [q] Quit │",
    "│ Use arrow keys to navigate, Enter to select, or press the key shown │", "╰───╯", "",
    "  Cursor Agent", "  v2026.10.16-e3cb207", "  Tip: Use /plan to iterate on an implementation plan", "  → Plan, search, build anything",
    "  Auto", "  ~\\proj · main"].join("\n");
  check("детект: старый вопрос выше основного экрана — не вопрос", detectAuthPrompt(answered) === null, JSON.stringify(detectAuthPrompt(answered)));
}

/* ── ссылка оплаты/тарифа — не страница входа ── */
{
  const limit = "Error: You've hit your usage limit\nchatMessage: *You've hit your free requests limit. [Upgrade to Pro](https://cursor.com/api/auth/checkoutDeepControl?tier=pro) for more usage";
  check("детект: лимит тарифа со ссылкой оплаты — не вход", detectAuthPrompt(limit) === null, JSON.stringify(detectAuthPrompt(limit)));
  check("детект: device-код — вход", !!detectAuthPrompt("Visit https://github.com/login/device and enter code ABCD-1234")?.url);
  check("детект: oauth authorize — вход", !!detectAuthPrompt("Open https://claude.ai/oauth/authorize?client_id=x&code=true")?.url);
}

/* ── просроченный код входа — отдельное состояние ── */
{
  const exp = detectAuthPrompt("Error: Login timed out. Please try again.\nPlease restart the CLI and try again");
  check("детект: код входа истёк", exp?.expired === true, JSON.stringify(exp));
  const wait = detectAuthPrompt("Waiting for login...");
  check("детект: ожидание входа — не истёкший код", wait !== null && !wait.expired);
}

/* ── модель со строки состояния агента ── */
{
  const { screenModelForTest } = await import("../src/server-model");
  check("модель с экрана: берётся строка с «•»",
    screenModelForTest("DeepSeek V4.1 Flash • high · /путь · /model to\nchange · Chat: привет\n← for history") === "DeepSeek V4.1 Flash",
    String(screenModelForTest("DeepSeek V4.1 Flash • high · /путь\nchange · Chat: привет")));
  check("модель с экрана: строка состояния с «·» не выдаётся за модель",
    screenModelForTest("change · Chat: New chat\n← for history · ? for help") === null);
}

/* ── то, на чём ломался самописный парсер: TUI держатся именно на этом ── */
{
  const s = new Screen(5, 10);
  // область прокрутки строк 2–4: перевод строки внизу двигает только её
  s.feed(`шапка${ESC}[2;4r${ESC}[2;1Ha\r\nb\r\nc\r\nd${ESC}[r`);
  const l = s.plain().split("\n");
  check("DECSTBM: шапка вне области не уезжает", l[0] === "шапка" && l[1] === "b" && l[3] === "d", JSON.stringify(l));
  const w = new Screen(2, 10);
  w.feed("中文ab");
  check("широкие символы занимают две клетки", w.cursorCol === 6 && w.plain().split("\n")[0] === "中文ab", `${w.cursorCol} ${JSON.stringify(w.plain())}`);
  const e = new Screen(2, 10);
  e.feed("😀x");
  check("эмодзи (суррогатная пара) — один символ", e.plain().split("\n")[0] === "😀x", JSON.stringify(e.plain().split("\n")[0]));
  const d = new Screen(2, 5);
  d.feed("abcde");
  check("отложенный перенос: 5 символов в 5 колонках не создают строку", d.cursorRow === 0, `row=${d.cursorRow}`);
}

/* ── ответы на запросы терминала: TUI ждут их при старте ── */
{
  const s = new Screen(5, 20);
  const got: string[] = [];
  s.onResponse = (r) => got.push(r);
  s.colors = { fg: "#111111", bg: "#fafbfc" };
  s.feed(`ab${ESC}[6n${ESC}[c${ESC}]11;?\x07`);
  check("DSR 6n → позиция курсора", got.includes(`${ESC}[1;3R`), JSON.stringify(got));
  check("DA → атрибуты устройства", got.some((r) => r.startsWith(`${ESC}[?`) && r.endsWith("c")), JSON.stringify(got));
  check("OSC 11 → цвет фона темы пульта", got.includes(`${ESC}]11;rgb:fafa/fbfb/fcfc${ESC}\\`), JSON.stringify(got));
}

/* ── светлая/тёмная схема: opentui (opencode) ждёт CSI ? 997 n после DECSET 2031 ── */
{
  const s = new Screen(5, 20);
  const got: string[] = [];
  s.onResponse = (r) => got.push(r);
  s.colors = { fg: "#111111", bg: "#ffffff" };
  s.feed(`${ESC}[?2031h`);
  await Promise.resolve();
  check("DECSET 2031 → схема «светлая» (997;2)", got.includes(`${ESC}[?997;2n`), JSON.stringify(got));
  got.length = 0;
  s.setColors({ fg: "#eeeeee", bg: "#101010" });
  check("смена темы пульта → уведомление «тёмная» (997;1)", got.includes(`${ESC}[?997;1n`), JSON.stringify(got));
  got.length = 0;
  s.feed(`${ESC}[?996n`);
  check("CSI ? 996 n → текущая схема", got.includes(`${ESC}[?997;1n`), JSON.stringify(got));
  const q = new Screen(5, 20);
  const none: string[] = [];
  q.onResponse = (r) => none.push(r);
  q.setColors({ fg: "#000000", bg: "#ffffff" });
  check("без подписки 2031 уведомлений нет", none.length === 0, JSON.stringify(none));
}

/* ── снимок экрана для браузера, подключившегося посреди сессии ── */
{
  const src = new Screen(6, 30);
  src.feed(`обычный экран\r\n${ESC}[?1049h${ESC}[2;3H${ESC}[38;2;200;10;10mкрасный${ESC}[0m ${ESC}[1mжирный${ESC}[0m${ESC}[5;1Hподвал`);
  const dst = new Screen(6, 30);
  dst.feed(src.serialize());
  check("serialize: текст кадра совпадает", dst.plain() === src.plain(), JSON.stringify(dst.plain()));
  check("serialize: alt-экран сохранён", dst.alt === true);
  check("serialize: цвет сохранён", JSON.stringify(dst.snapshot().lines[1]) === JSON.stringify(src.snapshot().lines[1]));
  check("serialize: курсор на месте", dst.cursorRow === src.cursorRow && dst.cursorCol === src.cursorCol, `${dst.cursorRow},${dst.cursorCol} vs ${src.cursorRow},${src.cursorCol}`);
}

/* ── bracketed paste: режим агента виден демону ── */
{
  const s = new Screen(3, 20);
  check("bracketed paste выключен по умолчанию", s.bracketedPaste === false);
  s.feed(`${ESC}[?2004h`);
  check("DECSET 2004 → bracketed paste включён", s.bracketedPaste === true);
}

/* ── снимок для UI ── */
{
  const s = new Screen(2, 8);
  s.feed("ab");
  const snap = s.snapshot();
  check("снимок: размер и курсор", snap.rows === 2 && snap.cols === 8 && snap.cursor.col === 2, JSON.stringify(snap.cursor));
  check("снимок: строки как отрезки", Array.isArray(snap.lines) && snap.lines[0]!.spans.length >= 1);
  const rev = snap.rev;
  s.feed("c");
  check("ревизия растёт при изменении", s.snapshot().rev > rev);
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
