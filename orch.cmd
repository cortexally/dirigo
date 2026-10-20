@echo off
rem Dirigo — CLI (Windows). Использование: orch <команда> [аргументы]
rem Требуется bun в PATH. Адрес демона: --host или DIRIGO_HOST.
rem Примеры: orch health · orch run hermes "задача" --copy · orch setup
setlocal
if "%DIRIGO_HOST%"=="" set DIRIGO_HOST=http://127.0.0.1:7171
bun run "%~dp0scripts\orch.ts" %*
