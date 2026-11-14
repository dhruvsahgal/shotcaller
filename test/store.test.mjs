import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../app/store.mjs';
import { buildForecast } from '../app/forecast.mjs';

const statline = pts => ({ fgm: 1, fga: 2, ftm: 1, fta: 1, three_pm: 1, pts, oreb: 1, reb: 2, ast: 1, stl: 1, blk: 0 });
const replayableForecast = (pts = 5) => buildForecast({
  schema_version: 1, kind: 'forecast_input', league_id: '12345', season: '2026', week: 4,
  as_of: '2026-11-14T00:00:00Z', scoring_timezone: 'America/Los_Angeles', expected_teams: 2,
  period: { start_date: '2026-11-09', end_date: '2026-11-15' }, source_snapshot_ids: ['capture-1'], roster_slots: ['PG'],
  matchups: [{ id: 'm1', team_ids: ['a', 'b'] }], teams: ['a', 'b'].map((id, index) => ({
    id, name: id.toUpperCase(), actual: { stats: { ...statline(0), fgm: 0, fga: 0, ftm: 0, fta: 0, three_pm: 0, oreb: 0, reb: 0, ast: 0, stl: 0 }, source_ids: ['capture-1'] },
    players: [{ id: `${id}1`, name: `${id}1`, eligible_positions: ['PG'], baseline: statline(pts - index), availability: { status: 'available', observed_at: '2026-11-14T00:00:00Z', source_ids: ['capture-1'] }, games: [{ starts_at: '2026-11-15T03:00:00Z', source_ids: ['capture-1'] }] }]
  }))
});

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

test('forecasts are immutable records in their own Railway volume folder', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shotcaller-forecast-store-'));
  const store = new Store(root);
  const forecast = replayableForecast();
  const saved = await store.saveForecast(forecast);
  assert.equal((await store.list('forecasts')).length, 1);
  const restored = await new Store(root).latestForecast();
  assert.equal(restored.kind, 'league_forecast');
  assert.deepEqual(restored.forecast.input, forecast.input);
  assert.equal(restored.forecast.input_hash, forecast.input_hash);
  assert.equal(restored.forecast.algorithm_version, forecast.algorithm_version);
  assert.deepEqual(restored.forecast.teams, forecast.teams);
  await assert.rejects(store.saveForecast({ input_hash: 'a'.repeat(64), status: 'complete', source_snapshot_ids: ['capture-1'] }), /Invalid forecast/);
  await assert.rejects(store.saveForecast({ ...forecast, input_hash: 'a'.repeat(64) }), /Invalid forecast/);
  await assert.rejects(store.saveForecast({ ...forecast, source_snapshot_ids: ['capture-2'] }), /Invalid forecast/);
});

test('a revised forecast appends history and survives a store restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shotcaller-forecast-history-'));
  const store = new Store(root);
  const first = await store.saveForecast(replayableForecast(5));
  const second = await store.saveForecast(replayableForecast(6));
  const history = await new Store(root).list('forecasts');
  assert.equal(history.length, 2);
  assert.ok(history.some(record => record.id === first.id));
  assert.ok(history.some(record => record.id === second.id));
  const recent = await new Store(root).recent('forecasts', 1);
  assert.equal(recent.length, 1);
  assert.equal(recent[0].id, second.id);
});
