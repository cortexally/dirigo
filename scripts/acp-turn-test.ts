#!/usr/bin/env bun
// Ответы живого диалога (ACP) не теряются после переподключения (1.9.2).
//
// Регресс (devin, 18.10): после обновления пульта сессия переподключилась,
// счётчик ходов начался с нуля, и новые ответы получили id старых
// («acp:1:»). Проверка «агент ответил в этом ходе?» находила старый ответ —
// ход, где модель ответила одними размышлениями, не попадал в ленту вовсе:
// «агент вызывает инструменты, но никакого вывода нет».
//
//   bun run scripts/acp-turn-test.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  ok ? pass++ : fail++;
};
const { acpMsgId, turnReplies } = await import("../src/agents/runner");

const before = "mf1a", after = "mf9z"; // два подключения одной сессии
check("id ответа включает подключение", acpMsgId(before, 1, "") !== acpMsgId(after, 1, ""), `${acpMsgId(before, 1, "")} vs ${acpMsgId(after, 1, "")}`);
check("id различает messageId моста", acpMsgId(after, 2, "a") !== acpMsgId(after, 2, "b"));

// лента сессии: ответы ДО переподключения (ходы 1..3) и новый ход 1 без текста
const feed = [
  { id: acpMsgId(before, 1, ""), text: "Добавил дату" },
  { id: acpMsgId(before, 2, ""), text: "Изменил имя автора" },
  { id: acpMsgId(before, 3, ""), text: "Добавил номер карты" },
  { id: "msg_u1", text: "достань данные из coally" },
];
check("новый ход 1 после переподключения: старые ответы не считаются его ответом", turnReplies(feed, after, 1).length === 0, JSON.stringify(turnReplies(feed, after, 1)));
feed.push({ id: acpMsgId(after, 1, ""), text: "   " });
check("пустой кусок ответа — не ответ", turnReplies(feed, after, 1).length === 0);
feed.push({ id: acpMsgId(after, 1, "m1"), text: "В CoAlly нет проекта northwind" });
check("настоящий ответ этого хода найден", turnReplies(feed, after, 1).length === 1);
check("ход 10 не путается с ходом 1 (префикс с двоеточием)", turnReplies([{ id: acpMsgId(after, 10, ""), text: "x" }], after, 1).length === 0);

// в коде: куски ответа пишутся через acpMsgId, проверка хода — через turnReplies,
// у ответа одними размышлениями — список вызванных инструментов
const src = readFileSync(join(import.meta.dir, "..", "src", "agents", "runner.ts"), "utf8");
check("runner: куски ответа — с меткой подключения", /appendChunk\(sessionId, acpMsgId\(handle\.conn, handle\.turn/.test(src) && !/`acp:\$\{handle\.turn\}:/.test(src));
check("runner: проверка хода — turnReplies", /turnReplies\(messages\.list\(sessionId\), handle\.conn, handle\.turn\)/.test(src));
check("runner: история при session/load не пишется в ленту повторно", /handle\.replaying = true;/.test(src) && /if \(handle\.replaying && \(u\.kind === "message"/.test(src));
check("runner: ход одними размышлениями показывается с инструментами", /Агент ответил только размышлениями — показаны выше\.\$\{toolNote\}/.test(src));

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
