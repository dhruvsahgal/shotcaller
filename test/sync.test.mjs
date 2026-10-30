import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createApp } from '../app/server.mjs';
import { configuration } from '../app/config.mjs';
import { Store } from '../app/store.mjs';

function run(root, url, token) {
  return new Promise((resolveRun,reject)=>{
    const child=spawn(process.execPath,[resolve('scripts/sync-evidence.mjs'),root],{env:{...process.env,SHOTCALLER_URL:url,APP_TOKEN:token}});
    let output=''; child.stdout.on('data',b=>output+=b); child.stderr.on('data',b=>output+=b);
    child.on('error',reject); child.on('exit',code=>resolveRun({code,output}));
  });
}
test('private sync preserves files and A→B→A notebook revisions; retries do not duplicate evidence',async()=>{
  const root=await mkdtemp(join(tmpdir(),'shotcaller-sync-')), token='synthetic-access-token-at-least-24-characters';
  for(const dir of ['data/snapshots','knowledge','sources']) await mkdir(join(root,dir),{recursive:true});
  await writeFile(join(root,'data/snapshots/example.json'),JSON.stringify({snapshot_id:'synthetic',source:{type:'test'},teams:[]}));
  await writeFile(join(root,'sources/example.png'),Buffer.from('89504e470d0a1a0a','hex'));
  const note=join(root,'knowledge/example.md'); await writeFile(note,'# Example\nA');
  const store=new Store(join(root,'store'));
  const app=await createApp({...configuration(),dataDir:store.root,token},{store});
  await new Promise(r=>app.listen(0,'127.0.0.1',r));
  const url=`http://127.0.0.1:${app.address().port}`;
  try {
    for(const [text,expected] of [['A',3],['B',4],['A',5],['A',5]]) {
      await writeFile(note,`# Example\n${text}`);
      const result=await run(root,url,token); assert.equal(result.code,0,result.output); assert.equal(result.output.includes(token),false);
      const state=await (await fetch(`${url}/api/state`,{headers:{Authorization:`Bearer ${token}`}})).json();
      assert.equal(state.snapshots.length,expected);
      assert.equal(state.overview.documents[0].content,`# Example\n${text}`);
      assert.equal(state.overview.documents[0].meta.observed_at,null);
    }
    const images=(await store.list()).filter(r=>r.payload.kind==='source_image');
    assert.equal(Buffer.from(images[0].payload.image_base64,'base64').toString('hex'),'89504e470d0a1a0a');
  } finally {await new Promise(r=>app.close(r));}
});
test('sync stops on destination failure without exposing its access token',async()=>{
  const root=await mkdtemp(join(tmpdir(),'shotcaller-sync-failure-'));
  await mkdir(join(root,'data/snapshots'),{recursive:true});
  for(const id of ['a','b']) await writeFile(join(root,`data/snapshots/${id}.json`),JSON.stringify({snapshot_id:id,source:{type:'test'}}));
  let requests=0; const app=createServer((req,res)=>{requests++;res.writeHead(503);res.end('{}');});
  await new Promise(r=>app.listen(0,'127.0.0.1',r));
  try {
    const token='synthetic-access-token-at-least-24-characters';
    const result=await run(root,`http://127.0.0.1:${app.address().port}`,token);
    assert.notEqual(result.code,0);assert.equal(requests,1);assert.match(result.output,/Import failed \(503\)/);assert.equal(result.output.includes(token),false);
  } finally {await new Promise(r=>app.close(r));}
});
