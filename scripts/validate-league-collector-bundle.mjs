#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateLeagueCollectorBundle } from '../app/collector-bundle.mjs';
import { artifactLimits, ingestLimits } from '../app/ingest.mjs';

const artifactReference = /^evidence\/[A-Za-z0-9_-]+\.(?:json|txt|png)$/;
const artifactId = /^[A-Za-z0-9_-]{1,32}$/;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw new Error(message); };

export async function validateLocalLeagueBundle({ run, manifest, artifactRoot, includeArtifactBytes = false }) {
  if (!run || run.scope?.dataset !== 'league_coverage' || !run.collection_plan || !Array.isArray(run.allowed_pages)) fail('Invalid league run metadata');
  if (!manifest || manifest.version !== 1 || manifest.run_id !== run.id || manifest.idempotency_key !== run.idempotency_key || manifest.league_id !== run.scope.league_id || !Array.isArray(manifest.artifacts)) fail('Invalid collector manifest binding');
  if (manifest.artifacts.length < 3 || manifest.artifacts.length > ingestLimits.count) fail('Invalid collector artifact count');
  if (new Set(manifest.artifacts.map(row => row.id)).size !== manifest.artifacts.length || new Set(manifest.artifacts.map(row => row.evidence_ref)).size !== manifest.artifacts.length) fail('Invalid collector artifact duplicate');

  let total = 0;
  const artifacts = [];
  const root = resolve(artifactRoot);
  for (const descriptor of manifest.artifacts) {
    if (!artifactId.test(descriptor.id ?? '') || !Object.hasOwn(artifactLimits, descriptor.class) || !artifactReference.test(descriptor.evidence_ref ?? '')) fail('Invalid collector artifact descriptor');
    const extension = descriptor.class === 'screenshot' ? '.png' : descriptor.class === 'source_text' ? '.txt' : '.json';
    if (!descriptor.evidence_ref.endsWith(extension) || !/^[a-f0-9]{64}$/.test(descriptor.sha256 ?? '') || !Number.isSafeInteger(descriptor.bytes) || descriptor.bytes < 1 || descriptor.bytes > artifactLimits[descriptor.class]) fail('Invalid collector artifact metadata');
    const path = resolve(root, descriptor.evidence_ref);
    if (!path.startsWith(`${root}/`)) fail('Invalid collector artifact path');
    const bytes = await readFile(path);
    if (bytes.length !== descriptor.bytes || sha256(bytes) !== descriptor.sha256) fail('Invalid collector artifact readback');
    if (descriptor.class === 'screenshot' && !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) fail('Invalid collector screenshot format');
    total += bytes.length;
    artifacts.push({ ...descriptor, artifact_id: `preflight-${descriptor.id}`, bytesRead: bytes });
  }
  if (total > ingestLimits.total) fail('Invalid collector artifact total');
  for (const kind of ['collector_output', 'structured_capture']) if (artifacts.filter(row => row.class === kind).length !== 1) fail('Invalid collector output/capture count');

  const output = JSON.parse(artifacts.find(row => row.class === 'collector_output').bytesRead.toString('utf8'));
  const capture = JSON.parse(artifacts.find(row => row.class === 'structured_capture').bytesRead.toString('utf8'));
  const validation = validateLeagueCollectorBundle({ output, capture, run, artifacts });
  return {
    valid: true,
    status: output.status,
    segments: validation.plan.segments.length,
    fragments: validation.fragments.length,
    ...(includeArtifactBytes ? { artifactBytes: new Map(artifacts.map(artifact => [artifact.id, artifact.bytesRead])) } : {})
  };
}

async function main(argv) {
  if (argv.length !== 3) fail('Usage: validate-league-collector-bundle <run.json> <manifest.json> <artifact-root>');
  const [runPath, manifestPath, artifactRoot] = argv;
  return validateLocalLeagueBundle({
    run: JSON.parse(await readFile(runPath, 'utf8')),
    manifest: JSON.parse(await readFile(manifestPath, 'utf8')),
    artifactRoot
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(result => process.stdout.write(`${JSON.stringify(result)}\n`)).catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
