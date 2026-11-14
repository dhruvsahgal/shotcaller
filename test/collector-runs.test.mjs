import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CollectorRuns, collectionSlot, nextCollectionSlot } from '../app/collector-runs.mjs';
import { harness, scope } from './helpers/collector-ingest.mjs';

test('SGT due slots are durable, paused by default and catch up only latest missed slot', async () => {
  assert.equal(collectionSlot(Date.parse('2026-11-14T09:59:59Z')), '2026-11-13T22:00:00.000Z');
  assert.equal(nextCollectionSlot(Date.parse('2026-11-14T10:00:00Z')), '2026-11-14T22:00:00.000Z');
  const h = await harness();
  const initial = await h.runs.settings(); assert.equal(initial.paused, true);
  assert.deepEqual(initial.times, ['06:00', '18:00']);
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
  assert.deepEqual(body.target, { kind: 'existing_thread', threadId: 'existing-thread' });
  assert.equal(body.prompt.includes(h.config.boxesSecret), false);
  assert.equal(body.prompt.includes(h.config.collectorToken), false);
  assert.equal(await runs.tick(), null);
  const restarted = new CollectorRuns(h.config, h.store, h.options);
  assert.equal((await restarted.settings()).last_slot, '2026-11-17T10:00:00.000Z');
  h.advance(16 * 60_000); await runs.expirePending();
  assert.equal((await runs.status()).alerts[0].outcome, 'timed_out');
});

test('manual and scheduled intentions reuse identity; trigger failure is a terminal alert', async () => {
  const h = await harness();
  const manual = await h.runs.runNow({ scope, intended_for: h.run.intended_for });
  assert.equal(manual.run.id, h.run.id); assert.equal(manual.run.idempotency_key, h.run.idempotency_key);
  assert.equal(manual.launch.status, 'supervised_upload');
  assert.equal((await h.store.list('runs')).length, 1);
  Object.assign(h.config, { collectorGatesVerified: true, boxesRunUrl: 'https://boxes.dev/test/run', boxesSecret: 'secret', boxesThreadId: 'thread' });
  const runs = new CollectorRuns(h.config, h.store, { ...h.options, fetcher: async () => { throw new Error('provider secret detail'); } });
  const newer = await runs.create({ scope, intended_for: '2026-11-14T10:01:00Z' });
  assert.equal((await runs.dispatch(newer)).outcome, 'failed');
  const status = await runs.status(); assert.equal(status.alerts.length, 1);
  assert.equal(JSON.stringify(status).includes('provider secret detail'), false);
});
