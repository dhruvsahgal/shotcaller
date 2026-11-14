import { canonicalDigest } from './store.mjs';
import { categoryKeys } from './schema.mjs';


const ratio = (stats, made, attempted) => {
  if (Number.isFinite(stats?.[made]) && Number.isFinite(stats?.[attempted])) return stats[attempted] > 0 ? stats[made] / stats[attempted] : null;
  return null;
};
const categoryValue = (stats, category) => {
  if (!stats) return null;
  if (category === 'fg_pct') return Number.isFinite(stats.fg_pct) ? stats.fg_pct : ratio(stats, 'fgm', 'fga');
  if (category === 'ft_pct') return Number.isFinite(stats.ft_pct) ? stats.ft_pct : ratio(stats, 'ftm', 'fta');
  const value = category === 'stl' ? stats.stl ?? stats.st : stats[category];
  return Number.isFinite(value) ? value : null;
};
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

export function evaluateForecast({ forecast_record, outcome, baseline_record = null, evaluated_at = new Date().toISOString(), correction_of = null }) {
  const forecast = unwrap(forecast_record), baseline = baseline_record ? unwrap(baseline_record) : null;
  if (!forecast?.league_id || !forecast?.season || !Number.isInteger(forecast?.week) || !Array.isArray(forecast.teams) || !Array.isArray(forecast.matchups)) throw new Error('Invalid forecast evaluation input');
  if (!outcome || !Array.isArray(outcome.matchups)) throw new Error('Invalid forecast outcome');
  const outcomeById = new Map(outcome.matchups.map(row => [row.id, row]));
  const teamById = new Map(forecast.teams.map(row => [row.id, row]));
  const baselineById = new Map((baseline?.teams || []).map(row => [row.id, row]));
  const expected = outcome.expected_matchups ?? forecast.matchups.length;
  const allFinal = outcome.status === 'final' && outcome.matchups.length === expected && outcome.matchups.every(row => row.status === 'final');
  const caveats = [];
  if (!allFinal) caveats.push(`Outcome is not final for all ${expected} expected matchups; this evaluation is provisional.`);
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
  const evaluation = {
    schema_version: 1, kind: 'forecast_evaluation', status: allFinal ? 'final' : 'provisional',
    evaluated_at, forecast_id: forecast_record.id || forecast.id || null, baseline_forecast_id: baseline_record?.id || null,
    league_id: String(forecast.league_id), season: String(forecast.season), week: forecast.week,
    correlation_key: `${forecast.league_id}:${forecast.season}:${forecast.week}`,
    independent_validation_units: allFinal ? 1 : 0, source_snapshot_ids: unique([...sourceIds(forecast_record), ...sourceIds(outcome)]),
    correction_of, outcome_id: outcome.id || null, caveats, matchups: matchupEvaluations
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
