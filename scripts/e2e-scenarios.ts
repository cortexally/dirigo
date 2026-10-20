#!/usr/bin/env bun
// Пользовательские сценарии пульта — так, как их проходит человек.
//
// Главное отличие от остальных сьютов: сессии создаются через диалог «Новая
// сессия» с его настройками ПО УМОЛЧАНИЮ, а не через API. Прежние тесты
// создавали сессии API-запросом и поэтому не видели дефектов самого диалога:
// он подставлял первую модель из списка, и opencode в «Терминале» падал на
// неизвестном флаге --model.
//
//   bun run scripts/e2e-scenarios.ts                     все агенты, свой демон
//   DIRIGO_SCENARIO_AGENTS=freebuff,claude-code ...       только эти агенты
//   DIRIGO_SCENARIOS=pty,modes,acp ...                    только эти блоки
//   DIRIGO_URL=http://127.0.0.1:7399 ...                  против живого демона
//
// Блоки:
//   pty   — задача из диалога доходит до TUI (стартовые вопросы агента
//           проходятся), сессия не падает, текст из нижнего поля доходит при
//           фокусе вне терминала, ввод одной сессии не попадает в другую;
//   modes — каждый агент × каждый доступный режим: сессия из диалога с
//           настройками по умолчанию не падает в первые секунды;
//   acp   — живой диалог: пузырь хода работы с таймером, ответ, «/model».
import { chromium, type Page } from "playwright";
import { detectAuthPrompt } from "../src/agents/runner";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ONLY = (process.env.DIRIGO_SCENARIO_AGENTS ?? "").split(",").map((x) => x.trim()).filter(Boolean);
const BLOCKS = new Set((process.env.DIRIGO_SCENARIOS ?? "pty,modes,acp").split(",").map((x) => x.trim()));
const SHOTS = process.env.DIRIGO_E2E_SHOTS ?? join(tmpdir(), "dirigo-e2e-shots");
mkdirSync(SHOTS, { recursive: true });

/* ── демон и проект: свои, если не задан чужой ── */
const OWN = !process.env.DIRIGO_URL;
const PORT = (() => {
  const srv = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {}, open() {}, close() {}, error() {} } });
  const p = srv.port; srv.stop(true); return p;
})();
const BASE = process.env.DIRIGO_URL ?? `http://127.0.0.1:${PORT}`;
const TMP = join(import.meta.dir, "..", `.e2e-scn-${Date.now().toString(36)}`);
let own: Bun.Subprocess | null = null;
if (OWN) {
  mkdirSync(join(TMP, "data"), { recursive: true });
  own = Bun.spawn([process.execPath, "run", "src/server.ts"], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, PORT: String(PORT), DIRIGO_DATA: join(TMP, "data") },
    stdout: "ignore", stderr: "ignore",
  });
  for (let i = 0; i < 120; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* */ } await Bun.sleep(250); }
}
const REPO = join(TMP, "repo");
mkdirSync(REPO, { recursive: true });
writeFileSync(join(REPO, "README.md"), "# e2e scenarios\n");
for (const cmd of [["git", "init", "-q", "-b", "main"], ["git", "add", "-A"], ["git", "-c", "user.email=e2e@dirigo", "-c", "user.name=e2e", "commit", "-qm", "init"]]) Bun.spawnSync(cmd, { cwd: REPO });

let pass = 0, fail = 0;
const fails: string[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (ok) pass++; else { fail++; fails.push(`${name}${detail ? " — " + detail : ""}`); }
};
const api = async (path: string, init?: { method?: string; body?: unknown }) => {
  const r = await fetch(BASE + "/api" + path, {
    method: init?.method ?? "GET", headers: { "content-type": "application/json" },
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  return r.json().catch(() => ({})) as Promise<any>;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const proj = await api("/projects", { method: "POST", body: { name: "e2e-scn", path: REPO } });
const agents = (await api("/agents")) as any[];
const modeOk = (a: any, m: string) => (a.availability?.modes ?? []).some((x: any) => x.mode === m && x.available);
const want = (a: any) => !ONLY.length || ONLY.includes(a.id);

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const jsErrors: string[] = [];
page.on("pageerror", (e) => jsErrors.push(String(e)));
await page.goto(BASE + "/");
await page.waitForSelector("#nav-new");

/** Новая сессия ЧЕРЕЗ ДИАЛОГ: агент, режим, задача — остальное по умолчанию. */
async function createViaDialog(agentId: string, mode: string, task: string): Promise<string | null> {
  const before = new Set(((await api("/sessions")) as any[]).map((s) => s.id));
  await page.click("#nav-new");
  await page.waitForSelector("#new-session-modal", { timeout: 8000 });
  await page.click(`[data-ns-agent="${agentId}"]`);
  await sleep(400);
  const uiMode = mode === "persistent" ? "acp" : mode;
  const ok = await page.evaluate((m) => {
    const sel = document.getElementById("ns-mode") as HTMLSelectElement;
    const opt = [...sel.options].find((o) => o.value === m && !o.disabled);
    if (!opt) return false;
    sel.value = m; sel.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }, uiMode);
  if (!ok) { await page.click("#ns-cancel"); return null; }
  // настройки по умолчанию — проверяем, что они действительно «агентские»
  const dflt = await page.evaluate(() => ({
    model: (document.getElementById("ns-model") as HTMLSelectElement).value,
    reasoning: (document.getElementById("ns-reasoning") as HTMLSelectElement).value,
  }));
  check(`${agentId}/${mode}: диалог не навязывает модель и уровень`, dflt.model === "" && dflt.reasoning === "", JSON.stringify(dflt));
  await page.fill("#ns-prompt", task);
  await page.click("#ns-go");
  for (let i = 0; i < 40; i++) {
    const now = ((await api("/sessions")) as any[]).find((s) => !before.has(s.id));
    if (now) { await page.waitForSelector("#view-chat:not(.hidden)", { timeout: 8000 }).catch(() => {}); return now.id; }
    await sleep(250);
  }
  const err = await page.textContent("#ns-err").catch(() => "");
  await page.click("#ns-cancel").catch(() => {});
  check(`${agentId}/${mode}: сессия создалась`, false, String(err ?? "").slice(0, 120));
  return null;
}

const screenOf = async (id: string) => (((await api(`/sessions/${id}/screen`)).lines ?? []) as any[]).map((l) => String(l.text)).join("\n");
const browserScreen = (p: Page) => p.evaluate(() =>
  [...document.querySelectorAll("#pty-term .xterm-rows > div")].map((r) => (r as HTMLElement).innerText.replace(/ /g, " ").trimEnd()).join("\n"));

/** Стартовые вопросы TUI (доверие к папке, тема): стрелками к «да» и Enter.
 *  Клавиши — настоящие, через xterm в браузере: он сам кодирует стрелки по
 *  режиму приложения (ESC [ B или ESC O B), как это происходит у человека. */
const DIALOG = /Do you trust|trust this folder|Trust Required|Detected (light|dark) theme|Switch theme\?|Switch\?/i;
async function waitDialog(id: string, ms = 3000): Promise<string> {
  let text = "";
  // «вопрос активен» — то же правило, что в пульте (старое окно выше экрана не в счёт)
  for (let i = 0; i < ms / 500; i++) { text = await screenOf(id); if (DIALOG.test(text) && detectAuthPrompt(text)?.kind === "choice") return text; await sleep(500); }
  return "";
}
async function passDialogs(id: string): Promise<number> {
  let n = 0;
  for (let round = 0; round < 4; round++) {
    const text = await waitDialog(id);
    if (!text) return n;
    await page.focus("#pty-term textarea");
    const lines = text.split("\n").map((l) => l.replace(/[│┃]/g, " "));
    const sel = lines.findIndex((l) => /^\s*[❯›▶❭>]\s*\S/.test(l));
    // пункт «да» — строка, которая САМА начинается с yes/trust ([a], «1.», маркер),
    // а не вопрос «…one you trust?» над пунктами
    const yes = lines.findIndex((l, i) => Math.abs(i - (sel < 0 ? i : sel)) <= 8
      && /^\s*([❯›▶❭>]\s*)?(\d+[.)]?\s*)?(\[\w\]\s*)?(yes\b|trust\b)/i.test(l) && !/\bno\b|quit|exit|don.t/i.test(l));
    if (sel >= 0 && yes >= 0) for (let k = 0; k < Math.abs(yes - sel); k++) { await page.keyboard.press(yes > sel ? "ArrowDown" : "ArrowUp"); await sleep(150); }
    const before = await screenOf(id);
    await page.keyboard.press("Enter");
    for (let i = 0; i < 20 && (await screenOf(id)) === before; i++) await sleep(300);
    n++;
    await sleep(1200);
  }
  return n;
}

const alive = async (id: string) => { const s = await api(`/sessions/${id}`); return { ok: s.status !== "error" && s.status !== "done", s }; };
const created: string[] = [];

/* ════════ pty: задача, нижнее поле при фокусе вне терминала, изоляция ════════ */
if (BLOCKS.has("pty")) {
  const ptyAgents = agents.filter((a) => want(a) && modeOk(a, "pty"));
  const tokens = new Map<string, string>();
  for (const a of ptyAgents) {
    const token = `ЗАДАЧА${a.id.replace(/[^a-z]/g, "").toUpperCase().slice(0, 6)}${Math.floor(Math.random() * 900 + 100)}`;
    tokens.set(a.id, token);
    const id = await createViaDialog(a.id, "pty", `напиши в ответ слово ${token}`);
    if (!id) continue;
    created.push(id);
    await page.waitForSelector("#pty-term .xterm-screen", { timeout: 15_000 }).catch(() => {});
    await sleep(4000);
    const st0 = await alive(id);
    check(`${a.id}/pty: TUI запустился и жив`, st0.ok, `${st0.s.status} ${st0.s.failReason ?? ""}`);
    if (!st0.ok) { await page.screenshot({ path: join(SHOTS, `scn-${a.id}-dead.png`) }); continue; }
    // Пока агент задаёт вопрос — текст из нижнего поля НЕ должен уходить:
    // Enter выбрал бы подсвеченный пункт (у Claude это «No, exit»).
    if (await waitDialog(id, 4000)) {
      await page.click("#prompt");
      await page.fill("#prompt", "не-отправлять-в-вопрос");
      await page.keyboard.press("Enter");
      await sleep(1500);
      const toastText = (await page.textContent("#toasts").catch(() => "")) ?? "";
      const st = await alive(id);
      check(`${a.id}/pty: во время вопроса агента нижнее поле не отвечает за человека`, st.ok && /ждёт ответа|вопрос/i.test(toastText) && !(await screenOf(id)).includes("не-отправлять-в-вопрос"),
        `${st.s.status}; ${toastText.slice(-80)}`);
      await page.fill("#prompt", "");
    }
    const dialogs = await passDialogs(id);
    // задача из диалога должна дойти до агента (и быть видна на экране)
    let delivered = false;
    for (let i = 0; i < 60 && !delivered; i++) { await sleep(1000); delivered = (await screenOf(id)).includes(token); }
    // Лимит бесплатного тарифа у самого агента (freebuff: «Not enough hours…»)
    // заменяет поле ввода окном оплаты — задачу не видно, но это аккаунт, а не пульт.
    const limitRe = /not enough hours|usage limit|requires more credits|out of credits|insufficient (credits|balance)/i;
    if (!delivered && limitRe.test(await screenOf(id))) {
      console.log(`SKIP  ${a.id}/pty: исчерпан лимит тарифа агента — доставку не проверить (${(await screenOf(id)).split("\n").find((l) => limitRe.test(l))?.trim().slice(0, 90)})`);
      continue;
    }
    check(`${a.id}/pty: задача из диалога дошла до агента${dialogs ? ` (вопросов при старте: ${dialogs})` : ""}`, delivered,
      delivered ? "" : (await screenOf(id)).split("\n").filter((l) => l.trim()).slice(-4).join(" | ").slice(0, 160)
        + " || журнал: " + (((await api(`/sessions/${id}/log?n=200`)).lines ?? []) as string[]).filter((l) => l.includes("[dirigo]")).slice(-4).join(" / ").slice(0, 300));
    // нижнее поле: фокус уходит из терминала — текст всё равно должен дойти
    const second = `ВТОРОЕ${Math.floor(Math.random() * 9000 + 1000)}`;
    await page.click("#prompt");
    await page.fill("#prompt", second);
    await page.keyboard.press("Enter");
    let got = false;
    for (let i = 0; i < 30 && !got; i++) { await sleep(700); got = (await screenOf(id)).includes(second); }
    check(`${a.id}/pty: текст из нижнего поля доходит (фокус вне терминала)`, got);
    const st1 = await alive(id);
    check(`${a.id}/pty: сессия жива после ввода`, st1.ok, `${st1.s.status} ${st1.s.failReason ?? ""}`);
    // экран в браузере совпадает с экраном демона — поток не потерялся.
    // Анимированные TUI меняют экран между двумя снимками — берём лучшую из попыток.
    // сверяем, когда агент затих (идёт ответ — экран меняется каждые 100 мс)
    { let prev = "", calm = 0; for (let k = 0; k < 60 && calm < 4; k++) { await sleep(500); const t = await screenOf(id); calm = t === prev ? calm + 1 : 0; prev = t; } }
    let best = 0, total = 0;
    for (let k = 0; k < 6 && best < total - 2 || k === 0; k++) {
      const d = (await screenOf(id)).split("\n").map((l) => l.trimEnd());
      const b = (await browserScreen(page)).split("\n").map((l) => l.trimEnd());
      total = d.length;
      best = Math.max(best, d.filter((l, i) => l === (b[i] ?? "")).length);
      if (best < total - 2) await sleep(400);
    }
    check(`${a.id}/pty: экран пульта = экран агента`, best >= total - 2, `${best}/${total}`);
    await page.screenshot({ path: join(SHOTS, `scn-${a.id}-pty.png`) });
    // одновременно живут не больше двух сессий (лимит копий — 8); последние
    // две остаются для проверки изоляции
    while (created.length > 2) {
      const old = created.shift()!;
      await api(`/sessions/${old}/stop`, { method: "POST" });
      await fetch(`${BASE}/api/sessions/${old}`, { method: "DELETE" });
    }
  }
  // ввод одной сессии не попадает в другую (две последние живые сессии)
  const ids = created.slice();
  if (ids.length >= 2) {
    let leaks = 0;
    for (const id of ids) {
      const s = await api(`/sessions/${id}`);
      const mine = tokens.get(s.agentId);
      const scr = await screenOf(id);
      for (const [agentId, tok] of tokens) if (agentId !== s.agentId && tok !== mine && scr.includes(tok)) leaks++;
    }
    check("pty: ввод одной сессии не попадает в другую", leaks === 0, `утечек ${leaks}`);
  }
  for (const id of created.splice(0)) { await api(`/sessions/${id}/stop`, { method: "POST" }); await fetch(`${BASE}/api/sessions/${id}`, { method: "DELETE" }); }
}

/* ════════ modes: каждый агент × каждый режим с настройками диалога ════════ */
if (BLOCKS.has("modes")) {
  for (const a of agents.filter(want)) {
    for (const m of ["cli", "persistent", "pty", "web"]) {
      if (!modeOk(a, m)) continue;
      if (m === "pty" && BLOCKS.has("pty")) continue;          // уже проверено выше подробно
      const id = await createViaDialog(a.id, m, m === "cli" ? "ответь одним словом: ок" : "");
      if (!id) continue;
      await sleep(m === "web" ? 6000 : 9000);
      const { ok, s } = await alive(id);
      // Отказ самого агента (нет входа, кредитов, лимит) — его состояние, а не
      // дефект пульта; дефект — неизвестный флаг, не найденный бинарь и т.п.
      const agentState = /log ?in|sign in|authenticat|credit|кредит|quota|limit|лимит|429|rate/i.test(String(s.failReason ?? ""));
      const reallyBroken = !ok && !agentState && /unrecognized|unknown (option|flag|argument)|invalid (option|flag)|не найден|ENOENT|кодом 1\b|usage:/i.test(`${s.failReason ?? ""} ${((await api(`/sessions/${id}/log?n=40`)).lines ?? []).join(" ")}`);
      check(`${a.id}/${m}: стартует с настройками диалога по умолчанию`, !reallyBroken, `${s.status} ${String(s.failReason ?? "").slice(0, 120)}`);
      await api(`/sessions/${id}/stop`, { method: "POST" });
      await fetch(`${BASE}/api/sessions/${id}`, { method: "DELETE" });
    }
  }
}

/* ════════ acp: ход работы, ответ, «/model» ════════ */
if (BLOCKS.has("acp")) {
  const acpAgent = agents.find((a) => want(a) && modeOk(a, "persistent") && a.id === "kilo")
    ?? agents.find((a) => want(a) && modeOk(a, "persistent") && a.availability?.auth?.signedIn);
  if (!acpAgent) check("acp: нет агента с живым диалогом — блок неприменим", true);
  else {
    const id = await createViaDialog(acpAgent.id, "persistent", "Ответь одним словом: привет");
    if (id) {
      created.push(id);
      // своё сообщение — в ленте сразу, а не после рукопожатия ACP
      let mine = false;
      for (let i = 0; i < 12 && !mine; i++) { await sleep(250); mine = await page.evaluate(() => [...document.querySelectorAll("#feed .oc-msg--user")].some((e) => (e as HTMLElement).innerText.includes("привет"))); }
      check(`acp/${acpAgent.id}: первое сообщение видно сразу (до подключения агента)`, mine);
      // пузырь «агент думает» с таймером — сразу, пока нет ответа
      let bubble = false, timer = "";
      for (let i = 0; i < 40 && !bubble; i++) {
        await sleep(250);
        bubble = await page.evaluate(() => !!document.getElementById("acp-typing"));
        timer = (await page.textContent("#acp-typing-time").catch(() => "")) ?? "";
      }
      check(`acp/${acpAgent.id}: пока агент думает — виден ход работы`, bubble, timer);
      await sleep(2500);
      const t2 = (await page.textContent("#acp-typing-time").catch(() => "")) ?? "";
      const reply = async () => page.evaluate(() => [...document.querySelectorAll("#feed .oc-msg--agent:not(.oc-typing)")].map((e) => (e as HTMLElement).innerText).join(" | "));
      let r = "";
      const sysNote = () => page.evaluate(() => [...document.querySelectorAll("#feed .oc-msg--system")].map((e) => (e as HTMLElement).innerText).join(" | "));
      for (let i = 0; i < 120 && !r.trim() && !/без ответа/.test(await sysNote()); i++) { await sleep(1000); r = await reply(); }
      check(`acp/${acpAgent.id}: таймер хода идёт`, !!t2 && t2 !== timer || !!r.trim(), `${timer} → ${t2}`);
      // исход хода всегда явный: ответ агента ИЛИ заметка «ход без ответа» — не тишина
      const note = await sysNote();
      check(`acp/${acpAgent.id}: ход закончился явно (ответ в ленте или заметка)`, !!r.trim() || /без ответа/.test(note), r.trim() ? r.trim().slice(0, 80) : note.slice(0, 80));
      // пузырь уходит, когда ход закончен (ответ виден раньше — он идёт кусками)
      let gone = false;
      for (let i = 0; i < 60 && !gone; i++) { await sleep(500); gone = !(await page.evaluate(() => !!document.getElementById("acp-typing"))); }
      check(`acp/${acpAgent.id}: после ответа пузырь хода исчез`, gone);
      // два сообщения подряд, пока агент отвечает: второе — в очередь, не «Ошибка»
      const agentCount = () => page.evaluate(() => [...document.querySelectorAll("#feed .oc-msg--agent:not(.oc-typing)")].filter((e) => (e as HTMLElement).innerText.trim()).length);
      const before2 = await agentCount();
      for (const q of ["Ответь одним словом: раз", "Ответь одним словом: два"]) {
        await page.click("#prompt"); await page.fill("#prompt", q); await page.keyboard.press("Enter"); await sleep(300);
      }
      let n2 = before2;
      for (let i = 0; i < 150 && n2 < before2 + 2; i++) { await sleep(1000); n2 = await agentCount(); }
      const stQ = await api(`/sessions/${id}`);
      check(`acp/${acpAgent.id}: сообщение во время ответа ждёт очереди, а не роняет сессию`, n2 >= before2 + 2 && stQ.status !== "error", `ответов +${n2 - before2}, статус ${stQ.status} ${stQ.failReason ?? ""}`);
      // «/model» — выбор модели, а не текст в модель
      await page.click("#prompt");
      await page.fill("#prompt", "/model");
      await page.keyboard.press("Enter");
      const picker = await page.waitForSelector("#acp-model-modal [data-acp-model]", { timeout: 8000 }).then(() => true).catch(() => false);
      check(`acp/${acpAgent.id}: «/model» открывает выбор модели`, picker);
      if (picker) {
        const target = await page.evaluate(() => {
          const btns = [...document.querySelectorAll("#acp-model-modal [data-acp-model]")] as HTMLElement[];
          return (btns.find((b) => !b.classList.contains("oc-cmdk__item--on")) ?? btns[0])!.dataset.acpModel!;
        });
        await page.click(`#acp-model-modal [data-acp-model="${target}"]`);
        let sys = false;
        for (let i = 0; i < 20 && !sys; i++) { await sleep(500); sys = await page.evaluate((m) => [...document.querySelectorAll("#feed .oc-msg--system")].some((e) => (e as HTMLElement).innerText.includes(m)), target); }
        check(`acp/${acpAgent.id}: смена модели видна в ленте`, sys, target);
        const s = await api(`/sessions/${id}`);
        check(`acp/${acpAgent.id}: модель диалога сменилась у агента`, s.acpModels?.current === target, `${s.acpModels?.current} vs ${target}`);
      }
      await page.screenshot({ path: join(SHOTS, `scn-acp-${acpAgent.id}.png`) });
    }
  }
  for (const id of created.splice(0)) { await api(`/sessions/${id}/stop`, { method: "POST" }); await fetch(`${BASE}/api/sessions/${id}`, { method: "DELETE" }); }
}

check("нет JS-ошибок в пульте", jsErrors.length === 0, jsErrors.slice(0, 2).join(" | "));

// После штатной остановки и удаления всех сессий у агентов не остаётся
// процессов на папках теста (хабы cline, сторожа freebuff, консоли ConPTY).
if (process.platform === "win32" && OWN) {
  await sleep(4000);                                  // отложенная уборка после stop
  const probe = TMP.toLowerCase().split("\\").join("/").replace(/'/g, "''");
  const script = "Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and ([string]$_.CommandLine).ToLower().Replace([char]92, [char]47).Contains('" + probe + "') } | ForEach-Object { \"$($_.ProcessId) $($_.Name)\" }";
  const ps = Bun.spawnSync(["powershell", "-NoProfile", "-NonInteractive", "-Command", script], { stdout: "pipe", stderr: "ignore", timeout: 20_000 });
  const left = ps.stdout.toString().split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/bun\.exe|powershell\.exe/i.test(l));
  check("после закрытия сессий не осталось процессов агентов", left.length === 0, left.slice(0, 4).join(", "));
}
await browser.close();
if (own) {
  if (process.platform === "win32") Bun.spawnSync(["taskkill", "/PID", String(own.pid), "/T", "/F"]); else own.kill();
}
for (let i = 0; i < 5; i++) { try { rmSync(TMP, { recursive: true, force: true }); break; } catch { await sleep(1500); } }
console.log(`\n${pass}/${pass + fail} passed  (скриншоты: ${SHOTS})`);
if (fails.length) { console.log("\nне прошли:"); for (const f of fails) console.log("  " + f); }
process.exit(fail ? 1 : 0);
