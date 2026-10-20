// Dirigo — происхождение изменений (provenance).
//
// Зачем это существует. Детектор, запущенный по уже закоммиченному коду, может
// только ПРЕДПОЛОЖИТЬ, кто его написал. Запись о происхождении обязана
// создаваться в момент самого взаимодействия — а пульт как раз в нём и стоит:
// он знает агента, модель, промпт, изолированную копию, прогон проверок,
// возвраты агенту, построчное одобрение человека и итоговый коммит.
//
// Устройство:
//   1. На сессию заводится append-only журнал (JSONL). Строки не переписываются
//      и не удаляются никогда — только дописываются.
//   2. Каждое событие несёт хеш предыдущего (цепочка), поэтому вырезать или
//      подменить событие в середине нельзя незаметно.
//   3. При применении изменений из журнала собирается «пакет доказательств» —
//      самодостаточный JSON, подписанный ключом этого инстанса (Ed25519).
//   4. Пакеты выгружаются за период одним файлом и проверяются офлайн.
//
// Архитектурная идея append-only журнала событий, из которого восстанавливается
// состояние, взята у event sourcing (и похожа на session log в deepseek-harness,
// MIT). Код свой: ни строки чужого здесь нет.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash, generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify, createPublicKey, createPrivateKey } from "node:crypto";
import { join, resolve } from "node:path";

export const EVIDENCE_SCHEMA = "dirigo.evidence/1";
export const LEDGER_SCHEMA = "dirigo.ledger/1";

export type ProvenanceEventType =
  | "session.created"
  | "agent.started"
  | "prompt.submitted"
  | "checks.run"
  | "checks.returned"
  | "policy.scan"
  | "review.note"
  | "change.applied"
  | "change.committed"
  | "change.reverted"
  | "knowledge.pushed"
  | "session.stopped";

export interface ProvenanceEvent {
  seq: number;
  at: number;
  sessionId: string;
  type: ProvenanceEventType;
  data: Record<string, unknown>;
  /** хеш предыдущего события в цепочке ("" у первого) */
  prev: string;
  /** sha256 канонического представления этого события */
  hash: string;
}

function dataRoot(): string {
  const dir = process.env.DIRIGO_DATA
    ? process.env.DIRIGO_DATA.replace(/[\\/]+$/, "")
    : new URL("../data/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  return resolve(dir);
}

function provDir(): string {
  const dir = join(dataRoot(), "provenance");
  mkdirSync(dir, { recursive: true });
  return dir;
}

const ledgerFile = (sessionId: string) => join(provDir(), `${safeId(sessionId)}.jsonl`);
const packFile = (sessionId: string, n: number) => join(provDir(), `${safeId(sessionId)}.pack${n}.json`);

/** Идентификатор в имени файла: только то, что не выведет нас из каталога. */
function safeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) || "session";
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Канонический вид события для хеширования: порядок полей фиксирован. */
function canonicalEvent(e: Omit<ProvenanceEvent, "hash">): string {
  return JSON.stringify([e.seq, e.at, e.sessionId, e.type, stableStringify(e.data), e.prev]);
}

/**
 * Стабильная сериализация: ключи отсортированы, иначе хеш «плавает».
 *
 * Поля со значением undefined ОПУСКАЮТСЯ — ровно так же, как это делает
 * JSON.stringify при записи пакета на диск. Иначе подпись считалась бы по
 * форме с "branch":null, а проверялась по прочитанной с диска форме без
 * ключа branch вовсе — и честная подпись не сходилась бы.
 */
export function stableStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") + "}";
}

/* ───────────────────────── журнал ───────────────────────── */

export function readLedger(sessionId: string): ProvenanceEvent[] {
  const file = ledgerFile(sessionId);
  if (!existsSync(file)) return [];
  const out: ProvenanceEvent[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s) as ProvenanceEvent); } catch { /* битая строка — пропускаем, verify её поймает */ }
  }
  return out;
}

/**
 * Дописать событие. Единственный способ попасть в журнал.
 * Никогда не бросает наружу: сбой записи доказательства не должен ронять
 * работу пульта, но обязан быть виден в ответе.
 */
export function record(
  sessionId: string,
  type: ProvenanceEventType,
  data: Record<string, unknown> = {},
): ProvenanceEvent | null {
  try {
    const existing = readLedger(sessionId);
    const prev = existing.length ? existing[existing.length - 1]!.hash : "";
    const base = { seq: existing.length + 1, at: Date.now(), sessionId, type, data, prev };
    const event: ProvenanceEvent = { ...base, hash: sha256(canonicalEvent(base)) };
    appendFileSync(ledgerFile(sessionId), JSON.stringify(event) + "\n", "utf8");
    return event;
  } catch {
    return null;
  }
}

export interface LedgerVerdict {
  ok: boolean;
  events: number;
  head: string;
  /** номер первого события, на котором цепочка разошлась */
  brokenAt?: number;
  detail: string;
}

/** Проверка цепочки: пересчитываем хеши и сверяем связь prev → hash. */
export function verifyLedger(sessionId: string): LedgerVerdict {
  const events = readLedger(sessionId);
  if (!events.length) return { ok: true, events: 0, head: "", detail: "журнал пуст" };
  let prev = "";
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    if (e.seq !== i + 1) return { ok: false, events: events.length, head: "", brokenAt: i + 1, detail: `нарушен порядок: seq=${e.seq} на позиции ${i + 1}` };
    if (e.prev !== prev) return { ok: false, events: events.length, head: "", brokenAt: e.seq, detail: `разрыв цепочки на событии ${e.seq}` };
    const expect = sha256(canonicalEvent({ seq: e.seq, at: e.at, sessionId: e.sessionId, type: e.type, data: e.data, prev: e.prev }));
    if (expect !== e.hash) return { ok: false, events: events.length, head: "", brokenAt: e.seq, detail: `событие ${e.seq} изменено после записи` };
    prev = e.hash;
  }
  return { ok: true, events: events.length, head: prev, detail: `цепочка целая: ${events.length} событий` };
}

/* ───────────────────────── подпись ───────────────────────── */

interface KeyMaterial { publicKeyPem: string; privateKeyPem: string; keyId: string; createdAt: number; }

const keyFile = () => join(provDir(), "signing-key.json");

/** Ключ инстанса. Создаётся при первом обращении, лежит рядом с данными. */
export function signingKey(): KeyMaterial {
  const file = keyFile();
  if (existsSync(file)) {
    try { return JSON.parse(readFileSync(file, "utf8")) as KeyMaterial; } catch { /* перегенерируем ниже */ }
  }
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const material: KeyMaterial = {
    publicKeyPem,
    privateKeyPem,
    keyId: sha256(publicKeyPem).slice(0, 16),
    createdAt: Date.now(),
  };
  writeFileSync(file, JSON.stringify(material, null, 2), { mode: 0o600 });
  return material;
}

export function publicKeyInfo(): { keyId: string; publicKeyPem: string; createdAt: number } {
  const k = signingKey();
  return { keyId: k.keyId, publicKeyPem: k.publicKeyPem, createdAt: k.createdAt };
}

export function signPayload(payload: unknown): { alg: "ed25519"; keyId: string; value: string } {
  const k = signingKey();
  const value = cryptoSign(null, Buffer.from(stableStringify(payload), "utf8"), createPrivateKey(k.privateKeyPem)).toString("base64");
  return { alg: "ed25519", keyId: k.keyId, value };
}

export function verifySignature(payload: unknown, signature: { value: string }, publicKeyPem?: string): boolean {
  try {
    const pem = publicKeyPem ?? signingKey().publicKeyPem;
    return cryptoVerify(null, Buffer.from(stableStringify(payload), "utf8"), createPublicKey(pem), Buffer.from(signature.value, "base64"));
  } catch {
    return false;
  }
}

/* ───────────────────── пакет доказательств ───────────────────── */

export interface EvidenceCheck { command: string; ok: boolean; durationMs: number; at: number; }
export interface EvidenceFile { path: string; added?: number; deleted?: number; status?: string; }

export interface EvidencePack {
  schema: typeof EVIDENCE_SCHEMA;
  packId: string;
  sessionId: string;
  project: { name?: string; path?: string; branch?: string };
  task: { title?: string; promptSha256?: string; promptChars?: number };
  agent: { id?: string; model?: string | null; reasoning?: string | null; mode?: string; workMode?: string };
  isolation: { kind?: string; worktree?: string; baseRef?: string };
  checks: EvidenceCheck[];
  /** сколько раз сломанная работа возвращалась агенту вместо показа человеку */
  returnedToAgent: number;
  /** inChanges — находки в строках, добавленных агентом; overridden — применено вопреки block */
  policy: { scans: number; findings: number; blocked: number; inChanges?: number; overridden?: number };
  review: { approvedBy?: string; approvedAt: number; files: EvidenceFile[] };
  /** trigger: что создало пакет — «Применить» (applied) или коммит (committed) */
  result: { applied: string[]; removed: string[]; commit?: string | null; trigger?: "applied" | "committed" };
  ledger: { schema: typeof LEDGER_SCHEMA; events: number; head: string; file: string; intact: boolean };
  producedBy: { product: string; version: string };
  producedAt: number;
  signature?: { alg: "ed25519"; keyId: string; value: string };
}

export interface PackContext {
  project?: { name?: string; path?: string; branch?: string };
  task?: { title?: string; prompt?: string };
  agent?: { id?: string; model?: string | null; reasoning?: string | null; mode?: string; workMode?: string };
  isolation?: { kind?: string; worktree?: string; baseRef?: string };
  approvedBy?: string;
  files?: EvidenceFile[];
  applied?: string[];
  removed?: string[];
  commit?: string | null;
  version?: string;
  trigger?: "applied" | "committed";
}

/**
 * Собрать и подписать пакет. Факты берутся из журнала (он первичен), контекст —
 * из вызывающего кода. Всё, что попало в пакет, уже лежит в журнале событиями.
 */
export function buildEvidencePack(sessionId: string, ctx: PackContext = {}): EvidencePack {
  const events = readLedger(sessionId);
  const verdict = verifyLedger(sessionId);

  const started = events.find((e) => e.type === "agent.started")?.data ?? {};
  const prompt = events.find((e) => e.type === "prompt.submitted")?.data ?? {};
  const checks: EvidenceCheck[] = events
    .filter((e) => e.type === "checks.run")
    .map((e) => ({
      command: String(e.data.command ?? ""),
      ok: e.data.ok === true,
      durationMs: Number(e.data.durationMs ?? 0),
      at: e.at,
    }));
  const returnedToAgent = events.filter((e) => e.type === "checks.returned").length;
  // Находки шлюза — за ЭТО изменение: от предыдущего пакета (применение или
  // коммит) до текущего. Иначе каждый следующий коммит нёс находки всех прошлых.
  const changeIdx = events.map((e, i) => (e.type === "change.applied" || e.type === "change.committed") ? i : -1).filter((i) => i >= 0);
  const windowStart = changeIdx.length >= 2 ? changeIdx[changeIdx.length - 2]! + 1 : 0;
  const scans = events.filter((e, i) => e.type === "policy.scan" && i >= windowStart);
  // Изменения проверяются при каждой попытке (отказ, «Отмена», повтор с
  // исключением) — одну и ту же строку нельзя считать трижды. Находки в коде —
  // по последней проверке, после которой изменение прошло; блокировки — числом попыток.
  const changeScans = scans.filter((e) => e.data.target === "changes");
  const lastChange = changeScans.at(-1);
  const inChanges = Number(lastChange?.data.findings ?? 0);
  const inputFindings = scans.filter((e) => e.data.target !== "changes").reduce((n, e) => n + Number(e.data.findings ?? 0), 0);
  const findings = inputFindings + inChanges;
  const blocked = scans.filter((e) => e.data.blocked === true).length;
  const overridden = lastChange?.data.overridden === true ? 1 : 0;

  const packNo = existingPackCount(sessionId) + 1;
  const body: EvidencePack = {
    schema: EVIDENCE_SCHEMA,
    packId: `${safeId(sessionId)}.${packNo}`,
    sessionId,
    project: ctx.project ?? {},
    task: {
      title: ctx.task?.title ?? (started.title as string | undefined),
      promptSha256: ctx.task?.prompt ? sha256(ctx.task.prompt) : (prompt.sha256 as string | undefined),
      promptChars: ctx.task?.prompt ? ctx.task.prompt.length : (prompt.chars as number | undefined),
    },
    agent: {
      id: ctx.agent?.id ?? (started.agentId as string | undefined),
      model: ctx.agent?.model ?? ((started.model as string | undefined) ?? null),
      reasoning: ctx.agent?.reasoning ?? ((started.reasoning as string | undefined) ?? null),
      mode: ctx.agent?.mode ?? (started.mode as string | undefined),
      workMode: ctx.agent?.workMode ?? (started.workMode as string | undefined),
    },
    isolation: ctx.isolation ?? {},
    checks,
    returnedToAgent,
    policy: { scans: scans.length, findings, blocked, inChanges, overridden },
    review: {
      approvedBy: ctx.approvedBy,
      approvedAt: Date.now(),
      files: ctx.files ?? [],
    },
    result: { applied: ctx.applied ?? [], removed: ctx.removed ?? [], commit: ctx.commit ?? null, trigger: ctx.trigger ?? "applied" },
    ledger: {
      schema: LEDGER_SCHEMA,
      events: verdict.events,
      head: verdict.head,
      file: `provenance/${safeId(sessionId)}.jsonl`,
      intact: verdict.ok,
    },
    producedBy: { product: "Dirigo", version: ctx.version ?? "" },
    producedAt: Date.now(),
  };
  body.signature = signPayload({ ...body, signature: undefined });
  return body;
}

function existingPackCount(sessionId: string): number {
  try {
    const prefix = `${safeId(sessionId)}.pack`;
    return readdirSync(provDir()).filter((f) => f.startsWith(prefix) && f.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

/** Сохранить пакет рядом с журналом. Возвращает путь или null. */
export function savePack(pack: EvidencePack): string | null {
  try {
    const n = Number(pack.packId.split(".").pop() ?? 1);
    const file = packFile(pack.sessionId, n);
    writeFileSync(file, JSON.stringify(pack, null, 2), "utf8");
    return file;
  } catch {
    return null;
  }
}

export function listPacks(from?: number, to?: number): EvidencePack[] {
  const out: EvidencePack[] = [];
  let files: string[] = [];
  try { files = readdirSync(provDir()).filter((f) => f.includes(".pack") && f.endsWith(".json")); } catch { return out; }
  for (const f of files.sort()) {
    try {
      const pack = JSON.parse(readFileSync(join(provDir(), f), "utf8")) as EvidencePack;
      if (from && pack.producedAt < from) continue;
      if (to && pack.producedAt > to) continue;
      out.push(pack);
    } catch { /* повреждённый файл не должен ломать выгрузку остальных */ }
  }
  return out;
}

export interface EvidenceBundle {
  schema: "dirigo.bundle/1";
  generatedAt: number;
  range: { from: number | null; to: number | null };
  publicKey: { keyId: string; alg: "ed25519"; pem: string };
  packs: EvidencePack[];
  verification: {
    signatures: { total: number; valid: number };
    ledgers: { total: number; intact: number };
    howTo: string;
  };
}

/** Выгрузка за период: пакеты + открытый ключ + сводка проверки. */
export function exportBundle(from?: number, to?: number): EvidenceBundle {
  const packs = listPacks(from, to);
  const key = publicKeyInfo();
  let valid = 0;
  for (const p of packs) {
    if (p.signature && verifySignature({ ...p, signature: undefined }, p.signature, key.publicKeyPem)) valid++;
  }
  const intact = packs.filter((p) => p.ledger.intact).length;
  return {
    schema: "dirigo.bundle/1",
    generatedAt: Date.now(),
    range: { from: from ?? null, to: to ?? null },
    publicKey: { keyId: key.keyId, alg: "ed25519", pem: key.publicKeyPem },
    packs,
    verification: {
      signatures: { total: packs.length, valid },
      ledgers: { total: packs.length, intact },
      howTo:
        "Каждый пакет подписан ключом инстанса (Ed25519). Проверка: взять пакет без поля " +
        "signature, сериализовать стабильно (ключи объектов по алфавиту), проверить подпись " +
        "открытым ключом из publicKey.pem. Цепочку событий проверяет GET /api/evidence/verify " +
        "или повторный расчёт sha256 по полям [seq, at, sessionId, type, data, prev].",
    },
  };
}

/** Трейлеры для коммита: читаются глазами в `git log`, не требуют инструментов. */
export function commitTrailers(pack: EvidencePack): string[] {
  const checksOk = pack.checks.filter((c) => c.ok).length;
  const lines = [
    `Dirigo-Agent: ${pack.agent.id ?? "unknown"}`,
    pack.agent.model ? `Dirigo-Model: ${pack.agent.model}` : "",
    `Dirigo-Checks: ${checksOk}/${pack.checks.length} pass`,
    pack.returnedToAgent ? `Dirigo-Returned-To-Agent: ${pack.returnedToAgent}` : "",
    pack.review.approvedBy ? `Dirigo-Approved-By: ${pack.review.approvedBy}` : "",
    `Dirigo-Evidence: ${pack.packId}`,
    `Dirigo-Ledger-Head: ${pack.ledger.head.slice(0, 16)}`,
  ];
  return lines.filter(Boolean);
}

/**
 * Трейлеры прямо из журнала, без сборки пакета — для коммита, который делает
 * пульт до применения изменений.
 */
export function ledgerTrailers(sessionId: string): string[] {
  const events = readLedger(sessionId);
  if (!events.length) return [];
  const started = events.find((e) => e.type === "agent.started")?.data ?? {};
  const checks = events.filter((e) => e.type === "checks.run");
  const okChecks = checks.filter((e) => e.data.ok === true).length;
  const returned = events.filter((e) => e.type === "checks.returned").length;
  const head = events[events.length - 1]!.hash;
  return [
    started.agentId ? `Dirigo-Agent: ${started.agentId}` : "",
    started.model ? `Dirigo-Model: ${started.model}` : "",
    checks.length ? `Dirigo-Checks: ${okChecks}/${checks.length} pass` : "",
    returned ? `Dirigo-Returned-To-Agent: ${returned}` : "",
    `Dirigo-Ledger-Head: ${head.slice(0, 16)}`,
  ].filter(Boolean) as string[];
}
