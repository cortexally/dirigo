import { rmSync } from "node:fs";
// Security-smoke для v2 (задача V2-6.1): rate-limit /api/auth/login, аудит
// авторизации (Bearer / cookie / unauth). Запуск: bun run scripts/smoke-security.ts
// Поднимает ВРЕМЕННЫЕ инстансы сервера на своих портах с изолированными
// хранилищами (.smoke-sec-a / .smoke-sec-b). Боевые данные не трогает.

const PORT_A = 7296; // auth + rate-limit логина
const PORT_B = 7295; // общий лимит /api/*
const BASE_A = `http://127.0.0.1:${PORT_A}`;
const BASE_B = `http://127.0.0.1:${PORT_B}`;
const BUN = process.execPath;
const ROOT = `${import.meta.dir}/..`;
const TOKEN = "smoke-secret-token";

type Check = { name: string; ok: boolean; detail: string };
const results: Check[] = [];
const rec = (name: string, ok: boolean, detail = "") => results.push({ name, ok, detail });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function spawnServer(port: number, data: string, extraEnv: Record<string, string> = {}) {
  return Bun.spawn([BUN, "run", "src/server.ts"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), DIRIGO_DATA: data, ...extraEnv },
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function waitHealth(base: string, timeoutMs = 15000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/api/health`, { headers: { authorization: `Bearer ${TOKEN}` } });
      if (r.ok) return true;
    } catch { /* ещё поднимается */ }
    await sleep(250);
  }
  return false;
}

const req = async (
  base: string, method: string, path: string,
  opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
) => {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const r = await fetch(base + path, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  return { status: r.status, headers: r.headers, body: await r.json().catch(() => null) as any };
};

const servers: ReturnType<typeof spawnServer>[] = [];
try {
  // ---------- инстанс A: токен + лимит попыток входа (3 / 2с) ----------
  const a = spawnServer(PORT_A, `${ROOT}/.smoke-sec-a`, {
    DIRIGO_TOKEN: TOKEN,
    DIRIGO_RL_LOGIN_MAX: "3",
    DIRIGO_RL_LOGIN_WIN_MS: "2000",
  });
  servers.push(a);
  rec("A: сервер с токеном поднялся", await waitHealth(BASE_A));

  // доступ без токена закрыт
  {
    const r = await req(BASE_A, "GET", "/api/health");
    rec("A: /api/health без токена → 401", r.status === 401, `${r.status}`);
  }
  // верный Bearer проходит, неверный — нет
  {
    const ok = await req(BASE_A, "GET", "/api/health", { token: TOKEN });
    const bad = await req(BASE_A, "GET", "/api/health", { token: "wrong-token" });
    rec("A: Bearer авторизация", ok.status === 200 && bad.status === 401, `ok=${ok.status} bad=${bad.status}`);
  }
  // /api/auth/check отражает требование токена
  {
    const r = await req(BASE_A, "GET", "/api/auth/check");
    rec("A: /api/auth/check → required=true", r.body?.required === true, JSON.stringify(r.body));
  }
  // общий лимит /api по умолчанию выключен: 25 health-запросов подряд — все 200
  {
    const codes: number[] = [];
    for (let i = 0; i < 25; i++) codes.push((await req(BASE_A, "GET", "/api/health", { token: TOKEN })).status);
    rec("A: общего лимита /api по умолчанию нет", codes.every((c) => c === 200), `уник.коды=${[...new Set(codes)].join(",")}`);
  }
  // rate-limit логина: 3 неверных → 401, 4-я → 429 с Retry-After
  {
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push((await req(BASE_A, "POST", "/api/auth/login", { body: { token: "wrong" } })).status);
    const last = await req(BASE_A, "POST", "/api/auth/login", { body: { token: "wrong" } });
    const retryAfter = last.headers.get("retry-after");
    rec("A: 3 неверных пароля, далее 429",
      codes.join(",") === "401,401,401,429" && last.status === 429,
      `коды=${codes.join(",")} последний=${last.status} retry-after=${retryAfter}`);
    rec("A: 429 несёт Retry-After", !!retryAfter && Number(retryAfter) >= 1, `retry-after=${retryAfter}`);
  }
  // окно истекает → верный токен снова проходит (и через cookie)
  await sleep(2200);
  {
    const login = await req(BASE_A, "POST", "/api/auth/login", { body: { token: TOKEN } });
    const cookie = login.headers.get("set-cookie") ?? "";
    const afterCookie = await req(BASE_A, "GET", "/api/health", { headers: { cookie: cookie.split(";")[0] } });
    rec("A: верный логин после окна → 200 + cookie",
      login.status === 200 && cookie.includes("dirigo_token=") && /HttpOnly/i.test(cookie) && afterCookie.status === 200,
      `login=${login.status} cookie=${cookie.split(";")[0] ?? "-"} health=${afterCookie.status}`);
  }
  // logout гасит cookie
  {
    const out = await req(BASE_A, "POST", "/api/auth/logout", {});
    rec("A: logout → 200", out.status === 200, `${out.status}`);
  }

  // ---------- инстанс B: общий лимит /api включён (5/60с) ----------
  const b = spawnServer(PORT_B, `${ROOT}/.smoke-sec-b`, { DIRIGO_RL_API_MAX: "5", DIRIGO_RL_API_WIN_MS: "60000" });
  servers.push(b);
  let bUp = false;
  const bDeadline = Date.now() + 15000;
  while (Date.now() < bDeadline) {
    // статика (не /api) — не расходует лимит API-запросов
    try { if ((await fetch(`${BASE_B}/`)).ok) { bUp = true; break; } } catch { /* ок */ }
    await sleep(250);
  }
  rec("B: сервер с общим лимитом поднялся", bUp);
  {
    const codes: number[] = [];
    for (let i = 0; i < 8; i++) codes.push((await req(BASE_B, "GET", "/api/health")).status);
    rec("B: общий лимит /api даёт 429",
      codes.slice(0, 5).every((c) => c === 200) && codes.slice(5).some((c) => c === 429),
      `коды=${codes.join(",")}`);
  }
} catch (e) {
  rec("security-smoke without exceptions", false, String(e));
} finally {
  for (const s of servers) s.kill();
  // Чистка без привязки к ОС: powershell есть не везде, а раньше его
  // отсутствие роняло весь сьют до печати результатов.
  for (const d of [`${ROOT}/.smoke-sec-a`, `${ROOT}/.smoke-sec-b`]) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* уже нет */ }
  }
}

// --- отчёт ---
const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? "  — " + r.detail : ""}`);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
