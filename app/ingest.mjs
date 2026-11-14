import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { atomicJSON, canonicalDigest } from './store.mjs';
import { validateIdentifier } from './schema.mjs';
import { validateCollectorOutput } from '../scripts/validate-collector-output.mjs';
import { extractRosterObservation } from './extract.mjs';

export const artifactLimits = Object.freeze({ collector_output: 256 * 1024, structured_capture: 1024 * 1024, source_text: 512 * 1024, screenshot: 2 * 1024 * 1024 });
export const ingestLimits = Object.freeze({ manifest: 32 * 1024, count: 16, total: 8 * 1024 * 1024, capability_ms: 15 * 60_000 });
const hashBytes = bytes => createHash('sha256').update(bytes).digest('hex');
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));

export class CollectorIngest {
  constructor(config, store, { now = () => Date.now() } = {}) {
    this.config = config; this.store = store; this.now = now;
    this.root = join(config.dataDir, 'collector'); this.queue = Promise.resolve();
  }
  async init() {
    for (const folder of ['collector/capabilities', 'collector-manifests', 'collector-artifacts']) await mkdir(join(this.config.dataDir, folder), { recursive: true, mode: 0o700 });
  }
  async mint({ run_id, attempt_id }) {
    validateIdentifier(run_id); validateIdentifier(attempt_id);
    if (!/^collector-[A-Za-z0-9-]{1,64}$/.test(attempt_id)) throw new Error('Invalid collector attempt ID');
    const run = await this.store.read(run_id, 'runs');
    if (run.scope.league_id !== this.config.leagueId || run.scope.dataset !== 'team_roster') throw new Error('Invalid collector run scope');
    try {
      const priorAttempt = await this.store.read(attempt_id, 'attempts');
      if (priorAttempt.run_id !== run_id) throw new Error('Invalid collector attempt binding');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await this.init();
    const token = randomBytes(32).toString('base64url');
    const claims = { version: 1, run_id, attempt_id, league_id: run.scope.league_id, issued_at: new Date(this.now()).toISOString(), expires_at: new Date(this.now() + ingestLimits.capability_ms).toISOString(), classes: Object.keys(artifactLimits), limits: ingestLimits };
    await atomicJSON(join(this.root, 'capabilities', `${hashBytes(token)}.json`), claims);
    return { token, ...claims };
  }
  async authenticate(token) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    try {
      const claims = JSON.parse(await readFile(join(this.root, 'capabilities', `${hashBytes(token)}.json`), 'utf8'));
      return Date.parse(claims.expires_at) > this.now() && claims.league_id === this.config.leagueId ? claims : null;
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async manifest(claims, input) {
    if (!exact(input, ['version', 'run_id', 'attempt_id', 'idempotency_key', 'league_id', 'artifacts'])) throw new Error('Invalid collector manifest fields');
    const run = await this.store.read(claims.run_id, 'runs');
    if (input.version !== 1 || input.run_id !== claims.run_id || input.attempt_id !== claims.attempt_id || input.league_id !== claims.league_id || input.idempotency_key !== run.idempotency_key) throw new Error('Invalid collector manifest binding');
    if (!Array.isArray(input.artifacts) || input.artifacts.length < 3 || input.artifacts.length > ingestLimits.count) throw new Error('Invalid collector artifact count');
    let total = 0;
    for (const artifact of input.artifacts) {
      if (!exact(artifact, ['id', 'class', 'sha256', 'bytes', 'evidence_ref'])) throw new Error('Invalid collector artifact fields');
      if (!/^[A-Za-z0-9_-]{1,32}$/.test(artifact.id) || !claims.classes.includes(artifact.class)) throw new Error('Invalid collector artifact class or ID');
      if (!/^[a-f0-9]{64}$/.test(artifact.sha256) || !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 1 || artifact.bytes > artifactLimits[artifact.class]) throw new Error('Invalid collector artifact size or hash');
      if (typeof artifact.evidence_ref !== 'string' || !/^evidence\/[A-Za-z0-9_-]+\.(?:json|txt|png)$/.test(artifact.evidence_ref)) throw new Error('Invalid collector evidence reference');
      const extension = artifact.class === 'screenshot' ? '.png' : artifact.class === 'source_text' ? '.txt' : '.json';
      if (!artifact.evidence_ref.endsWith(extension)) throw new Error('Invalid collector artifact extension');
      total += artifact.bytes;
    }
    if (total > ingestLimits.total || new Set(input.artifacts.map(a => a.id)).size !== input.artifacts.length || new Set(input.artifacts.map(a => a.evidence_ref)).size !== input.artifacts.length) throw new Error('Invalid collector artifact total or duplicate');
    for (const kind of ['collector_output', 'structured_capture']) if (input.artifacts.filter(a => a.class === kind).length !== 1) throw new Error('Invalid collector output/capture count');
    await this.init();
    return this.store.publish({ ...input, id: input.attempt_id, kind: 'collector_manifest', content_hash: canonicalDigest(input) }, 'collector-manifests');
  }
  async getManifest(claims) {
    const manifest = await this.store.read(claims.attempt_id, 'collector-manifests');
    if (manifest.run_id !== claims.run_id || manifest.league_id !== claims.league_id) throw new Error('Invalid collector manifest binding');
    return manifest;
  }
  async descriptor(claims, id) {
    const descriptor = (await this.getManifest(claims)).artifacts.find(a => a.id === id);
    if (!descriptor) throw new Error('Invalid collector artifact ID');
    return descriptor;
  }
  artifactId(claims, id) { return `artifact-${claims.attempt_id}-${id}`; }
  async upload(claims, id, bytes) {
    const descriptor = await this.descriptor(claims, id);
    if (bytes.length !== descriptor.bytes || hashBytes(bytes) !== descriptor.sha256) throw new Error('Invalid collector artifact bytes or hash');
    if (descriptor.class === 'screenshot' && !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('Invalid collector screenshot format');
    if (['collector_output', 'structured_capture'].includes(descriptor.class)) JSON.parse(bytes.toString('utf8'));
    return this.store.publish({ ...descriptor, id: this.artifactId(claims, id), kind: 'collector_artifact', run_id: claims.run_id, attempt_id: claims.attempt_id, content_base64: bytes.toString('base64'), content_hash: descriptor.sha256 }, 'collector-artifacts');
  }
  async readArtifact(claims, id) {
    const descriptor = await this.descriptor(claims, id);
    const record = await this.store.read(this.artifactId(claims, id), 'collector-artifacts');
    const bytes = Buffer.from(record.content_base64, 'base64');
    if (bytes.length !== descriptor.bytes || hashBytes(bytes) !== descriptor.sha256) throw new Error('Invalid collector artifact readback');
    return bytes;
  }
  async commit(claims) {
    const operation = async () => {
      const manifest = await this.getManifest(claims);
      const run = await this.store.read(claims.run_id, 'runs');
      const artifacts = await Promise.all(manifest.artifacts.map(async a => ({ ...a, bytesRead: await this.readArtifact(claims, a.id) })));
      const output = validateCollectorOutput(JSON.parse(artifacts.find(a => a.class === 'collector_output').bytesRead.toString()));
      const captureArtifact = artifacts.find(a => a.class === 'structured_capture');
      const capture = JSON.parse(captureArtifact.bytesRead.toString());
      const captureHash = canonicalDigest(capture);
      const artifactIds = artifacts.map(artifact => this.artifactId(claims, artifact.id));
      if (output.league.id !== claims.league_id || output.team.id !== run.scope.team_id || (output.status !== 'needs_login' && canonicalDigest(output.scoring_period) !== canonicalDigest(run.scope.scoring_period))) throw new Error('Invalid collector output scope');
      if (canonicalDigest(output.allowed_pages) !== canonicalDigest(run.allowed_pages)) throw new Error('Invalid collector allowed pages');
      if (!output.extraction || output.extraction.source_hash !== captureHash) throw new Error('Invalid collector source hash');
      const derived = validateCollectorOutput(extractRosterObservation(capture, { league: output.league, team: output.team, scoring_period: run.scope.scoring_period, allowed_pages: output.allowed_pages }));
      if (canonicalDigest(output.roster) !== canonicalDigest(derived.roster) || (output.status === 'complete' && derived.status !== 'complete')) throw new Error('Invalid collector source reconciliation');
      if (Date.parse(output.source.observed_at) !== Date.parse(derived.source.observed_at)) throw new Error('Invalid collector source observation time');
      const refs = [...output.source.evidence_refs, ...output.roster.flatMap(row => row.evidence_refs), ...output.extraction.page_inventory.flatMap(page => page.evidence_refs)];
      for (const ref of refs) if (!artifacts.some(a => a.evidence_ref === ref.split('#')[0] && ['source_text', 'screenshot'].includes(a.class))) throw new Error('Invalid collector evidence reference: artifact missing');
      const observationId = `observation-${run.id.slice(4)}`;
      let observation = null, duplicate = false;
      try { observation = await this.store.read(observationId, 'observations'); duplicate = true; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!observation && output.status !== 'needs_login') {
        observation = await this.store.saveObservation({ id: observationId, source: { id: this.artifactId(claims, captureArtifact.id), hash: captureHash }, observed_at: derived.source.observed_at, observed_at_precision: 'instant', scope: run.scope, coverage: { status: output.status, note: output.coverage.note || 'All visible roster rows reconciled with preserved source artifacts.' }, parser_version: 'bounded-roster-v1', data: output, links: { evidence: artifactIds } });
      }
      if (observation) await this.store.updateCompleteObservationIndex(observation);
      let attempt;
      try { attempt = await this.store.read(claims.attempt_id, 'attempts'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!attempt) attempt = await this.store.saveRunAttempt({ id: claims.attempt_id, run_id: run.id, started_at: claims.issued_at, finished_at: new Date(this.now()).toISOString(), outcome: output.status, artifact_ids: artifactIds, observation_id: observation?.id || null, duplicate_of: duplicate ? observation.id : null, reason: output.status === 'needs_login' ? 'Human login is required; no roster dataset published.' : duplicate ? 'Logical dataset already published; duplicate attempt retained.' : 'Artifact hashes verified on private-volume readback.' });
      return { run_id: run.id, attempt_id: attempt.id, observation_id: attempt.observation_id, status: attempt.outcome, duplicate: Boolean(attempt.duplicate_of), verified: true, artifacts: manifest.artifacts.map(({ id, sha256, bytes }) => ({ id, sha256, bytes })) };
    };
    const pending = this.queue.then(operation, operation); this.queue = pending.catch(() => {}); return pending;
  }
  async readback(claims) {
    const manifest = await this.getManifest(claims);
    const artifacts = await Promise.all(manifest.artifacts.map(async a => { const bytes = await this.readArtifact(claims, a.id); return { id: a.id, sha256: hashBytes(bytes), bytes: bytes.length }; }));
    let attempt = null;
    try { attempt = await this.store.read(claims.attempt_id, 'attempts'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return { run_id: claims.run_id, attempt_id: claims.attempt_id, status: attempt?.outcome || 'uncommitted', observation_id: attempt?.observation_id || null, verified: true, artifacts };
  }
}
