# dirigo

Installer helper for **[Dirigo](https://github.com/cortexally/dirigo)** — the
self-hosted control layer for AI coding agents.

```bash
npx dirigo
```

It prints the verified install command for your platform and exits. **It does
not download or run anything itself** — you see the command and run it. For a
product whose whole point is provable control over what runs on your machine,
a package that silently pipes a remote script into a shell would be the wrong
first impression.

## What Dirigo is

One daemon on your own machine or server. Every coding agent works in its own
`git worktree`; tests, lint and build run **before** a human sees the result,
and failing work goes back to the agent. A personal-data gate scans the task,
every message to the agent and every line the agent writes. Every applied
change produces an Ed25519-signed evidence pack over an append-only,
hash-chained ledger — and the provenance trailers are readable in plain
`git log`, with or without us.

Thirteen agent CLIs, Windows and Linux, open source under MIT.

- **Source and documentation:** https://github.com/cortexally/dirigo
- **Product:** https://dirigo.cortexally.ai

## Install without npm

Linux and macOS:

```bash
curl -fsSL https://dirigo.cortexally.ai/install.sh | sh
```

Windows (PowerShell):

```powershell
irm https://dirigo.cortexally.ai/install.ps1 | iex
```

## License

MIT
