import { readFile, readdir } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import { digest } from '../app/store.mjs';

const destination = process.env.SHOTCALLER_URL;
const token = process.env.APP_TOKEN;
if (!destination || !token || token.length < 24) throw new Error('Set SHOTCALLER_URL and APP_TOKEN for the private destination.');
const url = new URL('/api/import', destination);
if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('Use HTTPS for remote imports.');
const root = resolve(process.argv[2] || '.');
const payloads = [];
async function get(path) {
  const response = await fetch(new URL(path, destination), {headers:{Authorization:`Bearer ${token}`},redirect:'error',signal:AbortSignal.timeout(30000)});
  if (!response.ok) throw new Error(`Destination read failed (${response.status})`);
  return response.json();
}
async function files(folder, suffix) {
  try { return (await readdir(resolve(root, folder))).filter(f=>f.endsWith(suffix)).sort().map(f=>`${folder}/${f}`); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}
for (const path of await files('data/snapshots', '.json')) payloads.push(JSON.parse(await readFile(resolve(root,path),'utf8')));
const documents = [];
for (const folder of ['reports','knowledge','sources']) {
  for (const path of await files(folder,'.md')) {
    const content = await readFile(resolve(root,path),'utf8');
    documents.push({path,title:content.match(/^# (.+)$/m)?.[1] || basename(path),content});
  }
}
for (const path of ['SYSTEM_DESIGN.md','RESEARCH_WORKFLOW.md','LEAGUE_STRATEGY.md']) {
  try { const content=await readFile(resolve(root,path),'utf8'); documents.push({path,title:content.match(/^# (.+)$/m)?.[1] || path,content}); }
  catch(e) {if(e.code !== 'ENOENT') throw e;}
}
if (documents.length) {
  const state = await get('/api/state');
  const candidates = state.snapshots.filter(s=>s.kind==='collected_documents').sort((a,b)=>(b.stored_at || '').localeCompare(a.stored_at || '') || String(a.id).localeCompare(String(b.id)));
  let previous = null;
  for (const candidate of candidates) {
    const record = await get(`/api/snapshots/${encodeURIComponent(candidate.id)}`);
    if (record.payload?.source?.type === 'local_notebook_archive') { previous=record; break; }
  }
  if (digest(previous?.payload?.documents ?? []) !== digest(documents)) {
    const bundle = {kind:'collected_documents',source:{type:'local_notebook_archive',captured_at:null,previous_record_id:previous?.id ?? null},coverage:{warning:'Original dated notes preserved as written. May contain superseded states; not a fresh observation. Some older chat screenshots remain outside this archive.'},documents};
    payloads.push({schema_version:1,snapshot_id:`notebook-${digest(bundle).slice(0,20)}`,...bundle});
  }
}
for (const path of await files('sources', '.png')) {
  const bytes = await readFile(resolve(root,path));
  if (bytes.subarray(0,8).toString('hex') !== '89504e470d0a1a0a') throw new Error(`Expected PNG: ${path}`);
  const payload = {kind:'source_image',source:{type:'archived_user_screenshot',captured_at:null},original_path:path,mime_type:'image/png',image_base64:bytes.toString('base64')};
  payloads.push({schema_version:1,snapshot_id:`image-${digest(payload).slice(0,20)}`,...payload});
}
let count=0;
for (const payload of payloads) {
  const body=JSON.stringify(payload);
  if(Buffer.byteLength(body)>1048576) throw new Error(`Snapshot exceeds import limit: ${payload.snapshot_id}`);
  const response = await fetch(url,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body,redirect:'error',signal:AbortSignal.timeout(30000)});
  if(!response.ok) throw new Error(`Import failed (${response.status}): ${payload.snapshot_id}`);
  const record=await response.json(); console.log(`${payload.snapshot_id} → ${record.id}`); count++;
}
console.log(`${count} evidence records synchronized; duplicate content is idempotent. ${documents.length} notebook documents included. No Yahoo actions or model calls.`);
