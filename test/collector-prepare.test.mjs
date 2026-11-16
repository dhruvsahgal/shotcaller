import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectorRunArguments, collectorRunEnvironment, prepareCollectorRun } from '../scripts/prepare-collector-run.mjs';
import { fullLeaguePlanInput } from './helpers/full-league-collector.mjs';

const run = {
  id: 'run-123', idempotency_key: 'a'.repeat(64), intended_for: '2026-11-16T08:00:00.000Z',
  scope: { dataset: 'league_coverage', league_id: '123' }, collection_plan: fullLeaguePlanInput,
  allowed_pages: ['https://basketball.fantasysports.yahoo.com/nba/123']
};

test('run preparation accepts the Boxes Railway URL alias', () => {
  assert.deepEqual(collectorRunEnvironment({ RAILWAY_BASE_URL: 'https://shotcaller.example', COLLECTOR_RUN_TOKEN: 'run-secret-at-least-24-characters' }), { baseUrl: 'https://shotcaller.example', collectorRunToken: 'run-secret-at-least-24-characters' });
});

test('manual catch-up explicitly requests a current immutable contract', () => {
  const now = Date.parse('2026-11-16T14:42:43.206Z');
  assert.deepEqual(collectorRunArguments(['--manual-now', 'data/pilot/run.json'], now), {
    destination: 'data/pilot/run.json',
    intendedFor: '2026-11-16T14:42:43.206Z'
  });
  assert.deepEqual(collectorRunArguments(['data/pilot/run.json'], now), {
    destination: 'data/pilot/run.json',
    intendedFor: null
  });
  assert.throws(() => collectorRunArguments(['--manual-now', 'one.json', 'two.json'], now), /Usage/);
});

test('run preparation requests the immutable Railway contract and writes it locally', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shotcaller-run-')), destination = join(root, 'pilot', 'run.json');
  let request;
  const receipt = await prepareCollectorRun({
    baseUrl: 'https://shotcaller.example', collectorRunToken: 'run-secret-at-least-24-characters', intendedFor: run.intended_for, destination,
    fetcher: async (url, options) => { request = { url, options }; return new Response(JSON.stringify({ run, launch: { status: 'supervised_upload' } }), { status: 201, headers: { 'content-type': 'application/json' } }); }
  });
  assert.equal(request.url, 'https://shotcaller.example/api/collector/run');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers.Authorization, 'Bearer run-secret-at-least-24-characters');
  assert.deepEqual(JSON.parse(request.options.body), { intended_for: run.intended_for, dispatch: false });
  assert.deepEqual(JSON.parse(await readFile(destination, 'utf8')), run);
  assert.equal(receipt.run_id, run.id);
  assert.equal(JSON.stringify(receipt).includes('run-secret'), false);
});

test('run preparation rejects roster-only or incomplete contracts without replacing the destination', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shotcaller-run-')), destination = join(root, 'run.json');
  const previous = '{"run":"keep-me"}\n';
  await writeFile(destination, previous);
  await assert.rejects(prepareCollectorRun({
    baseUrl: 'https://shotcaller.example', collectorRunToken: 'run-secret-at-least-24-characters', destination,
    fetcher: async () => new Response(JSON.stringify({ run: { ...run, collection_plan: null } }), { status: 201, headers: { 'content-type': 'application/json' } })
  }), /requested full-league contract/);
  assert.equal(await readFile(destination, 'utf8'), previous);
});

test('run preparation reuses the deterministic Singapore collection slot', async () => {
  const bodies = [], root = await mkdtemp(join(tmpdir(), 'shotcaller-run-'));
  const fetcher = async (_url, options) => { bodies.push(JSON.parse(options.body)); return new Response(JSON.stringify({ run, launch: { status: 'supervised_upload' } }), { status: 201, headers: { 'content-type': 'application/json' } }); };
  const base = { baseUrl: 'https://shotcaller.example', collectorRunToken: 'run-secret-at-least-24-characters', fetcher };
  await prepareCollectorRun({ ...base, now: Date.parse('2026-11-16T10:00:01Z'), destination: join(root, 'one.json') });
  await prepareCollectorRun({ ...base, now: Date.parse('2026-11-16T10:59:59Z'), destination: join(root, 'two.json') });
  assert.equal(bodies[0].intended_for, bodies[1].intended_for);
  assert.equal(bodies[0].intended_for, '2026-11-16T08:00:00.000Z');
});
