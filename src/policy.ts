// Dirigo — шлюз персональных данных (PII / GDPR).
//
// Задача узкая и проверяемая: НЕ дать персональным данным уйти наружу вместе с
// задачей для внешнего агента, и оставить об этом запись.
//
// Важное решение: сами найденные значения никуда не пишутся — ни в журнал, ни в
// лог, ни в ответ API. Пишутся только тип находки, позиция и количество. Иначе
// инструмент, защищающий персональные данные, сам становится их хранилищем.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export type PolicyMode = "off" | "warn" | "redact" | "block";

export interface PolicyConfig {
  mode: PolicyMode;
  /** какие типы проверяем */
  detectors: PiiKind[];
  /** не трогать эти пути при проверке файлов (glob-подобные префиксы) */
  allowPaths: string[];
  /** свои слова: ФИО клиентов, номера договоров — ищутся без учёта регистра */
  terms: string[];
}

export type PiiKind = "email" | "phone" | "iban" | "card" | "secret" | "ip" | "jwt" | "name" | "custom";

export interface PiiFinding {
  kind: PiiKind;
  /** смещение в исходном тексте */
  at: number;
  length: number;
  /** НЕ значение: только форма, по которой человек узнает место */
  preview: string;
}

export interface ScanResult {
  mode: PolicyMode;
  findings: PiiFinding[];
  byKind: Record<string, number>;
  /** текст после замены (при mode=redact), иначе исходный */
  text: string;
  blocked: boolean;
  summary: string;
}

const DEFAULTS: PolicyConfig = {
  mode: "warn",
  detectors: ["email", "phone", "iban", "card", "secret", "jwt", "name"],
  allowPaths: [],
  terms: [],
};

function policyFile(): string {
  const dir = process.env.DIRIGO_DATA
    ? resolve(process.env.DIRIGO_DATA.replace(/[\\/]+$/, ""))
    : resolve(new URL("../data/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  mkdirSync(dir, { recursive: true });
  return join(dir, "policy.json");
}

/** Набор детекторов по умолчанию до 1.9.2 — его сохраняли в policy.json как есть.
 *  Такой файл означает «по умолчанию», а не «без ФИО»: новые детекторы включаем. */
const LEGACY_DEFAULT = ["email", "phone", "iban", "card", "secret", "jwt"];
function migrateDetectors(raw: unknown): PiiKind[] {
  if (!Array.isArray(raw) || !raw.length) return DEFAULTS.detectors;
  const list = raw.map(String) as PiiKind[];
  const same = list.length === LEGACY_DEFAULT.length && LEGACY_DEFAULT.every((k) => list.includes(k as PiiKind));
  return same ? DEFAULTS.detectors : list;
}
function cleanTerms(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/\r?\n/) : [];
  return [...new Set(list.map((x) => String(x).trim()).filter((x) => x.length >= 3))].slice(0, 500);
}

export function loadPolicy(): PolicyConfig {
  try {
    if (existsSync(policyFile())) {
      const raw = JSON.parse(readFileSync(policyFile(), "utf8")) as Partial<PolicyConfig>;
      return {
        mode: (["off", "warn", "redact", "block"] as PolicyMode[]).includes(raw.mode as PolicyMode) ? raw.mode as PolicyMode : DEFAULTS.mode,
        detectors: migrateDetectors(raw.detectors),
        allowPaths: Array.isArray(raw.allowPaths) ? raw.allowPaths.map(String) : [],
        terms: cleanTerms(raw.terms),
      };
    }
  } catch { /* битый конфиг не должен ронять демон — берём значения по умолчанию */ }
  // переопределение из окружения: удобно для контейнера
  const envMode = process.env.DIRIGO_PII_MODE as PolicyMode | undefined;
  return { ...DEFAULTS, mode: (["off", "warn", "redact", "block"] as PolicyMode[]).includes(envMode as PolicyMode) ? envMode as PolicyMode : DEFAULTS.mode };
}

export function savePolicy(next: Partial<PolicyConfig>): PolicyConfig {
  const cur = loadPolicy();
  const merged: PolicyConfig = {
    mode: (["off", "warn", "redact", "block"] as PolicyMode[]).includes(next.mode as PolicyMode) ? next.mode as PolicyMode : cur.mode,
    detectors: Array.isArray(next.detectors) && next.detectors.length ? next.detectors as PiiKind[] : cur.detectors,
    allowPaths: Array.isArray(next.allowPaths) ? next.allowPaths.map(String) : cur.allowPaths,
    terms: next.terms !== undefined ? cleanTerms(next.terms) : cur.terms,
  };
  writeFileSync(policyFile(), JSON.stringify(merged, null, 2), "utf8");
  return merged;
}

/* ───────────────────────── детекторы ───────────────────────── */

/** Luhn — отсекает случайные цифры, которые похожи на карту, но ей не являются. */
function luhnValid(digits: string): boolean {
  let sum = 0, alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (n < 0 || n > 9) return false;
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n; alt = !alt;
  }
  return sum % 10 === 0 && digits.length >= 13;
}

interface Detector { kind: PiiKind; re: RegExp; accept?: (m: string) => boolean; mask: (m: string) => string; }

const DETECTORS: Detector[] = [
  {
    kind: "email",
    re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    mask: (m) => `[REDACTED:EMAIL:${m.split("@")[1] ?? ""}]`,
  },
  {
    kind: "iban",
    re: /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g,
    accept: (m) => /\d/.test(m) && m.length >= 15,
    mask: (m) => `[REDACTED:IBAN:${m.slice(0, 2)}]`,
  },
  {
    kind: "card",
    re: /\b(?:\d[ -]?){13,19}\b/g,
    accept: (m) => luhnValid(m.replace(/[ -]/g, "")),
    mask: () => "[REDACTED:CARD]",
  },
  {
    // международный номер с «+» (E.164: 8–15 цифр в любых группах). Короткие
    // формы вроде +1-555-0142 местный детектор пропускал — а это типовой блок
    // контактов в рунбуке.
    kind: "phone",
    re: /(?<![\w+])\+\d{1,3}(?:[\s.-]?\(?\d{1,4}\)?){2,6}(?!\d)/g,
    accept: (m) => { const d = m.replace(/\D/g, ""); return d.length >= 8 && d.length <= 15; },
    mask: () => "[REDACTED:PHONE]",
  },
  {
    // международный формат и длинные локальные номера; короткие числа отсекаем
    kind: "phone",
    // (?<!\d)…(?!\d): не кусок более длинного числа (номер карты, счёта)
    re: /(?<![\d+])(?:\+\d{1,3}[\s-]?)?\(?\d{2,4}\)?[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2,4}(?!\d)/g,
    // телефон по E.164 — не длиннее 15 цифр: 16 цифр подряд это не телефон
    accept: (m) => { const d = m.replace(/\D/g, ""); return d.length >= 10 && d.length <= 15 && !luhnValid(d); },
    mask: () => "[REDACTED:PHONE]",
  },
  {
    kind: "jwt",
    re: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g,
    mask: () => "[REDACTED:JWT]",
  },
  {
    kind: "secret",
    re: /\b(?:sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
    mask: () => "[REDACTED:SECRET]",
  },
  {
    // ФИО с отчеством — в любом порядке: «Иванов Иван Константинович»,
    // «Иван Константинович Иванов». Отчество (-ович/-евич/-ич/-овна/-евна/-ична)
    // отличает человека от пары заглавных слов в тексте.
    kind: "name",
    re: /(?<![\p{L}\d])(?:[А-ЯЁ][а-яё]+(?:-[А-ЯЁ][а-яё]+)?\s+[А-ЯЁ][а-яё]+\s+[А-ЯЁ][а-яё]+(?:ович|евич|ич|овна|евна|ична|инична)|[А-ЯЁ][а-яё]+\s+[А-ЯЁ][а-яё]+(?:ович|евич|ич|овна|евна|ична|инична)\s+[А-ЯЁ][а-яё]+(?:-[А-ЯЁ][а-яё]+)?)(?![\p{L}\d])/gu,
    mask: () => "[REDACTED:NAME]",
  },
  {
    // фамилия с инициалами: «Иванов И.К.», «Иванов И. К.», «И.К. Иванов»
    kind: "name",
    re: /(?<![\p{L}\d])(?:[А-ЯЁ][а-яё]{2,}(?:-[А-ЯЁ][а-яё]+)?\s+[А-ЯЁ]\.\s?[А-ЯЁ]\.|[А-ЯЁ]\.\s?[А-ЯЁ]\.\s?[А-ЯЁ][а-яё]{2,})(?![\p{L}])/gu,
    mask: () => "[REDACTED:NAME]",
  },
  {
    kind: "ip",
    re: /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/g,
    accept: (m) => !/^(?:127\.|0\.|255\.255|10\.|192\.168\.)/.test(m),
    mask: () => "[REDACTED:IP]",
  },
];

/**
 * Проверка текста. Возвращает находки, сводку и — при mode=redact — текст с
 * заменами. Значения находок наружу не отдаются.
 */
export function scanText(text: string, cfg: PolicyConfig = loadPolicy()): ScanResult {
  if (cfg.mode === "off" || !text) {
    return { mode: cfg.mode, findings: [], byKind: {}, text, blocked: false, summary: "проверка выключена" };
  }
  const findings: PiiFinding[] = [];
  const replacements: Array<{ at: number; length: number; with: string }> = [];

  for (const d of DETECTORS) {
    if (!cfg.detectors.includes(d.kind)) continue;
    d.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = d.re.exec(text)) !== null) {
      const value = m[0];
      if (d.accept && !d.accept(value)) continue;
      findings.push({
        kind: d.kind,
        at: m.index,
        length: value.length,
        // превью без самих данных: длина и первый символ формы
        preview: `${d.kind}(${value.length} симв.)`,
      });
      replacements.push({ at: m.index, length: value.length, with: d.mask(value) });
    }
  }

  // «Имя Фамилия» латиницей. По одной форме имя не отличить от «Hello World» в
  // коде, поэтому — только в строке-контакте: рядом e-mail, телефон или
  // слово-маркер (contact, on-call, owner…). Детектор ФИО на отчестве западные
  // имена не видит, а продукт целится в ЕС.
  if (cfg.detectors.includes("name")) {
    const MARK = /(?:contact|on[- ]?call|owner|maintainer|author|reviewer|assignee|manager|lead|engineer|developer|customer|client|ping|reach|call|email|e-mail|phone|tel|cc|signed|approved by|written by|контакт|ответственн|дежурн|автор|владелец|клиент|менеджер|руководител|звонить|позвонить|написать)/i;
    const STOP = new Set(["Hello World", "Pull Request", "Read Me", "Merge Request", "Change Log", "Release Notes", "Open Source", "Visual Studio", "Google Chrome", "Microsoft Teams", "New York", "San Francisco", "United States", "United Kingdom", "Dirigo Agent", "Claude Code", "Github Actions", "Git Hub"]);
    let off = 0;
    for (const line of text.split("\n")) {
      const ctx = MARK.test(line) || /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(line) || /\+\d[\d\s().-]{6,}/.test(line);
      if (ctx) {
        const re = /(?<![\p{L}\d@./_-])([A-Z][a-z]{1,20}(?:-[A-Z][a-z]{1,20})?)\s([A-Z][a-z]{1,20}(?:-[A-Z][a-z]{1,20})?)(?![\p{L}\d@])/gu;
        let m: RegExpExecArray | null;
        while ((m = re.exec(line)) !== null) {
          const full = m[0];
          if (STOP.has(full)) continue;
          findings.push({ kind: "name", at: off + m.index, length: full.length, preview: `name(${full.length} симв.)` });
          replacements.push({ at: off + m.index, length: full.length, with: "[REDACTED:NAME]" });
        }
      }
      off += line.length + 1;
    }
  }

  // свои слова (клиенты, договоры) — без учёта регистра
  if (cfg.terms?.length) {
    const lower = text.toLowerCase();
    for (const t of cfg.terms) {
      const needle = t.toLowerCase();
      for (let at = lower.indexOf(needle); at >= 0; at = lower.indexOf(needle, at + needle.length)) {
        findings.push({ kind: "custom", at, length: t.length, preview: `custom(${t.length} симв.)` });
        replacements.push({ at, length: t.length, with: "[REDACTED:CUSTOM]" });
      }
    }
  }

  // Пересечения: 16 цифр карты подходили и под телефон — одна карта считалась
  // дважды. Оставляем находку с более высоким приоритетом, остальные снимаем.
  const PRIORITY: Record<string, number> = { secret: 0, jwt: 1, card: 2, iban: 3, email: 4, custom: 5, name: 6, phone: 7, ip: 8 };
  const order = findings.map((f, i) => ({ f, r: replacements[i]! }))
    .sort((a, b) => (PRIORITY[a.f.kind] ?? 9) - (PRIORITY[b.f.kind] ?? 9) || b.f.length - a.f.length);
  const kept: typeof order = [];
  for (const x of order) {
    const over = kept.some((k) => x.f.at < k.f.at + k.f.length && k.f.at < x.f.at + x.f.length);
    if (!over) kept.push(x);
  }
  findings.length = 0; replacements.length = 0;
  for (const k of kept) { findings.push(k.f); replacements.push(k.r); }

  findings.sort((a, b) => a.at - b.at);
  const byKind: Record<string, number> = {};
  for (const f of findings) byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;

  let out = text;
  if (cfg.mode === "redact" && replacements.length) {
    replacements.sort((a, b) => b.at - a.at); // с конца, чтобы не сбить смещения
    for (const r of replacements) out = out.slice(0, r.at) + r.with + out.slice(r.at + r.length);
  }

  const blocked = cfg.mode === "block" && findings.length > 0;
  const kinds = Object.entries(byKind).map(([k, n]) => `${k}:${n}`).join(", ");
  return {
    mode: cfg.mode,
    findings,
    byKind,
    text: out,
    blocked,
    summary: findings.length
      ? `найдено ${findings.length} (${kinds})${blocked ? " — отправка заблокирована" : cfg.mode === "redact" ? " — заменено" : ""}`
      : "персональных данных не найдено",
  };
}

/* ───────────────────── проверка изменений агента ───────────────────── */

export interface ChangesScan {
  mode: PolicyMode;
  findings: number;
  byKind: Record<string, number>;
  /** по файлам: тип находок и номера НОВЫХ строк (значения не отдаём) */
  files: Array<{ path: string; kinds: Record<string, number>; lines: number[] }>;
  blocked: boolean;
  summary: string;
}

/** Путь в исключениях политики (префикс или простая маска `*`). */
function allowed(path: string, allow: string[]): boolean {
  const p = path.replace(/\\/g, "/");
  return allow.some((a) => {
    const pat = a.replace(/\\/g, "/").trim();
    if (!pat) return false;
    if (pat.includes("*")) return new RegExp("^" + pat.split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$").test(p);
    return p === pat || p.startsWith(pat.replace(/\/?$/, "/"));
  });
}

/**
 * Проверка того, что агент ДОБАВИЛ в файлы (только новые строки диффа).
 * Задача может быть чистой, а персональные данные появятся в коде — например,
 * агент «для примера» вписал реальный e-mail клиента. Удалённые строки не
 * проверяем: их уход из кода — не утечка. В режиме block применение и коммит
 * останавливаются; redact код не переписывает (менять чужой код молча нельзя),
 * а работает как warn.
 */
export function scanChanges(
  files: Array<{ path: string; status?: string; lines?: Array<{ kind: string; text: string; newNo: number | null }> }>,
  cfg: PolicyConfig = loadPolicy(),
): ChangesScan {
  const out: ChangesScan = { mode: cfg.mode, findings: 0, byKind: {}, files: [], blocked: false, summary: "проверка выключена" };
  if (cfg.mode === "off") return out;
  const probe: PolicyConfig = { ...cfg, mode: "warn" };
  for (const f of files) {
    if (f.status === "deleted" || allowed(f.path, cfg.allowPaths)) continue;
    const kinds: Record<string, number> = {};
    const lines = new Set<number>();
    for (const l of f.lines ?? []) {
      if (l.kind !== "add" || !l.text) continue;
      const r = scanText(l.text, probe);
      if (!r.findings.length) continue;
      for (const [k, n] of Object.entries(r.byKind)) kinds[k] = (kinds[k] ?? 0) + n;
      if (l.newNo != null) lines.add(l.newNo);
    }
    const n = Object.values(kinds).reduce((a, b) => a + b, 0);
    if (!n) continue;
    out.findings += n;
    for (const [k, c] of Object.entries(kinds)) out.byKind[k] = (out.byKind[k] ?? 0) + c;
    out.files.push({ path: f.path, kinds, lines: [...lines].sort((a, b) => a - b).slice(0, 50) });
  }
  out.blocked = cfg.mode === "block" && out.findings > 0;
  const kinds = Object.entries(out.byKind).map(([k, n]) => `${k}:${n}`).join(", ");
  out.summary = out.findings
    ? `в изменениях агента найдено ${out.findings} (${kinds}) в ${out.files.length} файл(ах)${out.blocked ? " — применение остановлено политикой" : ""}`
    : "в изменениях агента персональных данных не найдено";
  return out;
}
