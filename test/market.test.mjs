import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMarketObservation, reconcileMarket, marketTransitions, marketEvidence, rollingTransactionWindow } from '../app/market.mjs';

const move = { provider_event_id: 'yahoo-1', kind: 'add_drop', status: 'confirmed', displayed_at: 'Nov 16, 9:00 am', legs: [{ action: 'add', player_id: 'p1', to_team_id: 'team-1' }, { action: 'drop', player_id: 'p2', from_team_id: 'team-1' }] };
const scan = (id, rows = [move], origin = 'native') => ({ id, league_id: '999', origin, observed_at: '2026-11-16T01:00:00Z', source: { id: `source-${id}` }, rows });

test('overlapping native/imported scans preserve both observations of one provider event', () => {
  const result = reconcileMarket([scan('one'), scan('two', [move], 'imported')]);
  assert.equal(result.events.length, 1);
  assert.equal(result.confirmed.length, 1);
  assert.equal(result.events[0].observations.length, 2);
  assert.deepEqual(result.events[0].observations.map(o => o.origin), ['native', 'imported']);
  assert.equal(reconcileMarket([scan('one'), scan('one')]).events[0].observations.length, 1);
});

test('same player and displayed date never collapse distinct moves or ambiguous unkeyed rows', () => {
  const other = { ...move, provider_event_id: 'yahoo-2' };
  assert.equal(reconcileMarket([scan('one', [move, other])]).events.length, 2);
  const ambiguous = { ...move, provider_event_id: null };
  const output = reconcileMarket([scan('one', [ambiguous, ambiguous]), scan('two', [ambiguous])]);
  assert.equal(output.events.length, 3);
  assert.equal(output.confirmed.length, 0);
  assert.ok(output.events.every(event => event.identity_confidence === 'observation_only'));
});

test('requests and rejected offers are distinct states; conflicting provider facts are not trusted as confirmed', () => {
  const output = reconcileMarket([scan('requested', [{ ...move, status: 'requested' }]), scan('rejected', [{ ...move, status: 'rejected' }]), scan('confirmed')]);
  assert.equal(output.requests.length, 1);
  assert.equal(output.rejected.length, 1);
  assert.equal(output.confirmed.length, 1);
  assert.equal(normalizeMarketObservation(scan('unknown', [{ ...move, status: undefined }]))[0].status, 'unknown');
  const changed = structuredClone(move); changed.legs[0].to_team_id = 'team-2';
  const conflict = reconcileMarket([scan('one'), scan('two', [changed])]);
  assert.equal(conflict.confirmed.length, 0);
  assert.equal(conflict.unresolved.length, 1);
  assert.equal(conflict.events[0].variants.length, 2);
});

test('multi-leg trades preserve all players and counterparties', () => {
  const trade = { provider_event_id: 'trade-1', kind: 'trade', status: 'confirmed', legs_complete: true, legs: [
    { action: 'transfer', player_id: 'p1', from_team_id: 'a', to_team_id: 'b' },
    { action: 'transfer', player_id: 'p2', from_team_id: 'b', to_team_id: 'a' },
    { action: 'transfer', player_id: 'p3', from_team_id: 'b', to_team_id: 'a' }
  ] };
  assert.equal(reconcileMarket([scan('one', [trade])]).confirmed[0].legs.length, 3);
  assert.throws(() => normalizeMarketObservation(scan('bad', [{ ...trade, legs: trade.legs.slice(0, 1) }])), /every visible leg/);
});

test('FA to waiver is a status transition even when the same player remains listed', () => {
  const before = { id: 'market-1', status: 'complete', observed_at: '2026-11-16T01:00:00Z', league_id: '999', season: '2026', scoring_period: { kind: 'week', key: '5' }, filters: { availability: ['FA', 'W'] }, players: [{ player_id: 'p1', availability: 'FA' }] };
  const after = { ...before, id: 'market-2', observed_at: '2026-11-16T13:00:00Z', players: [{ player_id: 'p1', availability: 'W' }] };
  const result = marketTransitions(before, after);
  assert.equal(result.events.length, 1);
  assert.deepEqual([result.events[0].from, result.events[0].to, result.events[0].status], ['FA', 'W', 'observed']);
  assert.equal(marketTransitions(before, { ...after, filters: { availability: ['FA'] } }).status, 'unknown');
  assert.equal(marketTransitions(before, { ...after, scoring_period: { kind: 'week', key: '6' } }).status, 'unknown');
  assert.equal(marketTransitions(before, { ...after, status: 'partial' }).status, 'unknown');
});

test('historical adapter preserves unknown source dates/statuses instead of inventing a confirmed move', () => {
  const result = marketEvidence([{ id: 'import-one', kind: 'historical_import', stored_at: '2026-11-17T01:00:00Z', payload: { league_id: '999', observed_date: '2026-11-16', recent_transactions: [{ displayed_at: 'Yesterday', add: 'A', drop: 'B', team: 'Team' }] } }]);
  assert.equal(result.confirmed.length, 0);
  assert.equal(result.events[0].observations[0].observed_at, null);
  assert.equal(result.events[0].occurred_at, null);
  assert.equal(result.events[0].legs.length, 2);
});

test('rolling windows overlap earlier scans and preserve downtime gaps for bounded resumption', () => {
  const recent = rollingTransactionWindow({ end: '2026-11-17T00:00:00Z', previous_end: '2026-11-16T12:00:00Z' });
  assert.equal(recent.start, '2026-11-10T00:00:00.000Z');
  const gap = rollingTransactionWindow({ end: '2026-11-17T00:00:00Z', previous_end: '2026-11-01T00:00:00Z' });
  assert.equal(gap.start, '2026-10-31T00:00:00.000Z');
  assert.throws(() => rollingTransactionWindow({ end: '2026-11-17T00:00:00Z', overlap_hours: 0 }), /overlapping/);
});

test('malformed imported events remain visible as gaps without breaking dashboard projection', () => {
  const output = marketEvidence([{ id: 'bad-import', kind: 'historical_import', payload: { league_id: '999', recent_transactions: [{ legs: 'not a list' }] } }]);
  assert.equal(output.events.length, 0);
  assert.equal(output.invalid_observations[0].id, 'bad-import');
});
