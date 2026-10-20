#!/usr/bin/env bun
// Журнал происхождения: цепочка хешей, подпись пакета, выгрузка, трейлеры.
// Запуск: bun run scripts/provenance-test.ts
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const DATA = join(tmpdir(), `dirigo-prov-test-${Date.now().toString(36)}`);
rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });
process.env.DIRIGO_DATA = DATA;

const {
  record, readLedger, verifyLedger, buildEvidencePack, savePack,
  exportBundle, commitTrailers, verifySignature, publicKeyInfo, stableStringify, sha256,
} = await import("../src/provenance");

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? "  — " + detail : ""}`);
  ok ? pass++ : fail++;
};

const SID = "ses_prov_demo";

// ── журнал ──
check("пустой журнал валиден", verifyLedger(SID).ok);
const e1 = record(SID, "session.created", { projectId: "prj_1" });
const e2 = record(SID, "agent.started", { agentId: "claude-code", model: "sonnet", mode: "cli" });
const e3 = record(SID, "prompt.submitted", { sha256: sha256("задача"), chars: 6 });
check("события записаны", !!e1 && !!e2 && !!e3);
check("нумерация подряд", readLedger(SID).map((e) => e.seq).join(",") === "1,2,3", readLedger(SID).map((e) => e.seq).join(","));
check("первое событие без prev", readLedger(SID)[0]!.prev === "");
check("цепочка связана", readLedger(SID)[1]!.prev === readLedger(SID)[0]!.hash);

record(SID, "checks.run", { command: "bun test", ok: false, durationMs: 1200 });
record(SID, "checks.returned", { iteration: 1, reason: "2 теста красные" });
record(SID, "checks.run", { command: "bun test", ok: true, durationMs: 900 });
record(SID, "policy.scan", { findings: 2, blocked: false, kinds: ["email"] });

const v = verifyLedger(SID);
check("цепочка целая на 7 событиях", v.ok && v.events === 7, `${v.events}: ${v.detail}`);

// ── обнаружение подделки ──
const ledgerPath = join(DATA, "provenance", `${SID}.jsonl`);
const lines = readFileSync(ledgerPath, "utf8").trim().split("\n");
const tampered = JSON.parse(lines[3]!);
tampered.data.ok = true; // «проверки прошли» вместо провала
lines[3] = JSON.stringify(tampered);
writeFileSync(ledgerPath, lines.join("\n") + "\n");
const bad = verifyLedger(SID);
check("подмена события поймана", !bad.ok && bad.brokenAt === 4, `${bad.brokenAt} ${bad.detail}`);

// вырезание строки тоже должно ловиться
writeFileSync(ledgerPath, lines.filter((_, i) => i !== 2).join("\n") + "\n");
const cut = verifyLedger(SID);
check("вырезанное событие поймано", !cut.ok, cut.detail);

// восстанавливаем журнал для остальных проверок
writeFileSync(ledgerPath, "");
rmSync(ledgerPath);
for (const [t, d] of [
  ["session.created", { projectId: "prj_1" }],
  ["agent.started", { agentId: "claude-code", model: "sonnet", mode: "cli", workMode: "solo" }],
  ["prompt.submitted", { sha256: sha256("добавь раздел"), chars: 14 }],
  ["checks.run", { command: "bun test", ok: false, durationMs: 1200 }],
  ["checks.returned", { iteration: 1 }],
  ["checks.run", { command: "bun test", ok: true, durationMs: 900 }],
] as Array<[any, any]>) record(SID, t, d);

// ── пакет ──
const pack = buildEvidencePack(SID, {
  project: { name: "demo", path: "/tmp/demo", branch: "main" },
  task: { title: "добавь раздел", prompt: "добавь раздел" },
  isolation: { kind: "git", worktree: "/tmp/w", baseRef: "abc123" },
  approvedBy: "ilya",
  files: [{ path: "README.md", added: 3, deleted: 0 }],
  applied: ["README.md"],
  commit: "deadbeef",
  version: "1.6",
});
check("пакет: агент из журнала", pack.agent.id === "claude-code" && pack.agent.model === "sonnet", JSON.stringify(pack.agent));
check("пакет: проверки собраны", pack.checks.length === 2 && pack.checks[1]!.ok === true, String(pack.checks.length));
check("пакет: возвраты агенту посчитаны", pack.returnedToAgent === 1, String(pack.returnedToAgent));
check("пакет: журнал признан целым", pack.ledger.intact && pack.ledger.events === 6, `${pack.ledger.events}`);
check("пакет: хеш промпта на месте", pack.task.promptSha256 === sha256("добавь раздел"));
check("пакет: подписан", !!pack.signature && pack.signature.alg === "ed25519");

const sig = pack.signature!;
check("подпись проверяется", verifySignature({ ...pack, signature: undefined }, sig, publicKeyInfo().publicKeyPem));

const forged = { ...pack, signature: undefined, result: { ...pack.result, commit: "0000000" } };
check("подделанный пакет не проходит подпись", !verifySignature(forged, sig, publicKeyInfo().publicKeyPem));

check("пакет сохранён", !!savePack(pack));

// ── выгрузка ──
const bundle = exportBundle();
check("выгрузка содержит пакет", bundle.packs.length === 1, String(bundle.packs.length));
check("выгрузка: подписи валидны", bundle.verification.signatures.valid === 1);
check("выгрузка: журналы целы", bundle.verification.ledgers.intact === 1);
check("выгрузка: открытый ключ приложен", bundle.publicKey.pem.includes("BEGIN PUBLIC KEY"));

// ── трейлеры ──
const trailers = commitTrailers(pack);
check("трейлер агента", trailers.some((t) => t === "Dirigo-Agent: claude-code"), trailers.join(" | "));
check("трейлер проверок", trailers.some((t) => t === "Dirigo-Checks: 1/2 pass"), trailers.join(" | "));
check("трейлер возвратов", trailers.some((t) => t.startsWith("Dirigo-Returned-To-Agent: 1")));
check("трейлер одобрившего", trailers.some((t) => t === "Dirigo-Approved-By: ilya"));

// ── стабильная сериализация ──
check("порядок ключей не влияет на сериализацию",
  stableStringify({ b: 1, a: { d: 2, c: 3 } }) === stableStringify({ a: { c: 3, d: 2 }, b: 1 }));

rmSync(DATA, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
