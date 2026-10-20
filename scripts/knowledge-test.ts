#!/usr/bin/env bun
// База знаний: сборка записи из пакета, выключена по умолчанию, PII-шлюз на выходе.
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const DATA = join(tmpdir(), `dirigo-kn-${Date.now().toString(36)}`);
rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });
process.env.DIRIGO_DATA = DATA;

const { loadKnowledge, saveKnowledge, entryFromPack, pushEntry } = await import("../src/knowledge");
const { savePolicy } = await import("../src/policy");

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? "  — " + detail : ""}`);
  ok ? pass++ : fail++;
};

// приёмник-заглушка, запоминает последнее тело
let lastBody = "";
let hits = 0;
const sink = Bun.serve({
  port: 0,
  fetch: async (req) => { lastBody = await req.text(); hits++; return new Response("{}", { status: 200 }); },
});
const sinkUrl = `http://127.0.0.1:${sink.port}/entries`;

const pack: any = {
  schema: "dirigo.evidence/1", packId: "ses_x.1", sessionId: "ses_x",
  project: { name: "demo", path: "/tmp/demo" },
  task: { title: "починить расчёт комиссии" },
  agent: { id: "claude-code", model: "sonnet", mode: "cli", workMode: "solo" },
  isolation: { kind: "git", baseRef: "abcdef1234" },
  checks: [{ command: "bun test", ok: false, durationMs: 10, at: 1 }, { command: "bun test", ok: true, durationMs: 9, at: 2 }],
  returnedToAgent: 1,
  policy: { scans: 1, findings: 0, blocked: 0 },
  review: { approvedBy: "ilya", approvedAt: 3, files: [{ path: "src/fee.ts" }, { path: "src/fee.test.ts" }] },
  result: { applied: ["src/fee.ts"], removed: [], commit: "deadbeefcafe" },
  ledger: { schema: "dirigo.ledger/1", events: 6, head: "aa", file: "f", intact: true },
  producedBy: { product: "Dirigo", version: "1.6" }, producedAt: 100,
};

const entry = entryFromPack(pack, "demo-project");
check("запись: автор и модель", entry.author === "claude-code" && entry.model === "sonnet");
check("запись: модули из файлов ревью", entry.modules.length === 2 && entry.modules.includes("src/fee.ts"), entry.modules.join(","));
check("запись: проверки посчитаны", entry.checks.total === 2 && entry.checks.passed === 1 && entry.checks.returnedToAgent === 1);
check("запись: решения выведены", entry.decisions.some((d) => d.includes("возвращалась агенту")), entry.decisions.join(" | "));
check("запись: ссылка на пакет", entry.evidencePackId === "ses_x.1");
check("запись: кто одобрил", entry.approvedBy === "ilya");

// ── по умолчанию выключено ──
check("по умолчанию выключена", loadKnowledge().enabled === false);
const off = await pushEntry(entry);
check("выключенная интеграция ничего не шлёт", off.ok === false && !!off.skipped && hits === 0, JSON.stringify(off));

// ── включаем ──
saveKnowledge({ enabled: true, url: sinkUrl, apiKey: "secret-key", project: "demo-project" });
check("конфиг сохранён", loadKnowledge().enabled && loadKnowledge().url === sinkUrl);
const sent = await pushEntry(entry);
check("запись отправлена", sent.ok === true && hits === 1, JSON.stringify(sent));
check("приёмник получил схему", lastBody.includes("dirigo.knowledge/1"), lastBody.slice(0, 80));
check("ключ не попал в тело", !lastBody.includes("secret-key"));

// ── адрес без схемы отклоняется ──
saveKnowledge({ url: "ftp://nope" });
const bad = await pushEntry(entry);
check("нешарный протокол отклонён", bad.ok === false && String(bad.skipped).includes("http"), JSON.stringify(bad));
saveKnowledge({ url: sinkUrl });

// ── шлюз PII на выходе ──
const dirty = { ...entry, summary: "клиент ivan.petrov@bank.de, карта 4111 1111 1111 1111" };
savePolicy({ mode: "block" });
const blocked = await pushEntry(dirty as any);
check("block: выгрузка остановлена", blocked.ok === false && String(blocked.skipped).includes("политика"), JSON.stringify(blocked));

savePolicy({ mode: "redact" });
const before = hits;
const red = await pushEntry(dirty as any);
check("redact: отправлено", red.ok === true && hits === before + 1, JSON.stringify(red));
check("redact: почта вычищена", !lastBody.includes("ivan.petrov@bank.de"), lastBody.slice(0, 160));
check("redact: карта вычищена", !lastBody.includes("4111 1111 1111 1111"));
check("redact: подставлены маркеры", lastBody.includes("REDACTED"), lastBody.slice(0, 160));

sink.stop(true);
try { rmSync(DATA, { recursive: true, force: true }); } catch { /* Windows держит файлы — приберёт следующий прогон */ }
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
