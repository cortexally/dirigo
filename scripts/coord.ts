#!/usr/bin/env bun
// CLI роевой координации. Один интерфейс для ВСЕх харнессов (opencode/kilo/любой).
//
//   bun scripts/coord.ts add "<title>" --spec "..." --verify "<command>"
//   bun scripts/coord.ts tasks [--status backlog] [--json]
//   bun scripts/coord.ts claim <id> [--ttl 30]
//   bun scripts/coord.ts heartbeat <id> [--ttl 30]
//   bun scripts/coord.ts review <id> --commit <hash> --evidence "<вывод>"
//   bun scripts/coord.ts done <id> | feedback <id> "<текст>" | release <id> "<причина>"
//   bun scripts/coord.ts msg <to|all> "<текст>" [--task <id>] [--kind info]
//   bun scripts/coord.ts agents | hb [--kind leader|worker|verifier] [--domains "api,ui"]
//   bun scripts/coord.ts watchdog
//   bun scripts/coord.ts export [--out RUNTIME.md]
//
// Идентичность агента: env AGENT_NAME (рекомендуется задать в промпте/профиле).
import {
  openDb, addTask, claimTask, heartbeatTask, reviewTask, doneTask, feedbackTask, releaseTask,
  listTasks, touchAgent, listAgents, postMessage, listMessages, watchdog, DEFAULT_LEASE_MS,
} from "../src/coordination/store";

const AGENT = process.env.AGENT_NAME ?? `agent-${Math.random().toString(36).slice(2, 7)}`;
const db = openDb();

function arg(flags: string[]): string | undefined {
  for (let i = 3; i < process.argv.length; i++) {
    if (flags.includes(process.argv[i]!)) return process.argv[i + 1];
  }
  return undefined;
}
const flagSet = (f: string) => process.argv.includes(f);
const out = (o: unknown) => console.log(typeof o === "string" ? o : JSON.stringify(o, null, 2));

const [cmd, a1, a2] = [process.argv[2], process.argv[3], process.argv[4]];

switch (cmd) {
  case "add": {
    if (!a1) { out("usage: add <title> --spec ... --verify ..."); break; }
    out({ id: addTask(db, AGENT, { title: a1, spec: arg(["--spec"]) ?? "", verify: arg(["--verify"]) ?? "", owner: arg(["--owner"]) }) });
    break;
  }
  case "tasks": {
    const rows = listTasks(db, arg(["--status"]));
    if (flagSet("--json")) { out(rows); break; }
    for (const t of rows) {
      const lease = t.lease_until ? `lease:${Math.max(0, Math.round((t.lease_until - Date.now()) / 60000))}m` : "";
      out(`${t.id} [${t.status}]${t.owner ? ` @${t.owner}` : ""}${lease ? " " + lease : ""} try:${t.attempts} - ${t.title}${t.commit_hash ? ` (${t.commit_hash})` : ""}`);
    }
    if (!rows.length) out("(пусто)");
    break;
  }
  case "claim": {
    if (!a1) { out("usage: claim <id>"); break; }
    const ttl = Number(arg(["--ttl"]) ?? 0) * 60000 || DEFAULT_LEASE_MS;
    touchAgent(db, AGENT, arg(["--kind"]) ?? "worker", arg(["--domains"]) ?? "");
    out(claimTask(db, AGENT, a1, ttl));
    break;
  }
  case "heartbeat": {
    if (!a1) { touchAgent(db, AGENT, arg(["--kind"]) ?? "worker", arg(["--domains"]) ?? ""); out({ ok: true, agent: AGENT }); break; }
    const ttl = Number(arg(["--ttl"]) ?? 0) * 60000 || DEFAULT_LEASE_MS;
    out(heartbeatTask(db, AGENT, a1, ttl));
    break;
  }
  case "review": {
    out(reviewTask(db, AGENT, a1!, { commit: arg(["--commit"]), evidence: arg(["--evidence"]) }));
    break;
  }
  case "done": { out(doneTask(db, AGENT, a1!)); break; }
  case "feedback": { out(feedbackTask(db, AGENT, a1!, a2 ?? "")); break; }
  case "release": { out(releaseTask(db, AGENT, a1!, a2 ?? "no reason")); break; }
  case "msg": {
    if (!a1 || !a2) { out("usage: msg <to|all> <text> [--task id] [--kind info]"); break; }
    out(postMessage(db, AGENT, a1, a2, arg(["--task"]), arg(["--kind"]) ?? "info"));
    break;
  }
  case "messages": { out(listMessages(db, arg(["--for"]))); break; }
  case "agents": {
    for (const a of listAgents(db)) {
      out(`${a.id} [${a.kind}] ${a.online ? "online" : "OFFLINE"} hb:${Math.round(a.ageMs / 1000)}s ago ${a.domains ? `(${a.domains})` : ""}`);
    }
    break;
  }
  case "hb": {
    touchAgent(db, AGENT, arg(["--kind"]) ?? "worker", arg(["--domains"]) ?? "");
    out({ ok: true, agent: AGENT, ts: Date.now() });
    break;
  }
  case "watchdog": { out(watchdog(db)); break; }
  case "export": {
    const rows = listTasks(db);
    const lines = [
      "# RUNTIME — выгрузка swarm.db (источник правды — БД, этот файл — для людей/агентов без sqlite)",
      "",
      `Агент выгрузки: ${AGENT} · ${new Date().toISOString()}`,
      "",
      "| ID | Статус | Владелец | Попытки | Коммит | Задача |",
      "|---|---|---|---|---|---|",
    ];
    for (const t of rows) {
      lines.push(`| ${t.id} | ${t.status} | ${t.owner ?? "-"} | ${t.attempts} | ${t.commit_hash ?? "-"} | ${t.title.replace(/\|/g, "/")} |`);
    }
    const dest = arg(["--out"]) ?? "RUNTIME.md";
    await Bun.write(dest, lines.join("\n") + "\n");
    out(`exported ${rows.length} tasks → ${dest}`);
    break;
  }
  default:
    out(`usage: coord.ts <add|tasks|claim|heartbeat|review|done|feedback|release|msg|messages|agents|hb|watchdog|export>
AGENT_NAME=${AGENT}`);
}
