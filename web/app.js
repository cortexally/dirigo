/* ═══════════════════════════════════════════════════════════
   Dirigo — модуль пульта. Подключён к API
   порта v2: сессии, копии, diff/git, swarm/fusion/orchestrator,
   история, статистика, настройки.
   ═══════════════════════════════════════════════════════════ */

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtTime = (ts) => !ts ? "" : new Date(ts).toLocaleTimeString("ru", { hour: "2-digit", minute: "2-digit" });
const fmtAgo = (ts) => {
  if (!ts) return "";
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return "только что";
  if (s < 3600) return `${Math.floor(s / 60)} мин назад`;
  if (s < 86400) return `${Math.floor(s / 3600)} ч назад`;
  return `${Math.floor(s / 86400)} дн назад`;
};
const MODE_LABEL = { solo: "Solo", swarm: "Swarm", fusion: "Fusion", orchestrator: "Orchestrator" };
/** Виды центральной области. «file» — просмотр файла по центру (F2). */
const VIEWS = ["chat", "file", "board", "history", "stats", "settings", "overview", "term", "evidence"];

const state = {
  projects: [],
  sessions: [],
  agents: [],
  current: null,          // id открытой сессии
  tabs: [],               // открытые табы [{id,title}]
  target: null,           // BranchTarget открытой сессии
  diff: null,
  files: null,            // дерево файлов копии
  fileView: null,
  viewBeforeFile: null,  // куда вернуться после закрытия файла
  checks: [],
  view: "chat",           // chat | board | history | stats | settings
  history: null,
  histProject: "",
  histOpenSha: null,
  expanded: new Set(),    // свёрнутые/раскрытые группы и папки
  collapsed: false,
  projectCollapsed: new Set(), // свёрнутые группы проектов в sidebar
  rightTab: "changes",
  plans: null,
  swarms: null,
  fusions: null,
  boardProject: "",
  tick: null,
};

/* ── API ── */
let TOKEN = "";

/**
 * Демон не отвечает. Раньше fetch бросал сырое «Failed to fetch», и этот
 * текст браузера расползался по всем панелям (Обзор, Статистика, шаги
 * мастера). Снаружи это выглядит как поломка пульта, хотя причина одна:
 * процесс демона не запущен или остановлен, а оболочку показал
 * service worker из кэша.
 */
const OFFLINE_MSG = "Демон не отвечает — проверьте, что он запущен";
let daemonOffline = false;

function setDaemonOffline(off) {
  if (daemonOffline === off) return;
  daemonOffline = off;
  const bar = document.getElementById("offline-bar");
  if (bar) bar.classList.toggle("hidden", !off);
  document.body.classList.toggle("is-offline", off);
}

/** Записать разметку, только если она изменилась. Опрос раз в 5 с и события
 *  SSE перерисовывали блоки целиком при тех же данных — экран «моргал»,
 *  терялись выделение и наведение. Сравниваем с последней записанной строкой. */
const lastHTML = new WeakMap();
function setHTML(el, html) {
  if (!el) return false;
  if (lastHTML.get(el) === html && el.innerHTML !== "") return false;
  el.innerHTML = html;
  lastHTML.set(el, html);
  return true;
}

async function api(path, opts = {}) {
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method: opts.method ?? "GET",
      headers: { "content-type": "application/json", ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    // сюда попадают только сетевые отказы: демон не слушает порт
    setDaemonOffline(true);
    throw new Error(tr(OFFLINE_MSG));
  }
  setDaemonOffline(false);
  if (res.status === 401 && path !== "/auth/check") { location.reload(); throw new Error("unauthorized"); }
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(text.slice(0, 200)); }
  if (!res.ok) {
    // Сервер умеет объяснять отказ («чего нет» + «что сделать») — не теряем
    // это по дороге: иначе пользователь видит обрывок без шага к починке.
    const err = new Error(data.error ?? data.detail ?? `HTTP ${res.status}`);
    err.data = data;
    if (data.fix) err.fix = data.fix;
    if (data.reason) err.reason = data.reason;
    err.status = res.status;
    throw err;
  }
  return data;
}

/* ── тосты ── */
function toast(msg, kind = "ok") {
  const el = document.createElement("div");
  el.className = `oc-toast oc-toast--${kind}`;
  el.textContent = msg;
  $("toasts").appendChild(el);
  setTimeout(() => { el.style.opacity = "0"; el.style.transition = "opacity .3s"; setTimeout(() => el.remove(), 300); }, 3400);
}

/* ── статус-марка (как oc-working-mark) ── */
function statusMark(s) {
  const working = s.status === "running" || s.status === "queued";
  const cls = working ? "oc-mark--working" : s.status === "error" ? "oc-mark--error" : s.status === "done" ? "oc-mark--done" : "oc-mark--idle";
  const title = working ? "Работает" : s.status === "error" ? (s.failReason ? "Ошибка: " + s.failReason : "Ошибка") : s.status === "done" ? "Готово" : s.status === "stopped" ? "Остановлена" : "Ожидает";
  return `<span class="oc-mark ${cls}" role="img" aria-label="${title}" title="${title}">
    ${working ? `<span class="oc-mark__ring"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-dasharray="9 57" stroke-dashoffset="15"><circle cx="12" cy="12" r="10.5" stroke-opacity=".25"/><path d="M12 1.5a10.5 10.5 0 0 1 10.5 10.5"/></svg></span>` : ""}
    <span class="oc-mark__dot"></span></span>`;
}

/* ═══════════ ЗАГРУЗКА ДАННЫХ ═══════════ */
// версия сборки UI — сверяется с версией демона; расхождение = у пользователя
// закэшированный старый интерфейс (SW) → мягкая перезагрузка один раз
const UI_BUILD = "0.1.0"; // держать в синхроне с APP_VERSION (src/server.ts)
let reloadGuard = false;

let agentsAt = 0;
let refreshTimer = null;
/** Частые куски ответа агента — одна перерисовка ленты на 300 мс. */
function refreshSoon() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => { refreshTimer = null; refreshCurrent(); }, 300);
}
let tabsRestored = false;
let loadAllTimer = null;
/** События сессий приходят пачками — склеиваем их в одну перезагрузку. */
function loadAllSoon() {
  clearTimeout(loadAllTimer);
  loadAllTimer = setTimeout(() => loadAll({ agents: false }), 250);
}

async function loadAll(opts = {}) {
  // Список агентов с проверкой доступности — тяжёлый запрос (13 агентов,
  // файлы, бинари). По событиям сессий его не дёргаем чаще раза в 20 с.
  const wantAgents = opts.agents !== false || !state.agents.length || Date.now() - agentsAt > 20_000;
  const h = await api("/health").catch(() => null);
  if (h) {
    $("ver-badge").textContent = String(h.version ?? "1.4");
    // демон 1.4+ и UI старше — предложить обновление (однократно за сеанс)
    const ver = String(h.version ?? "");
    // Сравниваем полные версии (1.9 == 1.9.0): усечение UI_BUILD до двух
    // чисел при демоне 1.9.1 давало «устарел» всегда — страница перезагружалась
    // сама на каждой новой вкладке, сбивая открытый вид.
    const norm = (v) => { const p = String(v).split(".").map((x) => Number(x) || 0); while (p.length < 3) p.push(0); return p.slice(0, 3).join("."); };
    const stale = ver && norm(ver) !== norm(UI_BUILD);
    if (stale && !sessionStorage.getItem("ui-reloaded") && !reloadGuard) {
      sessionStorage.setItem("ui-reloaded", "1");
      toast("Интерфейс обновился — перезагружаю страницу", "ok");
      setTimeout(() => location.reload(), 800);
      reloadGuard = true;
    }
  }
  const [projects, sessions, agents] = await Promise.all([
    api("/projects").catch(() => null),
    api("/sessions").catch(() => null),
    wantAgents ? api("/agents").catch(() => null) : Promise.resolve(null),
  ]);
  // Сбой одного запроса не должен обнулять списки (раньше пропадали все проекты)
  if (Array.isArray(projects)) state.projects = projects;
  if (Array.isArray(sessions)) state.sessions = sessions;
  if (!tabsRestored && Array.isArray(sessions)) { tabsRestored = true; restoreTabs(); }
  if (Array.isArray(agents)) { state.agents = agents; agentsAt = Date.now(); }
  // Сессию удалили (в другой вкладке, через API, вместе с проектом) — убираем
  // её из табов и не опрашиваем дальше: иначе каждые 5 с летели 404 и тосты.
  if (Array.isArray(sessions)) {
    const alive = new Set(sessions.map((s) => s.id));
    state.tabs = state.tabs.filter((t) => alive.has(t.id));
    if (state.current && !alive.has(state.current)) {
      state.current = state.tabs.at(-1)?.id ?? null;
      leavePtyFeed();
    }
  }
  renderSidebar();
  renderTabs();
  refreshCurrent();
  loadHistorySelects();
}

/* ═══════════ SIDEBAR ═══════════ */
function renderSidebar() {
  const wrap = $("sessions-scroll");
  // Счётчик у заголовка «Проекты» — это количество проектов, а не сессий.
  $("sessions-count").textContent = String(state.projects.length);
  // Ранний выход срабатывал при нуле СЕССИЙ и прятал уже добавленные проекты —
  // пользователь добавлял проект и не видел его в списке (баг 16.10).
  if (!state.sessions.length && !state.projects.length) {
    wrap.innerHTML = `<div class="oc-empty oc-empty--cta" id="sessions-empty">
      <p class="oc-empty__title">Здесь появятся ваши проекты</p>
      <p class="oc-empty__hint">Проект — это git-репозиторий на этой машине. Агенты работают в его копиях, оригинал не трогают.</p>
      <button class="oc-btn oc-btn--primary oc-btn--sm" data-act="add-project">Добавить проект</button>
    </div>`;
    return;
  }
  // группировка по проектам (как в оригинале: группа = проект)
  const byProj = new Map();
  for (const s of [...state.sessions].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))) {
    if (s.archived && !state.showArchivedSessions) continue;   // в архиве — не в списке
    const p = state.projects.find((x) => x.id === s.projectId);
    const key = p?.id ?? "?";
    if (!byProj.has(key)) byProj.set(key, { name: p?.name ?? s.projectId, id: key, items: [], archived: !!p?.archived });
    byProj.get(key).items.push(s);
  }
  // проекты без сессий — тоже показываем (иначе новый проект «не появился»)
  for (const p of state.projects) {
    if (!byProj.has(p.id)) byProj.set(p.id, { name: p.name, id: p.id, items: [], archived: !!p.archived });
  }
  // строкой и через setHTML: на каждое событие сессий список пересобирался
  // целиком — при работающем агенте сайдбар мигал несколько раз в секунду
  const htmlParts = [];
  const groups = [...byProj.entries()].sort((a, b) => Number(a[1].archived) - Number(b[1].archived));
  for (const [pid, g] of groups) {
    const open = !state.projectCollapsed.has(pid);
    htmlParts.push(`<div class="oc-group${g.archived ? " oc-group--archived" : ""}">
      <div class="oc-group__row">
        <button class="oc-group__head" data-group="${pid}">
          <span class="oc-dir-toggle ${open ? "oc-dir-toggle--open" : ""}">▸</span>
          <span class="oc-group__name">${esc(g.name)}</span>
          <span class="oc-group__count">${g.items.length}</span>
        </button>
        <span class="oc-group__acts">
          <button class="oc-icon-btn oc-icon-btn--tiny" data-proj-archive="${pid}" title="${g.archived ? "Вернуть из архива" : "В архив — проект и сессии остаются, но убираются из списка"}">${g.archived ? "↩" : "⌄"}</button>
          <button class="oc-icon-btn oc-icon-btn--tiny oc-icon-btn--danger" data-proj-del="${pid}" title="Удалить проект и все его сессии">✕</button>
        </span>
      </div>
      <ul class="oc-group__list ${open ? "" : "hidden"}">${g.items.length ? g.items.map(sessionItem).join("") : `<li class="oc-empty" style="padding:4px 8px">нет сессий</li>`}</ul></div>`);
  }
  setHTML(wrap, htmlParts.join(""));
}

function sessionItem(s) {
  const active = s.id === state.current;
  const p = state.projects.find((x) => x.id === s.projectId);
  const mode = s.workMode ?? "solo";
  return `<li class="oc-session-row"><button class="oc-session ${active ? "oc-session--active" : ""}" data-ses="${s.id}" title="${esc((s.title ?? "") + " · " + (p?.name ?? ""))}">
    ${statusMark(s)}
    <span class="oc-session__body">
      <span class="oc-session__title">${esc(shortTitle(s))}</span>
      <span class="oc-session__meta"><span class="oc-mode-text oc-mode-${mode}">${MODE_LABEL[mode]}</span>
      <span>·</span><span>${esc(agentName(s.agentId))}</span><span>·</span><span>${fmtAgo(s.updatedAt)}</span></span>
    </span>
  </button>
  <span class="oc-session-row__acts">
    <button class="oc-icon-btn oc-icon-btn--tiny" data-ses-archive="${s.id}" title="В архив — уберёт из списка, журнал и доказательства останутся">⌁</button>
    <button class="oc-icon-btn oc-icon-btn--tiny oc-icon-btn--danger" data-ses-del="${s.id}" title="Удалить сессию вместе с журналом">✕</button>
  </span></li>`;
}
function shortTitle(s) {
  const t = ((s.title ?? "").trim() || "Без названия");
  return t.length > 42 ? t.slice(0, 41) + "…" : t;
}
function agentName(id) { const a = state.agents.find((x) => x.id === id); return a?.label ?? a?.name ?? id; }
function agentById(id) { return state.agents.find((x) => x.id === id); }

/* ═══════════ ТАБЫ ═══════════ */
function renderTabs() {
  const wrap = $("tabs-scroll");
  // Заголовок таба — из актуальной сессии: при открытии только что созданной
  // её ещё не было в списке, и таб навсегда оставался «Без названия».
  const sessionTabs = state.tabs.map((t) => {
    const ses = state.sessions.find((s) => s.id === t.id);
    if (ses) t.title = shortTitle(ses);
    return `
    <div class="oc-tab ${t.id === state.current && state.view !== "term" ? "oc-tab--active" : ""}" data-tab="${t.id}">
      ${statusMark(ses ?? { status: "idle" })}
      <span>${esc(t.title)}</span>
      <button class="oc-tab__x" data-close="${t.id}" title="Закрыть">✕</button>
    </div>`;
  }).join("");
  const termTabs = state.terminals.map((t) => `
    <div class="oc-tab oc-tab--term ${t.id === state.term && state.view === "term" ? "oc-tab--active" : ""}" data-termtab="${t.id}">
      <span class="oc-termrow__dot"></span>
      <span>${esc(t.name)}</span>
      <button class="oc-tab__x" data-termclose="${t.id}" title="Закрыть">✕</button>
    </div>`).join("");
  setHTML(wrap, sessionTabs + termTabs);
  saveTabs();
}

/* Открытые табы и текущая сессия переживают перезагрузку страницы: раньше
   F5 закрывал все сессии, и их приходилось открывать заново из списка. */
function saveTabs() {
  try { localStorage.setItem("dirigo-tabs", JSON.stringify({ tabs: state.tabs, current: state.current })); } catch { /* приватный режим */ }
}
function restoreTabs() {
  try {
    const raw = JSON.parse(localStorage.getItem("dirigo-tabs") ?? "null");
    if (!raw || !Array.isArray(raw.tabs)) return;
    const alive = new Set(state.sessions.map((s) => s.id));
    state.tabs = raw.tabs.filter((t) => t && alive.has(t.id)).slice(-6);
    if (raw.current && alive.has(raw.current) && !state.current) state.current = raw.current;
  } catch { /* битое значение — начинаем с чистого листа */ }
}

function openSession(id) {
  if (!id) return;
  if (!state.tabs.some((t) => t.id === id)) {
    const s = state.sessions.find((x) => x.id === id);
    state.tabs.push({ id, title: shortTitle(s ?? {}) });
    if (state.tabs.length > 6) state.tabs.shift();
  }
  if (state.current !== id) { stopTermPoll(); termSession = null; }
  state.current = id;
  setView("chat");
  renderTabs();
  renderSidebar();
  refreshCurrent();
}

/* ═══════════ ЛЕНТА СЕССИИ ═══════════ */
async function refreshCurrent() {
  // Лента живёт только в виде «Разговор». refreshCurrent зовут и SSE, и
  // loadAll на каждое событие сессий — раньше он без спроса прятал текущий
  // вид и через пару секунд выкидывал из Настроек/Доски на главную.
  if (state.view !== "chat") return;
  if (!state.current) { showEmpty(); return; }
  $("view-empty").classList.add("hidden");
  $("view-chat").classList.remove("hidden");
  $("right-panel").classList.remove("hidden");
  try {
    const id = state.current;
    const s = await api(`/sessions/${id}`);
    // пока ждали ответ, пользователь мог уйти в другой вид или сессию
    if (state.view !== "chat" || state.current !== id) return;
    renderFeed(s);
    renderStatus(s);
    renderQuickModel();
    // чип агента — сразу, не дожидаясь панелей справа
    const ag = agentById(s.agentId);
    const mode0 = s.workMode ?? "solo";
    // Чип всегда называет две вещи: кто работает и в каком режиме. Модель
    // добавляем, когда она известна (у части CLI выбора моделей попросту нет).
    const chipModel = s.model || s.acpModel || ag?.defaultModel || "";
    const chipMode = MODE_SHORT[s.mode === "persistent" ? "persistent" : (s.mode ?? "cli")] ?? "";
    composerHint(s);
    $("composer-agent").innerHTML = `<span class="oc-chip oc-chip--${mode0}">${esc(ag?.label ?? ag?.name ?? s.agentId)}${chipMode ? " · " + esc(chipMode) : ""}${chipModel ? " · " + esc(chipModel) : ""}</span>`;
    await loadDiff();
    loadFiles();
    loadChecks();
  } catch (e) {
    // сессию только что удалили — это не ошибка для пользователя
    if (e.status === 404) { loadAll(); return; }
    toast(String(e.message ?? e), "err");
  }
}

/** Лента уходит из режима терминала: гасим эмулятор, поток и опрос. */
function leavePtyFeed() {
  if (termSession || xt) { stopTermPoll(); unmountXterm(); termSession = null; }
  $("feed")?.classList.remove("oc-feed--pty");
}

function renderFeed(s) {
  const feed = $("feed");
  // Терминальная сессия — это экран, а не лента строк. Поток PTY состоит из
  // управляющих последовательностей, и показывать их как лог бессмысленно:
  // именно поэтому «Терминал (TUI)» выглядел как молчащий агент.
  // У каждого рендера ленты своя «подпись» содержимого; чужую сбрасываем,
  // иначе при возврате к сессии другого режима лента оставалась прежней.
  if (s.mode === "pty") { delete feed.dataset.sig; delete feed.dataset.webSig; renderPtyFeed(s); return; }
  if (s.mode === "web") { delete feed.dataset.sig; leavePtyFeed(); renderWebFeed(s); return; }
  delete feed.dataset.webSig;
  leavePtyFeed();
  const parts = [];
  // У живого диалога заголовок служебный («ACP — проект»), а задача и так
  // стоит первым сообщением — карточка «Цель» лишь дублировала бы её.
  if (s.title && !(s.mode === "persistent" || s.persistent)) parts.push(goalCard(s.title));
  // лог как «шаги работы»: команды $ / системные [dirigo] / обычные строки
  for (const line of (s.logTail ?? [])) parts.push(logLine(line));
  // сообщения чата (ru: промпт + ответы агента)
  for (const m of (s.messages ?? [])) {
    if (m.role === "user") parts.push(`<div class="oc-msg oc-msg--user">${esc(m.text)}</div>`);
    else if (m.role === "system") parts.push(`<div class="oc-msg oc-msg--system">${esc(m.text)}</div>`);
    else if ((m.text ?? "").trim()) parts.push(`<div class="oc-msg oc-msg--agent">${esc(m.text.trim())}</div>`);
  }
  // Вопрос агента — кнопками, а не текстом: пока не ответишь, он стоит.
  if (s.pendingChoice) {
    const c = s.pendingChoice;
    parts.push(`<div class="oc-choice" data-choice="${esc(c.id)}">
      <div class="oc-choice__q">${esc(c.question)}</div>
      <div class="oc-choice__opts">${c.options.map((o) => `
        <button class="oc-btn ${/allow|accept|yes|approve/i.test(o.kind ?? o.id) ? "oc-btn--primary" : ""}"
          data-choice-pick="${esc(o.id)}" data-choice-id="${esc(c.id)}">${esc(o.label)}</button>`).join("")}</div>
      <div class="oc-choice__hint">Агент ждёт решения — без ответа он не продолжит.</div>
    </div>`);
  }
  // статус-заметки
  // Почему упало — человеческим языком и сразу, без похода в журнал.
  if (s.status === "error" && (s.failReason || s.failFix)) {
    parts.push(`<div class="oc-fail">
      <div class="oc-fail__why">${esc(s.failReason ?? "Сессия завершилась ошибкой")}</div>
      ${s.failFix ? `<div class="oc-fail__fix">${esc(s.failFix)}</div>` : ""}
    </div>`);
  }
  if (s.status === "error" && s.error) parts.push(notice(String(s.error), "err"));
  if (s.status === "done") parts.push(notice("Готово — работа ждёт вашего решения в панели «Изменения».", "ok"));
  if (s.checks?.length) {
    const last = s.checks[s.checks.length - 1];
    parts.push(notice(`Проверки: ${last.ok ? "пройдены" : "провалены"} · ${esc(last.command)} · ${(last.durationMs / 1000).toFixed(1)} с`, last.ok ? "ok" : "err"));
  }
  const html = parts.join("") || `<div class="oc-empty">Сессия запущена — лента появится здесь</div>`;
  // Ленту перерисовываем каждые 5 с: без этих проверок она мигала и силой
  // уезжала вниз, пока пользователь читал начало ответа.
  // полное сравнение: «длина + хвост 200 символов» пропускало правки в середине ленты
  if (feed.dataset.sig === s.id && lastHTML.get(feed) === html && feed.innerHTML) return;
  const fresh = feed.dataset.ses !== s.id;
  const atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80;
  const keep = feed.scrollTop;
  feed.innerHTML = html;
  feed.dataset.sig = s.id;
  lastHTML.set(feed, html);
  feed.dataset.ses = s.id;
  if (s.mode === "persistent" || s.persistent) renderActivity(s.id, s.activity);
  feed.scrollTop = fresh || atBottom ? feed.scrollHeight : keep;
}

/* ═══════════ ХОД РАБОТЫ ЖИВОГО ДИАЛОГА (ACP) ═══════════
   Пока модель думает, в ленте — пузырь «агент думает · 12 с»: что он делает
   сейчас (размышляет, вызывает инструмент, пишет ответ), хвост размышлений и
   список инструментов. Раньше десятки секунд было пусто. */
let actTimer = null;
const ACT_PHASE = { connecting: "Подключаемся к агенту", waiting: "Агент получил сообщение — ждём ответ модели", thinking: "Агент размышляет", tool: "Агент работает с инструментами", writing: "Агент пишет ответ", plan: "Агент составляет план" };
function renderActivity(sessionId, act) {
  const feed = $("feed");
  if (!feed || state.current !== sessionId) return;
  let el = $("acp-typing");
  if (!act?.busy) {
    el?.remove();
    if (actTimer) { clearInterval(actTimer); actTimer = null; }
    return;
  }
  const atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80;
  if (!el) {
    el = document.createElement("div");
    el.id = "acp-typing";
    el.className = "oc-msg oc-msg--agent oc-typing";
    feed.appendChild(el);
  } else if (el !== feed.lastElementChild) feed.appendChild(el);   // всегда последним
  el.dataset.since = String(act.since ?? Date.now());
  const tools = (act.tools ?? []).slice(-6).map((t) => {
    const mark = /complete|done|success/i.test(t.status) ? "✓" : /fail|error/i.test(t.status) ? "✗" : "…";
    return `<li><span class="oc-typing__mark">${mark}</span>${esc(t.title)}</li>`;
  }).join("");
  const plan = (act.plan ?? []).map((p) => `<li><span class="oc-typing__mark">${/complete/i.test(p.status) ? "✓" : "·"}</span>${esc(p.content)}</li>`).join("");
  const thought = String(act.thought ?? "").trim();
  el.innerHTML = `<div class="oc-typing__head"><span class="oc-typing__dots"><i></i><i></i><i></i></span>
      <span class="oc-typing__phase">${esc(tr(ACT_PHASE[act.phase] ?? ACT_PHASE.waiting))}</span>
      <span class="oc-typing__time" id="acp-typing-time"></span></div>
    ${thought ? `<div class="oc-typing__thought">${esc(thought.slice(-360))}</div>` : ""}
    ${plan ? `<ul class="oc-typing__list">${plan}</ul>` : ""}
    ${tools ? `<ul class="oc-typing__list">${tools}</ul>` : ""}`;
  const tick = () => {
    const t = $("acp-typing-time");
    const since = Number($("acp-typing")?.dataset.since ?? Date.now());
    if (t) t.textContent = `· ${Math.max(0, Math.round((Date.now() - since) / 1000))} ${tr("с")}`;
  };
  tick();
  if (!actTimer) actTimer = setInterval(() => { if (!$("acp-typing")) { clearInterval(actTimer); actTimer = null; return; } tick(); }, 1000);
  if (atBottom) feed.scrollTop = feed.scrollHeight;
}

/** «/model» в живом диалоге: выбор из моделей агента (ACP configOption). */
async function pickAcpModel(sessionId) {
  let s;
  try { s = await api(`/sessions/${sessionId}`); } catch (e) { toast(String(e.message ?? e), "err"); return; }
  const opts = s.acpModels?.options ?? [];
  if (!opts.length) { toast(tr("Агент не сообщил список моделей — смените модель в его настройках"), "err"); return; }
  const box = document.createElement("div");
  box.className = "oc-cmdk";
  box.id = "acp-model-modal";
  box.innerHTML = `<div class="oc-cmdk__box">
    <div class="oc-cmdk__input" style="display:block;font-weight:600">${esc(tr("Модель диалога"))}</div>
    <input class="oc-input" id="acp-model-filter" placeholder="${esc(tr("найти модель…"))}" style="margin:8px 16px;width:calc(100% - 32px)">
    <div class="oc-cmdk__list" id="acp-model-list"></div></div>`;
  document.body.appendChild(box);
  const list = () => {
    const q = ($("acp-model-filter")?.value ?? "").toLowerCase();
    $("acp-model-list").innerHTML = opts.filter((o) => !q || `${o.name} ${o.value}`.toLowerCase().includes(q)).slice(0, 200)
      .map((o) => `<button class="oc-cmdk__item ${o.value === s.acpModels.current ? "oc-cmdk__item--on" : ""}" data-acp-model="${esc(o.value)}">${esc(o.name || o.value)}<span class="muted small" style="margin-left:auto">${o.value === s.acpModels.current ? esc(tr("сейчас")) : ""}</span></button>`).join("")
      || `<div class="oc-empty">${esc(tr("ничего не найдено"))}</div>`;
  };
  list();
  const close = () => box.remove();
  $("acp-model-filter").oninput = list;
  $("acp-model-filter").focus();
  box.addEventListener("click", async (e) => {
    if (e.target === box) { close(); return; }
    const b = e.target.closest("[data-acp-model]");
    if (!b) return;
    try {
      await api(`/sessions/${sessionId}/model`, { method: "POST", body: { model: b.dataset.acpModel } });
      toast(`${tr("Модель")}: ${b.textContent.trim()}`, "ok");
      close(); refreshCurrent();
    } catch (err) { toast(String(err.message ?? err), "err"); }
  });
  box.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
}

/* ═══════════ ВЕБ-ПАНЕЛЬ АГЕНТА (режим Web) ═══════════ */

/**
 * Панель агента показываем прямо в пульте.
 *
 * Локальный сервер агента (opencode serve, kilo serve, zcode --web) — это
 * обычная страница на 127.0.0.1, и её можно встроить фреймом: пользователь
 * работает в родном интерфейсе агента, не уходя из пульта. Сайт агента
 * (claude.ai, cursor.com) фреймом открыть нельзя — такие сайты это запрещают,
 * поэтому для них показываем честную карточку со ссылкой.
 */
function renderWebFeed(s) {
  const feed = $("feed");
  const ag = agentById(s.agentId);
  const url = s.webAuthUrl || s.webUrl || "";
  const local = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(url);
  const sig = `${s.id}|${url}|${s.status}`;
  if (feed.dataset.webSig === sig) return;              // не дёргаем фрейм на каждом тике
  feed.dataset.webSig = sig;

  if (!url) {
    feed.innerHTML = `${s.title ? goalCard(s.title) : ""}
      ${s.status === "error"
        ? `<div class="oc-fail"><div class="oc-fail__why">${esc(s.failReason ?? "Панель не поднялась")}</div>${s.failFix ? `<div class="oc-fail__fix">${esc(s.failFix)}</div>` : ""}</div>`
        : `<div class="oc-empty">Поднимаем веб-панель ${esc(ag?.label ?? s.agentId)}…</div>`}`;
    return;
  }

  feed.innerHTML = `
    ${s.title ? goalCard(s.title) : ""}
    <div class="oc-termbar">
      <span class="oc-chip oc-chip--mono">${esc(url)}</span>
      <a class="oc-btn oc-btn--ghost oc-btn--tiny" href="${esc(url)}" target="_blank" rel="noopener">Открыть в новой вкладке</a>
      ${local ? `<button class="oc-btn oc-btn--ghost oc-btn--tiny" id="web-reload">Обновить</button>` : ""}
      <span class="muted small oc-termbar__spacer">${local
        ? "Родной интерфейс агента — работайте прямо здесь."
        : "Это сайт агента: встроить его нельзя, он откроется отдельной вкладкой."}</span>
    </div>
    ${local
      ? `<iframe class="oc-webframe" id="web-frame" src="${esc(url)}" referrerpolicy="no-referrer"
           sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-modals allow-downloads"></iframe>`
      : `<div class="oc-webcard">
           <div class="oc-webcard__title">${esc(ag?.web?.label ?? "Панель агента")}</div>
           <div class="oc-webcard__hint">${esc(ag?.web?.hint ?? "")}</div>
           <a class="oc-btn oc-btn--primary" href="${esc(url)}" target="_blank" rel="noopener">Перейти к ${esc(ag?.label ?? "агенту")}</a>
         </div>`}`;
  const rl = $("web-reload");
  if (rl) rl.onclick = () => { const f = $("web-frame"); if (f) f.src = f.src; };
}

/* ═══════════ ТЕРМИНАЛ СЕССИИ (режим PTY) ═══════════
   Экран рисует настоящий xterm.js из живого потока PTY (SSE /stream): при
   подключении — снимок текущего кадра, дальше — куски вывода как есть.
   Раньше здесь был опрос сетки раз в 700 мс и построчная отрисовка спанами:
   строки разъезжались полосами, а самописный разбор потока путал вывод TUI.
   Ввод — клавиши как есть (onData), вставка текста — bracketed paste,
   картинка — файлом в папке сессии, путь к нему уходит агенту.
   На запросы терминала (позиция курсора, цвета) отвечает демон; здесь они
   глушатся, иначе агент получил бы ответ дважды — «мусором» в поле ввода. */

let termPoll = null;       // опрос метаданных экрана: вход в аккаунт, модель
let termSession = null;    // чей экран сейчас показан
let xt = null;             // эмулятор терминала агента: { id, term, fit, el, es, ro, ... }
let xtShell = null;        // эмулятор встроенного терминала оболочки (вид «Терминал»)

/** Адреса API для эмулятора: терминал агента (сессия) или терминал оболочки. */
const XT_SESSION = (id) => ({ stream: `/api/sessions/${id}/stream`, input: `/sessions/${id}/input`, resize: `/sessions/${id}/resize`, paste: `/sessions/${id}/paste` });
const XT_SHELL = (id) => ({ stream: `/api/terminals/${id}/stream`, input: `/terminals/${id}/input`, resize: `/terminals/${id}/resize`, paste: null });
const xtLive = (st) => (st.slot === "shell" ? xtShell : xt) === st;

/** Каркас терминала в ленте + подключение эмулятора. */
function renderPtyFeed(s) {
  const feed = $("feed");
  feed.classList.add("oc-feed--pty");
  if (termSession !== s.id || !xt || xt.id !== s.id || !xt.el.isConnected) {
    termSession = s.id;
    const ag = agentById(s.agentId);
    // Карточка цели — только если задача правда была: у пустого терминала
    // заголовок — это имя режима, и карточка лишь отнимала высоту экрана.
    const task = String(s.prompt ?? "").trim();
    feed.innerHTML = `
      ${task && task !== ag?.pty?.label ? goalCard(task) : ""}
      <div class="oc-authbar hidden" id="pty-auth"></div>
      <div class="oc-termbar">
        <span class="oc-chip oc-chip--mono" id="pty-model" title="Модель, которой сейчас работает агент">модель агента</span>
        ${ag?.modelCommand ? `<button class="oc-btn oc-btn--ghost oc-btn--tiny" id="pty-modelbtn">Сменить модель в агенте</button>` : ""}
        <span class="muted small oc-termbar__spacer">Печатайте прямо в терминале или в поле внизу. Ctrl+V вставляет текст и картинки.</span>
      </div>
      <div class="oc-xterm" id="pty-term"></div>`;
    const mb = $("pty-modelbtn");
    if (mb) mb.onclick = () => {
      api(`/sessions/${s.id}/input`, { method: "POST", body: { text: ag.modelCommand } })
        .then(() => { xt?.term.focus(); toast("Открыл выбор модели в агенте — выберите в его списке", "ok"); })
        .catch((e) => toast(String(e.message ?? e), "err"));
    };
    mountXterm(s.id, $("pty-term"));
  }
  renderAuthBar(s);
  startTermPoll(s.id);
  // вернулись в разговор с уже подключённым терминалом — перерисовать кадр
  if (xt?.id === s.id) requestAnimationFrame(() => { try { xt?.term.refresh(0, xt.term.rows - 1); } catch { /* */ } });
}

/** Подпись нижнего поля под режим сессии — чтобы не гадать, куда писать. */
function composerHint(s) {
  const el = $("prompt");
  if (!el) return;
  // Через tr(): строку ставим из кода, и автоматический перевод страницы её
  // уже не догонит — иначе в английском интерфейсе оставался текст по умолчанию.
  el.placeholder = tr(s?.mode === "pty" ? "Сообщение в терминал агента"
    : s?.mode === "web" ? "Эта сессия — веб-панель агента: пишите в ней"
    : s?.mode === "persistent" || s?.persistent ? "Сообщение агенту (живой диалог)"
    : "Что далее?");
  el.disabled = s?.mode === "web";
  // Подсказка под полем — что на самом деле делает Enter в этом режиме.
  // Раньше там было «/ — команды · @ — файлы», хотя ни того, ни другого не было.
  const keys = $("composer-keys");
  if (keys) keys.textContent = tr(s?.mode === "pty" ? "Enter — в терминал агента · Shift+Enter — новая строка · /команды агента уходят как есть"
    : s?.mode === "persistent" || s?.persistent ? "Enter — отправить · Shift+Enter — новая строка · /model — сменить модель"
    : s?.mode === "web" ? "Пишите в веб-панели агента"
    : "Enter — продолжить задачу · Shift+Enter — новая строка");
}

/** Агент просит войти в аккаунт — показываем это первым делом, со ссылкой. */
function renderAuthBar(s) {
  const bar = $("pty-auth");
  if (!bar) return;
  const a = s.authPrompt;
  const sig = a ? `${a.label}|${a.url ?? ""}|${a.expired ? 1 : 0}` : "";
  if (bar.dataset.sig === sig) return;          // не перерисовываем то же самое (кнопки не мигают)
  bar.dataset.sig = sig;
  if (!a) { bar.classList.add("hidden"); bar.innerHTML = ""; return; }
  bar.classList.remove("hidden");
  bar.classList.toggle("oc-authbar--err", !!a.expired);
  bar.innerHTML = a.kind === "choice"
    ? `<div class="oc-authbar__why">${esc(tr(a.label))}</div>
       <div class="oc-authbar__fix">${esc(tr("Ответьте прямо в окне терминала — стрелки и Enter. Задача уйдёт агенту сама, сразу после ответа."))}</div>`
    : a.expired
    ? `<div class="oc-authbar__why">${esc(a.label)}</div>
       <button class="oc-btn oc-btn--ghost oc-btn--tiny" data-restart-session="1">Перезапустить сессию</button>
       <div class="oc-authbar__fix">Входите один раз: несколько открытых сессий показывают разные коды, и они гасят друг друга.</div>`
    : `<div class="oc-authbar__why">${esc(a.label)}</div>
       ${a.url ? `<a class="oc-authbar__link" href="${esc(a.url)}" target="_blank" rel="noopener">Открыть страницу входа</a>
                  <button class="oc-btn oc-btn--ghost oc-btn--tiny" data-copy-auth="${esc(a.url)}">Скопировать ссылку</button>` : ""}
       <div class="oc-authbar__fix">Задача уйдёт в терминал после входа — наберите её в поле внизу.</div>`;
}

/** Метаданные экрана (вход, модель) — редкий опрос: сам экран идёт потоком. */
function startTermPoll(id) {
  stopTermPoll();
  const tick = async () => {
    try {
      const sc = await api(`/sessions/${id}/screen?meta=1`);
      const mchip = $("pty-model");
      if (mchip && sc.model) mchip.textContent = sc.model;
      // Состояние входа берём из экрана: оно свежее снимка сессии
      // (ссылка у некоторых агентов появляется только после Enter).
      renderAuthBar({ authPrompt: sc.auth });
    } catch { /* сессия закрыта/перезапущена — следующий тик разберётся */ }
  };
  tick();
  termPoll = setInterval(tick, 2000);
}

function stopTermPoll() {
  if (termPoll) { clearInterval(termPoll); termPoll = null; }
}

/* ── эмулятор ── */

/** Цвет из CSS (oklch/rgba/hex) → #rrggbb, с подложкой под полупрозрачные. */
let colorCtx = null;
function cssHex(color, under = "#ffffff") {
  try {
    colorCtx ??= Object.assign(document.createElement("canvas"), { width: 1, height: 1 }).getContext("2d", { willReadFrequently: true });
    colorCtx.clearRect(0, 0, 1, 1);
    colorCtx.fillStyle = under; colorCtx.fillRect(0, 0, 1, 1);
    colorCtx.fillStyle = "#000"; colorCtx.fillStyle = String(color || "").trim() || under;
    colorCtx.fillRect(0, 0, 1, 1);
    const [r, g, b] = colorCtx.getImageData(0, 0, 1, 1).data;
    return "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
  } catch { return under; }
}
const lum = (hex) => { const n = parseInt(hex.slice(1), 16); return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255; };

/* ANSI-палитры: на светлом фоне стандартные «яркие» цвета нечитаемы, поэтому
   у светлой темы свои, более тёмные оттенки (как у VS Code Light). */
const ANSI_DARK = {
  black: "#1b1f23", red: "#f07178", green: "#7fd88f", yellow: "#e5c07b", blue: "#61afef", magenta: "#c678dd", cyan: "#56b6c2", white: "#c8ccd4",
  brightBlack: "#6b7280", brightRed: "#ff8b92", brightGreen: "#a5e8b0", brightYellow: "#f2d48f", brightBlue: "#8cc4ff", brightMagenta: "#dc9ef0", brightCyan: "#7fd1dc", brightWhite: "#f2f4f8",
};
const ANSI_LIGHT = {
  black: "#24292f", red: "#c62828", green: "#1a7f37", yellow: "#9a6700", blue: "#0550ae", magenta: "#8250df", cyan: "#0e7490", white: "#6e7781",
  brightBlack: "#57606a", brightRed: "#d1242f", brightGreen: "#2da44e", brightYellow: "#bf8700", brightBlue: "#218bff", brightMagenta: "#a475f9", brightCyan: "#1b95b5", brightWhite: "#8c959f",
};

/** Тема эмулятора из токенов текущей темы пульта. */
function termTheme() {
  const cs = getComputedStyle(document.documentElement);
  const base = cssHex(cs.getPropertyValue("--bg"), "#ffffff");
  const bg = cssHex(cs.getPropertyValue("--panel-solid"), base);
  const fg = cssHex(cs.getPropertyValue("--text"), lum(bg) > 0.5 ? "#1f2328" : "#e6e8ee");
  const accent = cssHex(cs.getPropertyValue("--accent"), "#5b8def");
  const light = lum(bg) > 0.5;
  return {
    background: bg, foreground: fg, cursor: accent, cursorAccent: bg,
    selectionBackground: accent + "55", selectionInactiveBackground: accent + "33",
    ...(light ? ANSI_LIGHT : ANSI_DARK),
  };
}

/**
 * Минимальный контраст текста. Часть агентов (cline, devin) не узнаёт фон и
 * рисует светло-серым, рассчитывая на тёмный терминал, — на светлой теме текст
 * пропадал. xterm сам затемняет такие цвета до читаемых (WCAG AA, 4.5:1).
 */
function termContrast(theme) { return lum(theme.background) > 0.5 ? 4.5 : 1; }

/** Тема пульта сменилась — перекрасить эмулятор и сообщить демону (OSC 11 для агентов). */
function applyTermTheme() {
  const t = termTheme();
  for (const x of [xt, xtShell]) {
    if (!x) continue;
    x.term.options.theme = t;
    x.term.options.minimumContrastRatio = termContrast(t);
    x.el.style.setProperty("--xterm-bg", t.background);
  }
  api("/terminal-theme", { method: "POST", body: { fg: t.foreground, bg: t.background } }).catch(() => {});
}

/** Запросы терминала глушим: отвечает демон (иначе агент получит ответ дважды). */
function muteTermQueries(term) {
  const p = term.parser;
  const yes = () => true;
  p.registerCsiHandler({ final: "n" }, yes);                          // DSR: 5n / 6n
  p.registerCsiHandler({ prefix: "?", final: "n" }, yes);
  p.registerCsiHandler({ final: "c" }, yes);                          // DA1
  p.registerCsiHandler({ prefix: ">", final: "c" }, yes);             // DA2
  p.registerCsiHandler({ prefix: "=", final: "c" }, yes);             // DA3
  p.registerCsiHandler({ prefix: ">", final: "q" }, yes);             // XTVERSION
  p.registerCsiHandler({ intermediates: "$", final: "p" }, yes);      // DECRQM
  p.registerCsiHandler({ prefix: "?", intermediates: "$", final: "p" }, yes);
  p.registerDcsHandler({ intermediates: "$", final: "q" }, yes);      // DECRQSS
  for (const id of [4, 10, 11, 12]) p.registerOscHandler(id, (data) => data.includes("?"));
}

function unmountXterm(slot = "session") {
  const x = slot === "shell" ? xtShell : xt;
  if (!x) return;
  try { x.es?.close(); } catch { /* */ }
  try { x.ro?.disconnect(); } catch { /* */ }
  // обработчики вставки/перетаскивания висят на контейнере — у терминала
  // оболочки он постоянный, без снятия они копились бы при каждом подключении
  for (const off of x.offs ?? []) { try { off(); } catch { /* */ } }
  clearTimeout(x.fitT);
  try { x.term.dispose(); } catch { /* */ }
  if (slot === "shell") xtShell = null; else xt = null;
}

/** Ввод в терминал: по порядку, пачками — быстрый набор и вставка не путаются. */
function xtSend(st, data) {
  if (st.dead) return;                 // процесс завершён — вводу некуда идти
  // «Окно потеряло фокус» агенту не сообщаем: в пульте фокус уходит постоянно
  // (нижнее поле, список сессий), а TUI на opentui (freebuff) после этого
  // выбрасывают весь ввод — «текст отправлен, но ничего не происходит».
  data = data.split("\x1b[O").join("");
  if (!data) return;
  st.q += data;
  if (st.busy) return;
  st.busy = true;
  (async () => {
    while (st.q && xtLive(st)) {
      const chunk = st.q;
      st.q = "";
      try {
        await api(st.ep.input, { method: "POST", body: { text: chunk, raw: true } });
      } catch (e) {
        if (e.status === 404 || e.status === 409) { st.q = ""; st.dead = true; break; }   // процесс/терминал уже закрыт — молча
        if (!st.warned) { st.warned = true; toast(String(e.message ?? e), "err"); }
      }
    }
    st.busy = false;
  })();
}

/** Картинка → файл в папке сессии → путь в поле ввода агента. */
async function xtPasteImage(st, file) {
  if (!file) return;
  if (file.size > 20 * 1024 * 1024) { toast("Картинка больше 20 МБ — не отправлю", "err"); return; }
  const data = await new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(",")[1] ?? "");
    r.onerror = () => rej(r.error);
    r.readAsDataURL(file);
  });
  try {
    if (!st.ep.paste) { toast("Картинки принимает только терминал агента", "err"); return; }
    const r = await api(st.ep.paste, { method: "POST", body: { mime: file.type, data } });
    if (!xtLive(st)) return;
    const p = /\s/.test(r.path) ? `"${r.path}"` : r.path;
    // term.paste уважает bracketed paste: агент видит это как вставку пути и
    // прикладывает картинку (claude, opencode) или читает файл сам.
    st.term.paste(p + " ");
    st.term.focus();
    toast("Картинка вставлена — агент получил путь к файлу", "ok");
  } catch (e) { toast(String(e.message ?? e), "err"); }
}

function mountXterm(id, el, ep = XT_SESSION(id), slot = "session") {
  unmountXterm(slot);
  if (typeof Terminal !== "function" || typeof FitAddon?.FitAddon !== "function") {
    el.textContent = "Эмулятор терминала не загрузился — обновите страницу (Ctrl+F5).";
    return;
  }
  const theme = termTheme();
  el.style.setProperty("--xterm-bg", theme.background);
  const term = new Terminal({
    fontFamily: '"Cascadia Mono", "IBM Plex Mono", Consolas, "SF Mono", Menlo, "DejaVu Sans Mono", monospace',
    fontSize: 13, lineHeight: 1, letterSpacing: 0, cursorBlink: true, scrollback: 5000,
    allowProposedApi: true, theme, drawBoldTextInBrightColors: false, macOptionIsMeta: true,
    minimumContrastRatio: termContrast(theme), smoothScrollDuration: 0,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  // те же ширины символов, что у демона и у самих агентов (Unicode 11)
  if (typeof Unicode11Addon?.Unicode11Addon === "function") {
    term.loadAddon(new Unicode11Addon.Unicode11Addon());
    term.unicode.activeVersion = "11";
  }
  term.open(el);
  muteTermQueries(term);
  const st = { id, slot, ep, term, fit, el, es: null, ro: null, q: "", busy: false, lastSize: "", fitT: 0, warned: false, offs: [] };
  const listen = (type, fn, capture = false) => { el.addEventListener(type, fn, capture); st.offs.push(() => el.removeEventListener(type, fn, capture)); };
  if (slot === "shell") xtShell = st; else xt = st;

  term.onData((d) => xtSend(st, d));
  term.onBinary((d) => xtSend(st, d));
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown") return true;
    const mod = e.ctrlKey || e.metaKey;
    // Ctrl+C при выделении — копировать, а не прерывать агента
    if (mod && e.key.toLowerCase() === "c" && term.hasSelection()) {
      navigator.clipboard?.writeText(term.getSelection()).catch(() => {});
      term.clearSelection();
      return false;
    }
    // Ctrl+V — отдаём браузеру: придёт событие paste (текст или картинка)
    if (mod && e.key.toLowerCase() === "v") return false;
    return true;
  });

  // Вставка: текст xterm вставит сам (bracketed paste), картинку — мы.
  listen("paste", (e) => {
    const files = [...(e.clipboardData?.items ?? [])]
      .filter((i) => i.kind === "file" && i.type.startsWith("image/"))
      .map((i) => i.getAsFile()).filter(Boolean);
    if (!files.length) return;
    e.preventDefault(); e.stopPropagation();
    for (const f of files) void xtPasteImage(st, f);
  }, true);
  listen("dragover", (e) => {
    if ([...(e.dataTransfer?.items ?? [])].some((i) => i.kind === "file")) { e.preventDefault(); el.classList.add("oc-xterm--drop"); }
  });
  listen("dragleave", () => el.classList.remove("oc-xterm--drop"));
  listen("drop", (e) => {
    el.classList.remove("oc-xterm--drop");
    const files = [...(e.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith("image/"));
    if (!files.length) return;
    e.preventDefault();
    for (const f of files) void xtPasteImage(st, f);
  });

  // Размер: эмулятор вписываем в окно, PTY агента — под эмулятор (TUI перерисуется).
  // Размер меняет только демон: браузер считает, сколько клеток помещается,
  // и просит демон; тот меняет PTY и присылает кадр в новом размере (init).
  // Раньше xterm в браузере менял размер сам, и куски вывода между двумя
  // resize раскладывались по-разному — экран пульта расходился с агентом.
  const doFit = () => {
    if (!xtLive(st) || !el.isConnected || el.offsetParent === null) return;
    let dims;
    try { dims = fit.proposeDimensions(); } catch { return; }
    if (!dims || !dims.cols || !dims.rows) return;
    const key = `${dims.cols}x${dims.rows}`;
    if (key === st.lastSize) return;
    st.lastSize = key;
    api(ep.resize, { method: "POST", body: { cols: dims.cols, rows: dims.rows } })
      .then((r) => {
        // провайдер без resize (script(1)) держит свой размер — берём его
        if (xtLive(st) && r && (r.cols !== term.cols || r.rows !== term.rows)) term.resize(r.cols, r.rows);
      })
      .catch(() => {});
  };
  // Контейнер показался/изменился: xterm, получивший данные, пока вид был
  // скрыт (display:none), сам строки не перерисовывает — окно оставалось
  // пустым до следующего вывода агента. Перерисовываем явно.
  st.ro = new ResizeObserver(() => {
    if (el.offsetParent !== null) { try { term.refresh(0, term.rows - 1); } catch { /* */ } }
    clearTimeout(st.fitT); st.fitT = setTimeout(doFit, 60);
  });
  st.ro.observe(el);
  doFit();

  // Поток экрана. EventSource сам переподключается; каждый раз приходит
  // init-снимок, поэтому экран после обрыва восстанавливается целиком.
  const es = new EventSource(ep.stream);
  st.es = es;
  // Очередь записи. xterm разбирает write асинхронно: если на init (кадр при
  // смене размера) сразу делать reset, ещё не разобранные прежние куски
  // доигрывались уже на чистом экране, а снимок ложился сверху — заголовок
  // Claude рисовался дважды, строки наезжали. Каждый шаг ждёт конца предыдущего.
  // st.q занят очередью ввода (xtSend) — у записи своя очередь st.wq
  st.wq = Promise.resolve();
  const step = (fn) => { st.wq = st.wq.then(() => new Promise((done) => { if (!xtLive(st)) return done(); try { fn(done); } catch { done(); } })); };
  es.onmessage = (ev) => {
    if (!xtLive(st)) return;
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (m.t === "init") {
      step((done) => {
        st.dead = !m.live;
        // кадр от демона — истина: его размер и содержимое
        if (m.cols !== term.cols || m.rows !== term.rows) term.resize(m.cols, m.rows);
        term.reset();
        term.write(m.data, done);
        if (!m.live) term.write(slot === "shell" ? "\r\n\x1b[2m[терминал закрыт]\x1b[0m" : "\r\n\x1b[2m[процесс завершён — «Перезапустить» запустит заново]\x1b[0m");
      });
      // первое подключение: если окно другого размера — попросим демон подстроиться
      if (!st.sized) { st.sized = true; clearTimeout(st.fitT); st.fitT = setTimeout(doFit, 30); }
    } else if (m.t === "d") {
      step((done) => term.write(m.data, done));
    } else if (m.t === "exit") {
      st.dead = true;
      term.write(`\r\n\x1b[2m[процесс завершён с кодом ${m.code}]\x1b[0m\r\n`);
    } else if (m.t === "none") {
      es.close();
      term.write(slot === "shell" ? "\x1b[2mтерминал закрыт\x1b[0m" : "\x1b[2mтерминал этой сессии ещё не запущен\x1b[0m");
    }
  };
  setTimeout(() => { if (xtLive(st)) term.focus(); }, 50);
  return st;
}

function goalCard(text) {
  return `<div class="oc-card oc-card--goal">
    <div class="oc-card__label"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/></svg>Цель</div>
    <div class="oc-card__text">${esc(text)}</div>
  </div>`;
}

const CMD_RE = /^\$ (.+)$/;
const SYS_RE = /^\[dirigo\]\s*(.+)$/;
function logLine(line) {
  const m = CMD_RE.exec(line);
  if (m) return `<div class="oc-step oc-step--run"><div class="oc-step__icon">▸</div><div class="oc-step__body"><div class="oc-step__text"><b>Выполняет</b> <span class="oc-step__file">${esc(m[1])}</span></div></div></div>`;
  const s = SYS_RE.exec(line);
  if (s) return `<div class="oc-step"><div class="oc-step__icon">◆</div><div class="oc-step__body"><div class="oc-step__text">${esc(s[1])}</div></div></div>`;
  if (/создан|создаёт|created/i.test(line)) return step(line, "create", "Создаёт");
  if (/правит|редактирует|изменён|updated|edited/i.test(line)) return step(line, "edit", "Правит");
  if (/читает|reading/i.test(line)) return step(line, "read", "Читает");
  if (/url|listening|http/i.test(line)) return step(line, "run", "Сервер");
  return `<div class="oc-step"><div class="oc-step__icon">·</div><div class="oc-step__body"><div class="oc-step__text" style="color:var(--text-dim)">${esc(line)}</div></div></div>`;
}
function step(line, kind, verb) {
  return `<div class="oc-step oc-step--${kind}"><div class="oc-step__icon">${kind === "create" ? "＋" : kind === "edit" ? "✎" : kind === "read" ? "👁" : "⚙"}</div><div class="oc-step__body"><div class="oc-step__text"><b>${verb}</b> ${esc(line)}</div></div></div>`;
}
function notice(text, kind) {
  return `<div class="oc-notice oc-notice--${kind === "err" ? "err" : kind === "ok" ? "ok" : ""}">${esc(text)}</div>`;
}

function showEmpty() {
  leavePtyFeed();
  for (const v of VIEWS) $(`view-${v}`)?.classList.add("hidden");
  $("view-empty").classList.remove("hidden");
  $("right-panel").classList.add("hidden");
}

/* ═══════════ СТАТУС РАБОТЫ (V6-6): понятно, что происходит с сессией ═══════════ */
function renderStatus(s) {
  const el = $("rp-status");
  if (!s) { setHTML(el, ""); return; }
  const dot = (state) => `<span class="oc-status__dot oc-status__dot--${state}"></span>`;
  let label = "", cls = "idle", hint = "";
  const mode = s.mode ?? "cli";
  switch (s.status) {
    case "running": label = "Работа идёт"; cls = "run"; break;
    case "queued": label = "В очереди"; cls = "queue"; break;
    case "done": label = "Готово — работа ждёт вашего решения"; cls = "ok"; break;
    case "error": label = s.failReason ? `Ошибка: ${s.failReason}` : "Ошибка"; cls = "err"; break;
    case "stopped": label = "Остановлена"; cls = "idle"; break;
    default: label = s.status ?? "—"; cls = "idle";
  }
  // ход работы: последние шаги лога + проверки/приёмка
  const steps = (s.logTail ?? []).slice(-3).filter((l) => /^\$|^\[dirigo\]/.test(l));
  if (steps.length) hint = steps.map((l) => `<div class="oc-status__step">${esc(l.length > 90 ? l.slice(0, 89) + "…" : l)}</div>`).join("");
  const acc = s.acceptance?.[s.acceptance.length - 1];
  const checks = (s.checks ?? []);
  const lastCheck = checks[checks.length - 1];
  const meta = [
    `${MODE_LABEL[s.workMode ?? "solo"]}`,
    mode === "cli" ? "CLI" : mode === "pty" ? "PTY" : mode === "web" ? "Web" : "ACP",
    lastCheck ? (lastCheck.ok ? "проверки ✓" : "проверки ✗") : null,
    acc ? (acc.ok ? "приёмка ✓" : "приёмка ✗") : null,
  ].filter(Boolean).map((m) => `<span class="oc-chip oc-chip--mono">${esc(m)}</span>`).join(" ");
  setHTML(el, `<div class="oc-status ${cls}">${dot(cls)}<span class="oc-status__label">${esc(label)}</span><span class="oc-status__meta">${meta}</span></div>${hint ? `<div class="oc-status__hint">${hint}</div>` : ""}${s.error ? `<div class="oc-status__err">${esc(String(s.error).slice(0, 200))}</div>` : ""}`);
}

/* ═══════════ ПРАВАЯ ПАНЕЛЬ: изменения ═══════════ */
async function loadDiff() {
  if (!state.current) return;
  try {
    const [d, t] = await Promise.all([
      api(`/sessions/${state.current}/diff`).catch(() => null),
      api(`/sessions/${state.current}/target`).catch(() => null),
    ]);
    state.diff = d;
    state.target = t;
    renderChanges();
  } catch { /* панель живает своей жизнью */ }
}

function renderChanges() {
  const t = state.target, d = state.diff;
  const root = $("rp-branch");
  if (!t) { root.textContent = "—"; return; }
  // цель панели: копия или бранч; ветка всегда с именем, «?» не показываем
  const where = t.kind === "copy" ? "копия" : "бранч";
  const branchName = t.branch && t.branch !== "HEAD" && t.branch !== "?" ? t.branch : t.git ? "main" : "без git";
  setHTML(root, `<span class="oc-chip ${t.kind === "branch" ? "oc-chip--accent" : "oc-chip--swarm"}" title="${esc(t.path ?? "")}">${where} · ${esc(branchName)}</span>`);
  // Сессия без копии: «Применить» не нужно — агент уже правит проект. Говорим
  // это прямо, иначе непонятно, куда делась кнопка и откуда берутся пакеты.
  const modeNote = $("rp-mode-note");
  if (modeNote) {
    const direct = t.kind === "branch";
    modeNote.hidden = !direct;
    if (direct) setHTML(modeNote, `Агент правит проект <b>напрямую</b> — «Применить» не нужно, изменения уже в папке проекта. Зафиксируйте их коммитом: при коммите шлюз PII проверит добавленные строки и появится пакет доказательств. Чтобы сначала смотреть дифф, а потом переносить, создавайте сессию «в копии».`);
  }
  // Коммиты — только в собственный репозиторий проекта. Без него кнопки git
  // вернули бы 409; вместо немой ошибки — объяснение и одна кнопка.
  const gitNote = $("rp-gitinit");
  if (gitNote) {
    const need = t.projectOwnRepo === false;
    gitNote.hidden = !need;
    if (need) {
      const why = t.projectInsideRepo
        ? `Проект лежит внутри другого репозитория (${esc(t.projectInsideRepo)}). Коммиты отключены, чтобы не попасть туда.`
        : "У проекта нет своего git: коммит, push и merge недоступны.";
      const copyNote = t.copyKind === "copy" ? " Эта сессия работает в файловой копии — «Применить в проект» доступно; новые сессии после создания git пойдут в git-копию." : "";
      setHTML(gitNote, `<div class="oc-rp__gitinit-text">${why}${copyNote}</div><button class="oc-btn oc-btn--sm oc-btn--primary" data-act="git-init" data-project="${esc(t.projectId ?? "")}">Создать git проекта</button>`);
    }
    for (const id of ["btn-commit", "btn-push", "btn-pr", "btn-merge"]) { const b = $(id); if (b) b.disabled = need; }
  }
  // открытый дифф файла переживает ререндер (поллинг 5с не должен его закрывать)
  const openDiff = $("file-diff")?.outerHTML ?? "";
  const files = d?.files ?? [];
  $("changes-count").textContent = String(files.length);
  $("rail-changes").textContent = String(files.length);
  // кнопки по смыслу цели: применить/вернуть — только у копии; git — только с git
  $("rp-copy-row").hidden = t.kind !== "copy";
  $("rp-git-row").hidden = !t.git || t.projectOwnRepo === false;
  // сворачиваемые группы — как проекты в sidebar (шеврон + счётчик)
  const group = (key, label, inner) => {
    const open = !state.projectCollapsed.has(`c:${key}`);
    return `<div class="oc-rp__group"><button class="oc-rp__glabel oc-rp__glabel--btn" data-cgroup="${key}">
      <span class="oc-dir-toggle ${open ? "oc-dir-toggle--open" : ""}">▸</span><span>${label}</span></button>
      <div class="${open ? "" : "hidden"}">${inner}</div></div>`;
  };
  const piiOf = d?.pii ?? {};
  const kindRu = { email: "e-mail", phone: "телефон", iban: "IBAN", card: "карта", secret: "секрет", jwt: "токен", ip: "IP", name: "ФИО", custom: "своё слово" };
  const rows = (list) => {
    if (!list.length) return `<div class="oc-empty" style="padding:8px">нет изменений</div>`;
    return list.map((f) => {
      const p = piiOf[f.path];
      const n = p ? Object.values(p.kinds).reduce((a, b) => a + b, 0) : 0;
      const tip = p ? `Персональные данные в добавленных строках: ${Object.entries(p.kinds).map(([k, v]) => `${kindRu[k] ?? k} ×${v}`).join(", ")}; строки ${p.lines.join(", ")}` : "";
      return `<button class="oc-file oc-file--modified" data-file="${esc(f.path)}" title="${p ? esc(tip) : "Показать дифф файла по центру"}">
        <span class="oc-file__dot"></span>
        <span class="oc-file__path">${esc(f.path)}</span>${n ? `<span class="oc-pii-badge" data-pii="${esc(f.path)}">PII·${n}</span>` : ""}
        <span class="oc-file__delta"><span class="add">+${f.added}</span>${f.deleted ? ` <span class="del">−${f.deleted}</span>` : ""}</span>
      </button>`;
    }).join("");
  };
  // v2 не различает staged/unstaged в diff — показываем одним списком + кнопки
  const changesBlock = group("changes", `Изменения · ${files.length}`,
    rows(files) + (files.length ? `<div style="margin:6px 0 2px"><button class="oc-btn oc-btn--ghost" data-act="diff-all" title="Показать весь дифф в центре">Показать весь дифф</button></div>` : ""));
  setHTML($("rp-staged"), openDiff + changesBlock);
  setHTML($("rp-unstaged"), "");
  const checks = state.checks.slice(-3).reverse();
  setHTML($("rp-checks"), checks.length ? group("checks", `Проверки · ${checks.length}`, checks.map((c) => `<div class="oc-check ${c.ok ? "oc-check--ok" : "oc-check--fail"}">${c.ok ? "✓" : "✗"} ${esc(c.command)} <span style="color:var(--text-faint)">· ${(c.durationMs / 1000).toFixed(1)} с</span></div>`).join("")) : "");
}

async function loadChecks() {
  if (!state.current) return;
  try { const s = await api(`/sessions/${state.current}`); state.checks = s.checks ?? []; renderChanges(); } catch { /* */ }
}

async function showFileDiff(path) {
  // дифф файла — по центру (отдельный вид), с подсветкой было/стало как в git
  try {
    const d = await api(`/sessions/${state.current}/diff`);
    const f = (d.files ?? []).find((x) => x.path === path);
    if (!f) { toast("Файл не в изменённых", "err"); return; }
    openCenter({
      title: `${f.path}`,
      meta: `дифф · +${f.added} −${f.deleted}`,
      diffFile: f,
    });
  } catch (e) { toast(String(e.message ?? e), "err"); }
}

/** Центральный вид «файл/дифф»: контент файла ИЛИ построчный дифф. */
function openCenter(opts) {
  state.viewBeforeFile = state.view === "file" ? (state.viewBeforeFile ?? "chat") : state.view;
  setView("file");
  $("file-modal-name").textContent = opts.title;
  $("file-modal-meta").textContent = opts.meta ?? "";
  const code = $("file-modal-code");
  if (opts.diffFile) {
    const f = opts.diffFile;
    const rows = (f.lines ?? []).map((l) => {
      const cls = l.kind === "add" ? "diff-line add" : l.kind === "del" ? "diff-line del" : "diff-line ctx";
      const sign = l.kind === "add" ? "+" : l.kind === "del" ? "−" : " ";
      return `<div class="${cls}"><span class="diff-no">${l.oldNo ?? ""}</span><span class="diff-no">${l.newNo ?? ""}</span><span class="diff-sign">${sign}</span>${esc(l.text)}</div>`;
    }).join("");
    code.innerHTML = rows || `<div class="oc-empty">нет строк в диффе</div>`;
  } else {
    const text = opts.fileText ?? "";
    code.textContent = text + (opts.truncated ? "\n… (обрезано, файл большой)" : "");
  }
  code.scrollTop = 0;
}

/** Весь дифф сессии в центре (кнопка «Показать весь дифф»). */
async function showAllDiff() {
  try {
    const d = await api(`/sessions/${state.current}/diff`);
    const files = d.files ?? [];
    if (!files.length) { toast("Изменений нет", "ok"); return; }
    const rows = files.map((f) => {
      const body = (f.lines ?? []).map((l) => {
        const cls = l.kind === "add" ? "diff-line add" : l.kind === "del" ? "diff-line del" : "diff-line ctx";
        const sign = l.kind === "add" ? "+" : l.kind === "del" ? "−" : " ";
        return `<div class="${cls}"><span class="diff-no">${l.oldNo ?? ""}</span><span class="diff-no">${l.newNo ?? ""}</span><span class="diff-sign">${sign}</span>${esc(l.text)}</div>`;
      }).join("");
      return `<div class="diff-file"><div class="diff-file__head">${esc(f.path)} <span style="color:var(--ins)">+${f.added}</span> <span style="color:var(--del)">−${f.deleted}</span></div>${body}</div>`;
    }).join("");
    state.viewBeforeFile = state.view === "file" ? (state.viewBeforeFile ?? "chat") : state.view;
    setView("file");
    $("file-modal-name").textContent = `дифф · ${files.length} файл(ов)`;
    $("file-modal-meta").textContent = `${state.target?.branch ? "ветка " + state.target.branch : ""}`;
    $("file-modal-code").innerHTML = rows;
    $("file-modal-code").scrollTop = 0;
  } catch (e) { toast(String(e.message ?? e), "err"); }
}

/* Дифф коммита в центре (V5.2: «Показать дифф» в Истории — предпросмотр, не сворачивание) */
async function showCommitDiff(sha) {
  try {
    const proj = $("history-project")?.value;
    if (!proj) return toast("Выберите проект", "err");
    const r = await api(`/history/commit?project=${encodeURIComponent(proj)}&sha=${encodeURIComponent(sha)}`);
    const files = r.files ?? [];
    if (!files.length) { toast("В коммите нет файлов", "err"); return; }
    const rows = files.map((f) => {
      const body = (f.lines ?? []).map((l) => {
        const cls = l.kind === "add" ? "diff-line add" : l.kind === "del" ? "diff-line del" : "diff-line ctx";
        const sign = l.kind === "add" ? "+" : l.kind === "del" ? "−" : " ";
        return `<div class="${cls}"><span class="diff-no">${l.oldNo ?? ""}</span><span class="diff-no">${l.newNo ?? ""}</span><span class="diff-sign">${sign}</span>${esc(l.text)}</div>`;
      }).join("");
      return `<div class="diff-file"><div class="diff-file__head">${esc(f.path)} <span style="color:var(--ins)">+${f.added}</span> <span style="color:var(--del)">−${f.deleted}</span></div>${body}</div>`;
    }).join("");
    state.viewBeforeFile = state.view === "file" ? (state.viewBeforeFile ?? "chat") : state.view;
    setView("file");
    $("file-modal-name").textContent = `${sha.slice(0, 7)} · ${r.message ?? ""}`.slice(0, 90);
    $("file-modal-meta").textContent = `${files.length} файл(ов)`;
    $("file-modal-code").innerHTML = rows;
    $("file-modal-code").scrollTop = 0;
  } catch (e) { toast(String(e.message ?? e), "err"); }
}

/* ═══════════ ПРАВАЯ ПАНЕЛЬ: файлы ═══════════ */
async function loadFiles() {
  if (!state.current || !state.target) return;
  const root = state.target.path;
  $("files-root").textContent = root.split(/[\\/]/).slice(-2).join("/");
  try {
    const tree = await api(`/sessions/${state.current}/files`);
    state.files = tree;
    renderFileTree();
  } catch { state.files = null; renderFileTree(); }
}

const IGNORE_DIRS = new Set(["node_modules", ".git", "dist", "build", ".dirigo", "data", "logs", ".smoke-data"]);
const IGNORE_FILES = new Set(["db.json", ".gitignore", "package-lock.json"]);

function buildTree(paths) {
  const root = { name: "", dirs: new Map(), files: [] };
  for (const f of paths) {
    const parts = f.path.replace(/\\/g, "/").split("/").filter(Boolean);
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!node.dirs.has(parts[i])) node.dirs.set(parts[i], { name: parts[i], dirs: new Map(), files: [] });
      node = node.dirs.get(parts[i]);
    }
    node.files.push(f);
  }
  return root;
}

function renderFileTree() {
  const wrap = $("file-tree");
  const files = state.files?.files ?? [];
  if (!files.length) { wrap.innerHTML = `<div class="oc-empty">Нет файлов (или проект не читается)</div>`; return; }
  const modified = new Set((state.diff?.files ?? []).map((f) => f.path.replace(/\\/g, "/")));
  const node = (n, depth) => {
    const out = [];
    for (const [name, sub] of [...n.dirs].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (IGNORE_DIRS.has(name) || name.startsWith(".smoke")) continue;
      const open = state.expanded.has(`d:${name}`) || depth < 1;
      out.push(`<div><button class="oc-ft-row" data-dir="${esc(name)}">
        <span class="oc-dir-toggle ${open ? "oc-dir-toggle--open" : ""}">▸</span>
        <span class="oc-ft-row__name">${esc(name)}</span></button>
        <div class="oc-ft-children ${open ? "" : "hidden"}">${node(sub, depth + 1)}</div></div>`);
    }
    for (const f of n.files.sort((a, b) => a.path.localeCompare(b.path))) {
      if (IGNORE_FILES.has(f.path.replace(/\\/g, "/").split("/").pop() ?? "")) continue;
      const isMod = modified.has(f.path.replace(/\\/g, "/"));
      out.push(`<button class="oc-ft-row ${isMod ? "oc-file--modified" : ""}" data-open="${esc(f.path)}" title="${esc(f.path)}">
        ${isMod ? `<span class="oc-file__dot"></span>` : `<span style="width:6px"></span>`}
        <span class="oc-ft-row__name">${esc(f.path.split(/[\\/]/).pop())}</span>
        <span class="oc-ft-row__dir">${esc(f.path.split(/[\\/]/).slice(0, -1).join("/"))}</span></button>`);
    }
    return out.join("");
  };
  const root = buildTree(files);
  const html = node(root, 0);
  // Дерево перерисовывается по таймеру опроса: setHTML пишет только при
  // изменении (полное сравнение — прежняя подпись «длина + начало» пропускала
  // отметку изменённого файла в середине дерева).
  setHTML(wrap, html);
}

async function openFileView(path) {
  // содержимое — по центру основного окна (отдельный вид), дерево файлов
  // справа остаётся на месте; повторный клик по другому файлу просто
  // подменяет содержимое — закрывать предыдущий не нужно.
  try {
    const r = await api(`/sessions/${state.current}/file?path=${encodeURIComponent(path)}`);
    const size = r.size ? `${(r.size / 1024).toFixed(1)} КБ` : "";
    openCenter({
      title: path,
      meta: [size, r.truncated ? "обрезано" : ""].filter(Boolean).join(" · "),
      fileText: r.content ?? "",
      truncated: r.truncated,
    });
  } catch (e) { toast(String(e.message ?? e), "err"); }
}

function closeFileView() {
  setView(state.viewBeforeFile ?? "chat");
  state.viewBeforeFile = null;
}

/** Видимость правой панели и её свёрнутость отражаются в сетке приложения:
 *  скрытая панель не оставляет пустой колонки, свёрнутая — узкий рельс. */
function syncRightLayout() {
  const hidden = $("right-panel").classList.contains("hidden");
  $("app").classList.toggle("oc-app--noright", hidden);
  $("app").classList.toggle("oc-app--rightmini", !hidden && !!state.rightMini);
}
function setRightMini(mini) {
  state.rightMini = !!mini;
  try { localStorage.setItem("dirigo-right", mini ? "mini" : ""); } catch { /* приватный режим */ }
  syncRightLayout();
}

function setRightTab(tab) {
  state.rightTab = tab;
  $("rtab-changes").classList.toggle("oc-rtab--active", tab === "changes");
  $("rtab-files").classList.toggle("oc-rtab--active", tab === "files");
  $("rtab-term").classList.toggle("oc-rtab--active", tab === "term");
  $("rpane-changes").classList.toggle("hidden", tab !== "changes");
  $("rpane-files").classList.toggle("hidden", tab !== "files");
  $("rpane-term").classList.toggle("hidden", tab !== "term");
  if (tab === "term") renderTermList();
}

/* ═══════════ ПОДТВЕРЖДЕНИЕ В DOM ═══════════
   Вместо window.confirm: нативный диалог рисует браузер — его не видно в
   записи и в headless-проверках, и текст нельзя оформить (находки шлюза PII
   были одним абзацем через \n). Первый абзац — заголовок, строки вида
   «файл: строки 1, 2» — списком. Enter — подтвердить, Esc — отмена. */
function ocConfirm(message, opts = {}) {
  return new Promise((resolve) => {
    document.getElementById("oc-confirm")?.remove();
    const paras = String(message ?? "").split(/\n{2,}/);
    const title = opts.title ?? (paras.shift() ?? "");
    const body = paras.map((p) => {
      const lines = p.split("\n").filter(Boolean);
      if (lines.length && lines.every((l) => /^[^:]+: (строки|lines) [\d, ]+$/.test(l))) {
        return `<ul class="oc-confirm__files">${lines.map((l) => { const i = l.indexOf(": "); return `<li><b>${esc(l.slice(0, i))}</b>: ${esc(l.slice(i + 2))}</li>`; }).join("")}</ul>`;
      }
      return `<p>${lines.map(esc).join("<br>")}</p>`;
    }).join("");
    const wrap = document.createElement("div");
    wrap.id = "oc-confirm";
    wrap.className = "oc-confirm";
    wrap.innerHTML = `<div class="oc-confirm__box" role="dialog" aria-modal="true" aria-labelledby="oc-confirm-title">
      <div class="oc-confirm__title" id="oc-confirm-title">${esc(title).replace(/\n/g, "<br>")}</div>
      ${body ? `<div class="oc-confirm__body">${body}</div>` : ""}
      <div class="oc-confirm__acts">
        <button class="oc-btn" data-oc-confirm="cancel">${esc(opts.cancel ?? tr("Отмена"))}</button>
        <button class="oc-btn ${opts.danger ? "oc-btn--danger" : "oc-btn--primary"}" data-oc-confirm="ok">${esc(opts.ok ?? tr("Продолжить"))}</button>
      </div></div>`;
    const done = (v) => { document.removeEventListener("keydown", onKey, true); wrap.remove(); resolve(v); };
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(false); }
      else if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); done(true); }
    };
    wrap.addEventListener("click", (e) => {
      const b = e.target.closest("[data-oc-confirm]");
      if (b) done(b.dataset.ocConfirm === "ok");
      else if (e.target === wrap) done(false);
    });
    document.addEventListener("keydown", onKey, true);
    document.body.appendChild(wrap);
    wrap.querySelector('[data-oc-confirm="ok"]')?.focus();
  });
}

/* ═══════════ ДЕЙСТВИЯ СЕССИИ ═══════════ */
/** Политика PII остановила применение/коммит: показать, что и где найдено,
 *  и дать осознанно продолжить (исключение тоже попадёт в журнал). */
async function piiOverrideConfirm(e) {
  const pol = e?.data?.policy;
  if (!e?.data?.needsPiiOverride || !pol) return false;
  const where = (pol.files ?? []).slice(0, 5).map((f) => `${f.path}: строки ${(f.lines ?? []).slice(0, 6).join(", ")}`).join("\n");
  return ocConfirm(`${pol.summary}\n\n${where}\n\nПродолжить всё равно? Исключение будет записано в журнал доказательств.`, { ok: tr("Продолжить с исключением"), cancel: tr("Остановить"), danger: true });
}

async function applyChanges(allowPii = false) {
  if (!state.current) return;
  try {
    const r = await api(`/sessions/${state.current}/apply`, { method: "POST", body: { confirmed: true, allowPii } });
    toast(r.ok ? `Применено: ${r.detail}` : `Не применено: ${r.detail ?? r.error}`, r.ok ? "ok" : "err");
    loadDiff(); refreshCurrent();
  } catch (e) {
    if (!allowPii && await piiOverrideConfirm(e)) return applyChanges(true);
    toast(String(e.message ?? e), "err");
  }
}

async function revertChanges() {
  if (!state.current) return;
  try {
    const r = await api(`/sessions/${state.current}/revert`, { method: "POST", body: { confirmed: true } });
    toast(r.ok ? `Возвращено: ${r.detail}` : `Не возвращено: ${r.detail ?? r.error}`, r.ok ? "ok" : "err");
    loadDiff(); refreshCurrent();
  } catch (e) { toast(String(e.message ?? e), "err"); }
}
/* ═══════════ ДЕЙСТВИЯ СЕССИИ ═══════════ */
/** Текст последнего отказа запуска — чтобы модалка показала его в своей форме. */
let lastStartError = "";

async function startSession(agentId, projectId, mode, prompt, worktree = false, extra = {}) {
  lastStartError = "";
  try {
    const s = await api("/sessions", { method: "POST", body: { agentId, projectId, mode, prompt, worktree, ...extra } });
    toast(`Сессия «${s.title ?? shortTitle(s)}» запущена`);
    openSession(s.id);
    loadAll();
    return true;
  } catch (e) {
    lastStartError = e?.fix ? `${e.message} — ${e.fix}` : String(e.message ?? e);
    toast(lastStartError, "err");
    return false;
  }
}

async function sendPrompt() {
  const text = $("prompt").value.trim();
  if (!text || !state.current) return;
  const s = state.sessions.find((x) => x.id === state.current);
  // Поле ввода одно, а назначений у него четыре. Раньше оно всегда било в
  // /continue, и в ACP/PTY-сессии пользователь получал «продолжение доступно
  // только для cli-сессий» — ошибку, которую он никак не мог предотвратить.
  if (s?.mode === "web") {
    toast("Это веб-панель агента — пишите задачу прямо в ней (кнопка «Открыть»)", "err");
    return;
  }
  // «/model» в живом диалоге — выбор модели пульта (если агент не объявил свою команду)
  if ((s?.mode === "persistent" || s?.persistent) && /^\/model\s*$/i.test(text)) {
    $("prompt").value = "";
    void pickAcpModel(state.current);
    return;
  }
  $("prompt").value = "";
  // ACP и терминал принимают сообщение в живую сессию; CLI с известным id
  // сессии агента — продолжает диалог новой сессией; иначе просто перезапуск.
  const live = s?.mode === "pty" || s?.mode === "persistent" || s?.persistent;
  const canContinue = s?.mode === "cli" && !!s?.externalRef;
  try {
    if (live) {
      await api(`/sessions/${state.current}/messages`, { method: "POST", body: { text } });
      toast(s?.mode === "pty" ? "Отправлено в терминал" : "Отправлено агенту");
    } else if (canContinue) {
      await api(`/sessions/${state.current}/continue`, { method: "POST", body: { prompt: text } });
      toast("Продолжение диалога — создана связанная сессия");
    } else {
      await api(`/sessions/${state.current}/messages`, { method: "POST", body: { text } });
      toast("Задача отправлена агенту");
    }
    refreshCurrent();
  } catch (e) {
    $("prompt").value = text; // текст не теряем: пользователь его диктовал
    toast(String(e.message ?? e), "err");
  }
}

async function gitAction(action, extra = {}) {
  if (!state.current) return;
  try {
    const r = await api(`/sessions/${state.current}/git`, { method: "POST", body: { action, ...extra } });
    if (r.ok && r.evidence) {
      const n = r.evidence.pii?.findings ?? 0;
      toast(`git ${action}: ${r.detail} · пакет доказательств ${r.evidence.packId}${n ? ` · PII: ${n}` : ""}`, n ? "err" : "ok");
    } else if (r.ok) toast(`git ${action}: ${r.detail}`, "ok");
    else if (r.url) { toast(`${r.detail}`, "err"); console.log("URL:", r.url); }
    else toast(`git ${action}: ${r.detail}`, "err");
    loadDiff(); refreshCurrent();
  } catch (e) {
    if (!extra.allowPii && await piiOverrideConfirm(e)) return gitAction(action, { ...extra, allowPii: true });
    toast(String(e.message ?? e), "err"); if (e.data?.needsGitInit) loadDiff();
  }
}

async function gitInitProject(projectId) {
  if (!projectId) return;
  if (!(await ocConfirm("Создать собственный git-репозиторий проекта? Текущие файлы попадут в первый коммит-снимок.", { ok: tr("Создать git") }))) return;
  try {
    const r = await api(`/projects/${projectId}/git-init`, { method: "POST" });
    toast(r.detail ?? "git проекта создан", "ok");
  } catch (e) { toast(String(e.message ?? e), "err"); }
  loadDiff();
}

async function runChecks() {
  if (!state.current) return;
  try {
    const r = await api(`/sessions/${state.current}/checks`, { method: "POST" });
    toast(r.ok ? `Проверки пройдены · ${(r.durationMs / 1000).toFixed(1)} с` : `Проверки: ${r.detail}`, r.ok ? "ok" : "err");
    loadChecks(); refreshCurrent();
  } catch (e) { toast(String(e.message ?? e), "err"); }
}

async function stopSession() {
  if (!state.current) return;
  try { await api(`/sessions/${state.current}/stop`, { method: "POST" }); toast("Остановлено"); loadAll(); } catch (e) { toast(String(e.message ?? e), "err"); }
}

/* ═══════════ ДОСКА ═══════════ */
async function loadBoard(opts = {}) {
  const boardWrap = $("board-cols");
  // Опрос раз в 5 с: заглушка «загружаем доску…» и сброс подписи давали
  // мигание всей доски. Перерисовка — только если данные изменились.
  if (!opts.poll) {
    delete boardWrap.dataset.sig;
    delete boardWrap.dataset.sigHead;
    boardWrap.innerHTML = `<div class="oc-empty" style="grid-column:1/-1">загружаем доску…</div>`;
  }
  try {
    state.boardProject = $("board-project").value ?? "";
    const proj = state.boardProject;
    const q = proj ? `?project=${encodeURIComponent(proj)}` : "";
    const [plans, swarms, fusions] = await Promise.all([
      api(`/plans${q}`).catch(() => []),
      api(`/swarm${q}`).catch(() => []),
      api(`/fusion${q}`).catch(() => []),
    ]);
    state.plans = plans; state.fusions = fusions;
    state.swarms = swarms;
    // сессии держим свежими: доска должна показывать актуальные статусы
    state.sessions = await api("/sessions").catch(() => state.sessions);
    renderBoard();
  } catch (e) {
    delete $("board-cols").dataset.sig;
    delete $("board-cols").dataset.sigHead;
    $("board-cols").innerHTML = `<div class="oc-empty" style="grid-column:1/-1">${esc(String(e.message ?? e))}</div>`;
  }
}

function renderBoard() {
  // Колонки однозначно определяются состоянием: todo < doing < review < done.
  // ВСЕ сущности роя видны: планы, рои, fusion И обычные сессии (F6) —
  // неизвестный статус всегда попадает в «Ожидают», задача не теряется.
  const cols = [
    { key: "todo", title: "Ожидают", states: ["pending", "idle", "draft", "judging", "waiting", "new", "queued", "blocked", "stopped"] },
    { key: "doing", title: "В работе", states: ["running", "working", "planning", "queued-active"] },
    { key: "review", title: "Ревью и merge", states: ["verifying", "review", "ready", "done"] },
    { key: "finish", title: "Готово", states: ["applied", "complete", "finished", "merged", "error"] },
  ];
  const allStates = new Set(cols.flatMap((c) => c.states));
  const tasks = [];
  for (const p of (state.plans ?? [])) tasks.push({ title: p.goal, branch: `${p.done}/${p.epics} эпиков`, state: p.status ?? "todo", kind: "plan", id: p.id });
  for (const s of (state.swarms ?? [])) tasks.push({ title: s.title, branch: s.branch ?? "—", state: s.state ?? s.status ?? "todo", kind: "swarm", id: s.id });
  for (const f of (state.fusions ?? [])) tasks.push({ title: f.question ?? f.title, branch: f.branch ?? "—", state: f.state ?? f.status ?? "todo", kind: "fusion", id: f.id });
  // сессии пользователя — тоже задачи доски
  for (const s of (state.sessions ?? [])) {
    if (state.boardProject && s.projectId && !state.projects.some((p) => p.path === state.boardProject && p.id === s.projectId)) continue;
    tasks.push({
      title: s.title ?? "Без названия",
      branch: agentName(s.agentId),
      state: s.status ?? "idle",
      kind: "session",
      id: s.id,
    });
  }
  const boardHtml = cols.map((c) => {
    // колонка «Ожидают» — приёмник по умолчанию: сюда попадает всё неразмеченное
    const items = tasks.filter((t) => c.states.includes(t.state) || (c.key === "todo" && !allStates.has(t.state)));
    return `<div class="oc-col"><div class="oc-col__head">${c.title}<span class="oc-col__count">${items.length}</span></div>
      <div class="oc-col__body">${items.length ? items.map((t) => `
        <button class="oc-card-task" data-taskkind="${t.kind}" data-taskid="${esc(t.id)}" title="${esc(t.title)}">
          <div class="oc-card-task__title">${esc(t.title)}</div>
          <div class="oc-card-task__meta"><span class="oc-card-task__branch">${esc(t.branch ?? "—")}</span><span>${esc(t.kind)}</span></div>
        </button>`).join("") : `<div class="oc-empty">пусто</div>`}</div></div>`;
  }).join("");
  const board = $("board-cols");
  // полное сравнение: «длина + первые 160 символов» пропускало изменения в середине доски
  if (board.dataset.sig === "1" && lastHTML.get(board) === boardHtml) return;
  board.dataset.sig = "1";
  board.innerHTML = boardHtml;
  lastHTML.set(board, boardHtml);
}

/** Настройки шлюза персональных данных и базы знаний. */
/** Обработчик через присваивание: функции привязки зовутся на каждое открытие
 *  вида, и addEventListener копил дубликаты (одно действие срабатывало N раз). */
function onEl(id, prop, fn) { const el = $(id); if (el) el[prop] = fn; }

async function bindGovernance() {
  // Значения полей ДО загрузки: ответы приходят асинхронно, и если человек уже
  // что-то ввёл или нажал «Подставить адрес», загрузка не должна это стереть.
  const before = {};
  for (const id of ["pii-terms", "kn-url", "kn-project"]) before[id] = $(id)?.value ?? "";
  const beforeChecked = $("kn-enabled")?.checked;
  const fillIfUntouched = (id, value) => { const el = $(id); if (el && !el.dataset.dirty) el.value = value; };
  const termsBefore = before["pii-terms"];
  // Загрузка — в фоне, БЕЗ await: обработчики кнопок ниже должны быть привязаны
  // сразу. Раньше «Сохранить» получал обработчик только после ответа сервера,
  // и быстрый клик уходил в пустоту.
  api("/policy").then((pol) => {
    if ($("pii-mode")) $("pii-mode").value = pol.policy?.mode ?? "warn";
    // поле не перезаписываем, если пользователь уже начал печатать
    if ($("pii-terms") && !$("pii-terms").dataset.dirty) $("pii-terms").value = (pol.policy?.terms ?? []).join("\n");
  }).catch(() => { /* демон не ответил — оставляем как есть */ });
  onEl("pii-mode", "onchange", async () => {
    try {
      const r = await api("/policy", { method: "POST", body: { mode: $("pii-mode").value } });
      toast(`${tr("Шлюз")}: ${r.policy.mode}`);
    } catch (e) { toast(String(e.message ?? e), "err"); }
  });
  onEl("pii-terms", "oninput", () => { $("pii-terms").dataset.dirty = "1"; });
  onEl("pii-terms-save", "onclick", async () => {
    try {
      const r = await api("/policy", { method: "POST", body: { terms: $("pii-terms").value } });
      $("pii-terms").value = (r.policy.terms ?? []).join("\n");
      delete $("pii-terms").dataset.dirty;
      toast(`${tr("Свои слова")}: ${(r.policy.terms ?? []).length}`);
    } catch (e) { toast(String(e.message ?? e), "err"); }
  });
  onEl("pii-check", "onclick", async () => {
    const text = $("pii-sample").value;
    if (!text) return;
    try {
      const r = await api("/policy/scan", { method: "POST", body: { text } });
      $("pii-result").textContent = r.summary;
    } catch (e) { $("pii-result").textContent = String(e.message ?? e); }
  });

  api("/knowledge").then((kn) => {
    const k = kn.knowledge ?? {};
    if ($("kn-enabled") && $("kn-enabled").checked === beforeChecked) $("kn-enabled").checked = !!k.enabled;
    fillIfUntouched("kn-url", k.url ?? "");
    fillIfUntouched("kn-project", k.project ?? "");
    // ключ наружу не отдаётся: показываем только факт, что он задан
    if ($("kn-key")) $("kn-key").placeholder = k.apiKey === "set" ? "••••••• (задан)" : "cnx_…";
  }).catch(() => { /* см. выше */ });
  // Сохранить то, что сейчас в полях (и «Проверить связь» проверяет именно это)
  const saveKn = async () => {
    const body = {
      enabled: $("kn-enabled").checked,
      url: $("kn-url").value.trim(),
      project: $("kn-project").value.trim(),
    };
    const key = $("kn-key").value.trim();
    if (key) body.apiKey = key;
    const r = await api("/knowledge", { method: "POST", body });
    for (const id of ["kn-url", "kn-project"]) delete $(id).dataset.dirty;
    $("kn-key").value = "";
    $("kn-key").placeholder = r.knowledge?.apiKey === "set" ? "••••••• (задан)" : "cnx_…";
  };
  onEl("kn-coally", "onclick", () => { $("kn-url").value = "https://coally.cortexally.ai/mcp"; $("kn-url").dataset.dirty = "1"; $("kn-key").focus(); });
  onEl("kn-search", "onclick", async () => {
    const q = $("kn-query").value.trim();
    if (!q) return;
    const out = $("kn-out");
    out.hidden = false; out.textContent = tr("ищем…");
    try {
      await saveKn();
      const r = await api("/knowledge/search", { method: "POST", body: { query: q } });
      out.textContent = r.ok ? (r.text || tr("ничего не найдено")) : (r.detail ?? tr("не получилось"));
    } catch (e) { out.textContent = String(e.message ?? e); }
  });
  // Подключение CoAlly к агентам машины: статус по каждому агенту
  const AG_STATE = { added: "добавлен", updated: "обновлён", present: "подключён", removed: "убран", absent: "не подключён", "not-installed": "не установлен", "session-only": "в сессиях пульта", error: "ошибка" };
  const renderAgents = (list) => setHTML($("kn-agents"), (list ?? []).map((a) => `<div class="oc-kn-agent oc-kn-agent--${esc(a.state)}" title="${esc(a.where ?? "")}">
      <span class="oc-kn-agent__name">${esc(a.label)}</span>
      <span class="oc-kn-agent__state">${esc(AG_STATE[a.state] ?? a.state)}</span>
      <span class="oc-kn-agent__detail">${esc(a.state === "error" || a.state === "session-only" ? a.detail : (a.verified ? "проверено агентом" : ""))}</span>
    </div>`).join(""));
  api("/knowledge/agents").then((r) => renderAgents(r.agents)).catch(() => { /* демон старый — блок пустой */ });
  const agentsAction = async (action) => {
    setHTML($("kn-agents"), `<div class="muted small">${tr("подключаем…")}</div>`);
    try {
      if (action === "install") await saveKn();
      const r = await api("/knowledge/agents", { method: "POST", body: { action } });
      renderAgents(r.agents);
      const n = (r.agents ?? []).filter((a) => ["added", "updated", "present", "removed"].includes(a.state)).length;
      toast(action === "install" ? `CoAlly подключён к агентам: ${n}` : `CoAlly убран у агентов: ${n}`, r.ok ? "ok" : "err");
    } catch (e) { toast(String(e.message ?? e), "err"); api("/knowledge/agents").then((r) => renderAgents(r.agents)).catch(() => {}); }
  };
  onEl("kn-agents-add", "onclick", () => agentsAction("install"));
  onEl("kn-agents-remove", "onclick", () => agentsAction("remove"));
  onEl("kn-save", "onclick", async () => {
    try { await saveKn(); toast(tr("Сохранено")); } catch (e) { toast(String(e.message ?? e), "err"); }
  });
  onEl("kn-test", "onclick", async () => {
    $("kn-result").textContent = tr("проверяем…");
    try {
      await saveKn();
      const r = await api("/knowledge/test", { method: "POST", body: {} });
      const res = r.result ?? {};
      $("kn-result").textContent = res.ok ? (res.detail ?? tr("связь есть")) : (res.skipped ?? res.detail ?? tr("не отправилось"));
      $("kn-result").classList.toggle("oc-kn-ok", !!res.ok);
    } catch (e) { $("kn-result").textContent = String(e.message ?? e); }
  });
}

/* ═══════════ ДОКАЗАТЕЛЬСТВА ПРОИСХОЖДЕНИЯ ═══════════
   Пакет собирается при каждом «Применить»: кто из агентов писал, какая модель,
   какие проверки прошли, сколько раз работа возвращалась агенту, кто одобрил и
   каким коммитом это легло. Здесь всё это видно и выгружается одним файлом. */
async function loadEvidence() {
  const pane = $("evidence-pane");
  try {
    const r = await api("/evidence");
    const packs = r.packs ?? [];
    $("ev-summary").textContent = packs.length ? packCount(packs.length) : tr("пока пусто");
    if (!packs.length) {
      pane.innerHTML = `<div class="oc-empty">${tr("Пока нет применённых изменений — пакеты появятся после первого «Применить».")}</div>`;
      return;
    }
    pane.innerHTML = packs.slice().reverse().map((p) => {
      const sealOk = p.signed && p.ledgerIntact;
      return `<div class="oc-evcard">
        <div class="oc-evcard__top">
          <span class="oc-evcard__title">${esc(p.task ?? "задача")}</span>
          <span class="oc-chip oc-chip--mono" title="${p.trigger === "committed" ? esc(tr("Пакет создан коммитом")) : esc(tr("Пакет создан «Применить в проект»"))}">${p.trigger === "committed" ? tr("коммит") : tr("применение")}</span>
          <span class="oc-evseal ${sealOk ? "" : "oc-evseal--bad"}">${sealOk ? "✓ " + tr("подпись и журнал целы") : "✕ " + tr("нарушено")}</span>
          <span class="oc-evcard__meta">${new Date(p.producedAt).toLocaleString()}</span>
        </div>
        <div class="oc-evrow">
          <span>${tr("Агент")}: <b>${esc(p.agent ?? "—")}</b></span>
          <span>${tr("Модель")}: <b>${esc(p.model ?? "—")}</b></span>
          <span>${tr("Проверки")}: <b>${p.checksOk}/${p.checks}</b></span>
          <span>${tr("Возвратов агенту")}: <b>${p.returnedToAgent}</b></span>
          <span>${tr("Файлов")}: <b>${p.files}</b></span>
          <span>${tr("Одобрил")}: <b>${esc(p.approvedBy ?? "—")}</b></span>
          ${p.pii ? `<span title="${esc(tr("Шлюз персональных данных: задача, сообщения и строки, добавленные агентом"))}">PII: <b class="${p.pii.findings ? "oc-evwarn" : ""}">${p.pii.findings}</b>${p.pii.inChanges ? ` (${tr("в изменениях")}: ${p.pii.inChanges})` : ""}${p.pii.overridden ? ` · <b class="oc-evwarn">${tr("применено вопреки политике")}</b>` : ""}</span>` : ""}
        </div>
        <div class="oc-evchain">${esc(p.packId)}${p.commit ? " · commit " + esc(String(p.commit).slice(0, 10)) : ""} · ${esc(p.project ?? "")}</div>
      </div>`;
    }).join("");
  } catch (e) {
    pane.innerHTML = `<div class="oc-empty">${esc(String(e.message ?? e))}</div>`;
  }
}

/** Счётчик пакетов на текущем языке: в EN склонений нет. */
function packCount(n) {
  return lang === "ru" ? `${n} ${plural(n, "пакет", "пакета", "пакетов")}` : `${n} pack${n === 1 ? "" : "s"}`;
}

/** Простое склонение для счётчиков. */
function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}

/* ═══════════ ИСТОРИЯ ═══════════ */
function loadHistorySelects() {
  for (const id of ["history-project", "board-project"]) {
    const sel = $(id);
    if (!sel) continue;
    // V6.13: сохраняем выбор — фоновая перезагрузка списка проектов сбрасывала его
    const keep = sel.value;
    sel.innerHTML = '<option value="">Все проекты</option>' + state.projects.map((p) => `<option value="${esc(p.path)}">${esc(p.name)}</option>`).join("");
    if (keep && [...sel.options].some((o) => o.value === keep)) sel.value = keep;
  }
}

async function loadHistory() {
  const proj = $("history-project").value;
  if (!proj) { $("history-pane").innerHTML = `<div class="oc-empty">Выберите проект — покажу историю версий</div>`; return; }
  try {
    const h = await api(`/history?project=${encodeURIComponent(proj)}`);
    state.history = h;
    renderHistory();
  } catch (e) { $("history-pane").innerHTML = `<div class="oc-empty">${esc(String(e.message ?? e))}</div>`; }
}

function renderHistory() {
  const h = state.history;
  if (!h?.commits?.length) { $("history-pane").innerHTML = `<div class="oc-empty">История пуста (не git-репозиторий?)</div>`; return; }
  const groups = new Map();
  const day = (ts) => new Date(ts * 1000).toLocaleDateString(dateLoc(), { day: "numeric", month: "long" });
  for (const c of h.commits) {
    const g = day(c.time);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(c);
  }
  $("history-pane").innerHTML = [...groups].map(([g, items]) => `
    <div class="oc-hist__group"><div class="oc-hist__ghead">${esc(g)} <span style="color:var(--text-faint)">${esc(h.branch ?? "")}</span></div>
    ${items.map((c) => `<div>
      <button class="oc-hist__row ${c.sha === h.head ? "oc-hist__row--current" : ""}" data-sha="${esc(c.sha)}">
        ${statusMark({ status: c.sha === h.head ? "done" : "idle" })}
        <span style="min-width:0;flex:1">
          <span class="oc-hist__msg">${esc(c.message)}</span>
          <span class="oc-hist__meta">
            <span class="oc-hist__sha">${esc(c.sha.slice(0, 7))}</span>
            <span class="oc-hist__branch">${esc(c.branch ?? h.branch ?? "")}</span>
            ${c.tags?.length ? `<span style="color:var(--accent)">${c.tags.map(esc).join(" ")}</span>` : ""}
            <span>${fmtAgo(c.time * 1000)} · ${c.files ?? 0} файлов</span>
          </span>
        </span>
      </button>
      ${state.histOpenSha === c.sha ? commitDetail(c) : ""}
    </div>`).join("")}</div>`).join("");
}

function commitDetail(c) {
  const files = c.changes ?? [];
  return `<div class="oc-hist__detail">
    <div class="oc-rp__glabel">Что изменилось в версии ${esc(c.sha.slice(0, 7))}</div>
    ${files.length ? files.map((f) => `<div class="oc-file"><span class="oc-file__path">${esc(f.path)}</span><span class="oc-file__delta"><span class="add">+${f.added}</span>${f.deleted ? ` <span class="del">−${f.deleted}</span>` : ""}</span></div>`).join("") : `<div class="oc-empty">нет данных о файлах</div>`}
    <div class="oc-hist__acts">
      <button class="oc-btn" data-act="restore" data-sha="${esc(c.sha)}" title="Откатить рабочий проект к этой версии">Вернуть проект к этой версии</button>
      <button class="oc-btn" data-act="diff" data-sha="${esc(c.sha)}">Показать дифф</button>
    </div></div>`;
}

async function restoreTo(sha) {
  const proj = $("history-project").value;
  if (!(await ocConfirm(`Вернуть проект к версии ${sha.slice(0, 7)}? Текущие незакоммиченные изменения будут сохранены в stash.`, { ok: tr("Вернуть") }))) return;
  try {
    const r = await api("/history/restore", { method: "POST", body: { project: proj, sha } });
    toast(r.detail ?? "Проект возвращён к версии", "ok");
    loadHistory();
  } catch (e) { toast(String(e.message ?? e), "err"); }
}

/* ═══════════ СТАТИСТИКА ═══════════ */
async function loadStats() {
  try {
    // /api/usage: {total, sessions:[{sessionId,agentId,title,status,tokens,mentions}]}
    const u = await api("/usage");
    const sessions = u.sessions ?? [];
    const byAgent = new Map();
    for (const s of sessions) byAgent.set(s.agentId, (byAgent.get(s.agentId) ?? 0) + (s.tokens ?? 0));
    const models = [...byAgent.entries()].sort((a, b) => b[1] - a[1]);
    const total = u.total ?? models.reduce((s, [, v]) => s + v, 0);
    const colors = ["var(--accent)", "var(--mode-swarm)", "var(--mode-fusion)", "var(--mode-orchestrator)", "var(--mode-solo)", "var(--warn)"];
    // «недельное окно»: сессии за последние 7 дней, сгруппированные по дню
    const days = new Map();
    for (let i = 6; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000);
      days.set(d.toLocaleDateString(dateLoc(), { day: "numeric", month: "short" }), 0);
    }
    for (const s of sessions) {
      if (s.tokens && s.at) {
        const key = new Date(s.at).toLocaleDateString(dateLoc(), { day: "numeric", month: "short" });
        if (days.has(key)) days.set(key, (days.get(key) ?? 0) + s.tokens);
      }
    }
    const week = [...days.entries()].map(([label, tokens]) => ({ label, tokens }));
    const series = (values) => {
      if (!values.length) return `<div class="oc-empty">нет данных</div>`;
      const max = Math.max(...values.map((v) => v.tokens), 1);
      return `<div style="display:flex;align-items:flex-end;gap:5px;height:64px;margin-top:10px">${values.map((v) => `
        <div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:4px" title="${v.tokens.toLocaleString("ru")} токенов">
          <div style="width:100%;background:var(--accent);border-radius:4px 4px 2px 2px;height:${Math.max(3, (v.tokens / max) * 56)}px;opacity:.85"></div>
          <span style="font-size:9px;color:var(--text-faint)">${esc(v.label)}</span>
        </div>`).join("")}</div>`;
    };
    $("stats-pane").innerHTML = `
      <div class="oc-stat"><div class="oc-stat__label">Расход за всё время</div><div class="oc-stat__value">${total.toLocaleString("ru")} <span style="font-size:12px;color:var(--text-faint)">токенов${sessions.some((s) => s.source === "est" || s.source === "text") ? " ≈" : ""}</span></div>
        <div class="oc-stat__label" style="margin-top:6px">сессий: ${sessions.length}</div></div>
      <div class="oc-stat"><div class="oc-stat__label">По моделям</div>
        ${models.length ? `<div class="oc-usage-bar">${models.map(([m, v], i) => `<div class="oc-usage-bar__seg" style="width:${((v / (total || 1)) * 100).toFixed(1)}%;background:${colors[i % colors.length]}"></div>`).join("")}</div>
        <div class="oc-usage-legend">${models.map(([m, v], i) => `<span><span class="oc-usage-legend__dot" style="background:${colors[i % colors.length]}"></span>${esc(m)} — ${v.toLocaleString("ru")}</span>`).join("")}</div>` : `<div class="oc-empty">нет данных</div>`}
      </div>
      <div class="oc-stat"><div class="oc-stat__label">За неделю</div>${series(week)}</div>`;
  } catch (e) { $("stats-pane").innerHTML = `<div class="oc-empty">${esc(String(e.message ?? e))}</div>`; }
}

/* ═══════════ НАСТРОЙКИ — полный порт v2 (V5.1): среда/агенты/ключи/удалёнка ═══════════ */
const setup = { step: "env", picked: new Set(), env: null, keys: [] };
let envJobs = [];
let machines = [];
let tunnelState = null;

function switchSetupStep(step) {
  setup.step = step;
  for (const el of document.querySelectorAll(".setup-step")) el.classList.toggle("active", el.dataset.step === step);
  for (const el of document.querySelectorAll(".setup-pane")) el.classList.toggle("active", el.dataset.pane === step);
  if (step === "env") refreshEnv();
  else if (step === "agents") refreshSetupAgents();
  else if (step === "keys") refreshKeys();
  else refreshMachines();
}

const eRow = (name, item, hint) => `<div class="env-row"><b>${esc(name)}</b><span class="muted small">${esc(item?.path ?? hint)}</span><span class="e-state ${item?.ok ? "ok" : "miss"}">${item?.ok ? (item.version ? esc(item.version) : "есть") : "нет"}</span></div>`;

async function refreshEnv() {
  const box = $("env-check");
  box.innerHTML = `<div class="oc-empty">проверяем…</div>`;
  try {
    setup.env = await api("/setup/env");
    const e = setup.env;
    box.innerHTML =
      eRow("Bun", e.bun, "рантайм демона и агентов") +
      eRow("git", e.git, "копии проектов (worktree)") +
      eRow("npm", e.npm, "установка агентов") +
      eRow("ssh", e.ssh, "удалённые машины и туннели") +
      eRow("cloudflared", e.cloudflared, "публичный URL без SSH-ключа");
    $("env-fix").disabled = false;
  } catch (e) {
    box.innerHTML = `<div class="oc-ns__err">Не удалось проверить среду: ${esc(String(e.message ?? e))}</div>`;
  }
}

async function refreshSetupAgents() {
  $("setup-summary").textContent = "проверяем…";
  $("setup-agents").innerHTML = `<div class="oc-empty">проверяем агентов…</div>`;
  try {
    const [agents, jobs] = await Promise.all([api("/setup/agents"), api("/setup/jobs")]);
    envJobs = jobs ?? [];
    const installed = agents.filter((a) => a.state === "installed").length;
    const missing = agents.filter((a) => a.state === "missing").length;
    const needsAuth = agents.filter((a) => a.state === "needs-auth").length;
    $("setup-summary").textContent = `всего ${agents.length} · установлено ${installed} · не хватает ${missing}${needsAuth ? ` · нужно авторизовать ${needsAuth}` : ""}`;
    $("setup-agents").innerHTML = agents.length ? agents.map((a) => `
      <div class="setup-agent ${a.state === "missing" ? "sa-picked" : ""}">
        <div class="sa-row">
          <input type="checkbox" class="sa-check" data-agent="${esc(a.id)}" ${a.state === "installed" ? "disabled" : "checked"} title="${a.state === "installed" ? "уже установлен" : "выбрать для установки"}" />
          <span class="sa-name">${esc(a.label ?? a.id)}</span>
          <span class="sa-state ${a.state}">${a.state === "installed" ? "готов" : a.state === "missing" ? "нет" : a.state === "needs-auth" ? "нужен вход" : esc(a.state)}</span>
          <span class="sa-actions">${a.signedIn ? `<span class="muted small" title="Агент вошёл в аккаунт — ключ не нужен">вход выполнен</span>` : a.envVar && !a.keySet ? `<span class="muted small" title="Ключ задаётся на шаге 3">ключ: ${esc(a.envVar)}</span>` : ""}</span>
        </div>
        <div class="sa-meta">${a.version ? "версия: " + esc(a.version) + " · " : ""}${a.path ? esc(a.path) : ""}${a.authHint ? (a.path ? " · " : "") + esc(a.authHint) : ""}${a.keyUrl ? ` · ${esc(a.keyUrl)}` : ""}</div>
        ${(a.modes ?? []).length ? `<div class="sa-modes">${a.modes.map((m) => `<span class="sa-mode ${m.available ? "ok" : "no"}" title="${esc(m.available ? tr("доступен") : trServer(m.reason ?? "") + (m.fix ? " — " + trServer(m.fix) : ""))}">${m.available ? "✓" : "✗"} ${esc(m.label)}</span>`).join("")}</div>` : ""}
      </div>`).join("")
      : `<div class="oc-empty">Не удалось получить список агентов</div>`;
    for (const el of document.querySelectorAll(".sa-check:not([disabled])")) el.onchange = () => {
      if (el.checked) setup.picked.add(el.dataset.agent); else setup.picked.delete(el.dataset.agent);
      $("sel-count").textContent = String(setup.picked.size);
    };
    setup.picked = new Set(agents.filter((a) => a.state === "missing").map((a) => a.id));
    $("sel-count").textContent = String(setup.picked.size);
    renderJobs(envJobs ?? []);
    startJobPoll();
  } catch (e) {
    $("setup-summary").textContent = "ошибка загрузки";
    $("setup-agents").innerHTML = `<div class="oc-ns__err">${esc(String(e.message ?? e))}</div>`;
  }
}

/** Прогресс установки: сколько шагов пройдено и что сейчас выполняется. */
function renderJobs(jobs) {
  const box = $("setup-jobs");
  if (!box) return;
  if (!jobs.length) { box.innerHTML = ""; return; }
  const total = jobs.reduce((n, j) => n + (j.steps?.length ?? 0), 0);
  const doneAll = jobs.reduce((n, j) => n + (j.steps ?? []).filter((s) => s.status === "done").length, 0);
  const running = jobs.filter((j) => j.status === "running" || j.status === "queued").length;
  box.innerHTML = `
    <div class="sj-overall">
      <div class="sj-bar"><span style="width:${total ? Math.round((doneAll / total) * 100) : 0}%"></span></div>
      <div class="muted small">${doneAll} из ${total} шагов${running ? ` · осталось агентов: ${running}` : " · всё готово"}</div>
    </div>
    ${jobs.map((j) => {
      const done = (j.steps ?? []).filter((s) => s.status === "done").length;
      const cur = (j.steps ?? []).find((s) => s.status === "running");
      const label = j.status === "done" ? "готово" : j.status === "failed" ? "ошибка"
        : j.status === "running" ? (cur?.label ? `${esc(cur.label)}…` : "ставится…") : "в очереди";
      return `<div class="setup-job setup-job--${esc(j.status)}">
        <div class="sj-head"><b>${esc(j.label)}</b><span class="sj-status">${label} (${done}/${j.steps?.length ?? 0})</span></div>
        ${j.log?.length ? `<pre>${esc(j.log.slice(-8).join(""))}</pre>` : ""}
      </div>`;
    }).join("")}`;
}

let jobPoll = null;
/** Пока что-то ставится — обновляем сами. Раньше прогресс замирал на «0/11»
 *  и увидеть результат можно было только перезагрузив страницу. */
function startJobPoll() {
  if (jobPoll) return;
  let idleTicks = 0;
  jobPoll = setInterval(async () => {
    try {
      const jobs = await api("/setup/jobs");
      renderJobs(jobs ?? []);
      const busy = (jobs ?? []).some((j) => j.status === "running" || j.status === "queued");
      if (busy) { idleTicks = 0; return; }
      // Установка закончилась — обновляем список агентов и гасим опрос.
      if (++idleTicks >= 2) {
        clearInterval(jobPoll); jobPoll = null;
        refreshSetupAgents();
        loadAll();
      }
    } catch { clearInterval(jobPoll); jobPoll = null; }
  }, 1200);
}

async function refreshKeys() {
  const box = $("setup-keys");
  box.innerHTML = `<div class="oc-empty">проверяем…</div>`;
  try {
    const [agents, keys] = await Promise.all([api("/setup/agents"), api("/setup/keys")]);
    setup.keys = keys;
    const withKeys = agents.filter((a) => a.envVar);
    const noKeys = agents.filter((a) => !a.envVar);
    // ── ключи провайдеров (CRUD) ──
    const keyRows = withKeys.map((a) => {
      const k = keys.find((x) => x.envVar === a.envVar);
      const st = a.state === "installed" ? (k ? "готов" : "установлен, ключ не задан") : a.state === "missing" ? "агент не установлен" : a.state;
      return `<div class="key-row">
        <span class="k-var" title="${esc(a.envVar)}">${esc(a.envVar)}</span>
        <input data-key-input="${esc(a.envVar)}" type="password" placeholder="${k ? (lang === "ru" ? "задан (" + esc(k.masked) + ") — введи новый для замены" : "set (" + esc(k.masked) + ") — enter a new one to replace") : tr("вставь ключ")}" />
        <span style="display:flex;gap:5px">
          <button class="oc-btn oc-btn--primary" data-key-save="${esc(a.envVar)}">Сохранить</button>
          ${k ? `<button class="oc-btn" data-key-del="${esc(a.envVar)}" title="Удалить ключ">✕</button>` : ""}
        </span>
      </div>
      <div class="muted small" style="margin:-4px 0 6px">${esc(a.label ?? a.id)} · ${esc(st)}${a.keyUrl ? " · " + esc(a.keyUrl) : ""}${a.authHint ? " · " + esc(a.authHint) : ""}</div>`;
    }).join("");
    // ── агенты без ключей: объясняем, что это не поломка ──
    const authList = noKeys.length ? `
      <h3 style="margin-top:14px;font-size:12.5px">Без API-ключей (вход через свой CLI)</h3>
      <div class="muted small" style="margin-bottom:6px">Эти агенты авторизуются своим клиентом — ключ здесь не нужен.</div>
      ${noKeys.map((a) => `<div class="key-row"><span class="k-var">${esc(a.label ?? a.id)}</span>
        <span class="sa-state ${a.state}">${a.state === "installed" ? "готов" : a.state === "missing" ? "нет" : a.state === "needs-auth" ? "нужен вход" : esc(a.state)}</span>
        ${a.authHint ? `<span class="muted small" style="flex:1">${esc(a.authHint)}</span>` : ""}
      </div>`).join("")}` : "";
    box.innerHTML = keyRows + authList || `<div class="oc-empty">Список агентов пуст</div>`;
    for (const el of document.querySelectorAll("[data-key-save]")) el.onclick = async () => {
      const input = document.querySelector(`[data-key-input="${el.dataset.keySave}"]`);
      const v = input.value.trim();
      if (!v) return toast("Вставь значение ключа", "err");
      el.disabled = true;
      try { await api("/setup/keys", { method: "POST", body: { envVar: el.dataset.keySave, value: v } }); toast("Ключ сохранён — подставится агентам", "ok"); input.value = ""; refreshKeys(); }
      catch (e) { toast(String((e).message ?? e), "err"); }
      finally { el.disabled = false; }
    };
    for (const el of document.querySelectorAll("[data-key-del]")) el.onclick = async () => {
      await api(`/setup/keys/${el.dataset.keyDel}`, { method: "DELETE" }).catch(() => {});
      refreshKeys();
    };
  } catch (e) { box.innerHTML = `<div class="oc-ns__err">Не удалось загрузить ключи: ${esc(String((e).message ?? e))}</div>`; }
}

/* --- удалёнка: машины + туннель --- */
async function refreshMachines() {
  try {
    machines = await api("/machines");
    tunnelState = await api("/tunnel").catch(() => null);
    $("machines-list").innerHTML = machines.length ? machines.map((m) => `
      <div class="oc-setrow"><span>${esc(m.name ?? `${m.user}@${m.host}`)}</span>
      <span class="muted small">${esc(m.host)}:${esc(m.daemonPort ?? 7171)}</span>
      <button class="oc-btn oc-btn--danger" data-machine-del="${esc(m.id)}" title="Удалить">✕</button></div>`).join("") : `<div class="oc-empty">машин нет — добавьте по SSH</div>`;
    for (const el of document.querySelectorAll("[data-machine-del]")) el.onclick = async () => {
      await api(`/machines/${el.dataset.machineDel}`, { method: "DELETE" }).catch(() => {});
      refreshMachines();
    };
    const url = (tunnelState)?.url ?? (tunnelState)?.webUrl;
    $("tunnel-url").textContent = url ? url : "выключен";
  } catch (e) { $("machines-list").innerHTML = `<div class="oc-empty">${esc(String((e).message ?? e))}</div>`; }
}

/* ═══════════ ТЕМЫ ═══════════
   Шесть основных тем — то, что видно сразу. Остальные остаются доступны,
   но спрятаны за «Ещё темы», чтобы выбор не превращался в стену кружков. */
const THEME_CORE = [
  ["modern-light", "Modern Light"], ["oc-dark", "Тёмная"], ["oc-light", "Светлая"], ["oc-midnight", "Полночь"],
  ["oc-emerald", "Изумруд"], ["oc-slate", "Сланец"], ["oc-mono", "Моно"],
];
const THEME_EXTRA = [
  ["oc-violet", "Вайолет"], ["oc-rose", "Роза"], ["oc-amber", "Амбер"],
  ["oc-ocean", "Океан"], ["oc-forest", "Лес"], ["oc-light-2", "Светлая фиолет"],
  ["oc-glass-dark", "Стекло тёмное"], ["oc-glass-light", "Стекло светлое"],
  ["glass", "Glass"], ["neo", "Neo"], ["glass-slate", "Glass Slate"],
  ["glass-light", "Glass Light"], ["glass-violet", "Glass Violet"],
  ["light", "Light"],
  ["atom-one-dark", "Atom One"], ["dracula", "Dracula"], ["monokai", "Monokai"],
  ["nord", "Nord"], ["solarized-light", "Solarized"],
  ["vscode-dark", "VS Code Dark"], ["vscode-light", "VS Code Light"],
];
const THEME_ALL = [...THEME_CORE, ...THEME_EXTRA];

/** Кружки тем в Настройках: основные всегда, остальные — по кнопке «Ещё темы». */
function renderThemeDots(showExtra) {
  const dots = $("theme-dots");
  if (!dots) return;
  const cur = document.documentElement.dataset.theme;
  const list = showExtra ? THEME_ALL : THEME_CORE;
  const dot = ([t, label]) =>
    `<button class="oc-themedot ${cur === t ? "oc-themedot--active" : ""}" data-theme="${t}" title="${label}" aria-label="${label}" style="background:${dotBg(t)}"></button>`;
  dots.innerHTML = list.map(dot).join("")
    + `<button class="oc-btn oc-btn--ghost oc-btn--sm oc-themedot-more" data-act="theme-more">${showExtra ? "Свернуть" : "Ещё темы"}</button>`;
}

async function loadSettings() {
  // шаги
  for (const el of document.querySelectorAll(".setup-step")) el.onclick = () => switchSetupStep(el.dataset.step);
  // Компаньон (F-V6-2): панель настроек + диалог
  bindCompanion();
  refreshCompanion();
  renderThemeDots();
  void bindGovernance();
  // серверные шаги
  switchSetupStep(setup.step);
  // импорт/экспорт
  // onclick, а не addEventListener: loadSettings зовётся на каждое открытие
  // вкладки, и обработчики копились — экспорт качал файл N раз.
  const be = $("btn-export");
  if (be) be.onclick = async () => {
    const r = await api("/export");
    const blob = new Blob([JSON.stringify(r, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = "dirigo-backup.json"; a.click();
    toast("Бэкап скачан");
  };
  const bi = $("btn-import");
  if (bi) bi.onclick = () => {
    const inp = document.createElement("input");
    inp.type = "file"; inp.accept = ".json";
    inp.onchange = async () => {
      const f = inp.files?.[0];
      if (!f) return;
      try {
        const data = JSON.parse(await f.text());
        await api("/import", { method: "POST", body: { ...data, mode: "merge" } });
        toast("Бэкап загружен (merge)"); loadAll();
      } catch (e) { toast(String((e).message ?? e), "err"); }
    };
    inp.click();
  };
  // установка агентов + env-fix
  $("setup-install-selected").onclick = async () => {
    const list = [...setup.picked];
    if (!list.length) return toast("Отметь агентов (или «Отметить недостающих»)", "err");
    for (const id of list) {
      try { await api("/setup/install", { method: "POST", body: { agentId: id } }); } catch (e) { toast(`${id}: ${String((e).message ?? e)}`, "err"); }
    }
    toast(`Установка ${list.length} агент(ов) — следи за прогрессом`, "ok");
    setTimeout(refreshSetupAgents, 1500);
  };
  $("setup-select-missing").onclick = async () => {
    const agents = await api("/setup/agents");
    setup.picked = new Set(agents.filter((a) => a.state !== "installed").map((a) => a.id));
    for (const el of document.querySelectorAll(".sa-check")) el.checked = setup.picked.has(el.dataset.agent);
    $("sel-count").textContent = String(setup.picked.size);
  };
  $("env-fix").onclick = async () => {
    const e = setup.env;
    if (!e) return;
    const targets = [];
    if (!e.bun?.ok) targets.push("bun");
    if (!e.cloudflared?.ok && await ocConfirm("cloudflared не установлен — поставить? (публичный URL демона в 2 клика)", { ok: tr("Поставить") })) targets.push("cloudflared");
    if (!targets.length) return toast("Нечего устанавливать — всё на месте", "ok");
    for (const t of targets) {
      try { await api("/setup/env", { method: "POST", body: { what: t } }); toast(`Установка ${t} запущена`, "ok"); } catch (err) { toast(String((err).message ?? err), "err"); }
    }
    toast("Перезапусти демон после установки (PATH обновляется)", "err");
    setTimeout(refreshEnv, 2000);
  };
  // машины + туннель
  $("m-add").onclick = async () => {
    const host = ($("m-host") ).value.trim();
    const user = ($("m-user") ).value.trim() || "root";
    if (!host) return toast("Укажи host/IP", "err");
    try {
      await api("/machines", { method: "POST", body: {
        name: ($("m-name") ).value.trim() || `${user}@${host}`,
        host, user,
        port: Number(($("m-port") ).value) || undefined,
        daemonPort: Number(($("m-daemon") ).value) || 7171,
        identity: ($("m-key") ).value.trim() || undefined,
      } });
      toast("Машина добавлена", "ok");
      ($("m-host") ).value = ""; ($("m-name") ).value = "";
      refreshMachines();
    } catch (e) { toast(String((e).message ?? e), "err"); }
  };
  $("tunnel-start").onclick = async () => {
    try { const r = await api("/tunnel/start", { method: "POST" }); toast("Туннель включается…", "ok"); $("tunnel-url").textContent = r?.url ?? r?.webUrl ?? "запускается"; setTimeout(refreshMachines, 2500); }
    catch (e) { toast(String((e).message ?? e), "err"); }
  };
  $("tunnel-stop").onclick = async () => {
    try { await api("/tunnel/stop", { method: "POST" }); toast("Туннель выключен"); refreshMachines(); }
    catch (e) { toast(String((e).message ?? e), "err"); }
  };
}

function dotBg(t) {
  if (t === "oc-dark") return "linear-gradient(135deg, #1a1d26, #2a2e3a)";
  if (t === "glass" || t === "neo" || t === "glass-slate" || t === "atom-one-dark" || t === "dracula" || t === "monokai" || t === "nord" || t === "vscode-dark" || t.startsWith("oc-")) {
    if (t === "oc-light" || t === "oc-light-2" || t === "oc-glass-light" || t === "glass-light" || t === "glass-violet" || t === "solarized-light" || t === "vscode-light" || t === "modern-light" || t === "light") return "#e8eaef";
    return "linear-gradient(135deg, #23262f, #2e3340)";
  }
  return "linear-gradient(135deg, #23262f, #3a4050)";
}
/* ═══════════ ОБЗОР — дашборд по проектам (V6-9) ═══════════ */
async function loadOverview() {
  try {
    const o = await api("/overview");
    const t = o.totals ?? {};
    $("ov-totals").textContent = `проектов: ${t.projects ?? 0} · сессий: ${t.sessions ?? 0} · активных: ${t.active ?? 0} · коммитов: ${t.commits ?? 0} · токенов: ${(t.tokens ?? 0).toLocaleString("ru")}`;
    // карточки проектов
    $("ov-cards").innerHTML = (o.projects ?? []).map((p) => `
      <button class="oc-ovcard" data-ovproj="${esc(p.id)}" title="${esc(p.path)}">
        <div class="oc-ovcard__head">
          <span class="oc-ovcard__name">${esc(p.name)}</span>
          ${p.archived ? `<span class="oc-chip">архив</span>` : ""}
          ${p.active ? `<span class="oc-chip oc-chip--accent">${p.active} в работе</span>` : ""}
        </div>
        <div class="oc-ovcard__branch">${esc(p.branch)}${p.lastCommit ? ` · ${esc(p.lastCommit)}` : ""}</div>
        <div class="oc-ovcard__stats">
          <span title="коммиты">⇪ ${p.commits}</span>
          <span title="сессии">◈ ${p.sessions}</span>
          <span title="готово">✓ ${p.done}</span>
          <span title="ошибки">✗ ${p.failed}</span>
          <span title="токены">◆ ${(p.tokens ?? 0).toLocaleString("ru")}</span>
        </div>
      </button>`).join("") || `<div class="oc-empty">проектов нет — добавьте первый</div>`;
    // сессии по дням (последние 7 дней)
    const days = new Map();
    for (let i = 6; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000);
      days.set(d.toLocaleDateString(dateLoc(), { day: "numeric", month: "short" }), 0);
    }
    for (const s of (state.sessions ?? [])) {
      if (!s.updatedAt) continue;
      const key = new Date(s.updatedAt).toLocaleDateString(dateLoc(), { day: "numeric", month: "short" });
      if (days.has(key)) days.set(key, (days.get(key) ?? 0) + 1);
    }
    const maxDay = Math.max(1, ...days.values());
    $("ov-days").innerHTML = [...days.entries()].map(([label, v]) => `
      <div class="oc-bars__col" title="${v} ${lang === "ru" ? "сессий" : "sessions"}"><div class="oc-bars__bar" style="height:${Math.max(2, (v / maxDay) * 100)}%"></div><span>${esc(label)}</span></div>`).join("");
    // токены по агентам
    const agents = o.agents ?? [];
    const maxTok = Math.max(1, ...agents.map((a) => a.tokens));
    const colors = ["var(--accent)", "var(--mode-swarm)", "var(--mode-fusion)", "var(--mode-orchestrator)", "var(--mode-solo)", "var(--warn)"];
    $("ov-agents").innerHTML = agents.slice(0, 6).map((a, i) => `<div class="oc-usage-bar__seg" style="width:${((a.tokens / maxTok) * 100).toFixed(1)}%;background:${colors[i % colors.length]}"></div>`).join("") || `<div class="oc-empty">нет данных</div>`;
    $("ov-agents-legend").innerHTML = agents.slice(0, 6).map((a, i) => `<span><span class="oc-usage-legend__dot" style="background:${colors[i % colors.length]}"></span>${esc(agentName(a.agentId))} — ${a.tokens.toLocaleString("ru")}</span>`).join("");
    // коммиты по проектам
    const byCommits = (o.projects ?? []).filter((p) => p.commits > 0).sort((a, b) => b.commits - a.commits).slice(0, 7);
    const maxCommit = Math.max(1, ...byCommits.map((p) => p.commits));
    $("ov-commits").innerHTML = byCommits.map((p) => `
      <div class="oc-bars__col" title="${p.commits} коммитов"><div class="oc-bars__bar" style="height:${Math.max(2, (p.commits / maxCommit) * 100)}%"></div><span>${esc(p.name)}</span></div>`).join("") || `<div class="oc-empty">нет коммитов</div>`;
  } catch (e) { $("overview-pane").innerHTML = `<div class="oc-empty">${esc(String(e.message ?? e))}</div>`; }
}

/* ═══════════ ТЕРМИНАЛЫ (V6-5): окно по центру табом, список справа-снизу ═══════════ */
state.showArchivedSessions = false;  // архив сессий скрыт, пока не попросили
state.terminals = [];      // [{id, name, dir}]
state.term = null;         // активный терминал

async function termCreate() {
  try {
    const r = await api("/terminals", { method: "POST", body: { sessionId: state.current } });
    if (!state.terminals.some((t) => t.id === r.id)) state.terminals.push({ id: r.id, name: r.name, dir: r.dir });
    state.term = r.id;
    renderTermList();
    setView("term");
    renderTabs();
  } catch (e) { toast(String(e.message ?? e), "err"); }
}

async function termKill(id) {
  try { await api(`/terminals/${id}`, { method: "DELETE" }); } catch { /* уже мёртв */ }
  state.terminals = state.terminals.filter((t) => t.id !== id);
  if (xtShell?.id === id) unmountXterm("shell");
  if (state.term === id) {
    state.term = state.terminals.at(-1)?.id ?? null;
    if (!state.term) setView("chat");
    else if (state.view === "term") renderTerminal();
  }
  renderTermList();
  renderTabs();
}

function renderTermList() {
  $("term-count").textContent = String(state.terminals.length);
  $("rail-term").textContent = String(state.terminals.length);
  $("rail-term").hidden = !state.terminals.length;
  $("term-list").innerHTML = state.terminals.length
    ? state.terminals.map((t) => `
      <div class="oc-termrow ${t.id === state.term ? "oc-termrow--on" : ""}">
        <button class="oc-termrow__open" data-term-open="${esc(t.id)}" title="${esc(t.dir)}">
          <span class="oc-termrow__dot"></span>
          <span class="oc-termrow__name">${esc(t.name)}</span>
        </button>
        <button class="oc-icon-btn oc-icon-btn--tiny oc-icon-btn--danger" data-term-kill="${esc(t.id)}" title="Закрыть терминал">✕</button>
      </div>`).join("")
    : `<div class="oc-empty">нет терминалов — «＋ Терминал» откроет в папке сессии</div>`;
}

function renderTerminal() {
  const t = state.terminals.find((x) => x.id === state.term) ?? state.terminals.at(-1) ?? null;
  if (!t) { setView("chat"); return; }
  state.term = t.id;
  $("term-name").textContent = t.name;
  $("term-dir").textContent = t.dir;
  // Терминал оболочки — тот же xterm.js, что у агентов: ввод прямо в окне,
  // стрелки, Tab, Ctrl+C. Раньше вывод PowerShell падал в <pre> сырыми
  // VT-кодами, а команды уходили строкой из отдельного поля.
  const el = $("term-xterm");
  if (!xtShell || xtShell.id !== t.id || !xtShell.el.isConnected) mountXterm(t.id, el, XT_SHELL(t.id), "shell");
  else requestAnimationFrame(() => { try { xtShell?.term.refresh(0, xtShell.term.rows - 1); xtShell?.term.focus(); } catch { /* */ } });
  renderTermList();
}

/* ═══════════ КОМПОЗЕР: контекст, голос, быстрый выбор модели (V6-8) ═══════════ */
const CONTEXT_MAX = 1_000_000; //Russell: 1M — типичное окно современных агентов

function renderContext() {
  const used = ($("prompt")?.value.length ?? 0) * 4 + (state.current ? 4000 : 0);
  const pct = Math.min(100, Math.round((used / CONTEXT_MAX) * 100));
  $("ctx-used").textContent = used >= 1000 ? `${(used / 1000).toFixed(0)}k` : String(used);
  $("ctx-max").textContent = `${Math.round(CONTEXT_MAX / 1000)}k`;
  $("ctx-fill").style.width = `${Math.max(1, pct)}%`;
  const meter = $("ctx-meter");
  meter.classList.toggle("oc-ctx--warn", pct > 60 && pct <= 85);
  meter.classList.toggle("oc-ctx--err", pct > 85);
}

let recognition = null;
function toggleVoice() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { toast("Голосовой ввод недоступен в этом браузере (нужен Chrome/Edge)", "err"); return; }
  const btn = $("mic-btn");
  if (recognition) { recognition.stop(); recognition = null; btn.classList.remove("oc-mic--on"); toast("Голосовой ввод выключен"); return; }
  recognition = new SR();
  recognition.lang = "ru-RU";
  recognition.interimResults = true;
  recognition.continuous = false;
  recognition.onresult = (e) => {
    const text = [...e.results].map((r) => r[0].transcript).join(" ");
    $("prompt").value = text;
    renderContext();
  };
  recognition.onerror = (e) => {
    // внятные причины вместо «not-allowed»
    const map = {
      "not-allowed": "Микрофон запрещён — разрешите его в настройках браузера (иконка 🔒 в адресной строке → Микрофон → Разрешить)",
      "service-not-allowed": "Сервис распознавания недоступен в этом браузере",
      "audio-capture": "Микрофон не найден — проверьте устройство ввода",
      "network": "Распознавание требует сеть — проверьте соединение",
      "aborted": "Запись прервана",
    };
    toast(map[e.error] ?? `Голос: ${e.error}`, "err");
    btn.classList.remove("oc-mic--on"); recognition = null;
  };
  recognition.onend = () => { btn.classList.remove("oc-mic--on"); recognition = null; };
  recognition.start();
  btn.classList.add("oc-mic--on");
  toast("Говорите — текст попадёт в поле задачи");
}

function renderQuickModel() {
  const s = state.sessions.find((x) => x.id === state.current);
  const el = $("quick-model");
  if (!s) { el.textContent = ""; return; }
  const a = agentById(s.agentId);
  // живой диалог: модель выставлена у агента (ACP), а не флагом запуска
  el.textContent = s.acpModel || s.model || a?.defaultModel || tr("модель агента");
  el.title = s.reasoning ? `рассуждения: ${s.reasoning}` : "рассуждения по умолчанию";
}

/* ═══════════ i18n (V6-10): механизм + словарь ═══════════
   Полный словарь RU→EN для интерфейса.
   Слой перевода DOM: после любого рендера сканирует тексты и подставляет EN
   (с skip-зонами: код/дифф/логи/вывод терминала — пользовательские данные). */
const I18N = {
  // 1.9.4: недостающие строки английского интерфейса — собраны и переведены при
  // съёмке промо-роликов (../promo/plan/EN-DICTIONARY.md), проверены по data-i18n.
  "Проверяются задача и каждое сообщение агенту (до отправки), а также строки, которые агент добавил в файлы (до применения и перед коммитом).": "The task and every message to the agent are checked before they are sent, and so is every line the agent added to a file — before it is applied and before it is committed.",
  "Ищет: e-mail, телефон, IBAN, номер карты (по алгоритму Луна — для проверки возьмите 4111 1111 1111 1111), ключи и токены, IP, ФИО и ваши слова. Сами значения не сохраняются — только вид, позиция и длина.": "It looks for e-mail addresses, phone numbers, IBANs, card numbers (Luhn — try 4111 1111 1111 1111), keys and tokens, IP addresses, full names and your own terms. The values themselves are never stored — only the kind, the offset and the length.",
  "свои слова — по одному в строке: ФИО клиентов, названия компаний, номера договоров": "your own terms — one per line: client names, company names, contract numbers",
  "проверить текст: почта, карта, телефон, ФИО…": "test a piece of text: e-mail, card, phone, full name…",
  "CoAlly Nexus — база знаний по MCP: решения и контекст задач остаются в компании и находятся по смыслу. Ключ: cnx_…": "CoAlly Nexus — a knowledge base over MCP: decisions and task context stay inside the company and are found by meaning. Key: cnx_…",
  "Подставить адрес CoAlly": "Use the CoAlly address",
  "Найти": "Search",
  "найти в базе знаний: как у нас устроен расчёт кредита?": "search the knowledge base: how do we calculate shipping rates?",
  "Подключить CoAlly к агентам": "Connect CoAlly to the agents",
  "Убрать из агентов": "Disconnect from the agents",
  "Добавляет сервер coally-nexus в настройки MCP каждого установленного агента": "Adds the coally-nexus server to the MCP settings of every installed agent",
  "подключён": "connected",
  "добавлен": "added",
  "обновлён": "updated",
  "убран": "removed",
  "не подключён": "not connected",
  "в сессиях пульта": "in panel sessions",
  "пользовательский конфиг MCP не читает — подключается в сессиях Dirigo (живой диалог)": "does not read a user MCP config — it is wired up inside Dirigo sessions (live dialog)",
  "· ключ не задан": "· no key set",
  "ключ не задан": "no key set",
  "Для «Kilo Gateway» ключ не задан — ответ будет локальным": "No key set for “Kilo Gateway” — the reply will be local",
  "••••••• (задан)": "••••••• (set)",
  "Очистить лог диалога": "Clear the conversation log",
  "версия:": "version:",
  "Claude Code — мост ACP": "Claude Code — ACP bridge",
  "claude — вход по подписке (один раз) ИЛИ ANTHROPIC_API_KEY": "claude — sign in once with your subscription, or ANTHROPIC_API_KEY",
  "cline auth — вход (Cline Provider / ClinePass / свой ключ провайдера)": "cline auth — sign in (Cline Provider / ClinePass / your own provider key)",
  "codex login — вход по подписке ChatGPT ИЛИ OPENAI_API_KEY": "codex login — sign in with a ChatGPT subscription, or OPENAI_API_KEY",
  "copilot — /login по подписке GitHub Copilot": "copilot — /login with a GitHub Copilot subscription",
  "cursor-agent login — вход по подписке Cursor": "cursor-agent login — sign in with a Cursor subscription",
  "devin — логин по токену кабинета cognition.ai": "devin — sign in with a cognition.ai account token",
  "gemini — /auth по Google-аккаунту ИЛИ GEMINI_API_KEY": "gemini — /auth with a Google account, or GEMINI_API_KEY",
  "hermes — вход по подписке из терминала": "hermes — sign in from the terminal with your subscription",
  "kilo — рабочий профиль и token из профиля (уже настроен на этой машине)": "kilo — a work profile and its token (already set up on this machine)",
  "opencode auth login — вход через браузер (или ключ из кабинета)": "opencode auth login — sign in through the browser, or a key from your account",
  "mcode — провайдер моделей настраивается флагом": "mcode — the model provider is set with a flag",
  "вход — тот же, что у claude": "same sign-in as claude",
  "мост нужен только для режима «Живой диалог (ACP)»": "the bridge is only needed for the Live chat (ACP) mode",
  "hermes-acp — мост ACP": "hermes-acp — the ACP bridge",
  "ключ:": "key:",
  "установлено": "installed",
  "не хватает": "missing",
  "нужно авторизовать": "needs sign-in",
  "[копия]": "[copy]",
  "Показать весь дифф": "Show the whole diff",
  "Вернуть проект к этой версии": "Restore the project to this version",
  "Создать git проекта": "Create a repository for the project",
  "уже установлен": "already installed",
  "выбрать для установки": "select for installation",
  "доступен": "available", "Отмена": "Cancel", "Продолжить": "Continue", "Продолжить с исключением": "Continue with an exception", "Остановить": "Stop", "Создать git": "Create git", "Вернуть": "Revert", "Поставить": "Install", "Удалить": "Delete", "Удалить навсегда": "Delete for good", "Применить": "Apply",
  "режим недоступен": "mode unavailable",
  "— кто выполняет задачу": "— who does the work",
  "Проект и запуск": "Project and run",
  "Тип сессии": "Session type",
  "Рассуждения": "Reasoning",
  "работать в копии проекта (безопасно)": "work in a copy of the project (safe)",
  "＋ Новый проект…": "＋ New project…",
  "(недоступен)": "(unavailable)",
  "Solo — один агент решает задачу": "Solo — one agent does the task",
  "Swarm — рои агентов по зонам файлов": "Swarm — a swarm of agents, split by file zones",
  "Fusion — несколько моделей, выбор лучшего": "Fusion — several models, the best one wins",
  "Orchestrator — план с эпиками и верификацией": "Orchestrator — a plan of epics, each one verified",
  "Разовая задача: агент получает текст, работает без вопросов и возвращает результат. Вмешаться по ходу нельзя. Подходит для простых и повторяемых задач.": "A one-shot task: the agent is given text, works without asking anything, and returns a result. You cannot step in while it runs. Good for simple, repeatable work.",
  "Живое соединение по протоколу ACP: агент отвечает структурированно, пульт показывает ход работы своим интерфейсом и держит контекст между сообщениями. Доступно там, где агент умеет ACP.": "A live connection over the ACP protocol: the agent answers in a structured way, the panel shows the work in its own interface and keeps context between messages. Available wherever the agent speaks ACP.",
  "Полноценный терминал агента прямо в пульте: его родной интерфейс, подтверждения и подсказки. Максимум контроля — обычно это основной способ.": "The agent’s full terminal, inside the panel: its own interface, its own prompts and confirmations. The most control — usually the one to reach for.",
  "Собственная веб-панель агента. Локальная открывается прямо здесь, во встроенном окне; если у агента только сайт — откроется отдельной вкладкой.": "The agent’s own web panel. A local one opens here in an embedded frame; if the agent only has a website, it opens in a separate tab.",
  "Задача · Веб · Диалог · Терминал": "Task · Web · Dialog · Terminal",
  "Задача · Веб · Терминал": "Task · Web · Terminal",
  "Задача · Диалог · Терминал": "Task · Dialog · Terminal",
  "Веб · Терминал": "Web · Terminal",
  "Задача · Веб": "Task · Web",
  "· Диалог": "· Dialog",
  "· Задача": "· Task",
  "· Терминал": "· Terminal",
  "· Веб": "· Web",
  "Веб": "Web",
  "Задача": "Task",
  "Диалог": "Dialog",
  "OpenCode — opencode run — своя сессия на задачу (free-tier только внутри приложения!)": "OpenCode — opencode run — its own session per task (the free tier only works inside the app)",
  "Агент правит проект": "The agent edits the project",
  "напрямую": "directly",
  "Ищет: e-mail, телефон, IBAN, номер карты (по алгоритму Луна — для проверки возьмите 4111 1111 1111 1111), ключи и токены, ФИО с отчеством или инициалами, и ваши слова ниже.": "It looks for e-mail addresses, phone numbers, IBANs, card numbers (Luhn — try 4111 1111 1111 1111), keys and tokens, full names with a patronymic or initials, and your own terms below.",
  "Проверяются задача и каждое сообщение агенту (до отправки), а также строки, которые агент добавил в файлы (до «Применить» и Commit). Сами найденные значения нигде не сохраняются — только тип, файл и номер строки.": "The task and every message to the agent are checked before they are sent, and so is every line the agent added to a file — before Apply and before Commit. The values found are never stored anywhere: only the kind, the file and the line number.",
  "CoAlly Nexus — база знаний по MCP: решения и контекст задач остаются в компании и находятся по смыслу. Ключ: coally.cortexally.ai → Settings → API Keys (cnx_…).": "CoAlly Nexus — a knowledge base over MCP: decisions and task context stay inside the company and are found by meaning. Key: coally.cortexally.ai → Settings → API Keys (cnx_…).",
  "Добавляет сервер coally-nexus в настройки MCP каждого установленного агента (Claude Code, Devin, OpenCode, Kilo, Cline, Cursor, Freebuff, ZCode, Hermes…): агенты смогут сами искать и сохранять контекст — и в пульте, и при запуске вручную. Ваши серверы и настройки остаются; перед первой правкой сохраняется копия файла.": "Adds the coally-nexus server to the MCP settings of every installed agent (Claude Code, Devin, OpenCode, Kilo, Cline, Cursor, Freebuff, ZCode, Hermes…), so the agents can search and save context themselves — both in the panel and when you start them by hand. Your own servers and settings are kept, and a copy of each file is saved before it is first touched.",
  "Агент ждёт решения — без ответа он не продолжит.": "The agent is waiting for a decision — without an answer it will not go on.",
  "Агент просит разрешение": "The agent is asking for permission",
  "инструментов": "tools",
  "инструменты": "tools",
  "инструмент": "tool",
  "Без API-ключей (вход через свой CLI)": "No API key needed (sign in with the agent’s own CLI)",
  "Эти агенты авторизуются своим клиентом — ключ здесь не нужен.": "These agents sign in through their own client, so no key is needed here.",
  "freebuff — ключ/подписка не нужны (бесплатные модели включены); первый запуск индексирует репозиторий": "freebuff — no key or subscription needed (free models are enabled); the first run indexes the repository",
  "freebuff в PTY — интерактивный сеанс; первый запуск индексирует репозиторий": "freebuff in a PTY — an interactive session; the first run indexes the repository",
  "установлен": "installed",
  "агент": "agent",
  "Продолжить всё равно? Исключение будет записано в журнал доказательств.": "Continue anyway? The exception will be written into the evidence log.",
  "в изменениях агента найдено": "found in the agent’s changes:",
  "в изменениях агента персональных данных не найдено": "no personal data found in the agent’s changes",
  "персональных данных не найдено": "no personal data found",
  "— применение остановлено политикой": "— the apply was stopped by policy",
  "— отправка заблокирована": "— sending was blocked",
  "строки": "lines",
  "файл(ах)": "file(s)",
  "найдено": "found",
  "почта": "e-mail",
  "телефон": "phone",
  "карта": "card",
  "секрет": "secret",
  "токен": "token",
  "ФИО": "full name",
  "своё слово": "own term",
  "В архив — проект и сессии остаются, но убираются из списка": "Archive — the project and its sessions stay, but leave the list",
  "В архив — уберёт из списка, журнал и доказательства останутся": "Archive — removes it from the list; the log and the evidence stay",
  "Удалить сессию вместе с журналом": "Delete the session and its log",
  "Доказательства происхождения изменений": "Provenance of the changes",
  "Развернуть панель": "Expand the panel",
  "Свернуть панель": "Collapse the panel",
  "Открыть копию в редакторе": "Open the copy in your editor",
  "Закоммитить все изменения в репозиторий проекта": "Commit every change to the project repository",
  "Светлая фиолет": "Light violet",
  "готово": "done",
  // терминал агента (xterm.js), вставка картинок, уровень рассуждений, вход
  "Печатайте прямо в терминале или в поле внизу. Ctrl+V вставляет текст и картинки.": "Type right in the terminal or in the field below. Ctrl+V pastes text and images.",
  "Картинка вставлена — агент получил путь к файлу": "Image pasted — the agent got the file path",
  "Картинка больше 20 МБ — не отправлю": "Image is over 20 MB — not sending it",
  "Картинки принимает только терминал агента": "Only an agent terminal accepts images",
  "Эмулятор терминала не загрузился — обновите страницу (Ctrl+F5).": "The terminal emulator failed to load — reload the page (Ctrl+F5).",
  "как настроено в агенте": "as configured in the agent", "агент выбирает сам": "the agent decides",
  "Без выбора агент работает на уровне из своих настроек; выбранный уровень передаётся флагом": "Left empty, the agent uses the level from its own settings; a chosen level is passed with the flag",
  "Уровень рассуждений этого агента задаётся в его собственных настройках": "This agent's reasoning level is set in its own settings",
  "None — без рассуждений": "None — no reasoning", "Minimal — минимум": "Minimal — the least", "Low — быстро": "Low — fast",
  "Medium — баланс": "Medium — balanced", "High — глубже": "High — deeper", "XHigh — ещё глубже": "XHigh — deeper still",
  "Max — максимум": "Max — maximum", "Ultra — предел": "Ultra — the limit",
  "Агент ждёт ответа в терминале": "The agent is waiting for your answer in the terminal",
  "Ответьте прямо в окне терминала — стрелки и Enter. Задача уйдёт агенту сама, сразу после ответа.": "Answer right in the terminal window — arrows and Enter. The task is sent to the agent as soon as you answer.",
  "модель агента по умолчанию": "agent default model", "спрашиваем агента…": "asking the agent…", " (модель агента)": " (agent model)", "выбор модели недоступен": "model choice unavailable",
  "Подключаемся к агенту": "Connecting to the agent", "Агент получил сообщение — ждём ответ модели": "The agent got the message — waiting for the model", "Агент размышляет": "The agent is thinking",
  "Агент работает с инструментами": "The agent is using tools", "Агент пишет ответ": "The agent is writing a reply", "Агент составляет план": "The agent is planning",
  "с": "s", "Модель диалога": "Dialog model", "найти модель…": "find a model…", "сейчас": "current", "ничего не найдено": "nothing found", "доступен": "available", "вставь ключ": "paste the key", "Модель": "Model",
  "Агент не сообщил список моделей — смените модель в его настройках": "The agent did not report its models — change the model in its own settings",
  "Enter — отправить · Shift+Enter — новая строка": "Enter — send · Shift+Enter — new line",
  "Enter — в терминал агента · Shift+Enter — новая строка · /команды агента уходят как есть": "Enter — to the agent terminal · Shift+Enter — new line · agent /commands are passed as is",
  "Enter — отправить · Shift+Enter — новая строка · /model — сменить модель": "Enter — send · Shift+Enter — new line · /model — switch model",
  "Пишите в веб-панели агента": "Type in the agent web panel",
  "Enter — продолжить задачу · Shift+Enter — новая строка": "Enter — continue the task · Shift+Enter — new line",
  "вход выполнен": "signed in", "Агент вошёл в аккаунт — ключ не нужен": "The agent is signed in — no key needed",
  "Открыл выбор модели в агенте — выберите в его списке": "Opened the model picker in the agent — choose from its list",
  // ── навигация и виды ──
  "Обзор": "Overview", "Создать": "New", "Разговор": "Chat", "Доска": "Board",
  "История": "History", "Статистика": "Statistics", "Настройки": "Settings",
  "Проекты": "Projects", "Тема": "Theme", "Файлы": "Files", "Изменения": "Changes",
  "Терминал": "Terminal", "Терминалы": "Terminals", "Оформление": "Appearance",
  "поиск": "search", "Поиск": "Search", "Поиск (⌘K)": "Search (⌘K)",
  "Компаньон": "Companion", "Язык": "Language", "Язык интерфейса": "Interface language",
  "Язык: русский": "Language: English", "Русский": "Russian",
  // ── действия ──
  "Отправить": "Send", "Запустить": "Start", "Запускаем…": "Starting…", "Создаём…": "Creating…",
  "Отмена": "Cancel", "Закрыть": "Close", "✕ Закрыть": "✕ Close", "Закрыть (Esc)": "Close (Esc)",
  "Добавить": "Add", "Удалить": "Delete", "Архив": "Archive", "Сохранить": "Save",
  "Применить в проект": "Apply to project", "Вернуть как было": "Revert",
  "Commit · все": "Commit · all", "Push": "Push", "PR": "PR", "Merge → main": "Merge → main",
  "Открыть в редакторе": "Open in editor", "Новая сессия": "New session",
  "Задача своими словами: что должно получиться": "Describe the task in your own words: what should the result be",
  "Поехали": "Go", "Обновить": "Refresh", "Очистить": "Clear",
  "Показать дифф": "Show diff", "Показать весь дифф в центре": "Show full diff in the center",
  "Показать дифф файла по центру": "Show file diff in the center",
  "Прогнать проверки": "Run checks", "Включить туннель": "Start tunnel", "Выключить": "Stop",
  "Поставить недостающее": "Install missing", "Отметить недостающих": "Mark missing",
  "Установить выбранные": "Install selected", "Загрузить бэкап": "Upload backup",
  "Скачать бэкап data/db.json": "Download backup data/db.json", "Экспорт данных": "Export data",
  "Импорт": "Import", "Импорт / экспорт": "Import / export",
  "Выбрать папку": "Choose folder", "На уровень вверх": "Up one level",
  // Терминальная сессия агента и слой доступности (v1.6.1)
  "Агент ждёт входа в аккаунт": "Agent is waiting for you to sign in",
  "Открыть страницу входа": "Open sign-in page",
  "Скопировать ссылку": "Copy link",
  "Ссылка входа скопирована": "Sign-in link copied",
  "Не удалось скопировать — ссылка есть в экране терминала": "Copy failed — the link is on the terminal screen",
  "Задача уйдёт в терминал после входа — наберите её в поле внизу.": "Your task goes to the terminal once you sign in — type it in the field below.",
  "Экран агента. Пишите прямо здесь или в поле внизу — всё уходит в терминал.": "The agent's screen. Type here or in the field below — both go to the terminal.",
  "подключаюсь к терминалу…": "connecting to the terminal…",
  "Кликните по экрану и печатайте — ввод уходит прямо в агента": "Click the screen and type — input goes straight to the agent",
  "Сообщение в терминал агента": "Message to the agent's terminal",
  "Эта сессия — веб-панель агента: пишите в ней": "This session is the agent's web panel — type there",
  "Сообщение агенту (живой диалог)": "Message to the agent (live chat)",
  "Писать можно и здесь, и в поле внизу — это один и тот же терминал.": "You can type here or in the field below — it is the same terminal.",
  "модель агента": "agent model",
  "Вход выполнен": "Signed in", "Войти один раз": "Sign in once",
  "Код входа истёк — нужен повторный запуск": "Sign-in code expired — restart needed",
  "Перезапустить сессию": "Restart session",
  "Входите один раз: несколько открытых сессий показывают разные коды, и они гасят друг друга.": "Sign in once: several open sessions show different codes and cancel each other out.",
  "Открыл выбор модели в агенте — выберите в его списке": "Opened the model picker inside the agent — choose from its list",
  "Сессия перезапущена": "Session restarted",
  "Отправлено в терминал": "Sent to the terminal",
  "Отправлено агенту": "Sent to the agent",
  "Задача отправлена агенту": "Task sent to the agent",
  "Продолжение диалога — создана связанная сессия": "Conversation continued — a linked session was created",
  "Это веб-панель агента — пишите задачу прямо в ней (кнопка «Открыть»)": "This is the agent's own web panel — type the task there (the «Open» button)",
  "Задача (CLI)": "Task (CLI)", "Живой диалог (ACP)": "Live chat (ACP)",
  "Терминал (TUI)": "Terminal (TUI)", "Веб-панель": "Web panel",
  "Веб-панель (сайт агента)": "Web panel (agent's site)",
  "выбор модели недоступен": "model choice unavailable",
  "нет доступных режимов": "no modes available", "не установлен": "not installed",
  "проверяем…": "checking…", "Сменить модель в агенте": "Change model inside the agent",
  "＋ Терминал": "＋ Terminal", "Новый терминал в папке сессии": "New terminal in the session folder",
  "Очистить вывод": "Clear output", "Закрыть терминал": "Close terminal",
  "Стоп сессию": "Stop session", "Вернуть проект к версии": "Restore project to version",
  "Откатить копию к точке возврата": "Revert copy to the restore point",
  "Создать проект прямо сейчас": "Create a project right now",
  "Вернуть копию к точке возврата? Правки агента будут отброшены.": "Revert the copy to the restore point? The agent's edits will be discarded.",
  // ── заголовки/пустые состояния ──
  "Пока пусто — создайте первую сессию": "Empty so far — create your first session",
  "Сессия запущена — лента появится здесь": "Session started — the feed will appear here",
  "нет изменений": "no changes", "Изменений нет": "No changes",
  "Выберите проект — покажу историю версий": "Pick a project — I'll show its version history",
  "История пуста (не git-репозиторий?)": "History is empty (not a git repo?)",
  "нет коммитов": "no commits", "Нет файлов (или проект не читается)": "No files (or the project can't be read)",
  "нет строк в диффе": "no lines in diff", "В коммите нет файлов": "The commit has no files",
  "Файл не в изменённых": "File is not among changed", "нет данных": "no data",
  "машин нет — добавьте по SSH": "no machines — add one over SSH",
  "проектов нет — добавьте первый": "no projects yet — add the first one",
  "ничего не найдено": "nothing found", "нет сессий": "no sessions",
  "проверяем…": "checking…", "проверяем агентов…": "checking agents…",
  "Соберите рабочий процесс": "Assemble your workflow",
  "в одном окне": "in one window",
  "Агенты работают в копии проекта. Вы смотрите изменения и решаете, что попадёт в проект.": "Agents work in a copy of your project. You review the changes and decide what lands.",
  "всё в пару кликов: среда → агенты → ключи → удалёнка": "a couple of clicks: environment → agents → keys → remote",
  // ── компаньон (F-V6-2) ──
  "Проверить окружение": "Check the environment",
  "Мастер найдёт, что уже стоит, и доустановит агентов и зависимости.": "The wizard detects what is installed and adds the missing agents and dependencies.",
  "Добавить проект": "Add a project",
  "Любой git-репозиторий на этой машине. Оригинал остаётся нетронутым.": "Any git repository on this machine. The original stays untouched.",
  "Запустить задачу": "Start a task",
  "Выберите агента и режим. Результат придёт на ревью построчным диффом.": "Pick an agent and a mode. The result comes back as a per-line diff for review.",
  "Здесь появятся ваши проекты": "Your projects will appear here",
  "Проект — это git-репозиторий на этой машине. Агенты работают в его копиях, оригинал не трогают.": "A project is a git repository on this machine. Agents work in copies of it and never touch the original.",
  "Ещё темы": "More themes", "Свернуть": "Collapse",
  "Демон не отвечает — проверьте, что он запущен": "The daemon is not responding — check that it is running",
  "Нет связи с демоном": "No connection to the daemon",
  "Пульт показывает последнее, что успел загрузить. Запустите демон и нажмите «Повторить».": "The panel is showing the last data it managed to load. Start the daemon and press “Retry”.",
  "Повторить": "Retry",
  "Доказательства": "Evidence", "пока пусто": "nothing yet",
  "Шлюз персональных данных": "Personal data gateway", "Режим": "Mode",
  "Выключен": "Off", "Предупреждать": "Warn", "Заменять": "Redact", "Блокировать": "Block",
  "Задача проверяется до отправки агенту. Сами найденные значения нигде не сохраняются — только тип и количество.": "The task is scanned before it reaches the agent. The matched values are never stored - only the kind and the count.",
  "База знаний компании": "Company knowledge base", "Включить выгрузку": "Enable export",
  "Ключ": "Key", "Проект": "Project", "Проверить связь": "Test connection",
  "После каждого применённого изменения в базу знаний уходит запись о задаче: автор, решения, затронутые модули. Всё проходит через шлюз персональных данных.": "After every applied change an entry about the task is sent: author, decisions, modules touched. Everything passes through the personal data gateway first.",
  "Шлюз": "Gateway", "Сохранено": "Saved", "связь есть": "connected", "не отправилось": "not sent",
  "Проверить": "Verify", "Выгрузить для аудита": "Export for audit",
  "Пока нет применённых изменений — пакеты появятся после первого «Применить».": "No applied changes yet — packs appear after the first Apply.",
  "подпись и журнал целы": "signature and ledger intact", "нарушено": "tampered",
  "Агент": "Agent", "Проверки": "Checks", "Возвратов агенту": "Returned to agent",
  "Файлов": "Files", "Одобрил": "Approved by",
  "Проверено": "Verified", "нарушений нет": "no violations",
  "Нарушения": "Violations", "Нарушения целостности": "Integrity violations", "коммит": "commit", "применение": "apply", "Пакет создан коммитом": "Pack created by a commit", "Пакет создан «Применить в проект»": "Pack created by Apply", "Свои слова": "Custom terms", "подключаем…": "connecting…", "в изменениях": "in changes", "применено вопреки политике": "applied despite policy", "Шлюз персональных данных: задача, сообщения и строки, добавленные агентом": "PII gate: task, messages and lines added by the agent", "подписей": "signatures", "журналов": "ledgers",
  "Роль": "Role", "Тон": "Tone", "Модель": "Model",
  "Сохранить настройки": "Save settings", "Очистить лог": "Clear log",
  "Задайте вопрос — ответ появится здесь": "Ask a question — the answer will appear here",
  "Спросить компаньона о сессиях, задачах и планах": "Ask the companion about sessions, tasks and plans",
  "Ответ идёт через провайдера (providers.json); ключ — из секретов демона": "Replies go through the provider (providers.json); the key comes from the daemon secrets",
  "Настройки компаньона сохранены": "Companion settings saved",
  "Лог компаньона очищен": "Companion log cleared",
  "Отвечаю…": "Thinking…",
  "Ассистент": "Assistant", "Ревьюер": "Reviewer", "Планировщик": "Planner", "Наставник": "Mentor",
  "Нейтральный": "Neutral", "Дружелюбный": "Friendly", "Деловой": "Formal", "Лаконичный": "Concise",
  "компаньон": "companion", "вы": "you", "через LLM": "via LLM", "локально (без LLM)": "locally (no LLM — set a provider key)",
  // ── сессии/лента ──
  "Без названия": "Untitled", "Что далее?": "What next?",
  "Enter — в очередь · / — команды · @ — файлы": "Enter — queue · / — commands · @ — files",
  "Enter — отправить в очередь, Shift+Enter — перенос строки": "Enter — send to queue, Shift+Enter — newline",
  "Задача отправлена в очередь": "Task sent to the queue",
  "Опишите задачу — в CLI-режиме агент получает её текстом": "Describe the task — in CLI mode the agent gets it",
  "Откройте сессию": "Open a session", "Выберите агента в левом списке": "Pick an agent from the left list",
  "Сначала нужен проект — создайте его": "A project is required first — create one",
  "Выберите проект": "Pick a project",
  "Выберите проект — или создайте новый кнопкой «＋»": "Pick a project — or create a new one with «＋»",
  "Сессия «": "Session «", "Проект «": "Project «", "» — история": "» — history",
  "» запущена": "» started", "» создан": "» created", "»?": "»?",
  "Вместе с ним удалятся сессии:": "Its sessions will be deleted too:",
  "Точно удалить? Действие необратимо.\nПуть:": "Delete for sure? This cannot be undone.\nPath:",
  "Удалить проект «": "Delete project «", "Удалить проект и все его сессии": "Delete the project and all its sessions",
  "Удалёнка": "Remote", "Сервер": "Server",
  // ── статусы ──
  "Готово": "Done", "Готово — работа ждёт вашего решения": "Done — waiting for your decision",
  "Готово — работа ждёт вашего решения в панели «Изменения».": "Done — waiting for your decision in the Changes panel.",
  "Работа идёт": "Working", "Работает": "Running", "Ошибка": "Error",
  "Ошибка загрузки": "Load error", "Остановлено": "Stopped", "Остановлена": "Stopped",
  "Ожидает": "Waiting", "В очереди": "Queued", "в очереди": "queued",
  "Ожидают": "Waiting", "В работе": "In progress", "Ревью и merge": "Review and merge",
  "Статус работы агента": "Agent work status", "приёмка ✓": "accepted ✓", "приёмка ✗": "accepted ✗",
  "проверки ✓": "checks ✓", "проверки ✗": "checks ✗", "провалены": "failed", "пройдены": "passed",
  "Проверки пройдены ·": "Checks passed ·", "Проверки:": "Checks:", "Проверки ·": "Checks ·",
  "Создаёт": "Creates", "Правит": "Edits", "Читает": "Reads", "готов": "done",
  // ── кнопки панели ──
  "Вернуть как было": "Revert", "Влить в main": "Merge into main",
  "Влить изменения в main?": "Merge changes into main?",
  "Отправить ветку на origin": "Push the branch to origin",
  "Создать Pull request": "Create a Pull request",
  "Перенести изменения копии в рабочий проект": "Move copy changes into the working project",
  "Применить изменения копии в рабочий проект?": "Apply copy changes to the working project?",
  "Открыть папку проекта в редакторе/проводнике": "Open the project folder in an editor/explorer",
  "Сообщение коммита:": "Commit message:", "feat: что изменилось": "feat: what changed",
  // ── настройки ──
  "Среда": "Environment", "Агенты": "Agents", "Ключи": "Keys", "Ключи провайдеров": "Provider keys",
  "Ключ задаётся на шаге 3": "Key is set at step 3", "Ключ сохранён — подставится агентам": "Key saved — will be passed to agents",
  "Вставь значение ключа": "Paste the key value", "Удалить ключ": "Delete key",
  "Нечего устанавливать — всё на месте": "Nothing to install — everything's in place",
  "Перезапусти демон после установки (PATH обновляется)": "Restart the daemon after install (PATH updates)",
  "Установка": "Installing", "ставится…": "installing…", "установлен, ключ не задан": "installed, no key set",
  "Удалённые машины": "Remote machines", "Публичный доступ (cloudflared)": "Public access (cloudflared)",
  "cloudflared не установлен — поставить? (публичный URL демона в 2 клика)": "cloudflared is not installed — install it? (public daemon URL in 2 clicks)",
  "Туннель включается…": "Starting tunnel…", "Туннель выключен": "Tunnel stopped",
  "Машина добавлена": "Machine added", "Укажи host/IP": "Specify host/IP",
  "порт": "port", "демон-порт": "daemon port", "ssh-ключ": "ssh key",
  "публичный URL без SSH-ключа": "public URL without ssh key",
  "Укажите путь к папке проекта": "Specify the project folder path",
  "путь к папке (создадим, если нет)": "folder path (will be created if missing)",
  "имя проекта": "project name", "имя (необязательно)": "name (optional)",
  "Добавить проект (git)": "Add project (git)", "Проект создан — выбран в сессии": "Project created — selected in the session",
  "Проект создан — теперь выберите агента": "Project created — now pick an agent",
  "Такой проект уже добавлен": "This project is already added",
  "Бэкап загружен (merge)": "Backup uploaded (merge)", "Бэкап скачан": "Backup downloaded",
  "Все проекты": "All projects", "Тема:": "Theme:", "модель агента": "agent model",
  "модель по умолчанию агента": "agent default model", "рассуждения:": "reasoning:",
  "рассуждения по умолчанию": "default reasoning", "Модель сессии": "Session model",
  "выбрано:": "selected:", "Отметь агентов (или «Отметить недостающих»)": "Mark agents (or «Mark missing»)",
  "Не поддерживает режим": "mode not supported", "не поддерживает режим": "mode not supported",
  "работает только через релей — выберите CLI": "works via relay only — pick CLI",
  "агент не установлен": "agent not installed", "нужен вход": "sign-in required",
  "нет режимов": "no modes", "копия": "copy", "копии проектов (worktree)": "project copies (worktree)",
  // ── история ──
  "История версий": "Version history", "Коммиты по проектам": "Commits by project",
  "Сессии по дням": "Sessions by day", "Токены по агентам": "Tokens by agent",
  "версия: ": "version: ", "ветка ": "branch ", "бранч": "branch",
  "дн назад": "d ago", "мин назад": "min ago", "ч назад": "h ago", "только что": "just now",
  "Проект возвращён к версии": "Project restored to version",
  "Откатить рабочий проект к этой версии": "Reset the working project to this version",
  "Что изменилось в версии": "What changed in this version",
  "дифф ·": "diff ·", "дифф · +": "diff · +", "файл(ов)": "file(s)", "всего": "total",
  // ── статистика ──
  "Статистика и расход": "Statistics and usage", "Расход за всё время": "All-time usage",
  "токенов": "tokens", ") токенов": ") tokens", "По моделям": "By model",
  "За неделю": "This week", "Занятый контекст (оценка по символам)": "Context used (rough estimate)",
  "Голос:": "Voice:", "Голосовой ввод (Web Speech API)": "Voice input (Web Speech API)",
  "Говорите — текст попадёт в поле задачи": "Speak — the text lands in the task field",
  "Голосовой ввод выключен": "Voice input off",
  "Голосовой ввод недоступен в этом браузере (нужен Chrome/Edge)": "Voice input is unavailable in this browser (Chrome/Edge needed)",
  "Микрофон запрещён — разрешите его в настройках браузера (иконка 🔒 в адресной строке → Микрофон → Разрешить)": "Microphone blocked — allow it in browser settings (🔒 in the address bar → Microphone → Allow)",
  "Микрофон не найден — проверьте устройство ввода": "No microphone found — check your input device",
  "Запись прервана": "Recording stopped", "Распознавание требует сеть — проверьте соединение": "Recognition needs network — check your connection",
  "Сервис распознавания недоступен в этом браузере": "Recognition service is unavailable in this browser",
  // ── ⌘K и прочее ──
  "Сессия, действие, файл…": "Session, action, file…",
  "Новая сессия ·": "New session ·", "Создать сессию": "Create session",
  "Скрыть меню (слева)": "Collapse menu (left)", "Скрыть раздел": "Collapse section",
  "(готов — введите команду)": "(ready — type a command)", "команда и Enter": "command and Enter",
  "Открываю…": "Opening…", "Возвращено:": "Restored:", "Не возвращено:": "Not restored:",
  "Применено:": "Applied:", "Не применено:": "Not applied:", "· активных:": "· active:",
  "· коммитов:": "· commits:", "· сессий:": "· sessions:", "· токенов:": "· tokens:",
  "· установлено": "· installed", "· не хватает": "· missing",
  "проектов:": "projects:", "сессий:": "sessions:", "коммитов": "commits",
  "коммиты": "commits", "сессии": "sessions", "токены": "tokens", "ошибки": "errors",
  "» в архиве — сессии на месте": "» archived — sessions kept", "» возвращён из архива": "» restored from archive",
  "» и его сессии (": "» and its sessions (", ") удалены": ") deleted",
  "шт. (копии на диске останутся до ручной уборки).": "pcs (copies stay on disk until manual cleanup).",
  ": эпиков": ": epics", "эпиков": "epics", ", статус": ", status", "с": "s",
  "обрезано": "truncated", "раздел в разработке — F-V6-2": "section in development — F-V6-2",
  "Интерфейс обновился — перезагружаю страницу": "Interface updated — reloading the page",
  "agент(ов) — следи за прогрессом": "agent(s) — watch the progress",
  "рантайм демона и агентов": "daemon and agents runtime",
  "удалённые машины и туннели": "remote machines and tunnels",
  "установка агентов": "agent installation",
  "— доступно:": "— available:", "запущена": "running", "запускается": "starting",
  "Dirigo — команда ИИ-агентов": "Dirigo — a team of AI agents",
  "dirigo: правки агента": "dirigo: agent changes",
  // ── темы (селектор) ──
  "Тёмная": "Dark", "Полночь": "Midnight", "Изумруд": "Emerald",
  "Вайолет": "Violet", "Роза": "Rose", "Амбер": "Amber", "Океан": "Ocean", "Лес": "Forest",
  "Моно": "Mono", "Сланец": "Slate", "Светлая": "Light", "Светлая (фиолет)": "Light (violet)",
  "Стекло тёмное": "Glass dark", "Стекло светлое": "Glass light",
  "Glass (v2)": "Glass (v2)", "Neo (v2)": "Neo (v2)", "Glass Slate (v2)": "Glass Slate (v2)",
  "Glass Light (v2)": "Glass Light (v2)", "Glass Violet (v2)": "Glass Violet (v2)",
  "Modern Light (v2)": "Modern Light (v2)", "Light (v2)": "Light (v2)", "Atom One (v2)": "Atom One (v2)",
  "Dracula (v2)": "Dracula (v2)", "Monokai (v2)": "Monokai (v2)", "Nord (v2)": "Nord (v2)",
  "Solarized (v2)": "Solarized (v2)", "VS Code Dark (v2)": "VS Code Dark (v2)", "VS Code Light (v2)": "VS Code Light (v2)",
  // ── добор по живой проверке (14.10) ──
  "Доска режимов": "Modes board", "Настройка": "Settings", "терминал": "terminal",
  "нет терминалов — «＋ Терминал» откроет в папке сессии": "no terminals — «＋ Terminal» opens one in the session folder",
  "есть": "yes", "нет": "no", "пусто": "empty",
  "в работе": "in progress", "в архиве": "archived", "выключен": "off", "включён": "on",
  "Сеть": "Network", "Релиз": "Release", "Сессии": "Sessions",
  "Ожидание": "Waiting", "Активных": "Active", "Готовых": "Done", "Ошибок": "Errors",
};
let lang = localStorage.getItem("dirigo-lang") ?? "ru";
const dateLoc = () => (lang === "ru" ? "ru" : "en-GB"); // локаль дат следом за языком UI

/* ── DOM-слой перевода (OCA, перехват F-V6-1): переводит любые тексты и
   title/placeholder/aria-label, где встречает известные русские строки.
   Skip-зоны: код/дифф/логи/терминал — пользовательские данные, не переводим. */
const I18N_SKIP_SEL = "pre, code, .oc-term__out, .oc-log, .oc-diff-line, .oc-file-modal__code, [data-i18n-skip]";
const I18N_KEYS = Object.keys(I18N).sort((a, b) => b.length - a.length);
const i18nOriginal = new WeakMap();
let i18nBusy = false;

function i18nSkip(el) {
  if (!(el instanceof Element)) return true;
  if (el.hasAttribute("data-i18n-skip")) return true;
  const tag = el.tagName;
  if (tag === "PRE" || tag === "CODE" || tag === "SCRIPT" || tag === "STYLE") return true;
  const cls = el.className;
  if (typeof cls === "string" && (cls.includes("oc-term__out") || cls.includes("oc-log") || cls.includes("oc-diff") || cls.includes("file-modal__code"))) return true;
  return false;
}

function i18nText(s) {
  if (!s || !/[А-Яа-яЁё]/.test(s)) return s;
  const key = s.trim();
  if (I18N[key] !== undefined) return s.replace(key, I18N[key]); // точное совпадение узла
  let out = s;
  for (const ru of I18N_KEYS) {
    if (ru.length >= 5 && out.includes(ru)) out = out.split(ru).join(I18N[ru]);
  }
  // Полупереведённая фраза хуже непереведённой: «Agent ждёт входа в аккаунт»
  // выглядит как поломка. Замены по кускам принимаем, только если от русского
  // текста ничего не осталось; иначе показываем исходную строку целиком.
  return /[А-Яа-яЁё]/.test(out) ? s : out;
}

function translateDom(root = document.body) {
  if (i18nBusy) return;
  i18nBusy = true;
  try {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    let node = null;
    while ((node = walker.nextNode())) {
      if (node.nodeType === Node.TEXT_NODE) {
        const parent = node.parentElement;
        if (parent && i18nSkip(parent)) continue;
        if (lang === "ru") {
          // возврат: восстановить всё, что переводили (англ. тексты кириллицы не содержат)
          const orig = i18nOriginal.get(node);
          if (orig !== undefined) node.nodeValue = orig;
          continue;
        }
        const raw = node.nodeValue ?? "";
        if (!raw.trim() || !/[А-Яа-яЁё]/.test(raw)) continue;
        if (!i18nOriginal.has(node)) i18nOriginal.set(node, raw);
        const tr = i18nText(raw);
        if (tr !== raw) node.nodeValue = tr;
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node;
        if (i18nSkip(el)) continue;
        const store = el.__i18nAttr;
        for (const attr of ["title", "placeholder", "aria-label"]) {
          if (lang === "ru") {
            if (store && store[attr] !== undefined) el.setAttribute(attr, store[attr]);
            continue;
          }
          const v = el.getAttribute(attr);
          if (!v || !/[А-Яа-яЁё]/.test(v)) continue;
          const s2 = store ?? (el.__i18nAttr = {});
          if (s2[attr] === undefined) s2[attr] = v;
          el.setAttribute(attr, i18nText(s2[attr]));
        }
      }
    }
  } finally { i18nBusy = false; }
}

let i18nObserver = null;
function initI18nObserver() {
  if (i18nObserver) return;
  i18nObserver = new MutationObserver(() => { if (lang !== "ru") translateDom(document.body); });
  i18nObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
}

/** Перевод строки интерфейса вне DOM (сообщения об ошибках, тосты). */
function tr(ru) { return lang === "ru" ? ru : (I18N[ru] ?? ru); }

/** Фразы, которые сервер собирает с именем агента («Codex CLI не установлен»), в
 *  словарь точных строк не попадают — переводим по шаблонам. */
const TR_SERVER = [
  [/^(.+) не установлен на этой машине$/, "$1 is not installed on this machine"],
  [/^(.+) не установлен — веб-панель поднимать нечем$/, "$1 is not installed — there is nothing to start the web panel with"],
  [/^ACP-мост для (.+) не установлен$/, "The ACP bridge for $1 is not installed"],
  [/^(.+) не установлен$/, "$1 is not installed"],
  [/^(.+) не говорит по ACP$/, "$1 does not speak ACP"],
  [/^(.+) не умеет разовые задачи из командной строки$/, "$1 has no one-shot command-line task mode"],
  [/^(.+) работает только интерактивно — разового запуска задачи у него нет$/, "$1 runs interactively only — it has no one-shot task mode"],
  [/^У (.+) нет веб-интерфейса$/, "$1 has no web interface"],
  [/^У (.+) нет интерактивного терминального режима$/, "$1 has no interactive terminal mode"],
  [/^На этой машине не собран нативный модуль node-pty$/, "The native node-pty module is not built on this machine"],
  [/^Настройки → Агенты → поставить недостающее$/, "Settings → Agents → install what is missing"],
  [/^Настройки → Агенты → «Claude Code — мост ACP» → установить$/, "Settings → Agents → “Claude Code — ACP bridge” → install"],
  [/^Используйте «Задача \(CLI\)» или «Веб-панель»$/, "Use “Task (CLI)” or “Web panel”"],
  [/^Используйте режим «Задача \(CLI\)»$/, "Use the “Task (CLI)” mode"],
  [/^Используйте «Задача \(CLI\)»$/, "Use “Task (CLI)”"],
  [/^Выберите режим «Терминал \(TUI\)»$/, "Choose the “Terminal (TUI)” mode"],
  [/^Выберите другой режим или другого агента$/, "Choose another mode or another agent"],
  [/^Выберите агента из списка$/, "Choose an agent from the list"],
  [/^bun install в каталоге установки \(нужны python3, make, g\+\+\/clang\)$/, "bun install in the install directory (needs python3, make, g++/clang)"],
  [/^агент недоступен$/, "the agent is unavailable"],
  [/^режим недоступен$/, "the mode is unavailable"],
];
function trServer(text) {
  if (lang === "ru" || !text) return text ?? "";
  const t = String(text);
  if (I18N[t]) return I18N[t];
  for (const [re, en] of TR_SERVER) if (re.test(t)) return t.replace(re, en);
  return t;
}

function applyI18n() {
  document.documentElement.lang = lang === "ru" ? "ru" : "en";
  for (const el of document.querySelectorAll("[data-i18n]")) {
    const key = el.dataset.i18n ?? "";
    const ru = el.dataset.i18nRu ?? key;
    el.textContent = lang === "ru" ? ru : (I18N[ru] ?? ru);
  }
  for (const el of document.querySelectorAll("[data-i18n-ph]")) {
    const key = el.dataset.i18nPh ?? "";
    el.placeholder = lang === "ru" ? key : (I18N[key] ?? key);
  }
  localStorage.setItem("dirigo-lang", lang);
  translateDom(document.body);
  initI18nObserver();
}

function renderLangSelect() {
  const sel = $("lang-select");
  if (!sel) return;
  if (!sel.options.length) {
    sel.innerHTML = `<option value="ru">Русский</option><option value="en">English</option>`;
  }
  sel.value = lang;
  sel.onchange = () => {
    lang = sel.value;
    applyI18n();
    toast(lang === "ru" ? "Язык: русский" : "Language: English", "ok");
    setView(state.view); // перерисовать текущий вид на новом языке
  };
}

/* ═══════════ Компаньон (F-V6-2, FBA): настройки + диалог ═══════════ */
const CMP_ROLE_LABELS = { assistant: "Ассистент", reviewer: "Ревьюер", planner: "Планировщик", tutor: "Наставник" };
const CMP_TONE_LABELS = { neutral: "Нейтральный", friendly: "Дружелюбный", formal: "Деловой", concise: "Лаконичный" };
let cmpInfo = null;

function cmpTime(ts) {
  return new Date(ts).toLocaleTimeString(dateLoc(), { hour: "2-digit", minute: "2-digit" });
}

function fillSelect(sel, items, labels, current) {
  if (!sel) return;
  sel.innerHTML = items.map((v) => `<option value="${v}">${labels[v] ?? v}</option>`).join("");
  sel.value = current;
}

async function refreshCompanion() {
  try { cmpInfo = await api("/companion"); } catch { cmpInfo = null; }
  renderCompanion();
}

function renderCompanion() {
  if (!cmpInfo) return;
  const s = (cmpInfo.settings ?? {});
  fillSelect($("cmp-role"), cmpInfo.roles ?? [], CMP_ROLE_LABELS, s.role || "assistant");
  fillSelect($("cmp-tone"), cmpInfo.tones ?? [], CMP_TONE_LABELS, s.tone || "neutral");
  const modelSel = $("cmp-model");
  if (modelSel) {
    const opts = [];
    for (const p of cmpInfo.providers ?? []) {
      for (const m of p.models ?? []) {
        opts.push({ v: m, t: `${m}${p.keySet ? "" : " · ключ не задан"}` });
      }
    }
    if (s.model && !opts.some((o) => o.v === s.model)) opts.unshift({ v: s.model, t: `${s.model} · вне providers.json` });
    modelSel.innerHTML = opts.map((o) => `<option value="${esc(o.v)}">${esc(o.t)}</option>`).join("");
    modelSel.value = s.model;
    const hint = $("cmp-model-hint");
    if (hint) {
      const p = (cmpInfo.providers ?? []).find((x) => (x.models ?? []).includes(s.model));
      hint.textContent = p ? (p.keySet ? `Ответ через провайдера ${p.label}` : `Для «${p.label}» ключ не задан — ответ будет локальным`) : "Модель вне реестра providers.json — ответ будет локальным";
    }
  }
  const log = $("cmp-log");
  if (!log) return;
  const msgs = cmpInfo.messages ?? [];
  log.innerHTML = msgs.length
    ? msgs.map((m) => `<div class="oc-cmp-msg oc-cmp-msg--${m.role === "user" ? "user" : "companion"}">${esc(m.text)}${
      m.role === "companion" ? `<div class="oc-cmp-msg__meta">${cmpTime(m.ts)} · ${m.source === "llm" ? "через LLM" : "локально (без LLM)"}</div>` : ""}</div>`).join("")
    : `<div class="oc-empty">Задайте вопрос — ответ появится здесь</div>`;
  log.scrollTop = log.scrollHeight;
}

async function saveCompanionSettings() {
  const role = $("cmp-role"), tone = $("cmp-tone"), model = $("cmp-model");
  try {
    const r = await api("/companion", { method: "POST", body: { settings: { role: role?.value, tone: tone?.value, model: model?.value } } });
    if (cmpInfo) cmpInfo.settings = r.settings;
    toast("Настройки компаньона сохранены", "ok");
    renderCompanion();
  } catch (e) { toast(String((e).message ?? e), "err"); }
}

async function clearCompanionLog() {
  try {
    await api("/companion", { method: "DELETE" });
    await refreshCompanion();
    toast("Лог компаньона очищен", "ok");
  } catch (e) { toast(String((e).message ?? e), "err"); }
}

async function sendCompanion() {
  const inp = $("cmp-input");
  const text = (inp?.value ?? "").trim();
  if (!text) return;
  if (inp) inp.value = "";
  const btn = $("cmp-send");
  if (btn) btn.disabled = true;
  try {
    const r = await api("/companion", { method: "POST", body: { text } });
    if (r.info) cmpInfo = r.info;
    renderCompanion();
  } catch (e) {
    toast(String((e).message ?? e), "err");
    if (inp) inp.value = text; // вернуть текст — пользователь не потеряет ввод
  } finally {
    if (btn) btn.disabled = false;
  }
}

function bindCompanion() {
  // Присваивание, а не addEventListener: функция зовётся на каждое открытие
  // Настроек, и раньше одно сообщение Компаньону уходило столько раз, сколько
  // раз открывали вкладку.
  const on = (id, ev, fn) => { const el = $(id); if (el) el[ev] = fn; };
  on("cmp-save", "onclick", saveCompanionSettings);
  on("cmp-clear", "onclick", clearCompanionLog);
  on("cmp-send", "onclick", sendCompanion);
  on("cmp-input", "onkeydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendCompanion(); }
  });
}

/* ═══════════ ПЕРЕКЛЮЧЕНИЕ ВИДОВ ═══════════ */
/** Телефон: закрыть выехавший сайдбар (на десктопе шторки нет — no-op). */
function closeSideDrawer() {
  document.body.classList.remove("side-open");
  const scrim = $("side-scrim");
  if (scrim) scrim.hidden = true;
}

/** Телефон: открыть/закрыть сайдбар-шторку. */
function toggleSideDrawer() {
  const open = !document.body.classList.contains("side-open");
  document.body.classList.toggle("side-open", open);
  const scrim = $("side-scrim");
  if (scrim) scrim.hidden = !open;
}

function setView(v) {
  // Уходим из разговора — гасим опрос экрана терминала, иначе он продолжает
  // долбить сервер из фоновой вкладки.
  if (v !== "chat") stopTermPoll();
  state.view = v;
  for (const key of VIEWS) {
    const el = $(`view-${key}`);
    if (el) el.classList.toggle("hidden", key !== v);
  }
  const nav = { chat: "nav-chat", board: "nav-board", history: "nav-history", stats: "nav-stats", settings: "nav-settings", overview: "nav-overview", evidence: "nav-evidence" };
  for (const [key, id] of Object.entries(nav)) $(id)?.classList.toggle("oc-navitem--active", key === v);
  // телефонный таб-бар: та же подсветка
  for (const b of document.querySelectorAll("[data-bnav]")) {
    b.classList.toggle("oc-bnav--active", b.dataset.bnav === v);
  }
  closeSideDrawer(); // переход по вкладке закрывает шторку
  // герой-пусто — только когда нет сессии и открыт вид «Разговор»
  $("view-empty").classList.toggle("hidden", !(v === "chat" && !state.current));
  $("view-chat").classList.toggle("hidden", !(v === "chat" && state.current));
  if (v === "overview") loadOverview();
  if (v === "term") renderTerminal();
  if (v === "board") loadBoard();
  if (v === "evidence") loadEvidence();
  if (v === "history") loadHistory();
  if (v === "stats") loadStats();
  if (v === "settings") loadSettings();
}

/* ═══════════ СОЗДАНИЕ СЕССИИ (F1: читаемая двухколоночная карточка) ═══════════
   Первая колонка — список агентов читаемыми строками (иконка/имя/состояние),
   а не нечитаемый <select>. Вторая — проект, режим и задача. Любая ошибка
   валидации показывается во флоу (нет молчаливых зависаний). */
const MODE_SHORT = { cli: "Задача", web: "Веб", pty: "Терминал", persistent: "Диалог" };
const REASONING_LABEL = {
  none: "None — без рассуждений", minimal: "Minimal — минимум", low: "Low — быстро",
  medium: "Medium — баланс", high: "High — глубже", xhigh: "XHigh — ещё глубже",
  max: "Max — максимум", ultra: "Ultra — предел",
};

/** Что у агента реально работает прямо сейчас (а не что он умеет в теории). */
function agentMeta(a) {
  if (!a) return "";
  const av = a.availability;
  if (!av) return "проверяем…";
  if (!av.installed && !av.usable) return "не установлен";
  const ok = av.modes.filter((m) => m.available).map((m) => MODE_SHORT[m.mode] ?? m.mode);
  return ok.length ? ok.join(" · ") : "нет доступных режимов";
}

/** Режимы агента для селекта: доступные сверху, недоступные — видно и почему. */
function agentModes(a) {
  const av = a?.availability;
  if (!av) return [];
  const order = ["cli", "persistent", "pty", "web"];
  return order.map((id) => av.modes.find((m) => m.mode === id)).filter(Boolean);
}

async function openNewSession() {
  // Список мог устареть (проект добавлен из CLI/другой вкладки, событие ещё
  // в пути) — прежде чем звать «создайте проект», спрашиваем демон.
  // Проекты — всегда свежие (дешёвый запрос): иначе только что добавленного
  // проекта не было в списке диалога. Агентов — если их ещё нет.
  {
    const [p, a] = await Promise.all([api("/projects").catch(() => null), state.agents.length ? null : api("/agents").catch(() => null)]);
    if (Array.isArray(p)) state.projects = p;
    if (Array.isArray(a)) { state.agents = a; agentsAt = Date.now(); }
  }
  // F5: нет проекта — ведём сразу в создание проекта (без тупика «сначала…»)
  if (!state.projects.length) {
    openProjectModal(() => { toast("Проект создан — теперь выберите агента"); openNewSession(); });
    toast("Сначала нужен проект — создайте его", "err");
    return;
  }
  if (!state.agents.length) {
    toast("Агенты не загрузились — проверьте Настройки → Агенты", "err");
    return;
  }
  // Готовые к работе агенты — вверху списка и выбраны по умолчанию: открывать
  // диалог с заведомо неустановленным агентом значит начинать с тупика.
  // Порядок: сначала те, кто реально выполняет работу на этой машине (задача,
  // диалог, терминал), затем «только сайт агента», затем неустановленные.
  // Иначе вверху оказывался агент, у которого доступна лишь ссылка на сайт.
  const nsRank = (a) => {
    const modes = a.availability?.modes ?? [];
    const works = (id) => modes.some((m) => m.mode === id && m.available);
    if (works("cli") || works("persistent") || works("pty")) return 0;
    if (works("web")) return 1;
    return 2;
  };
  const nsAgents = [...state.agents].sort((a, b) => nsRank(a) - nsRank(b));
  const nsAgent = nsAgents[0]?.id;
  const nsProject = state.projects[0]?.id;
  const box = document.createElement("div");
  box.className = "oc-cmdk";
  box.id = "new-session-modal";
  box.innerHTML = `<div class="oc-cmdk__box oc-ns">
    <div class="oc-cmdk__input" style="display:block;font-weight:600">Новая сессия</div>
    <div class="oc-ns__cols">
      <div class="oc-ns__col">
        <div class="oc-ns__colhead">Агент <span class="muted small">— кто выполняет задачу</span></div>
        <div class="oc-ns__list" id="ns-agent-list">
          ${nsAgents.map((a) => `
            <button type="button" class="oc-ns__agent ${a.id === nsAgent ? "oc-ns__agent--on" : ""} ${a.availability && !a.availability.usable ? "oc-ns__agent--off" : ""}" data-ns-agent="${esc(a.id)}" ${a.availability && !a.availability.usable ? `title="${esc(a.availability.reason ?? "недоступен")}"` : ""}>
              <span class="oc-ns__agent-name">${esc(a.label ?? a.name ?? a.id)}</span>
              <span class="oc-ns__agent-meta">${esc(agentMeta(a))}${a.defaultModel ? " · " + esc(a.defaultModel) : ""}</span>
            </button>`).join("")}
        </div>
        <div class="muted small oc-ns__hint" id="ns-agent-hint"></div>
      </div>
      <div class="oc-ns__col">
        <div class="oc-ns__colhead">Проект и запуск</div>
        <label class="oc-ns__field"><span>Проект</span>
          <span class="oc-ns__projrow">
            <select id="ns-project" class="oc-input">${state.projects.map((p) => `<option value="${esc(p.id)}" ${p.id === nsProject ? "selected" : ""}>${esc(p.name)}${p.archived ? " (архив)" : ""}</option>`).join("")}<option value="__new">＋ Новый проект…</option></select>
            <button type="button" class="oc-icon-btn oc-icon-btn--tiny" id="ns-newproj" title="Создать проект прямо сейчас">＋</button>
          </span>
        </label>
        <label class="oc-ns__field"><span>Тип сессии</span>
          <select id="ns-type" class="oc-input">
            <option value="solo" selected>Solo — один агент решает задачу</option>
            <option value="swarm">Swarm — рои агентов по зонам файлов</option>
            <option value="fusion">Fusion — несколько моделей, выбор лучшего</option>
            <option value="orchestrator">Orchestrator — план с эпиками и верификацией</option>
          </select>
        </label>
        <label class="oc-ns__field"><span>Режим</span>
          <select id="ns-mode" class="oc-input"></select>
        </label>
        <div class="muted small oc-ns__hint" id="ns-mode-hint"></div>
        <label class="oc-ns__field"><span>Модель</span>
          <select id="ns-model" class="oc-input"></select>
        </label>
        <div class="muted small oc-ns__hint" id="ns-model-hint"></div>
        <label class="oc-ns__field"><span>Рассуждения</span>
          <select id="ns-reasoning" class="oc-input"></select>
        </label>
        <div class="muted small oc-ns__hint" id="ns-reasoning-hint"></div>
        <label class="oc-chip" style="cursor:pointer;align-self:flex-start">
          <input type="checkbox" id="ns-wt" checked> работать в копии проекта (безопасно)
        </label>
        <textarea id="ns-prompt" class="oc-input oc-ns__prompt" rows="4" placeholder="Задача своими словами: что должно получиться"></textarea>
        <div class="oc-ns__err hidden" id="ns-err"></div>
      </div>
    </div>
    <div class="oc-ns__foot">
      <button class="oc-btn" id="ns-cancel">Отмена</button>
      <button class="oc-btn oc-btn--primary" id="ns-go">Запустить</button>
    </div>
  </div>`;
  document.body.appendChild(box);

  const pick = (id) => {
    for (const el of document.querySelectorAll("[data-ns-agent]")) {
      const on = el.dataset.nsAgent === id;
      el.classList.toggle("oc-ns__agent--on", on);
      if (on) el.setAttribute("aria-pressed", "true"); else el.removeAttribute("aria-pressed");
    }
    const a = agentById(id);
    const av = a?.availability;
    // Состояние входа показываем ДО запуска: иначе пользователь плодит сессии,
    // каждая рисует свой код авторизации, коды конкурируют и все отваливаются
    // с «Login timed out» — ровно так и выглядел «повторный логин каждый раз».
    const auth = av?.auth;
    const authLine = !auth?.known ? ""
      : auth.signedIn
        ? `<div class="oc-ns__ok">Вход выполнен${auth.account ? ": " + esc(auth.account) : ""}</div>`
        : `<div class="oc-ns__bad">Вход в аккаунт не выполнен${auth.hint ? " — " + esc(auth.hint) : ""}</div>` +
          (auth.canLogin ? `<button type="button" class="oc-btn oc-btn--ghost oc-btn--tiny" id="ns-login">Войти один раз</button>` : "");
    $("ns-agent-hint").innerHTML = !a ? ""
      : (av && !av.usable
          ? `<span class="oc-ns__bad">${esc(trServer(av.reason ?? "агент недоступен"))}</span>${av.fix ? " — " + esc(trServer(av.fix)) : ""}`
          : `${esc(a.label ?? a.id)}${a.hint ? " — " + esc(a.hint) : ""}`) + authLine;
    const loginBtn = $("ns-login");
    if (loginBtn) loginBtn.onclick = async () => {
      const projectId = $("ns-project").value;
      if (!projectId || projectId === "__new") { showErr("Сначала выберите проект — сессия входа тоже живёт в проекте"); return; }
      const ok = await startSession(a.id, projectId, "pty", "", false, { login: true });
      if (ok !== false) close();
    };

    // ── Режимы: показываем все, но запускаемые — выбираемы, остальные видно
    //    вместе с причиной. Так пользователь понимает, чего не хватает,
    //    и при этом не может выбрать заведомо нерабочий флоу.
    const ms = $("ns-mode");
    const modes = agentModes(a);
    const uiMode = (m) => (m === "persistent" ? "acp" : m);
    const firstOk = modes.find((m) => m.available);
    ms.innerHTML = modes.length
      ? modes.map((m) => `<option value="${esc(uiMode(m.mode))}" ${m.available ? "" : "disabled"} ${m === firstOk ? "selected" : ""}>${m.available ? "" : "— "}${esc(m.label)}${m.available ? "" : " (недоступен)"}</option>`).join("")
      : `<option value="" disabled selected>нет доступных режимов</option>`;
    ms.disabled = !firstOk;
    const modeHint = () => {
      const cur = modes.find((m) => uiMode(m.mode) === ms.value);
      const el = $("ns-mode-hint");
      if (!el) return;
      // Сначала — чем режим отличается от остальных, затем предупреждение или
      // причина недоступности. Четыре способа запуска выглядят похоже, и без
      // объяснения непонятно, какой из них когда брать.
      const about = cur?.about ? `<div class="oc-ns__about">${esc(cur.about)}</div>` : "";
      el.innerHTML = !cur ? ""
        : cur.available
          ? about + (cur.warn ? `<div><span class="oc-ns__warn">${esc(cur.warn)}</span> — Настройки → Агенты → ключи</div>` : "")
          : about + `<div><span class="oc-ns__bad">${esc(trServer(cur.reason ?? "режим недоступен"))}</span>${cur.fix ? " — " + esc(trServer(cur.fix)) : ""}</div>`;
    };
    ms.onchange = modeHint;
    modeHint();

    // ── Модель: либо реальный список агента, либо честное «выбора нет».
    //    Раньше любой агент без списка показывал «default», и это выглядело
    //    как поломка списка моделей, хотя у CLI просто нет такого флага.
    const sel = $("ns-model");
    const mh = $("ns-model-hint");
    // Список моделей спрашиваем у самого агента (у kilo их больше трёхсот и
    // они зависят от аккаунта). Пока ответ не пришёл — показываем это честно.
    renderModels(a, a?.models ?? [], "registry", undefined, true);
    if (a?.id) {
      const want = a.id;
      api(`/agents/${want}/models`)
        .then((r) => { if (pickedAgent === want) renderModels(a, r.models ?? [], r.source, r.error, false); })
        .catch(() => { if (pickedAgent === want) renderModels(a, a?.models ?? [], "registry", undefined, false); });
    }

    function renderModels(ag, models, source, error, loading) {
      const cur = sel.value;
      // Первый пункт — «модель агента»: флаг не передаём, агент берёт свою
      // модель из настроек. Раньше выбиралась первая из списка, и каждая
      // сессия молча стартовала на ней (у opencode TUI ещё и падал).
      const dflt = `<option value="" ${cur ? "" : "selected"}>${esc(tr(ag?.defaultModel ? `модель агента (${ag.defaultModel})` : "модель агента по умолчанию"))}</option>`;
      sel.innerHTML = models.length
        ? dflt + models.map((m) => `<option value="${esc(m)}" ${m === cur ? "selected" : ""}>${esc(m)}</option>`).join("")
        : `<option value="">${esc(loading ? tr("спрашиваем агента…") : ag?.defaultModel ? ag.defaultModel + tr(" (модель агента)") : tr("выбор модели недоступен"))}</option>`;
      sel.disabled = !models.length;
      if (!mh) return;
      mh.textContent = loading && !models.length ? "уточняем список у агента…"
        : error ? `Агент не отдал список: ${String(error).slice(0, 120)}`
        : source === "agent" ? (lang === "ru" ? `${models.length} моделей — список получен от самого агента` : `${models.length} models — the list comes from the agent itself`)
        : models.length ? "список из настроек пульта — агент свой не публикует"
        : ag?.modelCommand ? `Модель у ${ag?.label ?? "агента"} переключается внутри него: команда ${ag.modelCommand} в терминале`
        : `${ag?.label ?? "Агент"} выбирает модель сам: в его CLI нет параметра модели`;
    }

    // Уровни рассуждений — ровно те, что принимает агент. По умолчанию флаг не
    // передаём вовсе: агент работает на своём настроенном уровне (часто это
    // high/xhigh), и пульт его не понижает. Нет флага — селект выключен.
    const rs = $("ns-reasoning");
    const levels = a?.reasoning ?? [];
    rs.innerHTML = `<option value="" selected>${esc(tr(levels.length ? "как настроено в агенте" : "агент выбирает сам"))}</option>`
      + levels.map((l) => `<option value="${esc(l)}">${esc(tr(REASONING_LABEL[l] ?? l))}</option>`).join("");
    rs.disabled = !levels.length;
    const rh = $("ns-reasoning-hint");
    // Фразы целиком, без имени агента посередине — их переводит словарь I18N
    if (rh) rh.textContent = levels.length
      ? `${tr("Без выбора агент работает на уровне из своих настроек; выбранный уровень передаётся флагом")} ${a.reasoningFlag ?? ""}`
      : tr("Уровень рассуждений этого агента задаётся в его собственных настройках");
  };
  let pickedAgent = nsAgent;
  pick(pickedAgent);
  document.querySelector("#ns-agent-list").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-ns-agent]");
    if (!btn) return;
    pickedAgent = btn.dataset.nsAgent;
    pick(pickedAgent);
  });

  const showErr = (text) => {
    const el = $("ns-err");
    el.textContent = text;
    el.classList.toggle("hidden", !text);
  };
  const close = () => box.remove();
  $("ns-cancel").onclick = close;
  box.addEventListener("click", (e) => { if (e.target === box) close(); });
  document.addEventListener("keydown", function onEsc(e) {
    if (e.key === "Escape" && document.body.contains(box)) { close(); document.removeEventListener("keydown", onEsc); }
  });
  // «＋ Новый проект…» — создаём, не закрывая модалку сессии
  const goNewProject = () => {
    openProjectModal(async (p) => {
      await loadAll();
      const sel = $("ns-project");
      if (!sel) { openNewSession(); return; }
      const opt = [...sel.options].find((o) => o.value === p?.id);
      if (opt) sel.value = p.id;
      else if (p?.id) {
        const o = document.createElement("option");
        o.value = p.id; o.textContent = p.name;
        sel.appendChild(o); sel.value = p.id;
      }
      toast("Проект создан — выбран в сессии", "ok");
    });
  };
  $("ns-newproj").onclick = goNewProject;
  $("ns-project").onchange = () => { if ($("ns-project").value === "__new") goNewProject(); };
  $("ns-go").onclick = async () => {
    const btn = $("ns-go");
    const projectId = $("ns-project").value;
    const mode = $("ns-mode").value;
    const type = $("ns-type").value;          // solo | swarm | fusion | orchestrator
    const model = $("ns-model").value || undefined;
    const reasoning = $("ns-reasoning").value || undefined;
    // ── флоу ошибки: ничего не «залипает», каждый случай объяснён ──
    if (!pickedAgent) { showErr("Выберите агента в левом списке"); return; }
    if (!projectId || projectId === "__new") { showErr("Выберите проект — или создайте новый кнопкой «＋»"); $("ns-newproj")?.focus(); return; }
    const a = agentById(pickedAgent);
    const task = $("ns-prompt").value.trim();
    const srvMode = mode === "acp" ? "persistent" : mode;
    const cur = (a?.availability?.modes ?? []).find((m) => m.mode === srvMode);
    if (!mode) { showErr(`У ${a?.label ?? "агента"} нет доступных режимов на этой машине`); return; }
    if (cur && !cur.available) { showErr(`${trServer(cur.reason ?? "режим недоступен")}${cur.fix ? ". " + trServer(cur.fix) : ""}`); return; }
    if (mode === "cli" && !task) { showErr("Опишите задачу — в CLI-режиме агент получает её текстом"); $("ns-prompt").focus(); return; }
    showErr("");
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = "Запускаем…";
    try {
      const ok = await startSession(pickedAgent, projectId, mode, task, $("ns-wt").checked, { type, model, reasoning });
      if (ok === false) { showErr(lastStartError || "Сессия не запущена"); return; }
      close();
    } finally {
      btn.disabled = false;
      if (document.body.contains(btn)) btn.textContent = label;
    }
  };
  $("ns-prompt").focus();
}

/* ═══════════ ДОБАВЛЕНИЕ ПРОЕКТА (F5+F3: кнопка работает, выбор папки) ═══════════ */
function openProjectModal(onDone) {
  const box = document.createElement("div");
  box.className = "oc-cmdk";
  box.id = "project-modal";
  // Подсказку пути берём у демона (его рабочий каталог), а не выдумываем
  // windows-путь: на Linux/macOS он был заведомо неверным.
  const guess = ""; // подставим ниже, когда демон отдаст свой корень
  box.innerHTML = `<div class="oc-cmdk__box">
    <div class="oc-cmdk__input" style="display:block;font-weight:600">Новый проект</div>
    <div style="padding:10px 16px;display:flex;flex-direction:column;gap:8px">
      <input id="pm-name" class="oc-input" placeholder="имя проекта" autocomplete="off">
      <div class="oc-ns__projrow">
        <input id="pm-path" class="oc-input" placeholder="путь к папке (создадим, если нет)" value="${guess}" autocomplete="off">
        <button type="button" class="oc-btn oc-btn--ghost" id="pm-browse" title="Выбрать папку">📁</button>
      </div>
      <div class="oc-browser hidden" id="pm-browser">
        <div class="oc-browser__bar">
          <button class="oc-btn oc-btn--ghost" id="pm-up" title="На уровень вверх">↑</button>
          <span class="oc-chip oc-chip--mono" id="pm-cur"></span>
        </div>
        <div class="oc-browser__list" id="pm-dirs"></div>
        <div class="oc-browser__bar"><button class="oc-btn oc-btn--primary" id="pm-pick">Выбрать эту папку</button></div>
      </div>
      <label class="oc-chip" style="align-self:flex-start;cursor:pointer"><input type="checkbox" id="pm-git" checked> инициализировать git (ветка main, автор dirigo)</label>
      <div class="muted small">Если папка уже git-репозиторий — используем его как есть.</div>
      <div class="oc-ns__err hidden" id="pm-err"></div>
    </div>
    <div style="display:flex;gap:8px;padding:10px 16px;justify-content:flex-end">
      <button class="oc-btn" id="pm-cancel">Отмена</button>
      <button class="oc-btn oc-btn--primary" id="pm-go">Создать</button>
    </div></div>`;
  document.body.appendChild(box);

  // ── выбор папки: листаем подкаталоги через API, не угадываем путь ──
  let browserPath = "";
  // Плейсхолдер пути берём у демона: раньше тут был жёсткий windows-путь,
  // и на Linux/macOS пользователю предлагалась несуществующая папка.
  void (async () => {
    try {
      const r = await api("/fs/dirs?path=");
      const field = $("pm-path");
      const sep = String(r.path).includes("\\") ? "\\" : "/";
      if (field && !field.value) field.placeholder = `${String(r.path).replace(/[\\/]+$/, "")}${sep}my-project`;
    } catch { /* корень не отдали — поле просто останется с общей подсказкой */ }
  })();
  const renderDirs = async (path) => {
    try {
      const r = await api(`/fs/dirs?path=${encodeURIComponent(path ?? "")}`);
      browserPath = r.path;
      $("pm-cur").textContent = r.path;
      $("pm-dirs").innerHTML = (r.parent ? `<button class="oc-browser__row" data-up="1">…</button>` : "") +
        r.dirs.map((d) => `<button class="oc-browser__row" data-dir-path="${esc(d.path)}">📁 ${esc(d.name)}</button>`).join("") ||
        `<div class="oc-empty">подкаталогов нет</div>`;
    } catch (e) { $("pm-dirs").innerHTML = `<div class="oc-empty">${esc(String(e.message ?? e))}</div>`; }
  };
  $("pm-browse").onclick = async () => {
    const vis = $("pm-browser").classList.contains("hidden");
    $("pm-browser").classList.toggle("hidden", !vis);
    // пустой path → сервер сам отдаст корень демона (кроссплатформенно)
    if (vis) await renderDirs($("pm-path").value.trim());
  };
  $("pm-up").onclick = async () => {
    const r = await api(`/fs/dirs?path=${encodeURIComponent(browserPath)}`);
    if (r.parent) await renderDirs(r.parent);
  };
  $("pm-dirs").addEventListener("click", async (e) => {
    const up = e.target.closest("[data-up]");
    if (up) { $("pm-up").click(); return; }
    const d = e.target.closest("[data-dir-path]");
    if (d) await renderDirs(d.dataset.dirPath);
  });
  $("pm-pick").onclick = () => {
    $("pm-path").value = browserPath;
    $("pm-browser").classList.add("hidden");
    if (!$("pm-name").value.trim()) $("pm-name").value = browserPath.split(/[\\/]/).filter(Boolean).pop() ?? "проект";
  };

  const pmErr = (t) => { const el = $("pm-err"); if (!el) { if (t) toast(t, "err"); return; } el.textContent = t; el.classList.toggle("hidden", !t); };
  const close = () => box.remove();
  $("pm-cancel").onclick = close;
  box.addEventListener("click", (e) => { if (e.target === box) close(); });
  document.addEventListener("keydown", function onEsc(e) {
    if (e.key === "Escape" && document.body.contains(box)) { close(); document.removeEventListener("keydown", onEsc); }
  });
  $("pm-go").onclick = async () => {
    const name = $("pm-name").value.trim() || $("pm-path").value.split(/[\\/]/).filter(Boolean).pop() || "проект";
    const path = $("pm-path").value.trim();
    // ── флоу ошибки: кнопка никогда не «молчит», причина всегда видна ──
    if (!path) { pmErr("Укажите путь к папке проекта"); return; }
    const norm = (p) => String(p).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    if (state.projects.some((p) => norm(p.path) === norm(path))) { pmErr("Такой проект уже добавлен"); return; }
    const btn = $("pm-go");
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = "Создаём…";
    pmErr("");
    let created;
    try {
      created = await api("/projects", { method: "POST", body: { name, path, gitInit: $("pm-git").checked } });
      toast(`Проект «${name}» создан`);
      close();
      await loadAll();
      onDone?.(created);
    } catch (e) { pmErr(String(e.message ?? e)); }
    finally { btn.disabled = false; if (document.body.contains(btn)) btn.textContent = label; }
  };
  $("pm-path").focus();
}

/* ═══════════ ⌘K ═══════════ */
function openCmdk() {
  $("cmdk").classList.remove("hidden");
  $("cmdk-input").value = "";
  renderCmdk("");
  $("cmdk-input").focus();
}
function closeCmdk() { $("cmdk").classList.add("hidden"); }
function renderCmdk(q) {
  const items = [];
  const query = q.trim().toLowerCase();
  const add = (it) => { if (!query || it.label.toLowerCase().includes(query)) items.push(it); };
  for (const s of state.sessions) {
    const label = s.title ?? "Без названия";
    add({ icon: "▸", label, hint: "сессия", act: () => { closeCmdk(); openSession(s.id); } });
  }
  for (const a of state.agents) add({ icon: "＋", label: `Новая сессия · ${a.label ?? a.name ?? a.id}`, hint: "создать", act: () => { closeCmdk(); openNewSession(); } });
  for (const [v, label] of [["chat", "Разговор"], ["board", "Доска"], ["history", "История"], ["stats", "Статистика"], ["settings", "Настройки"]]) {
    add({ icon: "◈", label, hint: "вид", act: () => { setView(v); closeCmdk(); } });
  }
  if (state.current) {
    for (const [act, label] of [["diff", "Показать дифф"], ["status", "git status"], ["commit", "Commit"], ["push", "Push"], ["merge", "Merge → main"], ["checks", "Прогнать проверки"], ["stop", "Стоп сессию"]]) {
      add({ icon: "⚙", label, hint: "сессия", act: async () => {
        closeCmdk();
        if (act === "diff") { setRightTab("changes"); loadDiff(); }
        else if (act === "checks") runChecks();
        else if (act === "stop") stopSession();
        else if (act === "commit") { const m = prompt("Сообщение коммита:", "dirigo: правки агента"); if (m) gitAction("commit", { message: m }); }
        else gitAction(act);
      } });
    }
  }
  $("cmdk-list").innerHTML = items.slice(0, 12).map((it, i) => `<button class="oc-cmdk__item ${i === 0 ? "oc-cmdk__item--sel" : ""}" data-cmdk="${i}">${it.icon} ${esc(it.label)}<small>${it.hint}</small></button>`).join("") || `<div class="oc-empty">ничего не найдено</div>`;
  $("cmdk-list").querySelectorAll("[data-cmdk]").forEach((el, i) => { el.onclick = () => items[i]?.act(); });
}

/* ═══════════ СОБЫТИЯ ═══════════ */
function wire() {
  // Поле в Настройках, которое человек уже изменил, асинхронные загрузчики не
  // перезаписывают (ответ сервера приходил позже ввода и стирал набранное).
  document.addEventListener("input", (e) => {
    const el = e.target;
    if (el && el.closest && el.closest("#view-settings")) el.dataset.dirty = "1";
  }, true);
  // sidebar
  $("side-collapse").onclick = () => {
    state.collapsed = !state.collapsed;
    $("app").classList.toggle("oc-app--collapsed", state.collapsed);
    localStorage.setItem("dirigo-side", state.collapsed ? "1" : "");
  };
  if (localStorage.getItem("dirigo-side")) $("side-collapse").click();
  $("offline-retry")?.addEventListener("click", () => { void loadAll(); });

  $("ev-verify")?.addEventListener("click", async () => {
    try {
      const r = await api("/evidence/verify");
      toast(r.ok
        ? `${tr("Проверено")}: ${packCount(r.packs)}, ${tr("нарушений нет")}`
        : `${tr("Нарушения целостности")}: ${(r.badSignatures ?? []).length} ${tr("подписей")}, ${(r.brokenLedgers ?? []).length} ${tr("журналов")}`,
        r.ok ? "ok" : "err");
      loadEvidence();
    } catch (e) { toast(String(e.message ?? e), "err"); }
  });

  $("ev-export")?.addEventListener("click", () => {
    // выгрузка идёт как файл: браузер сам предложит сохранить
    window.open("/api/evidence/bundle", "_blank");
  });

  // Глобальная делегация: стартовые карточки, шторка сайдбара, нижний таб-бар,
  // раскрывашка тем. Раньше эти обработчики жили внутри слушателя правой панели
  // и не срабатывали — клики до них просто не доходили.
  document.addEventListener("click", (e) => {
    const bnav = e.target.closest?.("[data-bnav]");
    if (bnav) {
      if (bnav.dataset.bnav === "side") toggleSideDrawer();
      else setView(bnav.dataset.bnav);
      return;
    }
    if (e.target.id === "side-scrim") { closeSideDrawer(); return; }
    if (e.target.closest?.("[data-restart-session]") && state.current) {
      api(`/sessions/${state.current}/restart`, { method: "POST" })
        .then(() => toast("Сессия перезапущена", "ok"))
        .catch((err) => toast(String(err.message ?? err), "err"));
      return;
    }
    const pick = e.target.closest?.("[data-choice-pick]");
    if (pick && state.current) {
      const btn = pick;
      btn.disabled = true;
      api(`/sessions/${state.current}/choice`, { method: "POST", body: { choiceId: btn.dataset.choiceId, optionId: btn.dataset.choicePick } })
        .then(() => { toast("Ответ отправлен агенту", "ok"); refreshCurrent(); })
        .catch((err) => { btn.disabled = false; toast(String(err.message ?? err), "err"); });
      return;
    }
    const copyAuth = e.target.closest?.("[data-copy-auth]");
    if (copyAuth) {
      navigator.clipboard?.writeText(copyAuth.dataset.copyAuth)
        .then(() => toast("Ссылка входа скопирована", "ok"))
        .catch(() => toast("Не удалось скопировать — ссылка есть в экране терминала", "err"));
      return;
    }
    const act = e.target.closest?.("[data-act]")?.dataset.act;
    if (act === "go-setup") { setView("settings"); return; }
    if (act === "new-session") { openNewSession(); return; }
    if (act === "add-project") { openProjectModal(); return; }
    if (act === "theme-more") {
      const btn = e.target.closest("[data-act='theme-more']");
      renderThemeDots(btn.textContent.trim() === "Ещё темы");
      return;
    }
  });

  $("cmdk-btn").onclick = openCmdk;
  $("nav-new").onclick = openNewSession;
  for (const [v, id] of [["chat", "nav-chat"], ["overview", "nav-overview"], ["board", "nav-board"], ["evidence", "nav-evidence"], ["history", "nav-history"], ["stats", "nav-stats"], ["settings", "nav-settings"]]) $(id)?.addEventListener("click", () => setView(v));

  // тема: селект в сайдбаре + сохранение (инлайн-блок в index.html применит до отрисовки)
  const sel = $("theme-select");
  if (sel) {
    // Селект перестраиваем из каталога: основные сверху, остальные — группой.
    const opt = ([t, l]) => `<option value="${t}">${l}</option>`;
    sel.innerHTML = THEME_CORE.map(opt).join("")
      + `<optgroup label="Ещё">` + THEME_EXTRA.map(opt).join("") + `</optgroup>`;
    sel.value = document.documentElement.dataset.theme || "modern-light";
    sel.onchange = () => {
      document.documentElement.dataset.theme = sel.value;
      localStorage.setItem("dirigo-theme", sel.value);
      for (const el of document.querySelectorAll(".oc-themedot")) el.classList.toggle("oc-themedot--active", el.dataset.theme === sel.value);
      applyTermTheme();
      toast(`Тема: ${sel.options[sel.selectedIndex]?.text ?? sel.value}`);
    };
  }

  // добавить проект
  $("add-project").onclick = openProjectModal;

  // обзор: клик по карточке → шёлкнуться в проект (History этого проекта) + обновление
  $("ov-refresh")?.addEventListener("click", () => loadOverview());
  $("ov-cards")?.addEventListener("click", (e) => {
    const card = e.target.closest("[data-ovproj]");
    if (!card) return;
    const proj = state.projects.find((p) => p.id === card.dataset.ovproj);
    if (!proj) return;
    setView("history");
    const sel = $("history-project") ?? null;
    if (sel) { sel.value = proj.path; loadHistory(); }
    toast(`Проект «${proj.name}» — история`);
  });

  // список сессий (делегирование): сворачивание групп, архив, удаление
  $("sessions-scroll").addEventListener("click", async (e) => {
    const arch = e.target.closest("[data-proj-archive]");
    if (arch) {
      const pid = arch.dataset.projArchive;
      const p = state.projects.find((x) => x.id === pid);
      const wasArchived = !!p?.archived;
      try {
        await api(`/projects/${pid}/${wasArchived ? "unarchive" : "archive"}`, { method: "POST" });
        toast(wasArchived ? `Проект «${p?.name}» возвращён из архива` : `Проект «${p?.name}» в архиве — сессии на месте`, "ok");
        loadAll();
      } catch (err) { toast(String((err).message ?? err), "err"); }
      return;
    }
    const del = e.target.closest("[data-proj-del]");
    if (del) {
      const pid = del.dataset.projDel;
      const p = state.projects.find((x) => x.id === pid);
      const sessions = state.sessions.filter((s) => s.projectId === pid).length;
      // двойное подтверждение с составом потерь
      if (!(await ocConfirm(`Удалить проект «${p?.name ?? pid}»?\nВместе с ним удалятся сессии: ${sessions} шт. (копии на диске останутся до ручной уборки).`, { ok: tr("Удалить"), danger: true }))) return;
      if (!(await ocConfirm(`Точно удалить? Действие необратимо.\nПуть: ${p?.path ?? "-"}`, { ok: tr("Удалить навсегда"), danger: true }))) return;
      try {
        await api(`/projects/${pid}`, { method: "DELETE" });
        toast(`Проект «${p?.name}» и его сессии (${sessions}) удалены`, "ok");
        if (state.current && state.sessions.some((s) => s.id === state.current && s.projectId === pid)) {
          state.current = null; state.tabs = [];
        }
        loadAll();
      } catch (err) { toast(String((err).message ?? err), "err"); }
      return;
    }
    const group = e.target.closest("[data-group]");
    if (group) {
      const id = group.dataset.group;
      state.projectCollapsed.has(id) ? state.projectCollapsed.delete(id) : state.projectCollapsed.add(id);
      renderSidebar(); return;
    }
    const sesArch = e.target.closest?.("[data-ses-archive]");
    if (sesArch) {
      e.stopPropagation();
      api(`/sessions/${sesArch.dataset.sesArchive}/archive`, { method: "POST" })
        .then(() => { toast("Сессия в архиве", "ok"); loadAll(); })
        .catch((err) => toast(String(err.message ?? err), "err"));
      return;
    }
    const sesDel = e.target.closest?.("[data-ses-del]");
    if (sesDel) {
      e.stopPropagation();
      // Удаление необратимо и уносит журнал с доказательствами — спрашиваем.
      if (!(await ocConfirm(tr("Удалить сессию вместе с её журналом и доказательствами? Отменить будет нельзя."), { ok: tr("Удалить"), danger: true }))) return;
      api(`/sessions/${sesDel.dataset.sesDel}`, { method: "DELETE" })
        .then(() => {
          const id = sesDel.dataset.sesDel;
          state.tabs = state.tabs.filter((t) => t.id !== id);
          if (state.current === id) { state.current = null; stopTermPoll(); }
          toast("Сессия удалена", "ok");
          loadAll(); renderTabs();
        })
        .catch((err) => toast(String(err.message ?? err), "err"));
      return;
    }
    const ses = e.target.closest("[data-ses]");
    if (ses) openSession(ses.dataset.ses);
  });

  // табы: сессии + терминалы (V6-5)
  $("tabs-scroll").addEventListener("click", (e) => {
    const tclose = e.target.closest("[data-termclose]");
    if (tclose) { termKill(tclose.dataset.termclose); return; }
    const ttab = e.target.closest("[data-termtab]");
    if (ttab) {
      const id = ttab.dataset.termtab;
      state.term = id;
      setView("term");
      return;
    }
    const close = e.target.closest("[data-close]");
    if (close) {
      state.tabs = state.tabs.filter((t) => t.id !== close.dataset.close);
      if (state.current === close.dataset.close) state.current = state.tabs.at(-1)?.id ?? null;
      renderTabs(); refreshCurrent(); return;
    }
    const tab = e.target.closest("[data-tab]");
    if (tab) openSession(tab.dataset.tab);
  });

  // composer
  $("composer").addEventListener("submit", (e) => { e.preventDefault(); sendPrompt(); });
  $("prompt").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendPrompt(); } });
  $("prompt").addEventListener("input", () => renderContext());
  $("mic-btn").onclick = toggleVoice;
  renderContext();
  renderLangSelect();

  // правая панель
  $("rtab-changes").onclick = () => setRightTab("changes");
  $("rp-collapse").onclick = () => setRightMini(true);
  $("rp-expand").onclick = () => setRightMini(false);
  $("rp-rail").addEventListener("click", (e) => {
    const b = e.target.closest("[data-rail]");
    if (b) { setRightMini(false); setRightTab(b.dataset.rail); }
  });
  $("rail-editor").onclick = openInEditor;
  try { state.rightMini = localStorage.getItem("dirigo-right") === "mini"; } catch { /* */ }
  new MutationObserver(syncRightLayout).observe($("right-panel"), { attributes: true, attributeFilter: ["class"] });
  syncRightLayout();
  $("rtab-files").onclick = () => setRightTab("files");
  $("rtab-term").onclick = () => setRightTab("term");
  // терминалы (V6-5)
  $("term-add").onclick = termCreate;
  $("term-hide").onclick = () => setRightTab("changes");
  $("term-kill").onclick = () => { if (state.term) termKill(state.term); };
  $("term-clear").onclick = () => { xtShell?.term.clear(); xtShell?.term.focus(); };
  $("term-list").addEventListener("click", (e) => {
    const open = e.target.closest("[data-term-open]");
    if (open) { state.term = open.dataset.termOpen; setView("term"); renderTabs(); return; }
    const kill = e.target.closest("[data-term-kill]");
    if (kill) termKill(kill.dataset.termKill);
  });
  $("btn-commit").onclick = () => gitAction("commit", { message: $("commit-msg").value.trim() || "dirigo: правки агента" });
  $("btn-push").onclick = () => gitAction("push");
  $("btn-pr").onclick = () => gitAction("pr");
  $("btn-merge").onclick = async () => { if (await ocConfirm(tr("Влить изменения в main?"), { ok: "Merge" })) gitAction("merge", { into: "main", confirmed: true }); };
  $("btn-apply").onclick = async () => { if (await ocConfirm(tr("Применить изменения копии в рабочий проект?"), { ok: tr("Применить") })) applyChanges(); };
  $("btn-revert").onclick = async () => { if (await ocConfirm(tr("Вернуть копию к точке возврата? Правки агента будут отброшены."), { ok: tr("Вернуть"), danger: true })) revertChanges(); };
  $("btn-open-editor").onclick = openInEditor;
  $("rp-gitinit").addEventListener("click", (e) => { const b = e.target.closest("[data-act='git-init']"); if (b) gitInitProject(b.dataset.project); });
  $("rp-staged").addEventListener("click", (e) => {
    const cg = e.target.closest("[data-cgroup]");
    if (cg) {
      const key = `c:${cg.dataset.cgroup}`;
      state.projectCollapsed.has(key) ? state.projectCollapsed.delete(key) : state.projectCollapsed.add(key);
      renderChanges(); return;
    }
    const f = e.target.closest("[data-file]");
    if (f) showFileDiff(f.dataset.file);
    const act = e.target.closest("[data-act='diff-all']");
    if (act) showAllDiff();
  });
  // группа «Проверки» в правой панели — тоже сворачиваемая
  $("rp-checks").addEventListener("click", (e) => {
    const cg = e.target.closest("[data-cgroup]");
    if (!cg) return;
    const key = `c:${cg.dataset.cgroup}`;
    state.projectCollapsed.has(key) ? state.projectCollapsed.delete(key) : state.projectCollapsed.add(key);
    renderChanges();
  });
  $("file-modal-close").onclick = closeFileView;
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (state.view === "file") { closeFileView(); return; }
      closeCmdk();
    }
  });
  $("file-tree").addEventListener("click", (e) => {
    const dir = e.target.closest("[data-dir]");
    if (dir) {
      const key = `d:${dir.dataset.dir}`;
      state.expanded.has(key) ? state.expanded.delete(key) : state.expanded.add(key);
      renderFileTree(); return;
    }
    const open = e.target.closest("[data-open]");
    if (open) openFileView(open.dataset.open);
  });

  // доска/история
  $("board-project").onchange = loadBoard;
  $("history-project").onchange = loadHistory;
  $("history-pane").addEventListener("click", (e) => {
    const restore = e.target.closest("[data-act='restore']");
    if (restore) { restoreTo(restore.dataset.sha); return; }
    // «Показать дифф» — предпросмотр коммита по центру (как файл в Изменениях)
    const diff = e.target.closest("[data-act='diff']");
    if (diff) { showCommitDiff(diff.dataset.sha); return; }
    const row = e.target.closest("[data-sha]");
    if (row) { state.histOpenSha = state.histOpenSha === row.dataset.sha ? null : row.dataset.sha; renderHistory(); }
  });
  $("board-cols").addEventListener("click", (e) => {
    const card = e.target.closest("[data-taskid]");
    if (!card) return;
    const id = card.dataset.taskid;
    const kind = card.dataset.taskkind;
    // F6: клик по карточке ведёт к сущности, а не в пустоту
    if (kind === "session") {
      setView("chat");
      openSession(id);
      return;
    }
    if (kind === "plan") {
      api(`/plans/${id}`)
        .then((p) => toast(`${p.goal ?? "План"}: эпиков ${(p.epics ?? []).length}, статус ${p.status ?? "draft"}`, "info"))
        .catch((err) => toast(String(err.message ?? err), "err"));
      return;
    }
    if (kind === "swarm") {
      api(`/swarm/${id}`)
        .then((s) => toast(`${s.title ?? "Swarm"}: ${s.state ?? s.status ?? "—"}`, "info"))
        .catch((err) => toast(String(err.message ?? err), "err"));
      return;
    }
    if (kind === "fusion") {
      api(`/fusion/${id}`)
        .then((f) => toast(`${f.question ?? f.title ?? "Fusion"}: ${f.state ?? f.status ?? "—"}`, "info"))
        .catch((err) => toast(String(err.message ?? err), "err"));
    }
  });

  // темы (делегирование в настройках) — все 28 оформлений
  $("settings-pane").addEventListener("click", (e) => {
    // только кружки тем: голый [data-theme] ловил и сам <html data-theme>
    const dot = e.target.closest(".oc-themedot[data-theme]");

    if (dot) {
      document.documentElement.dataset.theme = dot.dataset.theme ?? '';
      localStorage.setItem("dirigo-theme", dot.dataset.theme ?? '');
      for (const el of document.querySelectorAll(".oc-themedot")) el.classList.toggle("oc-themedot--active", el === dot);
      const sel = $("theme-select") ;
      if (sel) sel.value = dot.dataset.theme ?? '';
      applyTermTheme();
    }
  });

  // ⌘K
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openCmdk(); }
    if (e.key === "Escape") closeCmdk();
  });
  $("cmdk").addEventListener("click", (e) => { if (e.target === $("cmdk")) closeCmdk(); });
  $("cmdk-input").addEventListener("input", (e) => renderCmdk(e.target.value));
}

/* «Открыть в редакторе»: просим сервер открыть папку (V5-9, без «Браузера») */
async function openInEditor() {
  if (!state.current) { toast("Откройте сессию", "err"); return; }
  try {
    const r = await api("/open-editor", { method: "POST", body: { sessionId: state.current } });
    toast(r.detail ?? "Открываю…", r.ok ? "ok" : "err");
  } catch (e) { toast(String(e.message ?? e), "err"); }
}

/* ═══════════ СТАРТ ═══════════ */
wire();
applyI18n();
loadAll();
applyTermTheme(); // демон узнаёт тему пульта: агенты в терминале подстроят палитру
// SSE: живые обновления сессий
try {
  const es = new EventSource("/api/events");
  es.onmessage = (e) => {
    try {
      const ev = JSON.parse(e.data);
      if (ev.type === "message" && ev.sessionId === state.current) refreshCurrent();
      // ответ живого диалога приходит кусками — показываем по мере поступления
      if (ev.type === "message.upsert" && ev.sessionId === state.current) refreshSoon();
      if (ev.type === "session.activity" && ev.sessionId === state.current && state.view === "chat") renderActivity(ev.sessionId, ev.activity);
      if (ev.type === "session.status" || ev.type === "sessions.changed") loadAllSoon();
      // терминалы (V6-5): экран идёт своим потоком (xterm.js), здесь — только список
      if (ev.type === "terminals.changed") {
        api("/terminals").then((r) => {
          state.terminals = (r.terminals ?? []).map((t) => ({ id: t.id, name: t.name, dir: t.dir }));
          if (state.term && !state.terminals.some((t) => t.id === state.term)) {
            state.term = state.terminals.at(-1)?.id ?? null;
            if (state.view === "term") { state.term ? renderTerminal() : setView("chat"); }
          }
          renderTermList(); renderTabs();
        }).catch(() => {});
      }
    } catch { /* */ }
  };
} catch { /* */ }
// правая панель и виды живут своей жизнью: дифф, дерево, доска — как в v2
setInterval(() => {
  if (state.view === "chat" && state.current) {
    loadDiff();
    if (state.rightTab === "files") loadFiles();
    refreshCurrent();
  }
  if (state.view === "board") loadBoard({ poll: true });
  if (state.view === "history") loadHistory();
}, 5000);
setView("chat");
