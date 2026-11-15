import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, cp, mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { CollectorIngest, ingestLimits } from '../app/ingest.mjs';
import { createApp } from '../app/server.mjs';
import { Store } from '../app/store.mjs';
import { harness, bundle, stage } from './helpers/collector-ingest.mjs';
import { fullLeagueBundle, fullLeaguePlanInput } from './helpers/full-league-collector.mjs';

test('bounded artifacts publish one logical dataset across overlap, retry and restart', async () => {
  const h = await harness();
  const a = await stage(h, 'collector-attempt-one'), b = await stage(h, 'collector-attempt-two');
  const [first, duplicate] = await Promise.all([h.ingest.commit(a.capability), h.ingest.commit(b.capability)]);
  assert.deepEqual([first.duplicate, duplicate.duplicate].sort(), [false, true]);
  assert.equal(first.observation_id, duplicate.observation_id);
  assert.equal((await h.store.list('observations')).length, 1);
  assert.equal((await h.store.list('attempts')).length, 2);
  const restarted = new CollectorIngest(h.config, h.store, h.options);
  assert.deepEqual(await restarted.commit(await restarted.authenticate(a.capability.token)), first);
  const readback = await restarted.readback(a.capability);
  assert.deepEqual(readback.artifacts, first.artifacts);
  assert.equal(readback.status, 'complete');
  assert.equal(await restarted.authenticate('forged'), null);
  h.advance(ingestLimits.capability_ms);
  assert.equal(await restarted.authenticate(a.capability.token), null);
});

test('manifest rejects cross-run identities, paths, artifact limits and tampered hashes', async () => {
  const h = await harness();
  const cap = await h.ingest.mint({ run_id: h.run.id, attempt_id: 'collector-validate' });
  const { manifest, files } = await bundle(h.run, cap.attempt_id);
  for (const patch of [{ league_id: 'other' }, { run_id: 'other' }, { attempt_id: 'other' }, { idempotency_key: 'other' }, { actions: [] }]) await assert.rejects(h.ingest.manifest(cap, { ...manifest, ...patch }), /Invalid/);
  const oversized = structuredClone(manifest); oversized.artifacts[0].bytes = 9999999;
  await assert.rejects(h.ingest.manifest(cap, oversized), /size/);
  const traversal = structuredClone(manifest); traversal.artifacts[0].evidence_ref = 'evidence/../../.env';
  await assert.rejects(h.ingest.manifest(cap, traversal), /reference/);
  await h.ingest.manifest(cap, manifest);
  await assert.rejects(h.ingest.upload(cap, 'output', Buffer.from('wrong')), /hash/);
  await assert.rejects(h.ingest.commit(cap), /ENOENT/);
  for (const f of files) await h.ingest.upload(cap, f.id, f.bytes);
  const sourceFile = join(h.config.dataDir, 'collector-artifacts', h.ingest.artifactId(cap, 'output'), 'snapshot.json');
  await writeFile(sourceFile, JSON.stringify({ content_base64: Buffer.from('changed').toString('base64') }));
  await assert.rejects(h.ingest.commit(cap), /readback/);
  assert.equal((await h.store.list('observations')).length, 0);
});

test('source reconciliation rejects forged output even with valid uploaded hashes', async () => {
  const h = await harness(); const cap = await h.ingest.mint({ run_id: h.run.id, attempt_id: 'collector-forged' });
  const data = await bundle(h.run, cap.attempt_id);
  const output = JSON.parse(data.files[0].bytes); output.roster[0].name = 'Forged Player';
  data.files[0].bytes = Buffer.from(JSON.stringify(output));
  data.manifest.artifacts[0].bytes = data.files[0].bytes.length;
  data.manifest.artifacts[0].sha256 = createHash('sha256').update(data.files[0].bytes).digest('hex');
  await h.ingest.manifest(cap, data.manifest);
  for (const f of data.files) await h.ingest.upload(cap, f.id, f.bytes);
  await assert.rejects(h.ingest.commit(cap), /reconciliation/);
});

test('source reconciliation rejects relabeled observation time with otherwise valid hashes', async () => {
  const h = await harness(); const cap = await h.ingest.mint({ run_id: h.run.id, attempt_id: 'collector-time-forged' });
  const data = await bundle(h.run, cap.attempt_id);
  const output = JSON.parse(data.files[0].bytes); output.source.observed_at = '2028-01-01T00:00:00Z';
  data.files[0].bytes = Buffer.from(JSON.stringify(output));
  data.manifest.artifacts[0].bytes = data.files[0].bytes.length;
  data.manifest.artifacts[0].sha256 = createHash('sha256').update(data.files[0].bytes).digest('hex');
  await h.ingest.manifest(cap, data.manifest);
  for (const f of data.files) await h.ingest.upload(cap, f.id, f.bytes);
  await assert.rejects(h.ingest.commit(cap), /observation time/);
});

test('commit retry repairs a complete observation pointer after publication/index split', async () => {
  const h = await harness(); const data = await stage(h, 'collector-index-retry');
  const update = h.store.updateCompleteObservationIndex.bind(h.store);
  let fail = true;
  h.store.updateCompleteObservationIndex = async record => {
    if (fail) { fail = false; throw new Error('simulated index interruption'); }
    return update(record);
  };
  await assert.rejects(h.ingest.commit(data.capability), /simulated index interruption/);
  assert.equal((await h.store.list('observations')).length, 1);
  const retried = await h.ingest.commit(data.capability);
  assert.equal(retried.status, 'complete');
  assert.equal((await h.store.completeObservation(h.run.scope)).id, retried.observation_id);
});

test('login output is retained as a terminal alert without publishing a roster', async () => {
  const h = await harness(); const data = await stage(h, 'collector-login', 'login');
  const result = await h.ingest.commit(data.capability);
  assert.equal(result.status, 'needs_login'); assert.equal(result.observation_id, null);
  assert.equal((await h.store.list('observations')).length, 0);
  assert.equal((await h.runs.status()).alerts[0].outcome, 'needs_login');
});

test('isolated volume restore retains records, source hashes and private file modes', async () => {
  const h = await harness(); const data = await stage(h, 'collector-backup');
  const result = await h.ingest.commit(data.capability);
  const restored = await mkdtemp(join(tmpdir(), 'shotcaller-restore-'));
  await cp(h.config.dataDir, restored, { recursive: true });
  const store = new Store(restored);
  const restoredIngest = new CollectorIngest({ ...h.config, dataDir: restored }, store, h.options);
  assert.deepEqual(await restoredIngest.readback(data.capability), await h.ingest.readback(data.capability));
  assert.deepEqual(await store.read(result.observation_id, 'observations'), await h.store.read(result.observation_id, 'observations'));
  assert.equal((await stat(join(restored, 'observations', result.observation_id, 'snapshot.json'))).mode & 0o777, 0o600);
});

test('HTTP capabilities cannot access setup, analysis, actions or other attempt artifacts', async () => {
  const h = await harness();
  const app = await createApp(h.config, { store: h.store, collectorOptions: h.options });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  const request = (path, token, method = 'GET', input) => fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
  try {
    const minted = await request('/api/collector/capabilities', h.config.collectorToken, 'POST', { run_id: h.run.id, attempt_id: 'collector-http' });
    assert.equal(minted.status, 201); const cap = await minted.json();
    for (const token of [cap.token, h.config.collectorToken]) for (const path of ['/api/setup', '/api/state', '/api/decisions', '/api/actions', '/api/collector/run']) assert.equal((await request(path, token, path.includes('decisions') ? 'POST' : 'GET')).status, 401);
    assert.equal((await request('/api/collector/capabilities', cap.token, 'POST', { run_id: h.run.id, attempt_id: 'collector-other' })).status, 401);
    const data = await bundle(h.run, cap.attempt_id);
    assert.equal((await request('/api/collector/manifest', cap.token, 'POST', data.manifest)).status, 201);
    for (const file of data.files) assert.equal((await fetch(`${base}/api/collector/artifacts/${file.id}`, { method: 'PUT', headers: { Authorization: `Bearer ${cap.token}` }, body: file.bytes })).status, 201);
    assert.equal((await request('/api/collector/commit', cap.token, 'POST', {})).status, 200);
    const state = await (await request('/api/state', h.config.token)).json();
    assert.equal(state.overview.observations.scopes.some(entry => entry.scope.dataset === 'team_roster'), true);
    assert.equal((await (await request('/api/collector/readback', cap.token)).json()).status, 'complete');
    assert.equal((await request('/api/collector/artifacts/unknown', cap.token)).status, 400);
    assert.equal((await request('/api/collector/settings', h.config.token, 'POST', { paused: false })).status, 400);
  } finally { await new Promise(resolve => app.close(resolve)); }
});

test('full-league bundle publishes every segment plus a recomputed coverage observation', async () => {
  const h = await harness();
  const run = await h.runs.create({ plan: fullLeaguePlanInput, intended_for: '2026-11-16T10:00:00Z' });
  const attemptId = 'collector-full-league';
  const capability = await h.ingest.mint({ run_id: run.id, attempt_id: attemptId });
  const data = await fullLeagueBundle(run, attemptId);
  await h.ingest.manifest(capability, data.manifest);
  for (const file of data.files) await h.ingest.upload(capability, file.id, file.bytes);
  const result = await h.ingest.commit(capability);
  assert.equal(result.status, 'complete');
  const coverage = await h.store.read(result.observation_id, 'observations');
  assert.equal(coverage.scope.dataset, 'league_coverage');
  assert.equal(coverage.coverage.status, 'complete');
  assert.equal(coverage.data.fragments.length, run.collection_plan.segments.length);
  const observations = await h.store.list('observations');
  assert.equal(observations.filter(record => record.scope.dataset !== 'league_coverage').length, run.collection_plan.segments.length);
  for (const dataset of ['team_roster', 'matchups', 'team_period_stats', 'player_period_stats', 'daily_lineup', 'daily_contributions', 'market', 'transactions']) {
    const representative = observations.find(record => record.scope.dataset === dataset);
    assert.equal((await h.store.completeObservation(representative.scope)).id, representative.id);
  }
  assert.equal((await h.ingest.readback(capability)).status, 'complete');
});

test('full-league commit rejects a forged coverage summary before publishing observations', async () => {
  const h = await harness();
  const run = await h.runs.create({ plan: fullLeaguePlanInput, intended_for: '2026-11-16T10:00:00Z' });
  const attemptId = 'collector-full-league-forged';
  const capability = await h.ingest.mint({ run_id: run.id, attempt_id: attemptId });
  const data = await fullLeagueBundle(run, attemptId);
  const output = JSON.parse(data.files[0].bytes);
  output.coverage_hash = '0'.repeat(64);
  data.files[0].bytes = Buffer.from(JSON.stringify(output));
  data.manifest.artifacts[0].bytes = data.files[0].bytes.length;
  data.manifest.artifacts[0].sha256 = createHash('sha256').update(data.files[0].bytes).digest('hex');
  await h.ingest.manifest(capability, data.manifest);
  for (const file of data.files) await h.ingest.upload(capability, file.id, file.bytes);
  await assert.rejects(h.ingest.commit(capability), /coverage reconciliation/);
  assert.equal((await h.store.list('observations')).length, 0);
});

test('full-league bundle rejects source pages outside the run and impossible future timestamps', async () => {
  const h = await harness();
  const run = await h.runs.create({ plan: fullLeaguePlanInput, intended_for: '2026-11-16T10:00:00Z' });
  for (const [attemptId, mutate, message] of [
    ['collector-full-league-page-forged', capture => { capture.fragments[0].source.url = 'https://basketball.fantasysports.yahoo.com/nba/12345'; }, /source page/],
    ['collector-full-league-time-forged', capture => { capture.fragments[0].observed_at = '9999-01-01T00:00:00Z'; }, /observation time/]
  ]) {
    const capability = await h.ingest.mint({ run_id: run.id, attempt_id: attemptId });
    const data = await fullLeagueBundle(run, attemptId);
    const capture = JSON.parse(data.files[1].bytes); mutate(capture);
    data.files[1].bytes = Buffer.from(JSON.stringify(capture));
    data.manifest.artifacts[1].bytes = data.files[1].bytes.length;
    data.manifest.artifacts[1].sha256 = createHash('sha256').update(data.files[1].bytes).digest('hex');
    const output = JSON.parse(data.files[0].bytes);
    output.source.source_hash = (await import('../app/store.mjs')).canonicalDigest(capture);
    if (attemptId.includes('time')) output.source.observed_at = '9999-01-01T00:00:00Z';
    data.files[0].bytes = Buffer.from(JSON.stringify(output));
    data.manifest.artifacts[0].bytes = data.files[0].bytes.length;
    data.manifest.artifacts[0].sha256 = createHash('sha256').update(data.files[0].bytes).digest('hex');
    await h.ingest.manifest(capability, data.manifest);
    for (const file of data.files) await h.ingest.upload(capability, file.id, file.bytes);
    await assert.rejects(h.ingest.commit(capability), message);
  }
  assert.equal((await h.store.list('observations')).length, 0);
});

test('full-league commit recovers hidden segments after coverage publication is interrupted', async () => {
  const h = await harness();
  const run = await h.runs.create({ plan: fullLeaguePlanInput, intended_for: '2026-11-16T10:00:00Z' });
  const saveObservation = h.store.saveObservation.bind(h.store);
  let fail = true;
  h.store.saveObservation = async input => {
    if (fail && input.scope.dataset === 'league_coverage') { fail = false; throw new Error('simulated coverage interruption'); }
    return saveObservation(input);
  };
  const first = await h.ingest.mint({ run_id: run.id, attempt_id: 'collector-full-league-retry-one' });
  const firstBundle = await fullLeagueBundle(run, first.attempt_id);
  await h.ingest.manifest(first, firstBundle.manifest);
  for (const file of firstBundle.files) await h.ingest.upload(first, file.id, file.bytes);
  await assert.rejects(h.ingest.commit(first), /coverage interruption/);
  assert.equal((await h.store.list('observations')).length, 0);
  const second = await h.ingest.mint({ run_id: run.id, attempt_id: 'collector-full-league-retry-two' });
  const secondBundle = await fullLeagueBundle(run, second.attempt_id);
  await h.ingest.manifest(second, secondBundle.manifest);
  for (const file of secondBundle.files) await h.ingest.upload(second, file.id, file.bytes);
  const result = await h.ingest.commit(second);
  assert.equal(result.status, 'complete');
  assert.equal((await h.store.list('observations')).length, run.collection_plan.segments.length + 1);
});
