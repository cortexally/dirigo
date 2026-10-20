# Ресёрч агентов (docs/agents-research.md)

Снимки `--help`: `docs/agent-help/<agent>.txt`. Всё проверено live-запусками в dirigo.

## Таблица агентов (CLI + Web-режимы)

| Агент | CLI (проверено) | Web/Remote-режим (проверено) | Продолжение сессии |
|---|---|---|---|
| kilo | `kilo.exe run --model M "<prompt>"` ✅ | `kilo remote` ✅ (релей в ЛК) | `--session <id>` (только продолжение; id из `kilo session list`) |
| opencode | `opencode-cli.exe run --model M "<prompt>"` ⚠ free-tier только внутри приложения | `opencode serve --port N` ✅ (URL+password из лога) | `--session <id>` (создаёт если нет) |
| hermes | `hermes.exe -z "<prompt>"` 🔜 | `hermes dashboard --port N --no-open` ✅ (`HERMES_DASHBOARD_READY port=`) | `--resume <id>` |
| zcode | `node zcode.cjs -p "<prompt>" --surface terminal --cwd <dir>` ✅ (ответ модели получен) | ✖ `--web` только в distribution-сборке, в пакете десктопа — нет | `--resume`? (уточнить) |
| cursor | `cursor-agent.ps1 -p "<prompt>" --output-format stream-json --force` ⚠ нужен login | — | `--resume <chatId>`, `--continue` |
| devin | `devin.exe --respect-workspace-trust false -p "<prompt>"` ⚠ нужен auth | — | `-r <id>` |
| minimax | ✖ CLI-агента нет (`mcode-tools/cli.mjs` — только connector-хелпер) | ✖ | — |
| minimax GUI | `MiniMax Code.exe` (desktop-заглушка) | — | — |

##临近важное о среде

- **Node 24.21 LTS поставлен через scoop** (`~\scoop\apps\nodejs-lts\current\node.exe`) —
  нужен для zcode CLI (это Node SEA/node-bundle) и полезен остальным.
- **ZCode CLI — фикс совместимости**: CLI из десктопа ищет провайдер-конфиг
  `resources\glm\provider\zcode-builtin.json`, а app кладёт его в
  `resources\config\provider\`. Решение: скопировать папку
  `config\provider` → `glm\provider` (сделано). После этого `-p` работает
  с существующими кредами десктопа (`~/.zcode/v2/credentials.json`, провайдеры zai-api + openrouter).
- **Bun 1.4.3** — рантайм самого dirigo.

## Web-режимы: как это устроено

- У КАЖДОГО агента теперь есть выбор режима в форме: **«Задача (CLI)»** или его web-вариант.
- Виды web-режимов (`docs/agents-research.md` + реестр `registry.ts`):
  - **Локальный web-UI** (поднимается процесс + парсинг URL/пароля из лога):
    `opencode serve --port N` (URL + `server password`), `hermes dashboard --port N --no-open`
    (`HERMES_DASHBOARD_READY port=` / stderr `Hermes Web UI → URL`).
  - **Релей** (`relayOnly`): `kilo remote` — НЕ создаёт сессию и не поднимает веб-UI.
    Это только релей: при включённом релее новые CLI-сессии kilo синхронизируются с облаком
    и видны в личном кабинете Kilo. В UI сессии такого режима показана поясняющая плашка
    и ссылка на кабинет; URL в логе не появляется (проверено — печатается только
    `Remote connection enabled.`).
  - **Внешний сайт** (`externalOnly`): devin — app.devin.ai, cursor — cursor.com,
    minimax — minimax.io. Локального web-UI нет; кнопка «⤢ Открыть» ведёт на сайт.
  - **Запуск приложения** (`launchApp`): zcode — `Programs\ZCode\ZCode.exe`
    (т.к. `zcode --web` есть только в distribution-сборке, а не в пакете десктопа).
- Порт выделяется динамически (свободный loopback-порт), если агент принимает `--port`.
- В UI web-сессии: кнопка **«⤢ Открыть»** (прямой доступ в новой вкладке), копирование URL,
  встроенный iframe, пароль (если агент печатает), стоп/перезапуск.

## Как запускать каждого агента (шпаргалка)

```
kilo.exe   run --model kilo/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free "промпт"
opencode-cli.exe run --model opencode/step-5-preview-free "промпт"   # нужен auth
hermes.exe -z "промпт"                                              # openrouter-кред есть
node zcode.cjs -p "промпт" --surface terminal --cwd <dir>           # работает
cursor-agent.ps1 -p "промпт" --output-format stream-json --force    # нужен login
devin.exe  --respect-workspace-trust false -p "промпт"                   # нужен auth; флаг — обход trust-промпта (в -p он блокер)
```

## Обёржки для Bun.spawn на Windows (грани)

- `.exe` — напрямую. `.cmd` — только через `cmd /c`. `.ps1` — через `powershell -File`.
- Кириллица в argv: прямой exe — ок; `cmd /c` — ломается.
- `Bun.mkdirSync`, `Bun.file().rename()`, `Bun.listen` без `socket` — не существуют/требуют хендлеры.

## Persistent-сессии: исслед.stdio-протоколов (спайк к T4, OCA 2026-10-11)

| Агент | Команда | Протокол | TTY нужен? | Результат probes |
|---|---|---|---|---|
| kilo | `kilo acp` | **стандартный ACP (JSON-RPC 2.0)** | нет | ✅ ответ на `initialize`: `protocolVersion:1`, `agentCapabilities: loadSession/prompt(image,embeddedContext)/session(resume,fork,list,close), mcp(http,sse)` — **годен для stdio-клиента dirigo** |
| hermes | `hermes acp` | ACP?-обёртка, но стартует с TUI-баннером («Available Tools») | да (нужен ConPTY/winpty) | ⚠ без псевдо-терминала не отвечает по протоколу |
| devin | `devin acp` | ACP | да | ⚠ интерактивный запрос «Do you trust the authors of this directory?» — нужен TTY + trust-проход |
| zcode | `zcode app-server` | «ZCode Protocol» (свой: `{id,method,params}` без jsonrpc, встречные server-N запросы) | нет | ✅ **протокол размотан (см. research/zcode-protocol-spec.md): session/create → send → стриминг state.updated; MCP-подобный; auth — общие креды десктопа. Осталась реализация клиента (T4-zcode)** |

**Вывод для T4:** первым кандидатом — kilo (pure ACP over stdio; реализовано KA).
Для hermes/devin нужен слой псевдо-терминала (node-pty/ConPTY) — отдельная подзадача. zcode — свой протокол.
Реализация stdio-клиента (initialize → session/new → prompt с потоком обновлений) — следующий
инкремент после подтверждения цели (см. RUNTIME.md).

## PTY-слой (интерактивные агенты) — реализовано OCA (коммит 7f13f23)

Для `hermes`/`devin` ACP-режимы оказались **внутренними адаптерами с TUI-рендерингом**
(не отдают JSON-RPC клиенту) — проверено probes выше. Поэтому для них сделан PTY-режим:

- `src/agents/pty.ts` — ConPTY через **node-pty** (работает под bun, установлен как зависимость).
- Режим сессии `pty`: hermes — `hermes --tui`, devin — `devin` (REPL).
- API: `POST /api/sessions/:id/input` (ввод с переводом строки), stop/restart как у обычных.
- UI: кнопка режима «Терминал (PTY)», бейдж PTY, чат-инпут работает как терминальный ввод.
- Проверено вживую: hermes TUI поднимается (pid, ANSI-поток в лог), промпт доходит
  («starting agent»), стоп убивает процесс; devin через PTY проходит trust/login-промпт
  (в `-p` режиме этот промпт был блокером — теперь обходится флагом
  `--respect-workspace-trust false` в argsTemplate, см. шпаргалку выше).
- Значение: интерактивный доступ к агентам, которым CLI-режим недоступен (devin до auth,
  hermes TUI), + основа на будущее, если ACP-адаптеры когда-нибудь откроют протокол.
