# -*- coding: utf-8 -*-
"""Правка набора e2e-cli: правила — из e2e-guard, проект — черновик в песочнице."""
import io

P = "scripts/cli-e2e.ts"
s = io.open(P, encoding="utf-8").read()
orig = s


def cut(start_marker, end_marker, new_text):
    global s
    i = s.index(start_marker)
    j = s.index(end_marker, i)
    s = s[:i] + new_text + s[j:]


def sub(old, new):
    global s
    assert s.count(old) == 1, "anchor not unique: %r (%d)" % (old[:70], s.count(old))
    s = s.replace(old, new)


# ── R1: локальные копии правил → правила из e2e-guard ───────────────────────
cut(
    "/** Каталог внутри другого? */",
    "// Порт: занятый живым демоном",
    """/**
 * Каталог данных набора — можно ли его снести?
 *
 * Правила живут в scripts/e2e-guard.ts: их и проверяет регресс-набор
 * scripts/cli-e2e-isolation-test.ts. Своя копия правил здесь — это вторая
 * правда: правила усилили в guard, а набор продолжал сносить каталоги по
 * старым (так у живого агента пропадала рабочая папка).
 *
 * own=true — каталог нашего прогона: его метку (suite.json с живым pid) мы
 * игнорируем, остальные проверки остаются в силе.
 */
const canRemove = (dir: string, own = false): boolean =>
  canRemoveDataDir(dir, { cwd: ROOT, ignorePid: own ? process.pid : undefined }).ok;

""",
)

# ── R2: свой каталог данных — через pickDataDir + метка ────────────────────
cut(
    "const DATA_HOME = join(tmpdir(),",
    "mkdirSync(DATA, { recursive: true });",
    """const DATA_HOME = join(tmpdir(), "dirigo-e2e", `cli-e2e-${PORT}`);
// Свой каталог — через pickDataDir: прошлый прогон вытирается переименованием
// (папку, которую держит процесс, сносить нельзя: rm -r снёс бы её файлы
// наполовину, и агент потерял бы правки), а занятый каталог обходится новым
// именем. Метка suite.json с живым pid: чужой прогон такой каталог не тронет.
const DATA = pickDataDir(PORT);
writeMarker(DATA, { pid: process.pid, port: PORT, startedAt: Date.now() });
""",
)

# ── R3: проект набора — черновик в песочнице, а не репозиторий разработчика ─
sub(
    """/** Проект набора (текущая папка) — регистрируется один раз. */
const projectId = async (): Promise<string> => {
  const r = await fetch(`${BASE}/api/projects`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "cli", path: process.cwd() }) });
  return ((await r.json()) as any).id as string;
};""",
    """/**
 * Проект набора — ЧЕРНОВИК в песочнице, а не рабочий репозиторий разработчика.
 *
 * «apply» переносит правки агента в проект, а «revert» откатывает проект
 * целиком (в git-режиме — `git checkout` + `git clean` по всему дереву). С
 * репозиторием разработчика это снесло бы чужие правки: незакоммиченные
 * изменения и untracked-файлы. Поэтому набор работает с копией проекта в
 * песочнице — её и убирать не жалко.
 */
const SCRATCH = projectDirFor(PORT);
makeScratchProject(SCRATCH, ROOT);

/** Проект набора (черновик) — регистрируется один раз. */
const projectId = async (): Promise<string> => {
  const r = await fetch(`${BASE}/api/projects`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "cli", path: SCRATCH }) });
  return ((await r.json()) as any).id as string;
};""",
)

# ── R4: проверки и уборка — по правилам guard ──────────────────────────────
sub(
    'check("каталог данных свой: чужой не тронут", DATA !== DATA_HOME || safeToWipe(DATA_HOME), DATA);',
    'check("каталог данных свой: чужой не тронут", DATA !== DATA_HOME || canRemove(DATA_HOME), DATA);',
)
sub(
    '    if (!removeTreeSafely(wt)) console.log(`рабочая папка агента занята процессом — оставлена: ${wt}`);',
    '    if (!removeTreeSafely(wt).ok) console.log(`рабочая папка агента занята процессом — оставлена: ${wt}`);',
)
sub(
    """} else if (canRemoveOwn(DATA)) {""",
    """} else if (canRemove(DATA, true)) {""",
)
sub(
    '  if (!removeTreeSafely(DATA)) console.log(`каталог данных оставлен (держит процесс): ${DATA}`);',
    '  if (!removeTreeSafely(DATA).ok) console.log(`каталог данных оставлен (держит процесс): ${DATA}`);',
)
sub(
    """  removeTreeSafely(DATA);""",
    """  removeTreeSafely(DATA);""",
)

# ── R5: импорт pickDataDir ─────────────────────────────────────────────────
sub(
    """  canRemoveDataDir, makeScratchProject, pidAlive, projectDirFor, removeTreeSafely,
  sessionState, sweepSandbox, writeMarker,""",
    """  canRemoveDataDir, makeScratchProject, pickDataDir, pidAlive, projectDirFor,
  removeTreeSafely, sessionState, sweepSandbox, writeMarker,""",
)

assert s != orig
io.open(P, "w", encoding="utf-8", newline="\n").write(s)
print("patched", len(orig), "->", len(s))
