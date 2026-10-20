// Проверка детекта и прогона авто-проверок (V2-2.1/2.2). Запуск: bun run scripts/checks-test.ts
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checksFeedbackPrompt, detectChecks, runChecks } from "../src/checks";

const TMP = join(import.meta.dir, "..", ".smoke-checks");
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  ok ? pass++ : fail++;
};
const mk = (name: string, files: Record<string, string>) => {
  const dir = join(TMP, name);
  for (const [rel, text] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, text);
  }
  return dir;
};

// package.json + bun.lock → bun run test/lint/typecheck
{
  const dir = mk("node-proj", {
    "package.json": JSON.stringify({ scripts: { test: "echo t", lint: "echo l", typecheck: "echo c", build: "echo b", start: "echo s" } }),
    "bun.lock": "{}",
  });
  const d = detectChecks(dir)!;
  check("package.json: bun + 3 команды", d.pm === "bun" && d.commands.length === 3
    && d.commands[0]!.join(" ") === "bun run test", d.commands.map((c) => c.join(" ")).join(" | "));
}
// package.json без lock → bun (демон на bun; npm только по package-lock.json)
{
  const dir = mk("npm-proj", { "package.json": JSON.stringify({ scripts: { test: "echo t" } }) });
  const d = detectChecks(dir)!;
  check("package.json: bun fallback", d.pm === "bun" && d.commands[0]!.join(" ") === "bun run test", d.pm);
}
// package-lock.json → npm
{
  const dir = mk("npm-real", { "package.json": JSON.stringify({ scripts: { test: "echo t" } }), "package-lock.json": "{}" });
  const d = detectChecks(dir)!;
  check("package-lock: npm", d.pm === "npm" && d.commands[0]!.join(" ") === "npm run test", d.pm);
}
// packageManager поле
{
  const dir = mk("pnpm-proj", { "package.json": JSON.stringify({ packageManager: "pnpm@9", scripts: { test: "echo t" } }), "pnpm-lock.yaml": "" });
  const d = detectChecks(dir)!;
  check("package.json: pnpm из packageManager", d.pm === "pnpm" && d.commands[0]![0] === "pnpm", d.commands[0]?.join(" ") ?? "-");
}
// Makefile
{
  const dir = mk("mk-proj", { "Makefile": "build:\n\techo b\ntest:\n\techo t\n" });
  const d = detectChecks(dir)!;
  check("Makefile: make test", d.source === "Makefile" && d.commands[0]!.join(" ") === "make test", d.commands.map((c) => c.join(" ")).join(" | "));
}
// pytest по pyproject
{
  const dir = mk("py-proj", { "pyproject.toml": "[tool.pytest.ini_options]\n", "src/main.py": "print(1)\n" });
  const d = detectChecks(dir)!;
  check("pytest: python -m pytest", d.source === "pytest" && d.commands[0]!.join(" ") === "python -m pytest -q", d.commands[0]?.join(" ") ?? "-");
}
// cargo
{
  const dir = mk("rs-proj", { "Cargo.toml": "[package]\nname=\"x\"\n" });
  const d = detectChecks(dir)!;
  check("cargo: cargo test", d.commands[0]!.join(" ") === "cargo test", d.commands[0]?.join(" ") ?? "-");
}
// just
{
  const dir = mk("just-proj", { "justfile": "test:\n  echo t\n" });
  const d = detectChecks(dir)!;
  check("just: just test", d.commands[0]!.join(" ") === "just test", d.commands[0]?.join(" ") ?? "-");
}
// go
{
  const dir = mk("go-proj", { "go.mod": "module x\n" });
  const d = detectChecks(dir)!;
  check("go: go test ./...", d.commands[0]!.join(" ") === "go test ./...", d.commands[0]?.join(" ") ?? "-");
}
// ничего не найдено
{
  const dir = mk("empty-proj", { "readme.txt": "hi\n" });
  check("пустой проект: null", detectChecks(dir) === null, "");
}
// прогон без проверок — не провал (регрессия: пустой отчёт слался агенту)
{
  const dir = mk("run-none", { "readme.txt": "hi\n" });
  const r = await runChecks(dir);
  check("прогон: нет проверок — не провал", r.ok && r.outcomes.length === 0 && r.source === null, `ok=${r.ok} source=${r.source}`);
}
// прогон: успешная проверка (bun run test с настоящим скриптом)
{
  const dir = mk("run-ok", {
    "package.json": JSON.stringify({ scripts: { test: "exit 0" } }),
    "bun.lock": "{}",
  });
  const r = await runChecks(dir);
  check("прогон: зелёный", r.ok && r.outcomes.length === 1 && r.outcomes[0]!.ok, r.outcomes[0]?.output.slice(0, 60) ?? "-");
}
// прогон: падающая проверка — вывод захвачен
{
  const dir = mk("run-fail", {
    "package.json": JSON.stringify({ scripts: { test: "echo 'boom: assertion'; exit 1" } }),
    "bun.lock": "{}",
  });
  const r = await runChecks(dir);
  check("прогон: красный + вывод", !r.ok && r.outcomes[0]!.ok === false && r.outcomes[0]!.output.includes("boom"), r.outcomes[0]?.output.slice(0, 40) ?? "-");
  const fb = checksFeedbackPrompt(r);
  check("фидбек-промпт агенту", fb.includes("Исправь причину") && fb.includes("bun run test") && fb.includes("boom"), "");
}
// две команды: вторая падает — общий вердикт красный
{
  const dir = mk("run-multi", {
    "package.json": JSON.stringify({ scripts: { test: "exit 0", lint: "echo 'lint fail'; exit 2" } }),
    "bun.lock": "{}",
  });
  const r = await runChecks(dir);
  check("прогон: 2 команды, вердикт по всем", r.outcomes.length === 2 && !r.ok && r.outcomes[0]!.ok && !r.outcomes[1]!.ok, `outcomes=${r.outcomes.length}`);
}
// override: своя команда вместо детекта (V3-4)
{
  const { runChecks, runChecksOverride } = await import("../src/checks");
  const dir = mk("run-override", {
    "package.json": JSON.stringify({ scripts: { test: "exit 1" } }), // детект сказал бы «упало»
    "bun.lock": "{}",
  });
  const r = await runChecksOverride(dir, "echo ok");
  check("override: команда сессии исполнена", r.ok && r.source?.startsWith("session:"), r.source ?? "-");
  const r2 = await runChecksOverride(dir, "exit 3");
  check("override: падающая команда → failed", !r2.ok && r2.outcomes[0]?.ok === false, `${r2.ok}`);
  const r3 = await runChecksOverride(dir, null);
  check("override: null → обычный детект", !r3.ok && r3.source === "package.json scripts", r3.source ?? "-");
}
// несуществующая команда → failed, не бросок
{
  const dir = mk("run-missing", { "Cargo.toml": "[package]\n" });
  const r = await runChecks(dir);
  check("прогон: нет cargo — failed без исключения", !r.ok && r.outcomes[0]!.ok === false, r.outcomes[0]?.output.slice(0, 60) ?? "-");
}

try { rmSync(TMP, { recursive: true, force: true }); } catch { /* Windows держит файлы — приберёт следующий прогон */ }
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
