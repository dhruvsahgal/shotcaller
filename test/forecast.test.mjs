import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildForecast, validateForecastInput } from '../app/forecast.mjs';

const stats = (pts, fgm = 4, fga = 8) => ({ fgm, fga, ftm: 2, fta: 2, three_pm: 1, pts, oreb: 1, reb: 5, ast: 4, stl: 1, blk: 1 });
const zeroStats = () => ({ fgm: 0, fga: 0, ftm: 0, fta: 0, three_pm: 0, pts: 0, oreb: 0, reb: 0, ast: 0, stl: 0, blk: 0 });
const player = (id, pts, options = {}) => ({
  id, name: id, eligible_positions: options.positions || ['PG'], baseline: options.baseline || stats(pts),
  availability: options.availability || { status: 'available', observed_at: '2026-11-14T00:00:00Z', source_ids: ['capture-1'] },
  games: options.games || [{ starts_at: '2026-11-15T03:00:00Z', source_ids: ['capture-1'] }]
});
const input = () => ({
  schema_version: 1, kind: 'forecast_input', league_id: '123', season: '2026', week: 4,
  as_of: '2026-11-14T00:00:00Z', scoring_timezone: 'America/Los_Angeles', expected_teams: 2,
  period: { start_date: '2026-11-09', end_date: '2026-11-15' },
  source_snapshot_ids: ['capture-1'], roster_slots: ['PG'],
  matchups: [{ id: 'm1', team_ids: ['a', 'b'] }],
  teams: [
    { id: 'a', name: 'A', actual: { stats: zeroStats(), source_ids: ['capture-1'] }, players: [player('a1', 20), player('a2', 10)] },
    { id: 'b', name: 'B', actual: { stats: zeroStats(), source_ids: ['capture-1'] }, players: [player('b1', 18)] }
  ]
});

test('forecast pools shooting volume and reproduces identical versioned inputs', () => {
  const value = input();
  value.roster_slots = ['PG', 'Util'];
  value.teams[0].players[0].baseline = stats(20, 1, 2);
  value.teams[0].players[1].baseline = stats(10, 9, 18);
  value.teams[0].actual.stats.pts = 5;
  const first = buildForecast(value);
  const second = buildForecast(structuredClone(value));
  assert.equal(first.input_hash, second.input_hash);
  assert.deepEqual(first.input, value);
  assert.deepEqual(first.matchups, second.matchups);
  assert.equal(first.teams.find(team => team.id === 'a').range.upper.stats.fg_pct, 0.5);
  assert.equal(first.teams.find(team => team.id === 'a').range.upper.stats.pts, 35);
});

test('questionable players create ranges and missing opponent games prevent a precise score', () => {
  const value = input();
  value.teams[0].players.push(player('q', 30, { availability: { status: 'questionable', observed_at: '2026-11-14T00:00:00Z', source_ids: ['capture-1'] } }));
  value.teams[1].players[0].games = [];
  const forecast = buildForecast(value);
  const team = forecast.teams.find(row => row.id === 'a');
  assert.equal(team.range.lower.usable_starts, 1);
  assert.equal(team.range.upper.usable_starts, 1);
  assert.equal(forecast.precise, false);
  assert.ok(forecast.gaps.some(gap => /no scheduled games/i.test(gap)));
});

test('games already started by the cutoff are represented only by sourced actual totals', () => {
  const value = input();
  value.teams[0].actual.stats = stats(12, 5, 10);
  value.teams[0].players = [value.teams[0].players[0]];
  value.teams[0].players[0].games = [{ starts_at: '2026-11-13T03:00:00Z', source_ids: ['capture-1'] }];
  const team = buildForecast(value).teams.find(row => row.id === 'a');
  assert.equal(team.range.upper.stats.pts, 12);
  assert.equal(team.range.upper.usable_starts, 0);
});

test('daily Yahoo lineup locks are preserved by forecast assignment', () => {
  const value = input();
  value.teams[0].players[0].games[0].locked_slot = 'BN';
  const team = buildForecast(value).teams.find(row => row.id === 'a');
  assert.deepEqual(team.range.upper.days[0].assignments.map(row => row.player_id), ['a2']);
  assert.deepEqual(team.range.upper.days[0].bench.map(row => row.player_id).sort(), ['a1']);
});

test('missing actual stat fields make the forecast explicitly partial', () => {
  const value = input();
  delete value.teams[0].actual.stats.blk;
  const forecast = buildForecast(value);
  assert.equal(forecast.precise, false);
  assert.equal(forecast.status, 'partial');
  assert.ok(forecast.gaps.includes('A: actual totals are missing blk'));
});

test('missing rosters remain explicit partial coverage', () => {
  const value = input();
  value.teams[0].players = [];
  const forecast = buildForecast(value);
  assert.equal(forecast.status, 'partial');
  assert.ok(forecast.gaps.includes('A: roster has no players'));
});

test('eligibility, timestamps, duplicate games and matchup identity are strict', () => {
  const badPosition = input();
  badPosition.teams[0].players[0].eligible_positions = ['XYZ'];
  assert.throws(() => validateForecastInput(badPosition), /forecast player/);
  const noTimezone = input();
  delete noTimezone.scoring_timezone;
  assert.throws(() => validateForecastInput(noTimezone), /timezone/);
  const localTimestamp = input();
  localTimestamp.teams[0].players[0].games[0].starts_at = '2026-11-15T03:00:00';
  assert.throws(() => validateForecastInput(localTimestamp), /scheduled game/);
  const impossibleTimestamp = input();
  impossibleTimestamp.teams[0].players[0].games[0].starts_at = '2026-02-31T03:00:00Z';
  assert.throws(() => validateForecastInput(impossibleTimestamp), /scheduled game/);
  const duplicateGame = input();
  duplicateGame.teams[0].players[0].games.push(structuredClone(duplicateGame.teams[0].players[0].games[0]));
  assert.throws(() => validateForecastInput(duplicateGame), /Duplicate scheduled game/);
  const selfMatchup = input();
  selfMatchup.matchups[0].team_ids = ['a', 'a'];
  assert.throws(() => validateForecastInput(selfMatchup), /matchup coverage/);
});

test('category stability survives inverted participation scenarios', () => {
  const value = input();
  value.roster_slots = ['Util'];
  value.teams[0].players = [
    player('rebounder', 1, { baseline: { ...stats(1), reb: 20 } }),
    player('scorer', 30, { baseline: { ...stats(30), reb: 1 }, availability: { status: 'questionable', observed_at: '2026-11-14T00:00:00Z', source_ids: ['capture-1'] } })
  ];
  value.teams[1].players = [player('opponent', 10, { baseline: { ...stats(10), reb: 10 } })];
  const matchup = buildForecast(value).matchups[0];
  assert.equal(matchup.category_outcomes.reb, 'swing');
});

test('category bounds include mixed outcomes for independently uncertain players', () => {
  const value = input();
  value.roster_slots = ['Util'];
  const questionable = { status: 'questionable', observed_at: '2026-11-14T00:00:00Z', source_ids: ['capture-1'] };
  value.teams[0].players = [
    player('available-rebounder', 1, { baseline: { ...stats(1), reb: 20 } }),
    player('questionable-rebounder', 30, { baseline: { ...stats(30), reb: 20 }, availability: questionable }),
    player('questionable-scorer', 35, { baseline: { ...stats(35), reb: 1 }, availability: questionable })
  ];
  value.teams[1].players = [player('opponent', 10, { baseline: { ...stats(10), reb: 10 } })];
  const forecast = buildForecast(value), team = forecast.teams.find(row => row.id === 'a');
  assert.deepEqual(team.category_bounds.reb, { min: 1, max: 20 });
  assert.equal(forecast.matchups[0].category_outcomes.reb, 'swing');
});

test('excess availability combinations become unknown instead of exhausting the service', () => {
  const value = input();
  const questionable = { status: 'questionable', observed_at: '2026-11-14T00:00:00Z', source_ids: ['capture-1'] };
  value.teams[0].players = Array.from({ length: 7 }, (_, index) => player(`q${index}`, 10 + index, { availability: questionable }));
  const forecast = buildForecast(value);
  assert.equal(forecast.teams.find(row => row.id === 'a').category_bounds.pts.min, null);
  assert.equal(forecast.matchups[0].category_outcomes.pts, 'unknown');
  assert.ok(forecast.gaps.some(gap => /combination limit/.test(gap)));
});

test('questionable participation changes the lower and upper team projection', () => {
  const value = input();
  value.roster_slots = ['PG', 'Util'];
  value.teams[0].players.push(player('q', 30, { availability: { status: 'questionable', observed_at: '2026-11-14T00:00:00Z', source_ids: ['capture-1'] } }));
  const team = buildForecast(value).teams.find(row => row.id === 'a');
  assert.equal(team.range.lower.stats.pts, 30);
  assert.equal(team.range.upper.stats.pts, 50);
});

test('input fingerprints change when a forecast assumption changes', () => {
  const original = input(), changed = input();
  changed.teams[0].players[0].baseline.pts += 1;
  assert.notEqual(buildForecast(original).input_hash, buildForecast(changed).input_hash);
});

test('five league matchups sort the most swingable first', () => {
  const value = input();
  value.expected_teams = 10;
  value.matchups = [];
  value.teams = [];
  for (let i = 0; i < 10; i++) {
    const id = `t${i}`;
    const dominant = i === 0;
    const weak = i === 1;
    const baseline = dominant ? { fgm: 9, fga: 10, ftm: 9, fta: 10, three_pm: 9, pts: 30, oreb: 5, reb: 10, ast: 9, stl: 4, blk: 4 }
      : weak ? { fgm: 1, fga: 10, ftm: 1, fta: 10, three_pm: 1, pts: 5, oreb: 1, reb: 2, ast: 1, stl: 0, blk: 0 }
        : stats(10);
    value.teams.push({ id, name: id, actual: { stats: zeroStats(), source_ids: ['capture-1'] }, players: [player(`${id}p`, baseline.pts, { baseline })] });
  }
  for (let i = 0; i < 5; i++) value.matchups.push({ id: `m${i}`, team_ids: [`t${i * 2}`, `t${i * 2 + 1}`] });
  const matchups = buildForecast(value).matchups;
  assert.equal(matchups.length, 5);
  assert.equal(matchups.at(-1).id, 'm0');
  assert.equal(matchups.at(-1).stability.label, 'stable');
  assert.equal(matchups[0].stability.label, 'highly swingable');
});

test('all five matchups are ranked by swingability and missing league coverage is explicit', () => {
  const value = input();
  value.expected_teams = 10;
  const forecast = buildForecast(value);
  assert.equal(forecast.coverage.expected_matchups, 5);
  assert.equal(forecast.coverage.observed_matchups, 1);
  assert.equal(forecast.status, 'partial');
  assert.equal(forecast.matchups[0].stability.label, 'highly swingable');
});

test('invalid rebound arithmetic and unsourced inputs are rejected', () => {
  const value = input();
  value.teams[0].players[0].baseline.oreb = 8;
  assert.throws(() => validateForecastInput(value), /Offensive rebounds exceed rebounds/);
  value.teams[0].players[0].baseline.oreb = 1;
  value.source_snapshot_ids = [];
  assert.throws(() => validateForecastInput(value), /source snapshot/);
});
