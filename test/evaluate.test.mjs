import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateForecast, summarizeEvaluations } from '../app/evaluate.mjs';

const stats = pts => ({ fgm: pts / 2, fga: pts, ftm: 2, fta: 4, three_pm: 3, pts, oreb: 2, reb: 8, ast: 6, stl: 2, blk: 1 });
const forecast = (id = 'forecast-1', pts = 100) => ({
  id,
  created_at: '2026-11-10T12:00:00Z',
  forecast: {
    league_id: '123', season: '2026', week: 4, source_snapshot_ids: ['source-forecast'],
    teams: ['a', 'b'].map((teamId, index) => ({
      id: teamId, name: teamId.toUpperCase(),
      range: { lower: { stats: stats(pts + index * 10 - 5), usable_starts: 15 }, upper: { stats: stats(pts + index * 10 + 5), usable_starts: 17 } }
    })),
    matchups: [{ id: 'm1', team_ids: ['a', 'b'] }]
  }
});
const outcome = (status = 'final', pts = 103) => ({
  id: 'outcome-1', status, finalized_at: status === 'final' ? '2026-11-17T08:00:00Z' : null,
  source_snapshot_ids: ['source-outcome'], expected_matchups: 1,
  matchups: [{ id: 'm1', status, teams: [{ id: 'a', stats: stats(pts), usable_starts: 16 }, { id: 'b', stats: stats(112), usable_starts: 16 }] }]
});

test('forecast evaluation measures range hits, midpoint error and baseline improvement', () => {
  const result = evaluateForecast({ forecast_record: forecast(), outcome: outcome(), baseline_record: forecast('baseline-1', 80) });
  const points = result.matchups[0].teams[0].categories.pts;
  assert.equal(result.status, 'final');
  assert.equal(result.correlation_key, '123:2026:4');
  assert.deepEqual(result.source_snapshot_ids, ['source-forecast', 'source-outcome']);
  assert.equal(points.actual, 103);
  assert.equal(points.in_range, true);
  assert.equal(points.absolute_error, 3);
  assert.equal(points.baseline_absolute_error, 23);
  assert.equal(points.beat_baseline, true);
});

test('incomplete outcomes remain provisional and cannot become validation evidence', () => {
  const result = evaluateForecast({ forecast_record: forecast(), outcome: outcome('provisional') });
  assert.equal(result.status, 'provisional');
  assert.equal(result.independent_validation_units, 0);
  assert.ok(result.caveats.some(value => /not final/i.test(value)));
});

test('repeated forecast origins are summarized as one independent validation week', () => {
  const first = evaluateForecast({ forecast_record: forecast('forecast-1'), outcome: outcome() });
  const second = evaluateForecast({ forecast_record: forecast('forecast-2', 101), outcome: outcome() });
  const summary = summarizeEvaluations([{ id: 'evaluation-1', ...first }, { id: 'evaluation-2', ...second }]);
  assert.equal(summary.origins, 2);
  assert.equal(summary.independent_validation_weeks, 1);
  assert.equal(summary.groups[0].evaluation_ids.length, 2);
});
