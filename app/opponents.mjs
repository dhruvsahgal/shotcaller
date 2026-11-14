import { categoryKeys } from './schema.mjs';
import { strictInstant } from './time.mjs';

const completedMoveTypes = new Set(['add', 'drop', 'add_drop', 'waiver_claim', 'trade']);
const tendencyMoveTypes = new Set(['add', 'add_drop', 'waiver_claim']);
const knownTypes = new Set([...completedMoveTypes, 'trade_rejected', 'observed']);

function confidenceFor(count) {
  if (count >= 8) return 'high';
  if (count >= 5) return 'medium';
  return 'low';
}

function validateInput(input) {
  if (!input || typeof input !== 'object' || !strictInstant(input.as_of)) throw new Error('Opponent analysis requires a valid as-of time');
  if (!Array.isArray(input.team_ids) || new Set(input.team_ids).size !== input.team_ids.length) throw new Error('Opponent analysis requires unique team IDs');
  if (!Array.isArray(input.events)) throw new Error('Opponent events are required');
  return input;
}

export function buildOpponentProfiles(rawInput) {
  const input = validateInput(structuredClone(rawInput));
  const unique = new Map();
  for (const event of input.events) {
    if (!event || typeof event.id !== 'string' || !event.id || typeof event.team_id !== 'string' || !event.team_id || !knownTypes.has(event.type) || !strictInstant(event.occurred_at) || Date.parse(event.occurred_at) > Date.parse(input.as_of) || !Array.isArray(event.source_ids) || !event.source_ids.length) throw new Error('Invalid opponent event');
    if (!Array.isArray(event.categories) || event.categories.some(category => !categoryKeys.includes(category))) throw new Error('Invalid opponent event categories');
    if (!unique.has(event.id)) unique.set(event.id, event);
  }
  const profiles = input.team_ids.map(teamId => {
    const events = [...unique.values()].filter(event => event.team_id === teamId).sort((a, b) => a.occurred_at.localeCompare(b.occurred_at) || a.id.localeCompare(b.id));
    const confirmed = events.filter(event => event.confirmed === true && completedMoveTypes.has(event.type));
    const injuryDriven = confirmed.filter(event => event.injury_driven === true);
    const tendencies = [];
    for (const category of categoryKeys) {
      const matching = confirmed.filter(event => tendencyMoveTypes.has(event.type) && !event.injury_driven && event.categories.includes(category));
      const dates = new Set(matching.map(event => event.occurred_at.slice(0, 10)));
      if (matching.length < 3 || dates.size < 2) continue;
      tendencies.push({
        category,
        observed_events: matching.length,
        distinct_dates: dates.size,
        confidence: confidenceFor(matching.length),
        evidence_ids: matching.map(event => event.id),
        interpretation: `Repeated confirmed ${category} additions; future intent remains a hypothesis.`
      });
    }
    tendencies.sort((a, b) => b.observed_events - a.observed_events || a.category.localeCompare(b.category));
    return {
      team_id: teamId,
      as_of: input.as_of,
      sample_size: {
        observed_events: events.length,
        confirmed_moves: confirmed.length,
        injury_driven_moves: injuryDriven.length,
        completed_trades: events.filter(event => event.type === 'trade' && event.confirmed === true).length,
        rejected_trades: events.filter(event => event.type === 'trade_rejected').length
      },
      tendencies,
      evidence_ids: events.map(event => event.id),
      notes: ['Behavior patterns are revisable hypotheses based only on dated confirmed events.', 'Injury-driven moves and rejected trades do not establish recurring preferences.']
    };
  });
  return { as_of: input.as_of, profiles, deduplicated_event_count: unique.size };
}

export function estimateClaimRisk(profile, categories, scarcity = 0) {
  if (!profile || !Array.isArray(profile.tendencies) || !Array.isArray(categories) || !Number.isFinite(scarcity) || scarcity < 0 || scarcity > 1) throw new Error('Invalid claim-risk input');
  const matched = profile.tendencies.filter(tendency => categories.includes(tendency.category));
  const evidenceIds = [...new Set(matched.flatMap(tendency => tendency.evidence_ids))];
  const observed = matched.reduce((sum, tendency) => sum + tendency.observed_events, 0);
  const score = Math.min(1, observed / 8 + scarcity * 0.4);
  return {
    score: Number(score.toFixed(4)),
    confidence: evidenceIds.length ? confidenceFor(evidenceIds.length) : 'insufficient',
    evidence_ids: evidenceIds,
    basis: evidenceIds.length ? 'Repeated confirmed category additions plus supplied market scarcity.' : 'Market scarcity only; no recurring manager tendency was established.'
  };
}

export function screenTrades({ manager_needs, candidates }) {
  if (!Array.isArray(manager_needs) || manager_needs.some(category => !categoryKeys.includes(category)) || !Array.isArray(candidates)) throw new Error('Invalid trade screen input');
  return candidates.map(candidate => {
    for (const key of ['id', 'other_team_id', 'give_player_id', 'receive_player_id']) if (typeof candidate[key] !== 'string' || !candidate[key]) throw new Error('Invalid trade candidate');
    for (const key of ['receive_strengths', 'give_strengths', 'counterparty_needs', 'source_ids']) if (!Array.isArray(candidate[key]) || !candidate[key].length) throw new Error('Trade candidate is missing evidence or category fit');
    const managerGain = candidate.receive_strengths.filter(category => manager_needs.includes(category));
    const counterpartyGain = candidate.give_strengths.filter(category => candidate.counterparty_needs.includes(category));
    return {
      id: candidate.id,
      other_team_id: candidate.other_team_id,
      give_player_id: candidate.give_player_id,
      receive_player_id: candidate.receive_player_id,
      manager_gain_categories: managerGain,
      counterparty_gain_categories: counterpartyGain,
      mutual_fit: managerGain.length > 0 && counterpartyGain.length > 0,
      acceptance: 'unknown',
      status: 'screened_not_proposed',
      source_ids: [...candidate.source_ids],
      caveat: 'Category fit does not predict acceptance; verify current rosters and offer state before proposing.'
    };
  }).sort((a, b) => Number(b.mutual_fit) - Number(a.mutual_fit) || b.manager_gain_categories.length - a.manager_gain_categories.length || a.id.localeCompare(b.id));
}
