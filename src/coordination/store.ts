// Swarm coordination store — sqlite как источник правды для роя агентов.
// Использование: через scripts/coord.ts (CLI) или импорт из dirigo server.
import { Database } from "bun:sqlite";

export const DEFAULT_LEASE_MS = 30 * 60 * 1000; // 30 минут
export const HEARTBEAT_OFFLINE_MS = 5 * 60 * 1000; // агент молчит >5 мин → offline

export function openDb(path = process.env.DIRIGO_COORD_DB ?? "data/swarm.db"): Database {
  const db = new Database(path, { create: true });
  // busy_timeout: роевой протокол — много писателей. Без него параллельный
  // `PRAGMA journal_mode` / claim от другого агента валил всё с SQLITE_BUSY.
  db.exec("PRAGMA busy_timeout = 15000;");
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      spec TEXT NOT NULL DEFAULT '',
      verify_spec TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'backlog',   -- backlog|claimed|in_progress|review|done|blocked
      owner TEXT,
      lease_until INTEGER,
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      commit_hash TEXT,
      evidence TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL DEFAULT 'worker',
      domains TEXT NOT NULL DEFAULT '',
      last_heartbeat INTEGER NOT NULL,
      meta_json TEXT NOT NULL DEFAULT '{}',
      online INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      from_agent TEXT NOT NULL,
      to_agent TEXT NOT NULL DEFAULT 'all',
      task_id TEXT,
      kind TEXT NOT NULL DEFAULT 'info',   -- feedback|handoff|alert|info
      body TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      actor TEXT NOT NULL,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}'
    );
  `);
  return db;
}

const now = () => Date.now();

function logEvent(db: Database, actor: string, type: string, payload: unknown) {
  db.query("INSERT INTO events(ts, actor, type, payload_json) VALUES (?,?,?,?)")
    .run(now(), actor, type, JSON.stringify(payload ?? {}));
}

/* ---------------- tasks ---------------- */

export function addTask(db: Database, actor: string, o: {
  id?: string; title: string; spec?: string; verify?: string; owner?: string; maxAttempts?: number;
}) {
  const id = o.id ?? `T${now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  db.query(`INSERT INTO tasks(id,title,spec,verify_spec,owner,status,created_at,updated_at,max_attempts)
            VALUES (?,?,?,?,?,'backlog',?,?,?)`)
    .run(id, o.title, o.spec ?? "", o.verify ?? "", o.owner ?? null, now(), now(), o.maxAttempts ?? 3);
  logEvent(db, actor, "task.add", { id, title: o.title });
  return id;
}

/** Атомарный claim: побеждает ровно один агент. */
export function claimTask(db: Database, actor: string, id: string, ttlMs = DEFAULT_LEASE_MS) {
  const tx = db.transaction(() => {
    const t = db.query("SELECT * FROM tasks WHERE id = ?").get(id) as any;
    if (!t) return { ok: false as const, error: "not_found" };
    if (t.status !== "backlog") return { ok: false as const, error: `status=${t.status}`, owner: t.owner };
    if (t.owner && t.owner !== actor && t.lease_until && t.lease_until > now())
      return { ok: false as const, error: "leased", owner: t.owner };
    if (t.attempts >= t.max_attempts) {
      db.query("UPDATE tasks SET status='blocked', updated_at=? WHERE id=?").run(now(), id);
      logEvent(db, actor, "task.blocked", { id, reason: "max_attempts" });
      return { ok: false as const, error: "blocked_max_attempts" };
    }
    db.query(`UPDATE tasks SET status='claimed', owner=?, lease_until=?, attempts=attempts+1, updated_at=? WHERE id=?`)
      .run(actor, now() + ttlMs, now(), id);
    logEvent(db, actor, "task.claim", { id, leaseMs: ttlMs });
    return { ok: true as const, leaseUntil: now() + ttlMs };
  });
  return tx();
}

export function heartbeatTask(db: Database, actor: string, id: string, ttlMs = DEFAULT_LEASE_MS) {
  const t = db.query("SELECT * FROM tasks WHERE id = ?").get(id) as any;
  if (!t) return { ok: false as const, error: "not_found" };
  if (t.owner !== actor) return { ok: false as const, error: "not_owner", owner: t.owner };
  if (t.status === "claimed" || t.status === "in_progress") {
    db.query("UPDATE tasks SET lease_until=?, status='in_progress', updated_at=? WHERE id=?")
      .run(now() + ttlMs, now(), id);
    return { ok: true as const, leaseUntil: now() + ttlMs };
  }
  return { ok: false as const, error: `status=${t.status}` };
}

export function reviewTask(db: Database, actor: string, id: string, o: { commit?: string; evidence?: string }) {
  const t = db.query("SELECT * FROM tasks WHERE id = ?").get(id) as any;
  if (!t) return { ok: false, error: "not_found" };
  if (t.owner !== actor) return { ok: false, error: "not_owner", owner: t.owner };
  db.query(`UPDATE tasks SET status='review', commit_hash=?, evidence=?, lease_until=NULL, updated_at=? WHERE id=?`)
    .run(o.commit ?? t.commit_hash, o.evidence ?? t.evidence, now(), id);
  logEvent(db, actor, "task.review", { id, commit: o.commit });
  return { ok: true };
}

export function doneTask(db: Database, actor: string, id: string) {
  const t = db.query("SELECT * FROM tasks WHERE id = ?").get(id) as any;
  if (!t) return { ok: false, error: "not_found" };
  db.query("UPDATE tasks SET status='done', lease_until=NULL, updated_at=? WHERE id=?").run(now(), id);
  logEvent(db, actor, "task.done", { id, verifiedBy: actor });
  return { ok: true };
}

export function feedbackTask(db: Database, actor: string, id: string, text: string) {
  const t = db.query("SELECT * FROM tasks WHERE id = ?").get(id) as any;
  if (!t) return { ok: false, error: "not_found" };
  db.query(`UPDATE tasks SET status='backlog', owner=NULL, lease_until=NULL, evidence=?, updated_at=? WHERE id=?`)
    .run(text, now(), id);
  db.query("INSERT INTO messages(ts,from_agent,to_agent,task_id,kind,body) VALUES (?,?,?,?,?,?)")
    .run(now(), actor, t.owner ?? "all", id, "feedback", text);
  logEvent(db, actor, "task.feedback", { id });
  return { ok: true };
}

export function releaseTask(db: Database, actor: string, id: string, reason: string) {
  const t = db.query("SELECT * FROM tasks WHERE id = ?").get(id) as any;
  if (!t) return { ok: false, error: "not_found" };
  db.query(`UPDATE tasks SET status='backlog', owner=NULL, lease_until=NULL, updated_at=? WHERE id=?`).run(now(), id);
  db.query("INSERT INTO messages(ts,from_agent,to_agent,task_id,kind,body) VALUES (?,?, 'all', ?,?,?)")
    .run(now(), actor, id, "alert", `released: ${reason}`);
  logEvent(db, actor, "task.release", { id, reason });
  return { ok: true };
}

export function listTasks(db: Database, status?: string) {
  const rows = status
    ? db.query("SELECT * FROM tasks WHERE status = ? ORDER BY updated_at DESC").all(status)
    : db.query("SELECT * FROM tasks ORDER BY updated_at DESC").all();
  return rows as any[];
}

/* ---------------- agents ---------------- */

export function touchAgent(db: Database, actor: string, kind = "worker", domains = "") {
  const existing = db.query("SELECT * FROM agents WHERE id = ?").get(actor) as any;
  if (existing) {
    db.query("UPDATE agents SET last_heartbeat=?, online=1, kind=?, domains=? WHERE id=?")
      .run(now(), kind, domains, actor);
  } else {
    db.query("INSERT INTO agents(id,kind,domains,last_heartbeat) VALUES (?,?,?,?)")
      .run(actor, kind, domains, now());
  }
  return { ok: true };
}

export function listAgents(db: Database) {
  return (db.query("SELECT * FROM agents ORDER BY id").all() as any[]).map((a) => ({
    ...a,
    ageMs: now() - a.last_heartbeat,
    online: a.online === 1 && now() - a.last_heartbeat <= HEARTBEAT_OFFLINE_MS,
  }));
}

/* ---------------- messages / events ---------------- */

export function postMessage(db: Database, from: string, to: string, body: string, taskId?: string, kind = "info") {
  db.query("INSERT INTO messages(ts,from_agent,to_agent,task_id,kind,body) VALUES (?,?,?,?,?,?)")
    .run(now(), from, to, taskId ?? null, kind, body);
  return { ok: true };
}

export function listMessages(db: Database, to?: string, limit = 50) {
  const rows = to
    ? db.query("SELECT * FROM messages WHERE to_agent IN (?,'all') ORDER BY id DESC LIMIT ?").all(to, limit)
    : db.query("SELECT * FROM messages ORDER BY id DESC LIMIT ?").all(limit);
  return (rows as any[]).reverse();
}

/* ---------------- watchdog ---------------- */

export function watchdog(db: Database, actor = "watchdog") {
  const ts = now();
  const expired = db.query(
    `SELECT id, owner FROM tasks WHERE status IN ('claimed','in_progress') AND lease_until IS NOT NULL AND lease_until < ?`
  ).all(ts) as any[];
  for (const t of expired) {
    db.query(`UPDATE tasks SET status='backlog', owner=NULL, lease_until=NULL, updated_at=? WHERE id=?`).run(ts, t.id);
    db.query("INSERT INTO messages(ts,from_agent,to_agent,task_id,kind,body) VALUES (?,?, 'all', ?,?,?)")
      .run(ts, actor, t.id, "alert", `lease expired — returned to pool (was: ${t.owner})`);
    logEvent(db, actor, "watchdog.lease_expired", { id: t.id, owner: t.owner });
  }
  const dead = db.query(
    `SELECT id FROM agents WHERE online=1 AND last_heartbeat < ?`
  ).all(ts - HEARTBEAT_OFFLINE_MS) as any[];
  for (const a of dead) {
    db.query("UPDATE agents SET online=0 WHERE id=?").run(a.id);
    logEvent(db, actor, "watchdog.agent_offline", { id: a.id });
  }
  return { released: expired.length, offline: dead.length };
}
