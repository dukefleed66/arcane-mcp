import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import {execFileSync} from 'node:child_process';
import {refreshCatalog,catalogStatus,installSchema,spec,loadConfig} from '../src/core.mjs';
import {audit} from '../src/audit.mjs';
const approved=structuredClone(spec);

// Fake Arcane on loopback: a bad container, a clean one, an unreadable one and a local build.
async function fakeArcane(t,routes) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'arcane-audit-test-'));
  const key=path.join(dir,'key.pem'),cert=path.join(dir,'cert.pem');
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost'],{stdio:'ignore'});
  const server=https.createServer({key:fs.readFileSync(key),cert:fs.readFileSync(cert)},(req,res)=>{
    const [code,body]=routes(req.url);res.writeHead(code);res.end(JSON.stringify(body));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>{server.closeAllConnections();server.close();fs.rmSync(dir,{recursive:true,force:true});installSchema(approved);});
  return {url:`https://localhost:${server.address().port}`,connectAddress:'127.0.0.1',ca:fs.readFileSync(cert),key:'test-key'};
}
const c=(id,names,extra={})=>({id,names:[names],image:'nginx:1.27',state:'running',status:'Up 1 hour (healthy)',mounts:[],hostConfig:{networkMode:'bridge',privileged:false},...extra});

test('audit ranks findings, downgrades local builds, honours ignore and survives a failed lookup',async t=>{
  const list=[
    c('a'.repeat(12),'bad',{image:'nginx:latest',status:'Up 1 hour',mounts:[{source:'/var/run/docker.sock'}],hostConfig:{networkMode:'host',privileged:true}}),
    c('b'.repeat(12),'good'),
    c('c'.repeat(12),'broken'),
    c('d'.repeat(12),'local',{image:'registry.local/x:1',status:'Up 1 hour'}),
    c('e'.repeat(12),'skipped',{state:'exited',status:'Exited'})];
  const cfg=await fakeArcane(t,url=>{
    if(url.startsWith('/api/environments/0/containers?')) return [200,{success:true,data:list,pagination:{totalItems:6}}];
    if(url.includes('/containers/'+'c'.repeat(12))) return [500,{}];
    if(url.includes('/containers/')) return [200,{success:true,data:{hostConfig:{restartPolicy:'unless-stopped'}}}];
    if(url.endsWith('get-update-summary')||url.includes('image-updates')) return [200,{data:{imagesWithUpdates:0}}];
    if(url.includes('vulnerabilities')) return [200,{data:{totalImages:2,scannedImages:1,summary:{critical:1}}}];
    if(url.includes('/volumes')) return [200,{counts:{unused:0}}];
    return [404,{}];
  });
  await refreshCatalog(cfg,true).catch(()=>{}); // fake serves no schema; bundled baseline is used
  const r=await audit({...cfg,localImagePrefixes:['registry.local/']},'0',['skipped']);
  const has=(sev,container,re)=>r.findings.some(f=>f.severity===sev&&f.container===container&&re.test(f.issue));
  assert.equal(r.environmentId,'0');
  assert(has('high','bad',/privileged/));assert(has('high','bad',/docker\.sock/));assert(has('medium','bad',/host network/));
  assert(has('medium','bad',/unpinned/));assert(has('low','bad',/no healthcheck/));
  assert(has('info','local',/locally built/));
  assert(has('low','broken',/could not read/));
  assert(has('low','-',/only 5\/6 containers/));assert(has('high','-',/critical/));
  assert(!r.findings.some(f=>f.container==='skipped'||f.container==='good'));
  assert.deepEqual(r.findings.map(f=>f.severity),[...r.findings.map(f=>f.severity)].sort((x,y)=>({high:0,medium:1,low:2,info:3}[x]-{high:0,medium:1,low:2,info:3}[y])));
});

test('a failed refresh keeps reads on the last good catalog but still blocks writes',async t=>{
  let fail=false;
  const live=structuredClone(approved);
  const cfg=await fakeArcane(t,url=>url==='/api/openapi.json'?(fail?[503,{}]:[200,live]):[404,{}]);
  await refreshCatalog(cfg,true);assert.equal(catalogStatus.verified,true);
  fail=true;
  await assert.rejects(refreshCatalog(cfg,true),/mutations are disabled/); // a write: must fail
  assert.equal(catalogStatus.verified,false);
  assert.equal(await refreshCatalog(cfg,false),catalogStatus); // a read: keeps the last good catalog
});

test('config expands ~ and rejects a malformed localImagePrefixes',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'arcane-cfg-test-'));
  const key=path.join(dir,'key');fs.writeFileSync(key,'k',{mode:0o600});
  const file=path.join(dir,'config.json');
  const prev=process.env.ARCANE_CONFIG;process.env.ARCANE_CONFIG=file;
  try {
    fs.writeFileSync(file,JSON.stringify({url:'https://arcane.example.com',apiKeyFile:key,localImagePrefixes:'oops'}));
    assert.throws(()=>loadConfig(),/localImagePrefixes/);
    fs.writeFileSync(file,JSON.stringify({url:'https://arcane.example.com',apiKeyFile:key,caFile:'~/does-not-matter'}));
    assert.throws(()=>loadConfig(),new RegExp(os.homedir().replace(/[\\/]/g,'.')+'.does-not-matter'));
  } finally {process.env.ARCANE_CONFIG=prev;if(prev===undefined)delete process.env.ARCANE_CONFIG;fs.rmSync(dir,{recursive:true,force:true});}
});
