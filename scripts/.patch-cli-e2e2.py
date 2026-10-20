# -*- coding: utf-8 -*-
"""Черновик проекта: свой каталог, метка, уборка."""
import io

P = "scripts/cli-e2e.ts"
s = io.open(P, encoding="utf-8").read()
orig = s


def sub(old, new):
    global s
    assert s.count(old) == 1, "anchor not unique: %r (%d)" % (old[:70], s.count(old))
    s = s.replace(old, new)


# ── черновик проекта: свой каталог + метка (чтобы чужой прогон его не снёс) ─
sub(
    """const SCRATCH = projectDirFor(PORT);
makeScratchProject(SCRATCH, ROOT);""",
    """let SCRATCH = projectDirFor(PORT);
// Занятый черновик (живой агент прошлого прогона) обходим новым именем.
if (existsSync(SCRATCH) && !removeTreeSafely(SCRATCH).ok) SCRATCH = `${projectDirFor(PORT)}-${process.pid}`;
makeScratchProject(SCRATCH, ROOT);
// Метка с живым pid: пока набор работает, черновик никто не снесёт (в том числе
// чистка песочницы — см. sweepSandbox в e2e-guard).
writeMarker(SCRATCH, { pid: process.pid, port: PORT, startedAt: Date.now() });""",
)

# ── уборка черновика в финале ──────────────────────────────────────────────
sub(
    """  if (!removeTreeSafely(DATA).ok) console.log(`каталог данных оставлен (держит процесс): ${DATA}`);
} else console.log(`каталог данных оставлен (занят): ${DATA}`);""",
    """  if (!removeTreeSafely(DATA).ok) console.log(`каталог данных оставлен (держит процесс): ${DATA}`);
  // Черновик проекта — тоже мусор: копия в песочнице, её не жалко. Убираем
  // только вместе с каталогом данных: пока агент жив, репозиторий черновика
  // ему нужен (в нём идёт его работа).
  if (!removeTreeSafely(SCRATCH).ok) console.log(`черновик проекта оставлен: ${SCRATCH}`);
} else console.log(`каталог данных оставлен (занят): ${DATA}`);""",
)

# ── чистка песочницы от прошлых прогонов (свежее и своё — не трогаем) ──────
sub(
    """const DATA = pickDataDir(PORT);
writeMarker(DATA, { pid: process.pid, port: PORT, startedAt: Date.now() });""",
    """const DATA = pickDataDir(PORT);
writeMarker(DATA, { pid: process.pid, port: PORT, startedAt: Date.now() });
// Мусор прошлых прогонов в песочнице — только то, что никто не держит.
// Свежие каталоги (меньше получаса) не трогаем: набор мог ещё не дописать
// db.json, и мы снесли бы его каталог из-под ног.
sweepSandbox([DATA]);""",
)

assert s != orig
io.open(P, "w", encoding="utf-8", newline="\n").write(s)
print("patched", len(orig), "->", len(s))
