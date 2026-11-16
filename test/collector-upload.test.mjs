import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectorUpload, collectorUploadEnvironment } from '../scripts/upload-collector-bundle.mjs';
import { harness } from './helpers/collector-ingest.mjs';
import { fullLeagueBundle, fullLeaguePlanInput } from './helpers/full-league-collector.mjs';

async function fixture() {
  const h = await harness();
  const run = await h.runs.create({ plan: fullLeaguePlanInput, intended_for: '2026-11-16T10:00:00Z' });
  const bundle = fullLeagueBundle(run, 'collector-upload-test');
  const root = await mkdtemp(join(tmpdir(), 'shotcaller-upload-'));
  await mkdir(join(root, 'evidence'));
  for (const file of bundle.files) await writeFile(join(root, file.evidence_ref), file.bytes);
  return { run, manifest: bundle.manifest, root, files: bundle.files };
}

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
const manifestReceipt = data => data.manifest;

test('uploader accepts the Boxes Railway URL alias and prefers the explicit URL', () => {
  assert.deepEqual(collectorUploadEnvironment({ RAILWAY_BASE_URL: 'https://shotcaller.example', COLLECTOR_TOKEN: 'broker-secret-at-least-24' }), { baseUrl: 'https://shotcaller.example', collectorToken: 'broker-secret-at-least-24' });
  assert.deepEqual(collectorUploadEnvironment({ SHOTCALLER_URL: 'https://preferred.example', RAILWAY_BASE_URL: 'https://legacy.example', COLLECTOR_TOKEN: 'broker-secret-at-least-24' }), { baseUrl: 'https://preferred.example', collectorToken: 'broker-secret-at-least-24' });
});

test('trusted uploader preflights, uploads, commits and verifies Railway readback', async () => {
  const data = await fixture(), calls = [];
  const capability = 'c'.repeat(43);
  const fetcher = async (url, options = {}) => {
    calls.push({ url, options });
    const path = new URL(url).pathname;
    if (path.endsWith('/capabilities')) return json(201, { token: capability, run_id: data.run.id, attempt_id: data.manifest.attempt_id, league_id: data.run.scope.league_id });
    if (path.endsWith('/manifest')) return json(201, manifestReceipt(data));
    if (path.includes('/artifacts/')) {
      const id = path.split('/').at(-1), descriptor = data.manifest.artifacts.find(row => row.id === id);
      return json(201, { id, sha256: descriptor.sha256, bytes: descriptor.bytes });
    }
    if (path.endsWith('/commit')) return json(200, { run_id: data.run.id, attempt_id: data.manifest.attempt_id, observation_id: 'observation-test', status: 'complete', verified: true, artifacts: data.manifest.artifacts.map(({ id, sha256, bytes }) => ({ id, sha256, bytes })) });
    if (path.endsWith('/readback')) return json(200, { run_id: data.run.id, attempt_id: data.manifest.attempt_id, observation_id: 'observation-test', status: 'complete', verified: true, artifacts: data.manifest.artifacts.map(({ id, sha256, bytes }) => ({ id, sha256, bytes })) });
    throw new Error(`Unexpected ${path}`);
  };
  const receipt = await collectorUpload({ baseUrl: 'https://shotcaller.example', collectorToken: 'broker-secret-at-least-24', run: data.run, manifest: data.manifest, artifactRoot: data.root, fetcher });
  assert.equal(receipt.verified, true);
  assert.equal(receipt.status, 'complete');
  assert.equal(calls.length, 7);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer broker-secret-at-least-24');
  for (const call of calls.slice(1)) assert.equal(call.options.headers.Authorization, `Bearer ${capability}`);
  for (const call of calls.filter(({ url }) => url.includes('/artifacts/'))) {
    const id = new URL(call.url).pathname.split('/').at(-1), file = data.files.find(row => row.id === id);
    assert.equal(call.options.method, 'PUT');
    assert.equal(call.options.headers['content-type'], 'application/octet-stream');
    assert.deepEqual(call.options.body, file.bytes);
  }
  assert.equal(JSON.stringify(receipt).includes('broker-secret-at-least-24'), false);
  assert.equal(JSON.stringify(receipt).includes(capability), false);
});

test('trusted uploader refuses an incomplete local bundle before network access', async () => {
  const data = await fixture();
  data.manifest.artifacts[0].sha256 = '0'.repeat(64);
  let calls = 0;
  await assert.rejects(collectorUpload({ baseUrl: 'https://shotcaller.example', collectorToken: 'broker-secret-at-least-24', run: data.run, manifest: data.manifest, artifactRoot: data.root, fetcher: async () => { calls++; } }), /readback/);
  assert.equal(calls, 0);
});

test('trusted uploader fails closed when Railway readback differs from the manifest', async () => {
  const data = await fixture();
  const capability = 'c'.repeat(43);
  const fetcher = async (url) => {
    const path = new URL(url).pathname;
    if (path.endsWith('/capabilities')) return json(201, { token: capability, run_id: data.run.id, attempt_id: data.manifest.attempt_id, league_id: data.run.scope.league_id });
    if (path.endsWith('/manifest')) return json(201, manifestReceipt(data));
    if (path.includes('/artifacts/')) {
      const id = path.split('/').at(-1), descriptor = data.manifest.artifacts.find(row => row.id === id);
      return json(201, { id, sha256: descriptor.sha256, bytes: descriptor.bytes });
    }
    if (path.endsWith('/commit')) return json(200, { status: 'complete', verified: true });
    if (path.endsWith('/readback')) return json(200, { status: 'complete', verified: true, artifacts: data.manifest.artifacts.map(({ id, sha256, bytes }, index) => ({ id, sha256: index ? sha256 : 'f'.repeat(64), bytes })) });
  };
  await assert.rejects(collectorUpload({ baseUrl: 'https://shotcaller.example', collectorToken: 'broker-secret-at-least-24', run: data.run, manifest: data.manifest, artifactRoot: data.root, fetcher }), /readback mismatch/);
});

test('trusted uploader rejects a capability minted for another attempt', async () => {
  const data = await fixture();
  await assert.rejects(collectorUpload({
    baseUrl: 'https://shotcaller.example', collectorToken: 'broker-secret-at-least-24', run: data.run, manifest: data.manifest, artifactRoot: data.root,
    fetcher: async () => json(201, { token: 'c'.repeat(43), run_id: data.run.id, attempt_id: 'collector-wrong', league_id: data.run.scope.league_id })
  }), /binding mismatch/);
});

test('trusted uploader rejects commit or readback identities and statuses that differ from preflight', async () => {
  const data = await fixture(), capability = 'c'.repeat(43), artifacts = data.manifest.artifacts.map(({ id, sha256, bytes }) => ({ id, sha256, bytes }));
  const fetcher = async url => {
    const path = new URL(url).pathname;
    if (path.endsWith('/capabilities')) return json(201, { token: capability, run_id: data.run.id, attempt_id: data.manifest.attempt_id, league_id: data.run.scope.league_id });
    if (path.endsWith('/manifest')) return json(201, manifestReceipt(data));
    if (path.includes('/artifacts/')) {
      const id = path.split('/').at(-1), descriptor = data.manifest.artifacts.find(row => row.id === id);
      return json(201, { id, sha256: descriptor.sha256, bytes: descriptor.bytes });
    }
    if (path.endsWith('/commit')) return json(200, { run_id: data.run.id, attempt_id: data.manifest.attempt_id, observation_id: 'observation-test', status: 'complete', verified: true, artifacts });
    if (path.endsWith('/readback')) return json(200, { run_id: 'run-wrong', attempt_id: data.manifest.attempt_id, observation_id: 'observation-test', status: 'partial', verified: true, artifacts });
  };
  await assert.rejects(collectorUpload({ baseUrl: 'https://shotcaller.example', collectorToken: 'broker-secret-at-least-24', run: data.run, manifest: data.manifest, artifactRoot: data.root, fetcher }), /readback mismatch/);
});

test('trusted uploader resolves a lost commit acknowledgement through readback', async () => {
  const data = await fixture(), capability = 'c'.repeat(43), observation_id = 'observation-test', artifacts = data.manifest.artifacts.map(({ id, sha256, bytes }) => ({ id, sha256, bytes }));
  let commits = 0;
  const fetcher = async url => {
    const path = new URL(url).pathname;
    if (path.endsWith('/capabilities')) return json(201, { token: capability, run_id: data.run.id, attempt_id: data.manifest.attempt_id, league_id: data.run.scope.league_id });
    if (path.endsWith('/manifest')) return json(201, manifestReceipt(data));
    if (path.includes('/artifacts/')) {
      const id = path.split('/').at(-1), descriptor = data.manifest.artifacts.find(row => row.id === id);
      return json(201, { id, sha256: descriptor.sha256, bytes: descriptor.bytes });
    }
    if (path.endsWith('/commit') && ++commits === 1) throw Object.assign(new Error('lost acknowledgement'), { name: 'TimeoutError' });
    if (path.endsWith('/commit') || path.endsWith('/readback')) return json(200, { run_id: data.run.id, attempt_id: data.manifest.attempt_id, observation_id, status: 'complete', verified: true, artifacts });
  };
  const receipt = await collectorUpload({ baseUrl: 'https://shotcaller.example', collectorToken: 'broker-secret-at-least-24', run: data.run, manifest: data.manifest, artifactRoot: data.root, fetcher });
  assert.equal(receipt.observation_id, observation_id);
  assert.equal(commits, 1);
});

test('trusted uploader recovers a truncated successful commit response through readback', async () => {
  const data = await fixture(), capability = 'c'.repeat(43), observation_id = 'observation-test', artifacts = data.manifest.artifacts.map(({ id, sha256, bytes }) => ({ id, sha256, bytes }));
  let commits = 0;
  const fetcher = async url => {
    const path = new URL(url).pathname;
    if (path.endsWith('/capabilities')) return json(201, { token: capability, run_id: data.run.id, attempt_id: data.manifest.attempt_id, league_id: data.run.scope.league_id });
    if (path.endsWith('/manifest')) return json(201, manifestReceipt(data));
    if (path.includes('/artifacts/')) {
      const id = path.split('/').at(-1), descriptor = data.manifest.artifacts.find(row => row.id === id);
      return json(201, { id, sha256: descriptor.sha256, bytes: descriptor.bytes });
    }
    if (path.endsWith('/commit') && ++commits === 1) return new Response('{', { status: 200, headers: { 'content-type': 'application/json' } });
    if (path.endsWith('/readback')) return json(200, { run_id: data.run.id, attempt_id: data.manifest.attempt_id, observation_id, status: 'complete', verified: true, artifacts });
  };
  const receipt = await collectorUpload({ baseUrl: 'https://shotcaller.example', collectorToken: 'broker-secret-at-least-24', run: data.run, manifest: data.manifest, artifactRoot: data.root, fetcher });
  assert.equal(receipt.observation_id, observation_id);
  assert.equal(commits, 1);
});

test('trusted uploader replays a commit after a partial server failure has no attempt readback', async () => {
  const data = await fixture(), capability = 'c'.repeat(43), observation_id = 'observation-test', artifacts = data.manifest.artifacts.map(({ id, sha256, bytes }) => ({ id, sha256, bytes }));
  let commits = 0, readbacks = 0;
  const fetcher = async url => {
    const path = new URL(url).pathname;
    if (path.endsWith('/capabilities')) return json(201, { token: capability, run_id: data.run.id, attempt_id: data.manifest.attempt_id, league_id: data.run.scope.league_id });
    if (path.endsWith('/manifest')) return json(201, manifestReceipt(data));
    if (path.includes('/artifacts/')) {
      const id = path.split('/').at(-1), descriptor = data.manifest.artifacts.find(row => row.id === id);
      return json(201, { id, sha256: descriptor.sha256, bytes: descriptor.bytes });
    }
    if (path.endsWith('/commit') && ++commits === 1) return json(400, { error: 'interrupted after publication began' });
    if (path.endsWith('/commit')) return json(200, { run_id: data.run.id, attempt_id: data.manifest.attempt_id, observation_id, status: 'complete', verified: true, artifacts });
    if (path.endsWith('/readback') && ++readbacks === 1) return json(200, { run_id: data.run.id, attempt_id: data.manifest.attempt_id, observation_id: null, status: 'uncommitted', verified: true, artifacts });
    if (path.endsWith('/readback')) return json(200, { run_id: data.run.id, attempt_id: data.manifest.attempt_id, observation_id, status: 'complete', verified: true, artifacts });
  };
  const receipt = await collectorUpload({ baseUrl: 'https://shotcaller.example', collectorToken: 'broker-secret-at-least-24', run: data.run, manifest: data.manifest, artifactRoot: data.root, fetcher });
  assert.equal(receipt.observation_id, observation_id);
  assert.equal(commits, 2);
  assert.equal(readbacks, 2);
});

test('trusted uploader rejects a manifest receipt bound to another run', async () => {
  const data = await fixture(), capability = 'c'.repeat(43);
  let calls = 0;
  const fetcher = async url => {
    calls++;
    const path = new URL(url).pathname;
    if (path.endsWith('/capabilities')) return json(201, { token: capability, run_id: data.run.id, attempt_id: data.manifest.attempt_id, league_id: data.run.scope.league_id });
    if (path.endsWith('/manifest')) return json(201, { ...manifestReceipt(data), run_id: 'run-wrong' });
  };
  await assert.rejects(collectorUpload({ baseUrl: 'https://shotcaller.example', collectorToken: 'broker-secret-at-least-24', run: data.run, manifest: data.manifest, artifactRoot: data.root, fetcher }), /Manifest upload receipt mismatch/);
  assert.equal(calls, 2);
});

test('trusted uploader requires exact verification flags', async () => {
  const data = await fixture(), capability = 'c'.repeat(43), observation_id = 'observation-test', artifacts = data.manifest.artifacts.map(({ id, sha256, bytes }) => ({ id, sha256, bytes }));
  const fetcher = async url => {
    const path = new URL(url).pathname;
    if (path.endsWith('/capabilities')) return json(201, { token: capability, run_id: data.run.id, attempt_id: data.manifest.attempt_id, league_id: data.run.scope.league_id });
    if (path.endsWith('/manifest')) return json(201, manifestReceipt(data));
    if (path.includes('/artifacts/')) {
      const id = path.split('/').at(-1), descriptor = data.manifest.artifacts.find(row => row.id === id);
      return json(201, { id, sha256: descriptor.sha256, bytes: descriptor.bytes });
    }
    if (path.endsWith('/commit') || path.endsWith('/readback')) return json(200, { run_id: data.run.id, attempt_id: data.manifest.attempt_id, observation_id, status: 'complete', verified: 'true', artifacts });
  };
  await assert.rejects(collectorUpload({ baseUrl: 'https://shotcaller.example', collectorToken: 'broker-secret-at-least-24', run: data.run, manifest: data.manifest, artifactRoot: data.root, fetcher }), /readback mismatch/);
});

test('trusted uploader bounds stalled Railway requests', async () => {
  const data = await fixture();
  const fetcher = async (_url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  await assert.rejects(collectorUpload({ baseUrl: 'https://shotcaller.example', collectorToken: 'broker-secret-at-least-24', run: data.run, manifest: data.manifest, artifactRoot: data.root, fetcher, requestTimeoutMs: 5 }), /timed out or was aborted/);
});

test('trusted uploader keeps the deadline active while reading a response body', async () => {
  const data = await fixture();
  const fetcher = async (_url, { signal }) => new Response(new ReadableStream({
    start(controller) { signal.addEventListener('abort', () => controller.error(signal.reason), { once: true }); }
  }), { status: 201, headers: { 'content-type': 'application/json' } });
  await assert.rejects(collectorUpload({ baseUrl: 'https://shotcaller.example', collectorToken: 'broker-secret-at-least-24', run: data.run, manifest: data.manifest, artifactRoot: data.root, fetcher, requestTimeoutMs: 5 }), /timed out or was aborted/);
});
