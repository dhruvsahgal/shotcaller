#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { validateLocalLeagueBundle } from './validate-league-collector-bundle.mjs';

function endpoints(baseUrl) {
  const url = new URL(baseUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) throw new Error('SHOTCALLER_URL must be a bare HTTPS origin');
  return path => new URL(path, `${url.origin}/`).href;
}

async function requestJSON(fetcher, url, options, label, timeoutMs, signal) {
  const controller = new AbortController();
  const timeoutError = new Error(`${label} timed out`);
  timeoutError.name = 'TimeoutError';
  const timer = setTimeout(() => controller.abort(timeoutError), timeoutMs);
  const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  try {
    const response = await fetcher(url, { ...options, signal: requestSignal });
    let data;
    try {
      data = await Promise.race([
        response.json(),
        new Promise((_, reject) => requestSignal.addEventListener('abort', () => reject(requestSignal.reason), { once: true }))
      ]);
    } catch (error) {
      if (error?.name === 'AbortError' || error?.name === 'TimeoutError') throw error;
      if (!response.ok) throw new Error(`${label} failed with HTTP ${response.status}`);
      throw new Error(`${label} returned invalid JSON`);
    }
    if (!response.ok) throw new Error(`${label} failed with HTTP ${response.status}${data?.error ? `: ${data.error}` : ''}`);
    if (!data || typeof data !== 'object') throw new Error(`${label} returned invalid JSON`);
    return data;
  } catch (error) {
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') throw new Error(`${label} timed out or was aborted`);
    throw error;
  } finally { clearTimeout(timer); }
}

function auth(token, extra = {}) { return { Authorization: `Bearer ${token}`, ...extra }; }
function descriptors(artifacts) {
  return [...artifacts].map(({ id, sha256, bytes }) => ({ id, sha256, bytes })).sort((a, b) => a.id.localeCompare(b.id));
}
function sameDescriptors(left, right) { return JSON.stringify(descriptors(left)) === JSON.stringify(descriptors(right)); }

export async function collectorUpload({ baseUrl, collectorToken, run, manifest, artifactRoot, fetcher = fetch, requestTimeoutMs = 120_000 }) {
  if (typeof collectorToken !== 'string' || collectorToken.length < 24) throw new Error('COLLECTOR_TOKEN must contain at least 24 characters');
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs >= 15 * 60_000) throw new Error('requestTimeoutMs must be shorter than the capability lifetime');
  const endpoint = endpoints(baseUrl);
  const preflight = await validateLocalLeagueBundle({ run, manifest, artifactRoot, includeArtifactBytes: true });

  const minted = await requestJSON(fetcher, endpoint('/api/collector/capabilities'), {
    method: 'POST', headers: auth(collectorToken, { 'content-type': 'application/json' }),
    body: JSON.stringify({ run_id: run.id, attempt_id: manifest.attempt_id }), redirect: 'error'
  }, 'Capability request', requestTimeoutMs);
  if (typeof minted.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(minted.token)) throw new Error('Capability response omitted a valid run-scoped token');
  if (minted.run_id !== run.id || minted.attempt_id !== manifest.attempt_id || minted.league_id !== run.scope.league_id) throw new Error('Capability response binding mismatch');
  const capability = minted.token;

  const manifestReceipt = await requestJSON(fetcher, endpoint('/api/collector/manifest'), {
    method: 'POST', headers: auth(capability, { 'content-type': 'application/json' }), body: JSON.stringify(manifest), redirect: 'error'
  }, 'Manifest upload', requestTimeoutMs);
  if (manifestReceipt.run_id !== run.id || manifestReceipt.attempt_id !== manifest.attempt_id || manifestReceipt.league_id !== manifest.league_id || !sameDescriptors(manifest.artifacts, manifestReceipt.artifacts ?? [])) throw new Error('Manifest upload receipt mismatch');
  const artifactBatch = new AbortController();
  try {
    await Promise.all(manifest.artifacts.map(async descriptor => {
      const body = preflight.artifactBytes.get(descriptor.id);
      const label = `Artifact upload ${descriptor.id}`;
      const saved = await requestJSON(fetcher, endpoint(`/api/collector/artifacts/${encodeURIComponent(descriptor.id)}`), {
        method: 'PUT', headers: auth(capability, { 'content-type': 'application/octet-stream' }), body, redirect: 'error'
      }, label, requestTimeoutMs, artifactBatch.signal);
      if (saved.id !== descriptor.id || saved.sha256 !== descriptor.sha256 || saved.bytes !== descriptor.bytes) throw new Error(`Artifact upload receipt mismatch for ${descriptor.id}`);
    }));
  } catch (error) {
    artifactBatch.abort();
    throw error;
  }
  const commitRequest = label => requestJSON(fetcher, endpoint('/api/collector/commit'), {
    method: 'POST', headers: auth(capability), redirect: 'error'
  }, label, requestTimeoutMs);
  const readbackRequest = label => requestJSON(fetcher, endpoint('/api/collector/readback'), {
    method: 'GET', headers: auth(capability), redirect: 'error'
  }, label, requestTimeoutMs);
  let commit;
  try { commit = await commitRequest('Collector commit'); }
  catch (error) {
    let recovered = null;
    try { recovered = await readbackRequest('Collector recovery readback'); } catch {}
    if (recovered?.status && recovered.status !== 'uncommitted') commit = recovered;
    else {
      try { commit = await commitRequest('Collector commit recovery'); }
      catch (recoveryError) { throw new AggregateError([error, recoveryError], 'Collector commit and recovery failed'); }
    }
  }
  const readback = await readbackRequest('Collector readback');
  const correctIdentity = response => response.run_id === run.id && response.attempt_id === manifest.attempt_id;
  if (commit.verified !== true || readback.verified !== true || !correctIdentity(commit) || !correctIdentity(readback) || commit.status !== preflight.status || readback.status !== preflight.status || commit.observation_id !== readback.observation_id || (preflight.status === 'complete' && !readback.observation_id) || !sameDescriptors(manifest.artifacts, commit.artifacts ?? []) || !sameDescriptors(manifest.artifacts, readback.artifacts ?? [])) throw new Error('Railway readback mismatch');
  return {
    version: 1,
    run_id: run.id,
    attempt_id: manifest.attempt_id,
    observation_id: readback.observation_id,
    status: readback.status,
    verified: true,
    preflight: { status: preflight.status, segments: preflight.segments, fragments: preflight.fragments },
    artifacts: descriptors(readback.artifacts)
  };
}

async function main(argv) {
  if (argv.length !== 3) throw new Error('Usage: upload-collector-bundle <run.json> <manifest.json> <artifact-root>');
  const [runPath, manifestPath, artifactRoot] = argv;
  return collectorUpload({
    baseUrl: process.env.SHOTCALLER_URL,
    collectorToken: process.env.COLLECTOR_TOKEN,
    run: JSON.parse(await readFile(runPath, 'utf8')),
    manifest: JSON.parse(await readFile(manifestPath, 'utf8')),
    artifactRoot
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(receipt => process.stdout.write(`${JSON.stringify(receipt)}\n`)).catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
