import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import net from 'node:net';
import { randomUUID, createHash } from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020.js';

export let spec = JSON.parse(fs.readFileSync(new URL('../arcane-openapi.json', import.meta.url)));
const approvedSpec = spec;
const ajv = new Ajv2020({ strict: false, validateFormats: false, allErrors: true });
const allowed = p => ['/health', '/version', '/app-version', '/environments', '/events'].includes(p)
  || /^\/environments\/\{id\}(?:\/(?:containers|projects|images|networks|volumes|activities|vulnerabilities|image-updates|updater|jobs|job-schedules|builds|dashboard|ports|version)(?:\/|$)|\/system\/(?:docker\/info|health)$|$)/.test(p);
// Binary downloads, file uploads and streaming subscriptions need distinct transports.
const excluded = /\/(?:download|export|upload|attestations|workspace\/file\/download|browse\/download)$/;
export const operations = new Map();
const validators = new Map();
const metadata = new Set(['description','summary','examples','example','title','deprecated','$schema','externalDocs']);
function canonical(value, source, seen = new Set()) {
  if (Array.isArray(value)) return value.map(v => canonical(v, source, seen));
  if (!value || typeof value !== 'object') return value;
  if (value.$ref) {
    if (!value.$ref.startsWith('#/')) throw new Error('External schema references are not supported');
    if (seen.has(value.$ref)) return {$ref:value.$ref};
    const target = value.$ref.slice(2).split('/').reduce((v,k) => v?.[k.replace(/~1/g,'/').replace(/~0/g,'~')], source);
    if (!target) throw new Error('Unresolved schema reference');
    return canonical(target, source, new Set([...seen, value.$ref]));
  }
  return Object.fromEntries(Object.keys(value).sort().filter(k => !metadata.has(k)).map(k => [k,canonical(value[k],source,seen)]));
}
export function contractFingerprint(op, source) {
  return createHash('sha256').update(JSON.stringify(canonical({method:op.method,route:op.route,
    parameters:op.parameters || [],requestBody:op.requestBody || null,wireRequestBody:op.wireRequestBody || null},source))).digest('hex');
}
function makeOperations(document) {
const registry = new Map();
for (const [route, item] of Object.entries(document.paths)) {
  if (!allowed(route) || excluded.test(route)) continue;
  for (const [method, op] of Object.entries(item)) {
    if (!['get', 'post', 'put', 'patch', 'delete'].includes(method) || !op.operationId) continue;
    // Environment registration/removal and remote credentials are intentionally outside Docker management.
    if ((route === '/environments' || route === '/environments/{id}') && method !== 'get') continue;
    const content = op.requestBody?.content;
    if (content && !content['application/json']) continue;
    if (registry.has(op.operationId)) throw new Error('Duplicate operation ID');
    registry.set(op.operationId, { ...op, route, method: method.toUpperCase(), readOnly: method === 'get' });
  }
}

// Arcane 2.13.1 creates projects with multipart JSON parts; expose a typed JSON facade.
// Verified in backend/internal/project/handler.go and types/project/project.go.
const createProject = document.paths['/environments/{id}/projects']?.post;
if (createProject?.operationId === 'create-project' && createProject.requestBody?.content?.['multipart/form-data']) registry.set('create-project', {
  ...createProject, wireRequestBody:createProject.requestBody,route:'/environments/{id}/projects', method:'POST', readOnly:false, multipart:true,
  requestBody:{required:true,content:{'application/json':{schema:{
    type:'object',additionalProperties:false,required:['name','composeContent'],properties:{
      name:{type:'string',minLength:1},composeContent:{type:'string',minLength:1},envContent:{type:'string'},
      tags:{type:'array',items:{type:'string'}}
    }
  }}}}
});
const workspaceRoute = '/environments/{id}/projects/{projectId}/workspace';
const workspace = document.paths[workspaceRoute]?.put;
const form = workspace?.requestBody?.content?.['multipart/form-data']?.schema;
if (workspace?.operationId === 'update-project-workspace' && form?.properties?.manifest?.type === 'string'
  && form?.properties?.files?.type === 'array' && form.required?.includes('manifest')) {
  registry.set('update-project-workspace', {...workspace,wireRequestBody:workspace.requestBody,route:workspaceRoute,method:'PUT',readOnly:false,multipart:'workspace',
    requestBody:{required:true,content:{'application/json':{schema:{type:'object',additionalProperties:false,
      required:['fileTreeRevision','fileChanges'],properties:{fileTreeRevision:{type:'string',minLength:1},fileChanges:{type:'array',minItems:1,maxItems:500,items:{
        type:'object',additionalProperties:false,required:['operation','relativePath'],properties:{
          operation:{type:'string',enum:['create_file','create_folder','update_file','rename','move','delete']},
          relativePath:{type:'string',minLength:1},content:{type:'string'},baselineContent:{type:'string'},newName:{type:'string'},
          newParentPath:{type:'string'},recursive:{type:'boolean'}
        }
      }}}}}}}});
}
return registry;
}
const approvedOperations = makeOperations(approvedSpec);
export function installSchema(document) {
  if (!document.openapi?.startsWith('3.') || typeof document.info?.version !== 'string' || !document.paths || !document.components)
    throw new Error('Invalid Arcane OpenAPI document');
  // Resolve and validate every exposed request contract before publishing any of it.
  const next = makeOperations(document);
  for (const op of next.values()) {
    op.contractHash = contractFingerprint(op, document);
    const approved = approvedOperations.get(op.operationId);
    op.mutationAllowed = op.readOnly || (!!approved && op.contractHash === contractFingerprint(approved, approvedSpec));
  }
  spec = document;
  validators.clear();
  ajv.removeSchema();
  operations.clear();
  for (const [id,op] of next) operations.set(id,op);
  return {schemaVersion:spec.info.version,operationCount:operations.size,
    blockedMutations:[...operations.values()].filter(o=>!o.mutationAllowed).map(o=>o.operationId)};
}
installSchema(spec);

// Live Arcane vs the reviewed baseline: a version change alone is fine, a blocked mutation needs review.
export const drift = ({schemaVersion, blockedMutations = []}) => ({approvedVersion:approvedSpec.info.version, liveVersion:schemaVersion,
  versionChanged:schemaVersion !== approvedSpec.info.version, blockedMutations, needsReview:blockedMutations.length > 0});

let refreshedAt = 0, refreshPromise;
export const catalogStatus = {verified:false,approvedVersion:approvedSpec.info.version};
export async function refreshCatalog(cfg, force = false) {
  if (!force && catalogStatus.verified && Date.now()-refreshedAt < 120000) return catalogStatus;
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    try {
      const live = await request(cfg,{op:{method:'GET'},route:'/api/openapi.json',schemaDocument:true});
      const installed = installSchema(live);
      Object.assign(catalogStatus,installed,{verified:true,error:undefined,verifiedAt:new Date().toISOString()});
      refreshedAt = Date.now();
      return catalogStatus;
    } catch (error) {
      catalogStatus.verified = false;
      catalogStatus.error = error.message;
      // Reads keep the last good catalog; writes always force a refresh, so they still fail.
      if (!force && refreshedAt) return catalogStatus;
      throw new Error('Live Arcane schema verification failed; mutations are disabled');
    } finally { refreshPromise = undefined; }
  })();
  return refreshPromise;
}

export function loadConfig() {
  const filename = process.env.ARCANE_CONFIG || path.join(os.homedir(), '.config/arcane-mcp/config.json');
  const cfg = JSON.parse(fs.readFileSync(filename, 'utf8'));
  const expand = p => typeof p === 'string' ? p.replace(/^~(?=\/)/, os.homedir()) : p;
  cfg.apiKeyFile = expand(cfg.apiKeyFile); cfg.caFile = expand(cfg.caFile);
  if (cfg.localImagePrefixes !== undefined && !(Array.isArray(cfg.localImagePrefixes) && cfg.localImagePrefixes.every(p => typeof p === 'string')))
    throw new Error('localImagePrefixes must be an array of strings');
  const url = new URL(cfg.url);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname))
    throw new Error('Arcane URL must be an HTTPS origin without credentials, query or path');
  if (cfg.connectAddress && !net.isIP(cfg.connectAddress)) throw new Error('connectAddress must be an IP address');
  const st = fs.statSync(cfg.apiKeyFile);
  if (st.mode & 0o077) throw new Error('API key file must have permissions 0600');
  const key = fs.readFileSync(cfg.apiKeyFile, 'utf8').trim();
  if (!key || /[\r\n]/.test(key)) throw new Error('API key is missing or invalid');
  return { ...cfg, url: url.origin, key, ca: cfg.caFile ? fs.readFileSync(cfg.caFile) : undefined };
}

const sensitive = /password|passwd|secret|token|api.?key|authorization|cookie|private.?key|^env$|^environment$|^envcontent$|^envfilecontent$|^envvars$|^envmap$|^credentials$/i;
export function redact(value, key = '') {
  if (Array.isArray(value)) return value.map(v => redact(v, key));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, sensitive.test(k) ? '[REDACTED]' : redact(v, key)]));
  if (typeof value !== 'string') return value;
  let text = key ? value.split(key).join('[REDACTED]') : value;
  text = text.replace(/(\b[\w.-]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_KEY|APIKEY|PRIVATE_KEY)[\w.-]*\s*[:=]\s*)([^\n,}]+)/gi, '$1[REDACTED]');
  text = text.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, '$1[REDACTED]@');
  return text;
}

function check(schema, value, label) {
  const key = JSON.stringify(schema);
  if (!validators.has(key)) validators.set(key, ajv.compile({ ...schema, components: spec.components }));
  const validate = validators.get(key);
  if (!validate(value)) throw new Error(`Invalid ${label}: ${validate.errors.map(e => `${e.instancePath} ${e.message}`).join('; ')}`);
}

export function prepare(args, readOnly) {
  const op = operations.get(args.operationId);
  if (!op) throw new Error('Unknown operation. Use arcane_operations first.');
  if (op.readOnly !== readOnly) throw new Error(readOnly ? 'Mutations require arcane_execute' : 'Reads require arcane_read');
  if (!readOnly && !op.mutationAllowed) throw new Error('Mutation request contract changed or is new; review the live schema and refresh the approved snapshot before executing');
  if (!readOnly && ['deploy-project','redeploy-project','down-project','restart-project','destroy-project'].includes(op.operationId)
    && args.scope !== 'whole-project') throw new Error('This affects the whole project; set scope="whole-project" only when the task authorizes that scope. Use explicit services for a one-service change.');
  if (op.operationId === 'update-project-services' && !args.body?.services?.length) throw new Error('Explicit non-empty services are required; an empty list updates the whole project');
  const pathParams = args.pathParams || {}, query = args.query || {};
  for (const [location, values] of [['path',pathParams], ['query',query]]) {
    const params = (op.parameters || []).filter(p => p.in === location);
    const properties = Object.fromEntries(params.map(p => [p.name, p.schema]));
    check({ type:'object', properties, required:params.filter(p => p.required).map(p => p.name), additionalProperties:false }, values, location);
  }
  let route = op.route.replace(/\{([^}]+)\}/g, (_, k) => {
    const value = String(pathParams[k]);
    if (!value || /[\/\\%?#\x00-\x1f]/.test(value) || value === '.' || value === '..') throw new Error('Invalid path identifier');
    return encodeURIComponent(value);
  });
  const qs = new URLSearchParams();
  for (const [k,v] of Object.entries(query)) qs.set(k, Array.isArray(v) ? v.join(',') : String(v));
  if (qs.size) route += '?' + qs;
  const bodySchema = op.requestBody?.content?.['application/json']?.schema;
  if (args.body !== undefined) {
    if (!bodySchema) throw new Error('This operation does not accept a JSON body');
    check(bodySchema, args.body, 'body');
    if (JSON.stringify(args.body).includes('[REDACTED]')) throw new Error('Refusing to write masked secret placeholders');
  } else if (op.requestBody?.required) throw new Error('A body is required; inspect the operation schema');
  if (op.multipart === 'workspace') validateWorkspace(args.body);
  const streaming = op.method === 'POST' && (/\/projects\/\{projectId\}\/(up|redeploy|pull|build)$/.test(op.route) || /\/images\/(pull|build)$/.test(op.route));
  return { op, route:'/api'+route, body:args.body, streaming, view:args.view };
}

function safeRelative(value, allowEmpty = false) {
  if ((allowEmpty && value === '') || (typeof value === 'string' && value && !value.startsWith('/') && !/[\\\x00-\x1f]/.test(value)
    && value.split('/').every(part => part && part !== '.' && part !== '..'))) return;
  throw new Error('Invalid workspace relative path');
}
function validateWorkspace(body) {
  for (const change of body.fileChanges) {
    safeRelative(change.relativePath);
    if (/^(compose(?:\.override)?\.ya?ml|docker-compose(?:\.override)?\.ya?ml|\.env(?:\.git)?|project\.env)$/.test(change.relativePath))
      throw new Error('Protected Compose/env files must use update-project with preserved secrets');
    const upload = ['create_file','update_file'].includes(change.operation);
    if (upload !== (typeof change.content === 'string')) throw new Error('File creates/updates require content; other operations must not include it');
    if (change.baselineContent !== undefined && change.operation !== 'update_file') throw new Error('baselineContent is only valid for update_file');
    if (change.operation === 'rename' && (!change.newName || /[\/\\\x00-\x1f]/.test(change.newName) || ['.','..'].includes(change.newName))) throw new Error('Invalid rename destination');
    if (change.operation === 'move') safeRelative(change.newParentPath, true);
    if (upload && Buffer.byteLength(change.content) > 10*1024*1024) throw new Error('Workspace upload exceeds 10 MiB');
  }
}

export function projectWorkspaceView(result, view = {}) {
  if (!result?.data || !Array.isArray(result.data.files)) return result;
  const {relativePath='',search='',start=0,limit=100} = view;
  safeRelative(relativePath, true);
  if (!Number.isInteger(start) || start < 0 || !Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('Workspace view start/limit are invalid');
  const all = result.data.files;
  const selected = all.filter(f => (!relativePath || f.relativePath===relativePath || f.relativePath.startsWith(relativePath+'/'))
    && (!search || f.relativePath.toLowerCase().includes(search.toLowerCase())));
  return {...result,data:{...result.data,files:selected.slice(start,start+limit)},
    workspacePagination:{start,limit,totalMatches:selected.length,totalEntries:all.length,hasMore:start+limit<selected.length}};
}

export function describe(operationId) {
  const op = operations.get(operationId);
  if (!op) throw new Error('Unknown operation');
  const refs = {};
  function collect(v) {
    if (!v || typeof v !== 'object') return;
    if (v.$ref?.startsWith('#/components/schemas/')) {
      const n = v.$ref.split('/').pop();
      if (!(n in refs)) { refs[n] = spec.components.schemas[n]; collect(refs[n]); }
    }
    for (const child of Object.values(v)) if (child && typeof child === 'object') collect(child);
  }
  const schema = { operationId, method:op.method, path:op.route, summary:op.summary, description:op.description, readOnly:op.readOnly,
    schemaVersion:spec.info.version,mutationAllowed:op.mutationAllowed,contractHash:op.contractHash,parameters:op.parameters,requestBody:op.requestBody };
  collect(schema);
  return { ...schema, components:{schemas:refs} };
}

export function request(cfg, prepared, onEvent = () => {}) {
  const { op, route, body, streaming, schemaDocument, view } = prepared;
  if (schemaDocument && (op.method !== 'GET' || route !== '/api/openapi.json')) throw new Error('Unredacted schema mode is restricted to the OpenAPI endpoint');
  const url = new URL(cfg.url);
  let payload = body === undefined ? undefined : JSON.stringify(body);
  let contentType = 'application/json';
  if (op.multipart) {
    const boundary='arcane-mcp-'+randomUUID();
    contentType='multipart/form-data; boundary='+boundary;
    if (op.multipart === 'workspace') {
      const uploads=[];
      const changes=body.fileChanges.map(({content,baselineContent,...change}) => {
        if (content !== undefined) { change.uploadIndex=uploads.length; uploads.push(content); }
        if (baselineContent !== undefined) { change.baselineIndex=uploads.length; uploads.push(baselineContent); }
        return change;
      });
      const manifest={fileTreeRevision:body.fileTreeRevision,fileChanges:changes};
      const parts=[Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="manifest"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(manifest)}\r\n`)];
      uploads.forEach((content,index)=>parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="upload-${index}"\r\nContent-Type: application/octet-stream\r\n\r\n`),Buffer.from(content),Buffer.from('\r\n')));
      parts.push(Buffer.from(`--${boundary}--\r\n`)); payload=Buffer.concat(parts);
    } else payload=[['project',body],['manifest',{fileChanges:[]}]].map(([name,value]) =>
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(value)}\r\n`
      ).join('')+`--${boundary}--\r\n`;
  }
  return new Promise((resolve,reject) => {
    let settled = false, res, timer;
    const finish = (error,result) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      error ? reject(error) : resolve(result);
      res?.destroy(); req.destroy();
    };
    const req = https.request({
      hostname:url.hostname, port:url.port || 443, path:route, method:op.method,
      ca:cfg.ca, rejectUnauthorized:true, servername:url.hostname,
      ...(cfg.connectAddress ? {lookup:(_host,options,callback) => options.all ? callback(null,[{address:cfg.connectAddress,family:net.isIP(cfg.connectAddress)}]) : callback(null,cfg.connectAddress,net.isIP(cfg.connectAddress))} : {}),
      headers:{ 'X-Api-Key':cfg.key, 'Accept':'application/json', 'Content-Type':contentType, 'Origin':cfg.url, 'User-Agent':'Codex-Arcane-MCP/0.1' }
    }, response => {
      res = response;
      const status = response.statusCode;
      // Never follow redirects with credentials; do not echo potentially sensitive error bodies.
      if (status < 200 || status >= 300) return finish(new Error(`Arcane HTTP ${status}; inspect Arcane before retrying a mutation`));
      response.setEncoding('utf8');
      let buffer = '', result, bytes = 0;
      const line = text => {
        if (!text.trim()) return;
        let event;
        try { event = JSON.parse(text); } catch { throw new Error('Invalid Arcane JSON stream; outcome unknown, inspect activity'); }
        onEvent(redact(event,cfg.key));
        if (event.error || event.success === false) return finish(new Error('Arcane operation failed; inspect activity output'));
        if (event.done === true) finish(null,{completed:true});
      };
      response.on('data', chunk => {
        if (settled) return;
        bytes += Buffer.byteLength(chunk);
        buffer += chunk;
        if ((!streaming && bytes > (schemaDocument ? 16 : 8)*1024*1024) || buffer.length > (schemaDocument ? 16 : 8)*1024*1024) return finish(new Error('Response too large; narrow the request with pagination'));
        if (streaming) {
          try {
            let n;
            while ((n = buffer.indexOf('\n')) >= 0 && !settled) { const row = buffer.slice(0,n); buffer = buffer.slice(n+1); line(row); }
          } catch (e) { finish(e); }
        }
      });
      response.on('end', () => {
        if (settled) return;
        try {
          if (streaming) {
            if (buffer.trim()) line(buffer);
            if (!settled) finish(new Error('Arcane stream ended without done:true; outcome unknown, inspect activities before retrying'));
          } else {
            result = buffer.trim() ? JSON.parse(buffer) : {completed:true};
            if (result.success === false || result.error) finish(new Error('Arcane reported an unsuccessful operation'));
            else finish(null,schemaDocument ? result : projectWorkspaceView(redact(result,cfg.key),view));
          }
        } catch { finish(new Error('Invalid Arcane response; inspect state before retrying a mutation')); }
      });
      response.on('error', () => finish(new Error('Arcane connection interrupted; outcome unknown for mutations')));
    });
    req.on('error', error => finish(new Error(`Arcane connection failed (${error.code || 'transport error'}); inspect state before retrying mutations`)));
    timer = setTimeout(() => finish(new Error('Arcane request timed out; mutation may still be running. Inspect activities before retrying.')), streaming ? 30*60*1000 : 45*1000);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

export class Jobs {
  constructor(run) { this.run = run; this.jobs = new Map(); }
  start(prepared) {
    if ([...this.jobs.values()].filter(j => j.state === 'running').length >= 4) throw new Error('Four operations are already running');
    for (const [id,j] of this.jobs) if (j.state !== 'running' && Date.now()-j.started > 3600000) this.jobs.delete(id);
    if (this.jobs.size >= 100) {
      const old = [...this.jobs].find(([,j])=>j.state !== 'running'); if (old) this.jobs.delete(old[0]);
    }
    const id = randomUUID();
    const job = {jobId:id, operationId:prepared.op.operationId, state:'running', started:Date.now(), events:[]};
    this.jobs.set(id,job);
    Promise.resolve().then(()=>this.run(prepared,event=> {
      if (event.activityId) job.activityId=event.activityId;
      job.events.push(event); if (job.events.length>80) job.events.shift();
    })).then(result=>{job.state='completed';job.result=result;},error=>{job.state='failed';job.error=error.message;});
    return {jobId:id,state:'running',instruction:'Poll arcane_job until completion. Do not submit this operation again.'};
  }
  get(id) { const j=this.jobs.get(id); if (!j) throw new Error('Unknown job. Jobs are process-local; inspect Arcane activities after an MCP restart.'); return j; }
}
