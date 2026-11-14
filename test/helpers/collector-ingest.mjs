import { readFile, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { configuration } from '../../app/config.mjs';
import { Store } from '../../app/store.mjs';
import { CollectorRuns } from '../../app/collector-runs.mjs';
import { CollectorIngest } from '../../app/ingest.mjs';
import { extractRosterObservation } from '../../app/extract.mjs';

export const scope = { dataset: 'team_roster', league_id: '999', season: '2026', team_id: '7', scoring_period: { kind: 'week', key: '5', timezone: 'America/Los_Angeles' }, value_basis: { value: 'observed', aggregation: 'roster' } };
export async function harness() {
  const config = { ...configuration({}), dataDir: await mkdtemp(join(tmpdir(), 'shotcaller-ingest-')), leagueId: '999', token: 'admin-token-at-least-24-characters', collectorToken: 'broker-token-at-least-24-characters' };
  const store = new Store(config.dataDir); await store.init();
  let clock = Date.parse('2026-11-14T10:16:00Z');
  const options = { now: () => clock };
  const runs = new CollectorRuns(config, store, options);
  const ingest = new CollectorIngest(config, store, options);
  const run = await runs.create({ scope, intended_for: '2026-11-14T10:00:00Z' });
  return { config, store, runs, ingest, run, options, advance: ms => { clock += ms; } };
}
export async function bundle(run, attempt = 'collector-attempt-one', pageName = 'full') {
  const capture = JSON.parse(await readFile(new URL(`../fixtures/collector/page-${pageName}.json`, import.meta.url), 'utf8'));
  const output = extractRosterObservation(capture, { league: { id: '999', name: 'Synthetic League' }, team: { id: '7', name: 'Synthetic Team' }, scoring_period: scope.scoring_period, allowed_pages: run.allowed_pages });
  const refs = [...new Set(capture.evidence_refs.map(r => r.split('#')[0]))];
  const files = [
    { id: 'output', class: 'collector_output', evidence_ref: 'evidence/output.json', bytes: Buffer.from(JSON.stringify(output)) },
    { id: 'capture', class: 'structured_capture', evidence_ref: 'evidence/capture.json', bytes: Buffer.from(JSON.stringify(capture)) },
    ...refs.map((ref, i) => ({ id: `source-${i}`, class: ref.endsWith('.png') ? 'screenshot' : 'source_text', evidence_ref: ref, bytes: ref.endsWith('.png') ? Buffer.from([137,80,78,71,13,10,26,10,0]) : Buffer.from(capture.text) }))
  ];
  const manifest = { version: 1, run_id: run.id, attempt_id: attempt, idempotency_key: run.idempotency_key, league_id: '999', artifacts: files.map(f => ({ id: f.id, class: f.class, evidence_ref: f.evidence_ref, bytes: f.bytes.length, sha256: createHash('sha256').update(f.bytes).digest('hex') })) };
  return { files, manifest };
}
export async function stage(h, attempt, name) {
  const capability = await h.ingest.mint({ run_id: h.run.id, attempt_id: attempt });
  const data = await bundle(h.run, attempt, name);
  await h.ingest.manifest(capability, data.manifest);
  for (const f of data.files) await h.ingest.upload(capability, f.id, f.bytes);
  return { capability, ...data };
}
