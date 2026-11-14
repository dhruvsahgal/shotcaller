import { buildForecast, validateForecastInput } from './forecast.mjs';
import { canonicalDigest } from './store.mjs';
import { strictInstant } from './time.mjs';

export const optimizationAlgorithmVersion = 'finite-option-tree-v1';
export const maxOptimizationClockSkewMs = 5 * 60_000;
const availabilityStates = new Set(['available', 'waivers', 'claimed', 'unknown']);
const defaultWeights = Object.freeze({ category: 10, usable_start: 0.25, replacement: 1, next_matchup: 1, claim_risk: 1 });

function validateInput(input) {
  if (!input || typeof input !== 'object' || input.schema_version !== 1 || input.kind !== 'optimization_input' || !strictInstant(input.created_at)) throw new Error('Invalid optimization input contract');
  validateForecastInput(input.forecast_input);
  if (!input.forecast_input.teams.some(team => team.id === input.manager_team_id)) throw new Error('Manager team is absent from forecast input');
  if (!Number.isInteger(input.acquisitions_remaining) || input.acquisitions_remaining < 0 || input.acquisitions_remaining > 2) throw new Error('Acquisitions remaining must be between zero and two');
  if (!Number.isInteger(input.max_roster_size) || input.max_roster_size < 1 || input.max_roster_size > 30) throw new Error('Invalid roster size');
  if (!Number.isFinite(input.min_plan_value) || input.min_plan_value < 0 || !Number.isFinite(input.max_availability_age_hours) || input.max_availability_age_hours <= 0) throw new Error('Invalid optimization thresholds');
  if (!Array.isArray(input.opportunities) || input.opportunities.length > 16) throw new Error('Invalid optimization opportunities');
  const ids = new Set();
  for (const opportunity of input.opportunities) {
    if (!opportunity || typeof opportunity.id !== 'string' || !opportunity.id || ids.has(opportunity.id) || typeof opportunity.group_id !== 'string' || !opportunity.group_id) throw new Error('Invalid or duplicate opportunity');
    ids.add(opportunity.id);
    if (!['now', 'wait'].includes(opportunity.mode) || !strictInstant(opportunity.effective_at) || !strictInstant(opportunity.decision_deadline) || Date.parse(opportunity.effective_at) < Date.parse(input.forecast_input.as_of)) throw new Error('Invalid opportunity timing');
    if (!opportunity.availability || !availabilityStates.has(opportunity.availability.state) || !strictInstant(opportunity.availability.observed_at) || !Array.isArray(opportunity.availability.source_ids) || !opportunity.availability.source_ids.length) throw new Error('Invalid opportunity availability evidence');
    if (!Number.isInteger(opportunity.consumes_acquisitions) || opportunity.consumes_acquisitions < 0 || opportunity.consumes_acquisitions > 1) throw new Error('Invalid acquisition cost');
    for (const key of ['replacement_value', 'next_matchup_value', 'claim_risk']) if (!Number.isFinite(opportunity[key])) throw new Error(`Invalid opportunity ${key}`);
    if (opportunity.claim_risk < 0 || opportunity.claim_risk > 1) throw new Error('Invalid opportunity claim risk');
    const candidateInput = structuredClone(input.forecast_input);
    candidateInput.teams = [{ ...candidateInput.teams.find(team => team.id === input.manager_team_id), players: [opportunity.candidate] }];
    candidateInput.expected_teams = 2;
    candidateInput.matchups = [];
    try {
      const candidate = candidateInput.teams[0].players[0];
      if (!candidate || typeof candidate.id !== 'string' || !candidate.id || !Array.isArray(candidate.games) || !Array.isArray(candidate.eligible_positions)) throw new Error();
      for (const game of candidate.games) if (!strictInstant(game.starts_at) || !Array.isArray(game.source_ids) || !game.source_ids.length) throw new Error();
    } catch { throw new Error('Invalid opportunity candidate'); }
  }
  return input;
}

function preflightOpportunity(opportunity, input, initialRoster, receivedAt) {
  if (!['available', 'waivers'].includes(opportunity.availability.state)) return 'Refresh availability: candidate is no longer confirmed available.';
  const ageHours = (Date.parse(receivedAt) - Date.parse(opportunity.availability.observed_at)) / 3600000;
  if (ageHours < 0 || ageHours > input.max_availability_age_hours) return `Availability evidence is stale (${Math.max(0, ageHours).toFixed(1)} hours old).`;
  if (Date.parse(opportunity.decision_deadline) < Date.parse(receivedAt)) return 'The decision deadline has passed.';
  if (initialRoster.has(opportunity.candidate.id)) return 'Candidate is already rostered.';
  if (opportunity.drop_player_id != null && !initialRoster.has(opportunity.drop_player_id)) return 'Drop player is not on the current roster.';
  const afterDrop = initialRoster.size - (opportunity.drop_player_id ? 1 : 0);
  if ((opportunity.requires_open_roster_slot || afterDrop >= input.max_roster_size) && !opportunity.drop_player_id) return 'An open roster slot or legal drop is required.';
  return null;
}

function truncateGames(player, predicate) {
  player.games = player.games.filter(game => predicate(Date.parse(game.starts_at)));
}

function simulate(input, sequence) {
  const forecastInput = structuredClone(input.forecast_input);
  const team = forecastInput.teams.find(row => row.id === input.manager_team_id);
  const projectionPlayers = team.players;
  const currentRoster = new Map(team.players.map(player => [player.id, player]));
  const seen = new Set(currentRoster.keys());
  for (const opportunity of sequence) {
    const effective = Date.parse(opportunity.effective_at);
    if (opportunity.drop_player_id) {
      const dropped = currentRoster.get(opportunity.drop_player_id);
      if (!dropped) throw new Error(`Drop player ${opportunity.drop_player_id} is unavailable at ${opportunity.id}`);
      truncateGames(dropped, start => start < effective);
      currentRoster.delete(opportunity.drop_player_id);
    }
    if (currentRoster.size >= input.max_roster_size) throw new Error(`No open roster slot for ${opportunity.id}`);
    if (seen.has(opportunity.candidate.id)) throw new Error(`Candidate ${opportunity.candidate.id} is duplicated in one path`);
    const added = structuredClone(opportunity.candidate);
    truncateGames(added, start => start >= effective);
    projectionPlayers.push(added);
    currentRoster.set(added.id, added);
    seen.add(added.id);
  }
  return buildForecast(forecastInput);
}

function teamProjection(forecast, teamId) {
  const team = forecast.teams.find(row => row.id === teamId);
  return { team, usableStarts: (team.range.lower.usable_starts + team.range.upper.usable_starts) / 2 };
}

function matchupScore(forecast, teamId) {
  const matchup = forecast.matchups.find(row => row.team_ids.includes(teamId));
  if (!matchup) return 0;
  return Object.values(matchup.category_outcomes).reduce((sum, outcome) => sum + (outcome === teamId ? 1 : outcome === 'swing' || outcome === 'unknown' ? 0.5 : 0), 0);
}

function sequenceKey(sequence) { return sequence.map(opportunity => opportunity.id).join('+'); }

function enumerate(opportunities, remaining) {
  const sequences = [];
  function visit(start, selected, spent, groups) {
    if (selected.length) sequences.push([...selected]);
    for (let index = start; index < opportunities.length; index++) {
      const opportunity = opportunities[index];
      if (groups.has(opportunity.group_id) || spent + opportunity.consumes_acquisitions > remaining) continue;
      if (selected.length && Date.parse(opportunity.effective_at) < Date.parse(selected.at(-1).effective_at)) continue;
      groups.add(opportunity.group_id); selected.push(opportunity);
      visit(index + 1, selected, spent + opportunity.consumes_acquisitions, groups);
      selected.pop(); groups.delete(opportunity.group_id);
    }
  }
  visit(0, [], 0, new Set());
  return sequences;
}

export function optimizePlans(rawInput, { receivedAt = new Date().toISOString() } = {}) {
  if (!strictInstant(receivedAt)) throw new Error('Invalid optimization receipt time');
  const input = validateInput(structuredClone(rawInput));
  receivedAt = new Date(receivedAt).toISOString();
  if (Math.abs(Date.parse(receivedAt) - Date.parse(input.created_at)) > maxOptimizationClockSkewMs) throw new Error('Optimization request created_at is materially skewed from the server receipt time');
  const initialTeam = input.forecast_input.teams.find(team => team.id === input.manager_team_id);
  const initialRoster = new Map(initialTeam.players.map(player => [player.id, player]));
  const rejected = [], feasible = [];
  for (const opportunity of input.opportunities) {
    const reason = preflightOpportunity(opportunity, input, initialRoster, receivedAt);
    if (reason) rejected.push({ opportunity_id: opportunity.id, reason });
    else feasible.push(opportunity);
  }
  feasible.sort((a, b) => Date.parse(a.effective_at) - Date.parse(b.effective_at) || a.id.localeCompare(b.id));
  const baseline = buildForecast(input.forecast_input);
  const baselineStarts = teamProjection(baseline, input.manager_team_id).usableStarts;
  const baselineScore = matchupScore(baseline, input.manager_team_id);
  const weights = { ...defaultWeights, ...(input.weights || {}) };
  const hold = {
    id: 'hold', kind: 'hold', opportunity_ids: [], acquisitions_used: 0, acquisitions_reserved: input.acquisitions_remaining,
    score: 0, comparison: { category_leverage: 0, usable_starts_delta: 0, replacement_value: 0, next_matchup_value: 0, claim_risk: 0, raw_scheduled_games_credited: 0 },
    forecast: baseline, invalidated_by: ['A newer complete forecast input or changed league setting.']
  };
  const plans = [hold];
  for (const sequence of enumerate(feasible, input.acquisitions_remaining)) {
    try {
      const forecast = simulate(input, sequence);
      const acquisitionsUsed = sequence.reduce((sum, opportunity) => sum + opportunity.consumes_acquisitions, 0);
      const comparison = {
        category_leverage: matchupScore(forecast, input.manager_team_id) - baselineScore,
        usable_starts_delta: teamProjection(forecast, input.manager_team_id).usableStarts - baselineStarts,
        replacement_value: sequence.reduce((sum, opportunity) => sum + opportunity.replacement_value, 0),
        next_matchup_value: sequence.reduce((sum, opportunity) => sum + opportunity.next_matchup_value, 0),
        claim_risk: sequence.reduce((sum, opportunity) => sum + opportunity.claim_risk, 0),
        raw_scheduled_games_credited: 0
      };
      const score = comparison.category_leverage * weights.category + comparison.usable_starts_delta * weights.usable_start + comparison.replacement_value * weights.replacement + comparison.next_matchup_value * weights.next_matchup - sequence.filter(opportunity => opportunity.mode === 'wait').reduce((sum, opportunity) => sum + opportunity.claim_risk, 0) * weights.claim_risk;
      plans.push({
        id: sequenceKey(sequence), kind: sequence.some(opportunity => opportunity.mode === 'wait') ? 'wait' : 'act_now',
        opportunity_ids: sequence.map(opportunity => opportunity.id), acquisitions_used: acquisitionsUsed,
        acquisitions_reserved: input.acquisitions_remaining - acquisitionsUsed, score: Number(score.toFixed(4)), comparison, forecast,
        deadlines: sequence.map(opportunity => ({ opportunity_id: opportunity.id, decision_deadline: opportunity.decision_deadline })),
        invalidated_by: sequence.flatMap(opportunity => [`${opportunity.candidate.name} availability changes.`, `Roster, lock, or injury evidence changes before ${opportunity.decision_deadline}.`])
      });
    } catch (error) {
      rejected.push({ opportunity_id: sequenceKey(sequence), reason: error.message });
    }
  }
  plans.sort((a, b) => b.score - a.score || a.acquisitions_used - b.acquisitions_used || a.id.localeCompare(b.id));
  const best = plans.find(plan => plan.kind !== 'hold' && plan.score >= input.min_plan_value) || hold;
  const pending = feasible.filter(opportunity => !best.opportunity_ids.includes(opportunity.id)).sort((a, b) => a.decision_deadline.localeCompare(b.decision_deadline));
  const next = pending[0];
  return {
    schema_version: 1,
    kind: 'optimization_result',
    algorithm_version: optimizationAlgorithmVersion,
    created_at: receivedAt,
    submitted_created_at: input.created_at,
    input_hash: canonicalDigest(input),
    source_snapshot_ids: [...input.forecast_input.source_snapshot_ids],
    weights,
    plans,
    recommendation: best,
    rejected,
    fallbacks: plans.filter(plan => plan.id !== best.id).slice(0, 3).map(plan => ({ id: plan.id, opportunity_ids: plan.opportunity_ids, score: plan.score })),
    next_reconsideration: next ? { at: next.decision_deadline, reason: `Refresh availability and evidence before the ${next.id} deadline.` } : { at: null, reason: 'Reconsider when availability, injury, lineup-lock, or matchup evidence changes.' },
    execution_status: 'advice_only'
  };
}
