// Экран терминала: поток PTY → настоящий эмулятор VT (xterm.js headless).
//
// Зачем это здесь. Режим «Терминал (TUI)» запускает агента в настоящем
// псевдотерминале, и агент рисует интерфейс управляющими последовательностями.
// Раньше поток разбирал самописный парсер: без областей прокрутки (DECSTBM),
// отложенного переноса, широких символов и суррогатных пар. Современные TUI
// (opentui у opencode, ink у claude) держатся именно на этом — и экран
// «повторялся и перемешивался». Теперь экран ведёт @xterm/headless, тот же
// эмулятор, что рисует терминал в VS Code.
//
// Вторая задача — отвечать на запросы терминала. TUI при старте спрашивает
// позицию курсора (CSI 6n), атрибуты устройства (CSI c) и цвета фона/текста
// (OSC 10/11): по фону он выбирает светлую или тёмную палитру. Отвечает демон —
// сразу, даже когда пульт ещё не открыт; браузерный терминал запросы глушит,
// чтобы агент не получил ответ дважды.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// Вендоренная копия (scripts/vendor-xterm.ts): бандл ставится без node_modules.
const { Terminal } = require("../vendor/xterm-headless.cjs") as { Terminal: new (o: object) => HeadlessTerminal };
const { SerializeAddon } = require("../vendor/addon-serialize.cjs") as { SerializeAddon: new () => { serialize(o?: object): string } };
const { Unicode11Addon } = require("../vendor/addon-unicode11.cjs") as { Unicode11Addon: new () => object };

/* Минимальный срез API @xterm/headless, которым мы пользуемся. */
interface BufferCell {
  getChars(): string; getWidth(): number;
  isBold(): number; isInverse(): number; isDim(): number; isItalic(): number; isUnderline(): number;
  isFgRGB(): boolean; isBgRGB(): boolean; isFgPalette(): boolean; isBgPalette(): boolean;
  getFgColor(): number; getBgColor(): number;
}
interface BufferLine { translateToString(trimRight?: boolean): string; getCell(x: number): BufferCell | undefined; length: number; }
interface Buffer { type: "normal" | "alternate"; cursorX: number; cursorY: number; baseY: number; getLine(y: number): BufferLine | undefined; }
interface HeadlessTerminal {
  rows: number; cols: number;
  buffer: { active: Buffer };
  parser: { registerOscHandler(id: number, cb: (data: string) => boolean): { dispose(): void } };
  onData(cb: (d: string) => void): { dispose(): void };
  resize(cols: number, rows: number): void;
  loadAddon(a: object): void;
  dispose(): void;
  _core: { writeSync(d: string): void; coreService: { isCursorHidden: boolean } };
  unicode: { activeVersion: string };
}

export interface Cell { ch: string; fg?: string; bg?: string; bold?: boolean; inv?: boolean; }
export interface ScreenState {
  rows: number;
  cols: number;
  cursor: { row: number; col: number; visible: boolean };
  /** true — агент занял весь экран (alt-screen): это полноценный TUI */
  alt: boolean;
  /** номер ревизии: UI перерисовывает только при изменении */
  rev: number;
}
type Span = { text: string; fg?: string; bg?: string; bold?: boolean; inv?: boolean };

/** Цвета, которыми терминал «представляется» агенту в ответ на OSC 10/11. */
export interface TermColors { fg: string; bg: string; }
export const DARK_COLORS: TermColors = { fg: "#e6e8ee", bg: "#14161c" };
export const LIGHT_COLORS: TermColors = { fg: "#1f2328", bg: "#ffffff" };

export class Screen {
  private term: HeadlessTerminal;
  private ser = new SerializeAddon();
  rev = 0;
  /** Ответы терминала на запросы агента — их надо записать обратно в PTY. */
  onResponse: ((data: string) => void) | null = null;
  colors: TermColors = DARK_COLORS;

  constructor(rows = 40, cols = 160) {
    this.term = new Terminal({ rows, cols, scrollback: 1000, allowProposedApi: true, logLevel: "off" });
    this.term.loadAddon(this.ser);
    // Ширины символов как у агентов (string-width ≈ Unicode 11+): иначе эмодзи
    // и значки занимали одну клетку вместо двух, и строки TUI съезжали.
    this.term.loadAddon(new Unicode11Addon());
    this.term.unicode.activeVersion = "11";
    this.term.onData((d) => { try { this.onResponse?.(d); } catch { /* PTY уже закрыт */ } });
    // OSC 10/11/12 «?» — запрос цвета текста/фона/курсора. По ответу TUI
    // выбирает палитру: так агент в светлой теме пульта рисует светлый экран,
    // а не тёмные полосы поверх белой страницы.
    const answer = (id: number, color: () => string) =>
      this.term.parser.registerOscHandler(id, (data) => {
        if (data !== "?") return false;
        this.onResponse?.(`\x1b]${id};${xrgb(color())}\x1b\\`);
        return true;
      });
    answer(10, () => this.colors.fg);
    answer(11, () => this.colors.bg);
    answer(12, () => this.colors.fg);
    // Светлая/тёмная схема (протокол contour, им пользуется opentui у opencode):
    // приложение включает DECSET 2031 и ждёт `CSI ? 997 ; 1|2 n`, а уже потом
    // спрашивает OSC 10/11. xterm.js этого не умеет — без ответа opencode
    // навсегда оставался тёмным поверх светлого пульта. CSI ? 996 n — запрос.
    const p = this.term.parser as unknown as {
      registerCsiHandler(id: { prefix?: string; final: string }, cb: (params: (number | number[])[]) => boolean): void;
    };
    const modes = (params: (number | number[])[]) => params.map((x) => (Array.isArray(x) ? x[0] : x));
    p.registerCsiHandler({ prefix: "?", final: "h" }, (params) => {
      if (modes(params).includes(2031)) { this.schemeReports = true; queueMicrotask(() => this.reportScheme()); }
      return false;                                   // остальные режимы — штатно
    });
    p.registerCsiHandler({ prefix: "?", final: "l" }, (params) => {
      if (modes(params).includes(2031)) this.schemeReports = false;
      return false;
    });
    p.registerCsiHandler({ prefix: "?", final: "n" }, (params) => {
      if (modes(params)[0] !== 996) return false;
      this.reportScheme();
      return true;
    });
    // DECRQM по 2031: «поддерживается, включён/выключен» — иначе xterm.js
    // отвечал «не знаю такого режима», и приложение могло его не включать.
    (p as unknown as { registerCsiHandler(id: { prefix: string; intermediates: string; final: string }, cb: (params: (number | number[])[]) => boolean): void })
      .registerCsiHandler({ prefix: "?", intermediates: "$", final: "p" }, (params) => {
        if (modes(params)[0] !== 2031) return false;
        this.onResponse?.(`\x1b[?2031;${this.schemeReports ? 1 : 2}$y`);
        return true;
      });
  }

  /** Приложение подписалось на смену схемы (DECSET 2031). */
  private schemeReports = false;

  /** Сообщить приложению текущую схему: 1 — тёмная, 2 — светлая. */
  private reportScheme(): void {
    this.onResponse?.(`\x1b[?997;${isLightColor(this.colors.bg) ? 2 : 1}n`);
  }

  /** Тема пульта сменилась: TUI с подпиской перекрасится сам, без перезапуска. */
  setColors(c: TermColors): void {
    const changed = isLightColor(c.bg) !== isLightColor(this.colors.bg) || c.bg !== this.colors.bg;
    this.colors = c;
    if (changed && this.schemeReports) this.reportScheme();
  }

  get rows(): number { return this.term.rows; }
  get cols(): number { return this.term.cols; }
  get cursorRow(): number { return this.term.buffer.active.cursorY; }
  get cursorCol(): number { return this.term.buffer.active.cursorX; }
  get cursorVisible(): boolean { return !this.term._core.coreService.isCursorHidden; }
  get alt(): boolean { return this.term.buffer.active.type === "alternate"; }
  /** Агент следит за фокусом окна (DECSET 1004). */
  get focusReporting(): boolean { return !!(this.term as unknown as { modes?: { sendFocusMode?: boolean } }).modes?.sendFocusMode; }
  /** Агент включил bracketed paste (DECSET 2004): многострочный текст — вставкой. */
  get bracketedPaste(): boolean { return !!(this.term as unknown as { modes?: { bracketedPasteMode?: boolean } }).modes?.bracketedPasteMode; }

  resize(rows: number, cols: number): void {
    if (rows === this.rows && cols === this.cols) return;
    if (rows < 2 || cols < 10 || rows > 500 || cols > 1000) return;
    this.term.resize(cols, rows);
    this.rev++;
  }

  /** Скормить очередную порцию вывода псевдотерминала (разбор синхронный). */
  feed(data: string): void {
    if (!data) return;
    this.term._core.writeSync(data);
    this.rev++;
  }

  /**
   * Экран целиком как поток ESC-последовательностей (цвета, alt-экран, курсор,
   * режимы ввода). Браузер, подключившийся посреди сессии, проигрывает его и
   * сразу видит тот же кадр, что у агента, — без обрывков недоигранного потока.
   */
  serialize(): string { return this.ser.serialize({ scrollback: 200 }); }

  dispose(): void { try { this.term.dispose(); } catch { /* уже закрыт */ } }

  private line(y: number): BufferLine | undefined {
    const b = this.term.buffer.active;
    return b.getLine(b.baseY + y);
  }

  /** Снимок экрана: строки, схлопнутые в отрезки одного стиля. */
  snapshot(): ScreenState & { lines: { text: string; spans: Span[] }[] } {
    const lines: { text: string; spans: Span[] }[] = [];
    for (let y = 0; y < this.rows; y++) {
      const ln = this.line(y);
      const spans: Span[] = [];
      let cur: Span | null = null;
      for (let x = 0; ln && x < this.cols; x++) {
        const c = ln.getCell(x);
        if (!c || c.getWidth() === 0) continue;          // вторая половина широкого символа
        const cell: Cell = {
          ch: c.getChars() || " ",
          fg: c.isFgRGB() ? hex(c.getFgColor()) : c.isFgPalette() ? palette(c.getFgColor()) : undefined,
          bg: c.isBgRGB() ? hex(c.getBgColor()) : c.isBgPalette() ? palette(c.getBgColor()) : undefined,
          bold: !!c.isBold() || undefined,
          inv: !!c.isInverse() || undefined,
        };
        const same = cur && cur.fg === cell.fg && cur.bg === cell.bg && !!cur.bold === !!cell.bold && !!cur.inv === !!cell.inv;
        if (same) cur!.text += cell.ch;
        else { cur = { text: cell.ch, fg: cell.fg, bg: cell.bg, bold: cell.bold, inv: cell.inv }; spans.push(cur); }
      }
      // хвостовые пробелы без фона не несут смысла и раздувают ответ
      while (spans.length && spans[spans.length - 1]!.text.trim() === "" && !spans[spans.length - 1]!.bg) spans.pop();
      lines.push({ text: ln?.translateToString(true) ?? "", spans });
    }
    return {
      rows: this.rows, cols: this.cols,
      cursor: { row: this.cursorRow, col: this.cursorCol, visible: this.cursorVisible },
      alt: this.alt, rev: this.rev, lines,
    };
  }

  /** Видимый текст экрана — для детекта состояний (логин, «жду входа», модель). */
  plain(): string {
    const out: string[] = [];
    for (let y = 0; y < this.rows; y++) out.push(this.line(y)?.translateToString(true) ?? "");
    return out.join("\n");
  }
}

/** Светлый ли цвет #rrggbb (по относительной яркости). */
export function isLightColor(hex: string): boolean {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return false;
  const n = parseInt(m[1]!, 16);
  return 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255) > 140;
}

/** #rrggbb → rgb:rrrr/gggg/bbbb (формат ответа xterm на OSC 10/11). */
function xrgb(color: string): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color.trim());
  const [r, g, b] = m ? [m[1]!, m[2]!, m[3]!] : ["14", "16", "1c"];
  return `rgb:${r}${r}/${g}${g}/${b}${b}`;
}

const hex = (n: number) => `rgb(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255})`;

const BASE16 = [
  "#1b1f23", "#d4604f", "#4fae7a", "#c9a227", "#5b8def", "#a06ddb", "#2aa198", "#c8ccd4",
  "#6b7280", "#ff7b6b", "#6fd49b", "#e8c14a", "#7fa8ff", "#c08cf0", "#4ec9c0", "#eef1f6",
];

function palette(n: number): string {
  if (n < 16) return BASE16[n] ?? "#c8ccd4";
  if (n >= 232) { const v = 8 + (n - 232) * 10; return `rgb(${v},${v},${v})`; }
  const i = n - 16;
  const r = Math.floor(i / 36), g = Math.floor((i % 36) / 6), b = i % 6;
  const ch = (x: number) => (x === 0 ? 0 : 55 + x * 40);
  return `rgb(${ch(r)},${ch(g)},${ch(b)})`;
}
