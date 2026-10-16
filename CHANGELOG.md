# Changelog

## 0.3.0 - first public release
- Stdio MCP server with 7 tools: `arcane_connection`, `arcane_operations`, `arcane_describe`, `arcane_read`,
  `arcane_execute`, `arcane_job`, `arcane_audit`.
- Live API discovery with a reviewed-baseline gate for change operations; `arcane_connection` reports `drift`.
- Read-only `arcane_audit` posture check (privileged containers, `docker.sock` mounts, host networking, unpinned tags,
  restart policy, health, updates, vulnerabilities, unused volumes).
- Reads keep working on the last good catalog while Arcane restarts; writes stay blocked until it is verified again.
- Configurable `localImagePrefixes` so locally built images are reported at `info` level.
- Dependencies updated to versions with no known advisories.
