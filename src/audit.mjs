import { request, prepare } from './core.mjs';

const read = (cfg, id, operationId, extra = {}) => request(cfg, prepare({ operationId, pathParams: { id, ...extra.pathParams }, query: extra.query }, true));
const unpinned = image => !image.includes('@sha256:') && (!/:[^/]+$/.test(image) || image.endsWith(':latest'));

// Read-only posture check of one environment; every finding names its container.
export async function audit(cfg, id = '0', ignore = []) {
  const findings = [];
  const add = (severity, container, issue) => findings.push({ severity, container, issue });
  const { data: containers, pagination } = await read(cfg, id, 'list-containers', { query: { limit: 200 } });
  if (pagination?.totalItems > containers.length) add('low', '-', `only ${containers.length}/${pagination.totalItems} containers audited`);
  for (const c of containers) {
    const name = c.names?.[0] || c.id.slice(0, 12);
    if (ignore.includes(name)) continue; // e.g. on-demand containers
    let policy;
    try { policy = (await read(cfg, id, 'get-container', { pathParams: { containerId: c.id } })).data.hostConfig?.restartPolicy; }
    catch { add('low', name, 'could not read container details; restart policy not checked'); policy = 'unknown'; }
    if (c.hostConfig?.privileged) add('high', name, 'privileged container');
    if (c.mounts?.some(m => m.source?.endsWith('docker.sock'))) add('high', name, 'mounts docker.sock');
    if (c.hostConfig?.networkMode === 'host') add('medium', name, 'host network mode');
    if (unpinned(c.image)) add('medium', name, `unpinned image tag: ${c.image}`);
    if (!policy || policy === 'no') add('medium', name, 'no restart policy');
    if (c.state !== 'running') add('medium', name, `state is ${c.state}`);
    if (/unhealthy/.test(c.status)) add('high', name, 'healthcheck failing');
    else if (c.state === 'running' && !/\(health/.test(c.status)) {
      const local = (cfg.localImagePrefixes || []).some(prefix => c.image.startsWith(prefix));
      add(local ? 'info' : 'low', name, local ? 'locally built image, no healthcheck (add HEALTHCHECK to its Dockerfile)' : 'no healthcheck');
    }
  }
  const updates = (await read(cfg, id, 'get-update-summary')).data;
  const vulns = (await read(cfg, id, 'get-environment-vulnerability-summary')).data;
  const volumes = await read(cfg, id, 'list-volumes', { query: { limit: 1 } });
  if (updates.imagesWithUpdates) add('medium', '-', `${updates.imagesWithUpdates} image(s) have updates; upstream pulls can discard local patches`);
  if (vulns.summary.critical) add('high', '-', `${vulns.summary.critical} critical vulnerabilities`);
  if (vulns.scannedImages < vulns.totalImages) add('low', '-', `only ${vulns.scannedImages}/${vulns.totalImages} images scanned`);
  if (volumes.counts?.unused) add('low', '-', `${volumes.counts.unused} unused volume(s)`);
  const rank = { high: 0, medium: 1, low: 2, info: 3 };
  findings.sort((a, b) => rank[a.severity] - rank[b.severity]);
  return { environmentId: id, // not `environment`: redact() masks that key as container env vars
    containers: containers.length, updates, vulnerabilities: vulns, findings };
}
