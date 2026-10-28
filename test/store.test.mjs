import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../app/store.mjs';

test('immutable history survives restart; partial and imported evidence never replace current', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shotcaller-store-'));
  const store = new Store(root);
  const first = await store.saveCapture({ league_id: '12345', observed_at: '2026-10-28T12:00:00Z', status: 'complete', pages: [], warnings: [] });
  await store.saveCapture({ league_id: '12345', observed_at: '2026-10-28T13:00:00Z', status: 'partial', pages: [], warnings: ['login'] });
  const source = { snapshot_id: 'old', source: { captured_at: null }, players: [] };
  const a = await store.importHistorical(source);
  const b = await store.importHistorical(source);
  assert.equal(a.id, b.id);
  const restarted = new Store(root);
  assert.equal((await restarted.latest()).id, first.id);
  assert.equal((await restarted.list()).length, 3);
  assert.equal((await restarted.read(a.id)).payload.source.captured_at, null);
  assert.equal(JSON.parse(await readFile(join(root, 'snapshots', first.id, 'snapshot.json'))).id, first.id);
  await assert.rejects(store.read('../secret'), /identifier/);
});
