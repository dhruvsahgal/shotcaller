import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../app/store.mjs';

const scope = {
  dataset: 'team_roster', league_id: 'league-1', season: '2026', team_id: 'team-a', matchup_id: null,
  scoring_period: { kind: 'date', key: '2026-11-14', timezone: 'America/Los_Angeles' },
  value_basis: { value: 'actual', aggregation: 'snapshot' }
};

test('run intents and terminal attempts are immutable, idempotent, and restart safe', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shotcaller-runs-'));
  const store = new Store(root);
  const run = {
    id: 'run-league-1-roster-2026-11-14', job_id: 'roster-collector', idempotency_key: 'league-1:team-a:2026-11-14',
    automation_id: 'automation-1', thread_id: 'thread-1', scope, intended_for: '2026-11-14T14:00:00Z',
    created_at: '2026-11-14T13:59:00Z', budget: { unit: 'box_minutes', limit: 15 }
  };
  const first = await store.saveRun(run);
  assert.deepEqual(await store.saveRun(structuredClone(run)), first);
  await assert.rejects(store.saveRun({ ...run, budget: { unit: 'box_minutes', limit: 30 } }), /Immutable record conflict/);

  const attempt = {
    id: 'attempt-league-1-roster-1', run_id: run.id, started_at: '2026-11-14T14:00:00Z',
    finished_at: '2026-11-14T14:03:00Z', outcome: 'complete', artifact_ids: ['observation-roster-a']
  };
  const savedAttempt = await store.saveRunAttempt(attempt);
  assert.deepEqual(await store.saveRunAttempt(structuredClone(attempt)), savedAttempt);
  await assert.rejects(store.saveRunAttempt({ ...attempt, outcome: 'failed' }), /Immutable record conflict/);

  const restarted = new Store(root);
  assert.deepEqual((await restarted.list('runs')).map(record => record.id), [run.id]);
  assert.deepEqual((await restarted.list('attempts')).map(record => record.id), [attempt.id]);
  assert.equal((await restarted.read(attempt.id, 'attempts')).run_id, run.id);
});

test('attempts require a saved run and a terminal outcome', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shotcaller-run-validation-'));
  const store = new Store(root);
  await assert.rejects(store.saveRunAttempt({
    id: 'attempt-orphan', run_id: 'run-missing', started_at: '2026-11-14T14:00:00Z',
    finished_at: '2026-11-14T14:01:00Z', outcome: 'complete', artifact_ids: []
  }), /run/i);
  await assert.rejects(store.saveRun({ id: 'run-invalid' }), /Invalid (?:run|job)/);
});

test('run timestamps require real RFC3339 instants with offsets', async () => {
  const store = new Store(await mkdtemp(join(tmpdir(), 'shotcaller-run-times-')));
  const run = {
    id: 'run-invalid-time', job_id: 'roster-collector', idempotency_key: 'invalid-time',
    scope, intended_for: '2026-02-30T14:00:00Z', created_at: '2026-11-14T13:59:00Z',
    budget: { unit: 'box_minutes', limit: 15 }
  };
  await assert.rejects(store.saveRun(run), /Invalid run intended time/);
  await assert.rejects(store.saveRun({ ...run, intended_for: '2026-11-14T14:00:00' }), /Invalid run intended time/);
});
