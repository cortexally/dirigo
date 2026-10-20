#!/usr/bin/env bun
// Шлюз персональных данных: детекторы, режимы, отсутствие утечки значений.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const DATA = join(tmpdir(), `dirigo-policy-${Date.now().toString(36)}`);
rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });
process.env.DIRIGO_DATA = DATA;

const { scanText, savePolicy, loadPolicy } = await import("../src/policy");

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? "  — " + detail : ""}`);
  ok ? pass++ : fail++;
};

const warn = { mode: "warn" as const, detectors: ["email", "phone", "iban", "card", "secret", "jwt", "ip"] as any, allowPaths: [] };

// ── находит ──
check("email", scanText("пиши на ivan.petrov@bank.de", warn).byKind.email === 1);
check("карта (Luhn)", scanText("карта 4111 1111 1111 1111", warn).byKind.card === 1);
check("IBAN", scanText("счёт DE89370400440532013000", warn).byKind.iban === 1);
check("телефон", scanText("звони +49 160 1234567", warn).byKind.phone === 1, JSON.stringify(scanText("звони +49 160 1234567", warn).byKind));
// scan-ok: выдуманный токен-образец для проверки детектора секретов.
check("секрет", scanText("ключ sk-abcdefghij0123456789", warn).byKind.secret === 1);
check("JWT", scanText("токен eyJhbGciOi.eyJzdWIiOj.SflKxwRJSM", warn).byKind.jwt === 1);
check("публичный IP", scanText("хост 203.0.113.42", warn).byKind.ip === 1);

// ── не находит лишнего ──
check("случайные цифры не карта", !scanText("номер 1234567890123456", warn).byKind.card,
  JSON.stringify(scanText("номер 1234567890123456", warn).byKind));
check("localhost не утечка", !scanText("слушает 127.0.0.1:7171", warn).byKind.ip);
check("внутренняя сеть не утечка", !scanText("адрес 192.168.1.10", warn).byKind.ip);
check("чистый текст без находок", scanText("почини функцию sum в calc.js", warn).findings.length === 0,
  JSON.stringify(scanText("почини функцию sum в calc.js", warn).byKind));

// ── значения не утекают ──
const r = scanText("почта ivan.petrov@bank.de и карта 4111 1111 1111 1111", warn);
const serialized = JSON.stringify(r.findings);
check("в находках нет самих значений", !serialized.includes("ivan.petrov") && !serialized.includes("4111"), serialized.slice(0, 120));

// ── режимы ──
const off = scanText("почта a@b.de", { ...warn, mode: "off" });
check("off: ничего не ищет", off.findings.length === 0 && off.text === "почта a@b.de");

const red = scanText("почта ivan@bank.de, карта 4111 1111 1111 1111", { ...warn, mode: "redact" });
check("redact: почта заменена", red.text.includes("[REDACTED:EMAIL:bank.de]") && !red.text.includes("ivan@"), red.text);
check("redact: карта заменена", red.text.includes("[REDACTED:CARD]") && !red.text.includes("4111"), red.text);
check("redact: не блокирует", red.blocked === false);

const blocked = scanText("почта ivan@bank.de", { ...warn, mode: "block" });
check("block: помечает блокировку", blocked.blocked === true && blocked.findings.length === 1);
check("block: текст не меняет", blocked.text === "почта ivan@bank.de");

const clean = scanText("обычная задача", { ...warn, mode: "block" });
check("block: чистый текст проходит", clean.blocked === false);

// ── конфиг ──
check("по умолчанию режим warn", loadPolicy().mode === "warn", loadPolicy().mode);
check("сохранение режима", savePolicy({ mode: "redact" }).mode === "redact");
check("режим читается обратно", loadPolicy().mode === "redact");
check("мусорный режим игнорируется", savePolicy({ mode: "nonsense" as any }).mode === "redact");

// ── порядок замен не ломает смещения ──
const many = scanText("a@b.de и c@d.de и e@f.de", { ...warn, mode: "redact" });
check("несколько замен подряд", (many.text.match(/REDACTED:EMAIL/g) ?? []).length === 3, many.text);

// ── 1.9.2: ФИО, свои слова, пересечения, границы телефона ──
const w2 = { ...warn, detectors: [...warn.detectors, "name"] as any, terms: [] as string[] };
for (const [t, ok] of [
  ["Автор: Иванов Иван Константинович", true], ["Иван Константинович Иванов", true],
  ["Пирожков Артур Геннадьевич", true], ["Анна Сергеевна Петрова-Водкина", true],
  ["подписал Иванов И.К.", true], ["И. К. Иванов", true],
  ["Кредитный Калькулятор Расчёт", false], ["Москва Красная Площадь", false], ["Сергей Петрович сказал", false],
] as Array<[string, boolean]>) {
  check(`ФИО: «${t}» ${ok ? "найдено" : "не считается"}`, !!scanText(t, w2).byKind.name === ok, JSON.stringify(scanText(t, w2).byKind));
}
check("ФИО: значение не попадает в результат", !JSON.stringify(scanText("Иванов Иван Константинович", w2).findings).includes("Иванов"));
check("ФИО: redact заменяет", scanText("Автор: Иванов Иван Константинович", { ...w2, mode: "redact" }).text === "Автор: [REDACTED:NAME]");
const terms = { ...w2, terms: ["ООО Ромашка-2024", "Договор №77-ABC"] };
check("свои слова: без учёта регистра", scanText("с ооо ромашка-2024 и договор №77-abc", terms).byKind.custom === 2, JSON.stringify(scanText("с ооо ромашка-2024 и договор №77-abc", terms).byKind));
check("свои слова: сохраняются и читаются", savePolicy({ terms: ["  Клиент Альфа  ", "ab", "Клиент Альфа"] }).terms.join("|") === "Клиент Альфа", loadPolicy().terms.join("|"));
check("карта не считается заодно телефоном", JSON.stringify(scanText("Карта: 4111111111111111", w2).byKind) === JSON.stringify({ card: 1 }), JSON.stringify(scanText("Карта: 4111111111111111", w2).byKind));
check("16 случайных цифр — не телефон", !scanText("номер 1234567812345678", w2).byKind.phone);
check("телефон по-прежнему находится", scanText("+7 (916) 123-45-67", w2).byKind.phone === 1 && scanText("8 916 123 45 67", w2).byKind.phone === 1);
check("дата не телефон", !scanText("Дата: 2026-10-18", w2).findings.length);
// старый policy.json с набором по умолчанию до 1.9.2 — получает детектор ФИО
writeFileSync(join(DATA, "policy.json"), JSON.stringify({ mode: "warn", detectors: ["email", "phone", "iban", "card", "secret", "jwt"], allowPaths: [] }));
check("миграция: старый набор по умолчанию включает ФИО", loadPolicy().detectors.includes("name"));
writeFileSync(join(DATA, "policy.json"), JSON.stringify({ mode: "warn", detectors: ["email"], allowPaths: [] }));
check("миграция: свой набор пользователя не трогается", loadPolicy().detectors.join() === "email");

// ── 1.9.4 (промо-съёмка): западные имена в контакте и номера E.164 ──
const w3 = { ...w2, terms: ["NL-2026-0417"] };
const promo = scanText("Ping Maria Lindqvist at maria.lindqvist@example.com or +1-555-0142 about contract NL-2026-0417", w3).byKind;
check("контакт из рунбука: имя, почта, номер и своё слово — все найдены", promo.name === 1 && promo.email === 1 && promo.phone === 1 && promo.custom === 1, JSON.stringify(promo));
for (const [t, kind] of [["On-call: Maria Lindqvist", "name"], ["Owner: John Smith", "name"], ["+44 20 7946 0958", "phone"], ["+49 (30) 1234-5678", "phone"], ["+1-555-0142", "phone"]] as Array<[string, string]>) {
  check(`«${t}» → ${kind}`, (scanText(t, w2).byKind as any)[kind] === 1, JSON.stringify(scanText(t, w2).byKind));
}
for (const t of ["const Hello = World; // Hello World", "import React from \"react\"; New Component", "Read Me First", "version 1.2.3.4", "Visit New York office", "ID +123"]) {
  // набор детекторов по умолчанию (публичный IP в нём выключен: «1.2.3.4» — это IP)
  const def = { ...w2, detectors: w2.detectors.filter((k: string) => k !== "ip") };
  check(`без ложной тревоги: «${t}»`, scanText(t, def).findings.length === 0, JSON.stringify(scanText(t, def).byKind));
}
check("западное имя: redact заменяет", scanText("Owner: John Smith", { ...w2, mode: "redact" }).text === "Owner: [REDACTED:NAME]");

rmSync(DATA, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
