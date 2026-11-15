import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, digest } from '../app/store.mjs';

const hash = value => digest(value);
const scope = (dataset = 'team_roster') => ({
  dataset, league_id: 'league-1', season: '2026', team_id: dataset === 'team_roster' ? 'team-a' : null, matchup_id: null,
  scoring_period: { kind: dataset === 'team_roster' ? 'date' : 'week', key: dataset === 'team_roster' ? '2026-11-14' : '4', timezone: 'America/Los_Angeles' },
  value_basis: { value: 'actual', aggregation: 'snapshot' }
});
const observation = (id, observedAt, dataset = 'team_roster', coverage = 'complete') => ({
  id, source: { id: `source-${id}`, hash: hash(id.at(-1) || 'a') }, observed_at: observedAt,
  observed_at_precision: 'instant', scope: scope(dataset), coverage: { status: coverage, note: `${coverage} fixture` },
  parser_version: 'fixture-1', data: { rows: [{ id }] }, links: { evidence: [`source-${id}`] }
});

test('older evidence and partial datasets cannot replace a newer complete scoped pointer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shotcaller-observations-'));
  const store = new Store(root);
  const newer = await store.saveObservation(observation('observation-new', '2026-11-14T12:00:00Z'));
  await store.saveObservation(observation('observation-old', '2026-11-13T12:00:00Z'));
  assert.equal((await store.completeObservation(scope())).id, newer.id);

  const marketComplete = await store.saveObservation(observation('observation-market-complete', '2026-11-14T12:00:00Z', 'market_availability'));
  const marketPartial = await store.saveObservation(observation('observation-market-partial', '2026-11-14T13:00:00Z', 'market_availability', 'partial'));
  assert.equal((await store.completeObservation(scope('market_availability'))).id, marketComplete.id);
  const current = await store.currentObservations();
  assert.deepEqual(new Set(current.map(record => record.id)), new Set([newer.id, marketPartial.id]));
  assert.equal(current.some(record => record.id === 'observation-old'), false);
});

test('corrections retain original bytes and retries reject conflicting content', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shotcaller-corrections-'));
  const store = new Store(root);
  const originalInput = observation('observation-original', '2026-11-14T12:00:00Z');
  const original = await store.saveObservation(originalInput);
  const path = join(root, 'observations', original.id, 'snapshot.json');
  const before = await readFile(path);
  const correctionInput = { ...observation('observation-correction', '2026-11-14T12:05:00Z'), correction_of: original.id };
  const correction = await store.saveObservation(correctionInput);
  assert.equal(correction.correction_of, original.id);
  assert.deepEqual(await readFile(path), before);
  assert.deepEqual(await store.saveObservation(structuredClone(correctionInput)), correction);
  await assert.rejects(store.saveObservation({ ...correctionInput, data: { rows: [] } }), /Immutable record conflict/);
});

test('the complete index is rebuildable and produces the same scoped view after restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shotcaller-observation-index-'));
  const store = new Store(root);
  await store.saveObservation(observation('observation-first', '2026-11-13T12:00:00Z'));
  await store.saveObservation(observation('observation-second', '2026-11-14T12:00:00Z'));
  const before = await store.observationIndex();
  await rm(join(root, 'indexes', 'complete-observations.json'));
  const restarted = new Store(root);
  const rebuilt = await restarted.rebuildObservationIndex();
  assert.deepEqual(rebuilt, before);
  assert.equal((await restarted.completeObservation(scope())).id, 'observation-second');
});

test('unknown source time stays null and never outranks dated evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shotcaller-unknown-observation-time-'));
  const store = new Store(root);
  const dated = await store.saveObservation(observation('observation-dated', '2026-11-14T12:00:00Z'));
  const unknown = observation('observation-unknown', '2026-11-15T12:00:00Z');
  unknown.observed_at = null;
  unknown.observed_at_precision = 'unknown';
  const saved = await store.saveObservation(unknown);
  assert.equal(saved.observed_at, null);
  assert.equal((await store.completeObservation(scope())).id, dated.id);
});

test('observation times reject impossible dates and offset-free instants', async () => {
  const store = new Store(await mkdtemp(join(tmpdir(), 'shotcaller-observation-times-')));
  await assert.rejects(store.saveObservation(observation('observation-impossible', '2026-02-30T12:00:00Z')), /Invalid observation time/);
  await assert.rejects(store.saveObservation(observation('observation-local', '2026-11-14T12:00:00')), /Invalid observation time/);
  const dated = observation('observation-date', '2026-11-14T12:00:00Z');
  dated.observed_at = '2026-11-14';
  dated.observed_at_precision = 'date';
  assert.equal((await store.saveObservation(dated)).observed_at, '2026-11-14');
});
