#!/usr/bin/env bun
// Dirigo — CLI (V2-4.1).
//
//   v2 ls [--host H] [--json]                      список сессий
//   v2 health [--host H]                           состояние демона
//   v2 run <agent> "<prompt>" [--project id] [--mode cli|web|persistent|pty]
//         [--copy|--wt git|--wt copy] [--model m] [--wait] [--json]
//   v2 attach <session> [--host H] [-n 200]        живой лог (poll)
//   v2 send <session> "<text>" [--host H]          сообщение агенту
//   v2 diff <session> [--full] [--json]            построчный дифф копии
//   v2 apply <session> [--force] [--json]          применить в проект
//   v2 revert <session> [--json]                   вернуть копию как было
//   v2 checks <session> [--json]                   прогнать авто-проверки
//   v2 plans [--json] · plan <id> · start <id> · apply <id> [--json]
//
// host: --host / DIRIGO_HOST / http://127.0.0.1:7271. Токен: DIRIGO_TOKEN.
// Коды возврата: 0 ok · 1 ошибка · 2usage · 3 не найдено · 4 отказ демона.

const EXIT = { ok: 0, err: 1, usage: 2, notFound: 3, remote: 4 } as const;

/* ---------------- разбор аргументов ---------------- */
const argv = process.argv.slice(2);
const flags = new Set<string>();
const opts = new Map<string, string>();
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  if (a.startsWith("--")) {
    const eq = a.indexOf("=");
    if (eq > 0) opts.set(a.slice(2, eq), a.slice(eq + 1));
    else if (i + 1 < argv.length && !argv[i + 1]!.startsWith("--")) opts.set(a.slice(2), argv[++i]!);
    else flags.add(a.slice(2));
  }
}
// позиционные — всё, что не флаг и не значение флага
const pos: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  if (a.startsWith("--")) {
    const eq = a.indexOf("=");
    if (eq < 0 && i + 1 < argv.length && !argv[i + 1]!.startsWith("--")) i++; // значение флага
    continue;
  }
  pos.push(a);
}

const HOST = (opts.get("host") ?? process.env.DIRIGO_HOST ?? "http://127.0.0.1:7271").replace(/\/+$/, "");
const TOKEN = process.env.DIRIGO_TOKEN ?? "";
const JSON_OUT = flags.has("json");

/**
 * Машинный вывод — компактный JSON в одну строку (как `jq -c`).
 * Так его читают и jq/JSON.parse, и построчный парсинг в shell
 * (grep/cut по `"поле":значение` — с пробелом после двоеточия значение
 * «отъезжает» на лишний пробел и ломает разбор). Ошибки печатаются
 * в том же компактном виде (см. die), поэтому формат у --json один.
 */
function out(data: unknown, human: string): void {
  console.log(JSON_OUT ? JSON.stringify(data) : human);
}

/**
 * Пояснения для человека (лог, конфликты, справка). Без --json — в stdout,
 * как раньше; с --json — в stderr: stdout обязан остаться РОВНО одним
 * JSON-документом, иначе JSON.parse(stdout) / jq ломаются.
 */
function note(text: string): void {
  if (JSON_OUT) console.error(text); else console.log(text);
}

async function api(path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const r = await fetch(HOST + path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
      ...(init.headers ?? {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await r.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: r.status, body };
}

const die = (msg: string, code: number): never => {
  console.error(JSON_OUT ? JSON.stringify({ error: msg }) : `ошибка: ${msg}`);
  process.exit(code);
};

/** Ошибка по HTTP-статусу: 404 → «не найдено», остальное → отказ демона. */
const dieStatus = (status: number, msg: string): never => die(msg, status === 404 ? EXIT.notFound : EXIT.remote);

/* ---------------- команды ---------------- */
const [cmd, ...rest] = pos;

switch (cmd) {
  case "queue": {
    // Пример: orch queue --type run agentId=hermes prompt="тест" projectId=prj_x worktree=true
    const type = opts.get("type");
    if (!type) die("usage: orch queue --type run|send|apply|diff|checks|revert|approve|rework [key=value ...]", EXIT.usage);
    // payload — из позиционных key=value (после имени команды)
    const payload: Record<string, unknown> = {};
    for (const token of rest) {
      const eq = token.indexOf("=");
      if (eq <= 0) continue;
      const k = token.slice(0, eq), v = token.slice(eq + 1);
      payload[k] = v === "true" ? true : v === "false" ? false : v;
    }
    for (const [k, v] of opts) { if (!["type", "host", "json"].includes(k) && !(k in payload)) payload[k] = v; }
    const r = await api("/api/queue", { method: "POST", body: { type, payload } });
    if (r.status !== 202) die(`queue ${r.status}: ${JSON.stringify(r.body)}`, EXIT.remote);
    out(r.body, `в очереди: ${r.body.id} (опрос: orch queue-status ${r.body.id})`);
    break;
  }

  case "queue-status": {
    const id = rest[0];
    if (!id) die("usage: orch queue-status <id>", EXIT.usage);
    const r = await api(`/api/queue/${id}`);
    if (r.status !== 200) dieStatus(r.status, `queue-status ${r.status}`);
    out(r.body, `${r.body.type}: ${r.body.status}${r.body.error ? " — " + r.body.error : ""}`);
    if (r.body.status === "failed") process.exit(EXIT.err);
    if (r.body.status !== "done") process.exit(3); // ещё в работе
    break;
  }

  case "setup": {
    // Статусы агентов provisioning (V3-5)
    const r = await api("/api/setup/agents");
    if (JSON_OUT) { out(r.body, ""); break; }
    for (const a of r.body ?? []) {
      const mark = a.state === "installed" ? "готов" : a.state === "missing" ? "НЕТ" : a.state === "needs-auth" ? "вход?" : a.state;
      console.log(`${a.id.padEnd(13)} ${mark.padEnd(7)} ${a.label}${a.version ? " — " + a.version : ""}${a.envVar && !a.keySet ? ` · ключ ${a.envVar}` : ""}`);
    }
    break;
  }

  case "setup-install": {
    const id = rest[0];
    if (!id) die("usage: orch setup-install <agentId>", EXIT.usage);
    const r = await api("/api/setup/install", { method: "POST", body: { agentId: id } });
    if (r.status !== 202) die(`install ${r.status}: ${JSON.stringify(r.body)}`, EXIT.remote);
    out({ id: r.body.id, status: r.body.status }, `установка ${id} → ${r.body.id} (опрос: orch setup-jobs)`);
    break;
  }

  case "setup-jobs": {
    const r = await api("/api/setup/jobs");
    if (JSON_OUT) { out(r.body, ""); break; }
    for (const j of r.body ?? []) {
      const done = j.steps.filter((s: any) => s.status === "done").length;
      console.log(`${j.id}  ${j.status.padEnd(8)} ${j.label} (${done}/${j.steps.length})`);
    }
    break;
  }

  case "machines": {
    const r = await api("/api/machines");
    if (JSON_OUT) { out(r.body, ""); break; }
    for (const m of r.body ?? []) {
      console.log(`${m.id}  ${(m.lastStatus ?? "?").padEnd(8)} ${m.name} — ${m.user}@${m.host}:${m.daemonPort} (локально :${m.localPort})`);
    }
    break;
  }

  case "machine-add": {
    // ВНИМАНИЕ: --host занят адресом демона; машина задаётся через --at.
    const host = opts.get("at") ?? opts.get("mhost");
    const user = opts.get("user") ?? opts.get("muser") ?? "root";
    if (!host) die("usage: orch machine-add --at H [--user U] [--name N] [--key K] [--port P] [--daemon 7271]", EXIT.usage);
    const r = await api("/api/machines", {
      method: "POST",
      body: {
        name: opts.get("name") ?? `${user}@${host}`,
        host, user,
        port: opts.get("port") ? Number(opts.get("port")) : undefined,
        daemonPort: opts.get("daemon") ? Number(opts.get("daemon")) : 7271,
        identity: opts.get("key") ?? undefined,
      },
    });
    if (r.status !== 201) die(`machine-add ${r.status}: ${JSON.stringify(r.body)}`, EXIT.remote);
    out(r.body, `машина ${r.body.id}: ${r.body.name} (локальный порт туннеля :${r.body.localPort})`);
    break;
  }

  case "machine-probe": {
    const id = rest[0];
    if (!id) die("usage: orch machine-probe <id>", EXIT.usage);
    const r = await api(`/api/machines/${id}/probe`, { method: "POST" });
    // 404 — машины нет: это «не найдено» (3), а не «ошибка» (1).
    // 409 — машина есть, но демон на ней не отвечает: это ошибка (1).
    if (r.status === 404) dieStatus(r.status, `machine-probe ${r.status}: ${r.body?.error ?? "машина не найдена"}`);
    out(r.body, r.body?.ok ? "демон онлайн" : (r.body?.error ?? "не отвечает"));
    if (!r.body?.ok) process.exit(EXIT.err);
    break;
  }

  case "machine-tunnel": {
    const id = rest[0];
    if (!id) die("usage: v2 machine-tunnel <id>", EXIT.usage);
    const r = await api(`/api/machines/${id}/tunnel`, { method: "POST" });
    if (r.status !== 200) dieStatus(r.status, `tunnel ${r.status}: ${JSON.stringify(r.body)}`);
    out(r.body, `туннель открыт: http://127.0.0.1:${r.body.localPort} (pid ${r.body.pid})`);
    break;
  }

  case "machine-deploy": {
    // Деплой демона на машину (V3-1). --dry-run покажет команды.
    const id = rest[0];
    if (!id) die("usage: orch machine-deploy <id> [--engines claude,codex] [--dry-run]", EXIT.usage);
    const engines = opts.get("engines")?.split(",").map((s) => s.trim()).filter(Boolean);
    const r = await api(`/api/machines/${id}/deploy`, {
      method: "POST",
      body: { engines: engines ?? [], dryRun: flags.has("dry-run") },
    });
    if (r.status !== 200) {
      // --json: stdout — тело ответа, stderr — компактная ошибка (как в die).
      if (JSON_OUT) { out(r.body, ""); die(`deploy ${r.status}: ${r.body?.error ?? ""}`, EXIT.remote); }
      console.error(`deploy ${r.status}: ${r.body?.error ?? ""}`);
      if (r.body?.log?.length) console.error(r.body.log.join(""));
      process.exit(EXIT.remote);
    }
    if (JSON_OUT) { out(r.body, ""); break; }
    for (const l of r.body?.log ?? []) process.stdout.write(l);
    console.log(`\nготово: порт ${r.body?.port ?? "?"}${r.body?.token ? " (токен получен)" : ""}`);
    break;
  }

  case "machine-del": {
    const id = rest[0];
    if (!id) die("usage: v2 machine-del <id>", EXIT.usage);
    await api(`/api/machines/${id}/delete`, { method: "POST" });
    out({ ok: true }, "машина удалена");
    break;
  }

  case "tunnel": {
    const action = rest[0] ?? "status";
    if (action === "start") {
      const r = await api("/api/tunnel", { method: "POST", body: { action: "start" } });
      if (r.status !== 200) dieStatus(r.status, `tunnel start: ${r.body?.error ?? JSON.stringify(r.body)}`);
      out(r.body, r.body?.url ? `туннель: ${r.body.url}` : "запускается…");
    } else if (action === "stop") {
      const r = await api("/api/tunnel", { method: "POST", body: { action: "stop" } });
      out(r.body, "туннель остановлен");
    } else {
      const r = await api("/api/tunnel");
      out(r.body, r.body?.running ? `работает: ${r.body.url ?? "…"}` : `остановлен (cloudflared: ${r.body?.cloudflared ? "есть" : "нет"})`);
    }
    break;
  }

  case "health": {
    const r = await api("/api/health");
    if (r.status !== 200) die(`health ${r.status}`, EXIT.remote);
    out(r.body, `${r.body.running} активных · агентов: ${r.body.agents.length} · ${HOST}`);
    break;
  }

  case "ls": {
    const r = await api("/api/sessions");
    if (r.status !== 200) die(`ls ${r.status}`, EXIT.remote);
    const rows = r.body ?? [];
    if (JSON_OUT) { out(rows, ""); break; }
    if (!rows.length) { console.log("(сессий нет)"); break; }
    for (const s of rows) {
      const copy = s.worktree ? ` [копия ${s.worktree.kind}]` : "";
      console.log(`${s.id}  ${s.status.padEnd(8)} ${s.agentId.padEnd(9)} ${s.title}${copy}`);
    }
    break;
  }

  case "run": {
    const [agentId, prompt] = rest;
    if (!agentId || !prompt) die("usage: v2 run <agent> <prompt> [--project id] [--mode m] [--copy|--wt git|--wt copy] [--model m] [--wait]", EXIT.usage);
    const mode = opts.get("mode") ?? (flags.has("copy") || opts.has("wt") ? "cli" : "cli");
    const body: Record<string, unknown> = {
      agentId, prompt, mode,
      projectId: opts.get("project") ?? undefined,
      model: opts.get("model") ?? undefined,
      worktree: opts.get("wt") ?? (flags.has("copy") ? true : undefined),
    };
    if (!body.projectId) {
      const pr = await api("/api/projects");
      const first = (pr.body ?? [])[0];
      if (!first) die("нет проектов — создай через UI или v2 (проект обязателен)", EXIT.notFound);
      body.projectId = first.id;
    }
    const r = await api("/api/sessions", { method: "POST", body });
    if (r.status !== 201) die(`run ${r.status}: ${JSON.stringify(r.body)}`, EXIT.remote);
    const started = `сессия ${r.body.id} — ${r.body.status} (${r.body.mode})${r.body.worktree ? " · копия " + r.body.worktree.kind : ""}`;
    if (!flags.has("wait")) { out(r.body, started); break; }
    // --wait: stdout — один документ (итоговое состояние сессии), иначе
    // парсер увидит два JSON-объекта подряд и сломается.
    note(started);
    const deadline = Date.now() + 15 * 60_000;
    while (Date.now() < deadline) {
      await new Promise((res) => setTimeout(res, 2000));
      const s = await api(`/api/sessions/${r.body.id}`);
      if (s.status !== 200) continue;
      if (!["queued", "running"].includes(s.body?.status)) {
        out(s.body, `итог: ${s.body?.status}`);
        const lg = await api(`/api/sessions/${r.body.id}/log?n=1`);
        void lg;
        process.exit(s.body?.status === "done" ? EXIT.ok : EXIT.err);
      }
    }
    die("ожидание превысило 15 минут", EXIT.err);
  }

  case "attach": {
    const id = rest[0];
    if (!id) die("usage: v2 attach <session> [-n 200]", EXIT.usage);
    let seen = -1;
    const poll = async () => {
      const r = await api(`/api/sessions/${id}/log?n=${opts.get("n") ?? "500"}`);
      if (r.status !== 200) dieStatus(r.status, `attach ${r.status}`);
      const lines: string[] = r.body?.lines ?? [];
      const fresh = seen < 0 ? lines.slice(-Number(opts.get("n") ?? 200)) : lines.slice(seen);
      seen = lines.length;
      if (fresh.length) note(fresh.join("\n"));
    };
    await poll();
    const timer = setInterval(poll, 1500);
    const stop = async () => {
      clearInterval(timer);
      const s = await api(`/api/sessions/${id}`).catch(() => null);
      const st = s?.body?.status ?? "?";
      if (JSON_OUT) console.log(JSON.stringify({ status: st }));
      process.exit(["done", "stopped", "error"].includes(st) ? (st === "done" ? EXIT.ok : EXIT.err) : 0);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    // тихий режим: poll до конца сессии (Ctrl+C — выйти)
    while (true) {
      await new Promise((res) => setTimeout(res, 3000));
      const s = await api(`/api/sessions/${id}`).catch(() => null);
      if (s?.body && !["queued", "running"].includes(s.body.status)) { await stop(); break; }
    }
    break;
  }

  case "send": {
    const [id, text] = rest;
    if (!id || !text) die("usage: v2 send <session> <text>", EXIT.usage);
    const r = await api(`/api/sessions/${id}/messages`, { method: "POST", body: { text } });
    if (r.status !== 202 && r.status !== 200) dieStatus(r.status, `send ${r.status}: ${JSON.stringify(r.body)}`);
    out({ ok: true, session: id }, "отправлено");
    break;
  }

  case "diff": {
    const id = rest[0];
    if (!id) die("usage: v2 diff <session> [--full] [--json]", EXIT.usage);
    const r = await api(`/api/sessions/${id}/diff`);
    if (r.status !== 200) dieStatus(r.status, `diff ${r.status}: ${JSON.stringify(r.body)}`);
    if (JSON_OUT || flags.has("full") && JSON_OUT) { out(r.body, ""); break; }
    const files = r.body?.files ?? [];
    if (!files.length) { console.log("изменений нет"); break; }
    console.log(`+#${r.body.added} -#${r.body.deleted} в ${files.length} файл(ах)\n`);
    for (const f of files) {
      console.log(`${f.status === "added" ? "+" : f.status === "deleted" ? "-" : "~"} ${f.path} (+${f.added} -${f.deleted})`);
      if (flags.has("full")) {
        for (const l of f.lines) {
          const mark = l.kind === "add" ? "+" : l.kind === "del" ? "-" : " ";
          console.log(`${mark}${l.oldNo ?? ""}\t${l.newNo ?? ""}\t${l.text}`);
        }
      }
    }
    break;
  }

  case "apply": {
    const id = rest[0];
    if (!id) die("usage: v2 apply <session> [--force] [--json]", EXIT.usage);
    const r = await api(`/api/sessions/${id}/apply`, { method: "POST", body: { confirmed: true, force: flags.has("force") } });
    // 404 — сессии нет («не найдено», 3); 409 — демон отказал (4).
    if (r.status !== 200) dieStatus(r.status, `apply ${r.status}: ${r.body?.detail ?? JSON.stringify(r.body)}`);
    out(r.body, r.body?.detail ?? "применено");
    break;
  }

  case "revert": {
    const id = rest[0];
    if (!id) die("usage: v2 revert <session> [--json]", EXIT.usage);
    const r = await api(`/api/sessions/${id}/revert`, { method: "POST" });
    if (r.status !== 200) dieStatus(r.status, `revert ${r.status}`);
    out(r.body, r.body?.detail ?? "возвращено");
    break;
  }

  case "checks": {
    const id = rest[0];
    if (!id) die("usage: v2 checks <session> [--json]", EXIT.usage);
    const r = await api(`/api/sessions/${id}/checks`, { method: "POST" });
    if (r.status !== 200) dieStatus(r.status, `checks ${r.status}: ${r.body?.error ?? ""}`);
    if (JSON_OUT) { out(r.body, ""); break; }
    if (r.body?.source === null) { console.log("в проекте не найдено команд проверок"); break; }
    if (r.body?.ok) { console.log(`проверки пройдены (${r.body.source})`); break; }
    console.log(`проверки упали (${r.body?.source ?? "?"})`);
    for (const o of r.body?.outcomes ?? []) if (!o.ok) console.log(`$ ${o.command}\n${o.output.slice(-1500)}`);
    process.exit(EXIT.err);
    break;
  }

  case "plans": {    const r = await api("/api/plans");
    if (r.status !== 200) dieStatus(r.status, `plans ${r.status}`);
    const rows = r.body ?? [];
    if (JSON_OUT) { out(rows, ""); break; }
    if (!rows.length) { console.log("(планов нет)"); break; }
    for (const p of rows) {
      console.log(`${p.id}  ${String(p.status).padEnd(8)} ${p.done + p.applied}/${p.epics} эпиков · ${p.goal}`);
    }
    break;
  }

  case "plan": {
    const id = rest[0];
    if (!id) die("usage: v2 plan <id> [--json]", EXIT.usage);
    const r = await api(`/api/plans/${id}`);
    if (r.status !== 200) dieStatus(r.status, `plan ${r.status}`);
    if (JSON_OUT) { out(r.body, ""); break; }
    console.log(`${r.body.goal} [${r.body.status}] агент: ${r.body.agentId}`);
    for (const e of r.body.epics ?? []) {
      console.log(`  ${e.id}  ${String(e.status).padEnd(10)} ${e.title}${e.verdict ? ` — ${e.verdict.split("\n")[0]}` : ""}`);
      for (const c of e.criteria ?? []) console.log(`      • ${c}`);
    }
    break;
  }

  case "start": {
    const id = rest[0];
    if (!id) die("usage: v2 start <plan-id> [--json]", EXIT.usage);
    const r = await api(`/api/plans/${id}/start`, { method: "POST" });
    if (r.status !== 200) dieStatus(r.status, `start ${r.status}: ${JSON.stringify(r.body)}`);
    out(r.body, `запущено эпиков: ${r.body?.started}`);
    break;
  }

  case "apply-plan": {
    const id = rest[0];
    if (!id) die("usage: v2 apply-plan <plan-id> [--json]", EXIT.usage);
    const r = await api(`/api/plans/${id}/apply-all`, { method: "POST" });
    if (r.status !== 200) dieStatus(r.status, `apply-plan ${r.status}: ${JSON.stringify(r.body)}`);
    out(r.body, `применено: ${r.body?.applied}${r.body?.conflicts?.length ? `, конфликты: ${r.body.conflicts.length}` : ""}`);
    if (r.body?.conflicts?.length) for (const c of r.body.conflicts) note(`  ! ${c}`);
    if (!r.body?.ok) process.exit(EXIT.err);
    break;
  }

  default: {
    const usage = `orch — CLI пульта dirigo (host: ${HOST})

Команды:
  health                              состояние демона
  ls [--json]                         сессии
  run <agent> <prompt> [--project id] [--mode cli|web|persistent|pty]
       [--copy|--wt git|--wt copy] [--model m] [--wait] [--json]
  attach <session> [-n 200]           живой лог (Ctrl+C — выход)
  send <session> <text>               сообщение агенту
  diff <session> [--full] [--json]    дифф копии
  apply <session> [--force] [--json]  применить в проект
  revert <session> [--json]           вернуть копию как было
  checks <session> [--json]           авто-проверки копии
  plans [--json] · plan <id> · start <id> · apply-plan <id>
  queue --type … key=value            поставить команду в Companion-очередь
  queue-status <id>                   статус команды очереди
  setup [--json]                      статусы агентов provisioning
  setup-install <agentId>             установить агента (npm/нативный установщик)
  setup-jobs                          задачи установки
  machines [--json]                   список машин (SSH)
  machine-add --at H [--user U] [--name N] [--key K] [--port P]
  machine-probe <id>                  проверить демон машины по ssh
  machine-tunnel <id>                 открыть ssh-туннель к демону машины
  machine-deploy <id> [--engines claude,codex] [--dry-run]
                                     развернуть демон на машину (V3-1)
  machine-del <id>                    удалить машину
  tunnel [start|stop]                 cloudflare quick tunnel (V3-3)

Переменные: DIRIGO_HOST (адрес демона), DIRIGO_TOKEN (Bearer).
Коды: 0 ok · 1 ошибка · 2 usage · 3 не найдено · 4 отказ демона.`;
    if (JSON_OUT) {
      // Справка — в stderr, stdout — компактный JSON (контракт --json).
      note(usage);
      out({ error: cmd ? `неизвестная команда: ${cmd}` : "usage" }, "");
    } else {
      console.log(usage);
    }
    process.exit(cmd ? EXIT.usage : EXIT.ok);
  }
}
