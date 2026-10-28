import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configuration } from '../app/config.mjs';
import { createApp } from '../app/server.mjs';

test('cloud setup persists privately, rejects unsafe sessions, and preserves league identity', async () => {
  const config = { ...configuration(), dataDir: await mkdtemp(join(tmpdir(), 'shotcaller-setup-')), token: 'setup-test-token-at-least-24-characters' };
  const secret = 'test-provider-secret-not-a-real-key';
  let app, base;
  const start = async () => {
    app = await createApp({ ...config });
    await new Promise(r => app.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${app.address().port}`;
  };
  const request = (path, data, auth = true) => fetch(`${base}/api/${path}`, { method: data ? 'POST' : 'GET', headers: { ...(auth ? { Authorization: `Bearer ${config.token}` } : {}), 'Content-Type': 'application/json' }, ...(data ? { body: JSON.stringify(data) } : {}) });
  await start();
  try {
    assert.equal((await request('setup', null, false)).status, 401);
    assert.equal((await request('setup', { apiKey: secret }, false)).status, 401);
    assert.equal((await request('setup', { leagueId: '12345', model: 'example-model', apiKey: secret })).status, 200);
    assert.equal((await request('setup', { token: 'overwrite-access-token' })).status, 400);
    assert.equal((await request('setup', { endpoint: 'http://localhost:8080' })).status, 400);
    assert.equal((await request('setup', { endpoint: 'https://example.com/v1/chat/completions?api_key=secret' })).status, 400);
    const session = { cookies: [{ name: 'test', value: 'private-yahoo-session', domain: '.yahoo.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' }], origins: [] };
    assert.equal((await request('setup/yahoo', session, false)).status, 401);
    assert.equal((await request('setup/yahoo', session)).status, 200);
    assert.equal((await request('setup/yahoo', { ...session, cookies: [{ ...session.cookies[0], domain: 'yahoo.com.attacker.test' }] })).status, 400);
    assert.equal(JSON.parse(await readFile(join(config.dataDir, 'auth/yahoo.json'), 'utf8')).cookies[0].domain, '.yahoo.com');
    assert.equal((await stat(join(config.dataDir, 'settings.json'))).mode & 0o777, 0o600);
    assert.equal((await stat(join(config.dataDir, 'auth/yahoo.json'))).mode & 0o777, 0o600);
    const historical = { snapshot_id: 'setup-test', source: { type: 'test' }, teams: [] };
    const first = await (await request('import', historical)).json();
    assert.equal((await (await request('import', historical)).json()).id, first.id);
    assert.equal((await request('setup', { leagueId: '999' })).status, 400);
    await new Promise(r => app.close(r));
    await start();
    const settings = await (await request('setup')).json();
    assert.equal(settings.league_id, '12345');
    assert.equal(settings.model, 'example-model');
    assert.equal(settings.api_key_saved, true);
    assert.equal(settings.yahoo_session_saved, true);
    const state = await (await request('state')).json();
    assert.equal(state.snapshots.length, 1);
    assert.equal(state.latest_id, null);
    assert.equal(state.model_configured, true);
    for (const value of [settings, state]) {
      assert.equal(JSON.stringify(value).includes(secret), false);
      assert.equal(JSON.stringify(value).includes(session.cookies[0].value), false);
    }
  } finally { await new Promise(r => app.close(r)); }
});
