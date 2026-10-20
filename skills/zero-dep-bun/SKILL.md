---
name: zero-dep-bun
description: Соглашения zero-dependency Bun для проекта dirigo (демон, тесты, скрипты). Использовать при изменении src/ и scripts/.
---

# Zero-dependency Bun: соглашения dirigo

- **Рантайм-зависимостей нет** (кроме `node-pty` для PTY). Всё остальное — стандартная
  библиотека: `node:fs`, `node:path`, `Bun.spawn`, `Bun.CryptoHasher`.
- Тесты — bun-скрипты с матрицей PASS/FAIL и `process.exit(fail ? 1 : 0)`.
- Кодировка: UTF-8 **без BOM**. Никогда не проводить текст через PowerShell Set-Content/Out-File
  (ломает кириллицу) — правь файлы специализированными инструментами.
- Изоляция тестов: переменная `DIRIGO_DATA` до старта процесса (не внутри модуля —
  Bun кэширует окружение на загрузке). Лучше — дочерний процесс с env.
- Пути: `new URL("../x", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")`.
- Атомарная запись: tmp + rename (store.ts). Асинхронный `Bun.write` — только там,
  где сразу после нет чтения того же файла.
- Убийство процессов: `taskkill /PID <pid> /T /F` на Windows (дети агентов держат CWD).
