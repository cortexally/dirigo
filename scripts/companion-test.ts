#!/usr/bin/env bun
// Компаньон (F-V6-2, FBA): e2e-гейт приёмки.
// Сценарий: сохранил настройку → спросил → ответ компаньона → видно в логе → очистил.
// Запуск: bun run scripts/companion-test.ts  (свой демон на изолированных данных —
// боевой db.json и живой :7171 не трогает; урок H-V6-4: уникальный каталог на прогон).
import { mkdirSync, readFileSync, rmSync } from "node:fs";

const PORT = 7386;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = `${import.meta.dir}/../.smoke-companion`;
rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });

const server = Bun.spawn([process.execPath, "run", "src/server.ts"], {
  env: { ...process.env, PORT: String(PORT), DIRIGO_DATA: DATA },
  stdout: "ignore", stderr: "ignore",
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jpost = async (p: string, b: unknown) => {
  const r = await fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
  return { status: r.status, body: (await r.json().catch(() => null)) as any };
};
const jdel = async (p: string) => {
  const r = await fetch(BASE + p, { method: "DELETE" });
  return { status: r.status, body: (await r.json().catch(() => null)) as any };
};
const jget = async (p: string) => {
  const r = await fetch(BASE + p);
  return { status: r.status, body: (await r.json().catch(() => null)) as any };
};

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail.slice(0, 140) : ""}`);
  ok ? pass++ : fail++;
};

try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { try { up = (await fetch(`${BASE}/api/health`)).ok; if (!up) await sleep(300); } catch { await sleep(300); } }
  check("демон поднялся на изолированных данных", up);

  // 1. GET /api/companion — форма по умолчанию
  const g0 = await jget("/api/companion");
  check("GET /api/companion 200", g0.status === 200 && !!g0.body?.settings, JSON.stringify(g0.body?.settings?.role ?? "").slice(0, 80));
  check("дефолты настроек", g0.body?.settings?.role === "assistant" && g0.body?.settings?.tone === "neutral" && g0.body?.settings?.model === "kilo/kilo-auto/free");
  check("словари ролей/тонов отдаются", Array.isArray(g0.body?.roles) && Array.isArray(g0.body?.tones) && Array.isArray(g0.body?.providers));
  check("лог по умолчанию пуст", Array.isArray(g0.body?.messages) && g0.body.messages.length === 0);

  // 2. POST settings — сохранил настройку
  const s1 = await jpost("/api/companion", { settings: { role: "planner", tone: "concise", model: "kilo/kilo-auto/free" } });
  check("POST settings → ok", s1.status === 200 && s1.body?.ok === true && s1.body?.settings?.role === "planner", JSON.stringify(s1.body));
  const g1 = await jget("/api/companion");
  check("настройки переживают перечитывание", g1.body?.settings?.role === "planner" && g1.body?.settings?.tone === "concise");

  // 3. мусор в settings неaccepted
  const s2 = await jpost("/api/companion", { settings: { role: "нет-такой-роли" } });
  check("невалидная роль отфильтрована (не 500)", s2.status === 200 && s2.body?.settings?.role !== "нет-такой-роли", JSON.stringify(s2.body?.settings?.role ?? ""));

  // 4. пустой текст → 400
  const bad = await jpost("/api/companion", { text: "   " });
  check("пустой text → 400", bad.status === 400, `${bad.status}`);

  // 5. вопрос → ответ компаньона
  const r1 = await jpost("/api/companion", { text: "Как добавить проект в Dirigo?" });
  check("ответ компаньона получен", r1.status === 200 && !!r1.body?.reply && r1.body.reply.length > 10, `source=${r1.body?.source}`);
  check("источник честный (local или llm)", r1.body?.source === "local" || r1.body?.source === "llm", `${r1.body?.source}`);
  const g2 = await jget("/api/companion");
  const log1 = g2.body?.messages ?? [];
  check("диалог в логе: пара user→companion", log1.length === 2 && log1[0]?.role === "user" && log1[1]?.role === "companion", `len=${log1.length}`);
  check("ответ совпадает с возвращённым", log1[1]?.text === r1.body?.reply, "");
  check("метка источника в логе", log1[1]?.source === r1.body?.source, `${log1[1]?.source}`);

  // 6. второй обмен + ограничение истории
  await jpost("/api/companion", { text: "Какие агенты доступны?" });
  const g3 = await jget("/api/companion");
  check("второй обмен добавился (4 записи)", (g3.body?.messages ?? []).length === 4, `len=${(g3.body?.messages ?? []).length}`);

  // 7. persistence в db.json (данные реально в store, не только в памяти)
  const dbRaw = JSON.parse(readFileSync(`${DATA}/db.json`, "utf8"));
  check("companion в db.json (settings+messages)", dbRaw?.companion?.settings?.role === "planner" && Array.isArray(dbRaw.companion?.messages) && dbRaw.companion.messages.length === 4, "");

  // 8. очистка лога (настройки остаются)
  const c1 = await jdel("/api/companion");
  check("DELETE лога → ok", c1.status === 200 && c1.body?.ok === true, `${c1.status}`);
  const g4 = await jget("/api/companion");
  check("лог пуст, настройки на месте", (g4.body?.messages ?? []).length === 0 && g4.body?.settings?.role === "planner");

  const tc = await jpost("/api/companion", { action: "clear" });
  check("POST action=clear тоже работает", tc.status === 200 && tc.body?.ok === true, `${tc.status}`);

  console.log(`\nИтог: ${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
} finally {
  server.kill();
  try { server.unref?.(); } catch { /* noop */ }
}
