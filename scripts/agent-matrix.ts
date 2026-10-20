#!/usr/bin/env bun
// Сквозная проверка ВСЕХ агентов во ВСЕХ режимах.
//
// Зачем. Дефекты вида «opencode не запускается», «у freebuff нет CLI»,
// «у kilo пропадают сообщения» находились руками, по одному, и каждый раз
// заново. Этот набор проходит за пользователя полный путь по каждому агенту
// и каждому режиму и говорит, что именно сломано.
//
// Принцип: проверяется КОНТРАКТ, а не состав софта на машине.
//   режим доступен   → сессия обязана стартовать и подать признаки жизни;
//   режим недоступен → отказ 409 с причиной и подсказкой, сессии не создаётся.
// Поэтому набор одинаково осмыслен и на машине без единого агента, и на машине,
// где установлено всё.
//
// Запуск:  bun run scripts/agent-matrix.ts            (против своего демона)
//          DIRIGO_PORT=7399 bun run scripts/agent-matrix.ts   (против живого)
//          DIRIGO_MATRIX_AGENTS=kilo,opencode ...     (только эти агенты)
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PORT = Number(process.env.DIRIGO_PORT ?? 7411);
const BASE = `http://127.0.0.1:${PORT}`;
const ONLY = (process.env.DIRIGO_MATRIX_AGENTS ?? "").split(",").map((x) => x.trim()).filter(Boolean);
/** Сколько ждём признаков жизни от режима. Реальные агенты думают долго. */
const LIVE_MS = Number(process.env.DIRIGO_MATRIX_LIVE_MS ?? 45_000);
/** Сколько раз повторить ожидание, прежде чем признать отсутствие жизни.
 *  Живые агенты иногда стартуют медленно (холодный кэш, сеть, лимиты), и
 *  набор, падающий через раз, бесполезен как релизный гейт. */
const LIVE_RETRIES = Number(process.env.DIRIGO_MATRIX_RETRIES ?? 2);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  ok ? pass++ : fail++;
};

const jget = async (p: string) => {
  const r = await fetch(BASE + p);
  return { status: r.status, body: await r.json().catch(() => null) as any };
};
const jpost = async (p: string, b: unknown = {}) => {
  const r = await fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
  return { status: r.status, body: await r.json().catch(() => null) as any };
};

/* ── демон: свой, если чужого нет ── */
const alive = async () => { try { return (await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(900) })).ok; } catch { return false; } };
let own: Bun.Subprocess | null = null;
const OWN_DATA = join(import.meta.dir, "..", `.matrix-data-${Math.random().toString(36).slice(2, 8)}`);
if (!(await alive())) {
  mkdirSync(OWN_DATA, { recursive: true });
  own = Bun.spawn([process.execPath, "run", "src/server.ts"], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, PORT: String(PORT), DIRIGO_DATA: OWN_DATA },
    stdout: "ignore", stderr: "ignore",
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && !(await alive())) await sleep(300);
  if (!(await alive())) { console.error("демон не поднялся"); process.exit(1); }
}
const cleanup = () => {
  if (own) { try { process.kill(own.pid, "SIGKILL"); } catch { /* мёртв */ } }
  try { rmSync(OWN_DATA, { recursive: true, force: true }); } catch { /* занято */ }
};
process.on("exit", cleanup);

/* ── проект: настоящая папка с git, как у пользователя ── */
const REPO = join(import.meta.dir, "..", `.matrix-repo-${Math.random().toString(36).slice(2, 8)}`);
rmSync(REPO, { recursive: true, force: true });
mkdirSync(REPO, { recursive: true });
writeFileSync(join(REPO, "README.md"), "# matrix\n");
Bun.spawnSync(["git", "init", "-q", "-b", "main", "."], { cwd: REPO });
Bun.spawnSync(["git", "add", "-A"], { cwd: REPO });
Bun.spawnSync(["git", "-c", "user.email=m@t", "-c", "user.name=m", "commit", "-qm", "init"], { cwd: REPO });
const proj = await jpost("/api/projects", { name: "matrix", path: REPO });
const pid = proj.body?.id as string;
check("проект для матрицы создан", !!pid, String(proj.status));

const agents = (await jget("/api/agents")).body ?? [];
check("реестр агентов отвечает", Array.isArray(agents) && agents.length > 0, `${agents.length}`);

const UI_MODE: Record<string, string> = { cli: "cli", persistent: "acp", pty: "pty", web: "web" };

/** Ждём, пока сессия подаст признак жизни: статус, вывод или экран. */
async function waitAlive(id: string, mode: string): Promise<{ status: string; signs: string; fail?: string }> {
  const deadline = Date.now() + LIVE_MS;
  let last = { status: "", signs: "", fail: undefined as string | undefined };
  while (Date.now() < deadline) {
    const d = (await jget(`/api/sessions/${id}`)).body;
    const logLen = ((await jget(`/api/sessions/${id}/log?n=all`)).body?.lines ?? []).join("\n").length;
    const screen = mode === "pty" ? ((await jget(`/api/sessions/${id}/screen`)).body?.lines ?? []) : [];
    const screenText = screen.map((l: any) => l.text).join("").trim().length;
    last = {
      status: d?.status ?? "",
      signs: `лог ${logLen}${mode === "pty" ? `, экран ${screenText}` : ""}${d?.webUrl ? `, url ${d.webUrl}` : ""}`,
      fail: d?.failReason,
    };
    if (d?.status === "error") break;
    if (mode === "web" && d?.webUrl) break;
    if (mode === "pty" && screenText > 40) break;
    if (mode === "cli" && (d?.status === "done" || logLen > 200)) break;
    if (mode === "acp" && (d?.externalRef || (d?.messages ?? []).length > 1)) break;
    await sleep(1200);
  }
  return last;
}

for (const a of agents as any[]) {
  if (ONLY.length && !ONLY.includes(a.id)) continue;
  const av = a.availability;
  if (!av) { check(`${a.id}: доступность известна`, false, "нет поля availability"); continue; }

  for (const m of av.modes) {
    const ui = UI_MODE[m.mode]!;
    const title = `${a.id} · ${m.label}`;
    const body: Record<string, unknown> = { agentId: a.id, projectId: pid, mode: ui, worktree: false };
    if (ui === "cli" || ui === "pty" || ui === "acp") body.prompt = "скажи ок одним словом";

    const r = await jpost("/api/sessions", body);

    if (!m.available) {
      // Контракт отказа: 409, причина, подсказка, сессия не создана.
      const okStatus = r.status === 409;
      const okReason = typeof r.body?.reason === "string" && r.body.reason.length > 5;
      const okFix = typeof r.body?.fix === "string" && r.body.fix.length > 3;
      check(`${title}: отказ объяснён`, okStatus && okReason && okFix,
        `${r.status} ${String(r.body?.reason ?? r.body?.error ?? "").slice(0, 70)}`);
      continue;
    }

    if (r.status !== 201) {
      check(`${title}: сессия стартует`, false, `${r.status} ${String(r.body?.error ?? "").slice(0, 70)}`);
      continue;
    }
    const id = r.body.id as string;
    let live = await waitAlive(id, ui);
    for (let attempt = 1; attempt <= LIVE_RETRIES; attempt++) {
      const silent = !/лог [1-9]/.test(live.signs) && !/экран [1-9]/.test(live.signs) && !live.signs.includes("url ");
      if (!silent || live.status === "error" || live.status === "done") break;
      live = await waitAlive(id, ui);                 // даём агенту ещё один круг
    }

    // Живой режим обязан дать признаки жизни и не упасть с ошибкой запуска.
    // Дефект пульта (бинарь не найден, нет папки, не поднялся процесс) —
    // это провал. Отказ самого агента (нет входа, нет ключа, лимит) — это его
    // состояние: пульт обязан его ВНЯТНО показать, но виноват не он.
    const reason = live.fail ?? "";
    const agentState = /log ?in|login|sign in|authenticat|not logged|ключ|вход|credit|quota|limit/i.test(reason);
    const brokenStart = live.status === "error" && !agentState
      && /не найден|не установлен|не запустил|Папка проекта|ENOENT|spawn/i.test(reason);
    check(`${title}: запустился`, !brokenStart, live.fail ?? live.signs);
    if (!brokenStart) {
      const hasSigns = /лог [1-9]/.test(live.signs) || /экран [1-9]/.test(live.signs) || live.signs.includes("url ");
      check(`${title}: подаёт признаки жизни`, hasSigns, `${live.status}: ${live.signs}`);
      // Ошибка без объяснения — отдельный дефект: «Error» без причины.
      if (live.status === "error") {
        check(`${title}: ошибка объяснена`, !!live.fail, live.fail ?? "причина не указана");
      }
    } else {
      check(`${title}: причина падения названа`, !!reason, reason || "причина не указана");
    }
    await jpost(`/api/sessions/${id}/stop`, {});
    await fetch(`${BASE}/api/sessions/${id}`, { method: "DELETE" });
  }

  // Список моделей: либо реальный от агента, либо честная причина.
  const models = (await jget(`/api/agents/${a.id}/models`)).body;
  check(`${a.id}: список моделей внятен`,
    !!models && (models.source === "agent" ? models.models.length > 0
      : models.source === "registry" ? true
      : models.models.length === 0),
    `${models?.source} ${models?.models?.length ?? 0}${models?.error ? " · " + String(models.error).slice(0, 50) : ""}`);
}

// Уборка: на Windows папку может ещё держать уходящий процесс агента —
// несколько попыток, и падение уборки не выдаётся за провал матрицы.
for (let i = 0; i < 5; i++) {
  try { rmSync(REPO, { recursive: true, force: true }); break; }
  catch { await sleep(1500); }
}
console.log(`\n${pass}/${pass + fail} passed`);
if (fail) {
  console.log("\nне прошли:");
  for (const r of results.filter((x) => !x.ok)) console.log(`  ${r.name} — ${r.detail}`);
}
process.exit(fail ? 1 : 0);
