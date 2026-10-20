// dirigo-site — статический гейт лендинга. Запуск: bun run tests/site-check.ts
//
// Проверяет:
//   1. служебное (кодировка, meta, og, favicon, lang);
//   2. целостность: локальные ассеты существуют, якоря резолвятся, теги сбалансированы;
//   3. приватность: НИ ОДНОГО внешнего сетевого запроса в разметке, CSS и JS
//      (сайт обязан открываться офлайн; <a href> наружу — не запрос, разрешены);
//   4. честность: нет старого имени продукта, нет имён конкурентов,
//      Enterprise-блок говорит «private beta», roadmap-пункты имеют бейдж;
//   5. структура и ключевые смыслы новой страницы;
//   6. двуязычие: у каждого data-i18n есть перевод в словаре app.js;
//   7. сборка app.js и наличие базовых правил доступности в CSS.
import { existsSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const INDEX = join(ROOT, "index.html");
const html = await Bun.file(INDEX).text();
const css = await Bun.file(join(ROOT, "assets/style.css")).text();
const js = await Bun.file(join(ROOT, "assets/app.js")).text();
const low = html.toLowerCase();

type Check = { name: string; ok: boolean; detail: string };
const results: Check[] = [];
const rec = (name: string, ok: boolean, detail = "") => results.push({ name, ok, detail });

/* ------------------------------ 1. служебное ------------------------------ */

const bytes = new Uint8Array(await Bun.file(INDEX).arrayBuffer());
const hasBom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
rec("UTF-8 без BOM", !hasBom, hasBom ? "файл начинается с BOM" : "");
const head = await Bun.file(INDEX).slice(0, 200).text();
rec("charset=utf-8 объявлен", /charset=["']?utf-8/i.test(head));
rec("title не пустой", /<title>[^<]{10,}<\/title>/.test(html));
rec("meta description", /name="description"\s+content="[^"]{80,}"/.test(html.replace(/\s+/g, " ")));
rec("lang=ru", /<html lang="ru"/.test(html));
rec("viewport", /name="viewport"/.test(html));
rec("og:image задан", /property="og:image"\s+content="[^"]+"/.test(html));
rec("twitter:card задан", /name="twitter:card"/.test(html));
rec("favicon задан", /rel="icon"/.test(html));
rec("JSON-LD валиден", (() => {
  const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  if (!m) return false;
  try { JSON.parse(m[1]); return true; } catch { return false; }
})());

/* --------------------------- 2. целостность ссылок --------------------------- */

const refs = [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map((m) => m[1]);
const local = refs.filter((r) => !/^(#|https?:|mailto:|data:|tel:)/.test(r));
const missing = local.filter((r) => !existsSync(join(ROOT, r)));
rec("все локальные ассеты существуют", missing.length === 0, missing.join(", ") || `${local.length} ссылок`);

const anchors = [...new Set([...html.matchAll(/<a[^>]*\shref="#([^"]+)"/g)].map((m) => m[1]))];
const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
const dead = anchors.filter((a) => a && !ids.has(a));
rec("все якоря резолвятся", dead.length === 0, dead.map((d) => "#" + d).join(",") || `${anchors.length} якорей`);

for (const tag of ["html", "head", "body", "main", "footer", "section", "header"]) {
  const open = (html.match(new RegExp(`<${tag}[\\s>]`, "g")) ?? []).length;
  const close = (html.match(new RegExp(`</${tag}>`, "g")) ?? []).length;
  rec(`баланс <${tag}>`, open === close, `${open}/${close}`);
}
rec("<main> не вложен сам в себя", (html.match(/<main[\s>]/g) ?? []).length === 1, "ровно один <main>");

/* ------------------- 3. приватность: ноль внешних запросов ------------------- */

const external: string[] = [];
for (const m of html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)) if (/^(https?:)?\/\//.test(m[1])) external.push("script: " + m[1]);
for (const m of html.matchAll(/<link[^>]*href="([^"]+)"[^>]*>/g)) {
  if (/rel=["'](stylesheet|preload|prefetch|dns-prefetch|preconnect)["']/.test(m[0]) && /^(https?:)?\/\//.test(m[1])) external.push("link: " + m[1]);
}
for (const tag of ["img", "iframe", "video", "audio", "source", "track", "embed", "object"]) {
  for (const m of html.matchAll(new RegExp(`<${tag}[^>]*\\s(?:src|data)="([^"]+)"`, "g"))) {
    if (/^(https?:)?\/\//.test(m[1])) external.push(`${tag}: ${m[1]}`);
  }
}
for (const m of html.matchAll(/<form[^>]*\saction="([^"]+)"/g)) external.push("form action: " + m[1]);
rec("разметка: нет внешних загрузок", external.length === 0, external.join(", ") || "все ассеты локальные");

const cssExternal = [...css.matchAll(/url\(\s*["']?(https?:)?\/\//g)].map((m) => m[0]);
rec("CSS: нет url() наружу", cssExternal.length === 0, cssExternal.join(", ") || "только локальные url()");
rec("CSS: нет @import", !/@import/.test(css));

const jsNet = [
  [/\bfetch\s*\(/, "fetch("],
  [/XMLHttpRequest/, "XMLHttpRequest"],
  [/new\s+WebSocket/, "WebSocket"],
  [/importScripts/, "importScripts"],
  [/navigator\.sendBeacon/, "sendBeacon"],
  [/https?:\/\/(?!github\.com|www\.w3\.org)/, "внешний http(s)-адрес"],
] as const;
// единственное разрешённое — свои метрики на том же origin (serve.ts /api/event)
const jsOwn = js.replace(/navigator\.sendBeacon && /g, "").replace(/navigator\.sendBeacon\("\/api\/event"/g, "").replace(/fetch\("\/api\/event"/g, "");
const jsHits = jsNet.filter(([re]) => re.test(jsOwn)).map(([, n]) => n);
rec("JS: сеть — только свои метрики /api/event, внешних адресов нет", jsHits.length === 0, jsHits.join(", ") || "offline-friendly");
rec("нет трекеров и аналитики", !/gtag|googletagmanager|yandex\.metrika|ym\(|analytics|hotjar|plausible|posthog/i.test(html + js));

/* ---------------------------- 4. честность текстов ---------------------------- */

// «Orchestra» как старое имя продукта; режим Orchestrator — легальное слово. scan-ok
// scan-ok: стоп-лист проверки, а не текст страницы.
const oldNameHits = [
  ...html.matchAll(/orchestra(?!tor)/gi),
  ...js.matchAll(/orchestra(?!tor)/gi),
  ...css.matchAll(/orchestra(?!tor)/gi),
].map((m) => m[0]);
rec("нет старого имени продукта (Orchestra)", oldNameHits.length === 0, oldNameHits.slice(0, 5).join(", "));
rec("нет артефактов переименования (Dirigotor)", !/dirigotor/i.test(html + js + css));
rec("режим Orchestrator на месте", /data-mode="orchestrator"/.test(html) && />Orchestrator</.test(html));

// scan-ok: стоп-лист проверки, а не текст страницы.
const COMPETITORS = [
  "paseo", "vibeforge", "vibe-forge", "vibechestra", "vibe kanban", "claude squad", // scan-ok
  "aichestra", "nimbalyst", "omnara", "sculptor", "kestra", "orkes", "conductor",
];
const compHits = COMPETITORS.filter((c) => (low + js.toLowerCase() + css.toLowerCase()).includes(c));
rec("нет имён конкурентов", compHits.length === 0, compHits.join(", "));
rec("нет ссылок на vibe-forge.ru", !/vibe-?forge\.ru/i.test(html + js + css));

// Enterprise: только private beta, без обещания готового GDPR/PII-продукта
const entBlock = (html.match(/<div class="price price--beta[\s\S]*?<\/form>/) ?? [""])[0];
rec("Enterprise-блок найден", entBlock.length > 400, `${entBlock.length} символов`);
rec("Enterprise: «private beta»", /private beta/i.test(entBlock));
rec("Enterprise: «design-партнёр»", /design-партнёр/i.test(entBlock));
// 19.10: формулировки нейтральные — «по запросу», «в разработке с design-партнёрами»,
// без «этого ещё нет / не построено / не код»
rec("Enterprise: «по запросу» и «с design-партнёрами»", /по запросу/i.test(entBlock) && /design-партнёр/i.test(entBlock));
rec("Enterprise: без «пока нет / не построено / не код»", !/пока нет|не построен|а не код|назовём цену/i.test(entBlock));
rec("Enterprise: есть форма контакта", /<form[^>]+id="entForm"/.test(html) && /type="email"/.test(entBlock));
// шлюз и провенанс построены — они больше не в списке «не построено»;
// непостроенным остаётся только слой, который проектируется с партнёрами.
rec("Enterprise: открытая часть перечислена (шлюз, журнал)",
  /в открытой части/i.test(entBlock) && /шлюз персональных данных/i.test(entBlock));
rec("Enterprise: слой назван — SSO, SCIM, SLA",
  /SSO/.test(entBlock) && /SCIM/.test(entBlock) && /SLA/.test(entBlock));
const soonBox = (html.match(/<div class="note-box[\s\S]*?<\/div>/) ?? [""])[0];
rec("note-box: шлюз и журнал — в открытой части, Enterprise — по запросу",
  /входят в открытую часть/i.test(soonBox) && /по запросу/i.test(soonBox) && /SSO/.test(soonBox) && !/не построен/i.test(soonBox));
// страница не говорит «пользователей нет», «ничего не отправляет», «трекеров нет»
rec("нет «пользователей нисколько / нет звёзд»", !/нисколько|нет ни звёзд|none so far|no stars/i.test(html + js));
rec("форма без «ничего никуда не отправляет / ни трекеров»", !/ничего никуда не отправляет|ни трекеров|no trackers|sends nothing by itself/i.test(html + js));
// шлюз персональных данных построен, но соответствие GDPR мы не обещаем
rec("GDPR не заявлен готовым", !/gdpr[^<]{0,60}(готов|ready|compliant|available)/i.test(html + js));
rec("пакет не продаётся как «сертификат»", !/сертифик|certified/i.test(low));

// 19.10: спрайт иконок не display:none — иначе градиенты не рисуются и в светлой
// теме значки агентов пропадают; иконки в кнопках не сжимаются (пустая кнопка GitHub)
rec("спрайт иконок не скрыт через display:none", !/<svg[^>]*style="display:none"/.test(html));
rec("иконки в кнопках не сжимаются flex-раскладкой", /.btn svg { flex: none; }/.test(css));
// любой roadmap-пункт обязан нести видимый бейдж «скоро»
rec("roadmap помечен бейджем", /class="badge badge--soon"/.test(html) && /badge--soon/.test(css));
rec("бейдж «скоро» переводится", /"badge\.soon"/.test(js));

// запрещённые выдуманные социальные доказательства
rec("нет выдуманных метрик пользователей", !/(\d[\d\s]{2,})\s*(пользовател|users|компани|customers|звёзд|stars)/i.test(html));
rec("нет отзывов и логотипов клиентов", !/testimonial|отзыв клиент|нам доверяют|trusted by/i.test(low));
// Число «581» получено на Windows с установленными агентами и на чистой
// машине не воспроизводится — на странице его быть не должно.
const gateNumbers = /\b(445|581)\s*(провер|check|тест|test)/i.test(html + js) || /"(445|581)"/.test(js);
rec("нет невоспроизводимых цифр гейта (445/581)", !gateNumbers);
rec("счёт сьютов на месте", /\d{2}\s*тест-сьют|\d{2}\s*test suites/i.test(html + js));
rec("лицензия MIT согласована", /MIT/.test(html) && !/Apache-2\.0/i.test(html + js));

/* --------------------------- 5. структура страницы --------------------------- */

for (const id of ["top", "problem", "how", "edge", "evidence", "gateway", "knowledge",
  "modes", "agents", "remote", "security", "download", "pricing", "enterprise", "faq"]) {
  rec(`раздел #${id}`, ids.has(id));
}
for (const word of [
  "dirigo", "solo", "swarm", "fusion", "orchestrator",
  "worktree", "cloudflare", "tailscale", "pwa", "provisioning",
  "ревью", "изолирован", "59 наборов тестов", "13 агентов", "mit",
  "ed25519", "пакет доказательств", "провенанс", "хеш промпта",
  "шлюз персональных данных", "база знаний",
]) {
  rec(`ключевое слово «${word}»`, low.includes(word));
}
rec("позиционирование в hero: запись пишется в момент генерации",
  /запись о том, кто написал каждую строку/i.test(low) && /внутри цикла генерации/i.test(low));
rec("hero: запись нельзя собрать постфактум", /по готовому коммиту такую запись уже не собрать/i.test(low));
rec("проблема сформулирована", /один агент уже не вывозит/i.test(low) && /в тот же проект не запустить/i.test(low));
rec("три шага «как работает»", (html.match(/class="clip__step"/g) ?? []).length === 3);
rec("три отличия", (html.match(/class="edge[ "]/g) ?? []).length === 3);
rec("третье отличие — провенанс", /data-i18n="edge\.c3h"/.test(html) && /провенанс/i.test(low));
/* ------------- 5b. провенанс: пакет, трейлеры, шлюз, база знаний ------------- */

const sectionAt = (id: string) => html.indexOf(`id="${id}"`);
rec("#evidence стоит сразу после #edge",
  sectionAt("edge") < sectionAt("evidence") && sectionAt("evidence") < sectionAt("modes"),
  `edge=${sectionAt("edge")} evidence=${sectionAt("evidence")} modes=${sectionAt("modes")}`);
rec("#gateway стоит между #evidence и #modes",
  sectionAt("evidence") < sectionAt("gateway") && sectionAt("gateway") < sectionAt("modes"));

const evi = (html.match(/<section[^>]*id="evidence"[\s\S]*?<\/section>/) ?? [""])[0];
rec("раздел доказательств найден", evi.length > 1500, `${evi.length} символов`);
rec("состав пакета перечислен (≥ 8 пунктов)",
  (evi.match(/data-i18n="evi\.l\d+"/g) ?? []).length >= 8,
  `${(evi.match(/data-i18n="evi\.l\d+"/g) ?? []).length} пунктов`);

const TRAILERS = ["Dirigo-Agent", "Dirigo-Model", "Dirigo-Checks", "Dirigo-Returned-To-Agent", "Dirigo-Ledger-Head"];
for (const t of TRAILERS) rec(`трейлер ${t} показан`, evi.includes(t));
rec("git log собран из разметки, а не скриншот", /class="term term--log"/.test(evi) && !/<img/.test(evi));
rec("подпись Ed25519 названа", /ed25519/i.test(evi.toLowerCase()));
rec("обнаружение подделки заявлено явно",
  /подделк/i.test(evi.toLowerCase()) && /цепочк/i.test(evi.toLowerCase()));
rec("выгрузка для аудита одним файлом", /выгрузка для аудита/i.test(evi.toLowerCase()) && /json/i.test(evi));
rec("проверка пакета без наших инструментов", /без наших инструментов/i.test(evi.toLowerCase()));

const pii = (html.match(/<section[^>]*id="gateway"[\s\S]*?<\/section>/) ?? [""])[0];
rec("раздел шлюза найден", pii.length > 1200, `${pii.length} символов`);
for (const mode of ["off", "warn", "redact", "block"]) {
  rec(`режим шлюза «${mode}»`, new RegExp(`<span class="card__num">${mode}</span>`).test(pii));
}
rec("шлюз стоит ДО отправки агенту", /до отправки/i.test(pii.toLowerCase()));
// 1.9.1: проверяется и код, который агент написал, — до применения и коммита
rec("шлюз проверяет код агента до «Применить» и коммита", /строка, которую агент добавил в код/i.test(pii.toLowerCase()) && /до «применить» и коммита/i.test(pii.toLowerCase()));
rec("принцип: найденные значения не хранятся",
  /не сохраняются нигде/i.test(pii.toLowerCase()) && /тип находки и количество/i.test(pii.toLowerCase()));
rec("база знаний: периметр и шлюз",
  /data-i18n="kb\.h"/.test(pii) && /внутри вашего периметра/i.test(pii.toLowerCase()) &&
  /проходит через шлюз/i.test(pii.toLowerCase()));

// карточка пакета в блоке отличий — собственная разметка, не картинка
const pack = (html.match(/<div class="pack"[\s\S]*?<\/dl>/) ?? [""])[0];
rec("карточка пакета собрана из разметки", pack.length > 400 && !/<img/.test(pack));
rec("карточка пакета: печать целостности", /data-i18n="pack\.seal"/.test(html));

rec("блок установки с копированием", /data-copy="#cmd-unix"/.test(html) && /data-copy="#cmd-win"/.test(html));
rec("команда установки с нашего домена", /curl -fsSL https:\/\/[^\s"]+\/install\.sh/.test(html));
rec("ссылка на GitHub в подвале", /https:\/\/github\.com\/cortexally\/dirigo/.test(html));
rec("заявки на рабочий ящик partners@cortexally.ai, личной почты нет", /MAILBOX = "partners@cortexally\.ai"/.test(js) && !/@gmail\./.test(js + html));
rec("переключатель языка RU/EN", /data-lang="ru"/.test(html) && /data-lang="en"/.test(html));
rec("переключатель темы", ids.has("themeToggle"));
rec("skip-link для клавиатуры", /class="skip-link"/.test(html));
rec("у всех img есть alt", [...html.matchAll(/<img[^>]*>/g)].every((m) => /\salt="[^"]+"/.test(m[0])));
rec("у всех img заданы размеры", [...html.matchAll(/<img[^>]*>/g)].every((m) => /width="\d+"/.test(m[0]) && /height="\d+"/.test(m[0])));

/* ------------------------------ 6. двуязычие ------------------------------ */

const i18nKeys = [...new Set([...html.matchAll(/data-i18n="([^"]+)"/g)].map((m) => m[1]))];
const dictKeys = js.match(/"[a-zA-Z0-9_.]+":/g) ?? [];
const counted = new Map<string, number>();
for (const k of dictKeys) {
  const key = k.slice(1, -2);
  counted.set(key, (counted.get(key) ?? 0) + 1);
}
const untranslated = i18nKeys.filter((k) => (counted.get(k) ?? 0) < 2);
rec("у каждого data-i18n есть RU и EN", untranslated.length === 0, untranslated.slice(0, 8).join(", ") || `${i18nKeys.length} ключей`);
rec("meta.title переводится", (counted.get("meta.title") ?? 0) >= 2);

// ключи, которые JS достаёт сам (схема режимов, макет пульта), тоже должны быть в обоих словарях.
// Ключи, собираемые конкатенацией (t("am.hist" + i)), проверяются по префиксу.
const PREFIX_KEYS = ["am.hist"];
const jsKeys = [...new Set([
  ...[...js.matchAll(/\bt\(\s*"([a-z]+\.[a-zA-Z0-9_]+)"/g)].map((m) => m[1]),
  ...[...js.matchAll(/"(vfm\.[a-zA-Z0-9_]+)"/g)].map((m) => m[1]),
])].filter((k) => !PREFIX_KEYS.includes(k));
const jsUntranslated = jsKeys.filter((k) => (counted.get(k) ?? 0) < 2);
rec("ключи из JS переведены на оба языка", jsUntranslated.length === 0,
  jsUntranslated.slice(0, 8).join(", ") || `${jsKeys.length} ключей`);

/* ---------------------- 7. доступность, движение, сборка ---------------------- */

rec("CSS: prefers-reduced-motion учтён", (css.match(/prefers-reduced-motion/g) ?? []).length >= 2);
rec("CSS: focus-visible определён", /:focus-visible/.test(css));
rec("CSS: светлая тема определена", /\[data-site-theme="light"\]/.test(css));
rec("CSS: мобильный брейкпоинт ≤480px", /max-width:\s*480px/.test(css));
rec("CSS: нет сломанных токенов (---)", !/\n\s*---[a-z]/.test(css));

for (const file of ["assets/app.js", "assets/style.css"]) {
  const p = join(ROOT, file);
  rec(`${file} существует`, existsSync(p), existsSync(p) ? `${(statSync(p).size / 1024).toFixed(1)} КБ` : "нет файла");
}
{
  const out = join(ROOT, ".site-build/app.js");
  const b = Bun.spawnSync([process.execPath, "build", join(ROOT, "assets/app.js"), "--outfile", out]);
  rec("app.js собирается", b.exitCode === 0, b.exitCode === 0 ? "" : b.stderr.toString().slice(0, 160));
  try { rmSync(join(ROOT, ".site-build"), { recursive: true, force: true }); } catch { /* ок */ }
}

/* -------------------------------- отчёт -------------------------------- */

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? "  — " + r.detail : ""}`);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
