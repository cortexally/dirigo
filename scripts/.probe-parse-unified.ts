// Проба: как парсится unified diff с не-ASCII именами файлов.
import { parseUnified } from "../src/worktrees";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = join(tmpdir(), `dirigo-e2e", "parse-${process.pid}`.replace(/"/g, ""));
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const git = (args: string[]) => Bun.$`git -C ${dir} ${args}`.quiet();
await git(["init", "-q", "-b", "main"]);
await git(["config", "user.name", "d"]);
await git(["config", "user.email", "d@l"]);
writeFileSync(join(dir, "обычный.txt"), "было\n", "utf8");
writeFileSync(join(dir, "новый файл.txt"), "новое\n", "utf8");
await git(["add", "-A"]);
await git(["commit", "-q", "-m", "снимок"]);
writeFileSync(join(dir, "обычный.txt"), "стало\n", "utf8");
writeFileSync(join(dir, "новый файл.txt"), "изменено\n", "utf8");

const raw = await Bun.$`git -C ${dir} diff --no-color HEAD`.text();
console.log("=== СЫРОЙ DIFF (по умолчанию) ===");
console.log(raw);
console.log("=== parseUnified ===");
for (const f of parseUnified(raw)) {
  console.log(JSON.stringify({ path: f.path, status: f.status, added: f.added, deleted: f.deleted, lines: f.lines.length }));
}

const raw2 = await Bun.$`git -C ${dir} -c core.quotePath=false diff --no-color HEAD`.text();
console.log("=== СЫРОЙ DIFF (quotePath=false) ===");
console.log(raw2);
console.log("=== parseUnified (quotePath=false) ===");
for (const f of parseUnified(raw2)) {
  console.log(JSON.stringify({ path: f.path, status: f.status, added: f.added, deleted: f.deleted, lines: f.lines.length }));
}
rmSync(dir, { recursive: true, force: true });
