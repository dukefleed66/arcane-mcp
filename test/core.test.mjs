import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import {execFileSync} from 'node:child_process';
import {operations,prepare,redact,request,Jobs,spec,installSchema,projectWorkspaceView,refreshCatalog,catalogStatus,drift} from '../src/core.mjs';
const approved=structuredClone(spec);

test('read/write boundary and credential APIs are enforced',()=>{
  assert.throws(()=>prepare({operationId:'restart-container',pathParams:{id:'0',containerId:'x'}},true),/Mutations/);
  assert.throws(()=>prepare({operationId:'listEnvironments'},false),/Reads/);
  assert.throws(()=>prepare({operationId:'create-api-key'},false),/Unknown/);
  assert(![...operations.values()].some(o=>o.route.includes('deployment/mtls')));
});
test('exact schema validation and environment selection',()=>{
  assert.throws(()=>prepare({operationId:'list-containers'},true),/required/);
  assert.throws(()=>prepare({operationId:'listEnvironments',query:{limit:'100'}},true),/integer/);
  assert.throws(()=>prepare({operationId:'listEnvironments',query:{unknown:'x'}},true),/additional/);
  assert.throws(()=>prepare({operationId:'restart-container',pathParams:{id:'../other',containerId:'x'}},false),/identifier/);
  assert.throws(()=>prepare({operationId:'restart-container',pathParams:{id:'%2f',containerId:'x'}},false),/identifier/);
  assert.throws(()=>prepare({operationId:'deploy-project',scope:'whole-project',pathParams:{id:'remote',projectId:'p'},body:{recreateVolumes:'false'}},false),/boolean/);
  const p=prepare({operationId:'list-containers',pathParams:{id:'remote'},query:{start:20,limit:10}},true);
  assert.equal(p.route,'/api/environments/remote/containers?start=20&limit=10');
  const vulnerabilities=prepare({operationId:'list-environment-vulnerabilities',pathParams:{id:'remote'},query:{fixAvailable:true}},true);
  assert.equal(vulnerabilities.route,'/api/environments/remote/vulnerabilities/all?fixAvailable=true');
  assert.throws(()=>prepare({operationId:'list-environment-vulnerabilities',pathParams:{id:'remote'},query:{fixAvailable:'true'}},true),/boolean/);
});

test('release changes refresh reads without enabling new/changed writes',()=>{
  const live=structuredClone(approved);live.info.version='2.99.0';
  live.paths['/environments/{id}/containers'].get.description='A weekly documentation change';
  live.paths['/environments/{id}/containers/new-read']={get:{operationId:'future-read',parameters:[{in:'path',name:'id',required:true,schema:{type:'string'}}]}};
  live.paths['/environments/{id}/containers/new-write']={post:{operationId:'future-write',parameters:[{in:'path',name:'id',required:true,schema:{type:'string'}}]}};
  live.paths['/environments/{id}/containers/{containerId}/restart'].post.parameters.push({in:'query',name:'dangerousNewOption',schema:{type:'boolean'}});
  try {
    const status=installSchema(live);
    assert.equal(status.schemaVersion,'2.99.0');
    assert.equal(prepare({operationId:'future-read',pathParams:{id:'remote'}},true).route,'/api/environments/remote/containers/new-read');
    assert.throws(()=>prepare({operationId:'future-write',pathParams:{id:'remote'}},false),/contract changed or is new/);
    assert.throws(()=>prepare({operationId:'restart-container',pathParams:{id:'remote',containerId:'x'}},false),/contract changed or is new/);
    assert(operations.get('create-container').mutationAllowed);
  } finally {installSchema(approved);}
});

test('invalid live catalog cannot partially replace the verified registry',()=>{
  const bad=structuredClone(approved);
  bad.paths['/environments/{id}/containers'].get.parameters[0].schema={$ref:'https://untrusted.example/schema'};
  const size=operations.size;
  assert.throws(()=>installSchema(bad),/External schema/);
  assert.equal(operations.size,size);
  assert.equal(spec.info.version,approved.info.version);
});

test('multipart wire contract changes disable the workspace adapter',()=>{
  const live=structuredClone(approved);
  live.paths['/environments/{id}/projects/{projectId}/workspace'].put.requestBody.content['multipart/form-data'].schema.required.push('newRequiredPart');
  try {installSchema(live);assert.equal(operations.get('update-project-workspace').mutationAllowed,false);}
  finally {installSchema(approved);}
});

test('single-service updates cannot silently expand to the whole project',()=>{
  const pathParams={id:'remote',projectId:'p'};
  assert.throws(()=>prepare({operationId:'update-project-services',pathParams,body:{services:[]}},false),/non-empty services/);
  assert.throws(()=>prepare({operationId:'deploy-project',pathParams,body:{pullPolicy:'never'}},false),/whole project/);
  assert.deepEqual(prepare({operationId:'update-project-services',pathParams,body:{services:['homepage']}},false).body.services,['homepage']);
  assert.equal(prepare({operationId:'deploy-project',pathParams,scope:'whole-project',body:{pullPolicy:'never'}},false).body.pullPolicy,'never');
});

test('workspace view limits large trees while retaining revisions and source truncation',()=>{
  const result={success:true,data:{fileTreeRevision:'rev',fileTreeTruncated:true,files:Array.from({length:1000},(_,i)=>({relativePath:`config/file-${i}`}))}};
  const page=projectWorkspaceView(result,{relativePath:'config',start:10,limit:5});
  assert.equal(page.data.files.length,5);assert.equal(page.data.fileTreeRevision,'rev');assert.equal(page.data.fileTreeTruncated,true);
  assert.equal(page.workspacePagination.totalMatches,1000);assert.equal(page.workspacePagination.hasMore,true);
  assert.throws(()=>projectWorkspaceView(result,{relativePath:'../outside'}),/relative path/);
});

test('workspace rejects escape paths, protected files and incorrect content operations',()=>{
  const call=change=>prepare({operationId:'update-project-workspace',pathParams:{id:'remote',projectId:'p'},body:{fileTreeRevision:'rev',fileChanges:[change]}},false);
  assert.throws(()=>call({operation:'update_file',relativePath:'../secret',content:'x'}),/relative path/);
  assert.throws(()=>call({operation:'update_file',relativePath:'compose.yaml',content:'x'}),/Protected/);
  assert.throws(()=>call({operation:'create_file',relativePath:'config/x'}),/require content/);
  assert.throws(()=>call({operation:'delete',relativePath:'config/x',content:'x'}),/must not include/);
  assert.throws(()=>call({operation:'rename',relativePath:'config/x',newName:'../../x'}),/rename/);
});

test('workspace multipart preserves text/baselines and live schema fetch preserves schema property names',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'arcane-workspace-test-'));
  const key=path.join(dir,'key.pem'),cert=path.join(dir,'cert.pem');
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost'],{stdio:'ignore'});
  let wire, failSchema=false;
  const live=structuredClone(approved);live.info.version='2.15.2';
  const server=https.createServer({key:fs.readFileSync(key),cert:fs.readFileSync(cert)},(req,res)=>{
    if(req.url==='/api/openapi.json') {res.writeHead(failSchema?503:200);res.end(failSchema?'unavailable':JSON.stringify(live));return;}
    const chunks=[];req.on('data',c=>chunks.push(c));req.on('end',()=>{wire=Buffer.concat(chunks).toString();res.writeHead(200);res.end('{"success":true,"data":{"fileTreeRevision":"next","files":[]}}');});
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>{server.closeAllConnections();server.close();fs.rmSync(dir,{recursive:true,force:true});installSchema(approved);});
  const cfg={url:`https://localhost:${server.address().port}`,connectAddress:'127.0.0.1',ca:fs.readFileSync(cert),key:'test-key'};
  await refreshCatalog(cfg,true);
  assert.equal(spec.info.version,'2.15.2');
  assert.equal(typeof spec.components.schemas.ProjectUpdateProject.properties.envContent,'object');
  const p=prepare({operationId:'update-project-workspace',pathParams:{id:'remote',projectId:'p'},body:{fileTreeRevision:'rev',fileChanges:[
    {operation:'update_file',relativePath:'config/unicode.txt',content:'line one\nGrüße\n',baselineContent:'old\n'},
    {operation:'create_folder',relativePath:'config/new'}]}},false);
  assert.equal((await request(cfg,p)).data.fileTreeRevision,'next');
  assert(wire.includes('name="manifest"'));assert(wire.includes('"uploadIndex":0'));assert(wire.includes('"baselineIndex":1'));
  assert(wire.includes('line one\nGrüße\n'));assert(wire.includes('old\n'));assert(wire.includes('filename="upload-1"'));
  failSchema=true;await assert.rejects(refreshCatalog(cfg,true),/mutations are disabled/);assert.equal(catalogStatus.verified,false);
});
test('secrets are removed from objects, environment arrays and logs',()=>{
  const clean=JSON.stringify(redact({ApiKey:'abc',Config:{Env:['PASSWORD=pw']},nested:{envContent:'TOKEN=token'},log:'SECRET=abc\nother key-123'},'key-123'));
  for(const secret of ['abc','pw','key-123','TOKEN=token']) assert(!clean.includes(secret));
  assert(clean.includes('REDACTED'));
});
test('async jobs expose completion and failures without resubmission',async()=>{
  let calls=0;
  const jobs=new Jobs(async(p,event)=>{calls++;event({activityId:'activity'});return {ok:true};});
  const j=jobs.start({op:{operationId:'test'}});
  assert.equal(j.state,'running'); await new Promise(r=>setImmediate(r));
  assert.equal(jobs.get(j.jobId).state,'completed');assert.equal(jobs.get(j.jobId).activityId,'activity');assert.equal(calls,1);
  const bad=new Jobs(async()=>{throw Error('uncertain');});const b=bad.start({op:{operationId:'test'}});await new Promise(r=>setImmediate(r));assert.equal(bad.get(b.jobId).state,'failed');
});
test('HTTPS trust, no redirects, streaming done/errors and truncated stream',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'arcane-mcp-test-'));
  const key=path.join(dir,'key.pem'),cert=path.join(dir,'cert.pem');
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost'],{stdio:'ignore'});
  let calls=0;
  const server=https.createServer({key:fs.readFileSync(key),cert:fs.readFileSync(cert)},(req,res)=>{
    calls++; assert.equal(req.headers['x-api-key'],'test-key');
    if(req.url==='/redirect'){res.writeHead(302,{location:'https://example.com/steal'});res.end();}
    else if(req.url==='/error'){res.writeHead(200);res.end('{"error":"failed"}\n');}
    else if(req.url==='/truncated'){res.writeHead(200);res.end('{"activityId":"a"}\n');}
    else if(req.url==='/stream'){res.writeHead(200);res.write('{"activityId":"a"}\n{"log":"ok"}\n{"done":true}\n');}
    else if(req.url==='/fail'){res.writeHead(200);res.end('{"success":false}');}
    else{res.writeHead(200);res.end('{"data":{"name":"test","apiKey":"secret"}}');}
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>{server.closeAllConnections();server.close();fs.rmSync(dir,{recursive:true,force:true});});
  const cfg={url:`https://localhost:${server.address().port}`,connectAddress:'127.0.0.1',ca:fs.readFileSync(cert),key:'test-key'};
  const call=(route,streaming=false)=>request(cfg,{op:{method:'GET'},route,streaming});
  assert.equal((await call('/ok')).data.apiKey,'[REDACTED]');
  const before=calls;await assert.rejects(call('/redirect'),/302/);assert.equal(calls,before+1);
  await assert.rejects(request({...cfg,ca:undefined},{op:{method:'GET'},route:'/ok'}),/connection failed/);
  assert.deepEqual(await call('/stream',true),{completed:true});
  await assert.rejects(call('/error',true),/failed/);
  await assert.rejects(call('/truncated',true),/without done/);
  await assert.rejects(call('/fail'),/unsuccessful/);
});

test('create-project uses multipart facade and redacted content cannot be written back',()=>{
 const p=prepare({operationId:'create-project',pathParams:{id:'remote'},body:{name:'example',composeContent:'services: {}'}},false);
 assert.equal(p.op.multipart,true);assert.equal(p.route,'/api/environments/remote/projects');
 assert.throws(()=>prepare({operationId:'update-project',pathParams:{id:'0',projectId:'p'},body:{envContent:'PASSWORD=[REDACTED]'}},false),/masked/);
});

test('Arcane 2.13.1 volume-backup discovery remains an explicit mutation',()=>{
  assert.throws(()=>prepare({operationId:'discover-volume-backups',pathParams:{id:'remote'}},false),/body is required/);
  assert.throws(()=>prepare({operationId:'discover-volume-backups',pathParams:{id:'remote'},body:{s3DestinationId:1}},false),/string/);
  const p=prepare({operationId:'discover-volume-backups',pathParams:{id:'remote'},body:{s3DestinationId:'destination'}},false);
  assert.equal(p.route,'/api/environments/remote/volumes/backups/discover');
  assert.equal(p.op.readOnly,false);
});

test('drift flags changed write contracts, not version-only releases',()=>{
  const live=structuredClone(approved);live.info.version='2.99.0';
  try {
    let d=drift(installSchema(live));
    assert.equal(d.versionChanged,true);assert.equal(d.needsReview,false);
    live.paths['/environments/{id}/containers/{containerId}/restart'].post.parameters.push({in:'query',name:'newOption',schema:{type:'boolean'}});
    d=drift(installSchema(live));
    assert.equal(d.needsReview,true);assert(d.blockedMutations.includes('restart-container'));
  } finally {installSchema(approved);}
});
