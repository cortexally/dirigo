// dirigo-site — отдача статики (ноль зависимостей).
// Локально:  bun run serve.ts            →  http://127.0.0.1:7380
// На проде:  PORT=7380 HOST=127.0.0.1 bun run serve.ts  за cloudflare-туннелем
// (см. DEPLOY.md). Отдаёт страницу, ассеты, install.sh / install.ps1 и releases/*
// с одного origin.
import { resolve, sep } from "node:path";

const ROOT = resolve(new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const PORT = Number(process.env.PORT ?? 7380);
const HOST = process.env.HOST ?? "127.0.0.1";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".sh": "text/x-shellscript; charset=utf-8",
  ".ps1": "text/plain; charset=utf-8",
  ".sha256": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
  ".gz": "application/gzip",
};

// Кэш: страница — всегда свежая, установочные скрипты — тоже; ассеты и архивы — надолго.
const cacheFor = (p: string) => {
  if (p === "/index.html" || p.endsWith(".html")) return "no-cache";
  if (p === "/install.sh" || p === "/install.ps1") return "no-cache";
  // манифест и суммы меняются при каждой выкладке — только свежие (иначе CDN держит старые)
  if (p === "/releases/latest.json" || p === "/releases/SHA256SUMS") return "no-cache";
  if (p.startsWith("/releases/")) return "public, max-age=2592000";
  if (p.startsWith("/assets/")) return "public, max-age=604800";
  return "public, max-age=3600";
};

// ── Метрики: /api/event (приём), /api/stats и /stats (сводка по ключу) ───────────
// Событие — строка JSON в data/events.jsonl: {ts, landing, type, visitor, email, meta}
// (формат landings/server.js — данные можно объединять). Ключ сводки — STATS_KEY из
// окружения или файл data/stats.key; без ключа сводка закрыта (404), приём работает.
// Каталог data/ наружу не отдаётся.
const DATA = resolve(ROOT, process.env.SITE_DATA ?? "data");
const EVENTS = resolve(DATA, "events.jsonl");
const TYPES = new Set(["view", "scroll50", "buy_intent", "cta", "signup"]);
const FUNNEL = ["view", "scroll50", "buy_intent", "signup"];
const statsKey = (): string => {
  if (process.env.STATS_KEY) return process.env.STATS_KEY.trim();
  try { return require("node:fs").readFileSync(resolve(DATA, "stats.key"), "utf8").trim(); } catch { return ""; }
};
const hits = new Map<string, { n: number; at: number }>();
const limited = (ip: string): boolean => {
  const now = Date.now(), h = hits.get(ip);
  if (!h || now - h.at > 60_000) { hits.set(ip, { n: 1, at: now }); if (hits.size > 5000) hits.clear(); return false; }
  return ++h.n > 120; // 120 событий в минуту с адреса
};
const clip = (v: unknown, n: number) => String(v ?? "").slice(0, n);
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

async function acceptEvent(req: Request): Promise<Response> {
  const ip = req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  if (limited(ip)) return json({ ok: false, error: "rate" }, 429);
  const raw = await req.text();
  if (raw.length > 8192) return json({ ok: false, error: "too large" }, 413);
  let b: any;
  try { b = JSON.parse(raw); } catch { return json({ ok: false, error: "bad json" }, 400); }
  if (!b || !TYPES.has(b.type)) return json({ ok: false, error: "bad type" }, 400);
  const email = b.type === "signup" && /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(String(b.email ?? "")) ? clip(b.email, 254) : "";
  let meta: unknown = b.meta && typeof b.meta === "object" ? b.meta : {};
  if (JSON.stringify(meta).length > 2048) meta = { truncated: true };
  const ev = { ts: new Date().toISOString(), landing: clip(b.landing || "dirigo", 40), type: b.type, visitor: clip(b.visitor, 64), email, meta };
  const fs = await import("node:fs");
  fs.mkdirSync(DATA, { recursive: true });
  fs.appendFileSync(EVENTS, JSON.stringify(ev) + "\n");
  return json({ ok: true });
}

function readEvents(days: number): any[] {
  const fs = require("node:fs");
  let text = "";
  try { text = fs.readFileSync(EVENTS, "utf8"); } catch { return []; }
  const since = days > 0 ? Date.now() - days * 86_400_000 : 0;
  const out: any[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try { const e = JSON.parse(line); if (!since || Date.parse(e.ts) >= since) out.push(e); } catch { /* битая строка */ }
  }
  return out;
}

export function aggregate(events: any[]) {
  const byType: Record<string, { events: number; visitors: number }> = {};
  const vis: Record<string, Set<string>> = {};
  const labels: Record<string, number> = {}, refs: Record<string, number> = {}, utm: Record<string, number> = {};
  const days: Record<string, Record<string, number>> = {};
  const signups: { ts: string; email: string; company: string }[] = [];
  for (const e of events) {
    (byType[e.type] ??= { events: 0, visitors: 0 }).events++;
    (vis[e.type] ??= new Set()).add(e.visitor);
    const d = String(e.ts).slice(0, 10);
    ((days[d] ??= {})[e.type] = (days[d][e.type] ?? 0) + 1);
    if (e.type === "buy_intent" || e.type === "cta") { const l = e.meta?.label || "—"; labels[l] = (labels[l] ?? 0) + 1; }
    if (e.type === "view") {
      let r = "direct";
      try { if (e.meta?.ref) r = new URL(e.meta.ref).hostname || "direct"; } catch { /* не URL */ }
      refs[r] = (refs[r] ?? 0) + 1;
      const src = e.meta?.utm?.utm_source; if (src) utm[src] = (utm[src] ?? 0) + 1;
    }
    if (e.type === "signup") signups.push({ ts: e.ts, email: e.email, company: e.meta?.company ?? "" });
  }
  for (const t of Object.keys(byType)) byType[t].visitors = vis[t]?.size ?? 0;
  const base = byType.view?.visitors ?? 0;
  const funnel = FUNNEL.map((t) => ({ step: t, visitors: byType[t]?.visitors ?? 0, pct: base ? Math.round(((byType[t]?.visitors ?? 0) / base) * 1000) / 10 : 0 }));
  return { total: events.length, byType, funnel, labels, referrers: refs, utm, days, signups: signups.slice(-50).reverse() };
}

const esc = (s: unknown) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const rows = (o: Record<string, number>) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v}</td></tr>`).join("") || `<tr><td colspan="2">—</td></tr>`;
function statsHtml(a: ReturnType<typeof aggregate>, days: number, key: string): string {
  const k = encodeURIComponent(key);
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Dirigo · метрики</title><style>body{font:14px/1.45 system-ui,sans-serif;margin:24px;max-width:960px;color:#1a1a1a;background:#fff}h1{font-size:20px}h2{font-size:15px;margin-top:28px}
table{border-collapse:collapse;width:100%;margin-top:6px}td,th{border-bottom:1px solid #e5e5e5;padding:6px 8px;text-align:left}th{color:#666;font-weight:500}nav a{margin-right:12px}
@media (prefers-color-scheme:dark){body{background:#111;color:#eee}td,th{border-color:#333}th{color:#aaa}a{color:#8ab4ff}}</style></head><body>
<h1>Dirigo · метрики (${days > 0 ? days + " дн." : "всё время"})</h1>
<nav>${[1, 7, 30, 0].map((d) => `<a href="/stats?key=${k}&days=${d}">${d ? d + " дн." : "всё"}</a>`).join("")}<a href="/api/stats?key=${k}&days=${days}">JSON</a></nav>
<h2>Воронка (уникальные посетители)</h2><table><tr><th>шаг</th><th>посетители</th><th>% от view</th></tr>
${a.funnel.map((f) => `<tr><td>${f.step}</td><td>${f.visitors}</td><td>${f.pct}%</td></tr>`).join("")}</table>
<h2>Клики CTA</h2><table><tr><th>label</th><th>клики</th></tr>${rows(a.labels)}</table>
<h2>Источники</h2><table><tr><th>referrer</th><th>просмотры</th></tr>${rows(a.referrers)}</table>
<h2>utm_source</h2><table><tr><th>источник</th><th>просмотры</th></tr>${rows(a.utm)}</table>
<h2>Заявки (последние 50)</h2><table><tr><th>время</th><th>e-mail</th><th>компания</th></tr>
${a.signups.map((s) => `<tr><td>${esc(s.ts.replace("T", " ").slice(0, 16))}</td><td>${esc(s.email)}</td><td>${esc(s.company)}</td></tr>`).join("") || `<tr><td colspan="3">—</td></tr>`}</table>
<p style="color:#888">событий: ${a.total}</p></body></html>`;
}

function statsRoute(url: URL, html: boolean): Response {
  const key = statsKey();
  if (!key || url.searchParams.get("key") !== key) return new Response("not found", { status: 404 });
  const days = Math.max(0, Math.min(3650, Number(url.searchParams.get("days") ?? 30) || 0));
  const a = aggregate(readEvents(days));
  if (!html) return json({ days, ...a });
  return new Response(statsHtml(a, days, key), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });
}

if (import.meta.main) Bun.serve({
  port: PORT,
  hostname: HOST,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/api/event") return req.method === "POST" ? acceptEvent(req) : json({ ok: false }, 405);
    if (url.pathname === "/api/stats") return statsRoute(url, false);
    if (url.pathname === "/stats") return statsRoute(url, true);
    let p = decodeURIComponent(url.pathname);
    if (p.endsWith("/")) p += "index.html";
    // данные метрик и ключ — не наружу
    if (p === "/data" || p.startsWith("/data/")) return new Response("not found", { status: 404 });

    // защита от выхода за пределы каталога (../, симлинки, абсолютные пути)
    const full = resolve(ROOT, "." + p);
    if (full !== ROOT && !full.startsWith(ROOT + sep)) return new Response("forbidden", { status: 403 });

    const file = Bun.file(full);
    if (!(await file.exists())) return new Response("not found", { status: 404 });

    const ext = p.slice(p.lastIndexOf("."));
    return new Response(file, {
      headers: {
        "content-type": MIME[ext] ?? "application/octet-stream",
        "cache-control": cacheFor(p),
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
      },
    });
  },
});
if (import.meta.main) console.log(`dirigo-site: http://${HOST}:${PORT}`);
