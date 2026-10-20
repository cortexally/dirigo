#!/usr/bin/env bun
// Перевод ошибок агентов в действие. Запуск: bun run scripts/diagnose-test.ts
import { diagnose } from "../src/agents/diagnose";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  ok ? pass++ : fail++;
};

// Реальные тексты, собранные с живых агентов в этой среде.
const CASES: [string, string, RegExp][] = [
  ["cline: формат модели", "error: invalid model format. Expected format: modelType/model", /модел/i],
  ["cline: сломанный хук", "error: hook dispatch failed: session.hook requires a valid hook event payload", /хук/i],
  ["devin: нужен вход", "Authentication failed: Please authenticate to continue. Run `/login` to log in.", /вход/i],
  ["kilo: нужен вход", "Error: You need to sign in to use this model.", /вход/i],
  ["devin acp: нужен вход", "Please log in to use Devin. Use `/login` to authenticate again.", /вход/i],
  ["hermes: нет аутентификации", "no Nous authentication found (run: hermes auth)", /вход/i],
  ["cursor: нужен вход", "Error: Authentication required. Run 'agent login'", /вход/i],
  ["нет бинаря", "spawn failed: ENOENT: no such file or directory", /файл|команд/i],
  ["лимит провайдера", "429 Too Many Requests: rate limit exceeded", /лимит/i],
  ["недоверенная папка", "Refusing to run in an untrusted workspace", /довер/i],
  // opencode с ключом OpenRouter без баланса: раньше было «завершился с кодом 1»
  ["opencode: кончились кредиты", "Error: This request requires more credits, or fewer max_tokens. You requested up to 256000 tokens, but can only afford 5209.", /кредит/i],
];

for (const [name, text, expect] of CASES) {
  const d = diagnose(text, "Агент", "agent");
  check(name, !!d && expect.test(d.reason + " " + d.fix), d ? `${d.reason} → ${d.fix}`.slice(0, 90) : "не распознано");
}

// Ничего знакомого — не выдумываем объяснение.
check("незнакомая ошибка не выдумывается", diagnose("Segmentation fault (core dumped)", "Агент", "agent") === null);
check("пустой текст не распознаётся", diagnose("", "Агент", "agent") === null);
// Управляющие последовательности не мешают разбору
check("ESC-коды не мешают", !!diagnose("\x1b[31merror:\x1b[0m invalid model format", "Агент", "agent"));

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
