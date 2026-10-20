#!/usr/bin/env bun
// SSH-деплой, машины и туннели (V3-1/2/3): сборка команд + деплой с мок-раннером.
// Запуск через deploy-test.ts (ставит env).
import {
  deployDaemon, installerFor, parseMarkers, probeRemoteOs, scpArgs, sshArgs, classifyOs,
} from "../src/deploy";
import {
  addMachine, listMachines, loadMachines, probeMachine, removeMachine, tunnelArgs,
} from "../src/machines";
import { cloudflaredAvailable, startTunnel, stopTunnel, tunnelInfo } from "../src/tunnel";

const DATA = process.env.DIRIGO_DATA!;
rmIfExists(DATA);

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  ok ? pass++ : fail++;
};
function rmIfExists(p: string) { try { rmSync(p, { recursive: true, force: true }); } catch { /* занято */ } }
import { rmSync } from "node:fs";

// V4-3: определение ОС удалёнки + выбор установщика
{
  const linuxRun = async (cmd: string[]) => cmd.includes("uname") ? { code: 0, out: "Linux\n", err: "" } : { code: 0, out: "ok\n", err: "" };
  const darwinRun = async (cmd: string[]) => cmd.includes("uname") ? { code: 0, out: "Darwin\n", err: "" } : { code: 0, out: "ok\n", err: "" };
  const winRun = async (cmd: string[]) => cmd.includes("uname") ? { code: 1, out: "", err: "" } : { code: 0, out: "Microsoft Windows [Version 10.0.19045]\n", err: "" };
  const t = { host: "h", user: "u" };
  check("probeRemoteOs: linux", (await probeRemoteOs(t, linuxRun as any)) === "linux", "");
  check("probeRemoteOs: darwin", (await probeRemoteOs(t, darwinRun as any)) === "darwin", "");
  check("probeRemoteOs: windows (ver fallback)", (await probeRemoteOs(t, winRun as any)) === "windows", "");
  check("classifyOs: darwin", classifyOs("Darwin") === "darwin", "");
  check("installerFor: 3 OS", installerFor("linux") === "remote-install.sh" && installerFor("darwin") === "remote-install-macos.sh" && installerFor("windows") === "remote-install.ps1", installerFor("windows"));
  const { existsSync: ex } = await import("node:fs");
  check("установщики для 3 ОС на диске", ex(`${import.meta.dir}/../scripts/remote-install.sh`) && ex(`${import.meta.dir}/../scripts/remote-install-macos.sh`) && ex(`${import.meta.dir}/../scripts/remote-install.ps1`), "");
}

/* ---------- V3-1: деплой ---------- */
{
  const t = { host: "vps.example.com", user: "root", port: 22 };
  const a = sshArgs(t);
  check("sshArgs: хост/порт/опции", a[0] === "ssh" && a.includes("root@vps.example.com") && a.includes("-p") && a.includes("22"), a.join(" "));
  check("sshArgs: accept-new + timeout", a.some((x) => x.includes("StrictHostKeyChecking")) && a.some((x) => x.includes("ConnectTimeout")), "");
  const withIdentity = sshArgs({ ...t, identity: "C:/keys/id_ed25519" });
  check("sshArgs: identity", withIdentity.includes("-i") && withIdentity.includes("C:/keys/id_ed25519"), withIdentity.join(" "));
  const s = scpArgs(t, "/local/src", "/opt/dirigo");
  check("scpArgs: -r и цель", s[0] === "scp" && s.includes("-r") && s.includes("root@vps.example.com:/opt/dirigo"), s.join(" "));
  const s2 = scpArgs(t, "/local/src", "/opt/dirigo");
  check("scpArgs: -P (заглавная, как у scp)", s2.includes("-P"), s2.join(" "));

  // маркеры установщика
  const markers = parseMarkers("...\nDIRIGO_RESULT_PORT=7171\nDIRIGO_RESULT_TOKEN=abc123\n");
  check("parseMarkers: порт+токен", markers.port === 7171 && markers.token === "abc123", JSON.stringify(markers));
}

// деплой с мок-раннером: scp ok → установщик ok → маркеры
{
  const calls: string[][] = [];
  const runner = async (cmd: string[], opts?: { stdin?: string }) => {
    calls.push([...cmd, opts?.stdin ? `<stdin:${opts.stdin.length}b>` : ""]);
    // установщик: эмулируем успешный вывод с маркерами (узнаём по env-маркеру DIRIGO_HOST_DIR)
    if (cmd[0] === "ssh" && opts?.stdin?.includes("DIRIGO_HOST_DIR=")) {
      return { code: 0, out: "==> Служба systemd\nDIRIGO_RESULT_PORT=7171\nDIRIGO_RESULT_TOKEN=tok123\n", err: "" };
    }
    return { code: 0, out: "ok\n", err: "" };
  };
  const r = await deployDaemon({ host: "h", user: "root" }, {}, runner as any);
  check("деплой: ok + порт + токен", r.ok && r.port === 7171 && r.token === "tok123", `${r.ok} ${r.port} ${r.error ?? ""}`);
  check("деплой: 3 фазы (подготовка, scp, установщик)", r.log.some((l) => l.includes("подготовка")) && r.log.some((l) => l.includes("scp")) && r.log.some((l) => l.includes("install")), "");
  const scpCall = calls.find((c) => c[0] === "scp");
  check("деплой: scp с прямыми слэшами", !!scpCall && scpCall.join(" ").includes("/src") && !scpCall.join(" ").includes("\\src"), scpCall?.join(" ") ?? "-");
  const sshInst = calls.find((c) => c[0] === "ssh" && c.join(" ").includes("stdin:"));
  check("деплой: установщик ушёл по ssh через stdin", !!sshInst, "");
}
// деплой: установщик упал → ошибка пробрасывается
{
  const runner = async (cmd: string[], opts?: { stdin?: string }) => {
    if (opts?.stdin?.includes("DIRIGO_HOST_DIR=")) return { code: 1, out: "ОШИБКА: нет systemd\n", err: "" };
    return { code: 0, out: "ok\n", err: "" };
  };
  const r = await deployDaemon({ host: "h", user: "root" }, {}, runner as any);
  check("деплой: падение установщика → ok=false с причиной", !r.ok && (r.error ?? "").includes("код 1"), r.error ?? "-");
  check("деплой: лог сохранён", r.log.length > 0, `${r.log.length}`);
}
// dry-run: команды печатаются, ничего не выполняется
{
  let executed = 0;
  const runner = async () => { executed++; return { code: 0, out: "", err: "" }; };
  const r = await deployDaemon({ host: "h", user: "root" }, { dryRun: true }, runner as any);
  check("dry-run: ok, ничего не выполнено", r.ok && executed === 0, `executed=${executed}`);
  check("dry-run: показаны команды", r.log.some((l) => l.includes("[dry-run] scp")), "");
}

/* ---------- V3-2: машины ---------- */
loadMachines();
{
  const m = addMachine({ name: "vps1", host: "1.2.3.4", user: "root", daemonPort: 7171 });
  check("addMachine: в реестре", listMachines().some((x) => x.id === m.id), m.id);
  check("addMachine: localPort = daemonPort+1000", m.localPort === 8171, `${m.localPort}`);
  const ta = tunnelArgs(m);
  check("tunnelArgs: -N -L local:remote", ta.includes("-N") && ta.includes(`${m.localPort}:127.0.0.1:${m.daemonPort}`), ta.join(" "));
  check("tunnelArgs: хост", ta.includes("root@1.2.3.4"), "");
  // probe с моком Bun.spawn не сделать инъекцией — проверяем контракт «не найдено»
  const p = await probeMachine("нет-такой");
  check("probe неизвестной машины → ok=false", !p.ok, p.error ?? "-");
  check("removeMachine", removeMachine(m.id) && !listMachines().some((x) => x.id === m.id), "");
  const custom = addMachine({ name: "vps2", host: "h", user: "u", daemonPort: 8000, localPort: 9001 });
  check("localPort переопределяем", custom.localPort === 9001, `${custom.localPort}`);
  removeMachine(custom.id);
}

/* ---------- V3-3: tunnel ---------- */
{
  const info = tunnelInfo();
  check("tunnel: изначально не запущен", !info.running && !info.url, JSON.stringify(info));
  stopTunnel(); // идемпотентно
  const started = await startTunnel(7171);
  if (!cloudflaredAvailable()) {
    check("tunnel: без cloudflared — внятная ошибка", !started.running && (started.error ?? "").includes("cloudflared"), started.error ?? "-");
  } else {
    check("tunnel: стартовал", started.running, started.error ?? "-");
    const stopped = stopTunnel();
    check("tunnel: остановлен", !stopped.running && !stopped.url, "");
  }
}

rmIfExists(DATA);
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
