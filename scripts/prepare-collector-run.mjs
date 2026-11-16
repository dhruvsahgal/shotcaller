#!/usr/bin/env node

import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { collectionSlot } from '../app/collector-runs.mjs';

function endpoint(baseUrl) {
  const url = new URL(baseUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) throw new Error('SHOTCALLER_URL must be a bare HTTPS origin');
  return new URL('/api/collector/run', `${url.origin}/`).href;
}

export function collectorRunEnvironment(env = process.env) {
  return { baseUrl: env.SHOTCALLER_URL || env.RAILWAY_BASE_URL, collectorRunToken: env.COLLECTOR_RUN_TOKEN };
}

export function collectorRunArguments(argv, now = Date.now()) {
  const args = [...argv], manualNow = args[0] === '--manual-now';
  if (manualNow) args.shift();
  if (args.length > 1 || args[0]?.startsWith('--')) throw new Error('Usage: prepare-collector-run [--manual-now] [destination]');
  return { destination: args[0] || 'data/pilot/run.json', intendedFor: manualNow ? new Date(now).toISOString() : null };
}

export async function prepareCollectorRun({ baseUrl, collectorRunToken, intendedFor = null, now = Date.now(), destination, fetcher = fetch }) {
  if (typeof collectorRunToken !== 'string' || collectorRunToken.length < 24) throw new Error('COLLECTOR_RUN_TOKEN must contain at least 24 characters');
  if (typeof destination !== 'string' || !destination) throw new Error('Collector run destination is required');
  intendedFor ||= collectionSlot(now);
  const response = await fetcher(endpoint(baseUrl), {
    method: 'POST',
    headers: { Authorization: `Bearer ${collectorRunToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ intended_for: intendedFor, dispatch: false }),
    redirect: 'error',
    signal: AbortSignal.timeout(30_000)
  });
  let result;
  try { result = await response.json(); } catch { throw new Error(`Collector run request returned invalid JSON (HTTP ${response.status})`); }
  if (!response.ok) throw new Error(`Collector run request failed with HTTP ${response.status}${result?.error ? `: ${result.error}` : ''}`);
  const run = result?.run;
  if (!run || run.scope?.dataset !== 'league_coverage' || !run.collection_plan || !Array.isArray(run.allowed_pages) || !run.allowed_pages.length || typeof run.id !== 'string' || typeof run.idempotency_key !== 'string' || run.intended_for !== new Date(intendedFor).toISOString()) throw new Error('Collector run request did not return the requested full-league contract');
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(run, null, 2), { mode: 0o600, flag: 'wx' });
  try { await rename(temporary, destination); } finally { await rm(temporary, { force: true }); }
  return { version: 1, run_id: run.id, intended_for: run.intended_for, destination, status: result.launch?.status || 'supervised_upload' };
}

async function main(argv) {
  return prepareCollectorRun({ ...collectorRunEnvironment(), ...collectorRunArguments(argv) });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(receipt => process.stdout.write(`${JSON.stringify(receipt)}\n`)).catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
