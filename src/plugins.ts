// Dirigo — лёгкие плагины-data (V2-5.3).
//
// Плагины без кода: plugins.json описывает web-панели (фреймы) и ссылки.
// Демон их только читает и отдаёт; рендерит UI (CSP frame-src уже разрешает
// http/https). Формат:
//   { "panels": [{id,title,url,kind?: "frame"|"link",hint?}],
//     "links":  [{id,title,url}] }

import { existsSync, readFileSync } from "node:fs";

export interface PluginPanel { id: string; title: string; url: string; kind: "frame" | "link"; hint?: string; }
export interface PluginLink { id: string; title: string; url: string; }
export interface PluginsData { panels: PluginPanel[]; links: PluginLink[]; }

const FILE = new URL("../plugins.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

export function loadPlugins(): PluginsData {
  const empty: PluginsData = { panels: [], links: [] };
  try {
    if (!existsSync(FILE)) return empty;
    const raw = JSON.parse(readFileSync(FILE, "utf8")) as Partial<PluginsData>;
    const panels = Array.isArray(raw.panels)
      ? raw.panels.filter((p) => p?.id && p?.title && p?.url).map((p) => ({
          id: String(p.id), title: String(p.title), url: String(p.url),
          kind: p.kind === "link" ? "link" as const : "frame" as const,
          hint: p.hint ? String(p.hint) : undefined,
        }))
      : [];
    const links = Array.isArray(raw.links)
      ? raw.links.filter((l) => l?.id && l?.title && l?.url).map((l) => ({ id: String(l.id), title: String(l.title), url: String(l.url) }))
      : [];
    return { panels, links };
  } catch { return empty; }
}
