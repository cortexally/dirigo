// Проверка фикса OOM: большой файл должен диффиться без RangeError.
import { lineDiff } from "../src/worktrees";
const big1 = Array.from({ length: 6000 }, (_, i) => `line ${i}`).join("\n");
const big2 = Array.from({ length: 6000 }, (_, i) => (i === 2999 ? `line ${i} CHANGED` : `line ${i}`)).join("\n");
const t = Date.now();
const d = lineDiff(big1, big2);
const adds = d.filter((l) => l.kind === "add").length;
const dels = d.filter((l) => l.kind === "del").length;
const ctx = d.filter((l) => l.kind === "ctx").length;
console.log(`6000-строчный файл: ctx=${ctx} +${adds} -${dels} за ${Date.now() - t}мс`);
// номера строк корректны?
const firstCtx = d.find((l) => l.kind === "ctx");
const ok = d.length === 6001 && adds === 1 && dels === 1 && firstCtx?.oldNo === 1;
console.log(ok ? "PASS номера и состав корректны" : `FAIL ctx=${ctx} adds=${adds} dels=${dels}`);
process.exit(ok ? 0 : 1);
