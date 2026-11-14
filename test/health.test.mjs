import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../app/store.mjs';
import { archiveManifest, verifyArchive, ModelUsageLedger, RotatingCredential } from '../app/health.mjs';
import { CollectorRuns } from '../app/collector-runs.mjs';
import { makeDecision } from '../app/decisions.mjs';
import { harness, scope } from './helpers/collector-ingest.mjs';

test('private archive restores with matching records, hashes and links', async () => {
  const source = await mkdtemp(join(tmpdir(), 'shotcaller-backup-source-'));
  const restored = await mkdtemp(join(tmpdir(), 'shotcaller-backup-restored-'));
  const store = new Store(source);
  const record = await store.importHistorical({ snapshot_id: 'backup-fixture', source: { captured_at: '2026-11-14T00:00:00Z' }, players: [{ name: 'Player' }] });
  await writeFile(join(source, 'latest.json'), JSON.stringify({ id: record.id }));
  const manifest = await archiveManifest(source);
  await cp(source, restored, { recursive: true });
  const verified = await verifyArchive(restored, manifest);
  assert.equal(verified.ok, true);
  assert.equal(verified.files, manifest.files.length);
  await writeFile(join(restored, 'latest.json'), JSON.stringify({ id: 'missing-record' }));
  await assert.rejects(verifyArchive(restored, manifest), /hash mismatch|missing record/i);
});

test('model reservations and actual usage survive restart and stop at the cap', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shotcaller-budget-'));
  const first = new ModelUsageLedger(root, 2);
  const a = await first.reserve({ task: 'recommendation', model: 'test-model' });
  await first.settle(a.id, { status: 'failed', usage: null });
  const b = await first.reserve({ task: 'valuation', model: 'test-model' });
  await first.settle(b.id, { status: 'succeeded', usage: { prompt_tokens: 10, completion_tokens: 4 } });
  const restarted = new ModelUsageLedger(root, 2);
  await assert.rejects(restarted.reserve({ task: 'followup', model: 'test-model' }), /budget exhausted/i);
  const status = await restarted.status();
  assert.equal(status.attempted, 2);
  assert.equal(status.actual.prompt_tokens, 10);
  assert.equal(status.actual.completion_tokens, 4);
});

test('provider outage consumes one bounded attempt and preserves the last evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shotcaller-provider-outage-'));
  const store = new Store(root);
  const evidence = await store.importHistorical({ snapshot_id: 'last-good', source: { captured_at: '2026-11-14T00:00:00Z' }, players: [{ name: 'Available' }] });
  const config = { promptPath: new URL('../prompts/shotcaller-system.md', import.meta.url), endpoint: 'https://api.openai.com/v1/chat/completions', model: 'test-model', apiKey: 'test-key', modelCallBudget: 1 };
  let calls = 0;
  const outage = async () => { calls += 1; return new Response('', { status: 503 }); };
  const request = { task: 'recommendation', question: 'Hold or act?', snapshot_ids: [evidence.id] };
  await assert.rejects(makeDecision(request, config, store, outage), /HTTP 503/);
  await assert.rejects(makeDecision(request, config, store, outage), /budget exhausted/i);
  assert.equal(calls, 1);
  assert.equal((await store.read(evidence.id)).id, evidence.id);
});

test('collector credential rotation revokes the old secret without changing app auth', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shotcaller-credential-'));
  const oldToken = 'collector-old-token-1234567890';
  const nextToken = 'collector-next-token-123456789';
  const registry = new RotatingCredential(root, oldToken);
  assert.equal(await registry.authenticate(oldToken), true);
  const rotated = await registry.rotate(nextToken);
  assert.equal(rotated.version, 2);
  assert.equal(await registry.authenticate(oldToken), false);
  assert.equal(await registry.authenticate(nextToken), true);
  assert.equal((await readFile(join(root, 'operations', 'collector-credential.json'), 'utf8')).includes(nextToken), false);
});

test('active or receipt-missing boxes run blocks replacement until reconciled', async () => {
  const h = await harness();
  Object.assign(h.config, { collectorGatesVerified: true, boxesRunUrl: 'https://boxes.dev/test/run', boxesSecret: 'secret', boxesThreadId: 'thread' });
  let launches = 0;
  const runs = new CollectorRuns(h.config, h.store, { ...h.options, fetcher: async () => { launches += 1; return { status: 202, json: async () => ({ status: 'thread_ready' }) }; } });
  const first = await runs.create({ scope, intended_for: '2026-11-14T10:01:00Z' });
  await runs.dispatch(first);
  const next = await runs.create({ scope, intended_for: '2026-11-14T22:00:00Z' });
  await assert.rejects(runs.dispatch(next), /reconcile/i);
  h.advance(16 * 60_000);
  await runs.expirePending();
  await assert.rejects(runs.dispatch(next), /reconcile/i);
  await runs.reconcile(first.id, { outcome: 'failed', reason: 'Verified no Yahoo mutation and no stored artifacts.' });
  await runs.dispatch(next);
  assert.equal(launches, 2);
});
