#!/usr/bin/env bun
// Живой диалог (ACP) после переподключения — на настоящем агенте (1.9.2).
//
// Регресс (devin, 18.10): после обновления пульта сессия переподключилась —
//  • агент проиграл историю на session/load, и прошлые ответы легли в ленту
//    второй раз;
//  • счётчик ходов начался с нуля: новые ответы получали id старых, а ход
//    одними размышлениями не попадал в ленту («инструменты вызывает — вывода нет»).
// Сценарий: ход → перезапуск демона (= переподключение) → ход. В ленте: два
// ответа отдельными сообщениями, без дублей истории.
//
//   bun run scripts/e2e-acp-reconnect.ts      DIRIGO_RECONNECT_AGENT=devin — конкретный агент
import { join } from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";

const PORT = Number(process.env.E2E_RC_PORT ?? 7284);
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = join(import.meta.dir, "..", `.smoke-acp-reconnect-${PORT}`);
rmSync(ROOT, { recursive: true, force: true });
const repo = join(ROOT, "repo");
mkdirSync(repo, { recursive: true });
writeFileSync(join(repo, "a.txt"), "x\n");
for (const c of [["git", "init", "-q", "-b", "main"], ["git", "config", "user.email", "t@t"], ["git", "config", "user.name", "t"], ["git", "add", "-A"], ["git", "commit", "-qm", "i"]]) Bun.spawnSync(c, { cwd: repo });

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  ok ? pass++ : fail++;
};
const start = () => Bun.spawn([process.execPath, "run", "src/server.ts"], {
  cwd: join(import.meta.dir, ".."), env: { ...process.env, PORT: String(PORT), DIRIGO_DATA: join(ROOT, "data") }, stdout: "ignore", stderr: "ignore",
});
const up = async () => { for (let i = 0; i < 80; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) return true; } catch { /* */ } await Bun.sleep(250); } return false; };
const jpost = async (p: string, b: unknown) => { const r = await fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }); return { status: r.status, body: await r.json().catch(() => null) as any }; };
const jget = async (p: string) => (await fetch(BASE + p)).json() as any;
const waitIdle = async (id: string, ms = 180_000) => {
  const t = Date.now(); await Bun.sleep(3000);
  while (Date.now() - t < ms) { const s = await jget(`/api/sessions/${id}`); if (!s.activity?.busy && s.status !== "queued") return s; await Bun.sleep(1500); }
  return jget(`/api/sessions/${id}`);
};

let srv = start();
try {
  check("демон поднялся", await up());
  const { pickAgent } = await import("./pick-agent");
  const want = process.env.DIRIGO_RECONNECT_AGENT;
  const agents = await jget("/api/agents") as any[];
  const canAcp = (id: string) => agents.find((a) => a.id === id)?.availability?.modes?.some((m: any) => m.mode === "persistent" && m.available);
  const agent = want && canAcp(want) ? want : ["kilo", "devin", "opencode"].find(canAcp) ?? await pickAgent(BASE, "persistent");
  if (!agent) { console.log("SKIP  нет агента с живым диалогом — сценарий неприменим"); }
  else {
    const pid = (await jpost("/api/projects", { name: "rc", path: repo })).body.id;
    const s = await jpost("/api/sessions", { agentId: agent, projectId: pid, mode: "acp", prompt: "Ответь одним словом: ПЕРВЫЙ" });
    check(`${agent}: сессия живого диалога создана`, s.status === 201, `${s.status} ${s.body?.error ?? ""}`);
    const id = s.body.id;
    let ses = await waitIdle(id);
    const replies1 = (ses.messages ?? []).filter((m: any) => m.role !== "user");
    if (process.env.DEBUG_RC) console.log(JSON.stringify(ses.messages?.map((m: any) => [m.id, m.role, String(m.text).slice(0, 80)])), JSON.stringify(ses.activity ?? {}).slice(0, 200), ses.status);
    const okReply = (t: string, word: RegExp) => word.test(t) || /размышлениями|без ответа/i.test(t);
    check(`${agent}: первый ход — ответ в ленте (не пустой)`, replies1.some((m: any) => okReply(String(m.text), /ПЕРВЫЙ/i)), replies1.map((m: any) => String(m.text).slice(0, 40)).join(" | "));
    // перезапуск демона = переподключение к агенту (как после обновления пульта)
    srv.kill(); await Bun.sleep(1500); srv = start();
    check("демон перезапущен", await up());
    await jpost(`/api/sessions/${id}/messages`, { text: "Ответь одним словом: ВТОРОЙ" });
    ses = await waitIdle(id);
    const replies2 = (ses.messages ?? []).filter((m: any) => m.role !== "user");
    const texts = replies2.map((m: any) => String(m.text));
    const firstCount = texts.filter((t: string) => /ПЕРВЫЙ/i.test(t) && !/ВТОРОЙ/i.test(t)).length;
    check(`${agent}: история после переподключения не дублируется в ленте`, firstCount === replies1.filter((m: any) => /ПЕРВЫЙ/i.test(m.text)).length, texts.map((t: string) => t.slice(0, 30)).join(" | "));
    check(`${agent}: ответ после переподключения — новым сообщением`, replies2.length > replies1.length && texts.some((t: string) => /ВТОРОЙ|размышлениями|без ответа/i.test(t)), texts.slice(-2).map((t: string) => t.slice(0, 50)).join(" | "));
    check(`${agent}: старый ответ не изменён`, String(replies1[0]?.text) === String(replies2[0]?.text));
    // №6 (промо-съёмка): «Перезапустить» у остановленной ACP-сессии отвечал ok,
    // агент подключался, а сессия навсегда оставалась «остановлена»
    await jpost(`/api/sessions/${id}/stop`, {});
    await Bun.sleep(1500);
    const rs = await jpost(`/api/sessions/${id}/restart`, {});
    let st = "";
    for (let i = 0; i < 90; i++) { await Bun.sleep(1000); st = (await jget(`/api/sessions/${id}`)).status; if (st === "running" || st === "error") break; }
    check(`${agent}: рестарт остановленной сессии поднимает её (не «stopped»)`, rs.status === 200 && st === "running", `ответ ${rs.status}, статус ${st}`);
    await fetch(`${BASE}/api/sessions/${id}`, { method: "DELETE" }).catch(() => null);
  }
} catch (e) {
  check("без исключений", false, String(e).slice(0, 240));
} finally {
  srv.kill();
  await Bun.sleep(800);
  for (let i = 0; i < 5; i++) { try { rmSync(ROOT, { recursive: true, force: true }); break; } catch { await Bun.sleep(800); } }
}
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
