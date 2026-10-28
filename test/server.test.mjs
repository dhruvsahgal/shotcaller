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
    assert.equal(JSON.stringify(initial).includes(config.token), false);
    assert.equal((await fetch(`${base}/api/refresh`, { method: 'POST', headers })).status, 202);
    let final;
    for (let i = 0; i < 20; i++) { final = await (await fetch(`${base}/api/state`, { headers })).json(); if (final.refresh.status === 'failed') break; await new Promise(r => setTimeout(r, 10)); }
    assert.equal(final.refresh.status, 'failed');
    assert.equal(final.latest_id, null);
    assert.equal((await fetch(`${base}/api/snapshots/%2e%2e%2fsecret`, { headers })).status, 400);
  } finally { await new Promise(resolve => app.close(resolve)); }
});
