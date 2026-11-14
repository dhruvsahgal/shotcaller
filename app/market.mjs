import { canonicalDigest } from './store.mjs';
import { strictInstant } from './time.mjs';

const statuses = new Set(['confirmed', 'requested', 'rejected', 'cancelled', 'unknown']);
const kinds = new Set(['add', 'drop', 'add_drop', 'trade', 'waiver_claim', 'availability_transition', 'unknown']);
const stringOrNull = value => typeof value === 'string' && value.trim() ? value : null;

/** Native and imported rows use one contract. A missing status or event key is never inferred from roster changes. */
export function normalizeMarketObservation(input) {
  if (!input?.id || !input.league_id || !['native', 'imported'].includes(input.origin) || !Array.isArray(input.rows)) throw new Error('Invalid market observation');
  if (input.observed_at != null && !strictInstant(input.observed_at)) throw new Error('Market observation needs an exact instant or null');
  return input.rows.map((row, index) => {
    const providerId = stringOrNull(row.provider_event_id ?? row.provider_transaction_id ?? row.transaction_key ?? row.transaction_id);
    const status = statuses.has(row.status) ? row.status : 'unknown';
    const kind = kinds.has(row.kind) ? row.kind : row.add && row.drop ? 'add_drop' : row.add ? 'add' : row.drop ? 'drop' : 'unknown';
    let legs = row.legs ?? [
      ...(row.add ? [{ action: 'add', player_id: row.add_id ?? null, player_name: row.add, from_team_id: null, to_team_id: row.team_id ?? null }] : []),
      ...(row.drop ? [{ action: 'drop', player_id: row.drop_id ?? null, player_name: row.drop, from_team_id: row.team_id ?? null, to_team_id: null }] : [])
    ];
    if (!Array.isArray(legs) || legs.some(leg => !leg || !['add', 'drop', 'transfer'].includes(leg.action) || (!stringOrNull(leg.player_id) && !stringOrNull(leg.player_name)))) throw new Error('Invalid market transaction legs');
    legs = legs.map(leg => ({ action: leg.action, player_id: stringOrNull(leg.player_id), player_name: stringOrNull(leg.player_name), from_team_id: stringOrNull(leg.from_team_id), to_team_id: stringOrNull(leg.to_team_id) }));
    if (kind === 'trade' && legs.length < 2) throw new Error('Trade evidence requires every visible leg (at least two)');
    const occurredAt = strictInstant(row.occurred_at) ? row.occurred_at : null;
    const event = { league_id: input.league_id, provider_event_id: providerId, status, kind, legs_complete: kind === 'trade' ? row.legs_complete === true : true, occurred_at: occurredAt, displayed_at: row.displayed_at ?? null, team: row.team ?? null, legs, transition: row.transition ?? null };
    const key = providerId ? { league_id: input.league_id, provider_event_id: providerId, status } : { observation_id: input.id, row_index: index };
    return { id: `market-${canonicalDigest(key).slice(0, 24)}`, ...event, identity_confidence: providerId ? 'provider_key' : 'observation_only', observations: [{ id: input.id, row_index: index, origin: input.origin, observed_at: input.observed_at ?? null, source: structuredClone(input.source ?? null), raw: structuredClone(row) }] };
  });
}

export function reconcileMarket(observations = []) {
  const events = new Map();
  for (const observation of observations) for (const event of normalizeMarketObservation(observation)) {
    const existing = events.get(event.id);
    if (!existing) { events.set(event.id, event); continue; }
    for (const evidence of event.observations) if (!existing.observations.some(e => e.id === evidence.id && e.row_index === evidence.row_index)) existing.observations.push(evidence);
    const facts = value => ({ kind: value.kind, legs_complete: value.legs_complete, legs: value.legs, transition: value.transition });
    if (canonicalDigest(facts(existing)) !== canonicalDigest(facts(event))) {
      existing.conflict = true;
      existing.variants ??= [facts(existing)];
      if (!existing.variants.some(variant => canonicalDigest(variant) === canonicalDigest(facts(event)))) existing.variants.push(facts(event));
    }
  }
  const all = [...events.values()];
  return { events: all, confirmed: all.filter(event => event.status === 'confirmed' && event.identity_confidence === 'provider_key' && event.legs_complete && !event.conflict), requests: all.filter(event => event.status === 'requested'), rejected: all.filter(event => event.status === 'rejected'), unresolved: all.filter(event => event.status === 'unknown' || event.conflict || event.identity_confidence === 'observation_only' || !event.legs_complete), notes: ['Unkeyed rows remain separate observations; names and displayed dates do not uniquely identify transactions.', 'Confirmed status requires explicit source evidence. Availability transitions are observations, not proof of a transaction.'] };
}

/** Detect status transitions only between comparable complete market snapshots. */
export function marketTransitions(before, after) {
  if (!before || !after || before.status !== 'complete' || after.status !== 'complete' || !strictInstant(before.observed_at) || !strictInstant(after.observed_at) || Date.parse(before.observed_at) >= Date.parse(after.observed_at)) return { status: 'unknown', events: [], reason: 'Two complete chronological market snapshots are required' };
  const context = snapshot => ({ league_id: snapshot.league_id, season: snapshot.season, scoring_period: snapshot.scoring_period, filters: snapshot.filters });
  if (!before.league_id || !before.season || !before.scoring_period || !before.filters || canonicalDigest(context(before)) !== canonicalDigest(context(after))) return { status: 'unknown', events: [], reason: 'Market period or filter mismatch' };
  if (![before, after].every(snapshot => Array.isArray(snapshot.players) && snapshot.players.every(player => player?.player_id && ['FA', 'W'].includes(player.availability)) && new Set(snapshot.players.map(player => player.player_id)).size === snapshot.players.length)) return { status: 'unknown', events: [], reason: 'Invalid or repeated market player rows' };
  const previous = new Map(before.players.map(player => [player.player_id, player]));
  const events = after.players.flatMap(player => {
    const prior = previous.get(player.player_id);
    if (!prior || prior.availability === player.availability) return [];
    return [{ id: `transition-${canonicalDigest({ before: before.id, after: after.id, player_id: player.player_id }).slice(0, 24)}`, kind: 'availability_transition', status: 'observed', player_id: player.player_id, from: prior.availability, to: player.availability, evidence_ids: [before.id, after.id], observed_at: after.observed_at }];
  });
  return { status: 'complete', events };
}

/** Read-only compatibility adapter; unknown legacy dates and statuses stay unknown. */
export function marketEvidence(records = []) {
  const observations = [];
  for (const record of records) {
    const payload = record.kind === 'historical_import' ? record.payload : record;
    const league_id = payload?.league_id ?? record.scope?.league_id;
    if (!league_id) continue;
    const observed_at = strictInstant(payload.observed_at) ? payload.observed_at : null;
    if (Array.isArray(payload.recent_transactions)) observations.push({ id: record.id, league_id, observed_at, origin: 'imported', rows: payload.recent_transactions, source: payload.source });
    for (const [index, page] of (Array.isArray(payload.pages) ? payload.pages : []).entries()) if (page.kind === 'transactions') observations.push({ id: `${record.id}-page-${index}`, league_id, observed_at: strictInstant(page.observed_at) ? page.observed_at : observed_at, origin: 'native', rows: page.rows ?? [], source: { snapshot_id: record.id, url: page.url } });
    if (record.kind === 'observation' && record.scope.dataset === 'transactions' && Array.isArray(record.data?.rows)) observations.push({ id: record.id, league_id, observed_at, origin: 'native', rows: record.data.rows, source: record.source });
  }
  const valid = [], invalid_observations = [];
  for (const observation of observations) {
    try { normalizeMarketObservation(observation); valid.push(observation); }
    catch (error) { invalid_observations.push({ id: observation.id, source: observation.source, reason: error.message }); }
  }
  return { ...reconcileMarket(valid), invalid_observations };
}

export function rollingTransactionWindow({ end, previous_end = null, lookback_days = 7, overlap_hours = 24 }) {
  if (!strictInstant(end) || (previous_end !== null && (!strictInstant(previous_end) || Date.parse(previous_end) >= Date.parse(end))) || !Number.isInteger(lookback_days) || lookback_days < 1 || lookback_days > 30 || !Number.isInteger(overlap_hours) || overlap_hours < 1 || overlap_hours > 168) throw new Error('Invalid overlapping transaction window');
  const routineStart = Date.parse(end) - lookback_days * 86400000;
  const overlapStart = previous_end ? Date.parse(previous_end) - overlap_hours * 3600000 : routineStart;
  return { start: new Date(Math.min(routineStart, overlapStart)).toISOString(), end };
}
