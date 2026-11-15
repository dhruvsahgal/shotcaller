import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalDigest } from '../app/store.mjs';
import { validateLocalLeagueBundle } from '../scripts/validate-league-collector-bundle.mjs';
import { collectorUpload } from '../scripts/upload-collector-bundle.mjs';
import { harness } from './helpers/collector-ingest.mjs';
import { fullLeagueBundle, fullLeaguePlanInput } from './helpers/full-league-collector.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function stagedBundle(mutator = () => {}) {
  const h = await harness();
  const run = await h.runs.create({ plan: fullLeaguePlanInput, intended_for: '2026-11-16T10:00:00Z' });
  const bundle = fullLeagueBundle(run);
  mutator(bundle);
  bundle.files[0].bytes = Buffer.from(JSON.stringify(bundle.output));
  bundle.files[1].bytes = Buffer.from(JSON.stringify(bundle.capture));
  for (const file of bundle.files) {
    const descriptor = bundle.manifest.artifacts.find(row => row.id === file.id);
    descriptor.bytes = file.bytes.length;
    descriptor.sha256 = hash(file.bytes);
  }
  const root = await mkdtemp(join(tmpdir(), 'shotcaller-league-preflight-'));
  await mkdir(join(root, 'evidence'));
  for (const file of bundle.files) await writeFile(join(root, file.evidence_ref), file.bytes);
  return { run, manifest: bundle.manifest, artifactRoot: root };
}

test('league bundle preflight verifies the exact local upload bundle', async () => {
  const input = await stagedBundle();
  assert.deepEqual(await validateLocalLeagueBundle(input), { valid: true, status: 'complete', segments: 169, fragments: 169 });
});

test('league bundle preflight rejects forged source pages, future times and coverage', async t => {
  await t.test('source page', async () => {
    const input = await stagedBundle(bundle => {
      bundle.capture.fragments[0].source.url = 'https://basketball.fantasysports.yahoo.com/nba/999/forged';
      bundle.output.source.source_hash = canonicalDigest(bundle.capture);
    });
    await assert.rejects(validateLocalLeagueBundle(input), /source page/);
  });
  await t.test('future observation', async () => {
    const input = await stagedBundle(bundle => {
      bundle.capture.fragments[0].observed_at = '2026-11-16T12:01:00Z';
      bundle.output.source.observed_at = '2026-11-16T12:01:00Z';
      bundle.output.source.source_hash = canonicalDigest(bundle.capture);
    });
    await assert.rejects(validateLocalLeagueBundle(input), /observation time/);
  });
  await t.test('coverage', async () => {
    const input = await stagedBundle(bundle => { bundle.output.coverage_hash = '0'.repeat(64); });
    await assert.rejects(validateLocalLeagueBundle(input), /coverage reconciliation/);
  });
});

test('collector uploader independently rejects a changed Railway readback hash', async () => {
  const input = await stagedBundle();
  const capability = 'c'.repeat(43), observation_id = 'observation-readback-test';
  const artifacts = input.manifest.artifacts.map(({ id, sha256, bytes }) => ({ id, sha256, bytes }));
  const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetcher = async url => {
    const path = new URL(url).pathname;
    if (path.endsWith('/capabilities')) return reply(201, { token: capability, run_id: input.run.id, attempt_id: input.manifest.attempt_id, league_id: input.run.scope.league_id });
    if (path.endsWith('/manifest')) return reply(201, input.manifest);
    if (path.includes('/artifacts/')) {
      const id = path.split('/').at(-1), descriptor = artifacts.find(row => row.id === id);
      return reply(201, descriptor);
    }
    if (path.endsWith('/commit')) return reply(200, { run_id: input.run.id, attempt_id: input.manifest.attempt_id, status: 'complete', verified: true, observation_id, artifacts });
    if (path.endsWith('/readback')) return reply(200, { run_id: input.run.id, attempt_id: input.manifest.attempt_id, status: 'complete', verified: true, observation_id, artifacts: artifacts.map((row, index) => index ? row : { ...row, sha256: 'f'.repeat(64) }) });
  };
  await assert.rejects(collectorUpload({ baseUrl: 'https://shotcaller.example', collectorToken: 'broker-secret-at-least-24', ...input, fetcher }), /readback mismatch/);
});
