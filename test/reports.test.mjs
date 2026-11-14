import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildWeeklyReport, renderWeeklyReport } from '../app/reports.mjs';
import { Store } from '../app/store.mjs';

const categories = { fgm: 50, fga: 100, fg_pct: .01, ftm: 80, fta: 100, ft_pct: .01, three_pm: 40, pts: 400, oreb: 35, reb: 150, ast: 100, stl: 30, blk: 20 };
const matchup = (index, status = 'final') => ({ id: `m${index}`, status, source_snapshot_ids: [`outcome-${index}`], teams: [
  { id: `t${index * 2}`, name: `Team ${index * 2}`, stats: { ...categories, pts: 400 + index } },
  { id: `t${index * 2 + 1}`, name: `Team ${index * 2 + 1}`, stats: { ...categories, pts: 390 - index } }
] });
const input = () => ({
  league_id: '123', season: '2026', week: 4, expected_matchups: 99,
  frozen_matchup_topology: Array.from({ length: 5 }, (_, index) => ({ id: `m${index}`, team_ids: [`t${index * 2}`, `t${index * 2 + 1}`] })),
  matchup_topology_source_id: 'forecast-week-4',
  matchups: Array.from({ length: 5 }, (_, index) => matchup(index)),
  evaluations: [{ id: 'evaluation-1', status: 'final', correlation_key: '123:2026:4:m0', source_snapshot_ids: ['forecast-1'] }],
  decisions: [{ id: 'decision-acted', task: 'plan_optimization', answer: 'Add A' }, { id: 'decision-only', task: 'plan_optimization', answer: 'Add B' }],
  actions: [{ id: 'forged-action', decision_id: 'decision-only', status: 'verified', source_snapshot_ids: ['forged-source'] }],
  trusted_action_outcomes: [{ kind: 'action_outcome', id: 'outcome-1', intent_id: 'action-1', attempt_id: 'attempt-1', execution_mode: 'live', outcome: 'applied', requires_reconciliation: false, before_evidence_ids: ['action-before'], after_evidence_ids: ['action-after'] }],
  trusted_decision_action_links: [{ decision_id: 'decision-acted', intent_id: 'action-1', outcome_id: 'outcome-1' }],
  season_history_ids: ['season-history-v2', 'season-history-v1'], previous_report_id: 'report-week-3',
  lineup_days: [{ date: '2026-11-12', benched_with_game: ['Player X', 'Player Y'], source_snapshot_ids: ['lineup-source'] }],
  recap_decision: { id: 'recap-1', task: 'recap_draft', answer: 'League recap draft', snapshot_ids: ['recap-source'] }
});

test('weekly report is provisional until all five matchups are final', () => {
  const value = input();
  value.matchups[4] = matchup(4, 'provisional');
  const report = buildWeeklyReport(value);
  assert.equal(report.status, 'provisional');
  assert.match(report.caveats.join(' '), /not final/i);
});

test('weekly report separates verified actions, unexecuted advice and draft recap', () => {
  const report = buildWeeklyReport(input());
  assert.equal(report.status, 'final');
  assert.deepEqual(report.decision_review.verified.map(row => row.decision_id), ['decision-acted']);
  assert.deepEqual(report.decision_review.unexecuted.map(row => row.id), ['decision-only']);
  assert.equal(report.lost_starts.total, 2);
  assert.deepEqual(report.all_play.find(row => row.team_id === 't0').all_play, { wins: 5, losses: 4, ties: 0, incomplete: 0 });
  assert.equal(report.recap.status, 'draft');
  assert.equal(report.recap.authorized_for_sending, false);
  assert.ok(report.source_snapshot_ids.includes('action-after'));
  assert.equal(report.source_snapshot_ids.includes('forged-source'), false);
  assert.deepEqual(report.season_history_ids, ['season-history-v1', 'season-history-v2']);
  assert.equal(report.previous_report_id, 'report-week-3');
  assert.equal(report.matchups[0].teams[0].stats.fg_pct, .01);
  assert.equal(report.all_play[0].category_ranks.fg_pct, 1);
  assert.match(renderWeeklyReport(report), /PROVISIONAL|FINAL/);
});

test('weekly report cannot be final for empty, duplicate or incomplete matchup topology', () => {
  const empty = input();
  empty.frozen_matchup_topology = [];
  empty.matchups = [];
  assert.equal(buildWeeklyReport(empty).status, 'provisional');

  const duplicate = input();
  duplicate.matchups[4] = structuredClone(duplicate.matchups[3]);
  assert.equal(buildWeeklyReport(duplicate).status, 'provisional');
  assert.match(buildWeeklyReport(duplicate).caveats.join(' '), /duplicate/i);

  const incomplete = input();
  incomplete.matchups.pop();
  assert.equal(buildWeeklyReport(incomplete).status, 'provisional');
  assert.match(buildWeeklyReport(incomplete).caveats.join(' '), /do not exactly match/i);
});

test('missing shooting attempts produce explicit partial coverage', () => {
  const value = input();
  delete value.matchups[0].teams[0].stats.fga;
  const report = buildWeeklyReport(value);
  assert.equal(report.status, 'partial');
  assert.equal(report.category_coverage.complete, false);
  assert.deepEqual(report.category_coverage.missing[0], { matchup_id: 'm0', team_id: 't0', category: 'fg_pct' });
  assert.match(report.caveats.join(' '), /finite makes and attempts/i);
});

test('forged verified action labels cannot enter the applied decision review', () => {
  const value = input();
  value.decisions = [{ id: 'forged-decision', task: 'plan_optimization' }];
  value.actions = [{ id: 'forged', decision_id: 'forged-decision', status: 'verified' }];
  value.trusted_action_outcomes = [];
  value.trusted_decision_action_links = [];
  const report = buildWeeklyReport(value);
  assert.deepEqual(report.decision_review.verified, []);
  assert.deepEqual(report.decision_review.unexecuted.map(row => row.id), ['forged-decision']);
});

test('a corrected report appends an immutable version and preserves the original', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shotcaller-report-'));
  const store = new Store(root);
  const original = await store.saveReport(buildWeeklyReport(input()));
  const correctedInput = input();
  correctedInput.correction_of = original.id;
  correctedInput.matchups[0].teams[0].stats.pts = 999;
  const corrected = await store.saveReport(buildWeeklyReport(correctedInput));
  assert.notEqual(corrected.id, original.id);
  assert.equal(corrected.report.correction_of, original.id);
  assert.equal((await store.read(original.id, 'reports')).report.matchups[0].teams[0].stats.pts, 400);
  assert.match(await readFile(join(root, 'reports', corrected.id, 'brief.md'), 'utf8'), /Corrects:/);
  const seasonIndex = JSON.parse(await readFile(join(root, 'indexes', 'season-2026.json'), 'utf8'));
  assert.deepEqual(seasonIndex.reports.map(row => row.id), [original.id, corrected.id]);
  assert.match(await readFile(join(root, 'indexes', 'season-2026.md'), 'utf8'), new RegExp(corrected.id));
});
