import { canonicalDigest } from './store.mjs';
import { categoryKeys } from './schema.mjs';
import { categoryValue } from './categories.mjs';
const forecastValue = (team, category) => {
  const lower = categoryValue(team?.range?.lower?.stats, category), upper = categoryValue(team?.range?.upper?.stats, category);
  if (!Number.isFinite(lower) || !Number.isFinite(upper)) return { lower: null, upper: null, midpoint: null };
  return { lower: Math.min(lower, upper), upper: Math.max(lower, upper), midpoint: (lower + upper) / 2 };
};
const unwrap = record => record?.forecast || record;
const sourceIds = value => [
  ...(value?.source_snapshot_ids || value?.forecast?.source_snapshot_ids || []),
  ...(value?.matchups || []).flatMap(row => [...(row.source_snapshot_ids || []), ...(row.teams || []).flatMap(team => team.source_snapshot_ids || [])])
];
export const unique = values => [...new Set(values.filter(Boolean))].sort();

const duplicates = values => [...new Set(values.filter((value, index) => values.indexOf(value) !== index))].sort();
const sameIds = (left, right) => left.length === right.length && left.every((value, index) => value === right[index]);
const sortedIds = values => values.filter(value => typeof value === 'string' && value).sort();

function topologyCoverage(forecast, outcome) {
  const expected = forecast.matchups;
  const expectedIds = expected.map(row => row?.id).filter(Boolean);
  const actual = outcome.matchups;
  const actualIds = actual.map(row => row?.id).filter(Boolean);
  const issues = [];
  if (!expected.length) issues.push('The frozen forecast contains no expected matchups.');
  if (expectedIds.length !== expected.length) issues.push('The frozen forecast contains a matchup without an ID.');
  const duplicateExpectedIds = duplicates(expectedIds);
  if (duplicateExpectedIds.length) issues.push(`The frozen forecast repeats matchup IDs: ${duplicateExpectedIds.join(', ')}.`);
  const duplicateActualIds = duplicates(actualIds);
  if (duplicateActualIds.length) issues.push(`The outcome repeats matchup IDs: ${duplicateActualIds.join(', ')}.`);
  if (!sameIds(sortedIds(expectedIds), sortedIds(actualIds))) issues.push('Outcome matchup IDs do not exactly match the frozen forecast topology.');

  const expectedTeamIds = expected.flatMap(row => Array.isArray(row?.team_ids) ? row.team_ids : []);
  const duplicateExpectedTeamIds = duplicates(expectedTeamIds);
  if (expected.some(row => !Array.isArray(row?.team_ids) || row.team_ids.length !== 2 || new Set(row.team_ids).size !== 2)) issues.push('Each frozen matchup must contain exactly two unique team IDs.');
  if (duplicateExpectedTeamIds.length) issues.push(`The frozen topology assigns teams more than once: ${duplicateExpectedTeamIds.join(', ')}.`);
  if (duplicates(forecast.teams.map(row => row?.id).filter(Boolean)).length) issues.push('The forecast repeats team records.');

  const actualById = new Map(actual.map(row => [row?.id, row]));
  for (const matchup of expected) {
    const actualMatchup = actualById.get(matchup?.id);
    if (!actualMatchup) continue;
    const expectedTeams = sortedIds(matchup.team_ids || []);
    const actualTeams = sortedIds((actualMatchup.teams || []).map(row => row?.id));
    if (duplicates(actualTeams).length || !sameIds(expectedTeams, actualTeams)) issues.push(`Outcome teams do not match frozen matchup ${matchup.id}.`);
  }
  if (outcome.status !== 'final' || actual.some(row => row?.status !== 'final') || !Number.isFinite(Date.parse(outcome.finalized_at))) issues.push('One or more outcome matchups are not final or lack a valid finalization time.');
  return { complete: issues.length === 0, expected_matchup_ids: unique(expectedIds), observed_matchup_ids: unique(actualIds), issues };
}

export function evaluateForecast({ forecast_record, outcome, baseline_record = null, evaluated_at = new Date().toISOString(), correction_of = null }) {
  const forecast = unwrap(forecast_record), baseline = baseline_record ? unwrap(baseline_record) : null;
  if (!forecast?.league_id || !forecast?.season || !Number.isInteger(forecast?.week) || !Array.isArray(forecast.teams) || !Array.isArray(forecast.matchups)) throw new Error('Invalid forecast evaluation input');
  if (!outcome || !Array.isArray(outcome.matchups)) throw new Error('Invalid forecast outcome');
  const outcomeById = new Map(outcome.matchups.map(row => [row.id, row]));
  const teamById = new Map(forecast.teams.map(row => [row.id, row]));
  const baselineById = new Map((baseline?.teams || []).map(row => [row.id, row]));
  const topology = topologyCoverage(forecast, outcome);
  const caveats = [...topology.issues];
  const missing = [];
  const matchupEvaluations = forecast.matchups.map(matchup => {
    const actualMatchup = outcomeById.get(matchup.id);
    const actualTeams = new Map((actualMatchup?.teams || []).map(row => [row.id, row]));
    return {
      id: matchup.id,
      status: actualMatchup?.status || 'missing',
      teams: matchup.team_ids.map(teamId => {
        const projected = teamById.get(teamId), actual = actualTeams.get(teamId), baselineTeam = baselineById.get(teamId);
        const categories = Object.fromEntries(categoryKeys.map(category => {
          const range = forecastValue(projected, category), observed = categoryValue(actual?.stats, category), baselineRange = forecastValue(baselineTeam, category);
          const absent = [];
          if (!Number.isFinite(range.midpoint)) absent.push('forecast');
          if (!Number.isFinite(observed)) absent.push('outcome');
          if (absent.length) missing.push({ matchup_id: matchup.id, team_id: teamId, category, missing: absent });
          const absoluteError = Number.isFinite(observed) && Number.isFinite(range.midpoint) ? Math.abs(observed - range.midpoint) : null;
          const baselineError = Number.isFinite(observed) && Number.isFinite(baselineRange.midpoint) ? Math.abs(observed - baselineRange.midpoint) : null;
          return [category, {
            ...range, actual: observed,
            in_range: Number.isFinite(observed) && Number.isFinite(range.lower) ? observed >= range.lower && observed <= range.upper : null,
            absolute_error: absoluteError,
            baseline_absolute_error: baselineError,
            beat_baseline: Number.isFinite(absoluteError) && Number.isFinite(baselineError) ? absoluteError < baselineError : null
          }];
        }));
        return { id: teamId, name: projected?.name || actual?.name || teamId, projected_usable_starts: { lower: projected?.range?.lower?.usable_starts ?? null, upper: projected?.range?.upper?.usable_starts ?? null }, actual_usable_starts: actual?.usable_starts ?? null, categories };
      })
    };
  });
  const categoryCoverage = {
    complete: missing.length === 0,
    expected_observations: forecast.matchups.reduce((sum, row) => sum + (row.team_ids?.length || 0), 0) * categoryKeys.length,
    missing
  };
  if (missing.length) caveats.push(`${missing.length} forecast/outcome category observations are missing; percentage categories require finite makes and attempts.`);
  const status = !topology.complete ? 'provisional' : categoryCoverage.complete ? 'final' : 'partial';
  const evaluation = {
    schema_version: 1, kind: 'forecast_evaluation', status,
    evaluated_at, forecast_id: forecast_record.id || forecast.id || null, baseline_forecast_id: baseline_record?.id || null,
    league_id: String(forecast.league_id), season: String(forecast.season), week: forecast.week,
    correlation_key: `${forecast.league_id}:${forecast.season}:${forecast.week}`,
    independent_validation_units: status === 'final' ? 1 : 0, source_snapshot_ids: unique([...sourceIds(forecast_record), ...sourceIds(outcome)]),
    correction_of, outcome_id: outcome.id || null, topology_coverage: topology, category_coverage: categoryCoverage, caveats, matchups: matchupEvaluations
  };
  evaluation.input_hash = canonicalDigest({ forecast_id: evaluation.forecast_id, outcome_id: evaluation.outcome_id, baseline_forecast_id: evaluation.baseline_forecast_id, correction_of, source_snapshot_ids: evaluation.source_snapshot_ids });
  return evaluation;
}

export function summarizeEvaluations(records = []) {
  const groups = new Map();
  for (const record of records) {
    const evaluation = record.evaluation || record;
    const key = evaluation.correlation_key;
    if (!key) continue;
    const group = groups.get(key) || { correlation_key: key, evaluation_ids: [], statuses: [], final: false };
    group.evaluation_ids.push(record.id || evaluation.id || evaluation.input_hash);
    group.statuses.push(evaluation.status);
    group.final ||= evaluation.status === 'final';
    groups.set(key, group);
  }
  return { origins: records.length, independent_validation_weeks: [...groups.values()].filter(row => row.final).length, groups: [...groups.values()].sort((a, b) => a.correlation_key.localeCompare(b.correlation_key)) };
}
