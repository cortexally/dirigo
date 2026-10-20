import pty from "node-pty";
const exe = process.argv[2]!;
const args = process.argv.slice(3);
const p = pty.spawn(exe, args, { cols: 200, rows: 50, cwd: process.cwd() });
let out = "";
p.onData((d) => { out += d; });
setTimeout(() => { if (/trust|authors/i.test(out)) { p.write("y\n"); } }, 3000);
setTimeout(() => {
  p.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"capabilities":{}}}\n');
}, 6000);
setTimeout(() => {
  console.log("total:", out.length);
  console.log("trust_seen:", /trust|authors/i.test(out));
  console.log("jsonrpc_echo:", /jsonrpc/.test(out));
  console.log("tail:", JSON.stringify(out.slice(-500)));
  p.kill();
  process.exit(0);
}, 14000);
