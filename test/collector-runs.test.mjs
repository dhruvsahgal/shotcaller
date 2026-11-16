import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CollectorRuns, collectionSlot, nextCollectionSlot, fullLeagueAllowedPages } from '../app/collector-runs.mjs';
import { harness, scope } from './helpers/collector-ingest.mjs';
import { validateCollectorRequest } from '../scripts/validate-collector-output.mjs';
import { fullLeaguePlanInput } from './helpers/full-league-collector.mjs';

test('daily 16:00 SGT slots are durable, paused by default and catch up only latest missed slot', async () => {
  assert.equal(collectionSlot(Date.parse('2026-11-14T07:59:59Z')), '2026-11-13T08:00:00.000Z');
  assert.equal(nextCollectionSlot(Date.parse('2026-11-14T08:00:00Z')), '2026-11-15T08:00:00.000Z');
  const h = await harness();
  const initial = await h.runs.settings(); assert.equal(initial.paused, true);
  assert.deepEqual(initial.times, ['16:00']);
  assert.equal(await h.runs.tick(), null);
  await assert.rejects(h.runs.configure({ paused: false, scope }), /gates/);
  const calls = [];
  Object.assign(h.config, { collectorGatesVerified: true, boxesRunUrl: 'https://boxes.dev/test/run', boxesSecret: 'test-private-secret', boxesThreadId: 'existing-thread' });
  const runs = new CollectorRuns(h.config, h.store, { ...h.options, fetcher: async (url, options) => { calls.push({ url, options }); return { status: 202, json: async () => ({ status: 'thread_ready' }) }; } });
  await runs.configure({ paused: false, scope });
  h.advance(3 * 24 * 60 * 60_000);
  const result = await runs.tick();
  assert.equal(result.status, 'awaiting_artifacts'); assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0].options.body);
  const savedRun = (await h.store.list('runs')).at(-1);
  assert.deepEqual(savedRun.allowed_pages, ['https://basketball.fantasysports.yahoo.com/nba/999/7']);
  assert.equal(validateCollectorRequest({ method: 'GET', url: savedRun.allowed_pages[0], allowedPages: savedRun.allowed_pages }).allowed, true);
  assert.deepEqual(body.target, { kind: 'existing_thread', threadId: 'existing-thread' });
  assert.match(body.prompt, /structured capture|ingest-ready artifact bundle/i);
  assert.match(body.prompt, /Exact allowed_pages: \["https:\/\/basketball\.fantasysports\.yahoo\.com\/nba\/999\/7"\]/);
  assert.equal(body.prompt.includes(h.config.boxesSecret), false);
  assert.equal(body.prompt.includes(h.config.collectorToken), false);
  assert.equal(await runs.tick(), null);
  const restarted = new CollectorRuns(h.config, h.store, h.options);
  assert.equal((await restarted.settings()).last_slot, '2026-11-17T08:00:00.000Z');
  h.advance(16 * 60_000); await runs.expirePending();
  assert.equal((await runs.status()).alerts[0].outcome, 'timed_out');
});

test('manual intentions reuse identity and a refused launch can retry the same run', async () => {
  const h = await harness();
  const manual = await h.runs.runNow({ scope, intended_for: h.run.intended_for });
  assert.equal(manual.run.id, h.run.id); assert.equal(manual.run.idempotency_key, h.run.idempotency_key);
  assert.equal(manual.launch.status, 'supervised_upload');
  assert.equal((await h.store.list('runs')).length, 1);
  Object.assign(h.config, { collectorGatesVerified: true, boxesRunUrl: 'https://boxes.dev/test/run', boxesSecret: 'secret', boxesThreadId: 'thread' });
  let calls = 0;
  const runs = new CollectorRuns(h.config, h.store, { ...h.options, fetcher: async () => ++calls === 1 ? { status: 503 } : { status: 202, json: async () => ({ status: 'starting' }) } });
  const newer = await runs.create({ scope, intended_for: '2026-11-14T10:01:00Z' });
  assert.equal((await runs.dispatch(newer)).outcome, 'failed');
  const accepted = await runs.dispatch(newer);
  assert.equal(accepted.status, 'awaiting_artifacts');
  assert.equal(calls, 2);
  const status = await runs.status();
  assert.equal(status.alerts.length, 1);
  assert.equal(status.unresolved_run.run_id, newer.id);
  assert.equal(status.unresolved_run.status, 'awaiting_artifacts');
  assert.notEqual(accepted.attempt_id, status.alerts[0].id);
});

test('ambiguous dispatch is durable and blocks duplicates until reconciled', async () => {
  const h = await harness();
  Object.assign(h.config, { collectorGatesVerified: true, boxesRunUrl: 'https://boxes.dev/test/run', boxesSecret: 'secret', boxesThreadId: 'thread' });
  let calls = 0, runs;
  runs = new CollectorRuns(h.config, h.store, { ...h.options, fetcher: async () => {
    calls++;
    const pending = await runs.unresolvedReceipt();
    assert.equal(pending.receipt.status, 'dispatching');
    if (calls === 1) throw new Error('connection reset after request write');
    return { status: 202, json: async () => ({ status: 'thread_ready' }) };
  } });
  const run = await runs.create({ scope, intended_for: '2026-11-14T10:02:00Z' });
  const result = await runs.dispatch(run);
  assert.equal(result.status, 'reconciliation_required');
  assert.equal((await runs.status()).unresolved_run.status, 'reconciliation_required');
  await assert.rejects(runs.dispatch(run), /must reconcile/);
  assert.equal(calls, 1);
  const settlement = await runs.reconcile(run.id, { outcome: 'failed', reason: 'Confirmed no automation thread was created.' });
  assert.notEqual(settlement.id, result.attempt_id);
  assert.equal((await runs.status()).unresolved_run, null);
  const accepted = await runs.dispatch(run);
  assert.equal(accepted.status, 'awaiting_artifacts');
  assert.equal(calls, 2);
  assert.notEqual(accepted.attempt_id, result.attempt_id);
});

test('full-league intentions persist the declared plan and exact bounded Yahoo read pages', async () => {
  const h = await harness();
  const configured = await h.runs.configure({ paused: true, scope: null, plan: fullLeaguePlanInput });
  assert.equal(configured.plan.segments.length, 169);
  const prepared = await h.runs.runNow({ intended_for: '2026-11-16T09:00:00Z' });
  assert.equal(prepared.run.scope.dataset, 'league_coverage');
  assert.equal(prepared.launch.status, 'supervised_upload');
  const rosterOverride = await h.runs.runNow({ scope, intended_for: '2026-11-16T09:30:00Z' });
  assert.equal(rosterOverride.run.scope.dataset, 'team_roster');
  assert.equal(rosterOverride.run.collection_plan, undefined);
  const run = await h.runs.create({ plan: fullLeaguePlanInput, intended_for: '2026-11-16T10:00:00Z' });
  assert.equal(run.scope.dataset, 'league_coverage');
  assert.equal(run.collection_plan.segments.length, 169);
  assert.equal(run.allowed_pages.length, 207);
  assert.ok(run.allowed_pages.includes('https://basketball.fantasysports.yahoo.com/nba/999/players?status=FA'));
  assert.ok(run.allowed_pages.includes('https://basketball.fantasysports.yahoo.com/nba/999/transactions'));
  assert.ok(run.allowed_pages.includes('https://basketball.fantasysports.yahoo.com/nba/999/1?date=2026-11-16'));
  assert.ok(run.allowed_pages.includes('https://basketball.fantasysports.yahoo.com/nba/999/players?count=975&status=FA'));
  assert.ok(run.allowed_pages.includes('https://basketball.fantasysports.yahoo.com/nba/999/players?count=975&status=W'));
  assert.ok(run.allowed_pages.includes('https://basketball.fantasysports.yahoo.com/nba/999/transactions?count=975'));
  for (const teamId of fullLeaguePlanInput.team_ids) for (const date of fullLeaguePlanInput.scoring_dates) assert.ok(run.allowed_pages.includes(`https://basketball.fantasysports.yahoo.com/nba/999/${teamId}?date=${date}`));
  for (const page of run.allowed_pages) assert.equal(validateCollectorRequest({ method: 'GET', url: page, allowedPages: run.allowed_pages }).allowed, true);
  assert.equal(validateCollectorRequest({ method: 'POST', url: run.allowed_pages[0], allowedPages: run.allowed_pages }).allowed, false);
  const repeated = await h.runs.create({ plan: fullLeaguePlanInput, intended_for: '2026-11-16T10:00:00Z' });
  assert.equal(repeated.id, run.id);
});

test('full-league plan identifiers and activation require their own verified gate', async () => {
  const h = await harness();
  const forged = structuredClone(fullLeaguePlanInput);
  forged.team_ids[0] = '../12345';
  forged.matchups[0].team_ids[0] = '../12345';
  await assert.rejects(h.runs.create({ plan: forged, intended_for: '2026-11-16T10:00:00Z' }), /team ID/);
  Object.assign(h.config, { collectorGatesVerified: true, fullLeagueCollectorGatesVerified: false, boxesRunUrl: 'https://boxes.dev/test/run', boxesSecret: 'secret', boxesThreadId: 'thread' });
  await assert.rejects(h.runs.configure({ paused: false, scope: null, plan: fullLeaguePlanInput }), /gates/);
  h.config.fullLeagueCollectorGatesVerified = true;
  const configured = await h.runs.configure({ paused: false, scope: null, plan: fullLeaguePlanInput });
  assert.equal(configured.paused, false);
});

test('full-league dispatch deadline covers its runtime budget plus upload grace', async () => {
  const h = await harness();
  Object.assign(h.config, { collectorGatesVerified: true, fullLeagueCollectorGatesVerified: true, boxesRunUrl: 'https://boxes.dev/test/run', boxesSecret: 'secret', boxesThreadId: 'thread' });
  const runs = new CollectorRuns(h.config, h.store, { ...h.options, fetcher: async () => ({ status: 202, json: async () => ({ status: 'starting' }) }) });
  const run = await runs.create({ plan: fullLeaguePlanInput, intended_for: '2026-11-16T10:00:00Z' });
  const launchedAt = h.options.now();
  const receipt = await runs.dispatch(run);
  assert.equal(Date.parse(receipt.deadline) - launchedAt, 65 * 60_000);
  h.advance(64 * 60_000);
  await runs.expirePending();
  assert.equal((await runs.status()).alerts.length, 0);
  h.advance(2 * 60_000);
  await runs.expirePending();
  assert.equal((await runs.status()).alerts[0].outcome, 'timed_out');
});

test('full-league dispatch validates and uploads the exact Railway run through the trusted uploader', async () => {
  const h = await harness();
  const calls = [];
  Object.assign(h.config, { collectorGatesVerified: true, fullLeagueCollectorGatesVerified: true, boxesRunUrl: 'https://boxes.dev/test/run', boxesSecret: 'secret', boxesThreadId: 'thread', collectorToken: 'collector-token-that-must-not-leak' });
  const runs = new CollectorRuns(h.config, h.store, { ...h.options, fetcher: async (_url, options) => {
    calls.push(JSON.parse(options.body));
    return { status: 202, json: async () => ({ status: 'starting' }) };
  } });
  const run = await runs.create({ plan: fullLeaguePlanInput, intended_for: '2026-11-16T10:00:00Z' });
  await runs.dispatch(run);
  const prompt = calls[0].prompt;
  assert.match(prompt, /npm run validate:league-bundle -- data\/pilot\/run\.json data\/pilot\/manifest\.json data\/pilot/);
  assert.match(prompt, /npm run upload:league-bundle -- data\/pilot\/run\.json data\/pilot\/manifest\.json data\/pilot/);
  assert.match(prompt, /Railway readback receipt/);
  assert.equal(prompt.includes(JSON.stringify(run)), true);
  assert.equal(prompt.includes(h.config.collectorToken), false);
  assert.equal(prompt.includes(h.config.boxesSecret), false);
});
