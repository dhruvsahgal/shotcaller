import { assessCoverage, createCoveragePlan, segmentObservation } from './coverage.mjs';
import { canonicalDigest } from './store.mjs';
import { strictInstant } from './time.mjs';
import { isPlainObject } from './value.mjs';
import { collectorLoginChallenges, validateCollectorRequest } from '../scripts/validate-collector-output.mjs';

const fragmentKeys = ['id', 'collection_id', 'segment_id', 'scope', 'filters', 'page_key', 'terminal', 'next_page_key', 'status', 'observed_at', 'source', 'evidence_refs', 'reported_total_rows', 'rows'];
const maximumPastSkewMs = 24 * 60 * 60_000;
const maximumFutureSkewMs = 60 * 60_000;

function exactKeys(value, keys, label) {
  if (!isPlainObject(value) || Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key))) throw new Error(`Invalid ${label}`);
}

function evidenceArtifacts(refs, artifacts) {
  const ids = [];
  for (const ref of refs) {
    const base = ref.split('#')[0];
    const artifact = artifacts.find(candidate => candidate.evidence_ref === base && ['source_text', 'screenshot'].includes(candidate.class));
    if (!artifact) throw new Error('Invalid collector evidence reference: artifact missing');
    ids.push(artifact.artifact_id);
  }
  return [...new Set(ids)];
}

export function validateLeagueCollectorBundle({ output, capture, run, artifacts }) {
  exactKeys(capture, ['version', 'plan', 'fragments'], 'league structured capture');
  if (capture.version !== 1 || !Array.isArray(capture.fragments)) throw new Error('Invalid league structured capture');
  const plan = createCoveragePlan(capture.plan);
  if (!run.collection_plan || canonicalDigest(plan) !== canonicalDigest(run.collection_plan)) throw new Error('Invalid collector collection plan');

  exactKeys(output, ['contract_version', 'collector_mode', 'decision_output', 'status', 'league', 'collection_id', 'plan_hash', 'allowed_pages', 'source', 'fragment_count', 'coverage_hash', 'login', 'warnings'], 'league collector output');
  if (output.contract_version !== 2 || output.collector_mode !== 'observation_only' || output.decision_output !== false) throw new Error('Invalid league collector contract');
  if (!['complete', 'partial', 'needs_login'].includes(output.status)) throw new Error('Invalid league collector status');
  exactKeys(output.league, ['id', 'name'], 'league collector identity');
  if (output.league.id !== run.scope.league_id || typeof output.league.name !== 'string' || !output.league.name.trim()) throw new Error('Invalid league collector identity');
  if (output.collection_id !== run.id) throw new Error('Invalid league collection identity');
  if (output.plan_hash !== canonicalDigest(plan) || canonicalDigest(output.allowed_pages) !== canonicalDigest(run.allowed_pages)) throw new Error('Invalid league collector scope');
  if (!Number.isSafeInteger(output.fragment_count) || output.fragment_count !== capture.fragments.length) throw new Error('Invalid league collector source reconciliation');
  exactKeys(output.source, ['observed_at', 'evidence_refs', 'source_hash'], 'league collector source');
  if (!strictInstant(output.source.observed_at) || output.source.source_hash !== canonicalDigest(capture) || !Array.isArray(output.source.evidence_refs) || !output.source.evidence_refs.length) throw new Error('Invalid league collector source');
  evidenceArtifacts(output.source.evidence_refs, artifacts);
  if (!Array.isArray(output.warnings) || output.warnings.some(value => typeof value !== 'string' || !value.trim())) throw new Error('Invalid league collector warnings');
  exactKeys(output.login, ['required', 'challenge'], 'league collector login');

  const coverage = assessCoverage(plan, capture.fragments);
  const usableRows = capture.fragments.reduce((sum, fragment) => sum + (Array.isArray(fragment?.rows) ? fragment.rows.length : 0), 0);
  if (output.status !== 'needs_login' && usableRows === 0) throw new Error('Invalid league collector usable rows: observed pages produced no normalized data');
  if (output.coverage_hash !== canonicalDigest(coverage)) throw new Error('Invalid league collector coverage reconciliation');
  if (output.status === 'needs_login') {
    if (output.login.required !== true || !collectorLoginChallenges.has(output.login.challenge) || capture.fragments.length !== 0 || coverage.status !== 'unknown') throw new Error('Invalid league collector login receipt');
  } else {
    if (output.login.required !== false || output.login.challenge !== null || output.status !== coverage.status) throw new Error('Invalid league collector coverage status');
    const latestObservedAt = capture.fragments.map(fragment => fragment.observed_at).filter(strictInstant).sort().at(-1);
    if (!latestObservedAt || Date.parse(output.source.observed_at) !== Date.parse(latestObservedAt)) throw new Error('Invalid league collector source observation time');
    if (output.status === 'complete' && output.warnings.length) throw new Error('Complete league collector output cannot contain warnings');
  }

  const fragmentEvidence = new Map();
  for (const fragment of capture.fragments) {
    exactKeys(fragment, fragmentKeys, 'league fragment');
    exactKeys(fragment.source, ['id', 'url', 'hash'], 'league fragment source');
    if (fragment.collection_id !== output.collection_id) throw new Error('Invalid league fragment collection identity');
    const observedAt = Date.parse(fragment.observed_at), intendedFor = Date.parse(run.intended_for);
    if (!Number.isFinite(observedAt) || observedAt < intendedFor - maximumPastSkewMs || observedAt > intendedFor + maximumFutureSkewMs) throw new Error('Invalid league fragment observation time');
    if (!validateCollectorRequest({ method: 'GET', url: fragment.source.url, allowedPages: run.allowed_pages }).allowed) throw new Error('Invalid league fragment source page');
    const ids = evidenceArtifacts(fragment.evidence_refs, artifacts);
    const sourceArtifact = artifacts.find(candidate => ids.includes(candidate.artifact_id) && candidate.sha256 === fragment.source?.hash);
    if (!sourceArtifact) throw new Error('Invalid league fragment source hash');
    fragmentEvidence.set(fragment.id, ids);
  }
  return { plan, coverage, fragments: capture.fragments, fragmentEvidence };
}

export const leagueCoverageObservationId = runId => `observation-${runId.slice(4)}-coverage`;

export function leagueObservations({ run, validation, captureArtifactId, captureHash, artifactIds }) {
  const coverageId = leagueCoverageObservationId(run.id);
  const bySegment = new Map(validation.plan.segments.map(segment => [segment.id, segment]));
  const fragmentsBySegment = new Map();
  for (const fragment of validation.fragments) {
    if (!fragmentsBySegment.has(fragment.segment_id)) fragmentsBySegment.set(fragment.segment_id, []);
    fragmentsBySegment.get(fragment.segment_id).push(fragment);
  }
  const observations = [];
  for (const [segmentId, fragments] of fragmentsBySegment) {
    const segment = bySegment.get(segmentId);
    if (!segment) throw new Error('Invalid league fragment segment');
    const id = `observation-${run.id.slice(4, 20)}-${segment.id.slice(8, 24)}`;
    const observation = segmentObservation({ id, segment, fragments, source_id: captureArtifactId });
    observation.commit_id = coverageId;
    observation.source.hash = captureHash;
    observation.links.evidence = [...new Set(fragments.flatMap(fragment => validation.fragmentEvidence.get(fragment.id) ?? []))];
    observations.push(observation);
  }
  const coverageObservation = {
    id: coverageId,
    source: { id: captureArtifactId, hash: captureHash },
    observed_at: validation.fragments.map(fragment => fragment.observed_at).filter(strictInstant).sort().at(-1),
    observed_at_precision: 'instant',
    scope: structuredClone(run.scope),
    coverage: { status: validation.coverage.status, note: validation.coverage.status === 'complete' ? 'Every declared league dataset segment reconciled with preserved source evidence.' : 'League coverage is incomplete; inspect dataset and segment status before analysis.' },
    parser_version: 'full-league-bundle-v1',
    data: { plan: validation.plan, fragments: validation.fragments },
    links: { evidence: artifactIds }
  };
  return { observations, coverageObservation };
}
