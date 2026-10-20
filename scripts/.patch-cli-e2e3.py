# -*- coding: utf-8 -*-
"""Порядок: каталог → метка; чистка песочницы — после черновика."""
import io

P = "scripts/cli-e2e.ts"
s = io.open(P, encoding="utf-8").read()
orig = s


def sub(old, new):
    global s
    assert s.count(old) == 1, "anchor not unique: %r (%d)" % (old[:70], s.count(old))
    s = s.replace(old, new)


# каталог должен существовать ДО метки (writeFileSync без каталога падает)
sub(
    """const DATA = pickDataDir(PORT);
writeMarker(DATA, { pid: process.pid, port: PORT, startedAt: Date.now() });
// Мусор прошлых прогонов в песочнице — только то, что никто не держит.
// Свежие каталоги (меньше получаса) не трогаем: набор мог ещё не дописать
// db.json, и мы снесли бы его каталог из-под ног.
sweepSandbox([DATA]);
mkdirSync(DATA, { recursive: true });""",
    """const DATA = pickDataDir(PORT);
mkdirSync(DATA, { recursive: true });
writeMarker(DATA, { pid: process.pid, port: PORT, startedAt: Date.now() });""",
)

# чистка песочницы — после того, как известны и каталог данных, и черновик
sub(
    """writeMarker(SCRATCH, { pid: process.pid, port: PORT, startedAt: Date.now() });""",
    """writeMarker(SCRATCH, { pid: process.pid, port: PORT, startedAt: Date.now() });
// Мусор прошлых прогонов в песочнице — только то, что никто не держит.
// Свежие каталоги (меньше получаса) не трогаем: набор мог ещё не дописать
// db.json, и мы снесли бы его каталог из-под ног.
sweepSandbox([DATA, SCRATCH]);""",
)

assert s != orig
io.open(P, "w", encoding="utf-8", newline="\n").write(s)
print("patched", len(orig), "->", len(s))
