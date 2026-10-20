# Security policy

## The threat model, stated plainly

Dirigo starts AI agents as child processes **with the privileges of the user who
started the daemon**. Those agents execute arbitrary shell commands by design.
Therefore: anyone who can reach the panel can do anything that user can do.

This is why the daemon binds to `127.0.0.1` by default and refuses to be useful
on a public interface without a token.

## Reporting a vulnerability

Please do not open a public issue for anything exploitable. Use GitHub's
**Report a vulnerability** button on the Security tab, or email the maintainer
address listed on the project page.

Include a description, the affected version (`/api/health` reports it), and a
minimal reproduction. You can expect a first response within a few days.

## Hardening checklist for operators

- Set `DIRIGO_TOKEN` to 32+ random characters before binding anywhere but
  loopback. Without it, binding to `0.0.0.0` exposes a remote shell.
- Prefer a tunnel (Cloudflare, Tailscale) or an SSH tunnel over port forwarding.
- Keep the agents' own budgets and quotas under control — a stolen token is also
  a way to burn your API credit.
- Review `~/.dirigo/current` after an update; install scripts verify SHA256 and
  refuse non-HTTPS sources, and you should not disable that
  (`DIRIGO_SKIP_VERIFY=1` exists for offline installs only).
- Agent API keys live in the agents' own configuration directories, not in
  Dirigo's data. Back them up and protect them accordingly.

## What is already in place

- CSP with a per-file hash for the single inline script; `nosniff` on static.
- Token auth for the API, cookie-based auth for Server-Sent Events
  (`SameSite=Strict`, `HttpOnly`).
- Rate limiting on the API and on login (`DIRIGO_RL_*`).
- SHA256 verification and an HTTPS-only guard in the install scripts.
- A release-time security review suite (`scripts/install-security-review.ts`).
