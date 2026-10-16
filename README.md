# arcane-mcp

A security-first [Model Context Protocol](https://modelcontextprotocol.io) server that lets an AI assistant inspect, audit and operate Docker through the [Arcane](https://github.com/getarcaneapp/arcane) management UI.

> **Unofficial.** This is an independent community project, not affiliated with or endorsed by Arcane. It can change real infrastructure. Read [Security](#security-model) before you connect it to anything you care about.

## Why this exists

Arcane already gives you a UI and an authenticated REST API for Docker. This server exposes that API to an AI assistant **without** giving it a shell, the Docker socket, or your account credentials:

- Everything goes through Arcane's HTTPS API with one dedicated, revocable API key.
- Reads and changes are separate tools, so your MCP client can approve changes individually.
- Change operations are checked against a reviewed baseline. If an Arcane update changes what an operation does, it stays blocked until you review it.
- A read-only audit tool gives you a ranked security and hygiene report.

## Features

| Tool | Type | What it does |
|------|------|--------------|
| `arcane_connection` | read | Checks Arcane's health and reports **drift**: live version vs reviewed baseline, blocked operations, `needsReview`. |
| `arcane_operations` | read | Lists the available Docker operations (search, read-only filter). |
| `arcane_describe` | read | Shows an operation's parameters and body schema from the live API. |
| `arcane_read` | read | Runs a read (GET) operation, validated against the schema. |
| `arcane_execute` | **write** | Runs a change operation (start/stop/redeploy/build/…) and returns a job ID. |
| `arcane_job` | read | Progress and final result of a change started with `arcane_execute`. |
| `arcane_audit` | read | Ranked posture report: privileged containers, `docker.sock` mounts, host networking, unpinned image tags, restart policy, health, pending updates, vulnerability totals, unused volumes. |

Covered Arcane areas: containers, Compose projects (including native text-file workspace edits), images, networks, volumes, activities, builds, update checks and vulnerability scans.

Deliberately **not** supported: shell access, the Docker socket, user/account/API-key administration, registering or removing Arcane environments, Swarm, binary uploads and downloads, and open-ended subscriptions.

## Requirements

- Node.js **22 or later** and npm
- A running Arcane instance reachable over **HTTPS** (tested against Arcane 2.15–2.16)
- An Arcane API key (create a dedicated one; see [Installation](docs/INSTALLATION.md))
- An MCP client: Claude Code, Claude Desktop, Codex, or any client that can start a stdio server

## Quick start

```bash
git clone https://github.com/dukefleed66/arcane-mcp.git
cd arcane-mcp
npm ci --ignore-scripts
```

Store the key and the configuration privately:

```bash
install -d -m 700 ~/.config/arcane-mcp
install -m 600 /dev/null ~/.config/arcane-mcp/api-key
# paste your Arcane API key into the file (use your editor, not shell history):
${EDITOR:-nano} ~/.config/arcane-mcp/api-key
cp config.example.json ~/.config/arcane-mcp/config.json   # then edit it
```

Register the server with your client, for example Claude Code:

```bash
claude mcp add arcane --scope user -- node "$PWD/src/server.mjs"
```

Start a **new** client session, then ask the assistant to call `arcane_connection`. Full instructions for every client, TLS options and troubleshooting are in [docs/INSTALLATION.md](docs/INSTALLATION.md).

## Configuration

`~/.config/arcane-mcp/config.json` (override the location with the `ARCANE_CONFIG` environment variable). The file holds **paths only, never the key itself.**

| Field | Required | Meaning |
|-------|----------|---------|
| `url` | yes | Arcane's HTTPS origin, e.g. `https://arcane.example.com`. No path, query or credentials. |
| `apiKeyFile` | yes | Path to a file containing only the API key. Must be mode `0600`. `~/` is expanded. |
| `caFile` | no | PEM file with the CA to trust, for a private or self-signed certificate authority. |
| `connectAddress` | no | IP address to connect to instead of resolving `url`'s host. TLS name verification still uses the `url` host. |
| `localImagePrefixes` | no | List of image-name prefixes you build yourself. `arcane_audit` reports a missing healthcheck on these at `info` level instead of `low`. |

There is **no switch to disable TLS verification**, by design.

## Using it

The assistant discovers the rest on its own. A typical flow:

1. `arcane_connection` — is Arcane up, and does anything need review?
2. `arcane_read` with `{"operationId":"listEnvironments","query":{"limit":100}}` — find the environment ID.
3. `arcane_operations` / `arcane_describe` — pick and inspect an operation.
4. `arcane_read` or `arcane_execute` — do the work; poll `arcane_job` for changes.
5. `arcane_audit` — get a posture report at any time. Optional arguments: `environmentId` (default `"0"`) and `ignore` (container names to skip, e.g. containers you start on demand).

Example audit output (shortened):

```json
{"environmentId":"0","containers":17,"findings":[
  {"severity":"high","container":"proxy","issue":"mounts docker.sock"},
  {"severity":"medium","container":"web","issue":"unpinned image tag: example/web:latest"},
  {"severity":"info","container":"app","issue":"locally built image, no healthcheck (add HEALTHCHECK to its Dockerfile)"}]}
```

## Staying current with Arcane releases

Arcane ships often. You normally **do nothing** after upgrading Arcane:

- The server reads Arcane's live API description on first use, every two minutes while reading, and before every change.
- A new Arcane version or documentation change just works. New read operations appear automatically.
- A change operation that is **new or whose parameters changed** is blocked until you review it. `arcane_connection` lists these in `drift.blockedMutations` and sets `drift.needsReview: true`.
- After reviewing, refresh the baseline: `npm run update-schema -- --expect-version <new version>`. The updater uses the same private configuration, verifies TLS, refuses redirects and writes atomically. Use `--output <path>` to stage a candidate and diff it first.
- If Arcane is briefly unreachable, reads continue from the last verified catalog; changes stay blocked until verification succeeds.

## Security model

In short: least privilege, fail closed, no ambient credentials.

- **One credential, one origin.** The API key is sent only to the configured HTTPS origin. Redirects are rejected. The key file must be `0600`.
- **Strict TLS.** Certificates are always verified; use `caFile` for a private CA.
- **Allowlist.** Only Docker-management routes are exposed. Account, API-key and environment-registration endpoints are not reachable.
- **Reviewed change contracts.** Each change operation is fingerprinted against the bundled baseline.
- **Scope guards.** Whole-project actions need `scope: "whole-project"`; per-service updates need an explicit service list.
- **Secret handling.** Recognised secret fields are masked in output, and the server refuses to write masked placeholders back to Arcane.
- **Bounded.** Responses are capped (8 MiB; 120,000 characters of tool output), at most four changes run at once, and changes are never retried automatically.
- **Untrusted data.** Container logs, labels and file names can contain text that tries to steer an AI assistant. Keep your client's per-call approval for `arcane_execute` switched on.

Recommendations: use a dedicated API key you can revoke; put Arcane behind HTTPS on a trusted network; do not expose the key file; review each Arcane upgrade's `drift` before approving. Details and reporting instructions: [SECURITY.md](SECURITY.md).

## Development

```bash
npm ci --ignore-scripts
npm test                      # unit tests, no network needed (uses a temporary loopback HTTPS server; needs openssl)
npm run smoke                 # MCP handshake and discovery
npm run smoke -- --live       # also tests your configured Arcane; read-only
```

See [CONTRIBUTING.md](CONTRIBUTING.md). Please never include real host names, addresses or keys in issues, tests or fixtures.

## Limits

- Job status is kept in memory (up to 100 records, 80 progress events each). After a restart, inspect Arcane's activity log.
- Redaction is best effort: free-form data can still contain sensitive text.
- Binary file uploads and downloads are not supported.

## License

[MIT](LICENSE). Third-party notices: [NOTICE.md](NOTICE.md).
