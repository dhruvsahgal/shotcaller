import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../app/server.mjs';
import { configuration } from '../app/config.mjs';
test('API protects private evidence and handles a failed refresh without fake success', async () => {
  const config = { ...configuration(), dataDir: await mkdtemp(join(tmpdir(), 'shotcaller-api-')), token: 'test-access-token-at-least-24-characters' };
  const app = await createApp(config, { collect: async () => { throw new Error('Yahoo login required. Run npm run login'); } });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  const headers = { Authorization: `Bearer ${config.token}` };
  try {
    assert.equal((await fetch(`${base}/api/state`)).status, 401);
    assert.equal((await fetch(`${base}/api/refresh`, { method: 'POST' })).status, 401);
    assert.equal((await fetch(`${base}/health`)).status, 200);
    const initial = await (await fetch(`${base}/api/state`, { headers })).json();
    assert.equal(initial.prompt.ready, true);
    assert.equal(initial.latest_id, null);
    assert.equal(initial.overview.matchup, null);
    const imported = await fetch(`${base}/api/import`, {method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({snapshot_id:'manual-matchup',kind:'matchup_weekly_category_totals',week:2,observed_date:'2026-10-30',source:{type:'synthetic'},teams:[{name:'A',stats:{pts:100}},{name:'B',stats:{pts:90}}]})});
    assert.equal(imported.status,201);
    const updated = await (await fetch(`${base}/api/state`,{headers})).json();
    assert.equal(updated.overview.matchup.teams[0].stats.pts,100);
    assert.equal(updated.overview.matchup.meta.observed_at,'2026-10-30');
    assert.equal(updated.latest_id,null);
    const importPayload=payload=>fetch(`${base}/api/import`,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify(payload)});
    assert.equal((await importPayload({snapshot_id:'bad-documents',source:{type:'test'},kind:'collected_documents',documents:{wrong:true}})).status,400);
    assert.equal((await importPayload({snapshot_id:'large-archive',source:{type:'test'},note:'x'.repeat(600000)})).status,201);
    assert.equal((await importPayload({snapshot_id:'oversized',source:{type:'test'},note:'x'.repeat(1048576)})).status,400);
    assert.equal((await (await fetch(`${base}/api/state`,{headers})).json()).snapshots.length,2);
    assert.equal(JSON.stringify(initial).includes(config.token), false);
    assert.equal((await fetch(`${base}/api/refresh`, { method: 'POST', headers })).status, 202);
    let final;
    for (let i = 0; i < 20; i++) { final = await (await fetch(`${base}/api/state`, { headers })).json(); if (final.refresh.status === 'failed') break; await new Promise(r => setTimeout(r, 10)); }
    assert.equal(final.refresh.status, 'failed');
    assert.equal(final.latest_id, null);
    assert.equal((await fetch(`${base}/api/snapshots/%2e%2e%2fsecret`, { headers })).status, 400);
  } finally { await new Promise(resolve => app.close(resolve)); }
});
