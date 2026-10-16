import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createRequire } from 'node:module';
import { audit } from './audit.mjs';
import { operations, spec, loadConfig, prepare, describe, request, Jobs, redact, refreshCatalog, catalogStatus, drift } from './core.mjs';

const object = {type:'object',additionalProperties:true};
const callSchema = {type:'object',properties:{operationId:{type:'string'},pathParams:object,query:object,body:object,
  scope:{type:'string',enum:['whole-project'],description:'Explicit acknowledgement required for whole-project lifecycle operations.'},
  view:{type:'object',additionalProperties:false,properties:{relativePath:{type:'string'},search:{type:'string'},start:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:200}},description:'Client-side filter/pagination for project workspace trees; revision always retained.'}},required:['operationId'],additionalProperties:false};
const definitions = [
 ['arcane_operations','Discover supported Arcane Docker operations. Filter by search or readOnly, then describe the chosen operation before calling it.',{type:'object',properties:{search:{type:'string'},readOnly:{type:'boolean'}},additionalProperties:false},true],
 ['arcane_describe','Get parameters and body schema from the verified live API. Changed/new mutation contracts remain blocked until reviewed in the approved snapshot.',{type:'object',properties:{operationId:{type:'string'}},required:['operationId'],additionalProperties:false},true],
 ['arcane_read','Read Docker state through Arcane. Start with listEnvironments; use the actual environment ID in pathParams.id. No mutations are allowed.',callSchema,true],
 ['arcane_execute','Execute an authorized Docker change through Arcane after fresh live schema verification. Poll arcane_job. One-service changes require explicit services; project-wide lifecycle calls require scope=whole-project. Workspace supports text uploads, revisions and baseline conflicts. Prefer targeted changes over project-wide ones. Never repeat an uncertain mutation.',callSchema,false],
 ['arcane_job','Read progress and result for an operation started by arcane_execute. A running job is not completion.',{type:'object',properties:{jobId:{type:'string'}},required:['jobId'],additionalProperties:false},true],
 ['arcane_audit','Read-only posture audit of one environment (default "0"): privileged/docker.sock/host-network containers, unpinned tags, restart policy, health, pending updates, vulnerability totals, unused volumes. Findings are ranked by severity.',{type:'object',properties:{environmentId:{type:'string'},ignore:{type:'array',items:{type:'string'},description:'Container names to skip, e.g. on-demand ones.'}},additionalProperties:false},true],
 ['arcane_connection','Verify Arcane health and schema version. Does not expose configuration credentials.',{type:'object',properties:{},additionalProperties:false},true]
];
const jobs = new Jobs((p,event) => request(loadConfig(),p,event));
const server = new Server({name:'arcane',version:createRequire(import.meta.url)('../package.json').version},{capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:definitions.map(([name,description,inputSchema,readOnlyHint])=>({name,description,inputSchema,annotations:{readOnlyHint,destructiveHint:!readOnlyHint,idempotentHint:readOnlyHint,openWorldHint:true}}))}));
server.setRequestHandler(CallToolRequestSchema,async({params})=>{
  try {
    const a=params.arguments || {}; let result, cfg;
    if (params.name !== 'arcane_job') {
      cfg=loadConfig();
      await refreshCatalog(cfg, params.name === 'arcane_execute' || params.name === 'arcane_connection');
    }
    if (params.name==='arcane_operations') {
      const search=String(a.search || '').toLowerCase();
      result={schemaVersion:spec.info.version,catalog:catalogStatus,operations:[...operations.values()].filter(o=>(a.readOnly===undefined || o.readOnly===a.readOnly) && `${o.operationId} ${o.summary} ${o.route}`.toLowerCase().includes(search)).map(o=>({operationId:o.operationId,method:o.method,path:o.route,summary:o.summary,readOnly:o.readOnly,mutationAllowed:o.mutationAllowed}))};
    } else if (params.name==='arcane_describe') result=describe(a.operationId);
    else if (params.name==='arcane_read') result=await request(cfg,prepare(a,true));
    else if (params.name==='arcane_execute') result=jobs.start(prepare(a,false));
    else if (params.name==='arcane_audit') result=await audit(cfg,a.environmentId,a.ignore);
    else if (params.name==='arcane_job') result=jobs.get(a.jobId);
    else if (params.name==='arcane_connection') {
      const health=await request(cfg,{op:{method:'GET'},route:'/api/health'});
      result={url:cfg.url,health,drift:drift(catalogStatus),operationCount:operations.size,catalog:catalogStatus};
    } else throw new Error('Unknown tool');
    // Schema property names such as env/token describe types, not live secrets.
    const text=JSON.stringify(params.name === 'arcane_describe' ? result : redact(result));
    if (text.length>120000) throw new Error('Result exceeds tool output budget; narrow with search, start and limit');
    return {content:[{type:'text',text}]};
  } catch(error) { return {isError:true,content:[{type:'text',text:error.message}]}; }
});
await server.connect(new StdioServerTransport());
