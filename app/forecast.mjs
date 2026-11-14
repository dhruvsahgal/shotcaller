import { canonicalDigest } from './store.mjs';
import { categoryKeys, countKeys, validateStats } from './schema.mjs';
import { participationScenarios } from './research.mjs';
import { assignLineup, scoringDate } from './schedule.mjs';
import { strictInstant, validDate } from './time.mjs';

export const algorithmVersion = 'transparent-baseline-v1';
const rawKeys = countKeys.filter(key => key !== 'gp');
const allowedSlots = new Set(['PG', 'SG', 'G', 'SF', 'PF', 'F', 'C', 'UTIL', 'BN', 'IL', 'IL+', 'NA']);
const allowedPlayerPositions = new Set(['PG', 'SG', 'G', 'SF', 'PF', 'F', 'C']);
const maxEnumeratedUncertain = 6;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
function validateStatline(stats) {
  if (!object(stats)) throw new Error('Invalid forecast statline');
  validateStats(stats);
}

export function validateForecastInput(input) {
  if (!object(input) || input.schema_version !== 1 || input.kind !== 'forecast_input') throw new Error('Invalid forecast input contract');
  if (!identifier(input.league_id) || typeof input.season !== 'string' || !Number.isInteger(input.week) || input.week < 1) throw new Error('Invalid forecast league or period');
  if (!strictInstant(input.as_of) || typeof input.scoring_timezone !== 'string' || !input.scoring_timezone.trim()) throw new Error('Invalid forecast cutoff or scoring timezone');
  scoringDate(input.as_of, input.scoring_timezone);
  if (!object(input.period) || !validDate(input.period.start_date) || !validDate(input.period.end_date) || input.period.start_date > input.period.end_date) throw new Error('Invalid forecast scoring period');
  if (!Number.isInteger(input.expected_teams) || input.expected_teams < 2 || input.expected_teams > 30 || input.expected_teams % 2) throw new Error('Invalid expected team count');
  if (!Array.isArray(input.source_snapshot_ids) || !input.source_snapshot_ids.length || input.source_snapshot_ids.length > 128 || new Set(input.source_snapshot_ids).size !== input.source_snapshot_ids.length || input.source_snapshot_ids.some(id => !identifier(id))) throw new Error('At least one valid source snapshot is required');
  const sourceIds = new Set(input.source_snapshot_ids);
  if (!Array.isArray(input.roster_slots) || !input.roster_slots.length || input.roster_slots.length > 20 || input.roster_slots.some(slot => typeof slot !== 'string' || !allowedSlots.has(slot.toUpperCase()))) throw new Error('Invalid roster slots');
  if (!Array.isArray(input.teams) || input.teams.length > input.expected_teams || !Array.isArray(input.matchups) || input.matchups.length > input.expected_teams / 2) throw new Error('Forecast teams and matchups are required');
  const teamIds = new Set();
  for (const team of input.teams) {
    if (!identifier(team.id) || typeof team.name !== 'string' || !team.name.trim() || teamIds.has(team.id) || !Array.isArray(team.players) || team.players.length > 30 || !object(team.actual)) throw new Error('Invalid or duplicate forecast team');
    teamIds.add(team.id);
    validateStatline(team.actual.stats);
    if (!Array.isArray(team.actual.source_ids) || !team.actual.source_ids.length || team.actual.source_ids.some(id => !sourceIds.has(id))) throw new Error('Invalid or unsourced actual team totals');
    const playerIds = new Set();
    for (const player of team.players) {
      if (!identifier(player.id) || typeof player.name !== 'string' || !player.name.trim() || playerIds.has(player.id) || !Array.isArray(player.eligible_positions) || !player.eligible_positions.length || player.eligible_positions.some(position => typeof position !== 'string' || !allowedPlayerPositions.has(position.toUpperCase())) || !object(player.baseline) || !Array.isArray(player.games)) throw new Error('Invalid or duplicate forecast player');
      playerIds.add(player.id);
      validateStatline(player.baseline);
      const gameDates = new Set();
      for (const game of player.games) {
        if (!strictInstant(game.starts_at) || !Array.isArray(game.source_ids) || !game.source_ids.length || game.source_ids.some(id => !sourceIds.has(id))) throw new Error('Invalid or unsourced scheduled game');
        const gameDate = scoringDate(game.starts_at, input.scoring_timezone);
        if (gameDates.has(gameDate)) throw new Error('Duplicate scheduled game for player and scoring date');
        gameDates.add(gameDate);
        if (game.locked_slot != null && (typeof game.locked_slot !== 'string' || !allowedSlots.has(game.locked_slot.toUpperCase()))) throw new Error('Invalid scheduled lineup lock');
      }
      if (player.availability?.source_ids?.some(id => !sourceIds.has(id))) throw new Error('Availability source is not archived with this input');
    }
  }
  const used = new Set(), matchupIds = new Set();
  for (const matchup of input.matchups) {
    if (!identifier(matchup.id) || matchupIds.has(matchup.id) || !Array.isArray(matchup.team_ids) || matchup.team_ids.length !== 2 || new Set(matchup.team_ids).size !== 2 || matchup.team_ids.some(id => !teamIds.has(id) || used.has(id))) throw new Error('Invalid matchup coverage');
    matchupIds.add(matchup.id);
    matchup.team_ids.forEach(id => used.add(id));
  }
  return input;
}

const playerValue = baseline => ['pts', 'reb', 'ast', 'stl', 'blk', 'three_pm'].reduce((sum, key) => sum + (Number.isFinite(baseline[key]) ? baseline[key] : 0), 0);
function emptyTotals() { return { values: Object.fromEntries(rawKeys.map(key => [key, 0])), missing: new Set() }; }
function addBaseline(total, baseline) {
  for (const key of rawKeys) {
    if (Number.isFinite(baseline[key])) total.values[key] += baseline[key];
    else total.missing.add(key);
  }
}
function finishStats(total) {
  const stats = {};
  for (const key of rawKeys) stats[key] = total.missing.has(key) ? null : total.values[key];
  stats.fg_pct = stats.fgm != null && stats.fga > 0 ? stats.fgm / stats.fga : null;
  stats.ft_pct = stats.ftm != null && stats.fta > 0 ? stats.ftm / stats.fta : null;
  return stats;
}

function projectTeam(team, input, scenario, gaps, includedUncertain = null) {
  const byDate = new Map();
  const uncertain = [];
  for (const player of team.players) {
    const participation = participationScenarios(player.availability);
    if (!participation.sourced) gaps.add(`${team.name}: ${player.name} has no sourced availability report`);
    if (participation.lower !== participation.upper) uncertain.push({ player_id: player.id, name: player.name, status: participation.status });
    const participates = participation.lower === participation.upper ? participation.lower : includedUncertain ? includedUncertain.has(player.id) : participation[scenario];
    if (!participates) continue;
    const periodGames = player.games.filter(game => {
      const date = scoringDate(game.starts_at, input.scoring_timezone);
      return date >= input.period.start_date && date <= input.period.end_date;
    });
    if (!periodGames.length) gaps.add(`${team.name}: ${player.name} has no scheduled games in the forecast period`);
    for (const key of rawKeys) if (!Number.isFinite(player.baseline[key])) gaps.add(`${team.name}: ${player.name} is missing ${key} baseline data`);
    for (const game of periodGames) {
      if (['postponed', 'cancelled'].includes(game.status)) continue;
      if (Date.parse(game.starts_at) <= Date.parse(input.as_of)) continue;
      const date = scoringDate(game.starts_at, input.scoring_timezone);
      const entry = { id: player.id, eligible_positions: player.eligible_positions, value: playerValue(player.baseline), baseline: player.baseline, locked_slot: game.locked_slot };
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date).push(entry);
    }
  }
  const totals = emptyTotals(), days = [];
  addBaseline(totals, team.actual.stats);
  let usableStarts = 0;
  for (const [date, players] of [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const lineup = assignLineup(players, input.roster_slots);
    const index = new Map(players.map(player => [player.id, player]));
    lineup.assignments.forEach(row => addBaseline(totals, index.get(row.player_id).baseline));
    usableStarts += lineup.assignments.length;
    days.push({ date, assignments: lineup.assignments, bench: lineup.bench, open_slots: lineup.open_slots });
  }
  return { stats: finishStats(totals), usable_starts: usableStarts, days, uncertain_players: uncertain };
}

function availabilityBounds(team, input, gaps) {
  const uncertainIds = team.players.filter(player => {
    const participation = participationScenarios(player.availability);
    return participation.lower !== participation.upper;
  }).map(player => player.id);
  if (uncertainIds.length > maxEnumeratedUncertain) {
    gaps.add(`${team.name}: ${uncertainIds.length} uncertain players exceed the ${maxEnumeratedUncertain}-player combination limit`);
    return Object.fromEntries(categoryKeys.map(key => [key, { min: null, max: null }]));
  }
  const projections = [];
  for (let mask = 0; mask < 2 ** uncertainIds.length; mask++) {
    const included = new Set(uncertainIds.filter((_, index) => mask & (1 << index)));
    projections.push(projectTeam(team, input, 'lower', gaps, included).stats);
  }
  return Object.fromEntries(categoryKeys.map(key => {
    const values = projections.map(stats => stats[key]);
    return [key, values.some(value => value == null) ? { min: null, max: null } : { min: Math.min(...values), max: Math.max(...values) }];
  }));
}

function matchupProjection(matchup, teams) {
  const [a, b] = matchup.team_ids.map(id => teams.get(id));
  let aWins = 0, bWins = 0, swings = 0;
  const categoryOutcomes = {};
  for (const key of categoryKeys) {
    const aBounds = a.category_bounds[key], bBounds = b.category_bounds[key];
    if ([aBounds.min, aBounds.max, bBounds.min, bBounds.max].some(value => value == null)) { categoryOutcomes[key] = 'unknown'; swings++; continue; }
    if (aBounds.min > bBounds.max) categoryOutcomes[key] = a.id;
    else if (bBounds.min > aBounds.max) categoryOutcomes[key] = b.id;
    else { categoryOutcomes[key] = 'swing'; swings++; }
    const aMiddle = (aBounds.min + aBounds.max) / 2, bMiddle = (bBounds.min + bBounds.max) / 2;
    if (aMiddle > bMiddle) aWins++; else if (bMiddle > aMiddle) bWins++;
  }
  return { id: matchup.id, team_ids: matchup.team_ids, projected_leader: aWins === bWins ? null : aWins > bWins ? a.id : b.id, midpoint_category_score: { [a.id]: aWins, [b.id]: bWins }, category_outcomes: categoryOutcomes, stability: { swing_categories: swings, label: swings === 0 ? 'stable' : swings <= 3 ? 'swingable' : 'highly swingable' } };
}

export function buildForecast(rawInput) {
  const input = validateForecastInput(structuredClone(rawInput));
  const gaps = new Set();
  if (input.teams.length !== input.expected_teams) gaps.add(`Expected ${input.expected_teams} teams but received ${input.teams.length}`);
  const expectedMatchups = input.expected_teams / 2;
  if (input.matchups.length !== expectedMatchups) gaps.add(`Expected ${expectedMatchups} matchups but received ${input.matchups.length}`);
  const teams = input.teams.map(team => {
    if (!team.players.length) gaps.add(`${team.name}: roster has no players`);
    for (const key of rawKeys) if (!Number.isFinite(team.actual.stats[key])) gaps.add(`${team.name}: actual totals are missing ${key}`);
    const lower = projectTeam(team, input, 'lower', gaps), upper = projectTeam(team, input, 'upper', gaps);
    const categoryBounds = availabilityBounds(team, input, gaps);
    return { id: team.id, name: team.name, actual: structuredClone(team.actual.stats), range: { lower, upper }, category_bounds: categoryBounds };
  });
  const teamIndex = new Map(teams.map(team => [team.id, team]));
  const matchups = input.matchups.map(matchup => matchupProjection(matchup, teamIndex)).sort((a, b) => b.stability.swing_categories - a.stability.swing_categories || a.id.localeCompare(b.id));
  const uncertain = teams.some(team => team.range.upper.uncertain_players.length);
  const gapList = [...gaps].sort();
  const precise = !gapList.length && !uncertain;
  return {
    algorithm_version: algorithmVersion, input_hash: canonicalDigest(input), created_at: input.as_of, input,
    league_id: input.league_id, season: input.season, week: input.week, as_of: input.as_of,
    source_snapshot_ids: [...input.source_snapshot_ids], status: precise ? 'complete' : 'partial', precise,
    coverage: { expected_teams: input.expected_teams, observed_teams: input.teams.length, expected_matchups: expectedMatchups, observed_matchups: input.matchups.length },
    assumptions: { baseline: 'provided per-game statistics', uncertainty: 'lower excludes uncertain players; upper includes them', lineup_selection: 'highest transparent counting-stat value subject to eligibility and locks' },
    gaps: gapList, teams, matchups
  };
}
