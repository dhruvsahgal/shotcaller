import { test } from 'node:test';
import assert from 'node:assert/strict';
import { optimizePlans } from '../app/optimize.mjs';

const stats = (pts, overrides = {}) => ({ fgm: 4, fga: 8, ftm: 2, fta: 2, three_pm: 1, pts, oreb: 1, reb: 5, ast: 4, stl: 1, blk: 1, ...overrides });
const zeroStats = () => stats(0, { fgm: 0, fga: 0, ftm: 0, fta: 0, three_pm: 0, oreb: 0, reb: 0, ast: 0, stl: 0, blk: 0 });
const game = starts_at => ({ starts_at, source_ids: ['capture-1'] });
const player = (id, pts, games = [game('2026-11-15T03:00:00Z')]) => ({
  id, name: id, eligible_positions: ['PG'], baseline: stats(pts), games,
  availability: { status: 'available', observed_at: '2026-11-14T00:00:00Z', source_ids: ['capture-1'] }
});
const forecastInput = () => ({
  schema_version: 1, kind: 'forecast_input', league_id: '123', season: '2026', week: 4,
  as_of: '2026-11-14T00:00:00Z', scoring_timezone: 'America/Los_Angeles', expected_teams: 2,
  period: { start_date: '2026-11-09', end_date: '2026-11-16' }, source_snapshot_ids: ['capture-1'],
  roster_slots: ['PG'], matchups: [{ id: 'm1', team_ids: ['mine', 'other'] }], teams: [
    { id: 'mine', name: 'Mine', actual: { stats: zeroStats(), source_ids: ['capture-1'] }, players: [player('roster', 10)] },
    { id: 'other', name: 'Other', actual: { stats: zeroStats(), source_ids: ['capture-1'] }, players: [player('opponent', 12)] }
  ]
});
const opportunity = (id, candidate, overrides = {}) => ({
  id, group_id: id, mode: 'now', candidate, drop_player_id: 'roster',
  effective_at: '2026-11-14T00:05:00Z', decision_deadline: '2026-11-14T23:00:00Z',
  availability: { state: 'available', observed_at: '2026-11-14T00:00:00Z', source_ids: ['capture-1'] },
  consumes_acquisitions: 1, replacement_value: 0, next_matchup_value: 0, claim_risk: 0, ...overrides
});
const input = () => ({
  schema_version: 1, kind: 'optimization_input', created_at: '2026-11-14T00:00:00Z', manager_team_id: 'mine',
  forecast_input: forecastInput(), acquisitions_remaining: 2, max_roster_size: 1, min_plan_value: 0.01,
  max_availability_age_hours: 12, opportunities: []
});
const optimize = value => optimizePlans(value, { receivedAt: value.created_at });

test('a raw scheduled game gets no start credit when it cannot enter the lineup', () => {
  const value = input();
  value.forecast_input.teams[0].players.push(player('locked-star', 40));
  value.max_roster_size = 2;
  value.opportunities = [opportunity('crowded', player('candidate', 8), { drop_player_id: 'roster' })];
  const plan = optimize(value).plans.find(row => row.opportunity_ids.includes('crowded'));
  assert.equal(plan.comparison.usable_starts_delta, 0);
  assert.equal(plan.comparison.raw_scheduled_games_credited, 0);
});

test('waiting can retain todays start and add tomorrows eligible start', () => {
  const value = input();
  value.forecast_input.teams[0].players[0].games = [game('2026-11-14T04:00:00Z')];
  const candidate = player('candidate', 15, [game('2026-11-15T04:00:00Z')]);
  value.opportunities = [
    opportunity('now', candidate, { group_id: 'candidate-choice', effective_at: '2026-11-14T01:00:00Z' }),
    opportunity('wait', candidate, { group_id: 'candidate-choice', mode: 'wait', effective_at: '2026-11-14T12:00:00Z' })
  ];
  const result = optimize(value);
  const now = result.plans.find(row => row.opportunity_ids[0] === 'now');
  const wait = result.plans.find(row => row.opportunity_ids[0] === 'wait');
  assert.equal(wait.comparison.usable_starts_delta, now.comparison.usable_starts_delta + 1);
});

test('illegal IL activation and stale or claimed candidates are excluded with refresh reasons', () => {
  const value = input();
  value.opportunities = [
    opportunity('activate', player('il-player', 20), { drop_player_id: null, consumes_acquisitions: 0, requires_open_roster_slot: true }),
    opportunity('claimed', player('claimed-player', 20), { availability: { state: 'claimed', observed_at: '2026-11-14T00:00:00Z', source_ids: ['capture-1'] } }),
    opportunity('stale', player('stale-player', 20), { availability: { state: 'available', observed_at: '2026-11-12T00:00:00Z', source_ids: ['capture-1'] } })
  ];
  const result = optimize(value);
  assert.deepEqual(result.plans.map(row => row.kind), ['hold']);
  assert.match(result.rejected.find(row => row.opportunity_id === 'activate').reason, /roster slot/i);
  assert.match(result.rejected.find(row => row.opportunity_id === 'claimed').reason, /refresh availability/i);
  assert.match(result.rejected.find(row => row.opportunity_id === 'stale').reason, /stale/i);
});

test('the complete acquisition path can beat an early single add and preserve a reserve', () => {
  const value = input();
  value.max_roster_size = 2;
  value.forecast_input.teams[0].players.push(player('second-drop', 2, [game('2026-11-16T03:00:00Z')]));
  value.forecast_input.roster_slots = ['PG', 'UTIL'];
  value.opportunities = [
    opportunity('small-now', player('small', 11), { replacement_value: 0.2 }),
    opportunity('late-swing', player('swing', 30, [game('2026-11-16T03:00:00Z')]), { drop_player_id: 'second-drop', effective_at: '2026-11-15T00:00:00Z', decision_deadline: '2026-11-14T18:00:00Z', replacement_value: 3 })
  ];
  const result = optimize(value);
  assert.deepEqual(result.recommendation.opportunity_ids, ['small-now', 'late-swing']);
  assert.equal(result.recommendation.acquisitions_used, 2);
  assert.equal(result.recommendation.acquisitions_reserved, 0);
  assert.ok(result.plans.some(row => row.opportunity_ids.length === 1 && row.acquisitions_reserved === 1));
});

test('hold remains explicit when no candidate clears the configured threshold', () => {
  const value = input();
  value.min_plan_value = 50;
  value.opportunities = [opportunity('marginal', player('marginal', 11))];
  const result = optimize(value);
  assert.equal(result.recommendation.kind, 'hold');
  assert.equal(result.recommendation.acquisitions_reserved, 2);
  assert.match(result.next_reconsideration.reason, /deadline|availability|evidence/i);
});

test('server receipt time rejects replayed inputs and controls freshness deadlines', () => {
  const replay = input();
  assert.throws(() => optimizePlans(replay, { receivedAt: '2026-11-14T00:06:00Z' }), /materially skewed/i);

  const value = input();
  value.created_at = '2026-11-14T00:00:00Z';
  value.opportunities = [opportunity('deadline-race', player('candidate', 20), { decision_deadline: '2026-11-14T00:02:00Z' })];
  const result = optimizePlans(value, { receivedAt: '2026-11-14T00:04:00Z' });
  assert.equal(result.created_at, '2026-11-14T00:04:00.000Z');
  assert.equal(result.submitted_created_at, value.created_at);
  assert.deepEqual(result.plans.map(plan => plan.kind), ['hold']);
  assert.match(result.rejected[0].reason, /deadline has passed/i);
});
