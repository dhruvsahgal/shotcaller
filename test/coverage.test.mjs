import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCoveragePlan, assessCoverage, assessSegment, pendingSegments, dailyContributions, createPilotAudit, selectAuditSamples, pilotReport, segmentObservation, coverageDatasets } from '../app/coverage.mjs';
import { collectDatasetSegment } from '../app/collector.mjs';
import { buildOverview } from '../app/overview.mjs';

const teams = Array.from({ length: 10 }, (_, index) => `team-${index + 1}`);
const dates = Array.from({ length: 7 }, (_, index) => `2026-11-${String(index + 16)}`);
const input = { league_id: '999', season: '2026', scoring_period: { kind: 'week', key: '5', timezone: 'America/Los_Angeles' }, team_ids: teams, matchups: Array.from({ length: 5 }, (_, index) => ({ id: `matchup-${index + 1}`, team_ids: teams.slice(index * 2, index * 2 + 2) })), scoring_dates: dates, transaction_window: { start: '2026-11-09T00:00:00Z', end: '2026-11-16T00:00:00Z' } };
const plan = createCoveragePlan(input);
const segment = dataset => plan.segments.find(s => s.scope.dataset === dataset);
function rowsFor(spec) {
  if (spec.expected_team_ids) return spec.expected_team_ids.map(team_id => ({ team_id, stats: { pts: 20 } }));
  if (spec.scope.dataset === 'transactions') return [];
  return [{ player_id: 'player-1', team_id: spec.scope.team_id, stats: { pts: 20, fgm: 4, fga: 8 }, ...(spec.scope.dataset === 'market' ? { availability: spec.filters.availability } : {}), ...(spec.scope.dataset === 'daily_lineup' ? { slot: 'PG' } : {}), ...(spec.scope.dataset === 'daily_contributions' ? { fantasy_counted: true, subsequently_dropped: true } : {}) }];
}
function fragment(spec, overrides = {}) {
  const rows = rowsFor(spec);
  return { id: `capture-${spec.id}`, collection_id: 'run-1', segment_id: spec.id, scope: structuredClone(spec.scope), filters: structuredClone(spec.filters), page_key: 'first', terminal: true, next_page_key: null, status: 'complete', observed_at: '2026-11-16T00:00:00Z', source: { id: `source-${spec.id}`, hash: 'a'.repeat(64) }, evidence_refs: ['table#main'], rows, reported_total_rows: rows.length, ...overrides };
}

test('full league plan requires ten rosters, five pairings, all periods, seven dates and both availability filters', () => {
  assert.equal(plan.segments.filter(s => s.scope.dataset === 'team_roster').length, 10);
  assert.equal(plan.segments.filter(s => s.scope.dataset === 'matchups').length, 5);
  assert.equal(plan.segments.filter(s => s.scope.dataset === 'daily_lineup').length, 70);
  assert.equal(plan.segments.filter(s => s.scope.dataset === 'daily_contributions').length, 70);
  assert.deepEqual(plan.segments.filter(s => s.scope.dataset === 'market').map(s => s.filters.availability), ['FA', 'W']);
  assert.throws(() => createCoveragePlan({ ...input, matchups: input.matchups.slice(0, 1) }), /five pairings/);
  assert.throws(() => createCoveragePlan({ ...input, scoring_dates: [...dates.slice(0, 6), '2026-11-25'] }), /consecutive/);
  const oneMatchup = assessCoverage(plan, [fragment(segment('matchups'))]);
  assert.deepEqual(oneMatchup.datasets.find(d => d.dataset === 'matchups'), { dataset: 'matchups', status: 'partial', expected_segments: 5, complete_segments: 1 });
  assert.equal(oneMatchup.datasets.find(d => d.dataset === 'team_roster').status, 'unknown');
  assert.equal(assessCoverage(plan, plan.segments.map(s => fragment(s))).status, 'complete');
  const mixed = plan.segments.map((s, index) => fragment(s, { collection_id: index ? 'run-2' : 'run-1' }));
  assert.equal(assessCoverage(plan, mixed).status, 'partial');
  assert.deepEqual(assessCoverage(plan, mixed).collection_ids, ['run-1', 'run-2']);
  assert.equal(assessCoverage(plan, mixed).datasets.every(dataset => dataset.complete_segments === 0), true);
});

test('missing terminal, repeating pages, repeated rows and incomplete chains cannot advance completeness', () => {
  const spec = segment('market');
  const first = fragment(spec, { terminal: false, next_page_key: 'page-2', reported_total_rows: 2 });
  const second = fragment(spec, { id: 'capture-page-2', page_key: 'page-2', rows: [{ player_id: 'player-2', availability: 'FA' }], reported_total_rows: 2 });
  assert.equal(assessSegment(spec, [first]).status, 'partial');
  assert.equal(assessSegment(spec, [first]).resume_page_key, 'page-2');
  assert.equal(assessSegment(spec, [first, second]).status, 'complete');
  assert.equal(assessSegment(spec, [first, { ...second, terminal: false, next_page_key: null }]).status, 'partial');
  assert.match(assessSegment(spec, [first, first]).issues.join(' '), /Repeated pagination/);
  assert.match(assessSegment(spec, [first, { ...second, rows: first.rows }]).issues.join(' '), /Repeated row/);
  assert.equal(assessSegment(spec, [second]).status, 'partial');
  assert.equal(assessSegment(spec, [fragment(spec, { reported_total_rows: 9 })]).status, 'partial');
});

test('date, filter, team and collection changes between fragments remain partial with a required restart', () => {
  const spec = segment('market');
  const first = fragment(spec, { terminal: false, next_page_key: 'page-2' });
  for (const change of [{ filters: { availability: 'W' } }, { scope: { ...spec.scope, scoring_period: { ...spec.scope.scoring_period, key: '6' } } }, { collection_id: 'other-run' }]) {
    const output = assessSegment(spec, [first, fragment(spec, { id: 'two', page_key: 'page-2', rows: [], ...change })]);
    assert.equal(output.status, 'partial');
    assert.equal(output.resume_page_key, null);
  }
  const pair = segment('matchups');
  assert.equal(assessSegment(pair, [fragment(pair, { rows: [{ team_id: 'wrong', stats: { pts: 20 } }] })]).status, 'partial');
});

test('bounded collection resumes only its failed dataset without recollecting completed pages or other teams', async () => {
  const spec = segment('market');
  const seen = [];
  const first = await collectDatasetSegment({ segment: spec, limits: { max_steps: 1 }, observe: async request => {
    seen.push(request.page_key);
    return fragment(spec, { terminal: false, next_page_key: 'page-2' });
  } });
  assert.equal(first.status, 'partial');
  const resumed = await collectDatasetSegment({ segment: spec, fragments: first.fragments, observe: async request => {
    seen.push(request.page_key);
    return fragment(spec, { id: 'capture-2', page_key: 'page-2', rows: [] });
  } });
  assert.equal(resumed.status, 'complete');
  assert.deepEqual(seen, ['first', 'page-2']);
  assert.equal(pendingSegments(plan, resumed.fragments).some(s => s.id === spec.id), false);
  assert.ok(pendingSegments(plan, resumed.fragments).some(s => s.scope.dataset === 'team_roster'));
});

test('daily earned stats retain dropped players and publish as a period-scoped observation without roster reconstruction', () => {
  const spec = segment('daily_contributions');
  const captured = fragment(spec);
  const day = dailyContributions(plan, [captured]).find(d => d.team_id === spec.scope.team_id && d.scoring_date === spec.scope.scoring_period.key);
  assert.equal(day.players[0].subsequently_dropped, true);
  assert.equal(day.players[0].stats.pts, 20);
  const observation = segmentObservation({ id: 'observation-earned', segment: spec, fragments: [captured], source_id: 'fragment-bundle' });
  assert.equal(observation.scope.scoring_period.kind, 'date');
  assert.equal(observation.coverage.status, 'complete');
  assert.deepEqual(observation.links.evidence, [captured.source.id]);
  assert.equal(assessSegment(spec, [fragment(spec, { filters: { fantasy_counted: true, include_dropped: false } })]).status, 'partial');
});

test('pilot preregisters fourteen attempts and requires source comparisons, transition reviews and cost/access evidence', () => {
  const scheduled = dates.flatMap(date => [0, 1].map(slot => ({ id: `run-${date}-${slot}`, scoring_date: date })));
  const audit = createPilotAudit({ start_date: dates[0], scheduled_attempts: scheduled, sample_seed: 'seed-before-pilot' });
  assert.equal(audit.matrix.length, 56);
  assert.throws(() => createPilotAudit({ start_date: dates[0], scheduled_attempts: scheduled.slice(1), sample_seed: 'seed' }), /scheduled/);
  const all = plan.segments.map(s => fragment(s));
  const samples = selectAuditSamples(audit, scheduled[0].id, all);
  assert.equal(samples.length, 8);
  assert.deepEqual(selectAuditSamples(audit, scheduled[0].id, all), samples);
  const attempts = scheduled.map(slot => ({ ...slot, outcome: 'complete', coverage: assessCoverage(plan, all), runtime_ms: 100, token_count: 200, compute_cost: .01, login_interventions: 0, independent_review: { passed: true, reviewer_id: 'human-reviewer', reviewed_at: '2026-11-23T00:00:00Z', source_compared: true, sample_seed: audit.sample_seed, datasets_checked: coverageDatasets, mismatches: [] } }));
  assert.equal(pilotReport(audit, attempts).status, 'passed');
  assert.equal(pilotReport(audit, attempts.slice(1)).status, 'not_passed');
  assert.match(pilotReport(audit, []).failures.join(' '), /access\/capacity/);
  attempts[0].partial_to_complete = true;
  assert.match(pilotReport(audit, attempts).failures.join(' '), /transition/);
  attempts[0].independent_review.transition_checked = true;
  attempts[0].independent_review.mismatches = ['Wrong scoring date'];
  assert.match(pilotReport(audit, attempts).failures.join(' '), /restart seven-day/);
  delete attempts[0].compute_cost;
  assert.match(pilotReport(audit, attempts).failures.join(' '), /missing compute_cost/);
});

test('dashboard exposes unknown coverage and derives saved coverage from fragments, never a claimed complete flag', () => {
  const empty = buildOverview();
  assert.equal(empty.dataset_coverage.status, 'unknown');
  assert.equal(empty.dataset_coverage.datasets.length, 8);
  const record = { id: 'league-report', kind: 'observation', observed_at: '2026-11-16T00:00:00Z', scope: { ...segment('market').scope, dataset: 'league_coverage' }, coverage: { status: 'complete' }, data: { plan, fragments: [fragment(segment('matchups'))] } };
  const output = buildOverview([], [], '999', [record]);
  assert.equal(output.dataset_coverage.status, 'partial');
  assert.equal(buildOverview([], [], 'other', [record]).dataset_coverage.status, 'unknown');
});

test('malformed evidence and over-budget final pages stay partial; claimed manifests cannot shrink required coverage', async () => {
  const spec = segment('market');
  assert.equal(assessSegment(spec, [null]).status, 'partial');
  assert.equal(assessSegment(spec, [fragment(spec, { rows: { invalid: true } })]).status, 'partial');
  const bounded = await collectDatasetSegment({ segment: spec, limits: { max_source_tokens: 1 }, observe: async () => fragment(spec) });
  assert.equal(bounded.status, 'partial');
  assert.equal(assessSegment(spec, bounded.fragments).status, 'partial');
  const record = { id: 'invalid-manifest', kind: 'observation', observed_at: '2026-11-16T00:00:00Z', scope: { ...spec.scope, dataset: 'league_coverage' }, coverage: { status: 'complete' }, data: { plan: { ...plan, segments: [spec] }, fragments: [fragment(spec)] } };
  assert.equal(buildOverview([], [], '999', [record]).dataset_coverage.status, 'unknown');
  const first = fragment(spec, { terminal: false, next_page_key: 'page-2', reported_total_rows: 2 });
  assert.equal(assessSegment(spec, [first]).resume_page_key, 'page-2');
});
