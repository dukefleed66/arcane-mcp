# Security policy

## Reporting a vulnerability

Please report vulnerabilities **privately** through GitHub: *Security → Report a vulnerability* on this repository
(or <https://github.com/dukefleed66/arcane-mcp/security/advisories/new>). Do not open a public issue.

Include the affected version, a description, and reproduction steps with placeholder data. Never send real API keys,
host names or IP addresses. You can expect an acknowledgement within a few days. This is a volunteer project, so
there is no guaranteed fix time, but security problems are handled first.

## Supported versions

Only the latest release receives fixes.

## Scope and design

This server acts with the authority of its Arcane API key. See "Security model" in the [README](README.md). In scope:
credential leaks, bypass of the read/write split, bypass of the change-contract gate or scope guards, path
confinement problems, TLS verification bypass, and output that leaks secrets. Out of scope: vulnerabilities in
Arcane, Docker or your MCP client, and misuse of a key you granted broad access.

## Hardening checklist for users

- Use a dedicated Arcane API key and revoke it when you stop using the server.
- Keep `~/.config/arcane-mcp` at mode `0700` and the key file at `0600`.
- Require per-call approval of `arcane_execute` in your MCP client.
- Treat text from containers (logs, labels) as untrusted: it can try to instruct your AI assistant.
- Run `npm ci --ignore-scripts` and keep dependencies updated (Dependabot is enabled in this repository).
