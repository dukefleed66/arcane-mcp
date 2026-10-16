# Installation guide

## 1. Prerequisites

- **Node.js 22+** (`node --version`). Use your distribution's package or [nvm](https://github.com/nvm-sh/nvm).
- **openssl** (only to run the test suite).
- An Arcane instance with a valid HTTPS certificate. If you use a private CA, you need its root certificate as a PEM file.

## 2. Get the code

```bash
git clone https://github.com/dukefleed66/arcane-mcp.git
cd arcane-mcp
npm ci --ignore-scripts
npm test
```

`--ignore-scripts` stops dependency install scripts from running. Install in a directory you control and do not run it as root.

## 3. Create a dedicated Arcane API key

In the Arcane web UI, create a new API key used only for this server (look under the settings area for API keys; menu names vary by Arcane version). Name it after its purpose, for example `mcp-assistant`. If your Arcane version supports restricting a key, limit it to the environments you want the assistant to manage.

Treat the key like a password: anyone holding it can manage Docker through Arcane. To remove access later, **revoke the key in Arcane**. Deleting the local file does not revoke it.

## 4. Store the key and the configuration

```bash
install -d -m 700 ~/.config/arcane-mcp
install -m 600 /dev/null ~/.config/arcane-mcp/api-key
${EDITOR:-nano} ~/.config/arcane-mcp/api-key        # paste the key, save
cp config.example.json ~/.config/arcane-mcp/config.json
${EDITOR:-nano} ~/.config/arcane-mcp/config.json
```

Edit the configuration:

```json
{
  "url": "https://arcane.example.com",
  "apiKeyFile": "~/.config/arcane-mcp/api-key"
}
```

Optional fields:

- **Private CA or self-signed certificate:** copy the CA's PEM file to `~/.config/arcane-mcp/ca.crt` and add `"caFile": "~/.config/arcane-mcp/ca.crt"`. Always trust the CA, never disable verification (there is no such option).
- **Name does not resolve from this machine:** add `"connectAddress": "<Arcane server IP>"`. The connection goes to that IP, while the certificate is still checked against the host in `url`.
- **Locally built images:** add `"localImagePrefixes": ["registry.example.com/mine/"]` so `arcane_audit` treats a missing healthcheck on your own builds as `info`.

The server refuses to start a request if the key file is readable by group or others. Fix with `chmod 600 ~/.config/arcane-mcp/api-key`.

## 5. Verify the connection (no MCP client needed)

```bash
npm run smoke -- --live
```

This needs the configuration from step 4 and a reachable Arcane. Expected: `MCP handshake OK; 7 tools`, an `arcane_connection` result with `"status":"UP"` and `catalog.verified: true`, then a few read-only list calls. This command changes nothing.

## 6. Register with your MCP client

Use the absolute path to `src/server.mjs` (shown by `pwd` inside the cloned folder). MCP servers load when a client session **starts**, so open a new session afterwards.

### Claude Code

```bash
claude mcp add arcane --scope user -- node /absolute/path/to/arcane-mcp/src/server.mjs
claude mcp list        # arcane should show Connected
```

Use `--scope project` instead to share a registration with a team through a `.mcp.json` file. Keep absolute, personal paths out of anything you commit.

### Claude Desktop

Edit `claude_desktop_config.json` (Settings → Developer → Edit Config) and add:

```json
{
  "mcpServers": {
    "arcane": {
      "command": "node",
      "args": ["/absolute/path/to/arcane-mcp/src/server.mjs"]
    }
  }
}
```

Restart Claude Desktop.

### Codex

Add to `~/.codex/config.toml` (check your Codex version's documentation if the format differs):

```toml
[mcp_servers.arcane]
command = "node"
args = ["/absolute/path/to/arcane-mcp/src/server.mjs"]
```

### Any other stdio MCP client

Command: `node`. Arguments: `/absolute/path/to/arcane-mcp/src/server.mjs`. To use a non-default config file, set the environment variable `ARCANE_CONFIG=/path/to/config.json` for the server process.

If `node` is not on the client's `PATH` (common with nvm), use the full path from `command -v node`.

## 7. First use

Start a new session and ask the assistant to:

1. call `arcane_connection` (expect `health.status: "UP"`, `drift.needsReview: false`),
2. list your environments and containers,
3. run `arcane_audit`.

Optional: copy `skills/arcane-management/SKILL.md` into your client's skills directory so the assistant follows the recommended workflow.

## 8. Recommended client settings

- Keep **per-call approval enabled** for `arcane_execute`. Read tools can usually be allowed without prompts.
- Start with a test environment or a few non-critical containers.

## Updating

```bash
cd arcane-mcp
git pull
npm ci --ignore-scripts
npm test
```

Restart your client session afterwards. After you upgrade **Arcane**, you normally do nothing; see "Staying current with Arcane releases" in the [README](../README.md).

## Troubleshooting

| Symptom | Likely cause and fix |
|---------|----------------------|
| `arcane` tools missing in the client | Registered after the session started, or `claude mcp list` shows it failing. Start a new session; check the paths. |
| `API key file must have permissions 0600` | `chmod 600 ~/.config/arcane-mcp/api-key`. |
| `Arcane connection failed (UNABLE_TO_VERIFY_LEAF_SIGNATURE)` or similar | The certificate is not trusted. Provide `caFile` with your CA's root certificate. |
| `Arcane connection failed (ENOTFOUND)` | The host name does not resolve here. Fix DNS or set `connectAddress`. |
| `Arcane HTTP 401/403` | Wrong, revoked or under-privileged API key. |
| `Live Arcane schema verification failed; mutations are disabled` | Arcane unreachable or returned an invalid API description. Reads continue if a catalog was loaded earlier; check Arcane's health. |
| `Mutation request contract changed or is new` | An Arcane upgrade changed that operation. Review it, then `npm run update-schema -- --expect-version <version>`. |
| `Result exceeds tool output budget` | Narrow the request with `start`/`limit` and filters. |

## Uninstall

```bash
claude mcp remove arcane        # or remove the entry from your client's config
rm -rf ~/.config/arcane-mcp
```

Then **revoke the API key in Arcane**.
