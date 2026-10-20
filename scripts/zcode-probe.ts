import { spawn } from "bun";
const proc = spawn([process.argv[2]!, ...process.argv.slice(3)], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
const decoder = new TextDecoder();
let text = "";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
  })().catch(() => {});

  await sleep(5000);
  const cwd = process.cwd();
  const key = "dirigo-" + cwd.replace(/[^a-zA-Z0-9]/g, "_");
  proc.stdin.write(JSON.stringify({ id: 1, method: "session/create", params: { workspace: { workspacePath: cwd, workspaceKey: key }, mode: "build" } }) + "\n");
  proc.stdin.flush();
  await sleep(3000);

  // отвечаем на серверные запросы (server-*)
  const serverReqs = text.split("\n").filter((l) => l.startsWith("{") && l.includes('"server-'));
  for (const line of serverReqs) {
    try {
      const msg = JSON.parse(line);
      proc.stdin.write(JSON.stringify({ id: msg.id, result: { nativeSearchEnhancementsEnabled: false } }) + "\n");
      proc.stdin.flush();
    } catch { /* ignore */ }
  }
  await sleep(2000);

  const sessionId = (text.match(/sess_[a-f0-9-]{36}/) ?? [])[0];
  if (sessionId) {
    proc.stdin.write(JSON.stringify({ id: 2, method: "session/send", params: { sessionId, content: "say ZCODE-PROTO-OK" } }) + "\n");
    proc.stdin.flush();
    await sleep(25000);
    const events = text.split("\n").filter((l) => l.startsWith("{"));
    for (const line of events.slice(-6)) console.log("  EVENT:", line.slice(0, 300));
    // schema errors — полный текст для спеки
    const errs = text.split("\n").filter((l) => l.startsWith("{") && l.includes('"name":"ZodError"'));
    for (const e of errs.slice(-2)) console.log("  SCHEMA:", e.slice(0, 700));
  }
  proc.kill();
  process.exit(0);
})();
