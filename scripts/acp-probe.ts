// Probe 4: корректные параметры set_config_option/load + реальный prompt на free-модели.
import { tmpdir } from "node:os";
import { join } from "node:path";
const KILO = `${process.env.USERPROFILE}/.kilo/bin/kilo.exe`;
const proc = Bun.spawn([KILO, "acp"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
const dec = new TextDecoder();
const msgs: any[] = [];
function send(obj: unknown) {
  proc.stdin.write(JSON.stringify(obj) + "\n");
  proc.stdin.flush();
}
(async () => {
  let buf = "";
  for await (const chunk of proc.stdout) {
    buf += dec.decode(chunk, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line) { try { msgs.push(JSON.parse(line)); } catch { /* raw */ } }
    }
  }
})();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const find = (id: number) => msgs.find((m) => m.id === id);

await sleep(1200);
send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } } });
await sleep(2000);
send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: process.cwd(), mcpServers: [] } });
await sleep(2000);
let sid = "";
for (let i = 0; i < 40 && !sid; i++) { await sleep(400); sid = find(2)?.result?.sessionId ?? (find(2)?.error ? "ERR:" + JSON.stringify(find(2).error).slice(0,120) : ""); }
console.log("SESSION:", sid);

send({ jsonrpc: "2.0", id: 3, method: "session/set_config_option", params: { sessionId: sid, configId: "model", value: "kilo/kilo-auto/free" } });
await sleep(1200);
console.log("set_config_option:", JSON.stringify(find(3) ?? "(нет ответа)").slice(0, 200));

console.log("--- prompt on free model ---");
send({ jsonrpc: "2.0", id: 4, method: "session/prompt", params: { sessionId: sid, prompt: [{ type: "text", text: "ответь одним словом: ок" }] } });
await sleep(35000);
console.log("prompt:", JSON.stringify(find(4) ?? "(нет ответа)").slice(0, 400));
const updates = msgs.filter((m) => m.method === "session/update");
const types = [...new Set(updates.map((u) => u.params?.update?.sessionUpdate))];
console.log("UPDATE TYPES:", JSON.stringify(types));
for (const u of updates) {
  const up = u.params?.update;
  if (up?.sessionUpdate === "agent_message_chunk" || types.length <= 4) {
    console.log("  ", up?.sessionUpdate, JSON.stringify(up ?? "(нет ответа)").slice(0, 200));
  }
}

console.log("--- session/load (reconnect по id) ---");
send({ jsonrpc: "2.0", id: 10, method: "session/load", params: { sessionId: sid, cwd: process.cwd(), mcpServers: [] } });
await sleep(2500);
console.log("load:", JSON.stringify(find(10) ?? "(нет ответа)").slice(0, 250));

send({ jsonrpc: "2.0", id: 20, method: "session/prompt", params: { sessionId: sid, prompt: [{ type: "text", text: "второй запрос: пинг" }] } });
await sleep(35000);
console.log("prompt2:", JSON.stringify(find(20) ?? "(нет ответа)").slice(0, 300));

await sleep(8000);
await Bun.write(join(tmpdir(), "dirigo-acp-raw.txt"), JSON.stringify(msgs, null, 1));
const after = msgs.filter((m) => Number(m.id ?? 0) >= 20 || m.method === "session/update");
console.log("ALL AFTER PROMPT2 (" + after.length + "):");
for (const m of after) console.log("  ", JSON.stringify(m).slice(0, 300));
send({ jsonrpc: "2.0", id: 99, method: "session/close", params: { sessionId: sid } });
await sleep(300);
proc.kill();
await sleep(200);