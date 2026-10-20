# Contributing to Dirigo

Thanks for taking the time. This project has no build step and no npm
dependency tree, so the feedback loop is short.

## Getting set up

```bash
git clone https://github.com/cortexally/dirigo.git
cd dirigo
bun run src/server.ts            # the panel on http://127.0.0.1:7171
```

Use an isolated data directory while hacking so you never touch a real instance:

```bash
DIRIGO_DATA=/tmp/dirigo-dev PORT=7399 bun run src/server.ts
```

The web UI is plain HTML/CSS/JS in `web/` — edit and reload, nothing to compile.

## Before you open a pull request

```bash
bun run smoke                     # API contracts, copies, review flow
bun build web/app.js --target=browser   # the UI must parse as plain browser JS
bun run scripts/ui-audit.ts       # browser audit, 65 checks (spawns its own daemon)
```

On a machine without agent CLIs installed, `smoke` is expected to report
**169/179** — the remaining checks need a real agent binary. Anything below that
is a regression you introduced.

## House rules

1. **No TypeScript syntax in `web/app.js`.** It is served to the browser as-is;
   `bun build --target=browser` is the gate.
2. **No npm dependencies in the daemon.** `node-pty` is the single optional
   native module, and everything must keep working when it is absent.
3. **Cross-platform or nothing.** No hardcoded Windows paths, no `taskkill`
   without a `process.platform` check, no `%USERPROFILE%` assumptions. The
   project runs on Linux, macOS and Windows.
4. **Re-renders go behind a signature guard.** The UI polls; rewriting
   `innerHTML` unconditionally makes rows jump under the cursor and swallows
   clicks.
5. **Comments explain why, not what.** Match the surrounding style; Russian
   comments in Russian files are fine.
6. **Claims must be verifiable.** If you add something to the README, make sure
   a stranger can reproduce it on a clean machine.

## Adding an agent

One entry in `src/agents/registry.ts`: id, label, how to resolve the binary
(`resolveBin` handles PATH plus per-OS install locations), the argument
template, and optionally web/ACP/PTY modes. Add a smoke check next to the
existing ones.

## Reporting bugs

Include: OS and architecture, `bun --version`, the output of
`curl -s http://127.0.0.1:7171/api/health`, and what you expected instead.

## License

By contributing you agree that your work is published under the MIT license.
