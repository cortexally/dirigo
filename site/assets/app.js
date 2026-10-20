/* Dirigo — интерактив сайта. Ноль зависимостей, ноль внешних запросов. */
(function () {
  "use strict";

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  /* ---------------- данные ---------------- */

  var AGENTS = [
    { name: "Claude Code", short: "CC", icon: "ag-claude", c: "#da7756" },
    { name: "OpenCode", short: "Oc", icon: "ag-opencode", c: "#7c5cff" },
    { name: "Kilo", short: "Ki", icon: "ag-kilo", c: "#22d3ee" },
    { name: "Codex", short: "Cx", icon: "ag-codex", c: "#94a3b8" },
    { name: "Copilot", short: "Cp", icon: "ag-copilot", c: "#cbd5e1" },
    { name: "Gemini", short: "Gm", icon: "ag-gemini", c: "#f59e0b" },
    { name: "Cursor", short: "Cu", icon: "ag-cursor", c: "#38bdf8" },
    { name: "Devin", short: "Dv", icon: "ag-devin", c: "#a78bfa" },
    { name: "Hermes", short: "He", icon: "ag-hermes", c: "#f472b6" },
    { name: "zcode", short: "Zc", icon: "ag-zcode", c: "#34d399" },
    { name: "MiniMax", short: "Mm", icon: "ag-minimax", c: "#fb7185" },
    { name: "Freebuff", short: "Fb", icon: "ag-freebuff", c: "#2dd4bf" },
    { name: "Cline", short: "Cl", icon: "ag-cline", c: "#c084fc" }
  ];

  var FAQ = {
    ru: [
      {
        q: "Что такое Dirigo?",
        a: "Веб-пульт для ИИ-агентов, который вы ставите на свою машину. Вы описываете задачу словами, пульт запускает CLI-агента в изолированной копии проекта (git-worktree), прогоняет проверки проекта и показывает построчный дифф. В ваш рабочий каталог изменения попадают только после того, как вы нажали «Применить». И на каждое такое применение пульт выдаёт подписанный пакет доказательств: кто и чем писал код, что проверялось и кто это одобрил."
      },
      {
        q: "Чем это отличается от «просто запустить агента в терминале»?",
        a: "Четырьмя вещами. Первая: агенты работают в отдельных копиях, поэтому их можно запускать параллельно и они не мешают друг другу. Вторая: проверки проекта гоняются до того, как вы что-то увидите, и сломанный результат уходит обратно агенту. Третья: недостающие агенты ставятся из интерфейса, а не руками на каждой машине. Четвёртая: после терминала у вас остаётся только диф, а после пульта — подписанная запись о том, как этот диф появился."
      },
      {
        q: "Что уже работает и что в разработке?",
        a: "Работает и проверено: демон на Bun, реестр из 13 агентов, мастер первого запуска (среда → агенты → ключи → удалёнка) с реальным детектом окружения, изолированные копии, автопроверки, построчный дифф с применением и откатом, терминал агента в браузере, дашборд проекта, PWA. Журнал происхождения с цепочкой хешей, подписанные пакеты доказательств, трейлеры в коммите, выгрузка для аудита, шлюз персональных данных и база знаний компании (CoAlly по MCP) — код, покрытый тестами, в открытой части. В разработке вместе с design-партнёрами: Enterprise-слой — SSO и SCIM, интерфейс журнала аудита, политики доступа по ролям и SLA; доступен по запросу."
      },
      {
        q: "Что именно лежит в пакете доказательств?",
        a: "Проект, задача и хеш промпта; агент и модель; вид изоляции и базовый коммит, от которого шла работа; каждый прогон проверок и его результат; сколько раз сломанная работа возвращалась агенту; сводка шлюза персональных данных (тип находки и количество, без самих значений); кто одобрил изменение и когда; список файлов — что изменено, что удалено; итоговый коммит; голова цепочки журнала и версия продукта. Всё это подписывается Ed25519-ключом вашего инстанса. Тот же набор в сокращённом виде попадает в трейлеры коммита: Dirigo-Agent, Dirigo-Model, Dirigo-Checks, Dirigo-Returned-To-Agent, Dirigo-Ledger-Head."
      },
      {
        q: "Что-нибудь из этого уходит с моей машины?",
        a: "Нет. Журнал, пакеты и ключ подписи лежат в каталоге данных на вашей машине; приватный ключ хранится в режиме 0600 и наружу не отдаётся. Единственный исходящий трафик — запросы самих агентов к их провайдерам по вашим ключам. Выгрузка записей в базу знаний компании выключена по умолчанию, и если её включить, запись уходит на ваш же приёмник внутри вашего периметра, причём обязательно через шлюз персональных данных."
      },
      {
        q: "Как аудитор проверит пакет, ничего не устанавливая?",
        a: "Двумя способами. Первый: открыть коммит обычным git log — трейлеры лежат в теле сообщения, никакого нашего формата для этого не нужно. Второй: взять выгрузку за период — это один JSON, в котором лежат сами пакеты, открытый ключ инстанса и сводка проверки подписей и цепочек. Подпись считается по стабильной сериализации пакета, так что проверить её может любой инструмент, умеющий Ed25519. Ставить Dirigo аудитору не нужно."
      },
      {
        q: "Может ли агент сломать мой проект?",
        a: "До вашего решения он не трогает рабочий каталог: агент пишет в свою копию, проверки гоняются там же. Если результат не понравился — копия удаляется, и у вас ничего не изменилось. Если вы уже применили патч, рядом есть кнопка «вернуть как было» и точка возврата."
      },
      {
        q: "Это правда бесплатно? В чём подвох?",
        a: "Подвоха нет: ядро открыто по MIT, ставится одной командой и работает без регистрации, ключей активации и ограничений. Платным может быть только Enterprise-слой для регулируемых команд — по запросу. Расходы на модели — ваши и идут напрямую провайдеру по вашим ключам."
      },
      {
        q: "Нужна ли отдельная подписка на ИИ?",
        a: "Да, нужна ваша собственная — подписка или API-ключ того агента, которым вы хотите пользоваться (Claude Code, Codex, Copilot, Gemini, Kilo, OpenCode и другие). Dirigo не перепродаёт токены и не встраивается между вами и провайдером: ключ лежит локально и передаётся процессу агента через переменные окружения."
      },
      {
        q: "Что происходит с моим кодом?",
        a: "Он остаётся на вашей машине. У проекта нет серверной части, куда можно было бы отправить файлы: демон, копии проекта, история и ключи лежат локально. Наружу уходят только запросы самих агентов к их провайдерам — ровно те же, что и при запуске агента вручную."
      },
      {
        q: "На чём это работает и что нужно поставить?",
        a: "Нужен Bun 1.4+ — установочный скрипт ставит его сам, если его нет. Зависимостей из npm у продукта нет вообще: это около 18 тысяч строк на Bun одним бандлом. Проверено на Linux и Windows; для macOS установщик ставит тот же бандл."
      },
      {
        q: "Нужно ли знать git?",
        a: "Нет. Под капотом используются git-worktree и точки возврата, но в интерфейсе это кнопки «применить» и «вернуть как было». Если git вы знаете — ничего не спрятано: ветки, коммиты и диффы остаются обычными."
      },
      {
        q: "Сколько агентов можно запустить параллельно?",
        a: "Жёсткого лимита в пульте нет — упираетесь в процессор, память и лимиты вашего провайдера моделей. Честно: конкретное число зависит от машины и агента, обещать «N агентов» было бы выдумкой."
      },
      {
        q: "Как работать с телефона?",
        a: "Пульт — обычное веб-приложение (PWA): открываете его в браузере телефона и ставите на домашний экран. Снаружи доступ идёт через Cloudflare-туннель или через вашу сеть Tailscale; порт демона наружу не открывается. Код на телефон не копируется — вы видите статусы и диффы."
      },
      {
        q: "Кто уже работает с Dirigo?",
        a: "Мы открываем продукт сейчас и работаем с первыми командами в регулируемом контуре, с которыми развиваем Enterprise-слой. Логотипы и счётчики на странице появятся, когда клиенты разрешат их показать. Проверить качество можно уже сейчас: открытый код и релизный гейт — 59 наборов тестов и 1488 проверок, включая живую матрицу «агенты × режимы» и пользовательские сценарии через настоящий интерфейс."
      },
      {
        q: "Можно ли поставить на сервер, а не на ноутбук?",
        a: "Да, установка та же самая. Демон слушает 127.0.0.1, поэтому снаружи он доступен только через туннель или вашу приватную сеть. Ставить его на публичный адрес без такой прослойки не нужно и не рекомендуется."
      },
      {
        q: "Нашёл баг или хочу функцию — куда писать?",
        a: "В issues репозитория на GitHub. Проект открыт по MIT, pull request'ы тоже приветствуются — особенно по платформам, отличным от Linux."
      }
    ],
    en: [
      {
        q: "What is Dirigo?",
        a: "A web console for AI agents that you install on your own machine. You describe a task in plain words, the console launches a CLI agent in an isolated copy of the project (a git worktree), runs the project's checks and shows a line-by-line diff. Changes reach your working directory only after you press “Apply”. And every such apply produces a signed evidence pack: who wrote the code and with what, what was checked, and who approved it."
      },
      {
        q: "How is this different from just running an agent in a terminal?",
        a: "In four ways. First, agents work in separate copies, so you can run them in parallel without them stepping on each other. Second, the project's checks run before you see anything, and a broken result goes back to the agent. Third, missing agents are installed from the interface instead of by hand on every machine. Fourth, a terminal leaves you a diff and nothing else, while the console leaves a signed record of how that diff came to be."
      },
      {
        q: "What already works, and what is in development?",
        a: "Working and verified: the Bun daemon, a registry of 13 agents, the first-run wizard (environment → agents → keys → remote) with real environment detection, isolated copies, automatic checks, a line-by-line diff with apply and rollback, the agent's own terminal in the browser, a project dashboard and the PWA. The hash-chained provenance ledger, signed evidence packs, commit trailers, the audit export, the personal-data gateway and the company knowledge base (CoAlly over MCP) are code, covered by tests, in the open core. In development with design partners: the Enterprise layer — SSO and SCIM, an audit-log UI, role-based access policies and an SLA; available on request."
      },
      {
        q: "What exactly is in an evidence pack?",
        a: "The project, the task and the prompt hash; the agent and the model; the kind of isolation and the base commit the work started from; every run of the checks and its result; how many times broken work was returned to the agent; the personal-data gateway summary (kind of match and count, never the values); who approved the change and when; the list of files — what changed and what was deleted; the resulting commit; the ledger head and the product version. All of it is signed with the Ed25519 key of your instance. A short form of the same data lands in the commit trailers: Dirigo-Agent, Dirigo-Model, Dirigo-Checks, Dirigo-Returned-To-Agent, Dirigo-Ledger-Head."
      },
      {
        q: "Does any of this leave my machine?",
        a: "No. The ledger, the packs and the signing key live in the data directory on your machine; the private key is kept with 0600 permissions and is never handed out. The only outbound traffic is the agents' own calls to their providers with your keys. Pushing task records to a company knowledge base is off by default, and when you turn it on the record goes to your own receiver inside your own perimeter — and always through the personal-data gateway."
      },
      {
        q: "How does an auditor verify a pack without installing anything?",
        a: "Two ways. First, open the commit with plain git log — the trailers are in the message body, and no format of ours is needed to read them. Second, take the export for a period: it is a single JSON holding the packs themselves, the public key of the instance, and a summary of the signature and chain verification. The signature is computed over a stable serialization of the pack, so any tool that can do Ed25519 can check it. The auditor does not need to install Dirigo."
      },
      {
        q: "Can an agent break my project?",
        a: "Not before you decide: the agent writes into its own copy and the checks run there too. If you don't like the result, the copy is deleted and nothing on your side has changed. If you have already applied a patch, there is a “put it back” button and a restore point next to it."
      },
      {
        q: "Is it really free? What's the catch?",
        a: "There is no catch: the core is open under MIT, installs with one command and runs with no sign-up, licence keys or limits. Only the Enterprise layer for regulated teams may be paid — on request. Model costs are yours and go straight to the provider with your keys."
      },
      {
        q: "Do I need a separate AI subscription?",
        a: "Yes, your own — a subscription or API key for whichever agent you want to use (Claude Code, Codex, Copilot, Gemini, Kilo, OpenCode and others). Dirigo does not resell tokens and does not sit between you and the provider: the key stays local and is handed to the agent process through environment variables."
      },
      {
        q: "What happens to my code?",
        a: "It stays on your machine. The project has no backend to send files to: the daemon, the project copies, the history and the keys are all local. The only outbound traffic is the agents' own calls to their providers — exactly the same calls you would make running the agent by hand."
      },
      {
        q: "What does it run on, and what do I need to install?",
        a: "Bun 1.4+ — the install script sets it up if it is missing. The product has no npm dependencies at all: about 18 thousand lines on Bun in a single bundle. Verified on Linux and Windows; on macOS the installer sets up the same bundle."
      },
      {
        q: "Do I need to know git?",
        a: "No. Git worktrees and restore points are used underneath, but in the interface they are “apply” and “put it back” buttons. If you do know git, nothing is hidden: branches, commits and diffs stay ordinary."
      },
      {
        q: "How many agents can run in parallel?",
        a: "The console sets no hard limit — you hit your CPU, your memory and your model provider's limits. Honestly: the real number depends on the machine and the agent, and promising “N agents” would be making things up."
      },
      {
        q: "How do I work from a phone?",
        a: "The console is a plain web app (PWA): open it in your phone's browser and add it to the home screen. Access from outside goes through a Cloudflare tunnel or your own Tailscale network; the daemon's port is never exposed. Code is not copied to the phone — you see statuses and diffs."
      },
      {
        q: "Who is already working with Dirigo?",
        a: "We are opening the product now and working with the first teams in a regulated perimeter, together with whom we are developing the Enterprise layer. Logos and counters will appear on this page once customers let us show them. The quality can be checked today: open code and a release gate of 59 test suites and 1,488 checks, including a live agents × modes matrix and user scenarios driven through the real interface."
      },
      {
        q: "Can I put it on a server instead of a laptop?",
        a: "Yes, the installation is the same. The daemon listens on 127.0.0.1, so from outside it is reachable only through a tunnel or your private network. Putting it on a public address without that layer is neither necessary nor recommended."
      },
      {
        q: "I found a bug or want a feature — where do I write?",
        a: "In the repository's issues on GitHub. The project is MIT-licensed and pull requests are welcome too — especially for platforms other than Linux."
      }
    ]
  };

  /* ---------------- агенты: бегущая строка ---------------- */

  (function fillAgents() {
    var track = $("#agentsTrack");
    if (!track) return;
    var make = function (a) {
      return '<span class="agent-mark"><svg class="agent-mark__ava" viewBox="0 0 32 32" aria-hidden="true"><use href="#' + a.icon + '"/></svg>' + a.name + "</span>";
    };
    track.innerHTML = AGENTS.map(make).join("");
    track.innerHTML += track.innerHTML; // бесшовный цикл
  })();

  /* ---------------- режимы: табы ---------------- */

  (function initTabs() {
    var tabs = $$(".tab");
    var panels = $$(".mode-panel");
    tabs.forEach(function (tab) {
      tab.addEventListener("click", function () {
        tabs.forEach(function (t) { t.classList.remove("tab--on"); t.setAttribute("aria-selected", "false"); });
        panels.forEach(function (p) { p.classList.remove("mode-panel--on"); });
        tab.classList.add("tab--on");
        tab.setAttribute("aria-selected", "true");
        var panel = $('[data-panel="' + tab.dataset.mode + '"]');
        if (panel) panel.classList.add("mode-panel--on");
      });
    });
  })();

  /* ---------------- FAQ: аккордеон (двуязычный) ---------------- */

  (function initFaq() {
    var list = $("#faqList");
    if (!list) return;
    var openIdx = -1;

    var render = function (lang) {
      var items = FAQ[lang === "en" ? "en" : "ru"];
      list.innerHTML = items.map(function (item, i) {
        return (
          '<div class="acc' + (i === openIdx ? ' acc--open' : '') + '" data-acc>' +
          '<button class="acc__q" aria-expanded="' + (i === openIdx) + '" aria-controls="faq-a-' + i + '">' + item.q +
          '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14" /></svg></button>' +
          '<div class="acc__a" id="faq-a-' + i + '" role="region"><p>' + item.a + "</p></div></div>"
        );
      }).join("");
      list.classList.toggle("faq--en", lang === "en");

      $$(".acc__q", list).forEach(function (btn, i) {
        btn.addEventListener("click", function () {
          openIdx = i;
          $$(".acc", list).forEach(function (a, j) {
            a.classList.remove("acc--open");
            var pane = a.querySelector(".acc__a");
            if (pane) pane.style.maxHeight = "";
            var q = a.querySelector(".acc__q"); if (q) q.setAttribute("aria-expanded", "false");
          });
          var acc = btn.closest(".acc");
          var pane = acc.querySelector(".acc__a");
          acc.classList.add("acc--open");
          pane.style.maxHeight = "";
          btn.setAttribute("aria-expanded", "true");
        });
      });
    };
    window.__rerenderFaq = function (lang) {
      render(lang || (document.documentElement.getAttribute("lang") === "en" ? "en" : "ru"));
    };
    window.__rerenderFaq("ru");
  })();

  /* ---------------- hero: 3D-поворот окна за мышью + параллакс фона ---------------- */

  (function initHeroTilt() {
    var shot = $("#heroShot"), tilt = $("#heroTilt");
    if (!shot || !tilt) return;
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    var apply = function (x, y) {
      var r = shot.getBoundingClientRect();
      if (!r.width || !r.height) return;
      var mx = Math.max(-1, Math.min(1, (x - r.left) / r.width * 2 - 1));
      var my = Math.max(-1, Math.min(1, (y - r.top) / r.height * 2 - 1));
      tilt.style.setProperty("--mx", (mx * 0.4).toFixed(3));
      tilt.style.setProperty("--my", (my * 0.3).toFixed(3));
      shot.style.setProperty("--my", (my * 0.3).toFixed(3));
    };
    shot.addEventListener("mousemove", function (e) { apply(e.clientX, e.clientY); }, { passive: true });
    shot.addEventListener("mouseleave", function () {
      tilt.style.setProperty("--mx", "0");
      tilt.style.setProperty("--my", "0");
      shot.style.setProperty("--my", "0");
    });
    if (window.matchMedia("(pointer: fine)") === null || window.matchMedia("(pointer: fine)").matches) {
      window.addEventListener("mousemove", function (e) {
        var r = shot.getBoundingClientRect();
        if (r.bottom < 0 || r.top > window.innerHeight) return; // параллакс только когда hero виден
        var dx = (e.clientX - window.innerWidth / 2) / window.innerWidth;
        tilt.style.setProperty("--mx", (dx * 0.5).toFixed(3));
      }, { passive: true });
    }

    // параллакс фонового свечения при скролле
    var glow = document.querySelector(".hero__glow");
    if (glow) {
      var onScroll = function () {
        var p = Math.min(1, Math.max(0, window.scrollY / Math.max(1, window.innerHeight)));
        glow.style.transform = "translate3d(0," + (p * -40).toFixed(1) + "px,0)";
        glow.style.opacity = String(1 - p * 0.6);
      };
      window.addEventListener("scroll", onScroll, { passive: true });
      onScroll();
    }
  })();

  /* ---------------- изометрическая схема режимов (i18n-aware) ---------------- */

  (function initModesDiagram() {
    var floor = document.getElementById("vfmFloor");
    var air = document.getElementById("vfmAir");
    var vfm = document.getElementById("vfm");
    if (!floor || !air || !vfm) return;

    var SVGNS = "http://www.w3.org/2000/svg";
    // геометрия пластины (из ромба + двух боковин), как в референсе
    var PLATE = {
      top: "-110.44,-31.59 70.26,-69.33 110.44,10.14 -70.26,47.88",
      sideR: "110.44,10.14 -70.26,47.88 -70.26,58.61 110.44,20.87",
      sideL: "-70.26,47.88 -110.44,-31.59 -110.44,-20.87 -70.26,58.61",
      lines: [
        [-85.28, -19.27, 5.52, -38.24],
        [-77.25, -3.38, 45.78, -29.07],
        [-69.21, 12.52, -1.84, -1.55],
        [-61.18, 28.41, 44.27, 6.39],
      ],
      split: [
        [-97.05, -5.1, 83.66, -42.84],
        [-83.66, 21.39, 97.05, -16.35],
      ],
    };

    var AGENTS = {
      claude: { icon: "ag-claude", name: "Claude", c: "#da7756" },
      codex: { icon: "ag-codex", name: "Codex", c: "#94a3b8" },
      gemini: { icon: "ag-gemini", name: "Gemini", c: "#f59e0b" },
      planner: { icon: "ag-opencode", nameKey: "vfm.planner", iconKey: null, c: "#22d3ee" },
      resolver: { icon: "ag-devin", nameKey: "vfm.resolver", c: "#fbbf24" },
      judge: { icon: "ag-kilo", nameKey: "vfm.judge", c: "#22d3ee" },
    };

    var TASK = [
      { kindKey: "vfm.task", textKey: "vfm.t_solo" },
      { kindKey: "vfm.task", textKey: "vfm.t_swarm" },
      { kindKey: "vfm.question", textKey: "vfm.t_fusion" },
      { kindKey: "vfm.goal", textKey: "vfm.t_orch" },
    ];

    var TAGS = {
      copy: { key: "vfm.tag_copy" },
      own: { key: "vfm.tag_own" },
      shared: { key: "vfm.tag_shared" },
    };

    // состояния сцены по режимам: пластины, агенты, связи, теги
    var SCENES = {
      solo: {
        plates: [
          { id: "copy", cls: "vfm-plate--copy", x: 490, y: 252, s: 1.15, split: false, tag: "copy" },
          { id: "own", cls: "vfm-plate--own", x: 1022, y: 141, s: 0.86, tag: "own" },
        ],
        agents: [{ id: "a1", at: "copy", dx: 0, dy: -34, a: "claude", hot: true }],
        links: [
          { from: "task", to: "copy", hot: false },
          { from: "copy", to: "own", hot: true },
        ],
      },
      swarm: {
        plates: [
          { id: "copy", cls: "vfm-plate--copy", x: 490, y: 252, s: 1.15, split: true, tag: "shared" },
          { id: "own", cls: "vfm-plate--own", x: 1022, y: 141, s: 0.86, tag: "own" },
        ],
        agents: [
          { id: "a1", at: "copy", dx: -62, dy: -18, a: "claude", hot: true },
          { id: "a2", at: "copy", dx: 0, dy: -40, a: "codex", hot: true },
          { id: "a3", at: "copy", dx: 62, dy: -18, a: "gemini", hot: true },
        ],
        links: [
          { from: "task", to: "copy", hot: false },
          { from: "copy", to: "own", hot: true },
        ],
      },
      fusion: {
        plates: [
          { id: "p1", cls: "vfm-plate--epic", x: 300, y: 150, s: 0.62 },
          { id: "p2", cls: "vfm-plate--epic", x: 300, y: 330, s: 0.62 },
          { id: "p3", cls: "vfm-plate--epic", x: 640, y: 240, s: 0.62 },
          { id: "own", cls: "vfm-plate--own", x: 1022, y: 141, s: 0.86, tag: "own" },
        ],
        agents: [
          { id: "a1", at: "p1", dx: 0, dy: -26, a: "claude" },
          { id: "a2", at: "p2", dx: 0, dy: -26, a: "codex" },
          { id: "a3", at: "p3", dx: 0, dy: -26, a: "gemini" },
          { id: "j", at: "own", dx: -105, dy: -6, a: "judge", hot: true },
        ],
        links: [
          { from: "task", to: "p1", hot: false },
          { from: "p1", to: "own", hot: false },
          { from: "p2", to: "own", hot: false },
          { from: "p3", to: "own", hot: false },
        ],
      },
      orchestrator: {
        plates: [
          { id: "p1", cls: "vfm-plate--copy", x: 300, y: 130, s: 0.7 },
          { id: "p2", cls: "vfm-plate--copy", x: 300, y: 350, s: 0.7 },
          { id: "p3", cls: "vfm-plate--copy", x: 660, y: 240, s: 0.7 },
          { id: "own", cls: "vfm-plate--own", x: 1022, y: 141, s: 0.86, tag: "own" },
        ],
        agents: [
          { id: "pl", at: "task", dx: 118, dy: -6, a: "planner" },
          { id: "a1", at: "p1", dx: 0, dy: -26, a: "claude" },
          { id: "a2", at: "p2", dx: 0, dy: -26, a: "codex" },
          { id: "a3", at: "p3", dx: 0, dy: -26, a: "gemini" },
          { id: "rs", at: "own", dx: -105, dy: -6, a: "resolver", hot: true },
        ],
        links: [
          { from: "task", to: "p1", hot: false },
          { from: "task", to: "p2", hot: false },
          { from: "task", to: "p3", hot: false },
          { from: "p1", to: "own", hot: false },
          { from: "p2", to: "own", hot: false },
          { from: "p3", to: "own", hot: true },
        ],
      },
    };

    var el = function (name, cls, attrs) {
      var e = document.createElementNS(SVGNS, name);
      if (cls) e.setAttribute("class", cls);
      for (var k in attrs || {}) e.setAttribute(k, attrs[k]);
      return e;
    };

    var plate = function (p) {
      var g = el("g", "vfm-plate " + (p.cls || ""), {
        transform: "translate(" + p.x + " " + p.y + ") scale(" + p.s + ")",
        "data-plate": p.id,
      });
      g.appendChild(el("polygon", "vfm-plate__side", { points: PLATE.sideR }));
      g.appendChild(el("polygon", "vfm-plate__side", { points: PLATE.sideL }));
      g.appendChild(el("polygon", "vfm-plate__top", { points: PLATE.top }));
      PLATE.lines.forEach(function (l) {
        g.appendChild(el("line", "vfm-plate__line", { x1: l[0], y1: l[1], x2: l[2], y2: l[3] }));
      });
      PLATE.split.forEach(function (l) {
        g.appendChild(el("line", "vfm-plate__split", { x1: l[0], y1: l[1], x2: l[2], y2: l[3] }));
      });
      if (p.split) g.setAttribute("data-split", "true");
      return g;
    };

    var linkGeom = function (from, to) {
      // координаты краёв пластин: левый/правый центр ромба
      var half = function (p) { return { x1: p.x - 110 * p.s, x2: p.x + 110 * p.s, y: p.y + 10 * p.s }; };
      var a = from === "task" ? { x1: 150, x2: 150, y: 331 } : half(from);
      var b = to === "own" ? { x1: to.x - 95 * to.s, x2: to.x + 95 * to.s, y: to.y + 8 * to.s } : half(to);
      var x1 = a.x2, x2 = b.x1;
      var dy = b.y - a.y;
      var len = Math.sqrt((x2 - x1) * (x2 - x1) + dy * dy);
      var ang = Math.atan2(dy, x2 - x1) * 180 / Math.PI;
      return { x: x1, y: a.y, len: len, ang: ang };
    };

    var findPlate = function (id) {
      return SCENES[current].plates.find(function (p) { return p.id === id; }) ||
        (id === "task" ? { x: 150, y: 331, s: 1 } : null);
    };

    var current = "solo";
    var render = function (mode) {
      current = mode;
      var sc = SCENES[mode];
      if (!sc) return;
      var dict = window.__siteDict || {};
      floor.textContent = "";
      air.textContent = "";

      // связи (под пластинами)
      sc.links.forEach(function (l) {
        var from = findPlate(l.from), to = findPlate(l.to);
        if (!from || !to) return;
        var g = linkGeom(from, to);
        var grp = el("g", "", { transform: "translate(" + g.x + " " + g.y + ") rotate(" + g.ang.toFixed(2) + ")" });
        var line = el("line", "vfm-link" + (l.hot ? " vfm-link--hot" : "") + " vfm-link--on", { x1: 0, y1: 0, x2: g.len.toFixed(1), y2: 0 });
        grp.appendChild(line);
        var pulse = el("line", "vfm-pulse vfm-pulse--on", { x1: 0, y1: 0, x2: 0.01, y2: 0 });
        pulse.style.setProperty("--len", g.len.toFixed(1) + "px");
        pulse.style.animationDelay = (Math.random() * 1.2).toFixed(2) + "s";
        grp.appendChild(pulse);
        floor.appendChild(grp);
      });

      // пластины
      sc.plates.forEach(function (p) { floor.appendChild(plate(p)); });

      // теги на пластинах — высоко над ними (выше подписей агентов)
      sc.plates.forEach(function (p) {
        if (!p.tag || !TAGS[p.tag]) return;
        var tag = document.createElement("div");
        tag.className = "vfm-bb vfm-tag" + (p.cls === "vfm-plate--copy" ? " vfm-tag--accent" : "");
        tag.style.left = (p.x / 1132 * 100) + "%";
        tag.style.top = (Math.max(30, p.y - 205 * p.s) / 448 * 100) + "%";
        tag.textContent = dict[TAGS[p.tag].key] || TAGS[p.tag].key;
        air.appendChild(tag);
      });

      // агенты
      sc.agents.forEach(function (ag) {
        var base = findPlate(ag.at);
        if (!base) return;
        var a = AGENTS[ag.a];
        var wrap = document.createElement("div");
        wrap.className = "vfm-bb vfm-agent" + (ag.hot ? " vfm-agent--hot" : "");
        // dx/dy — смещение от центра пластины: для пластин чуть выше центра (на верхнюю грань),
        // для карточки задачи — от её центра
        var x = base.x + ag.dx;
        var y = (ag.at === "task" ? base.y + ag.dy : base.y - 62 * base.s + ag.dy);
        wrap.style.left = (x / 1132 * 100) + "%";
        wrap.style.top = (y / 448 * 100) + "%";
        var roleName = a.nameKey ? dict[a.nameKey] || "" : "";
        var roleText = roleName && roleName !== dict["vfm.agent"] ? roleName : roleName;
        wrap.innerHTML =
          '<span class="vfm-agent__chip"><svg viewBox="0 0 32 32" aria-hidden="true"><use href="#' + a.icon + '"/></svg>' +
          '<span class="vfm-agent__live"></span></span>' +
          '<span class="vfm-agent__name">' + (a.nameKey ? (roleName || "") : a.name) + "</span>" +
          (a.roleKey ? '<span class="vfm-agent__role">' + (dict[a.roleKey] || "") + "</span>" : "");
        air.appendChild(wrap);
      });

      // карточка задачи (меняет текст по режиму)
      var task = TASK[["solo", "swarm", "fusion", "orchestrator"].indexOf(mode)] || TASK[0];
      var card = document.createElement("div");
      card.className = "vfm-bb vfm-task__card";
      card.style.left = (150 / 1132 * 100) + "%";
      card.style.top = (300 / 448 * 100) + "%";
      card.innerHTML =
        '<span class="vfm-task__kind">' + (dict[task.kindKey] || "") + "</span>" +
        '<span class="vfm-task__text">' + (dict[task.textKey] || "") + "</span>";
      air.appendChild(card);
    };

    // связь с табами
    var tabs = $$(".tab");
    tabs.forEach(function (tab) {
      tab.addEventListener("click", function () { render(tab.dataset.mode); });
    });
    render("solo");
    window.__rerenderVfm = render;
  })();

  /* ---------------- тема сайта (светлая/тёмная) ---------------- */

  (function initSiteTheme() {
    var root = document.documentElement;
    var KEY = "dirigo-site-theme";
    var saved = null;
    try { saved = localStorage.getItem(KEY); } catch (e) { /* приватный режим */ }
    if (saved === "light" || saved === "dark") root.setAttribute("data-site-theme", saved);
    else if (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches) root.setAttribute("data-site-theme", "light");
    else root.setAttribute("data-site-theme", "dark");

    var btn = document.getElementById("themeToggle");
    if (btn) {
      btn.addEventListener("click", function () {
        var next = root.getAttribute("data-site-theme") === "light" ? "dark" : "light";
        root.setAttribute("data-site-theme", next);
        try { localStorage.setItem(KEY, next); } catch (e) { /* приватный режим */ }
      });
    }
  })();

  /* ---------------- язык сайта (RU/EN): словарь на ВСЕ тексты ---------------- */

  (function initI18n() {
    var root = document.documentElement;
    var KEY = "dirigo-site-lang";

    var DICT = {
      ru: {
        "meta.title": "Dirigo - провенанс ИИ-кода: подписанная запись о каждой строке, написанной агентом",
        "a11y.skip": "К содержимому",
        "brand.sub": "пульт ИИ-агентов",
"ifaces.title": "Пульт — не единственный вход",
        "ifaces.cli.t": "CLI",
        "ifaces.cli.d": "./orch — сессии, копии, диффы и применение из терминала и из скриптов.",
        "ifaces.mcp.t": "MCP-сервер",
        "ifaces.mcp.d": "Пульт отдаётся как набор инструментов любому MCP-клиенту.",
        "ifaces.sdk.t": "TypeScript SDK",
        "ifaces.sdk.d": "Типизированный клиент к тому же REST API, что и у веб-интерфейса.",
        "ifaces.docker.t": "Docker",
        "ifaces.docker.d": "docker compose up, каталог проектов монтируется внутрь.",
        "nav.problem": "Проблема",
        "nav.how": "Как работает",
        "nav.edge": "Отличия",
        "nav.modes": "Режимы",
        "nav.agents": "Агенты",
        "nav.remote": "Удалёнка",
        "nav.evidence": "Доказательства",
        "nav.gateway": "Периметр",
        "nav.security": "Безопасность",
        "nav.pricing": "Цены",
        "nav.faq": "Вопросы",
        "nav.download": "Установить",
        "hero.badge1": "Открытый код, MIT · self-host",
        "hero.badge2": "59 наборов тестов · 1488 проверок",
        "hero.badge3": "ноль npm-зависимостей",
        "hero.title1": "Запись о том, кто написал каждую строку,",
        "hero.title2": "создаётся в момент, когда её пишет агент",
        "hero.lead": "Dirigo стоит внутри цикла генерации, между вашей задачей и вашим проектом. Поэтому он знает агента и модель, хеш промпта, каждую прогнанную проверку, сколько раз работа ушла обратно агенту, кто нажал «Применить» и какой вышел коммит — и на каждое применение выдаёт подписанный пакет доказательств. По готовому коммиту такую запись уже не собрать.",
        "hero.cta1": "Установить одной командой",
        "hero.cta2": "Что лежит в пакете доказательств",
        "hero.meta1": "агентов в реестре",
        "hero.meta2": "режима работы",
        "hero.meta3": "строк на Bun",
        "hero.meta4": "ваши ключи, ваш код, ваша машина",
        "hero.shotnote": "Интерактивный макет интерфейса — можно кликать. Реальные скриншоты пульта — ниже по странице.",
        "prob.kicker": "Проблема",
        "prob.title1": "Один агент уже не вывозит.",
        "prob.title2": "Второго в тот же проект не запустить.",
        "prob.lead": "Как только задач становится больше одной, упираешься в три стены подряд — и ни одну из них не чинит ещё один чат с моделью.",
        "prob.c1h": "Агенты дерутся за рабочий каталог",
        "prob.c1p": "Два агента в одном репозитории переписывают файлы друг друга, ломают индекс git и отменяют чужие правки. Ждать, пока первый закончит, — значит работать по одной задаче за раз.",
        "prob.c2h": "Проверки запускает человек",
        "prob.c2p": "Вы читаете диф, тратите внимание, а потом выясняется, что сборка падает и тесты красные. Фильтр стоит после вас, хотя должен стоять до.",
        "prob.c3h": "Каждая машина настраивается руками",
        "prob.c3p": "Поставить пять CLI-агентов, прописать ключи, проверить версии, поднять доступ с ноутбука — вечер работы, и так на каждой новой машине.",
        "prob.answer": "Dirigo закрывает все три: копия проекта на каждого агента, автопроверки до человека, установка агентов из интерфейса.",
        "how.kicker": "Как это работает",
        "how.title1": "Три шага",
        "how.title2": "от задачи до кода в проекте",
        "how.lead": "Вы описываете задачу словами. Дальше пульт делает копию проекта, прогоняет проверки и возвращает вам результат на решение — применить или откатить.",
        "how.s1": "Шаг 1",
        "how.bar1": "dirigo — новая сессия",
        "how.copytype": "копия: git-worktree",
        "how.t1": "Добавь округление цены в чеке и тест на него",
        "how.run": "▶ Запустить",
        "how.r1": "worktree создан · точка возврата сохранена",
        "how.r2": "ваш рабочий каталог не тронут",
        "how.r3": "агент работает, вы продолжаете своё",
        "how.c1h": "Задача словами — агент в изолированной копии",
        "how.c1p": "Каждая сессия получает собственный git-worktree и точку возврата. Параллельных агентов столько, сколько вытянет машина, и они не пересекаются.",
        "how.replay": "↻ проиграть сценарий",
        "how.s2": "Шаг 2",
        "how.bar2": "dirigo — проверки в копии",
        "how.chk0": "команды проекта найдены сами: bun test · eslint · build",
        "how.chk1": "bun test — 23/24, упал round.test.ts",
        "how.chk2": "возврат агенту с текстом ошибки (итерация 1 из 2)",
        "how.chk3": "bun test — 24/24",
        "how.chk4": "eslint — 0 ошибок · build — ok",
        "how.chk5": "только теперь результат показывается вам",
        "how.c2h": "Проверки гоняются до человека",
        "how.c2p": "Пульт сам находит команды проверок проекта (npm, make, pytest, cargo, just) и запускает их в копии. Сломанная правка не доходит до вас — она уходит обратно агенту.",
        "how.s3": "Шаг 3",
        "how.bar3": "dirigo — дифф копии",
        "how.newf": "новый +8 −0",
        "how.old": "return p * 1.2;&nbsp;&nbsp;(старый хелпер)",
        "how.apply": "✓ Применить в проект",
        "how.r4": "изменения перенесены, копия убрана",
        "how.r5": "«вернуть как было» — одна кнопка",
        "how.c3h": "Ревью построчно — решение за вами",
        "how.c3p": "Дифф с номерами строк и счётчиками. Замечание к строке уходит агенту на доработку. В проект код попадает только после явного «Применить».",
        "edge.kicker": "Отличия",
        "edge.title1": "Три вещи, которые в этой категории",
        "edge.title2": "почти никто не делает",
        "edge.lead": "Запускать агентов параллельно умеют многие. Поставить их на чистую машину, не пустить к вам сломанное и оставить после себя доказательство того, что произошло, — почти никто.",
        "edge.c1h": "Provisioning в один клик",
        "edge.c1p": "Мастер первого запуска из четырёх шагов: <b>Среда → Агенты → Ключи → Удалёнка</b>. Пульт сам опрашивает систему, показывает найденные bun, git, npm, ssh и cloudflared с путями и версиями, ставит недостающих агентов из интерфейса, подсказывает, где взять ключ, и после установки опрашивает систему заново.",
        "edge.c1l1": "13 агентов в реестре — ставятся из UI, без команд в терминале",
        "edge.c1l2": "детект среды с путями и версиями, а не «кажется, установлено»",
        "edge.c1l3": "ключи хранятся локально и отдаются процессу агента через ENV",
        "edge.shot1h": "Это не макет.",
        "edge.shot1p": "Экран диффа из работающего пульта: два файла, построчные изменения, счётчики.",
        "edge.c2h": "Ревью-гейт с автовозвратом",
        "edge.c2p": "Между агентом и вашим проектом стоит шлюз. Проверки проекта гоняются в копии до того, как вы что-то увидите; сломанный результат возвращается агенту с текстом ошибки (не больше двух итераций, чтобы не жечь токены). До вас доходит только то, что собирается и проходит тесты — и дальше решаете вы, построчно.",
        "edge.c2l1": "команды проверок определяются по проекту: npm, make, pytest, cargo, just",
        "edge.c2l2": "построчный дифф с замечаниями: замечание к строке уходит агенту",
        "edge.c2l3": "«Применить» и «вернуть как было» — две кнопки, обе с подтверждением",
        "edge.c3h": "Провенанс: подписанная запись о каждом изменении от ИИ",
        "edge.c3p": "Выдать доказательство может только тот, кто стоит <b>внутри цикла генерации</b>. Пульт там и стоит, поэтому запись о происхождении кода не восстанавливается задним числом по коммиту, а пишется в момент работы агента. На каждое применение изменений собирается пакет и подписывается Ed25519.",
        "edge.c3l1": "журнал сессии только дописывается, каждое событие несёт хеш предыдущего",
        "edge.c3l2": "коммит пульта несёт трейлеры, читаемые обычным git log",
        "edge.c3l3": "выгрузка за период — один файл с открытым ключом и сводкой проверки",
        "wiz.title": "dirigo — мастер первого запуска",
        "wiz.s1": "Среда",
        "wiz.s2": "Агенты",
        "wiz.s3": "Ключи",
        "wiz.s4": "Удалёнка",
        "wiz.miss": "не найден",
        "wiz.needtunnel": "нужен для туннеля",
        "wiz.btn": "Установить недостающее",
        "wiz.hint": "4 из 5 готово · дальше — агенты",
        "gate.title": "Как устроен шлюз",
        "gate.agent": "Агент в копии",
        "gate.agentsub": "git-worktree, точка возврата",
        "gate.checks": "Проверки проекта",
        "gate.checkssub": "npm · make · pytest · cargo · just",
        "gate.back": "✗ сломано — обратно агенту, ≤ 2 итерации",
        "gate.you": "Вы: построчный дифф",
        "gate.yousub": "применить · замечание к строке · вернуть как было",
        "gate.repo": "Ваш проект",
        "gate.reposub": "только то, что вы одобрили",
        "pack.title": "dirigo - пакет доказательств",
        "pack.seal": "подпись и журнал целы",
        "pack.k1": "агент и модель",
        "pack.k2": "хеш промпта",
        "pack.k3": "изоляция",
        "pack.k4": "проверки",
        "pack.k5": "возвратов агенту",
        "pack.k6": "одобрил",
        "pack.k7": "коммит",
        "pack.k8": "голова журнала",
        "pack.b1": "Проверить",
        "pack.b2": "Выгрузить для аудита",
        "evi.kicker": "Доказательства",
        "evi.title1": "Каждое «Применить» оставляет",
        "evi.title2": "подписанный пакет доказательств",
        "evi.lead": "Пакет собирается из того, что пульт и так видел: агент, промпт, проверки, решение человека. Подпись - Ed25519 ключом вашего инстанса; ключ лежит на вашей машине и наружу не уходит.",
        "evi.whath": "Что лежит в пакете",
        "evi.l1": "агент и модель, которые выполняли задачу",
        "evi.l2": "проект, задача и хеш промпта",
        "evi.l3": "вид изоляции и базовый коммит, от которого шла работа",
        "evi.l4": "каждый прогон проверок и его результат",
        "evi.l5": "сколько раз сломанная работа возвращалась агенту",
        "evi.l6": "сводка шлюза персональных данных: тип находки и количество",
        "evi.l7": "кто одобрил изменение и когда",
        "evi.l8": "файлы: что изменено, что удалено",
        "evi.l9": "итоговый коммит",
        "evi.l10": "голова цепочки журнала и версия продукта",
        "evi.subject": "checkout: округление цены в чеке и тест на него",
        "evi.logh": "Трейлеры читает обычный git.",
        "evi.logp": "Коммит, который делает пульт, несёт их прямо в теле сообщения: ни наш интерфейс, ни наш формат для этого не нужны.",
        "evi.c1h": "Подделка журнала видна",
        "evi.c1p": "Журнал сессии только дописывается, и каждое событие несёт хеш предыдущего. Вырезать событие, подменить его или переписать задним числом незаметно нельзя: проверка сверяет цепочку и показывает, где она рвётся. Это не обещание — есть тест, который подделывает журнал специально и ждёт, что подделку поймают.",
        "evi.c2h": "Выгрузка для аудита — один файл",
        "evi.c2p": "Пакеты за выбранный период выгружаются одним JSON: сами пакеты, открытый ключ инстанса и сводка проверки подписей и цепочек. Этот файл и есть то, что уходит аудитору.",
        "evi.c3h": "Проверяется без наших инструментов",
        "evi.c3p": "Подпись считается по стабильной сериализации пакета, открытый ключ лежит рядом в той же выгрузке. Проверить её может любой инструмент, умеющий Ed25519, — ставить Dirigo для этого не нужно.",
        "pii.kicker": "Периметр",
        "pii.title1": "Шлюз персональных данных",
        "pii.title2": "стоит перед агентом, а не после",
        "pii.lead": "Проверяются задача и каждое сообщение агенту — до отправки, и каждая строка, которую агент добавил в код, — до «Применить» и коммита. Ищутся e-mail, телефон, IBAN, номер карты (с проверкой Луна), секреты вида sk-, ghp_, AKIA, xox*, JWT и публичный IP. Локальные адреса 127.*, 10.* и 192.168.* утечкой не считаются.",
        "pii.m1h": "Выключен",
        "pii.m1p": "Проверка не выполняется: пульт не решает за вас, что считать персональными данными.",
        "pii.m2h": "Предупреждать",
        "pii.m2p": "Режим по умолчанию. Находки показываются и пишутся в журнал: тип и количество, для кода — файл и строка. Решение остаётся за человеком.",
        "pii.m3h": "Заменять",
        "pii.m3p": "Найденные значения заменяются метками до отправки. Агент видит структуру задачи, но не видит самих данных.",
        "pii.m4h": "Запрещать",
        "pii.m4p": "Задача или сообщение не уходят вовсе; код агента с находками не применяется и не коммитится. В журнал пишется факт срабатывания, осознанное исключение — тоже.",
        "pii.principle": "Сами найденные значения не сохраняются нигде: ни в журнале, ни в логе, ни в ответе API. Остаются только тип находки и количество. Иначе инструмент, который защищает персональные данные, сам становится их хранилищем.",
        "kb.kicker": "База знаний",
        "kb.h": "Знание о задаче остаётся внутри компании",
        "kb.p": "Необязательно и выключено по умолчанию. Если включить, после применения изменений запись о задаче уходит в вашу базу знаний — на ваш приёмник, внутри вашего периметра, — и дальше ищется по смыслу, а не по точному совпадению слов. Так опыт по задаче остаётся в компании, а не в чате, который закрыли.",
        "kb.l1": "в записи: автор, агент и модель, принятые решения, затронутые модули, проверки, кто одобрил, ссылка на пакет",
        "kb.l2": "выгрузка обязательно проходит через шлюз: в режиме block не уходит вовсе, в redact значения заменяются",
        "kb.l3": "ключ приёмника наружу из API не отдаётся — только факт, что он задан",
        "kb.rec": "запись о задаче",
        "kb.k1": "автор",
        "kb.k2": "агент и модель",
        "kb.k3": "модули",
        "kb.k4": "проверки",
        "kb.k5": "одобрил",
        "kb.k6": "пакет",
        "kb.gate": "выгрузка прошла шлюз: redact, 1 находка",
        "vfm.task": "Задача",
        "vfm.question": "Вопрос",
        "vfm.goal": "Цель",
        "vfm.t_solo": "Исправить вход по почте",
        "vfm.t_swarm": "Страница, сервер и тесты для оплаты",
        "vfm.t_fusion": "Как лучше хранить платежи?",
        "vfm.t_orch": "Запустить подписку в приложении",
        "vfm.tag_copy": "копия проекта",
        "vfm.tag_own": "ваш проект",
        "vfm.tag_shared": "одна копия на троих",
        "vfm.planner": "Планировщик",
        "vfm.planner_role": "режет на эпики",
        "vfm.resolver": "Резолютор",
        "vfm.resolver_role": "сводит конфликты",
        "vfm.judge": "Судья",
        "vfm.judge_role": "выбирает решение",
        "vfm.agent": "агент",
        "modes.kicker": "Режимы",
        "modes.title1": "Четыре режима",
        "modes.title2": "под размер задачи",
        "modes.lead": "От одной правки до цели, разбитой на части с автоматическим сведением результата. Режим переключается на лету — схема ниже живая.",
        "modes.solo.s1h": "Вы пишете задачу словами",
        "modes.solo.s1p": "Агент запускается в своей копии проекта, вы продолжаете работать.",
        "modes.solo.s2h": "Проверки гоняются сами",
        "modes.solo.s2p": "Тесты, линтер, сборка — до того, как вы увидите результат.",
        "modes.solo.s3h": "Вы смотрите дифф",
        "modes.solo.s3p": "Изменения построчно, ничего лишнего. Можно оставить замечание к строке.",
        "modes.solo.s4h": "Применить или откатить",
        "modes.solo.s4p": "Патч переносится в проект с подтверждением. «Вернуть как было» — тоже кнопка.",
        "modes.solo.note": "Режим по умолчанию: один агент, одна задача, максимальная простота.",
        "modes.swarm.s1h": "Задачу берут сразу несколько",
        "modes.swarm.s1p": "Одна цель уходит нескольким агентам параллельно.",
        "modes.swarm.s2h": "Модератор делит участки",
        "modes.swarm.s2p": "Каждый агент получает свою зону, пересечения по файлам исключены.",
        "modes.swarm.s3h": "Каждый пишет в своём участке",
        "modes.swarm.s3p": "Общая лента показывает прогресс всех агентов.",
        "modes.swarm.s4h": "Результаты сводятся в один патч",
        "modes.swarm.s4p": "Сведённый результат проходит тот же ревью-гейт, что и обычная сессия.",
        "modes.swarm.note": "Таймауты фаз и жёсткий модератор: рой не зависает на общих файлах.",
        "modes.fusion.s1h": "Один вопрос — разным моделям",
        "modes.fusion.s1p": "Несколько агентов отвечают независимо друг от друга.",
        "modes.fusion.s2h": "Ответы не правят проект",
        "modes.fusion.s2p": "Это режим выбора решения, а не параллельного кодинга.",
        "modes.fusion.s3h": "Варианты сравниваются",
        "modes.fusion.s3p": "Ответы сводятся в одно решение с обоснованием.",
        "modes.fusion.s4h": "Итог реализует один агент",
        "modes.fusion.s4p": "Выбранный вариант уходит в обычную сессию — с копией, проверками и ревью.",
        "modes.fusion.note": "Полезно на развилках архитектуры: сравнить подходы до того, как писать код.",
        "modes.orch.s1h": "Вы описываете цель целиком",
        "modes.orch.s1p": "«Сделать оплату и чеки» — без ручной декомпозиции.",
        "modes.orch.s2h": "Планировщик режет на части",
        "modes.orch.s2p": "К каждой части — критерий приёмки на обычном языке.",
        "modes.orch.s3h": "У каждой части своя копия",
        "modes.orch.s3p": "Части выполняются параллельно, каждая проходит проверки.",
        "modes.orch.s4h": "Пересечения разводятся",
        "modes.orch.s4p": "Конфликты между частями обрабатываются отдельным агентом, затем применение.",
        "modes.orch.note": "Лимиты шагов и дешёвые модели для планировщика — режим предсказуем по стоимости.",
        "agents.kicker": "Агенты",
        "agents.title1": "Мы не конкурируем с агентами —",
        "agents.title2": "мы их запускаем",
        "agents.lead": "Dirigo подхватывает CLI-агентов, которые уже стоят в системе, и доустанавливает недостающих. Вендор-независимо: ваши подписки и ключи, наш пульт поверх них.",
        "agents.list": "<b>13 агентов в реестре:</b> Claude Code · Codex · OpenCode · Kilo · Cursor · Devin · Hermes · zcode · MiniMax · Copilot · Gemini · Freebuff · Cline. Реестр находит их в PATH и в типовых местах установки на Linux, macOS и Windows.",
        "remote.kicker": "Удалённый доступ",
        "remote.title1": "Пульт дома,",
        "remote.title2": "вы — где угодно",
        "remote.lead": "Демон слушает на 127.0.0.1 — порт наружу не открывается. Доступ снаружи идёт через Cloudflare-туннель или Tailscale, а интерфейс — это обычное веб-приложение (PWA): открывается в браузере телефона и ставится на домашний экран.",
        "remote.step1h": "Порт закрыт по умолчанию",
        "remote.step1p": "Демон доступен только с самой машины; ничего не торчит в интернет.",
        "remote.step2h": "Cloudflare-туннель в два клика",
        "remote.step2p": "Мастер проверяет, стоит ли cloudflared, и поднимает туннель к локальному демону.",
        "remote.step3h": "Или Tailscale, если он у вас уже есть",
        "remote.step3p": "Пульт виден внутри вашей сети — без публичного адреса вообще.",
        "remote.step4h": "Телефон — тот же пульт",
        "remote.step4p": "PWA ставится на домашний экран; код на телефон не копируется, он остаётся на машине.",
        "term.discover": "# опрос системы…",
        "term.missing": "нет",
        "term.needtunnel": "нужен для туннеля",
        "term.found": "найден в PATH",
        "term.found2": "найден в PATH",
        "term.missing2": "нет",
        "term.keyneed": "нужен ключ ANTHROPIC_API_KEY",
        "term.queue": "# очередь: 1 агент… [########--] 78%",
        "term.verified": "установлен · при повторном опросе найден",
        "term.tunnelopen": "туннель поднят — пульт доступен с телефона",
        "sec.kicker": "Безопасность и self-host",
        "sec.title1": "Код не покидает периметр.",
        "sec.title2": "Это проверяется, а не обещается.",
        "sec.lead": "У нас нет облака с вашим кодом — его просто негде хранить. Всё, что делает пульт, происходит на вашей машине, а исходники целиком открыты.",
        "sec.c1h": "Всё локально",
        "sec.c1p": "Демон, агенты, копии проекта и история — на вашей машине. Наружу уходят только запросы самих агентов к их провайдерам, по вашим ключам.",
        "sec.c2h": "Ключи и порты",
        "sec.c2p": "Ключи хранятся локально и передаются процессу агента через переменные окружения. Демон слушает 127.0.0.1; наружу — только туннель, который включаете вы.",
        "sec.c3h": "Открыто и читаемо",
        "sec.c3p": "Лицензия MIT, около 18 тысяч строк на Bun и ноль npm-зависимостей: дерева зависимостей, в котором можно спрятать лишнее, просто нет.",
        "badge.soon": "скоро",
        "sec.soon": "Шлюз персональных данных и журнал происхождения входят в открытую часть — они описаны выше. Enterprise-слой поверх них — SSO и SCIM, интерфейс журнала аудита, политики доступа по ролям и SLA — доступен по запросу и развивается вместе с design-партнёрами в private beta, см. блок «Цены».",
        "dl.title1": "Установить —",
        "dl.title2": "одна команда",
        "dl.lead": "Скрипт ставит Bun, если его нет, скачивает бандл с этого же домена, сверяет SHA256, распаковывает в <code class=\"mono\">~/.dirigo</code> и открывает мастер первого запуска. Наружу ничего не открывает.",
        "dl.os1": "Linux / macOS",
        "dl.copy": "копировать",
        "dl.os2": "Windows",
        "dl.copy2": "копировать",
        "dl.os3": "Из исходников",
        "dl.copy3": "копировать",
        "dl.hint": "Нужен Bun 1.4+ (ставится скриптом). Проверено на Linux (Ubuntu, bun 1.4.3); macOS и Windows получают тот же бандл без нативных модулей, но на них установку мы прогоняли реже. Скрипт и бандл отдаются с того же домена по https, рядом лежит файл с контрольной суммой.",
        "price.kicker": "Цены",
        "price.title": "Ядро бесплатное. Навсегда.",
        "price.lead": "Весь продукт — в открытом доступе по MIT. Платить за пульт не нужно ни сейчас, ни потом; Enterprise-слой для регулируемых команд — по запросу.",
        "price.tag1": "Всё включено",
        "price.name1": "Self-host · MIT",
        "price.sum1": "0",
        "price.sum1s": "навсегда",
        "price.who1": "Разработчик, команда, свой сервер — без ограничений и регистрации",
        "price.li1a": "Все 4 режима и все 13 агентов",
        "price.li1b": "Изолированные копии, автопроверки, построчное ревью",
        "price.li1c": "Мастер установки агентов и ключей",
        "price.li1d": "Терминал, дашборд проекта, PWA",
        "price.li1e": "Удалённый доступ: Cloudflare-туннель, Tailscale",
        "price.li1f": "Ваши ключи и ваши токены — мы в них не участвуем",
        "price.cta1": "Установить",
        "price.betabadge": "private beta",
        "price.name2": "Enterprise",
        "price.sum2": "Набираем design-партнёров",
        "price.who2": "Для команд в регулируемом контуре, готовых строить этот слой вместе с нами",
        "price.honest": "В открытой части: журнал происхождения, подписанные пакеты доказательств, git-трейлеры, выгрузка для аудита и шлюз персональных данных. Enterprise-слой — SSO и SCIM, интерфейс журнала аудита, политики доступа по ролям и SLA — развивается вместе с design-партнёрами под их реальные требования. Состав и условия — по запросу.",
        "ent.name": "Имя",
        "ent.email": "E-mail",
        "ent.company": "Компания или команда",
        "ent.task": "Какую задачу нужно закрыть",
        "ent.submit": "Стать design-партнёром",
        "ent.note": "Заявка придёт команде Dirigo — ответим лично и предложим созвон.",
        "faq.kicker": "Вопросы",
        "faq.title": "Что обычно спрашивают",
        "footer.about": "Пульт ИИ-агентов, который ведёт запись происхождения кода: изолированные копии проекта, автопроверки до человека, построчное ревью и подписанный пакет доказательств на каждое применение. Ваши агенты, ваши ключи, ваш код.",
        "footer.col1": "Продукт",
        "footer.col2": "Разработчикам",
        "footer.install": "Установка",
        "footer.source": "Исходный код",
        "footer.col3": "Контакт",
        "footer.partners": "Design-партнёрство",
        "footer.issues": "Баги и предложения",
        "footer.bottom1": "© 2026 Dirigo - пульт ИИ-агентов и провенанс ИИ-кода · MIT",
        "footer.bottom2": "Сделано для тех, кто сам решает, что попадёт в проект",
        "am.wintitle": "пульт",
        "am.live": "live",
        "am.search": "Поиск",
        "am.sessions": "Проекты",
        "am.agentsLabel": "Агенты",
        "am.tab.chat": "Разговор",
        "am.tab.board": "Доска",
        "am.tab.history": "История",
        "am.tab.stats": "Статистика",
        "am.tab.settings": "Настройка",
        "am.tab.overview": "Обзор",
        "am.tab.terminal": "Терминал",
        "am.send": "Отправить",
        "am.placeholder": "Что далее?",
        "am.hint": "Enter — в очередь · / — команды · @ — файлы",
        "am.agentchip": "агент: claude",
        "am.m1": "Подключить Stripe-платежи: чекаут, вебхуки, ретраи",
        "am.m2": "kilo → создал копию (git-worktree), точка возврата зафиксирована",
        "am.m3": "claude → правит src/billing/stripe.ts: сессия чекаута",
        "am.m4": "codex → добавляет тесты подписок",
        "am.m5": "проверки: 24/24 PASS (bun test) · eslint чист · build ok",
        "am.m6": "claude → вебхуки: повторные доставки с упреждающим ретраем",
        "am.m7": "работаю над диффом…",
        "am.col1": "В очереди",
        "am.col2": "Работают",
        "am.col3": "Готово",
        "am.b1": "Настроить ретраи вебхуков",
        "am.b2": "Tест подписок: рево/даунгрейд",
        "am.b3": "Экран чекаута: локализация цен",
        "am.hist1": "feat(stripe): вебхуки с ретраями",
        "am.hist2": "feat(stripe): поток чекаута",
        "am.hist3": "test: контракты подписок",
                "am.hist4": "chore: обновить версии зависимостей",
        "am.stats1": "агентов",
        "am.stats2": "сессий",
        "am.stats3": "проверок",
        "am.stats4": "дел за сутки",
        "am.st1": "Среда",
        "am.st2": "Агенты",
        "am.st3": "Ключи",
        "am.st4": "Удалёнка",
        "am.env1": "bun 1.4.3",
        "am.env2": "git 2.40",
        "am.env3": "node 22",
        "am.env4": "ssl ok",
        "am.envfix": "Поставить недостающее",
        "am.setupsum": "установлено 9 · не хватает 4",
        "am.install": "Установить",
        "am.installed": "найден",
        "am.machine1": "my-vps · 1.2.3.4",
        "am.machine2": "office · 10.0.4.8",
        "am.tunnel": "туннель: выкл",
        "am.tunnelon": "Включить туннель",
        "am.changes": "Изменения",
        "am.files": "Файлы",
        "am.openeditor": "Открыть в редакторе",
        "am.branch": "branch: feat/stripe",
        "am.apply": "Применить в проект",
        "am.applying": "Применяю…",
        "am.applied": "Применено ✓",
        "am.revert": "Вернуть как было",
        "am.reverted": "откат к точке возврата",
        "am.commit": "Commit · все",
        "am.push": "Push",
        "am.pr": "PR",
        "am.merge": "Merge → main",
        "am.staged1": "src/billing/stripe.ts",
        "am.staged2": "src/billing/webhooks.ts",
        "am.staged3": "test/subscriptions.test.ts",
        // v1.3: вид по центру + сворачиваемые группы
        "am.diffAll": "Показать весь дифф",
        "am.centerDiff": "дифф",
        "am.centerFile": "файл",
        "am.centerClose": "Закрыть",
        "am.centerCommit": "дифф коммита",
        "am.folder": "Папка",
        "am.fileLines": "строк: ",
        "am.proj1": "api-gateway",
        "am.s2": "ревью: дифф stripe",
        "am.s3": "фикс: восстановление сессии",
        // v1.4: обзор-дашборд, терминал, статусы, голос/контекст, язык, компаньон
        "am.ovCommits": "коммитов",
        "am.ovSessions": "сессий",
        "am.ovTokens": "токенов",
        "am.ovWeek": "сессии за неделю",
        "am.termOpen": "Терминал",
        "am.termAdd": "+",
        "am.termKill": "✕",
        "am.termPh": "команда…",
        "am.termList": "Терминалы",
        "am.statusLabel": "Готово — работа ждёт вашего решения",
        "am.statusSteps": "шаги 4/4",
        "am.statusChecks": "проверки 24/24",
        "am.mic": "Голосовой ввод",
        "am.ctx": "Контекст: использовано 62%",
        "am.ctxShort": "контекст 62%",
        "am.langLabel": "Язык интерфейса",
        "am.companion": "Компаньон — раздел в разработке",
        "am.toastTermAdd": "Новый терминал — окно по центру",
        "am.toastTermKill": "Терминал закрыт",
        "am.toastTermRow": "Переключение терминала",
        "am.toastOvcard": "Откроем историю проекта",
        "am.toastMic": "Говорите — речь в текст",
        "am.toastCtx": "Контекст сессии: 62% использовано",
        "am.toastLang": "Язык интерфейса: RU | EN",
        "am.checksLabel": "Проверки",
        "am.chk1": "bun test — 24/24",
        "am.chk2": "eslint — 0 ошибок",
        "am.chk3": "build — 41 КБ",        "am.toastApplied": "Изменения перенесены в проект",
        "am.toastReverted": "Копия откатена к точке возврата",
        "am.toastCommit": "Коммит создан · ветка feat/stripe",
        "am.toastPush": "Ветка отправлена на origin",
        "am.toastPr": "Черновик PR открыт",
        "am.toastMerged": "Влито в main",
        "am.toastSearch": "Поиск по сессиям, действиям и файлам",
        "am.toastTheme": "Тема макета переключена",
        "am.toastAgent": "Выбран агент",
        "am.toastFile": "Файл открыт в дереве файлов",
        "am.toastInstall": "Ставим движок — очередь с прогрессом",
        "am.toastTunnel": "Cloudflared запущен — пульт доступен снаружи",
      },
      en: {
        "meta.title": "Dirigo - provenance for AI-written code: a signed record of every line an agent wrote",
        "a11y.skip": "Skip to content",
        "brand.sub": "AI agent console",
"ifaces.title": "The panel is not the only way in",
        "ifaces.cli.t": "CLI",
        "ifaces.cli.d": "./orch - sessions, copies, diffs and apply, from a terminal or a script.",
        "ifaces.mcp.t": "MCP server",
        "ifaces.mcp.d": "The panel is exposed as a set of tools to any MCP client.",
        "ifaces.sdk.t": "TypeScript SDK",
        "ifaces.sdk.d": "A typed client over the same REST API the web UI uses.",
        "ifaces.docker.t": "Docker",
        "ifaces.docker.d": "docker compose up, your projects directory is mounted inside.",
        "nav.problem": "Problem",
        "nav.how": "How it works",
        "nav.edge": "What's different",
        "nav.modes": "Modes",
        "nav.agents": "Agents",
        "nav.remote": "Remote",
        "nav.evidence": "Evidence",
        "nav.gateway": "Perimeter",
        "nav.security": "Security",
        "nav.pricing": "Pricing",
        "nav.faq": "FAQ",
        "nav.download": "Install",
        "hero.badge1": "Open source, MIT · self-host",
        "hero.badge2": "59 test suites · 1,488 checks",
        "hero.badge3": "zero npm dependencies",
        "hero.title1": "The record of who wrote each line",
        "hero.title2": "is made while the agent is writing it",
        "hero.lead": "Dirigo sits inside the generation loop, between your task and your project. That is why it knows the agent and the model, the prompt hash, every check that ran, how many times the work went back to the agent, who pressed “Apply” and which commit came out of it - and why every apply produces a signed evidence pack. From a finished commit, that record can no longer be assembled.",
        "hero.cta1": "Install with one command",
        "hero.cta2": "See what is inside an evidence pack",
        "hero.meta1": "agents in the registry",
        "hero.meta2": "working modes",
        "hero.meta3": "lines on Bun",
        "hero.meta4": "your keys, your code, your machine",
        "hero.shotnote": "An interactive mock-up of the interface — go ahead and click. Real screenshots are further down the page.",
        "prob.kicker": "Problem",
        "prob.title1": "One agent is no longer enough.",
        "prob.title2": "A second one can't run in the same project.",
        "prob.lead": "The moment you have more than one task, you hit three walls in a row — and none of them is fixed by yet another chat with a model.",
        "prob.c1h": "Agents fight over the working directory",
        "prob.c1p": "Two agents in one repository overwrite each other's files, break the git index and undo each other's edits. Waiting for the first one to finish means working one task at a time.",
        "prob.c2h": "A human starts the checks",
        "prob.c2p": "You read the diff, spend your attention on it, and only then find out that the build fails and the tests are red. The filter sits after you, when it belongs before you.",
        "prob.c3h": "Every machine is set up by hand",
        "prob.c3p": "Installing five CLI agents, wiring up keys, checking versions, getting access from a laptop — that is an evening of work, and it repeats on every new machine.",
        "prob.answer": "Dirigo closes all three: a project copy per agent, automatic checks before a human sees anything, agent installation straight from the interface.",
        "how.kicker": "How it works",
        "how.title1": "Three steps",
        "how.title2": "from a task to code in your project",
        "how.lead": "You describe the task in plain words. The console then makes a copy of the project, runs the checks and hands the result back to you for a decision — apply or roll back.",
        "how.s1": "Step 1",
        "how.bar1": "dirigo — new session",
        "how.copytype": "copy: git worktree",
        "how.t1": "Add price rounding to the receipt and a test for it",
        "how.run": "▶ Run",
        "how.r1": "worktree created · restore point saved",
        "how.r2": "your working directory is untouched",
        "how.r3": "the agent works, you carry on with your own thing",
        "how.c1h": "A task in words — the agent in an isolated copy",
        "how.c1p": "Every session gets its own git worktree and a restore point. Run as many parallel agents as the machine can take; they never collide.",
        "how.replay": "↻ replay the scenario",
        "how.s2": "Step 2",
        "how.bar2": "dirigo — checks inside the copy",
        "how.chk0": "project commands detected automatically: bun test · eslint · build",
        "how.chk1": "bun test — 23/24, round.test.ts failed",
        "how.chk2": "sent back to the agent with the error text (iteration 1 of 2)",
        "how.chk3": "bun test — 24/24",
        "how.chk4": "eslint — 0 errors · build — ok",
        "how.chk5": "only now is the result shown to you",
        "how.c2h": "Checks run before the human",
        "how.c2p": "The console detects your project's check commands (npm, make, pytest, cargo, just) and runs them inside the copy. A broken change never reaches you — it goes back to the agent.",
        "how.s3": "Step 3",
        "how.bar3": "dirigo — diff of the copy",
        "how.newf": "new +8 −0",
        "how.old": "return p * 1.2;&nbsp;&nbsp;(the old helper)",
        "how.apply": "✓ Apply to project",
        "how.r4": "changes moved in, the copy is gone",
        "how.r5": "“put it back” is a single button",
        "how.c3h": "Line-by-line review — the call is yours",
        "how.c3p": "A diff with line numbers and counters. A comment on a line goes back to the agent for a fix. Code reaches the project only after an explicit “Apply”.",
        "edge.kicker": "What's different",
        "edge.title1": "Three things almost nobody",
        "edge.title2": "in this category does",
        "edge.lead": "Plenty of tools can run agents in parallel. Almost none of them will install those agents on a clean machine, keep broken work away from you, and leave behind proof of what actually happened.",
        "edge.c1h": "One-click provisioning",
        "edge.c1p": "A four-step first-run wizard: <b>Environment → Agents → Keys → Remote</b>. The console probes the system itself, shows the bun, git, npm, ssh and cloudflared it found with paths and versions, installs the missing agents from the interface, points you to where each key comes from, and probes the system again after installing.",
        "edge.c1l1": "13 agents in the registry — installed from the UI, no terminal commands",
        "edge.c1l2": "environment detection with paths and versions, not “probably installed”",
        "edge.c1l3": "keys stay local and are handed to the agent process through ENV",
        "edge.shot1h": "Not a mock-up.",
        "edge.shot1p": "The diff screen from the running console: two files, line-by-line changes, counters.",
        "edge.c2h": "A review gate that sends work back",
        "edge.c2p": "There is a gate between the agent and your project. The project's checks run inside the copy before you see anything; a broken result goes back to the agent with the error text (no more than two iterations, so it doesn't burn tokens). Only work that builds and passes tests reaches you — and then you decide, line by line.",
        "edge.c2l1": "check commands are derived from the project: npm, make, pytest, cargo, just",
        "edge.c2l2": "line-by-line diff with comments: a note on a line goes to the agent",
        "edge.c2l3": "“Apply” and “put it back” — two buttons, both with confirmation",
        "edge.c3h": "Provenance: a signed record of every AI-written change",
        "edge.c3p": "Only something standing <b>inside the generation loop</b> can produce proof. The console stands there, so the record of where the code came from is not reconstructed from a commit afterwards — it is written while the agent works. Every apply builds a pack and signs it with Ed25519.",
        "edge.c3l1": "the session ledger is append-only, every event carries the hash of the previous one",
        "edge.c3l2": "the commit the console makes carries trailers that plain git log reads",
        "edge.c3l3": "an export for a period is one file with the public key and a verification summary",
        "wiz.title": "dirigo — first-run wizard",
        "wiz.s1": "Environment",
        "wiz.s2": "Agents",
        "wiz.s3": "Keys",
        "wiz.s4": "Remote",
        "wiz.miss": "not found",
        "wiz.needtunnel": "needed for the tunnel",
        "wiz.btn": "Install what's missing",
        "wiz.hint": "4 of 5 ready · agents are next",
        "gate.title": "How the gate is built",
        "gate.agent": "Agent in a copy",
        "gate.agentsub": "git worktree, restore point",
        "gate.checks": "Project checks",
        "gate.checkssub": "npm · make · pytest · cargo · just",
        "gate.back": "✗ broken — back to the agent, ≤ 2 iterations",
        "gate.you": "You: the line-by-line diff",
        "gate.yousub": "apply · comment on a line · put it back",
        "gate.repo": "Your project",
        "gate.reposub": "only what you approved",
        "pack.title": "dirigo - evidence pack",
        "pack.seal": "signature and ledger intact",
        "pack.k1": "agent and model",
        "pack.k2": "prompt hash",
        "pack.k3": "isolation",
        "pack.k4": "checks",
        "pack.k5": "returns to the agent",
        "pack.k6": "approved by",
        "pack.k7": "commit",
        "pack.k8": "ledger head",
        "pack.b1": "Verify",
        "pack.b2": "Export for audit",
        "evi.kicker": "Evidence",
        "evi.title1": "Every “Apply” leaves behind",
        "evi.title2": "a signed evidence pack",
        "evi.lead": "The pack is built from what the console already saw: the agent, the prompt, the checks, the human decision. It is signed with the Ed25519 key of your instance; the key stays on your machine and never leaves it.",
        "evi.whath": "What is inside the pack",
        "evi.l1": "the agent and the model that did the work",
        "evi.l2": "the project, the task and the prompt hash",
        "evi.l3": "the kind of isolation and the base commit the work started from",
        "evi.l4": "every run of the checks and its result",
        "evi.l5": "how many times broken work was returned to the agent",
        "evi.l6": "the personal-data gateway summary: kind of match and count",
        "evi.l7": "who approved the change and when",
        "evi.l8": "the files: what changed, what was deleted",
        "evi.l9": "the resulting commit",
        "evi.l10": "the ledger head and the product version",
        "evi.subject": "checkout: round the price on the receipt + a test for it",
        "evi.logh": "Plain git reads the trailers.",
        "evi.logp": "The commit the console makes carries them in the message body: neither our interface nor our format is needed to read them.",
        "evi.c1h": "Tampering with the ledger is visible",
        "evi.c1p": "The session ledger is append-only, and every event carries the hash of the previous one. Cutting an event out, swapping it or rewriting it after the fact cannot go unnoticed: verification walks the chain and shows where it breaks. This is not a promise - there is a test that forges the ledger on purpose and expects the forgery to be caught.",
        "evi.c2h": "An audit export is one file",
        "evi.c2p": "Packs for a chosen period are exported as a single JSON: the packs themselves, the public key of the instance, and a summary of the signature and chain verification. That file is what goes to the auditor.",
        "evi.c3h": "Verified without our tools",
        "evi.c3p": "The signature is computed over a stable serialization of the pack, and the public key sits next to it in the same export. Any tool that can do Ed25519 can check it - installing Dirigo for that is not required.",
        "pii.kicker": "Perimeter",
        "pii.title1": "The personal-data gateway",
        "pii.title2": "stands before the agent, not after it",
        "pii.lead": "The task and every message to the agent are scanned before they leave, and every line the agent adds to the code is scanned before apply and commit. It looks for e-mail, phone numbers, IBAN, card numbers (with the Luhn check), secrets such as sk-, ghp_, AKIA, xox*, JWT and public IP addresses. Local addresses 127.*, 10.* and 192.168.* are not treated as a leak.",
        "pii.m1h": "Off",
        "pii.m1p": "No scanning at all: the console does not decide for you what counts as personal data.",
        "pii.m2h": "Warn",
        "pii.m2p": "The default. Matches are shown and recorded in the ledger: the kind and the count, and for code the file and line. The call stays with the human.",
        "pii.m3h": "Redact",
        "pii.m3p": "Matched values are replaced with labels before sending. The agent sees the shape of the task but not the data itself.",
        "pii.m4h": "Block",
        "pii.m4p": "The task or message does not go out at all; agent code with matches is neither applied nor committed. The ledger records the fact, and any conscious override too.",
        "pii.principle": "The matched values themselves are stored nowhere: not in the ledger, not in the log, not in the API response. Only the kind of match and the count remain. Otherwise a tool that protects personal data becomes a store of it.",
        "kb.kicker": "Knowledge base",
        "kb.h": "Knowledge about a task stays inside the company",
        "kb.p": "Optional and off by default. Turn it on and, once changes are applied, a record of the task goes to your own knowledge base - your receiver, inside your own perimeter - where it is searched by meaning rather than by exact wording. The experience from the task stays in the company instead of in a chat someone closed.",
        "kb.l1": "in the record: the author, the agent and model, the decisions taken, the modules touched, the checks, who approved, a link to the pack",
        "kb.l2": "the export always passes through the gateway: in block mode it does not go out, in redact mode the values are replaced",
        "kb.l3": "the receiver key is never returned by the API - only the fact that one is set",
        "kb.rec": "task record",
        "kb.k1": "author",
        "kb.k2": "agent and model",
        "kb.k3": "modules",
        "kb.k4": "checks",
        "kb.k5": "approved by",
        "kb.k6": "pack",
        "kb.gate": "export passed the gateway: redact, 1 match",
        "vfm.task": "Task",
        "vfm.question": "Question",
        "vfm.goal": "Goal",
        "vfm.t_solo": "Fix login by email",
        "vfm.t_swarm": "Page, server and tests for payments",
        "vfm.t_fusion": "What's the best way to store payments?",
        "vfm.t_orch": "Launch subscriptions in the app",
        "vfm.tag_copy": "copy of the project",
        "vfm.tag_own": "your project",
        "vfm.tag_shared": "one copy shared by three",
        "vfm.planner": "Planner",
        "vfm.planner_role": "splits epics",
        "vfm.resolver": "Resolver",
        "vfm.resolver_role": "merges conflicts",
        "vfm.judge": "Judge",
        "vfm.judge_role": "picks the solution",
        "vfm.agent": "agent",
        "modes.kicker": "Modes",
        "modes.title1": "Four modes",
        "modes.title2": "for the size of the task",
        "modes.lead": "From a single edit to a goal split into parts with the results merged automatically. The mode switches on the fly — the diagram below is live.",
        "modes.solo.s1h": "You write the task in words",
        "modes.solo.s1p": "The agent starts in its own copy of the project; you keep working.",
        "modes.solo.s2h": "Checks run on their own",
        "modes.solo.s2p": "Tests, linter, build — before you ever see the result.",
        "modes.solo.s3h": "You look at the diff",
        "modes.solo.s3p": "Changes line by line, nothing extra. You can leave a comment on a line.",
        "modes.solo.s4h": "Apply or roll back",
        "modes.solo.s4p": "The patch moves into the project with a confirmation. “Put it back” is a button too.",
        "modes.solo.note": "Default mode: one agent, one task, maximum simplicity.",
        "modes.swarm.s1h": "Several agents take the task",
        "modes.swarm.s1p": "One goal goes to several agents in parallel.",
        "modes.swarm.s2h": "A moderator splits the ground",
        "modes.swarm.s2p": "Each agent gets its own zone, so file overlaps are ruled out.",
        "modes.swarm.s3h": "Everyone writes in their own zone",
        "modes.swarm.s3p": "A shared feed shows the progress of every agent.",
        "modes.swarm.s4h": "Results merge into one patch",
        "modes.swarm.s4p": "The merged result goes through the same review gate as an ordinary session.",
        "modes.swarm.note": "Phase timeouts and a strict moderator: the swarm doesn't stall on shared files.",
        "modes.fusion.s1h": "One question — different models",
        "modes.fusion.s1p": "Several agents answer independently of each other.",
        "modes.fusion.s2h": "Answers don't touch the project",
        "modes.fusion.s2p": "This is a mode for picking a solution, not for parallel coding.",
        "modes.fusion.s3h": "The options get compared",
        "modes.fusion.s3p": "The answers are merged into one decision with a rationale.",
        "modes.fusion.s4h": "One agent implements the winner",
        "modes.fusion.s4p": "The chosen option goes into a normal session — copy, checks and review included.",
        "modes.fusion.note": "Useful at architecture forks: compare approaches before writing any code.",
        "modes.orch.s1h": "You describe the whole goal",
        "modes.orch.s1p": "“Build payments and receipts” — no manual breakdown.",
        "modes.orch.s2h": "A planner cuts it into parts",
        "modes.orch.s2p": "Each part gets an acceptance criterion in plain language.",
        "modes.orch.s3h": "Every part has its own copy",
        "modes.orch.s3p": "Parts run in parallel and each one goes through the checks.",
        "modes.orch.s4h": "Overlaps are resolved",
        "modes.orch.s4p": "Conflicts between parts are handled by a separate agent, then the result is applied.",
        "modes.orch.note": "Step limits and cheap models for the planner keep this mode predictable in cost.",
        "agents.kicker": "Agents",
        "agents.title1": "We don't compete with agents —",
        "agents.title2": "we run them",
        "agents.lead": "Dirigo picks up the CLI agents already on your system and installs the missing ones. Vendor-independent: your subscriptions and your keys, our console on top of them.",
        "agents.list": "<b>13 agents in the registry:</b> Claude Code · Codex · OpenCode · Kilo · Cursor · Devin · Hermes · zcode · MiniMax · Copilot · Gemini · Freebuff · Cline. The registry finds them in PATH and in the usual install locations on Linux, macOS and Windows.",
        "remote.kicker": "Remote access",
        "remote.title1": "The console stays home,",
        "remote.title2": "you can be anywhere",
        "remote.lead": "The daemon listens on 127.0.0.1 — no port is opened to the outside. Access from outside goes through a Cloudflare tunnel or Tailscale, and the interface is a plain web app (PWA): it opens in your phone's browser and installs to the home screen.",
        "remote.step1h": "The port is closed by default",
        "remote.step1p": "The daemon is reachable only from the machine itself; nothing sticks out into the internet.",
        "remote.step2h": "A Cloudflare tunnel in two clicks",
        "remote.step2p": "The wizard checks whether cloudflared is installed and raises a tunnel to the local daemon.",
        "remote.step3h": "Or Tailscale, if you already use it",
        "remote.step3p": "The console is visible inside your own network — with no public address at all.",
        "remote.step4h": "Your phone is the same console",
        "remote.step4p": "The PWA installs to the home screen; code is never copied to the phone, it stays on the machine.",
        "term.discover": "# probing the system…",
        "term.missing": "missing",
        "term.needtunnel": "needed for the tunnel",
        "term.found": "found in PATH",
        "term.found2": "found in PATH",
        "term.missing2": "missing",
        "term.keyneed": "needs the ANTHROPIC_API_KEY",
        "term.queue": "# queue: 1 agent… [########--] 78%",
        "term.verified": "installed · found on the next probe",
        "term.tunnelopen": "tunnel is up — the console is reachable from your phone",
        "sec.kicker": "Security and self-host",
        "sec.title1": "Your code never leaves the perimeter.",
        "sec.title2": "That is checkable, not a promise.",
        "sec.lead": "We have no cloud with your code in it — there is simply nowhere to put it. Everything the console does happens on your machine, and the sources are fully open.",
        "sec.c1h": "Everything is local",
        "sec.c1p": "The daemon, the agents, the project copies and the history live on your machine. The only outbound traffic is the agents' own calls to their providers, with your keys.",
        "sec.c2h": "Keys and ports",
        "sec.c2p": "Keys are stored locally and handed to the agent process through environment variables. The daemon listens on 127.0.0.1; the only way out is a tunnel you switch on yourself.",
        "sec.c3h": "Open and readable",
        "sec.c3p": "MIT licence, about 18 thousand lines on Bun and zero npm dependencies: there is no dependency tree to hide anything in.",
        "badge.soon": "planned",
        "sec.soon": "The personal-data gateway and the provenance ledger are part of the open core — they are described above. The Enterprise layer on top of them — SSO and SCIM, an audit-log UI, role-based access policies and an SLA — is available on request and is being developed together with design partners in a private beta; see the pricing block.",
        "dl.title1": "Install —",
        "dl.title2": "one command",
        "dl.lead": "The script installs Bun if it is missing, downloads the bundle from this same domain, verifies the SHA256, unpacks it into <code class=\"mono\">~/.dirigo</code> and opens the first-run wizard. It opens nothing to the outside.",
        "dl.os1": "Linux / macOS",
        "dl.copy": "copy",
        "dl.os2": "Windows",
        "dl.copy2": "copy",
        "dl.os3": "From source",
        "dl.copy3": "copy",
        "dl.hint": "Requires Bun 1.4+ (the script installs it). Verified on Linux (Ubuntu, bun 1.4.3); macOS and Windows get the same bundle with no native modules, but we have run the install there less often. The script and the bundle are served from the same domain over https, with a checksum file next to them.",
        "price.kicker": "Pricing",
        "price.title": "The core is free. Forever.",
        "price.lead": "The whole product is open under MIT. You don't pay for the console now and you won't later; the Enterprise layer for regulated teams is available on request.",
        "price.tag1": "All inclusive",
        "price.name1": "Self-host · MIT",
        "price.sum1": "0",
        "price.sum1s": "forever",
        "price.who1": "A developer, a team, your own server — no limits, no sign-up",
        "price.li1a": "All 4 modes and all 13 agents",
        "price.li1b": "Isolated copies, automatic checks, line-by-line review",
        "price.li1c": "The wizard that installs agents and keys",
        "price.li1d": "Terminal, project dashboard, PWA",
        "price.li1e": "Remote access: Cloudflare tunnel, Tailscale",
        "price.li1f": "Your keys and your tokens — we take no part in them",
        "price.cta1": "Install",
        "price.betabadge": "private beta",
        "price.name2": "Enterprise",
        "price.sum2": "Looking for design partners",
        "price.who2": "For teams in a regulated perimeter who want to build this layer with us",
        "price.honest": "In the open core: the provenance ledger, signed evidence packs, git trailers, the audit export and the personal-data gateway. The Enterprise layer — SSO and SCIM, an audit-log UI, role-based access policies and an SLA — is being developed together with design partners against their real requirements. Scope and terms on request.",
        "ent.name": "Name",
        "ent.email": "E-mail",
        "ent.company": "Company or team",
        "ent.task": "Which problem you need solved",
        "ent.submit": "Become a design partner",
        "ent.note": "Your request goes to the Dirigo team — we will reply personally and suggest a call.",
        "faq.kicker": "FAQ",
        "faq.title": "Frequently asked",
        "footer.about": "A console for AI agents that keeps the record of where the code came from: isolated project copies, automatic checks before a human, line-by-line review and a signed evidence pack on every apply. Your agents, your keys, your code.",
        "footer.col1": "Product",
        "footer.col2": "For developers",
        "footer.install": "Install",
        "footer.source": "Source code",
        "footer.col3": "Contact",
        "footer.partners": "Design partnership",
        "footer.issues": "Bugs and ideas",
        "footer.bottom1": "© 2026 Dirigo - a console for AI agents and provenance for AI-written code · MIT",
        "footer.bottom2": "Made for people who decide for themselves what lands in their project",
        "am.wintitle": "console",
        "am.live": "live",
        "am.search": "Search",
        "am.sessions": "Projects",
        "am.agentsLabel": "Agents",
        "am.tab.chat": "Chat",
        "am.tab.board": "Board",
        "am.tab.history": "History",
        "am.tab.stats": "Stats",
        "am.tab.settings": "Setup",
        "am.tab.overview": "Overview",
        "am.tab.terminal": "Terminal",
        "am.send": "Send",
        "am.placeholder": "What next?",
        "am.hint": "Enter — queue · / — commands · @ — files",
        "am.agentchip": "agent: claude",
        "am.m1": "Add Stripe payments: checkout, webhooks, retries",
        "am.m2": "kilo → made a copy (git-worktree), restore point fixed",
        "am.m3": "claude → editing src/billing/stripe.ts: checkout session",
        "am.m4": "codex → adding subscription tests",
        "am.m5": "checks: 24/24 PASS (bun test) · eslint clean · build ok",
        "am.m6": "claude → webhooks: redelivery with backoff retry",
        "am.m7": "working on the diff…",
        "am.col1": "Queued",
        "am.col2": "Running",
        "am.col3": "Done",
        "am.b1": "Wire webhook retries",
        "am.b2": "Subscription tests: renew/downgrade",
        "am.b3": "Checkout screen: price localization",
        "am.hist1": "feat(stripe): webhooks with retries",
        "am.hist2": "feat(stripe): checkout flow",
        "am.hist3": "test: subscription contracts",
        "am.hist4": "chore: bump dependency versions",
        "am.stats1": "agents",
        "am.stats2": "sessions",
        "am.stats3": "checks",
        "am.stats4": "tasks per day",
        "am.st1": "Environment",
        "am.st2": "Agents",
        "am.st3": "Keys",
        "am.st4": "Remote",
        "am.env1": "bun 1.4.3",
        "am.env2": "git 2.40",
        "am.env3": "node 22",
        "am.env4": "ssh ok",
        "am.envfix": "Install what's missing",
        "am.setupsum": "9 installed · 4 missing",
        "am.install": "Install",
        "am.installed": "found",
        "am.machine1": "my-vps · 1.2.3.4",
        "am.machine2": "office · 10.0.4.8",
        "am.tunnel": "tunnel: off",
        "am.tunnelon": "Start tunnel",
        "am.changes": "Changes",
        "am.files": "Files",
        "am.openeditor": "Open in editor",
        "am.branch": "branch: feat/stripe",
        "am.apply": "Apply to project",
        "am.applying": "Applying…",
        "am.applied": "Applied ✓",
        "am.revert": "Back as it was",
        "am.reverted": "reverted to restore point",
        "am.commit": "Commit · all",
        "am.push": "Push",
        "am.pr": "PR",
        "am.merge": "Merge → main",
        "am.staged1": "src/billing/stripe.ts",
        "am.staged2": "src/billing/webhooks.ts",
        "am.staged3": "test/subscriptions.test.ts",
        // v1.3: вид по центру + сворачиваемые группы
        "am.diffAll": "Show full diff",
        "am.centerDiff": "diff",
        "am.centerFile": "file",
        "am.centerClose": "Close",
        "am.centerCommit": "commit diff",
        "am.folder": "Folder",
        "am.fileLines": "lines: ",
        "am.proj1": "api-gateway",
        "am.s2": "review: stripe diff",
        "am.s3": "fix: session restore",
        // v1.4: overview dashboard, terminal, statuses, voice/context, language, companion
        "am.ovCommits": "commits",
        "am.ovSessions": "sessions",
        "am.ovTokens": "tokens",
        "am.ovWeek": "sessions this week",
        "am.termOpen": "Terminal",
        "am.termAdd": "+",
        "am.termKill": "✕",
        "am.termPh": "command…",
        "am.termList": "Terminals",
        "am.statusLabel": "Done — waiting for your decision",
        "am.statusSteps": "steps 4/4",
        "am.statusChecks": "checks 24/24",
        "am.mic": "Voice input",
        "am.ctx": "Context: 62% used",
        "am.ctxShort": "context 62%",
        "am.langLabel": "Interface language",
        "am.companion": "Companion — section in development",
        "am.toastTermAdd": "New terminal — window in the center",
        "am.toastTermKill": "Terminal closed",
        "am.toastTermRow": "Switching terminal",
        "am.toastOvcard": "Opening project history",
        "am.toastMic": "Speak — speech to text",
        "am.toastCtx": "Session context: 62% used",
        "am.toastLang": "Interface language: RU | EN",
        "am.checksLabel": "Checks",
        "am.chk1": "bun test — 24/24",
        "am.chk2": "eslint — 0 errors",
        "am.chk3": "build — 41 KB",
        "am.toastApplied": "Changes moved into the project",
        "am.toastReverted": "Copy reverted to the restore point",
        "am.toastCommit": "Commit created · branch feat/stripe",
        "am.toastPush": "Branch pushed to origin",
        "am.toastPr": "Draft PR opened",
        "am.toastMerged": "Merged into main",
        "am.toastSearch": "Search sessions, actions and files",
        "am.toastTheme": "Mock theme switched",
        "am.toastAgent": "Agent selected",
        "am.toastFile": "File opened in the tree",
        "am.toastInstall": "Installing the engine — queue with progress",
        "am.toastTunnel": "Cloudflared started — the console is reachable from outside",
      },
    };

    var apply = function (lang) {
      root.setAttribute("lang", lang === "en" ? "en" : "ru");
      var dict = DICT[lang === "en" ? "en" : "ru"] || DICT.ru;
      // словарь доступен макету пульта (hero) и сценам — они перерисуются ниже
      window.__siteDict = dict;
      document.title = dict["meta.title"] || document.title;

      var els = document.querySelectorAll("[data-i18n]");
      els.forEach(function (el) {
        var key = el.getAttribute("data-i18n");
        var val = dict[key];
        if (val === undefined) return; // нет перевода — оставляем как есть
        if (!el.hasAttribute("data-i18n-orig")) {
          var orig = el.innerHTML;
          el.setAttribute("data-i18n-orig", orig);
        }
        el.innerHTML = val;
      });
      document.querySelectorAll(".lang-toggle button").forEach(function (b) {
        b.classList.toggle("on", b.getAttribute("data-lang") === lang);
      });
      // всё, что рисуется из JS, перерисовываем на выбранном языке
      if (typeof window.__rerenderAppMock === "function") window.__rerenderAppMock();
      if (typeof window.__rerenderFaq === "function") window.__rerenderFaq(lang);
      if (typeof window.__rerenderVfm === "function") window.__rerenderVfm(currentVfmMode());
    };
    var currentVfmMode = function () {
      var on = document.querySelector(".tab--on");
      return on ? (on.dataset.mode || "solo") : "solo";
    };

    var saved2 = null;
    try { saved2 = localStorage.getItem(KEY); } catch (e) { /* приватный режим */ }
    apply(saved2 === "en" ? "en" : "ru");

    document.querySelectorAll(".lang-toggle button").forEach(function (b) {
      b.addEventListener("click", function () {
        var lang = b.getAttribute("data-lang");
        apply(lang);
        try { localStorage.setItem(KEY, lang); } catch (e) { /* приватный режим */ }
      });
    });
  })();

  /* ---------------- клипы: запуск сценариев по попаданию в вьюпорт + replay ---------------- */

  (function initClips() {
    var clips = $$(".clip");
    if (!clips.length) return;

    var play = function (clip) {
      clip.classList.remove("clip--play");
      void clip.offsetWidth; // рефлоу — иначе анимация не перезапустится
      clip.classList.add("clip--play");
    };

    if ("IntersectionObserver" in window) {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          if (en.isIntersecting) { play(en.target); io.unobserve(en.target); }
        });
      }, { threshold: 0.35 });
      clips.forEach(function (c) { io.observe(c); });
    } else {
      clips.forEach(play);
    }

    $$("[data-replay]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var clip = document.getElementById(btn.dataset.replay);
        if (clip) play(clip);
      });
    });
  })();

  /* ---------------- интерактивный макет пульта v1.3 (hero) ----------------
     Реплика актуального веб-пульта (релиз 1.3): сессии + чат с агентами,
     доска режимов, история версий, статистика, настройки; правая панель
     «Изменения/Файлы» со сворачиваемыми группами, кнопками Применить/
     Вернуть/Commit/Push/PR/Merge; клик по файлу/коммиту — построчный
     дифф по центру (как view-file в v1.3). Всё кликабельно. */

  (function initAppMock() {
    var rootEl = document.getElementById("appmock");
    if (!rootEl) return;

    var t = function (key, fallback) {
      var dict = window.__siteDict || {};
      return dict[key] || fallback || "";
    };

    var state = {
      view: "chat",        // chat | board | history | stats | settings
      session: 0,          // активная сессия
      rtab: "changes",     // changes | files
      applied: false,
      agent: "cc",
      runTimer: null,
      center: null,        // v1.3: вид по центру {kind:"diff"|"file", title, meta, files:[{name,lines}]}
      rgroups: { changes: true, checks: true }, // v1.3: сворачивание групп правой панели
      psopen: true,        // v1.3: группа проектов в сайдбаре раскрыта
    };

    var SESSIONS = [
      { icon: "ag-claude", titleKey: "am.m1", state: "run" },
      { icon: "ag-kilo", titleKey: "am.s2", state: "ok" },
      { icon: "ag-codex", titleKey: "am.s3", state: "idle" },
    ];

    var MOCK_AGENTS = [
      { id: "cc", name: "Claude Code", icon: "ag-claude" },
      { id: "codex", name: "Codex CLI", icon: "ag-codex" },
      { id: "gemini", name: "Gemini CLI", icon: "ag-gemini" },
      { id: "kilo", name: "Kilo", icon: "ag-kilo" },
    ];

    var STAGED = ["am.staged1", "am.staged2", "am.staged3"];

    // v1.3: данные построчных диффов и содержимого файлов для вида по центру
    // (как openCenter/showCommitDiff в реальном пульте).
    var escHtml = function (s) {
      return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    };

    var STRIPE_DIFF = [
      ["del", "export function createCheckoutSession(priceId: string) {"],
      ["del", "  return stripe.checkout.sessions.create({ mode: \"payment\", line_items: [{ price: priceId, quantity: 1 }] });"],
      ["del", "}"],
      ["ctx", ""],
      ["add", "export async function createCheckoutSession("],
      ["add", "  priceId: string,"],
      ["add", "  opts: { trialDays?: number; customerId?: string } = {},"],
      ["add", ") {"],
      ["add", "  const mode = opts.trialDays ? \"subscription\" : \"payment\";"],
      ["add", "  return stripe.checkout.sessions.create({"],
      ["add", "    mode,"],
      ["add", "    line_items: [{ price: priceId, quantity: 1 }],"],
      ["add", "    customer: opts.customerId,"],
      ["add", "    subscription_data: opts.trialDays ? { trial_period_days: opts.trialDays } : undefined,"],
      ["add", "    success_url: APP_URL + \"/billing/success?session_id={CHECKOUT_SESSION_ID}\","],
      ["add", "    cancel_url: APP_URL + \"/billing/cancel\","],
      ["add", "  });"],
      ["add", "}"],
    ];
    var WEBHOOKS_DIFF = [
      ["add", "// подпись + идемпотентность: повторные доставки Stripe не создают дублей"],
      ["add", "export function verifyWebhook(raw: string, sig: string | undefined) {"],
      ["add", "  if (!sig) throw new Error(\"missing stripe-signature\");"],
      ["add", "  return stripe.webhooks.constructEvent(raw, sig, WEBHOOK_SECRET);"],
      ["add", "}"],
      ["ctx", ""],
      ["add", "const handled = new Set<string>();"],
      ["add", "export async function once(eventId: string, fn: () => Promise<void>) {"],
      ["add", "  if (handled.has(eventId)) return;      // ретрай Stripe — уже обработано"],
      ["add", "  handled.add(eventId);"],
      ["add", "  await fn();"],
      ["add", "}"],
    ];
    var TESTS_DIFF = [
      ["ctx", "describe(\"subscription contracts\", () => {"],
      ["add", "  it(\"downgrade keeps access until period end\", async () => { /* v1.3 */ });"],
      ["ctx", "});"],
    ];
    var DEPS_DIFF = [
      ["del", "    \"stripe\": \"^16.2.0\","],
      ["del", "    \"zod\": \"^3.23.8\","],
      ["add", "    \"stripe\": \"^17.3.0\","],
      ["add", "    \"zod\": \"^3.25.0\","],
    ];
    // диффы staged-файлов (по ключу названия из словаря)
    var FILE_DIFFS = {};
    FILE_DIFFS["src/billing/stripe.ts"] = { add: 29, del: 3, lines: STRIPE_DIFF };
    FILE_DIFFS["src/billing/webhooks.ts"] = { add: 9, del: 0, lines: WEBHOOKS_DIFF };
    FILE_DIFFS["test/subscriptions.test.ts"] = { add: 1, del: 0, lines: TESTS_DIFF };
    // диффы коммитов истории (индекс строки = индекс hist1..hist4)
    var COMMIT_DIFFS = [
      { name: "src/billing/webhooks.ts", lines: WEBHOOKS_DIFF },
      { name: "src/billing/stripe.ts", lines: STRIPE_DIFF },
      { name: "test/subscriptions.test.ts", lines: TESTS_DIFF },
      { name: "package.json", lines: DEPS_DIFF },
    ];
    var FILE_CONTENT = {};
    FILE_CONTENT["src/billing/stripe.ts"] = [
      "import Stripe from \"stripe\";",
      "",
      "const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);",
      "",
      "// v1.3: чекаут — payment | subscription (trial) с возвратом по URL",
      "export async function createCheckoutSession(priceId: string) { ... }",
    ].join("\n");
    FILE_CONTENT["src/billing/webhooks.ts"] = [
      "import { verifyWebhook, once } from \"./webhooks\";",
      "",
      "// Stripe ретраит вебхуки до 3 раз — обрабатываем событие один раз",
      "export async function onEvent(req: Request) {",
      "  const ev = verifyWebhook(await req.text(), req.headers.get(\"stripe-signature\")!);",
      "  await once(ev.id, () => dispatch(ev));",
      "}",
    ].join("\n");
    FILE_CONTENT["test/subscriptions.test.ts"] = [
      "import { describe, it, expect } from \"bun:test\";",
      "",
      "describe(\"subscription contracts\", () => {",
      "  it(\"downgrade keeps access until period end\", async () => { ... });",
      "});",
    ].join("\n");

    var themeDots = ["#7c5cff", "#22d3ee", "#34d399", "#f472b6", "#fbbf24"];

    var toastTimer = null;
    var toast = function (msg) {
      var box = document.getElementById("amToasts");
      if (!box) return;
      var el = document.createElement("div");
      el.className = "am-toast";
      el.textContent = msg;
      box.appendChild(el);
      setTimeout(function () {
        el.classList.add("am-toast--out");
        setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 350);
      }, 1900);
      while (box.children.length > 2) box.removeChild(box.firstChild);
    };

    var feed = []; // initial chat lines
    var initFeed = function () {
      feed = ["am.m2", "am.m3", "am.m4", "am.m5"];
    };
    initFeed();

    /* ---------- отрисовка ---------- */

    var drawTabs = function () {
      var box = document.getElementById("amTabs");
      if (!box) return;
      var tabs = [["overview", "am.tab.overview"], ["chat", "am.tab.chat"], ["board", "am.tab.board"], ["history", "am.tab.history"], ["stats", "am.tab.stats"], ["terminal", "am.tab.terminal"], ["settings", "am.tab.settings"]];
      box.innerHTML = tabs.map(function (tb) {
        return '<button class="appmock__tab' + (state.view === tb[0] ? " appmock__tab--on" : "") + '" data-am-view="' + tb[0] + '">' + t(tb[1]) + "</button>";
      }).join("");
    };

    var drawSide = function () {
      var sess = document.getElementById("amSessions");
      if (sess) {
        sess.innerHTML = SESSIONS.map(function (s, i) {
          var title = s.titleKey ? t(s.titleKey) : s.title;
          var dot = s.state === "run" ? "am-dot--run" : s.state === "ok" ? "am-dot--ok" : "";
          return '<button class="am-sess' + (state.session === i ? " am-sess--on" : "") + '" data-am-session="' + i + '">' +
            '<svg viewBox="0 0 32 32" aria-hidden="true"><use href="#' + s.icon + '"/></svg><span>' + title + "</span><i class=\"am-dot " + dot + '"></i></button>';
        }).join("");
      }
      var agents = document.getElementById("amAgents");
      if (agents) {
        agents.innerHTML = MOCK_AGENTS.map(function (a) {
          return '<button class="am-agent' + (state.agent === a.id ? " am-agent--on" : "") + '" data-am-agent="' + a.id + '">' +
            '<svg viewBox="0 0 32 32" aria-hidden="true"><use href="#' + a.icon + '"/></svg><span>' + a.name + "</span></button>";
        }).join("");
      }
      var themes = document.getElementById("amThemes");
      if (themes) {
        themes.innerHTML = themeDots.map(function (c, i) {
          return '<button class="am-th' + (i === 0 ? " am-th--on" : "") + '" data-am-theme="' + i + '" style="--c:' + c + '" title="' + t("am.toastTheme") + '"></button>';
        }).join("");
      }
    };

    var drawRight = function () {
      var rtabs = document.getElementById("amRtabs");
      var body = document.getElementById("amRight");
      if (!rtabs || !body) return;
      rtabs.innerHTML =
        '<button class="am-rtab' + (state.rtab === "changes" ? " am-rtab--on" : "") + '" data-am-rtab="changes">' + t("am.changes") + ' <span class="am-count">' + (state.applied ? "0" : "+38") + "</span></button>" +
        '<button class="am-rtab' + (state.rtab === "files" ? " am-rtab--on" : "") + '" data-am-rtab="files">' + t("am.files") + "</button>";
      if (state.rtab === "files") {
        body.innerHTML =
          '<div class="am-tree">' +
          '<button class="am-tree__row" data-am-tree="src">src</button>' +
          '<button class="am-tree__row am-tree__row--indent" data-am-tree="billing">billing</button>' +
          STAGED.map(function (k) { return '<button class="am-tree__row am-tree__row--file" data-am-tree="' + t(k) + '">' + t(k) + "</button>"; }).join("") +
          "</div>";
        return;
      }
      var groupHtml = function (key, label, inner, open) {
        return '<div class="am-group ' + (open ? "am-group--open" : "am-group--closed") + '">' +
          '<button class="am-group__label" type="button" data-am-rgroup="' + key + '" aria-expanded="' + (open ? "true" : "false") + '">' +
          '<span class="am-group__chev">▸</span>' + label + "</button>" +
          '<div class="am-group__body">' + inner + "</div></div>";
      };
      // v1.4 (V6-6): статус работы — «работает / ждёт вашего решения / ошибка» + шаги/проверки
      var statusInner =
        '<div class="am-status am-status--ok"><span class="am-status__dot"></span><b>' + t("am.statusLabel") + "</b>" +
        '<span class="am-status__meta">' + t("am.statusSteps") + " · " + t("am.statusChecks") + "</span></div>";
      var stagedInner = STAGED.map(function (k, i) {
        var add = ["+29 −3", "+9 −0", "+1"][i] || "+0";
        return '<button class="am-file" data-am-file="' + t(k) + '" title="' + t("am.toastFile") + '"><span>' + t(k) + '</span><b class="am-file__stat">' + add + "</b></button>";
      }).join("") +
        '<button class="am-btn am-btn--soft" type="button" data-am-btn="diffall">' + t("am.diffAll") + "</button>";
      var checksInner =
        '<div class="am-check"><span class="ok">✓</span>' + t("am.chk1") + "</div>" +
        '<div class="am-check"><span class="ok">✓</span>' + t("am.chk2") + "</div>" +
        '<div class="am-check"><span class="ok">✓</span>' + t("am.chk3") + "</div>";
      var appliedCls = state.applied ? " am-btn--done" : "";
      body.innerHTML =
        '<div class="am-branch">' + t("am.branch") + '<button class="am-minibtn" data-am-btn="terminal">' + t("am.termOpen") + '</button><button class="am-minibtn" data-am-btn="editor">' + t("am.openeditor") + "</button></div>" +
        statusInner +
        groupHtml("changes", t("am.changes") + (state.applied ? " · 0" : " · 3"), stagedInner, state.rgroups.changes) +
        '<textarea class="am-commitmsg" rows="2" spellcheck="false">' + (state.applied ? "" : "feat(stripe): checkout + webhooks") + "</textarea>" +
        '<div class="am-btnrow">' +
        '<button class="am-btn am-btn--primary' + appliedCls + '" id="amApply">' + (state.applied ? t("am.applied") : t("am.apply")) + "</button>" +
        '<button class="am-btn" data-am-btn="revert">' + t("am.revert") + "</button>" +
        "</div>" +
        '<div class="am-btnrow">' +
        '<button class="am-btn am-btn--soft" data-am-btn="commit">' + t("am.commit") + "</button>" +
        '<button class="am-btn" data-am-btn="push">' + t("am.push") + "</button>" +
        '<button class="am-btn" data-am-btn="pr">' + t("am.pr") + "</button>" +
        '<button class="am-btn" data-am-btn="merge">' + t("am.merge") + "</button>" +
        "</div>" +
        groupHtml("checks", t("am.checksLabel") + " · 3", checksInner, state.rgroups.checks);
    };

    /* v1.3: вид по центру — построчный дифф файла/коммита или содержимое файла */

    var makeDiffRows = function (lines) {
      var o = 0;
      var n = 0;
      return lines.map(function (l) {
        var cls = "";
        var sign = " ";
        if (l[0] === "add") { n++; cls = " am-diffline--add"; sign = "+"; }
        else if (l[0] === "del") { o++; cls = " am-diffline--del"; sign = "−"; }
        else { o++; n++; }
        var noOld = l[0] === "add" ? "" : String(o);
        var noNew = l[0] === "del" ? "" : String(n);
        return '<div class="am-diffline' + cls + '"><span class="am-diffline__no">' + noOld + '</span><span class="am-diffline__no">' + noNew + '</span><span class="am-diffline__sign">' + sign + "</span>" + escHtml(l[1]) + "</div>";
      }).join("");
    };

    var openFileDiff = function (name) {
      var f = FILE_DIFFS[name];
      if (!f) { toast(t("am.toastFile") + ": " + name); return; }
      state.center = {
        title: name,
        meta: t("am.centerDiff") + " · +" + f.add + " −" + f.del,
        files: [{ name: name, meta: "", lines: f.lines }],
      };
      renderAll();
    };

    var openFileContent = function (name) {
      var text = FILE_CONTENT[name];
      if (!text) { toast(t("am.folder") + ": " + name); return; }
      state.center = {
        title: name,
        meta: t("am.centerFile") + " · " + t("am.fileLines") + text.split("\n").length,
        files: [{ name: "", meta: "", lines: text.split("\n").map(function (l) { return ["ctx", l]; }) }],
      };
      renderAll();
    };

    var openAllDiff = function () {
      var files = STAGED.map(function (k) {
        var name = t(k);
        var f = FILE_DIFFS[name];
        return { name: name, meta: "+" + f.add + " −" + f.del, lines: f.lines };
      });
      state.center = {
        title: t("am.diffAll"),
        meta: t("am.centerDiff") + " · " + files.length,
        files: files,
      };
      renderAll();
    };

    var openCommitDiff = function (i) {
      var c = COMMIT_DIFFS[i];
      if (!c) return;
      state.center = {
        title: t("am.hist" + (i + 1)),
        meta: t("am.centerCommit") + " · " + c.name,
        files: [{ name: c.name, meta: "", lines: c.lines }],
      };
      renderAll();
    };

    var drawView = function () {
      var view = document.getElementById("amView");
      if (!view) return;
      if (state.center) {
        // центр: дифф файла/коммита/весь дифф — построчно, с номерами (v1.3)
        var code = state.center.files.map(function (f) {
          var head = f.name ? '<div class="am-difffile__head"><b>' + escHtml(f.name) + "</b>" +
            (f.meta ? "<span>" + escHtml(f.meta) + "</span>" : "") + "</div>" : "";
          return '<div class="am-difffile">' + head + makeDiffRows(f.lines) + "</div>";
        }).join("");
        view.innerHTML =
          '<div class="am-center">' +
          '<div class="am-center__head">' +
          '<span class="am-center__chip">' + escHtml(state.center.title) + "</span>" +
          '<span class="am-center__meta">' + escHtml(state.center.meta || "") + "</span>" +
          '<button class="am-btn am-center__close" type="button" data-am-center-close>' + t("am.centerClose") + "</button>" +
          "</div>" +
          '<div class="am-center__code">' + code + "</div>" +
          "</div>";
        return;
      }
      var agentOptions = MOCK_AGENTS.map(function (a) {
        return '<button class="am-chip' + (state.agent === a.id ? " am-chip--on" : "") + '" data-am-agent="' + a.id + '"><svg viewBox="0 0 32 32" aria-hidden="true"><use href="#' + a.icon + '"/></svg>' + a.name + "</button>";
      }).join("");

      if (state.view === "overview") {
        // v1.4 (V6-9): дашборд проектов — карточки + графики сессий/токенов
        var cards = [
          { name: "demo", branch: "main", commits: 12, sessions: 3, tokens: "38K" },
          { name: "ui-audit", branch: "main", commits: 4, sessions: 1, tokens: "6K" },
        ];
        var week = [["пн", 2], ["вт", 4], ["ср", 1], ["чт", 3], ["пт", 5], ["сб", 0], ["вс", 1]];
        view.innerHTML =
          '<div class="am-viewtitle">' + t("am.tab.overview") + "</div>" +
          '<div class="am-ovgrid">' +
          cards.map(function (c) {
            return '<button class="am-ovcard" data-am-btn="ovcard"><span class="am-ovcard__name">' + c.name + "</span>" +
              '<span class="am-ovcard__branch">' + c.branch + "</span>" +
              '<span class="am-ovcard__stats">' + t("am.ovCommits") + ": " + c.commits + " · " + t("am.ovSessions") + ": " + c.sessions + " · " + t("am.ovTokens") + ": " + c.tokens + "</span></button>";
          }).join("") +
          "</div>" +
          '<div class="am-ovbars"><span class="am-rlabel">' + t("am.ovWeek") + "</span>" +
          week.map(function (d) {
            return '<span class="am-ovbar" style="height:' + Math.max(6, d[1] * 16) + 'px" title="' + d[1] + '"></span>';
          }).join("") + "</div>";
        return;
      }
      if (state.view === "terminal") {
        // v1.4 (V6-5): терминал — окно по центру, список справа-снизу
        var termLines = [
          "$ bun test",
          " 24 pass, 0 fail (0.8s)",
          "$ git status",
          " On branch feat/stripe",
          " nothing to commit, working tree clean",
          "$",
        ].map(function (l) { return "<div>" + l.replace(/</g, "&lt;") + "</div>"; }).join("");
        var termRows = ["bash — demo", "bun test — watch", "orch deploy"];
        view.innerHTML =
          '<div class="am-viewtitle">' + t("am.tab.terminal") + "</div>" +
          '<div class="am-termwrap">' +
          '<div class="am-term">' +
          '<div class="am-term__head"><span class="am-term__ps">❯</span><span class="am-term__title">bash — demo</span>' +
          '<span class="am-term__acts"><button class="am-minibtn" data-am-btn="termadd">' + t("am.termAdd") + '</button><button class="am-minibtn" data-am-btn="termkill">' + t("am.termKill") + "</button></span></div>" +
          '<div class="am-term__out">' + termLines + "</div>" +
          '<div class="am-term__in"><span class="am-term__ps">❯</span><span class="am-term__fake" contenteditable="false">' + t("am.termPh") + "</span></div>" +
          "</div>" +
          '<div class="am-termlist"><span class="am-rlabel">' + t("am.termList") + "</span>" +
          termRows.map(function (n, i) {
            return '<button class="am-termrow' + (i === 0 ? " am-termrow--on" : "") + '" data-am-btn="termrow"><span class="am-termrow__dot"></span>' + n + "</button>";
          }).join("") + "</div>" +
          "</div>";
        return;
      }

      if (state.view === "chat") {
        var msgs = feed.map(function (k, i) {
          var text = t(k);
          var mine = k === "am.m1";
          return '<div class="am-msg ' + (mine ? "am-msg--me" : "am-msg--agent") + '" style="animation-delay:' + (i * 0.08) + 's">' +
            (mine ? "" : '<svg class="am-msg__ava" viewBox="0 0 32 32" aria-hidden="true"><use href="#ag-claude"/></svg>') +
            "<span>" + text + "</span></div>";
        }).join("");
        view.innerHTML =
          '<div class="am-sessionbar"><div class="am-head"><span class="am-head__title">' + t("am.m1").split(":")[0] + '</span>' +
          '<span class="am-badge am-badge--copy">' + t("vfm.tag_copy") + ' · git</span>' +
          (state.applied ? '<span class="am-badge am-badge--ok">' + t("am.applied") + "</span>" : '<span class="am-badge am-badge--run"><i></i>' + t("am.m7").replace("…", "") + "</span>") +
          "</div></div>" +
          '<div class="am-feedbox" id="amFeedBox">' + msgs + "</div>" +
          '<div class="am-agentrow">' + agentOptions + "</div>" +
          '<div class="am-composer">' +
          '<textarea id="amInput" rows="1" spellcheck="false" placeholder="' + t("am.placeholder") + '"></textarea>' +
          '<div class="am-composer__hint"><span>' + t("am.hint") + '</span>' +
          '<button class="am-minibtn" type="button" data-am-btn="mic" title="' + t("am.mic") + '">🎙</button>' +
          '<button class="am-ctxchip" type="button" data-am-btn="ctx" title="' + t("am.ctx") + '">' + t("am.ctxShort") + "</button>" +
          '<button class="am-btn am-btn--primary" data-am-btn="send">' + t("am.send") + "</button></div>" +
          "</div>";
      } else if (state.view === "board") {
        var cols = [["am.col1", ["am.b3"]], ["am.col2", ["am.b1"]], ["am.col3", ["am.b2"]]];
        view.innerHTML =
          '<div class="am-viewtitle">' + t("am.tab.board") + "</div>" +
          '<div class="am-board">' +
          cols.map(function (c) {
            return '<div class="am-col"><div class="am-col__head">' + t(c[0]) + '<span class="am-count">' + c[1].length + "</span></div>" +
              c[1].map(function (k) { return '<div class="am-bcard"><span class="am-bcard__dot"></span>' + t(k) + "</div>"; }).join("") + "</div>";
          }).join("") +
          "</div>";
      } else if (state.view === "history") {
        var hist = ["am.hist1", "am.hist2", "am.hist3", "am.hist4"];
        view.innerHTML =
          '<div class="am-viewtitle">' + t("am.tab.history") + "</div>" +
          '<div class="am-history">' +
          hist.map(function (k, i) {
            return '<button class="am-hrow" data-am-hist="' + i + '"><svg viewBox="0 0 32 32" aria-hidden="true"><use href="#' + (i % 2 ? "ag-claude" : "ag-codex") + '"/></svg><span>' + t(k) + '</span><b class="am-hrow__time">0' + (i + 4) + ":1" + i + "</b></button>";
          }).join("") +
          "</div>";
      } else if (state.view === "stats") {
        var bars = [["am.stats1", "13", 92], ["am.stats2", "27", 64], ["am.stats3", "23", 100], ["am.stats4", "8", 38]];
        view.innerHTML =
          '<div class="am-viewtitle">' + t("am.tab.stats") + "</div>" +
          '<div class="am-stats">' +
          bars.map(function (b) {
            return '<div class="am-stat"><div class="am-stat__head"><span>' + t(b[0]) + "</span><b>" + b[1] + "</b></div>" +
              '<div class="am-stat__bar"><i style="width:' + b[2] + '%"></i></div></div>';
          }).join("") +
          "</div>";
      } else if (state.view === "settings") {
        var steps = [["am.st1", "on"], ["am.st2", ""], ["am.st3", ""], ["am.st4", ""]];
        var env = ["am.env1", "am.env2", "am.env3", "am.env4"];
        var machineRows = ["am.machine1", "am.machine2"];
        view.innerHTML =
          '<div class="am-viewtitle">' + t("am.tab.settings") + "</div>" +
          '<div class="am-setupsteps">' + steps.map(function (s) {
            return '<button class="am-ss' + (s[1] ? " am-ss--on" : "") + '" data-am-ss="' + s[0] + '"><span>' + t(s[0]).slice(0, 1) + "</span>" + t(s[0]) + "</button>";
          }).join("") + "</div>" +
          '<div class="am-setblock">' +
          '<div class="am-envgrid">' + env.map(function (k) { return '<div class="am-env"><span class="ok">✓</span>' + t(k) + "</div>"; }).join("") + "</div>" +
          '<button class="am-btn am-btn--soft" data-am-btn="envfix">' + t("am.envfix") + "</button>" +
          '<div class="am-agentgrid">' + MOCK_AGENTS.slice(0, 3).map(function (a, i) {
            return '<div class="am-srow"><svg viewBox="0 0 32 32" aria-hidden="true"><use href="#' + a.icon + '"/></svg><span>' + a.name + '</span><em>' + t("am.installed") + "</em></div>";
          }).join("") +
          '<div class="am-srow"><svg viewBox="0 0 32 32" aria-hidden="true"><use href="#ag-gemini"/></svg><span>MiniMax</span><button class="am-minibtn" data-am-btn="install">' + t("am.install") + "</button></div>" +
          "</div>" +
          '<div class="am-machines">' + machineRows.map(function (k) {
            return '<div class="am-mrow"><span class="ok">✓</span>' + t(k) + "</div>";
          }).join("") +
          '<div class="am-mrow am-mrow--tunnel"><span>·</span>' + t("am.tunnel") + '<button class="am-minibtn" data-am-btn="tunnel">' + t("am.tunnelon") + "</button></div>" +
          "</div>" +
          '<div class="am-setrow"><span class="am-rlabel">' + t("am.langLabel") + '</span><span class="am-langseg" data-am-btn="lang"><b>RU</b> | <span>EN</span></span></div>' +
          '<div class="am-mrow am-mrow--companion"><span>·</span>' + t("am.companion") + "</div>" +
          "</div>";
      }
    };

    var renderAll = function () {
      drawTabs();
      drawSide();
      drawView();
      drawRight();
    };
    window.__rerenderAppMock = renderAll;
    renderAll();

    /* ---------- взаимодействие ---------- */

    var simulateRun = function (text) {
      // fake run: сообщения добавляются по очереди
      feed = ["clear"];
      var me = { raw: text };
      feed = [];
      drawView();
      var box = document.getElementById("amFeedBox");
      if (box) {
        var um = document.createElement("div");
        um.className = "am-msg am-msg--me";
        um.innerHTML = "<span>" + text.replace(/</g, "&lt;") + "</span>";
        box.appendChild(um); um.scrollIntoView && um.scrollIntoView({ block: "end" });
      }
      var seq = [["am.m2", "ag-kilo"], ["am.m3", "ag-claude"], ["am.m4", "ag-codex"], ["am.m5", "ag-kilo"]];
      seq.forEach(function (s, i) {
        setTimeout(function () {
          var box2 = document.getElementById("amFeedBox");
          if (!box2) return;
          var m = document.createElement("div");
          m.className = "am-msg am-msg--agent";
          m.innerHTML = '<svg class="am-msg__ava" viewBox="0 0 32 32" aria-hidden="true"><use href="#' + s[1] + '"/></svg><span>' + t(s[0]) + "</span>";
          box2.appendChild(m);
          box2.scrollTop = box2.scrollHeight;
        }, 450 + i * 620);
      });
    };

    var applyChanges = function () {
      if (state.applied) return;
      state.applied = true;
      var btn = document.getElementById("amApply");
      if (btn) { btn.textContent = t("am.applying"); btn.disabled = true; }
      setTimeout(function () {
        renderAll();
        toast(t("am.toastApplied"));
        feed.push("am.m5");
      }, 700);
    };

    var revertChanges = function () {
      if (!state.applied) { toast(t("am.reverted")); return; }
      state.applied = false;
      renderAll();
      toast(t("am.toastReverted"));
    };

    var clickAction = function (action) {
      if (action === "apply") applyChanges();
      else if (action === "revert") revertChanges();
      else if (action === "diffall") openAllDiff();
      else if (action === "terminal") { state.view = "terminal"; state.center = null; renderAll(); }
      else if (action === "termadd") toast(t("am.toastTermAdd"));
      else if (action === "termkill") toast(t("am.toastTermKill"));
      else if (action === "termrow") toast(t("am.toastTermRow"));
      else if (action === "ovcard") toast(t("am.toastOvcard"));
      else if (action === "mic") toast(t("am.toastMic"));
      else if (action === "ctx") toast(t("am.toastCtx"));
      else if (action === "lang") toast(t("am.toastLang"));
      else if (action === "commit") { toast(t("am.toastCommit")); feed.push("am.m6"); drawView(); }
      else if (action === "push") toast(t("am.toastPush"));
      else if (action === "pr") toast(t("am.toastPr"));
      else if (action === "merge") toast(t("am.toastMerged"));
      else if (action === "editor") toast(t("am.openeditor"));
      else if (action === "envfix") toast(t("am.envfix"));
      else if (action === "install") toast(t("am.toastInstall"));
      else if (action === "tunnel") toast(t("am.toastTunnel"));
      else if (action === "send") {
        var input = document.getElementById("amInput");
        var text = input && input.value && input.value.trim();
        if (!text) { input && input.focus(); return; }
        simulateRun(text);
        if (input) input.value = "";
      }
    };

    rootEl.addEventListener("click", function (e) {
      var el = e.target.closest ? e.target.closest("[data-am-view],[data-am-session],[data-am-agent],[data-am-theme],[data-am-rtab],[data-am-btn],[data-am-file],[data-am-tree],[data-am-ss],[data-am-hist],[data-am-rgroup],[data-am-center-close],[data-am-psgroup],#amApply,.am-search") : null;
      if (!el) return;
      if (el.id === "amSearch") { toast(t("am.toastSearch")); return; }
      if (el.id === "amApply") { applyChanges(); return; }
      if (el.hasAttribute("data-am-center-close")) { state.center = null; renderAll(); return; }
      var rgroup = el.getAttribute("data-am-rgroup");
      if (rgroup) { state.rgroups[rgroup] = !state.rgroups[rgroup]; renderAll(); return; }
      if (el.hasAttribute("data-am-psgroup")) {
        state.psopen = !state.psopen;
        el.setAttribute("aria-expanded", state.psopen ? "true" : "false");
        return;
      }
      var view = el.getAttribute("data-am-view");
      if (view) { state.view = view; state.center = null; renderAll(); return; }
      var sess = el.getAttribute("data-am-session");
      if (sess !== null && sess !== undefined) {
        state.session = Number(sess);
        state.center = null;
        if (state.session === 0) { state.view = "chat"; initFeed2(); }
        else { state.view = "chat"; feed = ["am.m2", "am.m4"]; }
        renderAll();
        return;
      }
      var agent = el.getAttribute("data-am-agent");
      if (agent) { state.agent = agent; renderAll(); toast(t("am.toastAgent") + ": " + agentName(agent)); return; }
      if (el.hasAttribute("data-am-theme")) {
        $$(".am-th", rootEl).forEach(function (b) { b.classList.remove("am-th--on"); });
        el.classList.add("am-th--on");
        toast(t("am.toastTheme"));
        return;
      }
      var rtab = el.getAttribute("data-am-rtab");
      if (rtab) { state.rtab = rtab; renderAll(); return; }
      var file = el.getAttribute("data-am-file");
      if (file) { openFileDiff(file); return; }
      var tree = el.getAttribute("data-am-tree");
      if (tree) {
        if (FILE_CONTENT[tree]) { openFileContent(tree); return; }
        toast(t("am.folder") + ": " + tree);
        return;
      }
      if (el.hasAttribute("data-am-ss")) { toast(t(el.getAttribute("data-am-ss"))); return; }
      if (el.hasAttribute("data-am-hist")) { openCommitDiff(Number(el.getAttribute("data-am-hist"))); return; }
      var action = el.getAttribute("data-am-btn");
      if (action) { clickAction(action); return; }
    });

    var agentName = function (id) {
      for (var i = 0; i < MOCK_AGENTS.length; i++) if (MOCK_AGENTS[i].id === id) return MOCK_AGENTS[i].name;
      return id;
    };

    var initFeed2 = function () { initFeed(); };

    // Enter в composer → отправка
    rootEl.addEventListener("keydown", function (e) {
      if (e.target && e.target.id === "amInput" && e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        clickAction("send");
      }
    });

    // лента оживает: раз в ~3с прокрутка нового события (только для chat)
    setInterval(function () {
      if (state.view !== "chat") return;
      var box = document.getElementById("amFeedBox");
      if (!box) return;
      var pool = ["am.m3", "am.m4", "am.m6"];
      var k = pool[Math.floor(Math.random() * pool.length)];
      var m = document.createElement("div");
      m.className = "am-msg am-msg--agent";
      m.innerHTML = '<svg class="am-msg__ava" viewBox="0 0 32 32" aria-hidden="true"><use href="#' + (k === "am.m3" ? "ag-claude" : k === "am.m4" ? "ag-codex" : "ag-claude") + '"/></svg><span>' + t(k) + "</span>";
      box.appendChild(m);
      while (box.children.length > 6) box.removeChild(box.firstChild);
      box.scrollTop = box.scrollHeight;
    }, 3200);
  })();

  /* ---------------- reveal на скролле ---------------- */

  (function initReveal() {
    var els = $$(".reveal");
    if (!("IntersectionObserver" in window)) {
      els.forEach(function (e) { e.classList.add("reveal--in"); });
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.add("reveal--in"); io.unobserve(en.target); }
      });
    }, { threshold: 0.12, rootMargin: "0px 0px -40px" });
    els.forEach(function (e) { io.observe(e); });
  })();

  /* ---------------- шапка: фон и активный пункт ---------------- */

  (function initHeader() {
    var header = $("#header");
    var links = $$(".nav a");
    var sections = links.map(function (a) { return $(a.getAttribute("href")); }).filter(Boolean);
    var onScroll = function () {
      header.classList.toggle("header--scrolled", window.scrollY > 12);
      var y = window.scrollY + 120;
      var current = null;
      sections.forEach(function (s) { if (s.offsetTop <= y) current = s; });
      links.forEach(function (a) {
        a.classList.toggle("active", current && a.getAttribute("href") === "#" + current.id);
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
  })();

  /* ---------------- мобильное меню ---------------- */

  (function initBurger() {
    var burger = $("#burger"), nav = $("#nav");
    if (!burger || !nav) return;
    burger.addEventListener("click", function () {
      var open = nav.classList.toggle("nav--open");
      burger.classList.toggle("burger--open", open);
      burger.setAttribute("aria-expanded", String(open));
    });
    $$(".nav a", nav).forEach(function (a) {
      a.addEventListener("click", function () {
        nav.classList.remove("nav--open");
        burger.classList.remove("burger--open");
        burger.setAttribute("aria-expanded", "false");
      });
    });
  })();

  /* ---------------- установка: копирование команды ---------------- */

  (function initCopy() {
    var status = $("#copyStatus");
    var say = function (ok) {
      if (!status) return;
      var en = document.documentElement.getAttribute("lang") === "en";
      status.textContent = ok
        ? (en ? "Command copied to the clipboard" : "Команда скопирована в буфер обмена")
        : (en ? "Could not copy — select the command and copy it by hand" : "Скопировать не вышло — выделите команду и скопируйте вручную");
      window.clearTimeout(say._t);
      say._t = window.setTimeout(function () { status.textContent = ""; }, 3200);
    };

    var legacyCopy = function (text) {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.cssText = "position:fixed;top:-1000px;opacity:0";
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      return ok;
    };

    $$("[data-copy]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var src = $(btn.getAttribute("data-copy"));
        if (!src) return;
        var text = (src.textContent || "").trim();
        var done = function (ok) {
          btn.classList.toggle("install__copy--done", ok);
          say(ok);
          if (ok) window.setTimeout(function () { btn.classList.remove("install__copy--done"); }, 2000);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(legacyCopy(text)); });
        } else {
          done(legacyCopy(text));
        }
      });
    });
  })();

  /* ---------------- Enterprise: заявка на design-партнёрство ----------------
     Сейчас письмо собирается локально и открывается в почтовом клиенте;
     серверная отправка — docs/SITE-HOSTING-HANDOFF.md. */

  (function initEnterpriseForm() {
    var form = $("#entForm");
    if (!form) return;
    // Ящик заявок продукта (личная почта — только в материалах питча). Серверная отправка и
    // аналитика — docs/SITE-HOSTING-HANDOFF.md.
    var MAILBOX = "partners@cortexally.ai";
    var note = $("#entNote");
    var noteDefault = note ? note.innerHTML : "";

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var en = document.documentElement.getAttribute("lang") === "en";
      var get = function (n) {
        var el = form.querySelector('[name="' + n + '"]');
        return el ? String(el.value || "").trim() : "";
      };
      var name = get("name"), email = get("email");
      if (!name || !email || email.indexOf("@") < 1) {
        var bad = form.querySelector(!name ? '[name="name"]' : '[name="email"]');
        if (bad) { bad.classList.add("field__input--bad"); bad.focus(); }
        if (note) note.textContent = en
          ? "Please fill in your name and a valid e-mail."
          : "Заполните имя и корректный e-mail.";
        return;
      }
      $$(".field__input", form).forEach(function (i) { i.classList.remove("field__input--bad"); });

      var subject = en ? "Dirigo — design partner application" : "Dirigo — заявка на design-партнёрство";
      var body = [
        (en ? "Name: " : "Имя: ") + name,
        (en ? "E-mail: " : "E-mail: ") + email,
        (en ? "Company / team: " : "Компания / команда: ") + (get("company") || "—"),
        "",
        (en ? "Problem to solve:" : "Какую задачу нужно закрыть:"),
        get("task") || "—"
      ].join("\n");

      // метрика заявки (воронка view → scroll50 → buy_intent → signup), см. initMetrics
      if (window._dTrack) window._dTrack("signup", { email: email, meta: { company: get("company") || "", lang: en ? "en" : "ru" } });
      var href = "mailto:" + MAILBOX + "?subject=" + encodeURIComponent(subject) + "&body=" + encodeURIComponent(body);
      try { window.location.href = href; } catch (err) { /* почтового клиента нет */ }
      if (note) {
        note.innerHTML = (en
          ? "A draft e-mail to <b>" + MAILBOX + "</b> has just opened. If nothing happened, write to us directly — the text is already composed."
          : "Черновик письма на <b>" + MAILBOX + "</b> открыт в вашей почте. Если ничего не произошло — напишите нам напрямую, текст уже собран.");
        window.setTimeout(function () { if (noteDefault) note.innerHTML = noteDefault; }, 12000);
      }
    });
  })();


  /* ── Метрики посещений (свои, без сторонних счётчиков) ─────────────────────
   * События уходят на /api/event того же origin (serve.ts → data/events.jsonl).
   * view — загрузка (+ referrer, utm), scroll50 — дочитали до середины,
   * buy_intent — [data-track="buy"] (установить, копировать команду),
   * cta — [data-track="cta"], signup — заявка enterprise (initEnterpriseForm).
   * Посетитель — случайный id в localStorage (d_vid), без cookie и отпечатков.
   * Формат совместим с landings/server.js: {ts, landing, type, visitor, email, meta}. */
  (function initMetrics() {
    var vid = "";
    try { vid = localStorage.getItem("d_vid") || ""; } catch (e) { /* приватный режим */ }
    if (!vid) {
      vid = "v_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
      try { localStorage.setItem("d_vid", vid); } catch (e) { /* без сохранения */ }
    }
    function send(type, extra) {
      extra = extra || {};
      var ev = { landing: "dirigo", type: type, visitor: vid, email: extra.email || "", meta: extra.meta || {} };
      var body = JSON.stringify(ev);
      try {
        if (navigator.sendBeacon && navigator.sendBeacon("/api/event", new Blob([body], { type: "application/json" }))) return;
      } catch (e) { /* упадём на fetch */ }
      try { fetch("/api/event", { method: "POST", headers: { "content-type": "application/json" }, body: body, keepalive: true }).catch(function () {}); } catch (e) { /* метрики не мешают сайту */ }
    }
    window._dTrack = send;

    var q = {};
    try { new URLSearchParams(location.search).forEach(function (v, k) { if (/^utm_/.test(k)) q[k] = v; }); } catch (e) { /* старый браузер */ }
    send("view", { meta: { ref: document.referrer || "", path: location.pathname, utm: q, lang: document.documentElement.lang || "" } });

    var half = false;
    window.addEventListener("scroll", function () {
      if (half) return;
      var h = document.documentElement.scrollHeight - window.innerHeight;
      if (h > 0 && window.scrollY / h >= 0.5) { half = true; send("scroll50"); }
    }, { passive: true });

    document.addEventListener("click", function (e) {
      var el = e.target && e.target.closest ? e.target.closest("[data-track]") : null;
      if (!el) return;
      var kind = el.getAttribute("data-track");
      send(kind === "buy" ? "buy_intent" : "cta", { meta: { label: el.getAttribute("data-label") || "" } });
    }, true);
  })();

})();
