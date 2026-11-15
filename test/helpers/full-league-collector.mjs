import { createHash } from 'node:crypto';
import { createCoveragePlan, assessCoverage } from '../../app/coverage.mjs';
import { canonicalDigest } from '../../app/store.mjs';

export const fullLeaguePlanInput = {
  league_id: '999',
  season: '2026',
  scoring_period: { kind: 'week', key: '5', timezone: 'America/Los_Angeles' },
  team_ids: Array.from({ length: 10 }, (_, index) => String(index + 1)),
  matchups: Array.from({ length: 5 }, (_, index) => ({ id: `matchup-${index + 1}`, team_ids: [String(index * 2 + 1), String(index * 2 + 2)] })),
  scoring_dates: Array.from({ length: 7 }, (_, index) => `2026-11-${String(index + 16)}`),
  transaction_window: { start: '2026-11-09T00:00:00Z', end: '2026-11-16T00:00:00Z' }
};

const fullLeaguePlan = createCoveragePlan(fullLeaguePlanInput);

function rowsFor(segment) {
  if (segment.expected_team_ids) return segment.expected_team_ids.map(team_id => ({ team_id, stats: { pts: 20 } }));
  if (segment.scope.dataset === 'transactions') return [];
  return [{
    player_id: 'player-1',
    team_id: segment.scope.team_id,
    stats: { pts: 20, fgm: 4, fga: 8 },
    ...(segment.scope.dataset === 'market' ? { availability: segment.filters.availability } : {}),
    ...(segment.scope.dataset === 'daily_lineup' ? { slot: 'PG' } : {}),
    ...(segment.scope.dataset === 'daily_contributions' ? { fantasy_counted: true, subsequently_dropped: true } : {})
  }];
}

function sourceUrl(segment) {
  const base = `https://basketball.fantasysports.yahoo.com/nba/${segment.scope.league_id}`;
  if (['team_roster', 'player_period_stats'].includes(segment.scope.dataset)) return `${base}/${segment.scope.team_id}`;
  if (['daily_lineup', 'daily_contributions'].includes(segment.scope.dataset)) return `${base}/${segment.scope.team_id}?date=${segment.scope.scoring_period.key}`;
  if (segment.scope.dataset === 'matchups') return `${base}/matchup`;
  if (segment.scope.dataset === 'team_period_stats') return `${base}/teamstats`;
  if (segment.scope.dataset === 'market') return `${base}/players?status=${segment.filters.availability}`;
  return `${base}/transactions`;
}

function completeFragments(collectionId = 'collection-2026-week-5', sourceHash = 'a'.repeat(64)) {
  return fullLeaguePlan.segments.map(segment => ({
    id: `capture-${segment.id}`,
    collection_id: collectionId,
    segment_id: segment.id,
    scope: structuredClone(segment.scope),
    filters: structuredClone(segment.filters),
    page_key: 'first',
    terminal: true,
    next_page_key: null,
    status: 'complete',
    observed_at: '2026-11-16T00:00:00Z',
    source: { id: 'source-bundle', url: sourceUrl(segment), hash: sourceHash },
    evidence_refs: ['evidence/source.txt'],
    rows: rowsFor(segment),
    reported_total_rows: rowsFor(segment).length
  }));
}

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function fullLeagueBundle(run, attemptId = 'collector-full-league') {
  const source = Buffer.from('Synthetic bounded Yahoo league source tables');
  const sourceHash = sha256(source);
  const fragments = completeFragments(run.id, sourceHash);
  const capture = { version: 1, plan: fullLeaguePlan, fragments };
  const captureBytes = Buffer.from(JSON.stringify(capture));
  const coverage = assessCoverage(fullLeaguePlan, fragments);
  const output = {
    contract_version: 2,
    collector_mode: 'observation_only',
    decision_output: false,
    status: coverage.status,
    league: { id: '999', name: 'Synthetic League' },
    collection_id: run.id,
    plan_hash: canonicalDigest(fullLeaguePlan),
    allowed_pages: run.allowed_pages,
    source: { observed_at: '2026-11-16T00:00:00Z', evidence_refs: ['evidence/source.txt'], source_hash: canonicalDigest(capture) },
    fragment_count: fragments.length,
    coverage_hash: canonicalDigest(coverage),
    login: { required: false, challenge: null },
    warnings: []
  };
  const files = [
    { id: 'output', class: 'collector_output', evidence_ref: 'evidence/output.json', bytes: Buffer.from(JSON.stringify(output)) },
    { id: 'capture', class: 'structured_capture', evidence_ref: 'evidence/capture.json', bytes: captureBytes },
    { id: 'source', class: 'source_text', evidence_ref: 'evidence/source.txt', bytes: source }
  ];
  const manifest = {
    version: 1,
    run_id: run.id,
    attempt_id: attemptId,
    idempotency_key: run.idempotency_key,
    league_id: '999',
    artifacts: files.map(file => ({ id: file.id, class: file.class, evidence_ref: file.evidence_ref, bytes: file.bytes.length, sha256: sha256(file.bytes) }))
  };
  return { files, manifest, output, capture };
}
