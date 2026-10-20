# -*- coding: utf-8 -*-
"""Сценарии 7-8 в регресс-набор изоляции."""
import io

P = "scripts/cli-e2e-isolation-test.ts"
s = io.open(P, encoding="utf-8").read()
orig = s

block = io.open("scripts/.scenarios-7-8.ts", encoding="utf-8").read()

# набор импортов: нужны isInside и sandboxRoot из e2e-guard
old_imp = 'import { sessionState, canRemoveDataDir, workCopiesIn } from "./e2e-guard";'
new_imp = 'import { sessionState, canRemoveDataDir, isInside, sandboxRoot, workCopiesIn } from "./e2e-guard";'
assert s.count(old_imp) == 1
s = s.replace(old_imp, new_imp)

tail = """console.log(`\\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
"""
assert s.count(tail) == 1
s = s.replace(tail, block)

# заголовок сценариев — в шапку файла
old_hdr = """// Сценарий 5. Состояние сессии — три исхода, а не два: живая, мёртвая и
//   «не узнали». «Не узнали» (демон не ответил, сессия не найдена) — это не
//   «мёртвый агент»: тогда набор ничего не сносит, иначе у живого агента
//   пропадёт рабочая папка."""
new_hdr = """// Сценарий 5. Состояние сессии — три исхода, а не два: живая, мёртвая и
//   «не узнали». «Не узнали» (демон не ответил, сессия не найдена) — это не
//   «мёртвый агент»: тогда набор ничего не сносит, иначе у живого агента
//   пропадёт рабочая папка.
// Сценарий 6. Сами правила изоляции (unit-уровень): если правила перестанут
//   видеть рабочую папку агента, защита выключится молча.
// Сценарий 7. Статус сессии врёт («done»), а процесс агента жив: набор не
//   сносит каталог данных — иначе у живого агента пропадает рабочая папка.
// Сценарий 8. Проект набора — черновик в песочнице, а не репозиторий
//   разработчика: «apply»/«revert» не должны трогать чужое рабочее дерево."""
assert s.count(old_hdr) == 1
s = s.replace(old_hdr, new_hdr)

assert s != orig
io.open(P, "w", encoding="utf-8", newline="\n").write(s)
print("patched", len(orig), "->", len(s))
