import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import { createApp } from '../server.js';
async function listen(server) { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return `http://127.0.0.1:${server.address().port}`; }
async function close(server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
test('local logs, Git comparison, agent drafts and persistence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fixlog-test-'));
  let app, agent, captured;
  try {
    const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
    git('init','-q'); git('config','user.name','FixLog Test'); git('config','user.email','test@example.invalid');
    await writeFile(join(dir,'users.js'),'export const render = users => users.map(String);\n'); git('add','.'); git('commit','-qm','before'); const baseSha = git('rev-parse','HEAD');
    await writeFile(join(dir,'users.js'),'export const render = users => (users ?? []).map(String);\n'); git('commit','-qam','fix null handling'); const headSha = git('rev-parse','HEAD');
    let mode = 'valid';
    agent = http.createServer(async (req,res) => { let body=''; for await (const chunk of req) body+=chunk; captured=JSON.parse(body); res.setHeader('Content-Type','application/json'); res.end(JSON.stringify(mode === 'invalid' ? {fixes:[{error:'bad'}]} : { fixes:[{error:'Inferred null access',file:'users.js',rootCause:'Inferred missing null guard',fixSummary:'Use an empty array fallback',evidence:'Added ?? []',similarMatch:[]}] })); });
    const agentUrl = await listen(agent); const dataFile = join(dir,'data','logs.json');
    app = await createApp({repoPath:dir,dataFile,agentUrl}); let url = await listen(app);
    async function request(path, method='GET', body) { const response = await fetch(url+path,{method,headers:{'Content-Type':'application/json'},...(body ? {body:JSON.stringify(body)} : {})}); return {status:response.status,body:await response.json()}; }
    assert.deepEqual((await request('/api/logs')).body, []);
    assert.equal((await request('/api/logs','POST',{})).status,400);
    const input={error:'Null access',file:'users.js',rootCause:'Missing guard',fixSummary:'Add fallback',similarMatch:[]};
    const created=await request('/api/logs','POST',input); assert.equal(created.status,201);
    const updated=await request(`/api/logs/${created.body.errorId}`,'PUT',{...created.body,fixSummary:'Edited fix',reviewed:true}); assert.equal(updated.body.fixSummary,'Edited fix');
    const writes=await Promise.all(Array.from({length:5},()=>request('/api/logs','POST',input))); assert.ok(writes.every(r=>r.status===201)); assert.equal((await request('/api/logs')).body.length,6);
    assert.equal((await request('/api/logs','POST',{...input,similarMatch:[{errorId:'missing',score:99}]})).status,400);
    const diff=await request('/api/compare','POST',{baseSha,headSha}); assert.equal(diff.status,200); assert.match(diff.body.diff,/\+export.*\?\? \[\]/); assert.deepEqual(diff.body.files,['users.js']);
    assert.equal((await request('/api/compare','POST',{baseSha:'--help',headSha})).status,400);
    assert.equal((await request('/api/compare','POST',{baseSha:'abcdef0',headSha})).status,422);
    const analyzed=await request('/api/analyze','POST',{baseSha,headSha}); assert.equal(analyzed.status,200); assert.equal(analyzed.body.drafts[0].reviewed,false); assert.equal(analyzed.body.drafts[0].commitSha,headSha); assert.equal(captured.previousFixes.length,6); assert.equal((await request('/api/logs')).body.length,6);
    assert.deepEqual((await request('/api/analyze','POST',{baseSha,headSha:baseSha})).body.drafts,[]);
    mode='invalid'; assert.equal((await request('/api/analyze','POST',{baseSha,headSha})).status,502);
    assert.equal((await fetch(url+'/api/logs',{headers:{Origin:'https://unrelated.example'}})).status,403);
    assert.equal((await fetch(url+'/.env')).status,404);
    assert.equal((await fetch(url+'/api.html')).status,200);
    assert.equal(JSON.parse(await readFile(dataFile,'utf8')).length,6);
    await close(app); app=await createApp({repoPath:dir,dataFile,agentUrl:''}); url=await listen(app);
    assert.equal((await request('/api/logs')).body.length,6);
    assert.equal((await request('/api/analyze','POST',{baseSha,headSha})).status,503);
  } finally { if(app) await close(app); if(agent) await close(agent); await rm(dir,{recursive:true,force:true}); }
});
